import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { z } from "zod";

import {
  initialPagesPublicationEvidenceSchema,
  parseInitialPagesPublicationEvidence,
} from "../../application/tracking-run/initial-pages-evidence-codec.js";
import { createInitialPagesPublicationEvidence } from "../../application/tracking-run/initial-pages-evidence.js";
import { verifyReceiptChain } from "../../application/tracking-run/receipt-chain.js";
import {
  createReceipt,
  observeInitialPagesDeployment,
  parseReceipt,
} from "../../application/tracking-run/receipt-codec.js";
import type {
  InitialStateCommitReceipt,
  PagesDeploymentExternalReference,
  PagesDeploymentReceipt,
} from "../../application/tracking-run/receipt-schema.js";
import {
  pagesDeploymentExternalReferenceSchema,
  pagesPublicUrlSchema,
  receiptSchema,
} from "../../application/tracking-run/receipt-schema.js";
import { serializeCanonicalJson, serializeCanonicalJsonLine } from "../../canonical-json/value.js";
import { readPagesContentManifest } from "../../pages/build-web-output.js";
import type {
  StateBranchAdapter,
  StatePersistenceConfiguration,
} from "../../persistence/branch-adapter.js";
import { authorizeAdvanceAfterOrthogonalCommits } from "../../persistence/state-orthogonal-advance.js";
import { verifyRunTransactionFiles } from "../../persistence/state-transaction-files.js";
import { nodeContentDigestPort as digest } from "./content-digest.js";
import {
  decodeInitialPagesBuildArtifact,
  type InitialPagesBuildArtifact,
} from "./initial-pages-build-artifact.js";
import { verifyInitialStateCommitReceiptAtRevision } from "./initial-pages-source.js";
import { resumeInitialPagesDeploy } from "./publication-resume-inputs.js";

const sha256Schema = z.string().regex(/^sha256:[0-9a-f]{64}$/u);
const revisionSchema = z.string().regex(/^[0-9a-f]{40}$/u);
const MAX_DEPLOYMENT_ARTIFACT_BYTES = 1024 * 1024;
const preflightSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    schemaVersion: z.literal(1),
    kind: z.literal("ready"),
    deploymentIntentDigest: sha256Schema,
    observedHeadRevision: revisionSchema,
    replay: z.boolean(),
  }),
  z.strictObject({
    schemaVersion: z.literal(1),
    kind: z.literal("observed"),
    deploymentIntentDigest: sha256Schema,
    observedHeadRevision: revisionSchema,
    receipt: receiptSchema.options[2],
    evidence: initialPagesPublicationEvidenceSchema,
  }),
  z.strictObject({
    schemaVersion: z.literal(1),
    kind: z.literal("superseded"),
    deploymentIntentDigest: sha256Schema,
    observedHeadRevision: revisionSchema,
    receipt: receiptSchema.options[2],
  }),
]);

const workflowActionObservationSchema = z.strictObject({
  schemaVersion: z.literal(1),
  phase: z.literal("initial"),
  deploymentIntentDigest: sha256Schema,
  uploadOutcome: z.enum(["success", "failure", "skipped"]),
  deploymentOutcome: z.enum(["success", "failure", "skipped"]),
  artifactName: z.string().min(1),
  artifactId: z.string().min(1).optional(),
  artifactDigest: sha256Schema.optional(),
  deploymentId: z.string().min(1).optional(),
  pageUrl: pagesPublicUrlSchema.optional(),
});

const sequentialPagesResultSchema = z.strictObject({
  deploymentReference: z.string().min(1),
  pageUrl: pagesPublicUrlSchema,
  adapterIdentityDigest: sha256Schema,
  actionsArtifact: pagesDeploymentExternalReferenceSchema.options[0].shape.actionsArtifact,
  effectOccurredAt: z.iso.datetime({ offset: true }).optional(),
});

const deploymentOutcomeSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    schemaVersion: z.literal(1),
    kind: z.literal("success"),
    receipt: receiptSchema.options[2],
    evidence: initialPagesPublicationEvidenceSchema,
  }),
  z.strictObject({
    schemaVersion: z.literal(1),
    kind: z.literal("failure"),
    reason: z.enum(["action_failed", "effect_unconfirmed", "superseded_by_newer_run"]),
    effectCertainty: z.enum(["no_effect", "ambiguous"]),
    runId: z.string().regex(/^tracker-run:[0-9a-f]{64}$/u),
    checkpointDigest: sha256Schema,
    deploymentIntentDigest: sha256Schema,
    observedHeadRevision: revisionSchema,
    receipt: receiptSchema.options[2].optional(),
  }),
]);

