import { createInitialPagesPublicationEvidence } from "../../application/tracking-run/initial-pages-evidence.js";
import {
  receiptChainEnvelopeSchema,
  type ReceiptChainEntry,
} from "../../application/tracking-run/receipt-chain-schema.js";
import { verifyReceiptChain } from "../../application/tracking-run/receipt-chain.js";
import { decodeReceipt } from "../../application/tracking-run/receipt-codec.js";
import type {
  PagesBuildReceipt,
  PagesDeploymentExternalReference,
  PagesDeploymentReceipt,
} from "../../application/tracking-run/receipt-schema.js";
import { serializeCanonicalJson, serializeCanonicalJsonLine } from "../../canonical-json/value.js";
import { assertNonNullable } from "../../util/index.js";
import { nodeContentDigestPort as digest } from "./content-digest.js";
import { decodeInitialPagesBuildArtifact } from "./initial-pages-build-artifact.js";
import {
  decodeInitialPagesDeploymentOutcome,
  parseInitialPagesDeploymentOutcome,
} from "./initial-pages-deployment.js";
import { decodeNotificationHistoryPagesBuildArtifact } from "./notification-history-pages-build-artifact.js";
import {
  decodeNotificationHistoryPagesDeploymentOutcome,
  parseNotificationHistoryPagesDeploymentOutcome,
} from "./notification-history-pages-deployment-outcome.js";

type Phase = "initial" | "notification_history";
type Publication =
  | Readonly<{ kind: "unrecorded" | "no_effect" }>
  | Readonly<{
      kind: "succeeded";
      receipt: PagesDeploymentReceipt;
      successKey: string;
      reference: PagesDeploymentExternalReference | undefined;
    }>;

/** 保存時点のbuild、結果、chainを検証したPages候補。 */
export type PriorPagesCandidate = Readonly<{
  files: ReadonlyMap<string, Uint8Array>;
  entries: readonly ReceiptChainEntry[];
  content:
    | Readonly<{ kind: "unprepared" }>
    | Readonly<{
        kind: "prepared";
        key: string;
        buildReceipt: PagesBuildReceipt;
      }>;
  publication: Publication;
}>;

/** 初回と通知履歴の取得対象fileを同じ粒度で返す。 */
export function priorPagesFileNames(phase: Phase): readonly string[] {
  if (phase === "initial") {
    return [
      "initial-state-commit-receipt.json",
      "initial-pages-build.json",
      "initial-pages-deployment.json",
      "receipt-chain.json",
    ];
  }
  return [
    "notification-settlement-receipt.json",
    "run-finalization-receipt.json",
    "notification-history-pages-build.json",
    "notification-history-pages-deployment.json",
    "receipt-chain.json",
  ];
}

function readChain(bytes: Uint8Array, runId: string): readonly ReceiptChainEntry[] {
  const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const raw: unknown = JSON.parse(source);
  if (source !== serializeCanonicalJsonLine(raw)) {
    throw new TypeError("保存済みPages候補のchainがcanonical JSONではありません");
  }
  const envelope = receiptChainEnvelopeSchema.parse(raw);
  const verified = verifyReceiptChain(envelope.entries, digest);
  if (
    verified.receipts[0]?.receiptType !== "initial_state_commit" ||
    verified.receipts.some(
      (receipt) => receipt.binding.bindingKind !== "checkpoint" || receipt.binding.runId !== runId,
    )
  ) {
    throw new TypeError("保存済みPages候補のchainとrunが一致しません");
  }
  return envelope.entries;
}

