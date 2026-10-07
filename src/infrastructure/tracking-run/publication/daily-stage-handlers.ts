import { basename, resolve } from "node:path";
import type { SequentialPublicationInput } from "../sequential-publication-input.js";
import type { PersistedRun } from "./contracts.js";

import type { PerformanceDetailObserver } from "../../../application/tracking-run/contracts/performance-detail-observation.js";
import type { RuntimeIdentity } from "../../../application/tracking-run/contracts/runtime-identity.js";
import {
  PagesEffectNotStartedError,
  publishPagesWithEffect,
} from "../../../application/tracking-run/pages-effect.js";
import type { ReceiptChainEvidence } from "../../../application/tracking-run/receipt-chain-schema.js";
import { verifyReceiptChain } from "../../../application/tracking-run/receipt-chain.js";
import { serializeCanonicalJson } from "../../../canonical-json/value.js";
import { readExactStateSnapshot } from "../../../persistence/index.js";
import { loadStateNotificationLedgers } from "../../../persistence/state-ledger-files.js";
import { nodeContentDigestPort } from "../content-digest.js";
import { parseInitialPagesBuildArtifact } from "../initial-pages-build-artifact.js";
import {
  InitialPagesDeploymentFailureError,
  preflightInitialPagesDeployment,
  recordInitialPagesSequentialDeployment,
  recordInitialPagesSequentialFailure,
} from "../initial-pages-deployment.js";
import { readNotificationMessageState } from "../notification-message-state.js";
import type { BoundPublicationCheckpoint } from "../publication-checkpoint-binding.js";
import { bindPublicationCheckpoint } from "../publication-checkpoint-binding.js";
import {
  decodePublicationArtifact,
  encodePublicationCheckpoint,
  readPublicationArtifactManifest,
  type DecodedPublicationArtifact,
} from "../publication-checkpoint-codec.js";
import { writePublicationCheckpointFile } from "../publication-checkpoint-file.js";
import { nodeCheckpointCompressionPort } from "../publication-checkpoint-gzip.js";
import {
  readPublicationRuntimeContext,
  writeWorkflowRuntimeManifest,
} from "../publication-runtime.js";
import { sequentialPagesArtifactPath } from "../sequential-pages-artifact-path.js";
import { createCollectAnalyzePayload } from "./artifact.js";
import type { DailyPublicationStageHandlers } from "./stage-handler-contracts.js";
import type { RunPublicationAdapters } from "./contracts.js";
import { buildPublicPages } from "./pages.js";
import { assertPlannedAiCacheAdditions, persistValidatedRun } from "./persistence.js";

function roundTripDailyCheckpoint(
  input: SequentialPublicationInput,
  runtimeIdentity: RuntimeIdentity,
  observePerformanceDetail: PerformanceDetailObserver | undefined,
): DecodedPublicationArtifact {
  const { configuration, planned } = input;
  const validatedPayload = createCollectAnalyzePayload({
    invocation: input.invocation,
    configuration,
    validated: planned.validated,
    diagnostics: input.diagnostics,
  });
  observePerformanceDetail?.({
    step: "checkpoint_payload_created",
    count: planned.validated.snapshot.items.length,
  });
  const artifactFileName = "validated-run.cpk";
  const encoded = encodePublicationCheckpoint(
    { planned, validatedPayload, runtimeIdentity, artifactFileName },
    nodeContentDigestPort,
    nodeCheckpointCompressionPort,
  );
  observePerformanceDetail?.({
    step: "checkpoint_encoded",
    count: 2,
    bytes: encoded.artifactBytes.length + encoded.sidecarBytes.length,
  });
  if (observePerformanceDetail != null) {
    const { artifact } = readPublicationArtifactManifest(encoded.artifactBytes);
    observePerformanceDetail({
      step: "checkpoint_artifact_encoded",
      bytes: encoded.artifactBytes.length,
    });
    observePerformanceDetail({
      step: "checkpoint_sidecar_encoded",
      bytes: encoded.sidecarBytes.length,
    });
    observePerformanceDetail({
      step: "checkpoint_frames_encoded",
      count: artifact.logical.frames.length,
      bytes: artifact.logical.frames.reduce((sum, frame) => sum + frame.uncompressedByteLength, 0),
    });
  }
  const decoded = decodePublicationArtifact(
    encoded.artifactBytes,
    encoded.sidecarBytes,
    {
      runtimeIdentity,
      expectedRunId: input.invocation.runId,
      baseStateRevision: planned.validated.core.baseRevision,
      configDigest: planned.validated.core.configDigest,
      artifactFileName,
    },
    nodeContentDigestPort,
    nodeCheckpointCompressionPort,
  );
  observePerformanceDetail?.({
    step: "checkpoint_decoded",
    count: decoded.validated.evidenceClosureWitness.resolvedUses.length,
  });
  return decoded;
}

