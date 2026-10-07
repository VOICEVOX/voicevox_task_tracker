import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

import type { PublicFailureArtifact } from "../../application/tracking-run/failure-artifact.js";
import { selectPrimaryFailureArtifact } from "../../application/tracking-run/failure-primary.js";
import { decodeReceipt } from "../../application/tracking-run/receipt-codec.js";
import type { CompletionReceipt } from "../../application/tracking-run/receipt-schema.js";
import { createRunReport, type RunReport } from "../../publication/run-report.js";
import { nodeContentDigestPort } from "./content-digest.js";
import { readWorkflowFailureArtifacts } from "./operations-failure-selection.js";

const actionStepSchema = z.strictObject({
  name: z.string().min(1),
  status: z.string().min(1),
  conclusion: z.string().min(1).nullable(),
});
const actionJobSchema = z.strictObject({
  name: z.string().min(1),
  status: z.string().min(1),
  conclusion: z.string().min(1).nullable(),
  steps: z.array(actionStepSchema),
});

/** GitHub Actionsが観測したjobとstepの結果。 */
export type WorkflowActionJob = z.output<typeof actionJobSchema>;

/** engineのreceiptとActionsのjob/step結果を分けたworkflow report。 */
export type WorkflowRunReport = Readonly<{
  schemaVersion: "7";
  workflowRunId: string;
  workflowRunAttempt: number;
  trackingRunId: string | null;
  effectTarget: "production" | "sandbox" | "recording";
  engine: Readonly<{
    completionReceipt: CompletionReceipt | null;
    primaryFailure: PublicFailureArtifact | null;
    collectAnalyzeReport: RunReport | null;
  }>;
  actions: Readonly<{ jobs: readonly WorkflowActionJob[] }>;
}>;

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

/** 完了artifactが存在すればreceiptを検証して読む。 */
export async function readOptionalCompletionReceipt(
  directory: string,
): Promise<CompletionReceipt | null> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error: unknown) {
    if (isMissingFile(error)) {
      return null;
    }
    throw error;
  }
  let completion: CompletionReceipt | null = null;
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^[0-9a-f]{64}$/u.test(entry.name)) {
      throw new TypeError("完了artifactのrunディレクトリが不正です");
    }
    let bytes: Uint8Array;
    try {
      bytes = await readFile(join(directory, entry.name, "completion-receipt.json"));
    } catch (error: unknown) {
      if (isMissingFile(error)) {
        continue;
      }
      throw error;
    }
    const receipt = decodeReceipt(bytes, nodeContentDigestPort);
    if (receipt.receiptType !== "completion" || completion != null) {
      throw new TypeError("workflowの完了receiptが一意ではありません");
    }
    completion = receipt;
  }
  return completion;
}

/** Actions APIから取得したjobとstepのJSON Linesを検証して読む。 */
export async function readWorkflowActionJobs(path: string): Promise<readonly WorkflowActionJob[]> {
  const lines = (await readFile(path, "utf8")).trim().split("\n");
  if (lines.length === 0 || lines[0] === "") {
    throw new TypeError("Actions job結果がありません");
  }
  return Object.freeze(
    lines.map((line) => {
      const value: unknown = JSON.parse(line);
      return actionJobSchema.parse(value);
    }),
  );
}

/** 収集run reportがあれば検証して読む。 */
export async function readOptionalRunReportFile(path: string): Promise<RunReport | null> {
  let source: string;
  try {
    source = await readFile(path, "utf8");
  } catch (error: unknown) {
    if (isMissingFile(error)) {
      return null;
    }
    throw error;
  }
  const value: unknown = JSON.parse(source);
  return createRunReport(value);
}

/** engineとActionsの独立した観測値からworkflow reportを作る。 */
export async function createWorkflowRunReport(
  input: Readonly<{
    workflowRunId: string;
    workflowRunAttempt: number;
    trackingRunId: string | undefined;
    effectTarget: "production" | "sandbox" | "recording";
    completionDirectory: string;
    failureDirectory: string;
    actionsJobsPath: string;
    collectAnalyzeReportPath: string;
  }>,
): Promise<WorkflowRunReport> {
  const [completionReceipt, failures, actionsJobs, collectAnalyzeReport] = await Promise.all([
    readOptionalCompletionReceipt(input.completionDirectory),
    readWorkflowFailureArtifacts(input.failureDirectory),
    readWorkflowActionJobs(input.actionsJobsPath),
    readOptionalRunReportFile(input.collectAnalyzeReportPath),
  ]);
  if (
    input.trackingRunId != null &&
    completionReceipt != null &&
    (completionReceipt.binding.bindingKind !== "checkpoint" ||
      completionReceipt.binding.runId !== input.trackingRunId)
  ) {
    throw new TypeError("workflowの完了receiptと対象run IDが一致しません");
  }
  return Object.freeze({
    schemaVersion: "7",
    workflowRunId: input.workflowRunId,
    workflowRunAttempt: input.workflowRunAttempt,
    trackingRunId: input.trackingRunId ?? null,
    effectTarget: input.effectTarget,
    engine: Object.freeze({
      completionReceipt,
      primaryFailure: failures.length === 0 ? null : selectPrimaryFailureArtifact(failures),
      collectAnalyzeReport,
    }),
    actions: Object.freeze({ jobs: actionsJobs }),
  });
}
