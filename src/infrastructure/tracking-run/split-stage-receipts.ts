import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createInitialPagesPublicationEvidence } from "../../application/tracking-run/initial-pages-evidence.js";
import {
  RECEIPT_CHAIN_SCHEMA_VERSION,
  receiptChainEnvelopeSchema,
  type ReceiptChainEntry,
  type ReceiptChainEvidence,
} from "../../application/tracking-run/receipt-chain-schema.js";
import { verifyReceiptChain } from "../../application/tracking-run/receipt-chain.js";
import { decodeReceipt } from "../../application/tracking-run/receipt-codec.js";
import type { Receipt } from "../../application/tracking-run/receipt-schema.js";
import { serializeCanonicalJsonLine } from "../../canonical-json/value.js";
import type { StateBranchAdapter, StatePersistenceConfiguration } from "../../persistence/index.js";
import { nodeContentDigestPort } from "./content-digest.js";
import {
  decodeInitialPagesBuildArtifact,
  parseInitialPagesBuildArtifact,
} from "./initial-pages-build-artifact.js";
import {
  decodeInitialPagesDeploymentEvidence,
  decodeInitialPagesDeploymentOutcome,
  parseInitialPagesDeploymentOutcome,
  readInitialPagesDeploymentOutcome,
} from "./initial-pages-deployment.js";
import { readNotificationMessageState } from "./notification-message-state.js";
import { buildWorkflowPages } from "./publication/workflow-stage-handlers.js";
import type { ProductionRuntimeAdapters } from "./runtime/adapters.js";
import type { SplitStagePaths } from "./split-stage-paths.js";
import { observeStateCommitAtRevision } from "./state-receipt-observation.js";

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function optionalArtifact(path: string): Promise<Uint8Array | undefined> {
  try {
    return await readFile(path);
  } catch (error: unknown) {
    if (isMissingFile(error)) {
      return undefined;
    }
    throw error;
  }
}

/** 個別receiptとPages結果から消失したchainの初回部分を再結合する。 */
export async function recoverSplitInitialPagesChain(
  paths: SplitStagePaths,
  runId: string,
  adapter: StateBranchAdapter,
  configuration: StatePersistenceConfiguration,
  initialStateRevision: string,
): Promise<readonly ReceiptChainEntry[] | undefined> {
  const [initialBytes, buildBytes, outcomeBytes] = await Promise.all([
    optionalArtifact(paths.initialReceipt),
    optionalArtifact(paths.initialBuild),
    optionalArtifact(paths.initialDeployment),
  ]);
  if (initialBytes == null) {
    if (buildBytes != null || outcomeBytes != null) {
      throw new TypeError("初回Pages個別artifactに初回state receiptがありません");
    }
    return undefined;
  }
  const initial = decodeReceipt(initialBytes, nodeContentDigestPort);
  if (initial.receiptType !== "initial_state_commit") {
    throw new TypeError("初回state receiptの種別が不正です");
  }
  const entries: ReceiptChainEntry[] = [
    {
      receipt: initial,
      evidence: await stateCommitEvidenceForSplitReceipt(
        adapter,
        configuration,
        initial,
        initialStateRevision,
      ),
    },
  ];
  if (buildBytes != null) {
    const build = decodeInitialPagesBuildArtifact(buildBytes);
    entries.push({ receipt: build.receipt, evidence: { kind: "none" } });
    if (outcomeBytes != null) {
      const outcome = decodeInitialPagesDeploymentOutcome(outcomeBytes, build);
      if (outcome.kind === "success") {
        entries.push({
          receipt: outcome.receipt,
          evidence: await initialPagesEvidenceForSplitReceipt(
            adapter,
            configuration,
            outcome.receipt,
          ),
        });
      }
    }
  } else if (outcomeBytes != null) {
    throw new TypeError("初回Pages結果に先行build artifactがありません");
  }
  const verified = verifyReceiptChain(entries, nodeContentDigestPort);
  if (
    verified.receipts.some(
      (receipt) => receipt.binding.bindingKind !== "checkpoint" || receipt.binding.runId !== runId,
    )
  ) {
    throw new TypeError("初回Pages個別artifactのrun IDが一致しません");
  }
  return entries;
}

