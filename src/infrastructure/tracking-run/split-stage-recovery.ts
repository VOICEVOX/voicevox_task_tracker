import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import { stateCommitReceiptOperationId } from "../../application/tracking-run/observed-state-commit.js";
import type { ReceiptChainEntry } from "../../application/tracking-run/receipt-chain-schema.js";
import { verifyReceiptChain } from "../../application/tracking-run/receipt-chain.js";
import type {
  InitialStateCommitReceipt,
  NotificationSettlementReceipt,
  PagesDeploymentReceipt,
  Receipt,
} from "../../application/tracking-run/receipt-schema.js";
import { serializeCanonicalJson } from "../../canonical-json/value.js";
import type { StateBranchAdapter, StatePersistenceConfiguration } from "../../persistence/index.js";
import { MAX_INTERVENING_COMMITS } from "../../persistence/state-orthogonal-advance.js";
import { nodeContentDigestPort as digest } from "./content-digest.js";
import { decodeInitialPagesBuildArtifact } from "./initial-pages-build-artifact.js";
import { readNotificationMessageState } from "./notification-message-state.js";
import { restoreNotificationReceiptHistory } from "./notification-receipt-history.js";
import { plannedNotificationMessages } from "./notification-settlement-validation.js";
import { observeInitialPagesFromState } from "./publication-resume-inputs.js";
import { buildWorkflowPages } from "./publication/workflow-stage-handlers.js";
import type { ProductionRuntimeAdapters } from "./runtime/adapters.js";
import type { SplitStagePaths } from "./split-stage-paths.js";
import { writeSplitReceiptChain } from "./split-stage-receipts.js";
import { observeStateCommitAtRevision } from "./state-receipt-observation.js";

type RecoveryState = Readonly<{
  adapter: StateBranchAdapter;
  configuration: StatePersistenceConfiguration;
  headRevision: string;
  initialStateRevision: string;
}>;

/** 保存済みsettlement receiptをremoteのexact commitとGit祖先へ照合する。 */
export async function verifySplitSettlementReceipt(
  state: RecoveryState,
  runId: string,
  checkpointDigest: string,
  receipt: NotificationSettlementReceipt,
): Promise<void> {
  if (receipt.previousReceiptDigest == null || receipt.phaseSequence < 2) {
    throw new TypeError("通知settlement receiptの先行receiptがありません");
  }
  const revision = await findCommitRevision(
    state,
    runId,
    "notification_settlement",
    checkpointDigest,
  );
  const observed = await observeStateCommitAtRevision(
    state.adapter,
    state.configuration,
    revision,
    state.initialStateRevision,
    "notification_settlement",
    {
      invocationId: randomUUID(),
      observedAt: receipt.observedAt,
      position: {
        kind: "after",
        previousReceiptDigest: receipt.previousReceiptDigest,
        previousPhaseSequence: receipt.phaseSequence - 1,
      },
    },
  );
  if (
    receipt.receiptType !== observed.receipt.receiptType ||
    receipt.operationId !== observed.receipt.operationId ||
    receipt.expectedStateRevision !== observed.receipt.expectedStateRevision ||
    receipt.logicalTarget !== observed.receipt.logicalTarget ||
    serializeCanonicalJson(receipt.binding) !== serializeCanonicalJson(observed.receipt.binding) ||
    serializeCanonicalJson(receipt.result) !== serializeCanonicalJson(observed.receipt.result)
  ) {
    throw new TypeError("通知settlement receiptがremoteのexact commitと一致しません");
  }
}

async function findCommitRevision(
  state: RecoveryState,
  runId: string,
  receiptType: "notification_settlement" | "run_finalization",
  checkpointDigest: string,
): Promise<string> {
  const operationId = stateCommitReceiptOperationId(receiptType, runId, checkpointDigest, digest);
  let revision = state.headRevision;
  for (let count = 0; count < MAX_INTERVENING_COMMITS; count += 1) {
    const commit = await state.adapter.readCommit(revision);
    if (commit.metadata.operationId === operationId) {
      if (commit.metadata.runId !== runId || commit.metadata.commitScope !== "tracking_run") {
        throw new TypeError("復旧対象commitのrunまたはscopeが一致しません");
      }
      return revision;
    }
    if (commit.parent.status !== "present") {
      break;
    }
    revision = commit.parent.revision;
  }
  throw new TypeError("復旧対象のstate commitがGit祖先にありません");
}

