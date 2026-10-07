import { PagesEffectNotStartedError } from "../../application/tracking-run/pages-effect.js";
import type { ProductionPagesEffectLease } from "../../persistence/production-pages-effect-lease-schema.js";
import type { StateBranchAdapter } from "../../persistence/branch-adapter.js";
import {
  advanceProductionPagesEffectAttempt,
  readActiveProductionPagesEffectLease,
} from "../../persistence/production-pages-effect-lease.js";
import { assertNonNullable } from "../../util/assert-non-nullable.js";
import type { SequentialPagesActionsPayload } from "./sequential-pages-actions-contract.js";
import {
  hasSequentialPagesNoEffectEvidence,
  waitForClaimedSequentialPagesChildRun,
  waitForSequentialPagesChildRun,
  type SequentialPagesActionsGet,
  type SequentialPagesActionsRun,
} from "./sequential-pages-actions-runs.js";

/** 一度だけdispatchし同じattemptの完了childをdurable leaseへ結び付ける。 */
export async function observeSequentialPagesAttempt(
  initialLease: ProductionPagesEffectLease,
  payload: SequentialPagesActionsPayload,
  dependencies: Readonly<{
    repository: string;
    adapter: StateBranchAdapter;
    now: () => Date;
    get: SequentialPagesActionsGet;
    verifyWorkflow: () => Promise<void>;
    dispatch: () => Promise<void>;
  }>,
): Promise<Readonly<{ lease: ProductionPagesEffectLease; child: SequentialPagesActionsRun }>> {
  let lease = initialLease;
  if (lease.attempt.status === "reserved") {
    try {
      await dependencies.verifyWorkflow();
    } catch (cause: unknown) {
      throw new PagesEffectNotStartedError("Pages childのdispatch前検証に失敗しました", { cause });
    }
    const now = dependencies.now();
    lease = await advanceProductionPagesEffectAttempt(
      dependencies.adapter,
      lease,
      {
        ...lease.attempt,
        status: "dispatch_started",
        dispatch: {
          startedAt: new Date(now.getTime() - 5 * 60_000).toISOString(),
          searchUntil: new Date(now.getTime() + 60 * 60_000).toISOString(),
        },
      },
      now,
    );
    await dependencies.dispatch();
  }
  let child: SequentialPagesActionsRun;
  if ("child" in lease.attempt && lease.attempt.child != null) {
    child = await waitForClaimedSequentialPagesChildRun(
      dependencies.repository,
      payload,
      lease,
      dependencies.get,
    );
  } else if ("dispatch" in lease.attempt && lease.attempt.dispatch != null) {
    child = await waitForSequentialPagesChildRun(
      dependencies.repository,
      payload,
      lease.attempt.dispatch,
      () => readActiveProductionPagesEffectLease(dependencies.adapter),
      dependencies.get,
    );
  } else {
    throw new TypeError("Pages childのdispatch証拠がないため再dispatchできません");
  }
  lease = await readActiveProductionPagesEffectLease(dependencies.adapter);
  if (
    lease.attempt.key !== payload.attemptKey ||
    lease.effect.idempotencyKey !== payload.idempotencyKey
  ) {
    throw new TypeError("Pages childと現在のattemptが一致しません");
  }
  if (
    lease.attempt.status === "dispatch_started" ||
    (lease.attempt.status === "unknown" &&
      lease.attempt.child == null &&
      lease.attempt.dispatch != null)
  ) {
    assertNonNullable(lease.attempt.dispatch, "Pages childのdispatch証拠がありません");
    lease = await advanceProductionPagesEffectAttempt(
      dependencies.adapter,
      lease,
      {
        ...lease.attempt,
        status: "child_bound",
        dispatch: lease.attempt.dispatch,
        child: { childRunId: child.id.toString(), childRunAttempt: child.run_attempt },
      },
      dependencies.now(),
    );
  }
  if (
    !("child" in lease.attempt) ||
    lease.attempt.child?.childRunId !== child.id.toString() ||
    lease.attempt.child.childRunAttempt !== child.run_attempt
  ) {
    throw new TypeError("Pages childのActions実行とleaseのclaimが一致しません");
  }
  if (
    lease.attempt.status !== "committed" &&
    (await hasSequentialPagesNoEffectEvidence(
      dependencies.repository,
      payload,
      child,
      dependencies.get,
    ))
  ) {
    if (!("dispatch" in lease.attempt) || lease.attempt.dispatch == null) {
      throw new TypeError("Pages attemptのdispatch証拠がありません");
    }
    await advanceProductionPagesEffectAttempt(
      dependencies.adapter,
      lease,
      {
        ...lease.attempt,
        status: "no_effect",
        dispatch: lease.attempt.dispatch,
        child: lease.attempt.child,
      },
      dependencies.now(),
    );
    throw new PagesEffectNotStartedError("Pages childのdeploy未開始を確認しました");
  }
  return { lease, child };
}

/** 完了childの外部効果を同じattemptのCASで確定する。 */
export async function settleSequentialPagesAttempt(
  adapter: StateBranchAdapter,
  lease: ProductionPagesEffectLease,
  status: "committed" | "unknown",
  now: Date,
): Promise<void> {
  if (lease.attempt.status === status) {
    return;
  }
  if (status === "unknown") {
    await advanceProductionPagesEffectAttempt(adapter, lease, { ...lease.attempt, status }, now);
    return;
  }
  if (
    (lease.attempt.status !== "effect_started" && lease.attempt.status !== "unknown") ||
    lease.attempt.dispatch == null ||
    lease.attempt.child == null
  ) {
    throw new TypeError("Pages deployの開始証拠がありません");
  }
  await advanceProductionPagesEffectAttempt(
    adapter,
    lease,
    {
      ...lease.attempt,
      status,
      dispatch: lease.attempt.dispatch,
      child: lease.attempt.child,
    },
    now,
  );
}