/** deploy直前の正本照合と再実行判定。 */
export type InitialPagesDeploymentPreflight = z.output<typeof preflightSchema>;

/** workflow actionが公開した値だけを持つ観測結果。 */
export type WorkflowPagesActionObservation = z.output<typeof workflowActionObservationSchema>;

/** 初回Pages公開の成功証拠または型付き失敗。 */
export type InitialPagesDeploymentOutcome = z.output<typeof deploymentOutcomeSchema>;

/** 初回Pagesの確定できなかった結果をCLI境界へ渡す。 */
export class InitialPagesDeploymentFailureError extends Error {
  public readonly outcome: Extract<InitialPagesDeploymentOutcome, { kind: "failure" }>;

  public constructor(
    outcome: Extract<InitialPagesDeploymentOutcome, { kind: "failure" }>,
    cause: unknown,
  ) {
    super(`初回Pages公開を確定できません。種別: ${outcome.reason}`, { cause });
    this.name = "InitialPagesDeploymentFailureError";
    this.outcome = outcome;
  }
}

/** sequential production portが確認して返す公開結果。 */
export type SequentialPagesResult = z.output<typeof sequentialPagesResultSchema>;

/** canonical JSONのdeploy直前判定を読む。 */
export async function readInitialPagesDeploymentPreflight(
  path: string,
): Promise<InitialPagesDeploymentPreflight> {
  const bytes = await readFile(path);
  if (bytes.length > MAX_DEPLOYMENT_ARTIFACT_BYTES) {
    throw new TypeError("Pages deploy直前判定が許容byte数を超えています");
  }
  const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const raw: unknown = JSON.parse(source);
  if (source !== serializeCanonicalJsonLine(raw)) {
    throw new TypeError("Pages deploy直前判定がcanonical JSONではありません");
  }
  const preflight = preflightSchema.parse(raw);
  if (preflight.kind !== "ready") {
    parseReceipt(preflight.receipt, digest);
  }
  return preflight;
}

async function readTransaction(
  adapter: StateBranchAdapter,
  configuration: StatePersistenceConfiguration,
  revision: string,
): Promise<NonNullable<ReturnType<typeof verifyRunTransactionFiles>>> {
  const paths = await adapter.listFiles(revision, "state");
  const files = await adapter.readFiles(revision, paths);
  if (files.size !== paths.length || paths.some((path) => files.get(path)?.status !== "present")) {
    throw new TypeError("Pages deployのexact state file一覧が不足しています");
  }
  const transaction = verifyRunTransactionFiles(files, configuration);
  if (transaction == null) {
    throw new TypeError("Pages deployのexact stateにrun transactionがありません");
  }
  return transaction;
}

async function assertOutputManifest(
  repositoryPath: string,
  artifact: InitialPagesBuildArtifact,
): Promise<void> {
  const output = await readPagesContentManifest(
    resolve(repositoryPath, artifact.intent.outputDirectory),
  );
  if (
    output.outputManifestDigest !== artifact.intent.outputManifestDigest ||
    output.pagesContentDigest !== artifact.intent.pagesContentDigest ||
    serializeCanonicalJson(output.manifest) !== serializeCanonicalJson(artifact.manifest)
  ) {
    throw new TypeError("deploy直前のPages全file manifestがbuild receiptと一致しません");
  }
}

function deploymentReceipt(
  artifact: InitialPagesBuildArtifact,
  status: "deployed" | "replayed_same_content" | "superseded_by_newer_run",
  observedAt: string,
  result?: PagesDeploymentReceipt["result"],
  effectOccurredAt?: string,
): PagesDeploymentReceipt {
  const build = artifact.receipt;
  const receipt = createReceipt(
    {
      schemaVersion: 1,
      receiptType: "pages_deployment",
      stage: "initial_pages_published",
      phase: "initial",
      binding: build.binding,
      logicalTarget: artifact.intent.deploymentIntentDigest,
      invocationId: randomUUID(),
      localAttemptIndex: 0,
      phaseSequence: build.phaseSequence + 1,
      previousReceiptDigest: build.receiptDigest,
      expectedStateRevision: artifact.intent.sourceStateRevision,
      receiptKind: status === "superseded_by_newer_run" ? "superseded" : "executed",
      observedAt,
      ...(effectOccurredAt == null ? {} : { effectOccurredAt }),
      status,
      effectCertainty: status === "superseded_by_newer_run" ? "no_effect" : "committed",
      ...(status === "superseded_by_newer_run"
        ? { publicDiagnosticCode: "superseded_by_newer_run" }
        : {}),
      ...(result == null ? {} : { result }),
    },
    digest,
  );
  if (receipt.receiptType !== "pages_deployment") {
    throw new TypeError("Pages deployment receiptの種別が不正です");
  }
  return receipt;
}

