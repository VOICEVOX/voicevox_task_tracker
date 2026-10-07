import type { Sha256Hash } from "../../../canonical-json/sha256.js";
import { serializeCanonicalJson } from "../../../canonical-json/value.js";
import type { ContentDigestPort } from "../contracts/content-digest-port.js";

type RunDigestValues = Readonly<{
  core: unknown;
  snapshot: unknown;
  historyInputEvents: unknown;
  aiCacheAdditions: unknown;
  personalReminderAiCacheAdditions: unknown;
  previousNotificationLedger: unknown;
  notificationLedger: unknown;
  notificationSelection: unknown;
  notificationPreview: unknown;
  publicationInputs: unknown;
  repositoryAllowlist: unknown;
  metrics: unknown;
  diagnostics: unknown;
  evidenceClosureSummary: unknown;
  evidenceClosureWitness: unknown;
  finalItemAiLineage: unknown;
  publicDiagnosticsSummary: unknown;
}>;

/** artifact内の実値とwitnessを個別に照合するdigest。 */
export type RunArtifactValueDigests = Readonly<{
  [Field in keyof RunDigestValues]: Sha256Hash;
}>;

/** 完全性検証済みの各公開値からcanonical digestを作る。 */
export function createRunArtifactValueDigests(
  values: RunDigestValues,
  digest: ContentDigestPort,
): RunArtifactValueDigests {
  const hash = (value: unknown): Sha256Hash => digest.sha256Utf8(serializeCanonicalJson(value));
  return Object.freeze({
    core: hash(values.core),
    snapshot: hash(values.snapshot),
    historyInputEvents: hash(values.historyInputEvents),
    aiCacheAdditions: hash(values.aiCacheAdditions),
    personalReminderAiCacheAdditions: hash(values.personalReminderAiCacheAdditions),
    previousNotificationLedger: hash(values.previousNotificationLedger),
    notificationLedger: hash(values.notificationLedger),
    notificationSelection: hash(values.notificationSelection),
    notificationPreview: hash(values.notificationPreview),
    publicationInputs: hash(values.publicationInputs),
    repositoryAllowlist: hash(values.repositoryAllowlist),
    metrics: hash(values.metrics),
    diagnostics: hash(values.diagnostics),
    evidenceClosureSummary: hash(values.evidenceClosureSummary),
    evidenceClosureWitness: hash(values.evidenceClosureWitness),
    finalItemAiLineage: hash(values.finalItemAiLineage),
    publicDiagnosticsSummary: hash(values.publicDiagnosticsSummary),
  });
}