/** 完全性検証済みrunをcodec往復済みcheckpointへ結ぶ。 */
export async function prepareDailyCheckpoint(
  dependencies: Readonly<{
    adapters: Pick<
      RunPublicationAdapters,
      | "repositoryPath"
      | "environment"
      | "createStateBranchAdapter"
      | "now"
      | "observePerformanceDetail"
    >;
  }>,
  input: SequentialPublicationInput,
): Promise<BoundPublicationCheckpoint> {
  const { configuration, planned } = input;
  if (
    nodeContentDigestPort.sha256Utf8(serializeCanonicalJson(configuration.config)) !==
    planned.validated.core.configDigest
  ) {
    throw new TypeError("sequential checkpointの設定digestが一致しません");
  }
  const runtime = await readPublicationRuntimeContext(
    dependencies.adapters.repositoryPath,
    planned.validated.core.executionPolicy,
    dependencies.adapters.environment,
  );
  const decoded = roundTripDailyCheckpoint(
    input,
    runtime.runtimeIdentity,
    dependencies.adapters.observePerformanceDetail,
  );
  const adapter = dependencies.adapters.createStateBranchAdapter();
  const snapshot = await readExactStateSnapshot(
    adapter,
    configuration.target.state,
    configuration.config.staleness.timezone,
    planned.validated.core.baseRevision,
  );
  dependencies.adapters.observePerformanceDetail?.({
    step: "checkpoint_base_snapshot_read",
    count: snapshot.status === "available" ? snapshot.snapshot.items.length : 0,
  });
  const previousNotificationLedger = await loadStateNotificationLedgers(
    adapter,
    configuration.target.state,
    planned.validated.core.baseRevision,
  );
  dependencies.adapters.observePerformanceDetail?.({
    step: "checkpoint_base_ledger_read",
    count: previousNotificationLedger.entries.length,
  });
  assertPlannedAiCacheAdditions(input.state, decoded.publicationPlan);
  const bound = bindPublicationCheckpoint(
    decoded,
    {
      checkpointFileDigest: decoded.checkpointFileDigest,
      runtimeRecoveryPlan: runtime.runtimeRecoveryPlan,
    },
    {
      revision: planned.validated.core.baseRevision,
      previousSnapshot: snapshot,
      previousNotificationLedger,
    },
    nodeContentDigestPort,
  );
  dependencies.adapters.observePerformanceDetail?.({
    step: "checkpoint_bound",
    count: bound.logicalCandidateCount,
  });
  return bound;
}

/** 検証済みcheckpointから初回stateだけをcommitする。 */
export async function commitDailyCheckpoint(
  dependencies: Readonly<{
    adapters: Pick<
      RunPublicationAdapters,
      "createStateBranchAdapter" | "now" | "observeInitialStateCommit" | "observePerformanceDetail"
    >;
  }>,
  configuration: SequentialPublicationInput["configuration"],
  bound: BoundPublicationCheckpoint,
): Promise<PersistedRun> {
  return persistValidatedRun({
    configuration,
    bound,
    adapter: dependencies.adapters.createStateBranchAdapter(),
    now: dependencies.adapters.now,
    ...(dependencies.adapters.observeInitialStateCommit == null
      ? {}
      : { observeProgress: dependencies.adapters.observeInitialStateCommit }),
    ...(dependencies.adapters.observePerformanceDetail == null
      ? {}
      : { observePerformanceDetail: dependencies.adapters.observePerformanceDetail }),
  });
}