function failedDeployment(
  artifact: InitialPagesBuildArtifact,
  preflight: InitialPagesDeploymentPreflight,
  reason: "action_failed" | "effect_unconfirmed",
  effectCertainty: "no_effect" | "ambiguous",
): InitialPagesDeploymentOutcome {
  return deploymentOutcomeSchema.parse({
    schemaVersion: 1,
    kind: "failure",
    reason,
    effectCertainty,
    runId: artifact.intent.runId,
    checkpointDigest: artifact.intent.checkpointDigest,
    deploymentIntentDigest: artifact.intent.deploymentIntentDigest,
    observedHeadRevision: preflight.observedHeadRevision,
  });
}

/** 直列portが公開不可または応答不明と観測した結果を保存する。 */
export function recordInitialPagesSequentialFailure(
  artifact: InitialPagesBuildArtifact,
  preflight: InitialPagesDeploymentPreflight,
  effectCertainty: "no_effect" | "ambiguous",
): InitialPagesDeploymentOutcome {
  if (preflight.kind !== "ready") {
    throw new TypeError("Pages公開を開始していないpreflightへeffect失敗を付けられません");
  }
  return failedDeployment(
    artifact,
    preflight,
    effectCertainty === "no_effect" ? "action_failed" : "effect_unconfirmed",
    effectCertainty,
  );
}

