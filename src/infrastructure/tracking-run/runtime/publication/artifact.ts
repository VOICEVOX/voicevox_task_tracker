import type { SequentialRunDependencies } from "../../sequential-run-contracts.js";

import {
  RECEIPT_CHAIN_SCHEMA_VERSION,
  receiptChainEnvelopeSchema,
} from "../../../../application/tracking-run/receipt-chain-schema.js";
import { verifyReceiptChain } from "../../../../application/tracking-run/receipt-chain.js";
import { nodeContentDigestPort } from "../../content-digest.js";
import { writeDailyCollectAnalyzeArtifact } from "../../publication/daily-stage-handlers.js";
import { writeRunReport } from "../../run-report-file.js";
import { sequentialReceiptPath } from "../../sequential-receipt-path.js";
import type { ProductionRuntimeAdapters } from "../adapters.js";

type SequentialStageDependencies = SequentialRunDependencies;
type JsonArtifactRuntimeAdapters = Pick<ProductionRuntimeAdapters, "writeJsonArtifact">;
type CheckpointRuntimeAdapters = Pick<
  ProductionRuntimeAdapters,
  "repositoryPath" | "environment" | "writeJsonArtifact"
>;
type ReportRuntimeAdapters = Pick<ProductionRuntimeAdapters, "writeTextFile">;

/** dry-runのartifact書込みを既存adapterへ接続する。 */
export function createWriteDryRunArtifactStage(
  adapters: JsonArtifactRuntimeAdapters,
): SequentialStageDependencies["writeDryRunArtifact"] {
  return (path, artifact) => adapters.writeJsonArtifact(path, artifact);
}

/** collect-analyzeのartifact書込みを既存公開処理へ接続する。 */
export function createWriteCollectAnalyzeArtifactStage(
  adapters: CheckpointRuntimeAdapters,
): SequentialStageDependencies["writeCollectAnalyzeArtifact"] {
  return (path, input) => writeDailyCollectAnalyzeArtifact({ adapters }, path, input);
}

/** run reportの書込みを既存writerへ接続する。 */
export function createWriteReportStage(
  adapters: ReportRuntimeAdapters,
): SequentialStageDependencies["writeReport"] {
  return (path, report) => writeRunReport(path, report, adapters.writeTextFile);
}

/** 直列runの確定済みreceipt列を中断再開用artifactへ保存する。 */
export function createWriteReceiptChainStage(
  adapters: Pick<ProductionRuntimeAdapters, "repositoryPath" | "writeJsonArtifact">,
): SequentialStageDependencies["writeReceiptChain"] {
  return async (runId, entries) => {
    verifyReceiptChain(entries, nodeContentDigestPort);
    await adapters.writeJsonArtifact(
      sequentialReceiptPath(adapters.repositoryPath, runId),
      receiptChainEnvelopeSchema.parse({ schemaVersion: RECEIPT_CHAIN_SCHEMA_VERSION, entries }),
    );
  };
}
