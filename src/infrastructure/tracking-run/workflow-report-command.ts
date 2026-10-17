import { resolve } from "node:path";

import type { ReportWorkflowCliCommand } from "./command-input.js";
import type { ProductionRuntimeAdapters } from "./runtime/adapters.js";
import { createWorkflowRunReport } from "./workflow-run-report.js";

type WorkflowReportRuntimeAdapters = Pick<
  ProductionRuntimeAdapters,
  "repositoryPath" | "writeJsonArtifact"
>;

/** workflowの結果報告を保存する。 */
export async function reportWorkflowRun(
  adapters: WorkflowReportRuntimeAdapters,
  command: ReportWorkflowCliCommand,
): Promise<void> {
  const report = await createWorkflowRunReport({
    workflowRunId: command.workflowRunId,
    workflowRunAttempt: command.workflowRunAttempt,
    trackingRunId: command.trackingRunId,
    effectTarget: command.effectTarget,
    completionDirectory: resolve(adapters.repositoryPath, command.completionDirectory),
    failureDirectory: resolve(adapters.repositoryPath, command.failureDirectory),
    actionsJobsPath: resolve(adapters.repositoryPath, command.actionsJobsPath),
    collectAnalyzeReportPath: resolve(adapters.repositoryPath, command.collectAnalyzeReportPath),
  });
  await adapters.writeJsonArtifact(resolve(adapters.repositoryPath, command.outputPath), report);
}