/** remote stateと出力全fileをdeploy直前に再検証する。 */
export async function preflightInitialPagesDeployment(
  input: Readonly<{
    adapter: StateBranchAdapter;
    configuration: StatePersistenceConfiguration;
    repositoryPath: string;
    artifact: InitialPagesBuildArtifact;
    initialStateCommitReceipt: InitialStateCommitReceipt;
    replay: boolean;
    previousOutcome?: InitialPagesDeploymentOutcome;
    observedAt: string;
    effectTarget: "production" | "sandbox" | "recording";
    adapterIdentityDigest?: string;
  }>,
): Promise<InitialPagesDeploymentPreflight> {
  const artifact = decodeInitialPagesBuildArtifact(
    new TextEncoder().encode(serializeCanonicalJsonLine(input.artifact)),
  );
  await assertOutputManifest(input.repositoryPath, artifact);
  if (artifact.receipt.binding.bindingKind !== "checkpoint") {
    throw new TypeError("Pages build receiptにcheckpoint結合がありません");
  }
  const source = await readTransaction(
    input.adapter,
    input.configuration,
    artifact.intent.sourceStateRevision,
  );
  if (source.marker.phase !== "initial_state_committed") {
    throw new TypeError("Pages deploy指示の初回stateが初回commit段階にありません");
  }
  const initialReceipt = parseReceipt(input.initialStateCommitReceipt, digest);
  if (initialReceipt.receiptType !== "initial_state_commit") {
    throw new TypeError("Pages deploy指示に初回state commit receiptがありません");
  }
  const initialEvidence = await verifyInitialStateCommitReceiptAtRevision(
    input.adapter,
    input.configuration,
    initialReceipt,
    input.observedAt,
  );
  resumeInitialPagesDeploy(
    {
      record: source.record,
      state: {
        revision: artifact.intent.sourceStateRevision,
        snapshotDigest: source.snapshotDigest,
        normalNotificationLedgerDigest: source.notificationLedgerDigest,
        marker: {
          runId: source.marker.runId,
          checkpointDigest: source.marker.checkpointDigest,
          publicationRecordDigest: source.marker.publicationRecordDigest,
          phase: source.marker.phase,
          phaseSequence: source.marker.phaseSequence,
        },
      },
      expectedRevision: artifact.intent.sourceStateRevision,
      initialStateCommitReceipt: initialReceipt,
      ...(initialReceipt.receiptKind === "observed"
        ? { initialStateCommitEvidence: initialEvidence }
        : {}),
      initialPagesBuildReceipt: artifact.receipt,
    },
    digest,
  );
  verifyReceiptChain(
    [
      {
        receipt: initialReceipt,
        evidence:
          initialReceipt.receiptKind === "observed"
            ? { kind: "state_commit", state: initialEvidence }
            : { kind: "none" },
      },
      { receipt: artifact.receipt, evidence: { kind: "none" } },
    ],
    digest,
  );
  if (source.record.executionPolicy.effectTarget !== input.effectTarget) {
    throw new TypeError("Pages deploy指示のeffect targetがadapterと一致しません");
  }
  if (
    input.adapterIdentityDigest != null &&
    (source.record.runtimeRecoveryPlan.kind !== "workflow_bundle" ||
      source.record.runtimeRecoveryPlan.recoveryProtocol.workflowEffectAdapterIdentityDigest !==
        input.adapterIdentityDigest)
  ) {
    throw new TypeError("Pages action adapterがrecordの回復契約と一致しません");
  }
  if (
    source.marker.runId !== artifact.intent.runId ||
    source.marker.checkpointDigest !== artifact.intent.checkpointDigest ||
    source.record.recordDigest !== artifact.intent.recordDigest ||
    source.snapshotDigest !== artifact.intent.snapshotDigest ||
    source.record.initialPagesProjection.repositoryAllowlistDigest !==
      artifact.intent.repositoryAllowlistDigest ||
    source.record.initialPagesProjection.settings.url !== artifact.intent.expectedPageUrl
  ) {
    throw new TypeError("Pages deploy指示と初回state revisionが一致しません");
  }
  const previous =
    input.previousOutcome == null
      ? undefined
      : parseInitialPagesDeploymentOutcome(input.previousOutcome, artifact);
  if (previous?.kind === "success") {
    const reference = previous.evidence.externalReference;
    if (
      serializeCanonicalJson(previous.receipt.binding) !==
        serializeCanonicalJson(artifact.receipt.binding) ||
      (input.adapterIdentityDigest != null &&
        (reference.kind !== "github_pages_actions" ||
          reference.adapterIdentityDigest !== input.adapterIdentityDigest)) ||
      (input.adapterIdentityDigest == null &&
        input.effectTarget === "production" &&
        reference.kind !== "github_pages_actions") ||
      (input.effectTarget !== "production" && reference.kind !== "recording")
    ) {
      throw new TypeError("保存済み初回Pages結果のadapterまたはcheckpoint結合が一致しません");
    }
  } else if (previous != null && previous.effectCertainty !== "no_effect") {
    throw new TypeError("初回Pagesの先行公開結果を自動再試行できません");
  }
  const head = await input.adapter.resolveHead(input.configuration.branch);
  if (head.status !== "present") {
    throw new TypeError("Pages deploy直前のremote state branchがありません");
  }
  const current = await readTransaction(input.adapter, input.configuration, head.revision);
  if (current.marker.runId !== artifact.intent.runId) {
    return preflightSchema.parse({
      schemaVersion: 1,
      kind: "superseded",
      deploymentIntentDigest: artifact.intent.deploymentIntentDigest,
      observedHeadRevision: head.revision,
      receipt: deploymentReceipt(artifact, "superseded_by_newer_run", input.observedAt),
    });
  }
  if (
    current.marker.checkpointDigest !== artifact.intent.checkpointDigest ||
    current.record.recordDigest !== artifact.intent.recordDigest ||
    current.snapshotDigest !== artifact.intent.snapshotDigest
  ) {
    throw new TypeError("Pages deploy直前のremote stateとintentが一致しません");
  }
  if (current.marker.phase !== "initial_state_committed") {
    if (current.initialPagesEvidence == null) {
      throw new TypeError("通知開始後のstateにPages保存証拠がありません");
    }
    if (
      previous != null &&
      (previous.kind !== "success" ||
        serializeCanonicalJson(previous.evidence) !==
          serializeCanonicalJson(current.initialPagesEvidence))
    ) {
      throw new TypeError("初回Pagesの保存済み結果とremote証拠が一致しません");
    }
    const observed = observeInitialPagesDeployment(
      {
        state: {
          exactStateRevision: head.revision,
          marker: {
            runId: current.marker.runId,
            checkpointDigest: current.marker.checkpointDigest,
            phase: current.marker.phase,
            initialPagesPublicationEvidenceDigest: current.initialPagesEvidence.evidenceDigest,
            initialStateRevision: current.marker.initialStateRevision,
          },
          evidence: current.initialPagesEvidence,
        },
        binding: artifact.receipt.binding,
        invocationId: randomUUID(),
        localAttemptIndex: 0,
        phaseSequence: artifact.receipt.phaseSequence + 1,
        previousReceiptDigest: artifact.receipt.receiptDigest,
        observedAt: input.observedAt,
      },
      digest,
    );
    if (
      observed.result?.deploymentIntentDigest !== artifact.intent.deploymentIntentDigest ||
      observed.result.pagesContentDigest !== artifact.intent.pagesContentDigest
    ) {
      throw new TypeError("保存済みPages証拠が現在のintentと一致しません");
    }
    return preflightSchema.parse({
      schemaVersion: 1,
      kind: "observed",
      deploymentIntentDigest: artifact.intent.deploymentIntentDigest,
      observedHeadRevision: head.revision,
      receipt: observed,
      evidence: current.initialPagesEvidence,
    });
  }
  await authorizeAdvanceAfterOrthogonalCommits(
    input.adapter,
    input.configuration,
    artifact.intent.sourceStateRevision,
    head.revision,
  );
  if (previous?.kind === "success") {
    return preflightSchema.parse({
      schemaVersion: 1,
      kind: "observed",
      deploymentIntentDigest: artifact.intent.deploymentIntentDigest,
      observedHeadRevision: head.revision,
      receipt: previous.receipt,
      evidence: previous.evidence,
    });
  }
  return preflightSchema.parse({
    schemaVersion: 1,
    kind: "ready",
    deploymentIntentDigest: artifact.intent.deploymentIntentDigest,
    observedHeadRevision: head.revision,
    replay: input.replay || previous != null,
  });
}

