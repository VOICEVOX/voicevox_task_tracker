import { resolve } from "node:path";

import type { ReportWorkflowCliCommand } from "../../command.js";
import { createWorkflowRunReport, readOptionalRunReportFile } from "../../workflow-run-report.js";
import type { ProductionRuntimeAdapters } from "../adapters.js";

type WorkflowReportRuntimeAdapters = Pick<
  ProductionRuntimeAdapters,
  "repositoryPath" | "writeJsonArtifact"
>;

/** workflowの結果報告を保存する。 */
export async function reportWorkflowRun(
  adapters: WorkflowReportRuntimeAdapters,
  command: ReportWorkflowCliCommand,
): Promise<void> {
  const collectAnalyzeReport = await readOptionalRunReportFile(
    resolve(adapters.repositoryPath, command.collectAnalyzeReportPath),
  );
  const report = createWorkflowRunReport({
    workflowRunId: command.workflowRunId,
    workflowRunAttempt: command.workflowRunAttempt,
    jobs: command.jobResults,
    collectAnalyzeReport,
  });
  await adapters.writeJsonArtifact(resolve(adapters.repositoryPath, command.outputPath), report);
}