/** chainが保持する初回Pages公開receiptから欠損した個別artifactを復元する。 */
export async function restoreSplitInitialPagesArtifacts(
  adapters: ProductionRuntimeAdapters,
  paths: SplitStagePaths,
  entries: readonly ReceiptChainEntry[],
  configPath: string,
): Promise<void> {
  const pages = entries.findLast(
    (entry) =>
      entry.receipt.receiptType === "pages_deployment" && entry.receipt.phase === "initial",
  )?.receipt;
  if (pages?.receiptType !== "pages_deployment" || pages.receiptKind === "observed") {
    return;
  }
  const initial = entries[0]?.receipt;
  const buildReceipt = entries.findLast(
    (entry) => entry.receipt.receiptType === "pages_build" && entry.receipt.phase === "initial",
  )?.receipt;
  if (
    initial?.receiptType !== "initial_state_commit" ||
    buildReceipt?.receiptType !== "pages_build"
  ) {
    throw new TypeError("初回Pages公開chainの先行receiptがありません");
  }
  let initialMissing = false;
  try {
    const saved = decodeReceipt(await readFile(paths.initialReceipt), nodeContentDigestPort);
    if (saved.receiptDigest !== initial.receiptDigest) {
      throw new TypeError("初回state receipt fileとchainが一致しません");
    }
  } catch (error: unknown) {
    if (!isMissingFile(error)) {
      throw error;
    }
    initialMissing = true;
  }
  let buildMissing = false;
  let build;
  try {
    build = decodeInitialPagesBuildArtifact(await readFile(paths.initialBuild));
  } catch (error: unknown) {
    if (!isMissingFile(error)) {
      throw error;
    }
    buildMissing = true;
  }
  if (build != null && build.receipt.receiptDigest !== buildReceipt.receiptDigest) {
    throw new TypeError("初回Pages build fileとchainが一致しません");
  }
  let outcomeMissing = false;
  let outcomeBytes: Uint8Array | undefined;
  try {
    outcomeBytes = await readFile(paths.initialDeployment);
    const outcome = decodeInitialPagesDeploymentEvidence(outcomeBytes);
    if (outcome.receipt.receiptDigest !== pages.receiptDigest) {
      throw new TypeError("初回Pages outcome fileとchainが一致しません");
    }
    if (build != null) {
      const outcome = await readInitialPagesDeploymentOutcome(paths.initialDeployment, build);
      if (outcome.kind !== "success" || outcome.receipt.receiptDigest !== pages.receiptDigest) {
        throw new TypeError("初回Pages outcome fileとchainが一致しません");
      }
    }
  } catch (error: unknown) {
    if (!isMissingFile(error)) {
      throw error;
    }
    outcomeMissing = true;
  }
  if (initialMissing) {
    await adapters.writeJsonArtifact(paths.initialReceipt, initial);
  }
  if (buildMissing) {
    const temp = await mkdtemp(join(tmpdir(), "tracking-pages-recovery-"));
    try {
      const temporaryBuildPath = join(temp, "initial-pages-build.json");
      await buildWorkflowPages(
        { adapters },
        {
          configPath,
          initialStateReceiptPath: paths.initialReceipt,
          buildArtifactPath: temporaryBuildPath,
          outputDirectory: paths.pagesOutput,
        },
      );
      const regenerated = decodeInitialPagesBuildArtifact(await readFile(temporaryBuildPath));
      build = parseInitialPagesBuildArtifact({
        schemaVersion: 1,
        manifest: regenerated.manifest,
        intent: regenerated.intent,
        receipt: buildReceipt,
      });
      await adapters.writeJsonArtifact(paths.initialBuild, build);
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  }
  if (build == null) {
    throw new TypeError("初回Pages build artifactを復元できません");
  }
  const evidence = createInitialPagesPublicationEvidence(
    {
      buildReceipt: build.receipt,
      deploymentReceipt: pages,
      sourceStateRevision: build.intent.sourceStateRevision,
    },
    nodeContentDigestPort,
  );
  const outcome = parseInitialPagesDeploymentOutcome(
    { schemaVersion: 1, kind: "success", receipt: pages, evidence },
    build,
  );
  if (outcome.kind !== "success") {
    throw new TypeError("初回Pages outcomeの成功結果を復元できません");
  }
  if (outcomeBytes != null) {
    const existing = decodeInitialPagesDeploymentOutcome(outcomeBytes, build);
    if (
      existing.kind !== "success" ||
      existing.receipt.receiptDigest !== outcome.receipt.receiptDigest
    ) {
      throw new TypeError("初回Pages outcome fileとchainが一致しません");
    }
  }
  if (outcomeMissing) {
    await adapters.writeJsonArtifact(paths.initialDeployment, outcome);
  }
}

/** run別receipt chainをcanonical形式で再読込する。 */
export async function readSplitReceiptChain(
  path: string,
  runId: string,
): Promise<readonly ReceiptChainEntry[]> {
  const source = await readFile(path, "utf8");
  const raw: unknown = JSON.parse(source);
  if (source !== serializeCanonicalJsonLine(raw)) {
    throw new TypeError("分割runのreceipt chainがcanonical JSONではありません");
  }
  const envelope = receiptChainEnvelopeSchema.parse(raw);
  const verified = verifyReceiptChain(envelope.entries, nodeContentDigestPort);
  if (
    verified.receipts.some(
      (receipt) => receipt.binding.bindingKind !== "checkpoint" || receipt.binding.runId !== runId,
    )
  ) {
    throw new TypeError("分割runのreceipt chainとrun IDが一致しません");
  }
  return envelope.entries;
}

/** receipt chainを同じ共有schemaで保存する。 */
export async function writeSplitReceiptChain(
  path: string,
  entries: readonly ReceiptChainEntry[],
  writeJsonArtifact: (path: string, value: unknown) => Promise<void>,
): Promise<void> {
  verifyReceiptChain(entries, nodeContentDigestPort);
  await writeJsonArtifact(
    path,
    receiptChainEnvelopeSchema.parse({
      schemaVersion: RECEIPT_CHAIN_SCHEMA_VERSION,
      entries,
    }),
  );
}

/** 直前receiptを保持して新しい段階のreceiptを連結する。 */
export function appendSplitReceipts(
  prior: readonly ReceiptChainEntry[],
  additions: readonly ReceiptChainEntry[],
  runId: string,
): readonly ReceiptChainEntry[] {
  if (additions.length === 0) {
    throw new TypeError("分割run段階の成功receiptがありません");
  }
  const entries = Object.freeze([...prior, ...additions]);
  const verified = verifyReceiptChain(entries, nodeContentDigestPort);
  if (
    verified.receipts.some(
      (receipt) => receipt.binding.bindingKind !== "checkpoint" || receipt.binding.runId !== runId,
    )
  ) {
    throw new TypeError("分割runの追加receiptとrun IDが一致しません");
  }
  return entries;
}

/** exact stateに結び付いた再観測receiptの証拠を取り出す。 */
export async function stateCommitEvidenceForSplitReceipt(
  adapter: StateBranchAdapter,
  configuration: StatePersistenceConfiguration,
  receipt: Receipt,
  initialStateRevision: string,
): Promise<ReceiptChainEvidence> {
  if (receipt.receiptKind !== "observed") {
    return { kind: "none" };
  }
  if (
    receipt.receiptType !== "initial_state_commit" &&
    receipt.receiptType !== "notification_settlement" &&
    receipt.receiptType !== "run_finalization"
  ) {
    throw new TypeError("state commit以外のreceiptへcommit証拠を要求できません");
  }
  const observed = await observeStateCommitAtRevision(
    adapter,
    configuration,
    receipt.result.resultingStateRevision,
    initialStateRevision,
    receipt.receiptType,
    {
      invocationId: receipt.invocationId,
      observedAt: receipt.observedAt,
      position:
        receipt.previousReceiptDigest == null
          ? { kind: "first" }
          : {
              kind: "after",
              previousReceiptDigest: receipt.previousReceiptDigest,
              previousPhaseSequence: receipt.phaseSequence - 1,
            },
    },
  );
  return { kind: "state_commit", state: observed.evidence };
}

/** 保存済みPages証拠とexact markerから再観測receiptを裏付ける。 */
export async function initialPagesEvidenceForSplitReceipt(
  adapter: StateBranchAdapter,
  configuration: StatePersistenceConfiguration,
  receipt: Receipt,
): Promise<ReceiptChainEvidence> {
  if (receipt.receiptKind !== "observed") {
    return { kind: "none" };
  }
  if (
    receipt.receiptType !== "pages_deployment" ||
    receipt.phase !== "initial" ||
    typeof receipt.expectedStateRevision !== "string"
  ) {
    throw new TypeError("初回Pagesの再観測receiptが不正です");
  }
  const state = await readNotificationMessageState(
    adapter,
    configuration,
    receipt.expectedStateRevision,
  );
  const marker = state.transaction.marker;
  const evidence = state.transaction.initialPagesEvidence;
  if (marker.phase === "initial_state_committed" || evidence == null) {
    throw new TypeError("初回Pagesの保存済みstate証拠がありません");
  }
  return {
    kind: "initial_pages_state",
    state: {
      exactStateRevision: receipt.expectedStateRevision,
      marker: {
        runId: marker.runId,
        checkpointDigest: marker.checkpointDigest,
        phase: marker.phase,
        initialPagesPublicationEvidenceDigest: marker.initialPagesPublicationEvidenceDigest,
        initialStateRevision: marker.initialStateRevision,
      },
      evidence,
    },
  };
}