/** action出力を検証し、成功receiptか型付き失敗を確定する。 */
export function recordInitialPagesWorkflowDeployment(
  input: Readonly<{
    artifact: InitialPagesBuildArtifact;
    preflight: InitialPagesDeploymentPreflight;
    observation: unknown;
    adapterIdentityDigest: string;
    observedAt: string;
  }>,
): InitialPagesDeploymentOutcome {
  const artifact = decodeInitialPagesBuildArtifact(
    new TextEncoder().encode(serializeCanonicalJsonLine(input.artifact)),
  );
  const preflight = preflightSchema.parse(input.preflight);
  const intent = artifact.intent;
  if (preflight.deploymentIntentDigest !== intent.deploymentIntentDigest) {
    throw new TypeError("Pages action観測とdeploy指示が一致しません");
  }
  const parsedObservation = workflowActionObservationSchema.safeParse(input.observation);
  if (!parsedObservation.success) {
    return failedDeployment(artifact, preflight, "effect_unconfirmed", "ambiguous");
  }
  const observation = parsedObservation.data;
  if (observation.deploymentIntentDigest !== intent.deploymentIntentDigest) {
    return failedDeployment(artifact, preflight, "effect_unconfirmed", "ambiguous");
  }
  if (preflight.kind === "superseded") {
    if (observation.uploadOutcome !== "skipped" || observation.deploymentOutcome !== "skipped") {
      return failedDeployment(artifact, preflight, "effect_unconfirmed", "ambiguous");
    }
    return deploymentOutcomeSchema.parse({
      schemaVersion: 1,
      kind: "failure",
      reason: "superseded_by_newer_run",
      effectCertainty: "no_effect",
      runId: intent.runId,
      checkpointDigest: intent.checkpointDigest,
      deploymentIntentDigest: intent.deploymentIntentDigest,
      observedHeadRevision: preflight.observedHeadRevision,
      receipt: preflight.receipt,
    });
  }
  if (preflight.kind === "observed") {
    if (observation.uploadOutcome !== "skipped" || observation.deploymentOutcome !== "skipped") {
      return failedDeployment(artifact, preflight, "effect_unconfirmed", "ambiguous");
    }
    if (preflight.evidence.externalReference.kind !== "github_pages_actions") {
      throw new TypeError("workflow Pagesの保存証拠がActions deployではありません");
    }
    return deploymentOutcomeSchema.parse({
      schemaVersion: 1,
      kind: "success",
      receipt: preflight.receipt,
      evidence: preflight.evidence,
    });
  }
  if (observation.uploadOutcome !== "success" || observation.deploymentOutcome !== "success") {
    return observation.deploymentOutcome === "failure" ||
      observation.deploymentOutcome === "success"
      ? failedDeployment(artifact, preflight, "effect_unconfirmed", "ambiguous")
      : failedDeployment(artifact, preflight, "action_failed", "no_effect");
  }
  if (observation.deploymentId == null || observation.pageUrl == null) {
    return failedDeployment(artifact, preflight, "effect_unconfirmed", "ambiguous");
  }
  if (observation.pageUrl !== intent.expectedPageUrl) {
    return failedDeployment(artifact, preflight, "effect_unconfirmed", "ambiguous");
  }
  if (observation.artifactDigest != null && observation.artifactId == null) {
    return failedDeployment(artifact, preflight, "effect_unconfirmed", "ambiguous");
  }
  const actionsArtifact: Extract<
    PagesDeploymentExternalReference,
    { kind: "github_pages_actions" }
  >["actionsArtifact"] =
    observation.artifactId == null
      ? {
          kind: "not_exposed",
          artifactName: observation.artifactName,
          limitation: "action_did_not_expose_artifact_id_or_digest",
        }
      : observation.artifactDigest == null
        ? {
            kind: "identified_without_digest",
            artifactId: observation.artifactId,
            limitation: "action_did_not_expose_artifact_digest",
          }
        : {
            kind: "identified",
            artifactId: observation.artifactId,
            artifactDigest: observation.artifactDigest,
          };
  const receipt = deploymentReceipt(
    artifact,
    preflight.replay ? "replayed_same_content" : "deployed",
    input.observedAt,
    {
      deploymentIntentDigest: intent.deploymentIntentDigest,
      pagesContentDigest: intent.pagesContentDigest,
      sourceStateRevision: intent.sourceStateRevision,
      pageUrl: observation.pageUrl,
      externalReference: {
        kind: "github_pages_actions",
        deploymentId: observation.deploymentId,
        actionsArtifact,
        adapterIdentityDigest: sha256Schema.parse(input.adapterIdentityDigest),
      },
    },
  );
  const evidence = createInitialPagesPublicationEvidence(
    {
      buildReceipt: artifact.receipt,
      deploymentReceipt: receipt,
      sourceStateRevision: intent.sourceStateRevision,
    },
    digest,
  );
  return deploymentOutcomeSchema.parse({ schemaVersion: 1, kind: "success", receipt, evidence });
}