function reconcileReceiptFiles(
  files: Map<string, Uint8Array>,
  entries: readonly ReceiptChainEntry[],
  phase: Phase,
): void {
  const kinds: readonly (readonly [
    string,
    "initial_state_commit" | "notification_settlement" | "run_finalization",
  ])[] =
    phase === "initial"
      ? [["initial-state-commit-receipt.json", "initial_state_commit"]]
      : [
          ["notification-settlement-receipt.json", "notification_settlement"],
          ["run-finalization-receipt.json", "run_finalization"],
        ];
  for (const [filename, kind] of kinds) {
    const receipt = entries.findLast((entry) => entry.receipt.receiptType === kind)?.receipt;
    const bytes = files.get(filename);
    if (bytes != null) {
      const saved = decodeReceipt(bytes, digest);
      if (saved.receiptType !== kind || saved.receiptDigest !== receipt?.receiptDigest) {
        throw new TypeError("保存済みPages候補のreceipt fileとchainが一致しません");
      }
    } else if (receipt != null) {
      files.set(filename, new TextEncoder().encode(serializeCanonicalJsonLine(receipt)));
    }
  }
}

function assertBuildChain(
  entries: readonly ReceiptChainEntry[],
  build: PagesBuildReceipt,
  phase: Phase,
): void {
  const entry = entries.findLast(
    (candidate) =>
      candidate.receipt.receiptType === "pages_build" && candidate.receipt.phase === phase,
  );
  if (entry == null) {
    verifyReceiptChain([...entries, { receipt: build, evidence: { kind: "none" } }], digest);
  } else if (entry.receipt.receiptDigest !== build.receiptDigest) {
    throw new TypeError("保存済みPages候補のbuild fileとchainが一致しません");
  }
}

function initialPublication(
  files: Map<string, Uint8Array>,
  entries: readonly ReceiptChainEntry[],
  artifact: ReturnType<typeof decodeInitialPagesBuildArtifact>,
): Publication {
  const deployment = entries.findLast(
    (entry) =>
      entry.receipt.receiptType === "pages_deployment" && entry.receipt.phase === "initial",
  );
  const bytes = files.get("initial-pages-deployment.json");
  let outcome;
  if (bytes != null) {
    outcome = decodeInitialPagesDeploymentOutcome(bytes, artifact);
  } else if (deployment?.receipt.receiptType === "pages_deployment") {
    const receipt = deployment.receipt;
    const evidence =
      deployment.evidence.kind === "initial_pages_state"
        ? deployment.evidence.state.evidence
        : createInitialPagesPublicationEvidence(
            {
              buildReceipt: artifact.receipt,
              deploymentReceipt: receipt,
              sourceStateRevision: artifact.intent.sourceStateRevision,
            },
            digest,
          );
    outcome = parseInitialPagesDeploymentOutcome(
      { schemaVersion: 1, kind: "success", receipt, evidence },
      artifact,
    );
    files.set(
      "initial-pages-deployment.json",
      new TextEncoder().encode(serializeCanonicalJsonLine(outcome)),
    );
  } else {
    return { kind: "unrecorded" };
  }
  if (outcome.kind === "failure") {
    if (
      outcome.effectCertainty !== "no_effect" ||
      outcome.reason !== "action_failed" ||
      deployment != null
    ) {
      throw new TypeError("保存済み初回Pages候補の結果を自動再開できません");
    }
    return { kind: "no_effect" };
  }
  assertDeployment(entries, artifact.receipt, outcome.receipt, deployment);
  return {
    kind: "succeeded",
    receipt: outcome.receipt,
    successKey: serializeCanonicalJson(outcome.evidence),
    reference: outcome.evidence.externalReference,
  };
}

