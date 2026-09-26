import type { DailyTransactionDependencies } from "../../daily-transaction.js";
import { writeRunReport } from "../../run-report.js";
import { writeDailyCollectAnalyzeArtifact } from "../../run-publication/daily-stage-handlers.js";
import type { ProductionRuntimeAdapters } from "../adapters.js";
import type { ProductionTypes } from "../contracts.js";

type ProductionDailyDependencies = DailyTransactionDependencies<ProductionTypes>;
type JsonArtifactRuntimeAdapters = Pick<ProductionRuntimeAdapters, "writeJsonArtifact">;
type ReportRuntimeAdapters = Pick<ProductionRuntimeAdapters, "writeTextFile">;

/** dry-runのartifact書込みを既存adapterへ接続する。 */
export function createWriteDryRunArtifactStage(
  adapters: JsonArtifactRuntimeAdapters,
): ProductionDailyDependencies["writeDryRunArtifact"] {
  return (path, artifact) => adapters.writeJsonArtifact(path, artifact);
}

/** collect-analyzeのartifact書込みを既存公開処理へ接続する。 */
export function createWriteCollectAnalyzeArtifactStage(
  adapters: JsonArtifactRuntimeAdapters,
): ProductionDailyDependencies["writeCollectAnalyzeArtifact"] {
  return (path, input) => writeDailyCollectAnalyzeArtifact({ adapters }, path, input);
}

/** run reportの書込みを既存writerへ接続する。 */
export function createWriteReportStage(
  adapters: ReportRuntimeAdapters,
): ProductionDailyDependencies["writeReport"] {
  return (path, report) => writeRunReport(path, report, adapters.writeTextFile);
}
