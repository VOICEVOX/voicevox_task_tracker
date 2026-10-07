import { z } from "zod";

import type { ProductionPagesEffectLease } from "../../persistence/production-pages-effect-lease-schema.js";
import { assertNonNullable } from "../../util/assert-non-nullable.js";
import {
  sequentialPagesChildName,
  type SequentialPagesActionsPayload,
} from "./sequential-pages-actions-contract.js";

const workflowFile = "sequential_pages_effect.yml";
const runSchema = z.looseObject({
  id: z.number().int().positive(),
  run_attempt: z.number().int().positive(),
  event: z.literal("workflow_dispatch"),
  display_title: z.string(),
  status: z.string(),
  created_at: z.iso.datetime(),
  conclusion: z.string().nullable(),
});
const runsSchema = z.looseObject({
  total_count: z.number().int().nonnegative(),
  workflow_runs: z.array(runSchema),
});

/** Pages childのActions run観測値。 */
export type SequentialPagesActionsRun = z.output<typeof runSchema>;
export type SequentialPagesActionsGet = (path: string) => Promise<Response>;

/** dispatch期間を完全に列挙し固定attemptに一致するchildを探す。 */
export async function findSequentialPagesChildRun(
  repository: string,
  payload: SequentialPagesActionsPayload,
  dispatch: Readonly<{ startedAt: string; searchUntil: string }>,
  get: SequentialPagesActionsGet,
): Promise<SequentialPagesActionsRun | undefined> {
  const name = sequentialPagesChildName(payload.attemptKey);
  const matches: SequentialPagesActionsRun[] = [];
  const windows = [
    {
      from: Math.floor(Date.parse(dispatch.startedAt) / 1000),
      to: Math.ceil(Date.parse(dispatch.searchUntil) / 1000),
    },
  ];
  let requests = 0;
  while (windows.length > 0) {
    const window = windows.pop();
    assertNonNullable(window, "Pages childの検索期間がありません");
    const created = encodeURIComponent(
      `${new Date(window.from * 1000).toISOString()}..${new Date(window.to * 1000).toISOString()}`,
    );
    let total: number | undefined;
    const runs = new Map<number, SequentialPagesActionsRun>();
    for (let page = 1; page <= 10; page += 1) {
      requests += 1;
      if (requests > 256) {
        throw new TypeError("Pages childの期間検索が上限を超えました");
      }
      const response = await get(
        `repos/${repository}/actions/workflows/${workflowFile}/runs?event=workflow_dispatch&created=${created}&per_page=100&page=${page.toString()}`,
      );
      const parsed = runsSchema.parse(await response.json());
      if (parsed.total_count > 1000) {
        if (window.from >= window.to) {
          throw new TypeError("Pages childの最小検索期間を完全に列挙できません");
        }
        const middle = Math.floor((window.from + window.to) / 2);
        windows.push({ from: window.from, to: middle }, { from: middle + 1, to: window.to });
        break;
      }
      if (total != null && total !== parsed.total_count) {
        throw new TypeError("Pages childの検索中にActions一覧が変わりました");
      }
      total = parsed.total_count;
      for (const run of parsed.workflow_runs) {
        const createdAt = Date.parse(run.created_at) / 1000;
        if (runs.has(run.id) || createdAt < window.from || createdAt > window.to) {
          throw new TypeError("Pages childのActions一覧が重複または期間外です");
        }
        runs.set(run.id, run);
      }
      if (page * 100 >= total) {
        if (runs.size !== total) {
          throw new TypeError("Pages childのActions一覧が完全ではありません");
        }
        matches.push(...[...runs.values()].filter((run) => run.display_title === name));
        break;
      }
    }
  }
  if (matches.length > 1 || (matches[0] != null && matches[0].run_attempt !== 1)) {
    throw new TypeError("Pages attemptのchildが重複または再実行されています");
  }
  return matches[0];
}

