import { randomUUID } from "node:crypto";

import type { PerformanceDetailObserver } from "../../../application/tracking-run/contracts/performance-detail-observation.js";
import type { InitialStateCommitReference } from "../../../application/tracking-run/engine.js";
import type { StateCommitReceiptEvidence } from "../../../application/tracking-run/observed-state-commit.js";
import { verifyReceiptChain } from "../../../application/tracking-run/receipt-chain.js";
import type {
  StateBranchAdapter,
  StatePersistenceConfiguration,
} from "../../../persistence/index.js";
import { assertExistingStatePublicSafety } from "../../../persistence/public-safety.js";
import { nodeContentDigestPort } from "../content-digest.js";
import { readNotificationMessageState } from "../notification-message-state.js";
import { observeStateCommitAtRevision } from "../state-receipt-observation.js";
import type { PersistedRun } from "./contracts.js";

/** 初回commitのexact treeからrecord、marker、receiptを再読込する。 */
export async function readCommittedInitialState(
  input: Readonly<{
    adapter: StateBranchAdapter;
    configuration: StatePersistenceConfiguration;
    knownSecrets: readonly string[];
    reference: InitialStateCommitReference;
    now: () => Date;
    observePerformanceDetail?: PerformanceDetailObserver;
  }>,
): Promise<
  PersistedRun &
    Readonly<{
      stateContentDigest: string;
      receiptEvidence: Extract<StateCommitReceiptEvidence, { receiptType: "initial_state_commit" }>;
    }>
> {
  const state = await readNotificationMessageState(
    input.adapter,
    input.configuration,
    input.reference.stateRevision,
  );
  input.observePerformanceDetail?.({ step: "committed_tree_read", count: state.files.size });
  const observed = await observeStateCommitAtRevision(
    input.adapter,
    input.configuration,
    input.reference.stateRevision,
    input.reference.stateRevision,
    "initial_state_commit",
    {
      invocationId: randomUUID(),
      observedAt: input.now().toISOString(),
      position: { kind: "first" },
    },
    input.observePerformanceDetail,
  );
  input.observePerformanceDetail?.({ step: "committed_receipt_reobserved" });
  const receipt = observed.receipt;
  if (observed.evidence.receiptType !== "initial_state_commit") {
    throw new TypeError("初回state commitの再観測証拠がありません");
  }
  const record = state.transaction.record;
  const marker = state.transaction.marker;
  if (
    receipt.receiptType !== "initial_state_commit" ||
    receipt.binding.bindingKind !== "checkpoint" ||
    marker.phase !== "initial_state_committed" ||
    receipt.result.stateContentDigest !== input.reference.stateContentDigest ||
    receipt.result.resultingStateRevision !== input.reference.stateRevision ||
    receipt.binding.runId !== record.runIdentity.runId ||
    receipt.binding.checkpointDigest !== record.checkpointDigest ||
    receipt.binding.checkpointFileDigest !== record.checkpointFileDigest ||
    marker.runId !== record.runIdentity.runId ||
    marker.checkpointDigest !== record.checkpointDigest ||
    marker.publicationRecordDigest !== record.recordDigest ||
    state.snapshot.run.id !== record.runIdentity.runId
  ) {
    throw new TypeError("再読込した初回stateとcommit receiptが一致しません");
  }
  verifyReceiptChain(
    [{ receipt, evidence: { kind: "state_commit", state: observed.evidence } }],
    nodeContentDigestPort,
  );
  assertExistingStatePublicSafety(
    state.snapshot,
    [],
    state.ledger,
    [record, marker],
    input.knownSecrets,
  );
  input.observePerformanceDetail?.({ step: "committed_public_safety_checked" });
  return Object.freeze({
    result: Object.freeze({ revision: state.revision, receipt }),
    stateContentDigest: receipt.result.stateContentDigest,
    receiptEvidence: observed.evidence,
  });
}