/** 同じintentをsequential productionまたはrecordingの結果へ結び付ける。 */
export function recordInitialPagesSequentialDeployment(
  input: Readonly<{
    artifact: InitialPagesBuildArtifact;
    preflight: InitialPagesDeploymentPreflight;
    target: "production" | "recording";
    productionResult?: unknown;
    recordingId?: string;
    observedAt: string;
  }>,
): InitialPagesDeploymentOutcome {
  const artifact = decodeInitialPagesBuildArtifact(
    new TextEncoder().encode(serializeCanonicalJsonLine(input.artifact)),
  );
  const preflight = preflightSchema.parse(input.preflight);
  if (preflight.deploymentIntentDigest !== artifact.intent.deploymentIntentDigest) {
    throw new TypeError("sequential Pages結果とdeploy指示が一致しません");
  }
  if (preflight.kind === "superseded") {
    return deploymentOutcomeSchema.parse({
      schemaVersion: 1,
      kind: "failure",
      reason: "superseded_by_newer_run",
      effectCertainty: "no_effect",
      runId: artifact.intent.runId,
      checkpointDigest: artifact.intent.checkpointDigest,
      deploymentIntentDigest: artifact.intent.deploymentIntentDigest,
      observedHeadRevision: preflight.observedHeadRevision,
      receipt: preflight.receipt,
    });
  }
  if (preflight.kind === "observed") {
    if (
      (input.target === "production" &&
        preflight.evidence.externalReference.kind !== "github_pages_actions") ||
      (input.target === "recording" && preflight.evidence.externalReference.kind !== "recording")
    ) {
      throw new TypeError("sequential Pagesの保存証拠がeffect targetと一致しません");
    }
    return parseInitialPagesDeploymentOutcome(
      {
        schemaVersion: 1,
        kind: "success",
        receipt: preflight.receipt,
        evidence: preflight.evidence,
      },
      artifact,
    );
  }
  let pageUrl = artifact.intent.expectedPageUrl;
  let effectOccurredAt: string | undefined;
  let externalReference: PagesDeploymentExternalReference;
  if (input.target === "production") {
    const result = sequentialPagesResultSchema.parse(input.productionResult);
    pageUrl = result.pageUrl;
    effectOccurredAt = result.effectOccurredAt;
    externalReference = {
      kind: "github_pages_actions",
      deploymentId: result.deploymentReference,
      actionsArtifact: result.actionsArtifact,
      adapterIdentityDigest: result.adapterIdentityDigest,
    };
  } else {
    if (
      input.productionResult != null ||
      input.recordingId == null ||
      input.recordingId.length === 0
    ) {
      throw new TypeError("recording Pages結果にproduction効果を付けられません");
    }
    externalReference = {
      kind: "recording",
      recordingId: input.recordingId,
      adapterIdentityDigest: digest.sha256Utf8("initial-pages-recording-adapter-v1"),
      productionEffect: false,
    };
  }
  if (pageUrl !== artifact.intent.expectedPageUrl) {
    throw new TypeError("sequential Pages公開URLがintentと一致しません");
  }
  const receipt = deploymentReceipt(
    artifact,
    preflight.replay ? "replayed_same_content" : "deployed",
    input.observedAt,
    {
      deploymentIntentDigest: artifact.intent.deploymentIntentDigest,
      pagesContentDigest: artifact.intent.pagesContentDigest,
      sourceStateRevision: artifact.intent.sourceStateRevision,
      pageUrl,
      externalReference,
    },
    effectOccurredAt,
  );
  const evidence = createInitialPagesPublicationEvidence(
    {
      buildReceipt: artifact.receipt,
      deploymentReceipt: receipt,
      sourceStateRevision: artifact.intent.sourceStateRevision,
    },
    digest,
  );
  return parseInitialPagesDeploymentOutcome(
    { schemaVersion: 1, kind: "success", receipt, evidence },
    artifact,
  );
}

