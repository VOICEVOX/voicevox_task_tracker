import {
  assertWorkflowArtifactPublicSafety,
  createWorkflowArtifact,
} from "../workflow-artifact.js";
import type { WorkflowArtifact } from "../workflow-artifact.js";
import type { DailyRunInvocation } from "../daily-transaction.js";
import type { RunMetrics } from "../run-report.js";
import type {
  PublicationConfiguration,
  PublicationRepositoryInventory,
  PublicationState,
  ValidatedRun,
} from "./contracts.js";
import { createRunMetadata } from "./metadata.js";
import { discordDeliverySettings, pagesUrl } from "./settings.js";

/** 完全性検証済みcollect-analyze runからartifactを作る入力。 */
export type CreateCollectAnalyzeArtifactInput = Readonly<{
  invocation: DailyRunInvocation;
  configuration: PublicationConfiguration;
  state: PublicationState;
  inventory: PublicationRepositoryInventory;
  validated: ValidatedRun;
  metrics: RunMetrics;
  diagnostics: readonly string[];
}>;

/** 完全性検証済みcollect-analyze runを分割workflow artifactへ変換する。 */
export function createCollectAnalyzeArtifact(
  input: CreateCollectAnalyzeArtifactInput,
): WorkflowArtifact {
  if (input.invocation.command.kind !== "collect-analyze") {
    throw new TypeError("collect-analyze以外のrunからworkflow artifactを生成できません");
  }
  const artifact = createWorkflowArtifact({
    schemaVersion: "13",
    kind: "validated_public_run",
    notificationAction: input.invocation.command.notificationAction,
    repositoryAllowlist: input.inventory.allowlist.repositories.map((repository) => ({
      id: repository.id,
      owner: repository.owner,
      name: repository.name,
    })),
    snapshot: input.validated.snapshot,
    historyInputEvents: input.validated.historyInputEvents,
    notificationLedger: input.validated.notificationLedger,
    notificationSelection: input.validated.notificationSelection,
    runMetadata: createRunMetadata({
      invocation: input.invocation,
      validated: input.validated,
      metrics: input.metrics,
      diagnostics: input.diagnostics,
    }),
    aiCacheEntries: input.state.session.pendingAiCacheEntries(),
    personalReminderAiCacheEntries: input.state.session.pendingPersonalReminderAiCacheEntries(),
    pagesUrl: pagesUrl(input.configuration.config),
    discordSettings: discordDeliverySettings(input.configuration.config),
  });
  assertWorkflowArtifactPublicSafety(
    artifact,
    input.inventory.inventory,
    input.configuration.credentials.knownSecrets,
  );
  return artifact;
}

/** workflow artifactの公開処理入力を再計算せず復元する。 */
export function validatedRunFromArtifact(artifact: WorkflowArtifact): ValidatedRun {
  return Object.freeze({
    snapshot: artifact.snapshot,
    historyInputEvents: artifact.historyInputEvents,
    notificationLedger: artifact.notificationLedger,
    notificationSelection: artifact.notificationSelection,
  });
}
