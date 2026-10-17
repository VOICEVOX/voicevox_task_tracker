import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import {
  createFailedRun,
  createPublicFailureArtifact,
  type FailedRun,
} from "../../application/tracking-run/failure-artifact.js";
import type { DiagnosticsJsonlRecorder } from "../../diagnostics/recorder.js";
import type { CliCommand } from "./command-input.js";
import { nodeContentDigestPort } from "./content-digest.js";
import type { CliExecutionResult } from "./execution-result.js";
import { observeCliFailureContext } from "./failure-context.js";
import { RecordedFailureError, recordFailureDiagnostic } from "./failure-diagnostic.js";
import { writeCliJsonArtifact } from "./file-output.js";
import { isPublicBoundaryViolation } from "./public-boundary-error.js";
import { splitStageFailureFileName } from "./split-stage-paths.js";

const FAILURE_DIRECTORY_ENVIRONMENT_VARIABLE = "VOICEVOX_TASK_TRACKER_FAILURE_DIRECTORY";

function failureArtifactPath(command: CliCommand | undefined, invocationId: string): string {
  const directory =
    command?.kind === "notify-operations"
      ? command.outputFailureDirectory
      : (process.env[FAILURE_DIRECTORY_ENVIRONMENT_VARIABLE] ?? "artifacts/workflow/failures");
  let fileName = `${invocationId}.json`;
  if (command?.kind === "run-stage") {
    fileName = splitStageFailureFileName(command);
  } else if (command?.kind === "runtime-recovery-v2") {
    fileName = `${command.runId.slice("tracker-run:".length)}-${command.operation}-${command.stage ?? command.phase ?? "inspect"}-attempt-${command.runAttempt.toString()}.json`;
  }
  return resolve(directory, fileName);
}

/** 失敗種別を公開可能な診断codeへ写す。 */
export function publicDiagnosticCode(
  failureKind: FailedRun["failureKind"],
): FailedRun["publicDiagnostics"]["code"] {
  switch (failureKind) {
    case "invalid_input":
      return "invalid_input";
    case "schema_validation":
    case "content_integrity":
      return "invalid_record";
    case "state_conflict":
      return "state_conflict";
    case "external_effect":
    case "superseded_by_newer_run":
      return "external_effect_unconfirmed";
    case "runtime_unavailable":
      return "runtime_unavailable";
    case "public_boundary":
      return "public_boundary";
    case "workflow_infrastructure_failure":
      return "workflow_infrastructure_failure";
    case "diagnostics_encryption_failure":
      return "diagnostics_encryption_failure";
    case "unexpected":
      return "unexpected_failure";
  }
}

/** CLI最上位の元エラーを診断へ一度だけ記録し公開失敗artifactを出す。 */
export async function reportCliFailure(
  command: CliCommand | undefined,
  invocationId: string,
  error: unknown,
  result: CliExecutionResult | undefined,
  recorder: DiagnosticsJsonlRecorder | undefined,
): Promise<unknown> {
  if (result != null && "result" in result && result.result.failedRun != null) {
    try {
      const artifact = createPublicFailureArtifact(result.result.failedRun, nodeContentDigestPort);
      await writeCliJsonArtifact(failureArtifactPath(command, invocationId), artifact);
      return error;
    } catch (artifactError: unknown) {
      return new AggregateError([error, artifactError], "公開失敗artifactの作成に失敗しました", {
        cause: error,
      });
    }
  }
  if (recorder == null) {
    return new Error("公開失敗artifactに必要な暗号化診断recorderがありません", { cause: error });
  }
  const diagnosticState =
    error instanceof RecordedFailureError
      ? { kind: "recorded" as const, error, recordIds: error.diagnosticRecordIds }
      : result != null && "result" in result && result.result.failureDiagnosticRecordId != null
        ? {
            kind: "recorded" as const,
            error,
            recordIds: [result.result.failureDiagnosticRecordId] satisfies readonly [string],
          }
        : { kind: "unrecorded" as const, error };
  let recorded;
  try {
    recorded = await recordFailureDiagnostic(recorder, diagnosticState, randomUUID());
  } catch (recordingError: unknown) {
    return new AggregateError([error, recordingError], "公開失敗の診断記録に失敗しました", {
      cause: error,
    });
  }
  let context;
  try {
    context = await observeCliFailureContext(command, error, result);
  } catch (observationError: unknown) {
    const contextRecordId = randomUUID();
    try {
      await recorder.append({
        event: "tracking_run.failure_context_unavailable",
        details: { recordId: contextRecordId, invocationId },
        error: observationError,
      });
    } catch (recordingError: unknown) {
      return new AggregateError(
        [error, observationError, recordingError],
        "失敗文脈と診断記録の両方に失敗しました",
        { cause: error },
      );
    }
    recorded = {
      ...recorded,
      recordIds: [...recorded.recordIds, contextRecordId] satisfies readonly [string, ...string[]],
    };
    context = {
      failedStage: "runtime_bootstrap" as const,
      failureKind: isPublicBoundaryViolation(error)
        ? ("public_boundary" as const)
        : ("content_integrity" as const),
      failedOperationEffectCertainty: "no_effect" as const,
      evidence: { bindingKind: "invocation_pre_run_alert" as const },
      lastVerifiedReceipt: undefined,
      stateObservation: { kind: "not_observed" as const },
    };
  }
  if (context.bootstrapError != null) {
    const bootstrapRecordId = randomUUID();
    try {
      await recorder.append({
        event: "tracking_run.failure_bootstrap_invalid",
        details: { recordId: bootstrapRecordId, invocationId },
        error: context.bootstrapError,
      });
    } catch (recordingError: unknown) {
      return new AggregateError(
        [error, context.bootstrapError, recordingError],
        "state bootstrap失敗の診断記録に失敗しました",
        { cause: error },
      );
    }
    recorded = {
      ...recorded,
      recordIds: [...recorded.recordIds, bootstrapRecordId] satisfies readonly [
        string,
        ...string[],
      ],
    };
  }
  try {
    const failure = createFailedRun({
      invocationId,
      failedStage: context.failedStage,
      failureKind: context.failureKind,
      failedOperationEffectCertainty: context.failedOperationEffectCertainty,
      evidence: context.evidence,
      ...(context.runId == null ? {} : { runId: context.runId }),
      ...(context.checkpointDigest == null ? {} : { checkpointDigest: context.checkpointDigest }),
      ...(context.checkpointFileDigest == null
        ? {}
        : { checkpointFileDigest: context.checkpointFileDigest }),
      ...(context.finalStateRevision == null
        ? {}
        : { finalStateRevision: context.finalStateRevision }),
      ...(context.causedByFailureArtifactDigest == null
        ? {}
        : { causedByFailureArtifactDigest: context.causedByFailureArtifactDigest }),
      publicDiagnostics: { code: publicDiagnosticCode(context.failureKind) },
      encryptedDiagnosticsRecordIds: [...recorded.recordIds],
      lastVerifiedReceipt: context.lastVerifiedReceipt,
      stateObservation: context.stateObservation,
    });
    const artifact = createPublicFailureArtifact(failure, nodeContentDigestPort);
    await writeCliJsonArtifact(failureArtifactPath(command, invocationId), artifact);
    return error;
  } catch (artifactError: unknown) {
    return new AggregateError([error, artifactError], "公開失敗artifactの作成に失敗しました", {
      cause: error,
    });
  }
}