/** 初回Pages公開結果とbuild artifactの結合を再検証する。 */
export function parseInitialPagesDeploymentOutcome(
  value: unknown,
  artifact: InitialPagesBuildArtifact,
): InitialPagesDeploymentOutcome {
  const outcome = deploymentOutcomeSchema.parse(value);
  if (outcome.kind !== "success") {
    if (
      outcome.runId !== artifact.intent.runId ||
      outcome.checkpointDigest !== artifact.intent.checkpointDigest ||
      outcome.deploymentIntentDigest !== artifact.intent.deploymentIntentDigest ||
      (outcome.reason === "superseded_by_newer_run") !== (outcome.receipt != null) ||
      (outcome.reason === "superseded_by_newer_run" && outcome.effectCertainty !== "no_effect")
    ) {
      throw new TypeError("Pages公開失敗artifactとintentが一致しません");
    }
    if (outcome.receipt != null) {
      const receipt = parseReceipt(outcome.receipt, digest);
      if (
        receipt.receiptType !== "pages_deployment" ||
        receipt.status !== "superseded_by_newer_run" ||
        receipt.logicalTarget !== artifact.intent.deploymentIntentDigest
      ) {
        throw new TypeError("Pages公開失敗receiptが無効化されたintentと一致しません");
      }
    }
    return outcome;
  }
  const receipt = parseReceipt(outcome.receipt, digest);
  if (receipt.receiptType !== "pages_deployment") {
    throw new TypeError("初回Pages公開結果のreceipt種別が不正です");
  }
  const evidence =
    receipt.receiptKind === "observed"
      ? parseInitialPagesPublicationEvidence(outcome.evidence, digest)
      : createInitialPagesPublicationEvidence(
          {
            buildReceipt: artifact.receipt,
            deploymentReceipt: receipt,
            sourceStateRevision: artifact.intent.sourceStateRevision,
          },
          digest,
        );
  if (
    receipt.effectCertainty !== "committed" ||
    receipt.binding.bindingKind !== "checkpoint" ||
    receipt.binding.runId !== artifact.intent.runId ||
    receipt.binding.checkpointDigest !== artifact.intent.checkpointDigest ||
    receipt.previousReceiptDigest !== artifact.receipt.receiptDigest ||
    receipt.result?.deploymentIntentDigest !== artifact.intent.deploymentIntentDigest ||
    receipt.result.pagesContentDigest !== artifact.intent.pagesContentDigest ||
    receipt.result.sourceStateRevision !== artifact.intent.sourceStateRevision ||
    receipt.result.pageUrl !== artifact.intent.expectedPageUrl ||
    evidence.runId !== artifact.intent.runId ||
    evidence.checkpointDigest !== artifact.intent.checkpointDigest ||
    evidence.sourceStateRevision !== artifact.intent.sourceStateRevision ||
    evidence.deploymentIntentDigest !== artifact.intent.deploymentIntentDigest ||
    evidence.pagesContentDigest !== artifact.intent.pagesContentDigest ||
    evidence.pageUrl !== artifact.intent.expectedPageUrl ||
    (receipt.receiptKind === "observed" &&
      (receipt.result.evidenceDigest !== evidence.evidenceDigest ||
        receipt.result.observedSourceReceiptDigest !== evidence.deploymentReceiptDigest ||
        serializeCanonicalJson(receipt.result.externalReference) !==
          serializeCanonicalJson(evidence.externalReference))) ||
    serializeCanonicalJson(evidence) !== serializeCanonicalJson(outcome.evidence)
  ) {
    throw new TypeError("初回Pages公開結果がbuild artifactと一致しません");
  }
  return outcome;
}

