import { serializeCanonicalJsonLine } from "../canonical-json/value.js";
import { nodeContentDigestPort } from "../infrastructure/tracking-run/content-digest.js";
import type { PagesDeploymentIntent } from "../application/tracking-run/pages-build-contracts.js";
import type { PagesDeploymentReceipt } from "../application/tracking-run/receipt-schema.js";
import {
  PRODUCTION_PAGES_EFFECT_LEASE_BRANCH,
  type StateBranchAdapter,
  type StateBranchHead,
  type StateFileReadResult,
} from "./branch-adapter.js";
import { StateBranchConflictError } from "./errors.js";
import {
  productionPagesEffectLeaseSchema,
  productionPagesAttemptKey,
  parseProductionPagesEffectLease,
  type ProductionPagesEffectLease,
} from "./production-pages-effect-lease-schema.js";
import { createStateCommitIdentity } from "./state-commit-metadata.js";

export const PRODUCTION_PAGES_EFFECT_LEASE_PATH = "state/production-pages-effect-lease-v1.json";

async function leaseAt(
  adapter: StateBranchAdapter,
  head: StateBranchHead,
): Promise<ProductionPagesEffectLease | undefined> {
  if (head.status === "missing") {
    return undefined;
  }
  const file = await adapter.readFile(head.revision, PRODUCTION_PAGES_EFFECT_LEASE_PATH);
  return file.status === "present" ? parseProductionPagesEffectLease(file.bytes) : undefined;
}

/** 専用branchのleaseを読み取る。 */
export async function readProductionPagesEffectLease(
  adapter: StateBranchAdapter,
): Promise<ProductionPagesEffectLease | undefined> {
  const head = await adapter.resolveHead(PRODUCTION_PAGES_EFFECT_LEASE_BRANCH);
  return leaseAt(adapter, head);
}

/** 専用branchからactive leaseを読み取る。 */
export async function readActiveProductionPagesEffectLease(
  adapter: StateBranchAdapter,
): Promise<ProductionPagesEffectLease> {
  const head = await adapter.resolveHead(PRODUCTION_PAGES_EFFECT_LEASE_BRANCH);
  const lease = await leaseAt(adapter, head);
  if (lease?.status !== "active") {
    throw new TypeError("production Pagesのactive leaseがありません");
  }
  return lease;
}

/** active leaseがなければproduction入口を許可する。 */
export async function assertNoProductionPagesEffectLease(
  adapter: StateBranchAdapter,
  branch: string,
): Promise<void> {
  if (branch !== "tracker-state") {
    throw new TypeError("production Pages leaseのstate branchが不正です");
  }
  const head = await adapter.resolveHead(PRODUCTION_PAGES_EFFECT_LEASE_BRANCH);
  if ((await leaseAt(adapter, head))?.status === "active") {
    throw new StateBranchConflictError({
      cause: new TypeError("production Pages childの効果が未確定です"),
    });
  }
}

async function changeLease(
  adapter: StateBranchAdapter,
  head: StateBranchHead,
  next: ProductionPagesEffectLease,
  now: Date,
): Promise<void> {
  const updates = [
    {
      path: PRODUCTION_PAGES_EFFECT_LEASE_PATH,
      bytes: new TextEncoder().encode(serializeCanonicalJsonLine(next)),
    },
  ];
  const deletions: string[] = [];
  const message =
    next.status === "released" ? "production Pages leaseを解放" : "production Pages leaseを更新";
  const result = await adapter.commit({
    branch: PRODUCTION_PAGES_EFFECT_LEASE_BRANCH,
    expectedHead: head,
    updates,
    deletions,
    message,
    committedAt: now.toISOString(),
    commitIdentity: createStateCommitIdentity(
      "production_pages_effect",
      undefined,
      head,
      message,
      updates,
      deletions,
    ),
  });
  await adapter.publish({
    branch: PRODUCTION_PAGES_EFFECT_LEASE_BRANCH,
    revision: result.revision,
  });
}