/** dispatchしたPages childの完了を待つ。 */
export async function waitForSequentialPagesChildRun(
  repository: string,
  payload: SequentialPagesActionsPayload,
  dispatch: Readonly<{ startedAt: string; searchUntil: string }>,
  readLease: () => Promise<ProductionPagesEffectLease>,
  get: SequentialPagesActionsGet,
): Promise<SequentialPagesActionsRun> {
  const deadline = Date.now() + 50 * 60_000;
  while (Date.now() < deadline) {
    const lease = await readLease();
    if (lease.attempt.key !== payload.attemptKey) {
      throw new TypeError("待機中のPages attemptが変わりました");
    }
    if ("child" in lease.attempt && lease.attempt.child != null) {
      return waitForClaimedSequentialPagesChildRun(repository, payload, lease, get);
    }
    const run = await findSequentialPagesChildRun(repository, payload, dispatch, get);
    if (run?.status === "completed") {
      return run;
    }
    await new Promise<void>((resolveSleep) => setTimeout(resolveSleep, 10_000));
  }
  throw new TypeError("Pages childの実結果が制限時間内に確定しませんでした");
}

/** leaseに記録された元childのIDとattemptを指定して完了を待つ。 */
export async function waitForClaimedSequentialPagesChildRun(
  repository: string,
  payload: SequentialPagesActionsPayload,
  lease: ProductionPagesEffectLease,
  get: SequentialPagesActionsGet,
): Promise<SequentialPagesActionsRun> {
  const binding = "child" in lease.attempt ? lease.attempt.child : undefined;
  assertNonNullable(binding, "production Pages leaseにchildがありません");
  const { childRunId, childRunAttempt } = binding;
  assertNonNullable(childRunId, "production Pages leaseにchild run IDがありません");
  assertNonNullable(childRunAttempt, "production Pages leaseにchild attemptがありません");
  const deadline = Date.now() + 50 * 60_000;
  while (Date.now() < deadline) {
    const response = await get(
      `repos/${repository}/actions/runs/${childRunId}/attempts/${childRunAttempt.toString()}`,
    );
    const child = runSchema.parse(await response.json());
    if (
      child.id.toString() !== childRunId ||
      child.run_attempt !== childRunAttempt ||
      child.display_title !== sequentialPagesChildName(payload.attemptKey)
    ) {
      throw new TypeError("leaseが保持するPages childの実行情報が一致しません");
    }
    if (child.status === "completed") {
      return child;
    }
    await new Promise<void>((resolveSleep) => setTimeout(resolveSleep, 10_000));
  }
  throw new TypeError("leaseが保持するPages childの実結果が制限時間内に確定しませんでした");
}

/** 完了childのdeploy stepが開始されなかったことをActionsの実記録で確認する。 */
export async function hasSequentialPagesNoEffectEvidence(
  repository: string,
  payload: SequentialPagesActionsPayload,
  child: SequentialPagesActionsRun,
  get: SequentialPagesActionsGet,
): Promise<boolean> {
  if (child.status !== "completed" || child.run_attempt !== 1 || child.conclusion === "success") {
    return false;
  }
  const jobsSchema = z.looseObject({
    total_count: z.number().int().nonnegative(),
    jobs: z.array(
      z.looseObject({
        run_id: z.number().int().positive(),
        run_attempt: z.number().int().positive(),
        name: z.string(),
        status: z.string(),
        conclusion: z.string().nullable(),
        steps: z.array(
          z.looseObject({
            name: z.string(),
            status: z.string(),
            conclusion: z.string().nullable(),
          }),
        ),
      }),
    ),
  });
  const response = await get(
    `repos/${repository}/actions/runs/${child.id.toString()}/attempts/${child.run_attempt.toString()}/jobs?per_page=100`,
  );
  const parsed = jobsSchema.parse(await response.json());
  if (parsed.total_count !== parsed.jobs.length) {
    throw new TypeError("Pages childのjob一覧が完全ではありません");
  }
  const name =
    payload.intent.phase === "initial"
      ? "initial-pages-deploy"
      : "notification-history-pages-deploy";
  const jobs = parsed.jobs.filter((job) => job.name === name);
  const job = jobs[0];
  if (
    jobs.length !== 1 ||
    job?.run_id !== child.id ||
    job.run_attempt !== child.run_attempt ||
    job.status !== "completed"
  ) {
    throw new TypeError("Pages childのdeploy jobを一意に確認できません");
  }
  const steps = job.steps.filter((step) => step.name === "Pagesへdeploy");
  return (
    steps.length === 1 && steps[0]?.status === "completed" && steps[0].conclusion === "skipped"
  );
}
