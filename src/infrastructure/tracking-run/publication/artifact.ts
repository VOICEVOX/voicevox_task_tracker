import { assertValidatedRun } from "../../../application/tracking-run/stages/validate-run.js";
import { hashCanonicalJson } from "../../../canonical-json/index.js";
import { serializeCanonicalJson } from "../../../canonical-json/value.js";
import type { PublicationValidatedRun } from "../../../publication/publication-plan-contracts.js";
import { nodeContentDigestPort } from "../content-digest.js";
import type { RunInvocation } from "../run-invocation.js";
import type { ValidatedRunPayload } from "../validated-run-payload.js";
import {
  assertValidatedRunPayloadPublicSafety,
  parseValidatedRunPayload,
} from "../validated-run-payload.js";
import type { PublicationConfiguration } from "./contracts.js";
import { createRunMetadata } from "./metadata.js";
import { discordDeliverySettings, pagesUrl } from "./settings.js";

/** 完全性検証済みcollect-analyze runからartifactを作る入力。 */
export type CreateCollectAnalyzeArtifactInput = Readonly<{
  invocation: RunInvocation;
  configuration: PublicationConfiguration;
  validated: PublicationValidatedRun;
  diagnostics: readonly string[];
}>;

/** 完全性検証済みcollect-analyze runを分割workflow artifactへ変換する。 */
export function createCollectAnalyzePayload(
  input: CreateCollectAnalyzeArtifactInput,
): ValidatedRunPayload {
  assertValidatedRun(input.validated);
  if (
    input.invocation.runId !== input.validated.core.identity.runId ||
    input.invocation.invocationId !== input.validated.core.identity.invocationId ||
    input.invocation.scheduledFor !== input.validated.core.identity.scheduledFor ||
    input.invocation.startedAt !== input.validated.core.identity.startedAt ||
    input.invocation.executionPolicy.notificationAction !==
      input.validated.core.executionPolicy.notificationAction ||
    serializeCanonicalJson(input.diagnostics) !==
      serializeCanonicalJson(input.validated.diagnostics)
  ) {
    throw new TypeError("collect-analyzeのrun識別が検証済みrunと一致しません");
  }
  const runMetadata = createRunMetadata({
    invocation: input.invocation,
    validated: input.validated,
    metrics: input.validated.metrics,
    diagnostics: input.diagnostics,
  });
  const publishedPagesUrl = pagesUrl(input.configuration.config);
  const publishedDiscordSettings = discordDeliverySettings(input.configuration.config);
  const artifact = parseValidatedRunPayload(
    {
      notificationAction: input.validated.core.executionPolicy.notificationAction,
      repositoryAllowlist: input.validated.repositoryAllowlist.map((repository) => ({
        id: repository.id,
        owner: repository.owner,
        name: repository.name,
      })),
      repositoryInventory: input.validated.repositoryAllowlist,
      allowlistDigest: input.validated.core.allowlistDigest,
      snapshot: input.validated.snapshot,
      historyInputEvents: input.validated.historyInputEvents,
      notificationLedger: input.validated.notificationLedger,
      notificationSelection: input.validated.notificationSelection,
      notificationPreview: input.validated.notificationPreview,
      runMetadata,
      aiCacheEntries: input.validated.aiCacheAdditions,
      personalReminderAiCacheEntries: input.validated.personalReminderAiCacheAdditions,
      pagesUrl: publishedPagesUrl,
      discordSettings: publishedDiscordSettings,
      validation: {
        core: input.validated.core,
        previousNotificationLedger: input.validated.previousNotificationLedger,
        publicationInputs: input.validated.publicationInputs,
        metrics: input.validated.metrics,
        diagnostics: input.validated.diagnostics,
        evidenceClosureSummary: input.validated.evidenceClosureSummary,
        evidenceClosureWitness: input.validated.evidenceClosureWitness,
        finalItemAiLineage: input.validated.finalItemAiLineage,
        publicDiagnosticsSummary: input.validated.publicDiagnosticsSummary,
        artifactValueDigests: input.validated.artifactValueDigests,
      },
      identityWitness: {
        identity: input.validated.core.identity,
        executionPolicy: input.validated.core.executionPolicy,
        baseRevision: input.validated.core.baseRevision,
        configDigest: input.validated.core.configDigest,
      },
      presentationDigests: {
        runMetadata: hashCanonicalJson(runMetadata),
        pagesUrl: hashCanonicalJson(publishedPagesUrl),
        discordSettings: hashCanonicalJson(publishedDiscordSettings),
      },
    },
    nodeContentDigestPort,
  );
  assertValidatedRunPayloadPublicSafety(
    artifact,
    input.validated.repositoryAllowlist,
    input.configuration.credentials.knownSecrets,
    nodeContentDigestPort,
  );
  return artifact;
}