async function observeCommit(
  state: RecoveryState,
  revision: string,
  receiptType: "initial_state_commit" | "notification_settlement" | "run_finalization",
  prior: Receipt | undefined,
  adapters: ProductionRuntimeAdapters,
): Promise<ReceiptChainEntry> {
  const observed = await observeStateCommitAtRevision(
    state.adapter,
    state.configuration,
    revision,
    state.initialStateRevision,
    receiptType,
    {
      invocationId: randomUUID(),
      observedAt: adapters.now().toISOString(),
      position:
        prior == null
          ? { kind: "first" }
          : {
              kind: "after",
              previousReceiptDigest: prior.receiptDigest,
              previousPhaseSequence: prior.phaseSequence,
            },
    },
  );
  return {
    receipt: observed.receipt,
    evidence: { kind: "state_commit", state: observed.evidence },
  };
}

/** exact stateから失われた分割runのreceipt列と必要なfileを再観測する。 */
export async function restoreSplitReceipts(
  adapters: ProductionRuntimeAdapters,
  paths: SplitStagePaths,
  runId: string,
  configPath: string,
  state: RecoveryState,
  existingEntries?: readonly ReceiptChainEntry[],
): Promise<readonly ReceiptChainEntry[]> {
  const current = await readNotificationMessageState(
    state.adapter,
    state.configuration,
    state.headRevision,
  );
  const record = current.transaction.record;
  const marker = current.transaction.marker;
  if (marker.runId !== runId || record.runIdentity.runId !== runId) {
    throw new TypeError("receipt復旧先のrun IDが一致しません");
  }
  const existingPagesIndex =
    existingEntries?.findLastIndex(
      (entry) =>
        entry.receipt.receiptType === "pages_deployment" && entry.receipt.phase === "initial",
    ) ?? -1;
  const initial =
    existingPagesIndex >= 0 && existingEntries != null
      ? existingEntries[0]
      : await observeCommit(
          state,
          state.initialStateRevision,
          "initial_state_commit",
          undefined,
          adapters,
        );
  if (initial == null) {
    throw new TypeError("復旧した初回state receiptがありません");
  }
  if (initial.receipt.receiptType !== "initial_state_commit") {
    throw new TypeError("復旧した初回state receiptの種別が不正です");
  }
  const initialReceipt: InitialStateCommitReceipt = initial.receipt;
  const entries: ReceiptChainEntry[] = [initial];
  if (existingPagesIndex < 0) {
    await adapters.writeJsonArtifact(paths.initialReceipt, initialReceipt);
  } else if (existingEntries != null) {
    entries.push(...existingEntries.slice(1, existingPagesIndex + 1));
  }
  if (marker.phase === "initial_state_committed") {
    await writeSplitReceiptChain(paths.receiptChain, entries, adapters.writeJsonArtifact);
    return entries;
  }
  const evidence = current.transaction.initialPagesEvidence;
  if (evidence == null) {
    throw new TypeError("通知開始済みrunの初回Pages保存証拠がありません");
  }
  let pagesEntry: ReceiptChainEntry & Readonly<{ receipt: PagesDeploymentReceipt }>;
  if (existingPagesIndex >= 0) {
    const pages = entries.at(-1);
    if (
      pages?.receipt.receiptType !== "pages_deployment" ||
      pages.receipt.result?.deploymentIntentDigest !== evidence.deploymentIntentDigest ||
      pages.receipt.result.pagesContentDigest !== evidence.pagesContentDigest ||
      pages.receipt.result.sourceStateRevision !== evidence.sourceStateRevision ||
      pages.receipt.result.pageUrl !== evidence.pageUrl ||
      (pages.receipt.receiptKind === "observed"
        ? pages.receipt.result.observedSourceReceiptDigest !== evidence.deploymentReceiptDigest
        : pages.receipt.receiptDigest !== evidence.deploymentReceiptDigest)
    ) {
      throw new TypeError("保存済み初回Pages chainがremote証拠と一致しません");
    }
    pagesEntry = { receipt: pages.receipt, evidence: pages.evidence };
  } else {
    await buildWorkflowPages(
      { adapters },
      {
        configPath,
        initialStateReceiptPath: paths.initialReceipt,
        buildArtifactPath: paths.initialBuild,
        outputDirectory: paths.pagesOutput,
      },
    );
    const build = decodeInitialPagesBuildArtifact(await readFile(paths.initialBuild));
    if (
      build.intent.deploymentIntentDigest !== evidence.deploymentIntentDigest ||
      build.intent.pagesContentDigest !== evidence.pagesContentDigest ||
      build.intent.sourceStateRevision !== evidence.sourceStateRevision ||
      build.receipt.previousReceiptDigest !== initialReceipt.receiptDigest
    ) {
      throw new TypeError("再生成した初回Pagesと保存済み公開証拠が一致しません");
    }
    entries.push({ receipt: build.receipt, evidence: { kind: "none" } });
    const pagesReceipt = observeInitialPagesFromState(
      {
        record,
        marker,
        exactStateRevision: state.headRevision,
        evidence,
        invocationId: randomUUID(),
        localAttemptIndex: 0,
        phaseSequence: build.receipt.phaseSequence + 1,
        previousReceiptDigest: build.receipt.receiptDigest,
        observedAt: adapters.now().toISOString(),
      },
      digest,
    );
    pagesEntry = {
      receipt: pagesReceipt,
      evidence: {
        kind: "initial_pages_state",
        state: {
          exactStateRevision: state.headRevision,
          marker: {
            runId: marker.runId,
            checkpointDigest: marker.checkpointDigest,
            phase: marker.phase,
            initialPagesPublicationEvidenceDigest: marker.initialPagesPublicationEvidenceDigest,
            initialStateRevision: marker.initialStateRevision,
          },
          evidence,
        },
      },
    };
    entries.push(pagesEntry);
  }
  const initialState = await readNotificationMessageState(
    state.adapter,
    state.configuration,
    state.initialStateRevision,
  );
  const messages = plannedNotificationMessages(record, initialState, evidence);
  let settlementRevision: string | undefined;
  let throughRevision = state.headRevision;
  if (marker.phase !== "notifications_in_progress") {
    settlementRevision = await findCommitRevision(
      state,
      runId,
      "notification_settlement",
      record.checkpointDigest,
    );
    const commit = await state.adapter.readCommit(settlementRevision);
    if (commit.parent.status !== "present") {
      throw new TypeError("通知settlement commitのGit親がありません");
    }
    throughRevision = commit.parent.revision;
  }
  const history = await restoreNotificationReceiptHistory(
    { adapter: state.adapter, configuration: state.configuration, now: adapters.now },
    record,
    initialReceipt,
    { kind: "state", evidence },
    pagesEntry,
    messages,
    throughRevision,
  );
  entries.push(...history.messageReceipts);
  if (marker.phase === "notifications_in_progress") {
    verifyReceiptChain(entries, digest);
    await writeSplitReceiptChain(paths.receiptChain, entries, adapters.writeJsonArtifact);
    return entries;
  }
  if (
    settlementRevision == null ||
    history.unresolvedReceipt != null ||
    history.finalReceipts.length !== messages.length
  ) {
    throw new TypeError("通知settlementのmessage結果をGit祖先から確定できません");
  }
  const settlement = await observeCommit(
    state,
    settlementRevision,
    "notification_settlement",
    history.previousReceipt,
    adapters,
  );
  if (
    settlement.receipt.receiptType !== "notification_settlement" ||
    settlement.receipt.expectedStateRevision !== history.stateRevision
  ) {
    throw new TypeError("復旧した通知settlementと送達commit列が一致しません");
  }
  entries.push(settlement);
  await adapters.writeJsonArtifact(paths.settlementReceipt, settlement.receipt);
  if (marker.phase === "run_finalized") {
    const finalizationRevision = await findCommitRevision(
      state,
      runId,
      "run_finalization",
      record.checkpointDigest,
    );
    const finalization = await observeCommit(
      state,
      finalizationRevision,
      "run_finalization",
      settlement.receipt,
      adapters,
    );
    if (
      finalization.receipt.receiptType !== "run_finalization" ||
      finalization.receipt.expectedStateRevision !== settlementRevision ||
      finalization.receipt.result.resultingStateRevision !== finalizationRevision
    ) {
      throw new TypeError("復旧したrun finalizationがsettlementと一致しません");
    }
    entries.push(finalization);
    await adapters.writeJsonArtifact(paths.finalizationReceipt, finalization.receipt);
  }
  if (
    serializeCanonicalJson(record.runtimeIdentity) !==
    serializeCanonicalJson(initialState.transaction.record.runtimeIdentity)
  ) {
    throw new TypeError("復旧したrunのruntime identityが初回stateと一致しません");
  }
  verifyReceiptChain(entries, digest);
  await writeSplitReceiptChain(paths.receiptChain, entries, adapters.writeJsonArtifact);
  return entries;
}