/** 初期保存済みrunをPages生成へ渡す。 */
export async function buildDailyPages(
  dependencies: Readonly<{
    adapters: Pick<
      RunPublicationAdapters,
      | "writePublicData"
      | "buildWebOutput"
      | "pagesOutputDirectory"
      | "createStateBranchAdapter"
      | "repositoryPath"
      | "now"
      | "writeJsonArtifact"
    >;
  }>,
  input: Parameters<DailyPublicationStageHandlers["buildPages"]>[0],
): ReturnType<DailyPublicationStageHandlers["buildPages"]> {
  const { configuration, persisted } = input;
  const result = await buildPublicPages({
    adapter: dependencies.adapters.createStateBranchAdapter(),
    config: configuration.config,
    stateConfiguration: configuration.target.state,
    initialStateCommitReceipt: persisted.result.receipt,
    repositoryPath: dependencies.adapters.repositoryPath,
    writePublicData: dependencies.adapters.writePublicData,
    buildWebOutput: dependencies.adapters.buildWebOutput,
    outputDirectory: dependencies.adapters.pagesOutputDirectory,
    knownSecrets: configuration.credentials.knownSecrets,
    now: dependencies.adapters.now,
  });
  await dependencies.adapters.writeJsonArtifact(
    sequentialPagesArtifactPath(
      dependencies.adapters.repositoryPath,
      result.intent.runId,
      "initial",
      "build",
    ),
    parseInitialPagesBuildArtifact({
      schemaVersion: 1,
      manifest: result.manifest,
      intent: result.intent,
      receipt: result.receipt,
    }),
  );
  return result;
}