function historyPublication(
  files: Map<string, Uint8Array>,
  entries: readonly ReceiptChainEntry[],
  artifact: ReturnType<typeof decodeNotificationHistoryPagesBuildArtifact>,
): Publication {
  const deployment = entries.findLast(
    (entry) =>
      entry.receipt.receiptType === "pages_deployment" &&
      entry.receipt.phase === "notification_history",
  );
  const bytes = files.get("notification-history-pages-deployment.json");
  let outcome;
  if (bytes != null) {
    outcome = decodeNotificationHistoryPagesDeploymentOutcome(bytes, artifact);
  } else if (deployment?.receipt.receiptType === "pages_deployment") {
    outcome = parseNotificationHistoryPagesDeploymentOutcome(
      {
        schemaVersion: 1,
        kind: deployment.receipt.status === "not_required" ? "not_required" : "deployed",
        sourceStateRevision: artifact.sourceStateRevision,
        buildReceipt: artifact.receipt,
        receipt: deployment.receipt,
      },
      artifact,
    );
    files.set(
      "notification-history-pages-deployment.json",
      new TextEncoder().encode(serializeCanonicalJsonLine(outcome)),
    );
  } else {
    return { kind: "unrecorded" };
  }
  if (outcome.kind === "failure") {
    if (
      outcome.failedOperationEffectCertainty !== "no_effect" ||
      outcome.reason !== "action_failed" ||
      deployment != null
    ) {
      throw new TypeError("保存済み通知履歴Pages候補の結果を自動再開できません");
    }
    return { kind: "no_effect" };
  }
  if (outcome.buildReceipt.receiptDigest !== artifact.receipt.receiptDigest) {
    throw new TypeError("保存済み通知履歴Pages候補の元buildと結果が一致しません");
  }
  assertDeployment(entries, artifact.receipt, outcome.receipt, deployment);
  return {
    kind: "succeeded",
    receipt: outcome.receipt,
    successKey: serializeCanonicalJson(outcome.receipt),
    reference: outcome.receipt.result?.externalReference,
  };
}

function assertDeployment(
  entries: readonly ReceiptChainEntry[],
  build: PagesBuildReceipt,
  receipt: PagesDeploymentReceipt,
  deployment: ReceiptChainEntry | undefined,
): void {
  if (deployment != null) {
    if (deployment.receipt.receiptDigest !== receipt.receiptDigest) {
      throw new TypeError("保存済みPages候補の結果fileとchainが一致しません");
    }
    return;
  }
  const prior = entries.at(-1)?.receipt;
  const additions: ReceiptChainEntry[] = [];
  if (prior?.receiptDigest !== build.receiptDigest) {
    additions.push({ receipt: build, evidence: { kind: "none" } });
  }
  additions.push({ receipt, evidence: { kind: "none" } });
  verifyReceiptChain([...entries, ...additions], digest);
}

/** 保存時点ごとにPagesのbuild、結果、先行receipt列を照合する。 */
export function parsePriorPagesCandidate(
  inputFiles: ReadonlyMap<string, Uint8Array>,
  phase: Phase,
  runId: string,
): PriorPagesCandidate {
  const files = new Map(inputFiles);
  const chain = files.get("receipt-chain.json");
  assertNonNullable(chain, "保存済みPages候補の元chainがありません");
  const entries = readChain(chain, runId);
  reconcileReceiptFiles(files, entries, phase);
  const prefix = phase === "initial" ? "initial-pages" : "notification-history-pages";
  const buildBytes = files.get(`${prefix}-build.json`);
  if (buildBytes == null) {
    if (
      files.has(`${prefix}-deployment.json`) ||
      entries.some(
        (entry) =>
          (entry.receipt.receiptType === "pages_build" ||
            entry.receipt.receiptType === "pages_deployment") &&
          entry.receipt.phase === phase,
      )
    ) {
      throw new TypeError("保存済みPages候補の元buildがありません");
    }
    return { files, entries, content: { kind: "unprepared" }, publication: { kind: "unrecorded" } };
  }
  let artifact:
    | ReturnType<typeof decodeInitialPagesBuildArtifact>
    | ReturnType<typeof decodeNotificationHistoryPagesBuildArtifact>;
  let publication: Publication;
  if (phase === "initial") {
    const initial = decodeInitialPagesBuildArtifact(buildBytes);
    assertBuildChain(entries, initial.receipt, phase);
    artifact = initial;
    publication = initialPublication(files, entries, initial);
  } else {
    const history = decodeNotificationHistoryPagesBuildArtifact(buildBytes);
    assertBuildChain(entries, history.receipt, phase);
    artifact = history;
    publication = historyPublication(files, entries, history);
  }
  const { receipt, ...content } = artifact;
  return {
    files,
    entries,
    content: {
      kind: "prepared",
      key: serializeCanonicalJson({ content, binding: receipt.binding }),
      buildReceipt: receipt,
    },
    publication,
  };
}