/** child dispatch前に効果をCASで予約する。 */
export async function reserveProductionPagesEffectLease(
  adapter: StateBranchAdapter,
  intent: PagesDeploymentIntent,
  owner: Readonly<{ parentRunId: string; parentRunAttempt: number; codeRevision: string }>,
  initialDeploymentReceipt: PagesDeploymentReceipt | undefined,
  now: Date,
): Promise<ProductionPagesEffectLease> {
  const head = await adapter.resolveHead(PRODUCTION_PAGES_EFFECT_LEASE_BRANCH);
  const previous = await leaseAt(adapter, head);
  if (
    previous?.status === "active" &&
    (previous.runId !== intent.runId ||
      previous.checkpointDigest !== intent.checkpointDigest ||
      (previous.effect.phase === "notification_history" && intent.phase === "initial"))
  ) {
    throw new StateBranchConflictError({
      cause: new TypeError("production Pages leaseを別の実行が保持しています"),
    });
  }
  const idempotencyKey = nodeContentDigestPort
    .sha256Utf8(
      serializeCanonicalJsonLine({
        runId: intent.runId,
        phase: intent.phase,
        deploymentIntentDigest: intent.deploymentIntentDigest,
      }),
    )
    .slice("sha256:".length);
  if (
    previous?.status === "active" &&
    previous.effect.phase === intent.phase &&
    previous.effect.deploymentIntentDigest === intent.deploymentIntentDigest &&
    previous.effect.sourceStateRevision === intent.sourceStateRevision
  ) {
    if (previous.attempt.status !== "no_effect") {
      return previous;
    }
    if (previous.codeRevision !== owner.codeRevision) {
      throw new StateBranchConflictError({
        cause: new TypeError("Pages attemptの固定sourceを変更できません"),
      });
    }
    const sequence = previous.attempt.sequence + 1;
    const lease = productionPagesEffectLeaseSchema.parse({
      ...previous,
      ...owner,
      attempt: {
        status: "reserved",
        sequence,
        key: productionPagesAttemptKey(idempotencyKey, sequence),
      },
    });
    await changeLease(adapter, head, lease, now);
    return lease;
  }
  if (previous?.status === "active" && previous.effect.phase === intent.phase) {
    throw new StateBranchConflictError({
      cause: new TypeError("同じPages phaseへ異なるintentを予約できません"),
    });
  }
  if (
    previous?.status === "active" &&
    (previous.attempt.status !== "committed" ||
      initialDeploymentReceipt?.receiptType !== "pages_deployment" ||
      initialDeploymentReceipt.phase !== "initial" ||
      (initialDeploymentReceipt.status !== "deployed" &&
        initialDeploymentReceipt.status !== "replayed_same_content") ||
      initialDeploymentReceipt.effectCertainty !== "committed" ||
      initialDeploymentReceipt.binding.bindingKind !== "checkpoint" ||
      initialDeploymentReceipt.binding.runId !== previous.runId ||
      initialDeploymentReceipt.binding.checkpointDigest !== previous.checkpointDigest ||
      initialDeploymentReceipt.logicalTarget !== previous.effect.deploymentIntentDigest ||
      initialDeploymentReceipt.result?.deploymentIntentDigest !==
        previous.effect.deploymentIntentDigest ||
      initialDeploymentReceipt.result.sourceStateRevision !== previous.effect.sourceStateRevision)
  ) {
    throw new StateBranchConflictError({
      cause: new TypeError("成功した初回Pages receiptがないため履歴Pagesを予約できません"),
    });
  }
  const lease = productionPagesEffectLeaseSchema.parse({
    schemaVersion: 2,
    status: "active",
    attempt: { status: "reserved", sequence: 1, key: productionPagesAttemptKey(idempotencyKey, 1) },
    runId: intent.runId,
    checkpointDigest: intent.checkpointDigest,
    parentRunId: owner.parentRunId,
    parentRunAttempt: owner.parentRunAttempt,
    codeRevision: owner.codeRevision,
    effect: {
      phase: intent.phase,
      sourceStateRevision: intent.sourceStateRevision,
      deploymentIntentDigest: intent.deploymentIntentDigest,
      idempotencyKey,
    },
  });
  await changeLease(adapter, head, lease, now);
  return lease;
}

