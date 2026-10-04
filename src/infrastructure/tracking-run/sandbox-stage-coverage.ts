import { z } from "zod";

import {
  analysisRunStageNames,
  trackingRunStageNames,
  trackingRunStageSchema,
} from "../../application/tracking-run/contracts/closed-values.js";
import { verifyReceiptChain } from "../../application/tracking-run/receipt-chain.js";
import type { Receipt } from "../../application/tracking-run/receipt-schema.js";
import { serializeCanonicalJson } from "../../canonical-json/value.js";
import { parseDurablePublicationRecord } from "../../publication/durable-record-schema.js";
import { nodeContentDigestPort } from "./content-digest.js";

const digestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/u);

const stageEvidenceSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("analysis_record"), digest: digestSchema }),
  z.strictObject({
    kind: z.literal("receipt"),
    digest: digestSchema,
    receiptKind: z.enum(["executed", "observed", "not_required"]),
    status: z.string().min(1),
  }),
]);

export const sandboxStageCoverageSchema = z.object({
  analysisStageRecordDigest: digestSchema,
  stages: z.array(
    z.strictObject({
      stage: trackingRunStageSchema,
      executed: z.boolean(),
      evidence: stageEvidenceSchema.nullable(),
    }),
  ),
  unexecutedStages: z.array(trackingRunStageSchema),
});

type StageCoverage = z.output<typeof sandboxStageCoverageSchema>;
type StageEvidence = z.output<typeof stageEvidenceSchema>;

function publicationReceipt(receipt: Receipt): boolean {
  if (
    receipt.receiptType === "notification_message" ||
    receipt.receiptType === "manual_resolution" ||
    receipt.receiptType === "operations_alert"
  ) {
    return false;
  }
  if (receipt.receiptType === "pages_deployment") {
    return (
      receipt.status === "deployed" ||
      receipt.status === "replayed_same_content" ||
      receipt.status === "not_required"
    );
  }
  return true;
}

/** 解析記録とreceipt chainからcanonical段階の実行状況を再構築する。 */
export function createSandboxStageCoverage(
  input: Readonly<{
    durableRecord: unknown;
    receiptEntries: readonly unknown[];
    runId: string;
    invocationId: string;
    checkpointDigest: string;
    checkpointFileDigest: string;
    baseStateRevision: unknown;
  }>,
): StageCoverage {
  const durable = parseDurablePublicationRecord(input.durableRecord, nodeContentDigestPort);
  if (durable.schemaVersion !== 3) {
    throw new TypeError("旧V2永続recordに解析段階の実行証拠がありません");
  }
  const record = durable.analysisStageRecord;
  if (
    record.runId !== input.runId ||
    record.invocationId !== input.invocationId ||
    record.checkpointDigest !== input.checkpointDigest ||
    record.checkpointFileDigest !== input.checkpointFileDigest ||
    serializeCanonicalJson(record.baseStateRevision) !==
      serializeCanonicalJson(input.baseStateRevision)
  ) {
    throw new TypeError("解析段階記録とcheckpointの結合が一致しません");
  }
  const recordDigest = nodeContentDigestPort.sha256Utf8(serializeCanonicalJson(record));
  const receipts = verifyReceiptChain(input.receiptEntries, nodeContentDigestPort).receipts;
  const publication = new Map<string, Receipt>();
  for (const receipt of receipts) {
    if (
      receipt.binding.bindingKind !== "checkpoint" ||
      receipt.binding.runId !== input.runId ||
      receipt.binding.checkpointDigest !== input.checkpointDigest ||
      receipt.binding.checkpointFileDigest !== input.checkpointFileDigest
    ) {
      throw new TypeError("段階receiptとcheckpointの結合が一致しません");
    }
    if (!publicationReceipt(receipt)) {
      continue;
    }
    if (publication.has(receipt.stage)) {
      throw new TypeError("同じcanonical段階のreceiptが複数あります");
    }
    publication.set(receipt.stage, receipt);
  }
  const stages = trackingRunStageNames.map((stage, index) => {
    if (index < analysisRunStageNames.length) {
      const evidence: StageEvidence = { kind: "analysis_record", digest: recordDigest };
      return {
        stage,
        executed: true,
        evidence,
      };
    }
    const receipt = publication.get(stage);
    if (receipt?.receiptKind === "superseded") {
      throw new TypeError("無効化されたPages receiptを段階実行証拠にできません");
    }
    const evidence: StageEvidence | null =
      receipt == null
        ? null
        : {
            kind: "receipt",
            digest: receipt.receiptDigest,
            receiptKind: receipt.receiptKind,
            status: receipt.status,
          };
    return {
      stage,
      executed: receipt != null,
      evidence,
    };
  });
  let skipped = false;
  for (const stage of stages) {
    if (!stage.executed) {
      skipped = true;
    } else if (skipped) {
      throw new TypeError("未実行段階より後の段階に実行receiptがあります");
    }
  }
  return sandboxStageCoverageSchema.parse({
    analysisStageRecordDigest: recordDigest,
    stages,
    unexecutedStages: stages.filter((stage) => !stage.executed).map((stage) => stage.stage),
  });
}

/** 完了coverageに全canonical段階の証拠があることを確認する。 */
export function assertCompleteSandboxStageCoverage(value: unknown): void {
  const coverage = sandboxStageCoverageSchema.parse(value);
  if (
    coverage.stages.length !== trackingRunStageNames.length ||
    coverage.unexecutedStages.length !== 0 ||
    coverage.stages.some(
      (stage, index) =>
        stage.stage !== trackingRunStageNames[index] ||
        !stage.executed ||
        stage.evidence == null ||
        (index < analysisRunStageNames.length &&
          (stage.evidence.kind !== "analysis_record" ||
            stage.evidence.digest !== coverage.analysisStageRecordDigest)) ||
        (index >= analysisRunStageNames.length && stage.evidence.kind !== "receipt"),
    )
  ) {
    throw new TypeError("canonical段階の実行証拠が揃っていません");
  }
}

/** coverageの段階証拠が同じreceipt chainを参照することを確認する。 */
export function assertSandboxStageReceiptLineage(
  value: unknown,
  receiptDigests: readonly string[],
): void {
  const coverage = sandboxStageCoverageSchema.parse(value);
  const digests = new Set(receiptDigests.map((value) => digestSchema.parse(value)));
  if (
    coverage.stages.some(
      (stage) => stage.evidence?.kind === "receipt" && !digests.has(stage.evidence.digest),
    )
  ) {
    throw new TypeError("段階証拠のreceiptが同じchainにありません");
  }
}

/** ambiguous初回が初回Pagesまで到達し、settlement以後は未実行と確認する。 */
export function assertPendingSandboxStageCoverage(
  value: Readonly<{
    stages: readonly Readonly<{ stage: string; executed: boolean }>[];
    unexecutedStages: readonly string[];
  }>,
): void {
  const lastExecuted = trackingRunStageNames.indexOf("initial_pages_published");
  if (
    value.stages.length !== trackingRunStageNames.length ||
    value.stages.some(
      (stage, index) =>
        stage.stage !== trackingRunStageNames[index] || stage.executed !== index <= lastExecuted,
    ) ||
    serializeCanonicalJson(value.unexecutedStages) !==
      serializeCanonicalJson(trackingRunStageNames.slice(lastExecuted + 1))
  ) {
    throw new TypeError("ambiguous初回の段階停止位置が一致しません");
  }
}
