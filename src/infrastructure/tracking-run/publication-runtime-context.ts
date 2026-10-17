import { z } from "zod";

import type { RuntimeIdentity } from "../../application/tracking-run/contracts/runtime-identity.js";
import { runtimeRecoveryPlanSchema } from "../../application/tracking-run/recovery-bootstrap.js";
import type { RunExecutionPolicy } from "../../application/tracking-run/request.js";
import { serializeCanonicalJson } from "../../canonical-json/value.js";
import { nodeContentDigestPort } from "./content-digest.js";
import { createManifest, readWorkflowRuntimeManifest } from "./publication-runtime-manifest.js";
import { assertWorkflowV2Adapter } from "./workflow-v2-adapter.js";

/** 実行byte列と回復計画の実測値。 */
export type PublicationRuntimeContext = Readonly<{
  runtimeIdentity: RuntimeIdentity;
  runtimeRecoveryPlan: z.output<typeof runtimeRecoveryPlanSchema>;
}>;

/** 永続workflow run identityと現在のActions起動を照合して再公開を判定する。 */
export function isWorkflowPublicationReplay(
  plan: PublicationRuntimeContext["runtimeRecoveryPlan"],
  environment: Readonly<NodeJS.ProcessEnv>,
): boolean {
  if (plan.kind !== "workflow_bundle") {
    throw new TypeError("Pages再公開判定にはworkflow bundle計画が必要です");
  }
  const workflowRunId = environment["GITHUB_RUN_ID"];
  const workflowRunAttempt = environment["GITHUB_RUN_ATTEMPT"];
  if (
    workflowRunId == null ||
    !/^\d+$/u.test(workflowRunId) ||
    workflowRunAttempt == null ||
    !/^[1-9]\d*$/u.test(workflowRunAttempt) ||
    !Number.isSafeInteger(Number(workflowRunAttempt))
  ) {
    throw new TypeError("Pages再公開判定にActions run identityがありません");
  }
  return (
    plan.workflowRunId !== workflowRunId || plan.workflowRunAttempt !== Number(workflowRunAttempt)
  );
}

/** 実行build outputを検証してcheckpointへ固定するruntime識別を返す。 */
export async function readPublicationRuntimeContext(
  repositoryPath: string,
  policy: RunExecutionPolicy,
  environment: Readonly<NodeJS.ProcessEnv>,
): Promise<PublicationRuntimeContext> {
  const shape = policy.executionShape;
  const manifest =
    shape === "split_workflow"
      ? await readWorkflowRuntimeManifest(repositoryPath, nodeContentDigestPort)
      : await createManifest(repositoryPath, shape, nodeContentDigestPort);
  if (shape === "split_workflow" && manifest.schemaVersion !== 2) {
    throw new TypeError("分割workflowのruntime manifestはV2が必要です");
  }
  if (shape === "split_workflow") {
    await assertWorkflowV2Adapter(repositoryPath);
  }
  const manifestDigest = nodeContentDigestPort.sha256Utf8(serializeCanonicalJson(manifest));
  const runtimeIdentity: RuntimeIdentity =
    shape === "split_workflow"
      ? {
          kind: "workflow_bundle",
          codeRevision: manifest.codeRevision,
          bundleSha256: manifestDigest,
          lockfileSha256: manifest.lockfileSha256,
          toolchain: manifest.toolchain,
        }
      : {
          kind: "source_process",
          codeRevision: manifest.codeRevision,
          runtimeManifestSha256: manifestDigest,
          lockfileSha256: manifest.lockfileSha256,
          toolchain: manifest.toolchain,
        };
  let runtimeRecoveryPlan: z.output<typeof runtimeRecoveryPlanSchema>;
  const planVersion = shape === "split_workflow" ? 2 : 1;
  if (manifest.codeRevision.startsWith("worktree:")) {
    runtimeRecoveryPlan = runtimeRecoveryPlanSchema.parse({
      schemaVersion: planVersion,
      kind: "not_reproducible",
      reason: "dirty_worktree",
      runtimeIdentityDigest: nodeContentDigestPort.sha256Utf8(
        serializeCanonicalJson(runtimeIdentity),
      ),
    });
  } else if (runtimeIdentity.kind === "source_process") {
    runtimeRecoveryPlan = runtimeRecoveryPlanSchema.parse({
      schemaVersion: 1,
      kind: "rebuild_exact",
      codeRevision: manifest.codeRevision,
      lockfileSha256: manifest.lockfileSha256,
      toolchain: manifest.toolchain,
      expectedRuntimeManifestSha256: manifestDigest,
      recoveryProtocol: manifest.recoveryProtocol,
    });
  } else if (
    environment["GITHUB_RUN_ID"] != null &&
    environment["GITHUB_RUN_ATTEMPT"] != null &&
    /^\d+$/u.test(environment["GITHUB_RUN_ID"]) &&
    /^[1-9]\d*$/u.test(environment["GITHUB_RUN_ATTEMPT"])
  ) {
    runtimeRecoveryPlan = runtimeRecoveryPlanSchema.parse({
      schemaVersion: planVersion,
      kind: "workflow_bundle",
      workflowRunId: environment["GITHUB_RUN_ID"],
      workflowRunAttempt: Number(environment["GITHUB_RUN_ATTEMPT"]),
      artifactName: "workflow-cli-runtime",
      bundleSha256: manifestDigest,
      codeRevision: manifest.codeRevision,
      lockfileSha256: manifest.lockfileSha256,
      toolchain: manifest.toolchain,
      recoveryProtocol: manifest.recoveryProtocol,
    });
  } else {
    runtimeRecoveryPlan = runtimeRecoveryPlanSchema.parse({
      schemaVersion: planVersion,
      kind: "not_reproducible",
      reason: "runtime_artifact_unavailable",
      runtimeIdentityDigest: nodeContentDigestPort.sha256Utf8(
        serializeCanonicalJson(runtimeIdentity),
      ),
    });
  }
  return Object.freeze({ runtimeIdentity, runtimeRecoveryPlan });
}