/** 保存済みattemptだけをCASで次の状態へ進める。 */
export async function advanceProductionPagesEffectAttempt(
  adapter: StateBranchAdapter,
  expected: ProductionPagesEffectLease,
  next: ProductionPagesEffectLease["attempt"],
  now: Date,
): Promise<ProductionPagesEffectLease> {
  const head = await adapter.resolveHead(PRODUCTION_PAGES_EFFECT_LEASE_BRANCH);
  const current = await leaseAt(adapter, head);
  const allowed: Readonly<
    Record<
      ProductionPagesEffectLease["attempt"]["status"],
      readonly ProductionPagesEffectLease["attempt"]["status"][]
    >
  > = {
    reserved: ["dispatch_started"],
    dispatch_started: ["child_bound", "unknown"],
    child_bound: ["effect_started", "no_effect", "unknown"],
    effect_started: ["committed", "no_effect", "unknown"],
    committed: [],
    no_effect: [],
    unknown: ["child_bound", "committed", "no_effect"],
  };
  if (
    current?.status !== "active" ||
    serializeCanonicalJsonLine(current) !== serializeCanonicalJsonLine(expected) ||
    next.key !== current.attempt.key ||
    next.sequence !== current.attempt.sequence ||
    !allowed[current.attempt.status].includes(next.status) ||
    ("dispatch" in current.attempt &&
      current.attempt.dispatch != null &&
      (!("dispatch" in next) ||
        next.dispatch == null ||
        serializeCanonicalJsonLine(current.attempt.dispatch) !==
          serializeCanonicalJsonLine(next.dispatch))) ||
    ("child" in current.attempt &&
      current.attempt.child != null &&
      (!("child" in next) ||
        next.child == null ||
        serializeCanonicalJsonLine(current.attempt.child) !==
          serializeCanonicalJsonLine(next.child)))
  ) {
    throw new StateBranchConflictError({
      cause: new TypeError("production Pages attemptの遷移が一致しません"),
    });
  }
  const lease = productionPagesEffectLeaseSchema.parse({ ...current, attempt: next });
  await changeLease(adapter, head, lease, now);
  return lease;
}

/** childが実行IDをCASで確保し重複deployを拒否する。 */
export async function claimProductionPagesEffectLease(
  adapter: StateBranchAdapter,
  expected: ProductionPagesEffectLease,
  childRunId: string,
  childRunAttempt: number,
  now: Date,
): Promise<ProductionPagesEffectLease> {
  if (expected.attempt.status !== "dispatch_started" || childRunAttempt !== 1) {
    throw new StateBranchConflictError({
      cause: new TypeError("production Pages childの効果予約が一致しません"),
    });
  }
  return advanceProductionPagesEffectAttempt(
    adapter,
    expected,
    {
      ...expected.attempt,
      status: "child_bound",
      child: { childRunId, childRunAttempt },
    },
    now,
  );
}

/** 検証済みの継続attemptが同一leaseだけをCASで解放する。 */
export async function releaseProductionPagesEffectLease(
  adapter: StateBranchAdapter,
  expected: ProductionPagesEffectLease,
  now: Date,
): Promise<void> {
  const head = await adapter.resolveHead(PRODUCTION_PAGES_EFFECT_LEASE_BRANCH);
  const current = await leaseAt(adapter, head);
  if (
    current?.status !== "active" ||
    serializeCanonicalJsonLine(current) !== serializeCanonicalJsonLine(expected) ||
    current.attempt.status !== "committed"
  ) {
    throw new StateBranchConflictError({
      cause: new TypeError("解放対象のproduction Pages leaseが一致しません"),
    });
  }
  await changeLease(
    adapter,
    head,
    productionPagesEffectLeaseSchema.parse({ ...current, status: "released" }),
    now,
  );
}

/** exact revisionのlease fileを読み取る。 */
export function parseProductionPagesEffectLeaseFile(
  file: StateFileReadResult,
): ProductionPagesEffectLease {
  if (file.status !== "present") {
    throw new TypeError("production Pages leaseがありません");
  }
  return parseProductionPagesEffectLease(file.bytes);
}