/** 初回Pages intentを確認し、productionまたはsandboxの結果を記録する。 */
export async function deployDailyPages(
  dependencies: Readonly<{
    adapters: Pick<
      RunPublicationAdapters,
      | "repositoryPath"
      | "createStateBranchAdapter"
      | "deployProductionPages"
      | "now"
      | "writeJsonArtifact"
    >;
  }>,
  input: Parameters<DailyPublicationStageHandlers["deployPages"]>[0],
): ReturnType<DailyPublicationStageHandlers["deployPages"]> {
  const artifact = parseInitialPagesBuildArtifact({
    schemaVersion: 1,
    manifest: input.pagesPrepared.manifest,
    intent: input.pagesPrepared.intent,
    receipt: input.pagesPrepared.receipt,
  });
  return publishPagesWithEffect(artifact, {
    preflight: (build) =>
      preflightInitialPagesDeployment({
        adapter: dependencies.adapters.createStateBranchAdapter(),
        configuration: input.configuration.target.state,
        repositoryPath: dependencies.adapters.repositoryPath,
        artifact: build,
        initialStateCommitReceipt: input.persisted.result.receipt,
        replay: false,
        observedAt: dependencies.adapters.now().toISOString(),
        effectTarget: input.configuration.target.kind,
      }),
    intent: (build) => build.intent,
    deploy: async (intent) => {
      if (input.configuration.target.kind !== "production") {
        return { kind: "deployed", result: undefined };
      }
      try {
        return {
          kind: "deployed",
          result: await dependencies.adapters.deployProductionPages(intent),
        };
      } catch (cause: unknown) {
        if (cause instanceof PagesEffectNotStartedError) {
          return { kind: "no_effect", cause };
        }
        throw cause;
      }
    },
    record: async (build, preflight, observation) => {
      const deployment =
        observation.kind === "no_effect" || observation.kind === "ambiguous"
          ? recordInitialPagesSequentialFailure(build, preflight, observation.kind)
          : recordInitialPagesSequentialDeployment({
              artifact: build,
              preflight,
              target: input.configuration.target.kind === "production" ? "production" : "recording",
              ...(observation.kind !== "deployed" || observation.result == null
                ? {}
                : { productionResult: observation.result }),
              recordingId: `${input.invocation.runId}:${build.intent.deploymentIntentDigest}`,
              observedAt: dependencies.adapters.now().toISOString(),
            });
      await dependencies.adapters.writeJsonArtifact(
        sequentialPagesArtifactPath(
          dependencies.adapters.repositoryPath,
          input.invocation.runId,
          "initial",
          "deployment",
        ),
        deployment,
      );
      return deployment;
    },
    requirePublished: async (deployment, observation) => {
      if (deployment.kind !== "success") {
        throw new InitialPagesDeploymentFailureError(
          deployment,
          observation.kind === "ambiguous" || observation.kind === "no_effect"
            ? observation.cause
            : undefined,
        );
      }
      if (deployment.receipt.result == null) {
        throw new TypeError("初回Pages公開の成功receiptに結果がありません");
      }
      let receiptEvidence: ReceiptChainEvidence = { kind: "none" };
      if (deployment.receipt.receiptKind === "observed") {
        const revision = deployment.receipt.expectedStateRevision;
        if (typeof revision !== "string") {
          throw new TypeError("再観測した初回Pagesにexact state revisionがありません");
        }
        const state = await readNotificationMessageState(
          dependencies.adapters.createStateBranchAdapter(),
          input.configuration.target.state,
          revision,
        );
        const marker = state.transaction.marker;
        if (
          marker.phase === "initial_state_committed" ||
          state.transaction.initialPagesEvidence == null ||
          serializeCanonicalJson(state.transaction.initialPagesEvidence) !==
            serializeCanonicalJson(deployment.evidence)
        ) {
          throw new TypeError("初回Pagesの再観測receiptとexact state証拠が一致しません");
        }
        receiptEvidence = {
          kind: "initial_pages_state",
          state: {
            exactStateRevision: revision,
            marker: {
              runId: marker.runId,
              checkpointDigest: marker.checkpointDigest,
              phase: marker.phase,
              initialPagesPublicationEvidenceDigest: marker.initialPagesPublicationEvidenceDigest,
              initialStateRevision: marker.initialStateRevision,
            },
            evidence: deployment.evidence,
          },
        };
        verifyReceiptChain(
          [{ receipt: deployment.receipt, evidence: receiptEvidence }],
          nodeContentDigestPort,
        );
      }
      return Object.freeze({
        prepared: input.pagesPrepared,
        deployment,
        pagesUrl: deployment.receipt.result.pageUrl,
        receiptEvidence,
      });
    },
  });
}

/** 日次runの解析結果からworkflow artifactを書き出す。 */
export async function writeDailyCollectAnalyzeArtifact(
  dependencies: Readonly<{
    adapters: Pick<RunPublicationAdapters, "repositoryPath" | "environment" | "writeJsonArtifact">;
  }>,
  path: string,
  stageInput: Parameters<DailyPublicationStageHandlers["writeCollectAnalyzeArtifact"]>[1],
): Promise<void> {
  await writeWorkflowRuntimeManifest(dependencies.adapters.repositoryPath);
  const runtime = await readPublicationRuntimeContext(
    dependencies.adapters.repositoryPath,
    stageInput.planned.validated.core.executionPolicy,
    dependencies.adapters.environment,
  );
  const validatedPayload = createCollectAnalyzePayload({
    invocation: stageInput.invocation,
    configuration: stageInput.configuration,
    validated: stageInput.planned.validated,
    diagnostics: stageInput.diagnostics,
  });
  const outputPath = resolve(dependencies.adapters.repositoryPath, path);
  const encoded = encodePublicationCheckpoint(
    {
      planned: stageInput.planned,
      validatedPayload,
      runtimeIdentity: runtime.runtimeIdentity,
      artifactFileName: basename(outputPath),
      analysisCompletedStages: stageInput.completedStages,
    },
    nodeContentDigestPort,
    nodeCheckpointCompressionPort,
  );
  await writePublicationCheckpointFile(outputPath, encoded);
}
