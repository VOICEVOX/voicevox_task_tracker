import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import {
  createFailedRun,
  createPublicFailureArtifact,
  decodePublicFailureArtifact,
  type PublicFailureArtifact,
} from "../../application/tracking-run/failure-artifact.js";
import { selectPrimaryFailureArtifact } from "../../application/tracking-run/failure-primary.js";
import type { DiagnosticsJsonlRecorder } from "../../diagnostics/recorder.js";
import { nodeContentDigestPort } from "./content-digest.js";
import { writeCliJsonArtifact } from "./file-output.js";

function isFileMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

/** 一つのworkflowから届いた全公開失敗artifactを検証して読む。 */
export async function readWorkflowFailureArtifacts(
  directory: string,
): Promise<readonly PublicFailureArtifact[]> {
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error: unknown) {
    if (isFileMissing(error)) {
      return Object.freeze([]);
    }
    throw error;
  }
  const artifacts: PublicFailureArtifact[] = [];
  for (const name of names.sort()) {
    if (!name.endsWith(".json")) {
      continue;
    }
    artifacts.push(
      decodePublicFailureArtifact(await readFile(join(directory, name)), nodeContentDigestPort),
    );
  }
  return Object.freeze(artifacts);
}

/** commandを起動できなかったjob結果だけから基盤障害を記録する。 */
export async function createWorkflowInfrastructureFailure(
  directory: string,
  failedJobs: readonly string[],
  recorder: DiagnosticsJsonlRecorder,
): Promise<PublicFailureArtifact> {
  if (failedJobs.length === 0) {
    throw new TypeError("基盤障害へ対応する失敗jobがありません");
  }
  const invocationId = randomUUID();
  const recordId = randomUUID();
  const error = new Error("workflow commandの公開失敗artifactを観測できません");
  await recorder.append({
    event: "workflow.infrastructure_failure",
    details: { recordId, invocationId, failedJobs: [...failedJobs] },
    error,
  });
  const failure = createFailedRun({
    invocationId,
    failedStage: "workflow_effect_observation",
    failureKind: "workflow_infrastructure_failure",
    failedOperationEffectCertainty: "ambiguous",
    evidence: { bindingKind: "invocation_pre_run_alert" },
    publicDiagnostics: { code: "workflow_infrastructure_failure" },
    encryptedDiagnosticsRecordIds: [recordId],
    lastVerifiedReceipt: undefined,
    stateObservation: { kind: "not_observed" },
  });
  const artifact = createPublicFailureArtifact(failure, nodeContentDigestPort);
  await writeCliJsonArtifact(join(directory, `${invocationId}.json`), artifact);
  return artifact;
}

/** 公開安全性違反を先に確認し、最初のfailed stageを返す。 */
export function primaryAlertFailure(
  artifacts: readonly PublicFailureArtifact[],
): PublicFailureArtifact | undefined {
  if (artifacts.some((artifact) => artifact.failure.failureKind === "public_boundary")) {
    return undefined;
  }
  return selectPrimaryFailureArtifact(artifacts);
}
