import { createUtcIsoDateTime, type UtcIsoDateTime } from "../domain/index.js";
import type { NotifyOperationsCliCommand } from "../infrastructure/tracking-run/operations-command-input.js";
import { optionalSingleOption, parseOptions, singleOption, usageError } from "./command-options.js";

/** 運用障害通知CLIのattemptとartifact取得先を検証して読む。 */
export function parseNotifyOperations(args: readonly string[]): NotifyOperationsCliCommand {
  const options = parseOptions(
    args,
    new Set([
      "--config",
      "--workflow-run-id",
      "--workflow-run-attempt",
      "--workflow-kind",
      "--failure-directory",
      "--output-failure-directory",
      "--previous-failures-directory",
      "--failed-job",
      "--receipt",
      "--previous-receipts-directory",
      "--occurred-at",
      "--retry-attempts",
    ]),
  );
  const workflowRunId = optionalSingleOption(options, "--workflow-run-id");
  if (workflowRunId == null || !/^[1-9][0-9]*$/u.test(workflowRunId)) {
    throw usageError("notify-operationsには数値の--workflow-run-idが必要です");
  }
  const workflowRunAttemptSource = optionalSingleOption(options, "--workflow-run-attempt");
  const workflowRunAttempt = Number(workflowRunAttemptSource);
  if (
    workflowRunAttemptSource == null ||
    !/^[1-9][0-9]*$/u.test(workflowRunAttemptSource) ||
    !Number.isSafeInteger(workflowRunAttempt)
  ) {
    throw usageError("notify-operationsには1以上の--workflow-run-attemptが必要です");
  }
  const workflowKind = optionalSingleOption(options, "--workflow-kind");
  if (workflowKind !== "daily" && workflowKind !== "manual") {
    throw usageError("notify-operationsにはdailyまたはmanualの--workflow-kindが必要です");
  }
  const occurredAtSource = optionalSingleOption(options, "--occurred-at");
  if (occurredAtSource == null) {
    throw usageError("notify-operationsには--occurred-atが必要です");
  }
  let occurredAt: UtcIsoDateTime;
  try {
    occurredAt = createUtcIsoDateTime(occurredAtSource);
  } catch (error: unknown) {
    throw usageError("--occurred-atにはタイムゾーン付きISO 8601日時を指定してください", error);
  }
  const retryAttemptsSource = singleOption(options, "--retry-attempts", "1");
  const retryAttempts = Number.parseInt(retryAttemptsSource, 10);
  if (
    !/^\d+$/u.test(retryAttemptsSource) ||
    !Number.isSafeInteger(retryAttempts) ||
    retryAttempts < 1
  ) {
    throw usageError("--retry-attemptsには1以上の整数を指定してください");
  }
  const failedJobs = options.get("--failed-job") ?? [];
  const allowedJobs = new Set([
    "quality",
    "bootstrap",
    "prepare-runtime",
    "analyze",
    "commit-initial-state",
    "initial-pages",
    "settle-notifications",
    "finalize-run",
    "notification-history-pages",
    "complete",
    "recovery-router",
    "resolve-delivery",
    "tracking",
  ]);
  if (failedJobs.some((job) => !allowedJobs.has(job))) {
    throw usageError("--failed-jobには既知のworkflow job名を指定してください");
  }
  return Object.freeze({
    kind: "notify-operations",
    configPath: singleOption(options, "--config", "config.yml"),
    workflowRunId,
    workflowRunAttempt,
    workflowKind,
    failureDirectory: singleOption(options, "--failure-directory", "artifacts/workflow/failures"),
    outputFailureDirectory: singleOption(
      options,
      "--output-failure-directory",
      "artifacts/workflow/notify-failures",
    ),
    previousFailuresDirectory: singleOption(
      options,
      "--previous-failures-directory",
      "artifacts/workflow/previous-operations-alert-failures",
    ),
    failedJobs: Object.freeze([...new Set(failedJobs)]),
    receiptPath: singleOption(
      options,
      "--receipt",
      "artifacts/workflow/operations-alert-receipt.json",
    ),
    previousReceiptsDirectory: singleOption(
      options,
      "--previous-receipts-directory",
      "artifacts/workflow/previous-operations-alert-receipts",
    ),
    occurredAt,
    retryAttempts,
  } satisfies NotifyOperationsCliCommand);
}