/** canonical JSONの初回Pages公開結果を読む。 */
export async function readInitialPagesDeploymentOutcome(
  path: string,
  artifact: InitialPagesBuildArtifact,
): Promise<InitialPagesDeploymentOutcome> {
  return decodeInitialPagesDeploymentOutcome(await readFile(path), artifact);
}

/** canonical JSONの初回Pages公開結果をbyte列から検証する。 */
export function decodeInitialPagesDeploymentOutcome(
  bytes: Uint8Array,
  artifact: InitialPagesBuildArtifact,
): InitialPagesDeploymentOutcome {
  if (bytes.length > MAX_DEPLOYMENT_ARTIFACT_BYTES) {
    throw new TypeError("Pages公開結果artifactが許容byte数を超えています");
  }
  const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const raw: unknown = JSON.parse(source);
  if (source !== serializeCanonicalJsonLine(raw)) {
    throw new TypeError("Pages公開結果artifactがcanonical JSONではありません");
  }
  return parseInitialPagesDeploymentOutcome(raw, artifact);
}

/** build artifactを失った後も保存済みstateとの照合に使えるdeploy結果を読む。 */
export function decodeInitialPagesDeploymentEvidence(
  bytes: Uint8Array,
): Extract<InitialPagesDeploymentOutcome, { kind: "success" }> {
  if (bytes.length > MAX_DEPLOYMENT_ARTIFACT_BYTES) {
    throw new TypeError("Pages公開結果artifactが許容byte数を超えています");
  }
  const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const raw: unknown = JSON.parse(source);
  if (source !== serializeCanonicalJsonLine(raw)) {
    throw new TypeError("Pages公開結果artifactがcanonical JSONではありません");
  }
  const outcome = deploymentOutcomeSchema.parse(raw);
  if (outcome.kind !== "success") {
    throw new TypeError("保存済みPages証拠と比較できる成功結果がありません");
  }
  const receipt = parseReceipt(outcome.receipt, digest);
  const evidence = parseInitialPagesPublicationEvidence(outcome.evidence, digest);
  if (
    receipt.receiptType !== "pages_deployment" ||
    receipt.phase !== "initial" ||
    receipt.effectCertainty !== "committed" ||
    receipt.receiptDigest !== evidence.deploymentReceiptDigest ||
    receipt.operationId !== evidence.deploymentOperationId ||
    receipt.result?.deploymentIntentDigest !== evidence.deploymentIntentDigest ||
    receipt.result.pagesContentDigest !== evidence.pagesContentDigest ||
    receipt.result.sourceStateRevision !== evidence.sourceStateRevision ||
    receipt.result.pageUrl !== evidence.pageUrl ||
    serializeCanonicalJson(receipt.result.externalReference) !==
      serializeCanonicalJson(evidence.externalReference)
  ) {
    throw new TypeError("Pages公開結果artifactと保存候補証拠が一致しません");
  }
  return outcome;
}
