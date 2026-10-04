import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import {
  createFailedRun,
  createPublicFailureArtifact,
  type FailedRun,
} from "../../application/tracking-run/failure-artifact.js";
import { createDiagnosticsRecorder } from "../../diagnostics/recorder.js";
import { nodeContentDigestPort } from "./content-digest.js";
import type { BootstrapFailureObservation } from "./failure-context-state.js";
import { writeCliJsonArtifact } from "./file-output.js";
import type { ManualExactCommand } from "./manual-command-input.js";

type ManualExactFailureInput = Readonly<{
  runId?: string;
  checkpointDigest?: string;
  diagnosticsPath: string;
  failureDirectory: string;
  inputInvalid: boolean;
  childStarted: boolean;
}>;

function failedStage(command: ManualExactCommand | undefined): FailedRun["failedStage"] {
  switch (command) {
    case undefined:
      return "prepare";
    case "select-runtime":
      return "runtime_selection";
    case "resolve-discord-delivery":
      return "notifications_settled";
  }
}

/** 失敗観測で実証したstate revisionを返す。 */
export function revision(observation: BootstrapFailureObservation | undefined): string | undefined {
  return observation?.stateObservation.kind === "not_observed"
    ? undefined
    : observation?.stateObservation.revision;
}

/** 観測したcheckpointが手動解決対象に一致するか判定する。 */
export function isExpectedCheckpoint(
  observation: BootstrapFailureObservation | undefined,
  runId: string,
  checkpointDigest: string,
): boolean {
  return (
    observation?.evidence?.bindingKind === "checkpoint" &&
    observation.evidence.runId === runId &&
    observation.evidence.checkpointDigest === checkpointDigest &&
    observation.stateObservation.kind === "consistent_pending"
  );
}

/** 手動workflowの未報告失敗を実証済みstateから記録する。 */
export async function reportManualExactFailure(
  command: ManualExactCommand | undefined,
  error: unknown,
  before: BootstrapFailureObservation | undefined,
  after: BootstrapFailureObservation | undefined,
  input: ManualExactFailureInput,
): Promise<void> {
  const invocationId = randomUUID();
  const matchingAfter =
    input.runId != null &&
    input.checkpointDigest != null &&
    isExpectedCheckpoint(after, input.runId, input.checkpointDigest);
  const matchingBefore =
    input.runId != null &&
    input.checkpointDigest != null &&
    isExpectedCheckpoint(before, input.runId, input.checkpointDigest);
  const observed = matchingAfter ? after : matchingBefore ? before : undefined;
  const evidence = observed?.evidence?.bindingKind === "checkpoint" ? observed.evidence : undefined;
  const bootstrapAlert =
    after?.evidence?.bindingKind === "state_bootstrap_alert" ? after : undefined;
  const recordId = randomUUID();
  {
    const recorder = await createDiagnosticsRecorder({ path: input.diagnosticsPath });
    try {
      await recorder.append({
        event: "tracking_run.manual_exact_runtime_failed",
        details: {
          recordId,
          invocationId,
          command: command ?? null,
          beforeStateRevision: revision(before) ?? null,
          afterStateRevision: revision(after) ?? null,
        },
        error,
      });
    } finally {
      await recorder.close();
    }
  }
  const stateObservation = after?.stateObservation ??
    before?.stateObservation ?? { kind: "not_observed" as const };
  const sameHead = revision(before) != null && revision(before) === revision(after);
  const readOnly = command === "select-runtime";
  const effectCertainty: FailedRun["failedOperationEffectCertainty"] =
    !input.childStarted ||
    readOnly ||
    (command === "resolve-discord-delivery" && sameHead && matchingAfter)
      ? "no_effect"
      : "ambiguous";
  const common = {
    invocationId,
    failedStage: bootstrapAlert == null ? failedStage(command) : "runtime_bootstrap",
    failedOperationEffectCertainty: effectCertainty,
    evidence: bootstrapAlert?.evidence ?? evidence ?? { bindingKind: "invocation_pre_run_alert" },
    ...(bootstrapAlert != null || evidence == null
      ? {}
      : {
          runId: evidence.runId,
          checkpointDigest: evidence.checkpointDigest,
          checkpointFileDigest: evidence.checkpointFileDigest,
        }),
    lastVerifiedReceipt: undefined,
    stateObservation: bootstrapAlert == null ? stateObservation : bootstrapAlert.stateObservation,
  };
  let failureKind: "invalid_input" | "unexpected" | "content_integrity";
  let publicCode: "invalid_input" | "unexpected_failure" | "invalid_record";
  if (input.inputInvalid) {
    failureKind = "invalid_input";
    publicCode = "invalid_input";
  } else if (bootstrapAlert != null) {
    failureKind = "content_integrity";
    publicCode = "invalid_record";
  } else {
    failureKind = "unexpected";
    publicCode = "unexpected_failure";
  }
  const failure = createFailedRun({
    ...common,
    failureKind,
    publicDiagnostics: { code: publicCode },
    encryptedDiagnosticsRecordIds: [recordId],
  });
  const artifact = createPublicFailureArtifact(failure, nodeContentDigestPort);
  await writeCliJsonArtifact(resolve(input.failureDirectory, `${invocationId}.json`), artifact);
}
