import { z } from "zod";

import {
  notificationActionSchema,
  type NotificationAction,
} from "../../application/tracking-run/contracts/closed-values.js";
import {
  assertValidatedRun,
  revalidateSerializedRun,
} from "../../application/tracking-run/stages/validate-run.js";
import type { PublicationValidatedRun } from "../../publication/publication-plan-contracts.js";

import type { ContentDigestPort } from "../../application/tracking-run/contracts/content-digest-port.js";
import type { Sha256Hash } from "../../canonical-json/index.js";
import { parseSha256Hash, serializeCanonicalJson } from "../../canonical-json/index.js";
import { canonicalJsonEquals } from "../../canonical-json/value.js";
import {
  createAiCacheEntry,
  createPersonalReminderAiCacheEntry,
  type AiCacheEntry,
  type PersonalReminderAiCacheEntry,
} from "../../codex/index.js";
import {
  calculateDiscordNotificationCandidateSeverity,
  type DiscordDeliverySettings,
  type DiscordNotificationSelection,
} from "../../discord/index.js";
import {
  discordSettingsSchema,
  notificationSelectionSchema,
} from "../../discord/notification-selection-schema.js";
import {
  createGitHubRepositoryId,
  createUtcIsoDateTime,
  type NotificationReason,
  type PendingNotification,
  type Repository,
} from "../../domain/index.js";
import {
  createPublicRepositoryAllowlist,
  isEligiblePublicRepository,
} from "../../github/public-repository-allowlist.js";
import {
  assertPersonalReminderEvidenceClosure,
  assertStatePublicSafety,
  createStateHistoryInputEvents,
  createStateNotificationLedger,
  createStateSnapshot,
  StatePublicSafetyError,
  type StateHistoryInputEvent,
  type StateNotificationLedger,
  type StateSnapshot,
} from "../../persistence/index.js";
import { assertNonNullable } from "../../util/index.js";
import {
  parseWorkflowIdentityWitness,
  parseWorkflowValidation,
  type WorkflowIdentityWitness,
  type WorkflowValidation,
} from "./workflow-artifact-validation.js";

const nonNegativeIntegerSchema = z.number().int().nonnegative();
const dateTimeSchema = z.iso
  .datetime({
    offset: true,
    error: "タイムゾーンを含むISO 8601日時を指定してください",
  })
  .transform((value) => createUtcIsoDateTime(value));
const repositoryIdSchema = z
  .string()
  .min(1)
  .transform((value) => createGitHubRepositoryId(value));
const repositoryAllowlistEntrySchema = z.strictObject({
  id: repositoryIdSchema,
  owner: z.string().min(1),
  name: z.string().min(1),
});
const repositoryInventoryEntrySchema = repositoryAllowlistEntrySchema.extend({
  visibility: z.literal("public"),
  archived: z.literal(false),
  disabled: z.literal(false),
  observedAt: dateTimeSchema,
});
const allowlistDigestSchema = z.string().transform((value) => parseSha256Hash(value));
const runMetadataMetricsSchema = z.strictObject({
  repositoryCount: nonNegativeIntegerSchema,
  itemCount: nonNegativeIntegerSchema,
  changedItemCount: nonNegativeIntegerSchema,
  activeEdgeCount: nonNegativeIntegerSchema,
  aiCallCount: nonNegativeIntegerSchema,
  aiProcessAttemptCount: nonNegativeIntegerSchema,
  aiCacheHitCount: nonNegativeIntegerSchema,
  aiRetainedResultCount: nonNegativeIntegerSchema,
  estimatedInputTokens: nonNegativeIntegerSchema,
  personalReminderCauseCount: nonNegativeIntegerSchema,
  personalReminderAiCallCount: nonNegativeIntegerSchema,
  personalReminderAiCacheHitCount: nonNegativeIntegerSchema,
  personalReminderAssessmentReuseCount: nonNegativeIntegerSchema,
  personalReminderUnknownCount: nonNegativeIntegerSchema,
  personalReminderFailedCount: nonNegativeIntegerSchema,
  personalReminderDeferredCount: nonNegativeIntegerSchema,
  personalReminderNotEvaluatedCount: nonNegativeIntegerSchema,
  githubApiRemaining: nonNegativeIntegerSchema,
  staleRepositoryCount: nonNegativeIntegerSchema,
  scheduleDelayMilliseconds: nonNegativeIntegerSchema,
});
const runMetadataSchema = z
  .strictObject({
    scheduledFor: dateTimeSchema,
    startedAt: dateTimeSchema,
    metrics: runMetadataMetricsSchema,
    diagnostics: z.array(z.string().min(1).max(1000)),
  })
  .superRefine((metadata, context) => {
    const scheduledFor = Date.parse(metadata.scheduledFor);
    const startedAt = Date.parse(metadata.startedAt);
    if (scheduledFor > startedAt) {
      context.addIssue({
        code: "custom",
        path: ["scheduledFor"],
        message: "予定時刻は開始時刻以前にしてください",
      });
    }
    if (metadata.metrics.scheduleDelayMilliseconds !== startedAt - scheduledFor) {
      context.addIssue({
        code: "custom",
        path: ["metrics", "scheduleDelayMilliseconds"],
        message: "schedule遅延が予定時刻と開始時刻に一致しません",
      });
    }
  });
export const validatedRunPayloadSchema = z.strictObject({
  notificationAction: notificationActionSchema,
  repositoryAllowlist: z.array(repositoryAllowlistEntrySchema),
  repositoryInventory: z.array(repositoryInventoryEntrySchema),
  allowlistDigest: allowlistDigestSchema,
  snapshot: z.unknown(),
  historyInputEvents: z.array(z.unknown()),
  notificationLedger: z.unknown(),
  notificationSelection: z.unknown(),
  notificationPreview: z.unknown(),
  runMetadata: runMetadataSchema,
  aiCacheEntries: z.array(z.unknown()),
  personalReminderAiCacheEntries: z.array(z.unknown()),
  pagesUrl: z.url(),
  discordSettings: discordSettingsSchema,
  validation: z.unknown(),
  identityWitness: z.unknown(),
  presentationDigests: z.strictObject({
    runMetadata: allowlistDigestSchema,
    pagesUrl: allowlistDigestSchema,
    discordSettings: allowlistDigestSchema,
  }),
});

export type ValidatedRunPayloadRepositoryAllowlistEntry = Readonly<{
  id: Repository["id"];
  owner: Repository["owner"];
  name: Repository["name"];
}>;

/** workflow完了時のrun report生成に使う確定済み収集指標。 */
export type WorkflowRunMetadata = Readonly<{
  scheduledFor: z.output<typeof dateTimeSchema>;
  startedAt: z.output<typeof dateTimeSchema>;
  metrics: Readonly<z.output<typeof runMetadataMetricsSchema>>;
  diagnostics: readonly string[];
}>;

/** collect-analyzeが後続jobへ渡す公開可能な検証済み成果物。 */
export type ValidatedRunPayload = Readonly<{
  notificationAction: NotificationAction;
  repositoryAllowlist: readonly ValidatedRunPayloadRepositoryAllowlistEntry[];
  repositoryInventory: readonly Repository[];
  allowlistDigest: Sha256Hash;
  snapshot: StateSnapshot;
  historyInputEvents: readonly StateHistoryInputEvent[];
  notificationLedger: StateNotificationLedger;
  notificationSelection: DiscordNotificationSelection;
  notificationPreview: DiscordNotificationSelection;
  runMetadata: WorkflowRunMetadata;
  aiCacheEntries: readonly AiCacheEntry[];
  personalReminderAiCacheEntries: readonly PersonalReminderAiCacheEntry[];
  pagesUrl: string;
  discordSettings: DiscordDeliverySettings;
  validation: WorkflowValidation;
  identityWitness: WorkflowIdentityWitness;
  presentationDigests: Readonly<{
    runMetadata: Sha256Hash;
    pagesUrl: Sha256Hash;
    discordSettings: Sha256Hash;
  }>;
  validated: PublicationValidatedRun;
}>;

export type ValidatedRunSerializablePayload = z.output<typeof validatedRunPayloadSchema>;
type ValidatedRunPublicValue = Omit<ValidatedRunPayload, "validated">;

/** 証明を除いたcheckpoint内の検証済みrun保存値を返す。 */
export function validatedRunSerializablePayload(
  artifact: ValidatedRunPayload,
): ValidatedRunPublicValue {
  assertValidatedRun(artifact.validated);
  const { validated, ...payload } = artifact;
  void validated;
  return Object.freeze(payload);
}

function nonEmptyValues<Value>(
  values: readonly Value[],
  description: string,
): readonly [Value, ...Value[]] {
  const first = values[0];
  assertNonNullable(first, `${description}がありません`);
  return Object.freeze([first, ...values.slice(1)]);
}

function emptyValues(): readonly [] {
  return Object.freeze([]);
}

function pendingNotificationValues(
  values: readonly PendingNotification[],
): readonly PendingNotification[] {
  return Object.freeze(values.map((value) => Object.freeze({ ...value })));
}

function createNotificationSelection(value: unknown): DiscordNotificationSelection {
  const result = notificationSelectionSchema.safeParse(value);
  if (!result.success) {
    throw new TypeError("workflow artifactの通知候補がschemaに適合しません", {
      cause: result.error,
    });
  }
  if (result.data.action === "skip_digest") {
    return Object.freeze({
      action: "skip_digest",
      reason: result.data.reason,
      candidates: emptyValues(),
      ledgerReservations: emptyValues(),
      pendingNotifications: pendingNotificationValues(result.data.pendingNotifications),
    });
  }
  const candidates = result.data.candidates.map((candidate) =>
    Object.freeze({
      ...candidate,
      reasons: nonEmptyValues(candidate.reasons, "通知理由"),
      downstreamImpact: Object.freeze({
        ...candidate.downstreamImpact,
      }),
    }),
  );
  return Object.freeze({
    action: "create_digest",
    candidates: nonEmptyValues(candidates, "通知候補"),
    ledgerReservations: nonEmptyValues(result.data.ledgerReservations, "通知予約"),
    pendingNotifications: pendingNotificationValues(result.data.pendingNotifications),
  });
}

function compareStrings(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function createAiCacheEntries(values: readonly unknown[]): readonly AiCacheEntry[] {
  const entries = values.map((value) => createAiCacheEntry(value));
  const cacheKeys = entries.map((entry) => entry.cacheKey);
  if (new Set(cacheKeys).size !== cacheKeys.length) {
    throw new TypeError("workflow artifactのAI cache keyが重複しています");
  }
  return Object.freeze(
    [...entries].sort((left, right) => compareStrings(left.cacheKey, right.cacheKey)),
  );
}

function createPersonalReminderAiCacheEntries(
  values: readonly unknown[],
): readonly PersonalReminderAiCacheEntry[] {
  const entries = values.map((value) => createPersonalReminderAiCacheEntry(value));
  const cacheKeys = entries.map((entry) => entry.cacheKey);
  if (new Set(cacheKeys).size !== cacheKeys.length) {
    throw new TypeError("workflow artifactの個人催促AI cache keyが重複しています");
  }
  return Object.freeze(
    [...entries].sort((left, right) => compareStrings(left.cacheKey, right.cacheKey)),
  );
}

function createRepositoryAllowlist(
  values: readonly z.output<typeof repositoryAllowlistEntrySchema>[],
): readonly ValidatedRunPayloadRepositoryAllowlistEntry[] {
  const entries: readonly ValidatedRunPayloadRepositoryAllowlistEntry[] = values.map((value) =>
    Object.freeze({ ...value }),
  );
  const repositoryIds = new Set(entries.map((repository) => repository.id));
  const repositoryNames = new Set(
    entries.map((repository) => `${repository.owner}/${repository.name}`.toLowerCase()),
  );
  if (repositoryIds.size !== entries.length || repositoryNames.size !== entries.length) {
    throw new TypeError("workflow artifactのrepository allowlistが重複しています");
  }
  return Object.freeze(entries);
}

/** workflow run metadataを時系列も含めて検証する。 */
export function createWorkflowRunMetadata(value: unknown): WorkflowRunMetadata {
  const result = runMetadataSchema.safeParse(value);
  if (!result.success) {
    throw new TypeError("workflow run metadataの検証に失敗しました", {
      cause: result.error,
    });
  }
  return Object.freeze({
    ...result.data,
    metrics: Object.freeze({
      ...result.data.metrics,
    }),
    diagnostics: Object.freeze([...result.data.diagnostics]),
  });
}

function assertRunConsistency(snapshot: StateSnapshot, metadata: WorkflowRunMetadata): void {
  if (snapshot.generatedAt < metadata.startedAt) {
    throw new TypeError("workflow artifactのsnapshot生成時刻はrun開始時刻以後にしてください");
  }
  if (
    snapshot.repositories.length !== metadata.metrics.repositoryCount ||
    snapshot.items.length !== metadata.metrics.itemCount ||
    snapshot.relations.filter((relation) => relation.active).length !==
      metadata.metrics.activeEdgeCount ||
    snapshot.repositories.filter((repository) => repository.freshness === "stale").length !==
      metadata.metrics.staleRepositoryCount
  ) {
    throw new TypeError("workflow artifactのsnapshotとrun metadataの件数が一致しません");
  }
}

function assertWorkflowValidationConsistency(
  artifact: ValidatedRunPublicValue,
  validated: ValidatedRunPayload["validated"],
): void {
  const { core, metrics, repositoryAllowlist } = validated;
  if (
    serializeCanonicalJson(artifact.identityWitness) !==
    serializeCanonicalJson({
      identity: core.identity,
      executionPolicy: core.executionPolicy,
      baseRevision: core.baseRevision,
      configDigest: core.configDigest,
    })
  ) {
    throw new TypeError("workflow artifactのrun識別witnessが検証済みrunと一致しません");
  }
  if (
    artifact.notificationAction !== core.executionPolicy.notificationAction ||
    artifact.allowlistDigest !== core.allowlistDigest ||
    artifact.runMetadata.scheduledFor !== core.identity.scheduledFor ||
    artifact.runMetadata.startedAt !== core.identity.startedAt ||
    artifact.pagesUrl !== validated.publicationInputs.pages.url ||
    serializeCanonicalJson(artifact.discordSettings) !==
      serializeCanonicalJson(validated.publicationInputs.discord)
  ) {
    throw new TypeError("workflow artifactのrun識別と実行条件が一致しません");
  }
  if (
    serializeCanonicalJson(artifact.repositoryInventory) !==
    serializeCanonicalJson(repositoryAllowlist)
  ) {
    throw new TypeError("workflow artifactの公開repository一覧が検証済みrunと一致しません");
  }
  const expectedMetrics: WorkflowRunMetadata["metrics"] = Object.freeze({
    repositoryCount: validated.snapshot.repositories.length,
    itemCount: validated.snapshot.items.length,
    changedItemCount: metrics.changedItemCount,
    activeEdgeCount: validated.snapshot.relations.filter((relation) => relation.active).length,
    aiCallCount: metrics.aiCallCount,
    aiProcessAttemptCount: metrics.aiProcessAttemptCount,
    aiCacheHitCount: metrics.aiCacheHitCount,
    aiRetainedResultCount: metrics.aiRetainedResultCount,
    estimatedInputTokens: metrics.estimatedInputTokens,
    personalReminderCauseCount: metrics.personalReminderCauseCount,
    personalReminderAiCallCount: metrics.personalReminderAiCallCount,
    personalReminderAiCacheHitCount: metrics.personalReminderAiCacheHitCount,
    personalReminderAssessmentReuseCount: metrics.personalReminderAssessmentReuseCount,
    personalReminderUnknownCount: metrics.personalReminderUnknownCount,
    personalReminderFailedCount: metrics.personalReminderFailedCount,
    personalReminderDeferredCount: metrics.personalReminderDeferredCount,
    personalReminderNotEvaluatedCount: metrics.personalReminderNotEvaluatedCount,
    githubApiRemaining: metrics.githubApiRemaining,
    staleRepositoryCount: validated.snapshot.repositories.filter(
      (repository) => repository.freshness === "stale",
    ).length,
    scheduleDelayMilliseconds: metrics.scheduleDelayMilliseconds,
  });
  if (
    serializeCanonicalJson(expectedMetrics) !==
      serializeCanonicalJson(artifact.runMetadata.metrics) ||
    serializeCanonicalJson(validated.diagnostics) !==
      serializeCanonicalJson(artifact.runMetadata.diagnostics)
  ) {
    throw new TypeError("workflow artifactのrun指標が検証済みrunと一致しません");
  }
}

function pendingNotificationMatches(
  left: PendingNotification | undefined,
  right: PendingNotification,
): boolean {
  if (left == null) {
    return false;
  }
  return (
    left.notificationKey === right.notificationKey &&
    left.itemNodeId === right.itemNodeId &&
    left.detectedAt === right.detectedAt &&
    left.highPriorityEligible === right.highPriorityEligible &&
    serializeCanonicalJson(left.reason) === serializeCanonicalJson(right.reason) &&
    serializeCanonicalJson(left.target) === serializeCanonicalJson(right.target)
  );
}

function pendingNotificationMatchesReason(
  pending: PendingNotification | undefined,
  itemNodeId: StateSnapshot["items"][number]["nodeId"],
  reason: NotificationReason,
): boolean {
  if (pending == null) {
    return false;
  }
  return (
    pending.itemNodeId === itemNodeId &&
    serializeCanonicalJson(pending.reason) ===
      serializeCanonicalJson({
        reasonCode: reason.reasonCode,
        threshold: reason.threshold,
      })
  );
}

function assertNotificationSelectionConsistency(
  snapshot: StateSnapshot,
  ledger: StateNotificationLedger,
  selection: DiscordNotificationSelection,
): void {
  const itemIds = new Set(snapshot.items.map((item) => item.nodeId));
  const reservations = new Map(
    selection.ledgerReservations.map((entry) => [entry.notificationKey, entry]),
  );
  const ledgerEntries = new Map(ledger.entries.map((entry) => [entry.notificationKey, entry]));
  const pendingNotifications = new Map(
    selection.pendingNotifications.map((notification) => [
      notification.notificationKey,
      notification,
    ]),
  );
  if (pendingNotifications.size !== selection.pendingNotifications.length) {
    throw new TypeError("workflow artifactの送信待ち通知keyが重複しています");
  }
  const ledgerPendingNotifications = new Map(
    ledger.pendingNotifications.map((notification) => [notification.notificationKey, notification]),
  );
  if (ledgerPendingNotifications.size !== ledger.pendingNotifications.length) {
    throw new TypeError("workflow artifactのledger送信待ち通知keyが重複しています");
  }
  for (const notification of selection.pendingNotifications) {
    if (!itemIds.has(notification.itemNodeId)) {
      throw new TypeError("workflow artifactの送信待ち通知がsnapshot外の項目を参照しています");
    }
    const ledgerNotification = ledgerPendingNotifications.get(notification.notificationKey);
    if (!pendingNotificationMatches(ledgerNotification, notification)) {
      throw new TypeError("workflow artifactの送信待ち通知がledgerへ反映されていません");
    }
  }
  if (ledgerPendingNotifications.size !== pendingNotifications.size) {
    throw new TypeError("workflow artifactの送信待ち通知とledgerの件数が一致しません");
  }
  const reasonKeys: string[] = [];

  for (const candidate of selection.candidates) {
    if (!itemIds.has(candidate.itemNodeId)) {
      throw new TypeError("workflow artifactの通知候補がsnapshot外の項目を参照しています");
    }
    if (candidate.downstreamImpact.nodeId !== candidate.itemNodeId) {
      throw new TypeError("workflow artifactの通知候補内で項目が一致しません");
    }
    if (candidate.severity !== calculateDiscordNotificationCandidateSeverity(candidate.reasons)) {
      throw new TypeError("workflow artifactの通知候補severityが理由と一致しません");
    }
    for (const reason of candidate.reasons) {
      reasonKeys.push(reason.notificationKey);
      const reservation = reservations.get(reason.notificationKey);
      if (reservation == null) {
        throw new TypeError("workflow artifactの通知候補に対応する予約がありません");
      }
      if (
        reservation.itemNodeId !== candidate.itemNodeId ||
        reservation.reasonCode !== reason.reasonCode ||
        reservation.severity !== reason.severity
      ) {
        throw new TypeError("workflow artifactの通知候補と予約が一致しません");
      }
      const ledgerEntry = ledgerEntries.get(reason.notificationKey);
      if (ledgerEntry == null) {
        throw new TypeError("workflow artifactの通知予約がledgerにありません");
      }
      if (ledgerEntry.status !== "reserved") {
        throw new TypeError("workflow artifactの通知予約がledgerへ反映されていません");
      }
      if (
        ledgerEntry.itemNodeId !== reservation.itemNodeId ||
        ledgerEntry.reasonCode !== reservation.reasonCode ||
        ledgerEntry.severity !== reservation.severity ||
        ledgerEntry.reservedAt !== reservation.reservedAt ||
        ledgerEntry.expiresAt !== reservation.expiresAt
      ) {
        throw new TypeError("workflow artifactの通知予約がledgerへ反映されていません");
      }
      const pendingNotification = pendingNotifications.get(reason.notificationKey);
      if (!pendingNotificationMatchesReason(pendingNotification, candidate.itemNodeId, reason)) {
        throw new TypeError("workflow artifactの通知候補が送信待ち通知へ反映されていません");
      }
    }
  }
  if (new Set(reasonKeys).size !== reasonKeys.length || reasonKeys.length !== reservations.size) {
    throw new TypeError("workflow artifactの通知候補と予約の対応が一意ではありません");
  }
}

function assertNotificationActionConsistency(
  notificationAction: NotificationAction,
  selection: DiscordNotificationSelection,
): void {
  if (selection.action === "create_digest") {
    if (notificationAction !== "send") {
      throw new TypeError("通知を送信しないworkflow artifactにはDiscord通知候補を含められません");
    }
    return;
  }
  if (notificationAction === "send" && selection.reason !== "no_candidates") {
    throw new TypeError("sendのworkflow artifactには通知保留理由を指定できません");
  }
  if (notificationAction === "hold" && selection.reason !== "held") {
    throw new TypeError("holdのworkflow artifactにはheldの通知selectionが必要です");
  }
  if (notificationAction === "acknowledge-current" && selection.reason !== "no_candidates") {
    throw new TypeError(
      "acknowledge-currentのworkflow artifactにはno_candidatesの通知selectionが必要です",
    );
  }
}

function normalizePagesUrl(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.hostname !== "voicevox.github.io" ||
    url.username.length !== 0 ||
    url.password.length !== 0 ||
    url.hash.length !== 0
  ) {
    throw new TypeError("workflow artifactのPages URLが安全なHTTPS URLではありません");
  }
  return url.href;
}

/** workflow artifactを独立した公開境界で再検証する。 */
export function parseValidatedRunPayload(
  value: unknown,
  digest: ContentDigestPort,
): ValidatedRunPayload {
  const result = validatedRunPayloadSchema.safeParse(value);
  if (!result.success) {
    throw new TypeError("workflow artifactがschemaに適合しません", {
      cause: result.error,
    });
  }
  z.object({ schemaVersion: z.literal("23") }).parse(result.data.snapshot);
  z.object({ schemaVersion: z.literal("10") }).parse(result.data.notificationLedger);
  const snapshot = createStateSnapshot(result.data.snapshot);
  assertPersonalReminderEvidenceClosure(snapshot);
  const historyInputEvents = createStateHistoryInputEvents(result.data.historyInputEvents);
  const notificationLedger = createStateNotificationLedger(result.data.notificationLedger);
  const notificationSelection = createNotificationSelection(result.data.notificationSelection);
  const notificationPreview = createNotificationSelection(result.data.notificationPreview);
  const runMetadata = createWorkflowRunMetadata(result.data.runMetadata);
  const aiCacheEntries = createAiCacheEntries(result.data.aiCacheEntries);
  const personalReminderAiCacheEntries = createPersonalReminderAiCacheEntries(
    result.data.personalReminderAiCacheEntries,
  );
  const validation = parseWorkflowValidation(result.data.validation);
  const identityWitness = parseWorkflowIdentityWitness(result.data.identityWitness);
  const artifact = Object.freeze({
    notificationAction: result.data.notificationAction,
    repositoryAllowlist: createRepositoryAllowlist(result.data.repositoryAllowlist),
    repositoryInventory: Object.freeze(
      result.data.repositoryInventory.map((repository) => Object.freeze(repository)),
    ),
    allowlistDigest: result.data.allowlistDigest,
    snapshot,
    historyInputEvents,
    notificationLedger,
    notificationSelection,
    notificationPreview,
    runMetadata,
    aiCacheEntries,
    personalReminderAiCacheEntries,
    pagesUrl: normalizePagesUrl(result.data.pagesUrl),
    discordSettings: Object.freeze({
      ...result.data.discordSettings,
      mentions: Object.freeze({
        ...result.data.discordSettings.mentions,
        users: Object.freeze({
          ...result.data.discordSettings.mentions.users,
        }),
      }),
      retry: Object.freeze({
        ...result.data.discordSettings.retry,
      }),
    }),
    validation,
    identityWitness,
    presentationDigests: result.data.presentationDigests,
  });
  if (!canonicalJsonEquals(value, artifact)) {
    throw new TypeError("workflow artifactの保存値が検証済みの正規形と一致しません");
  }
  if (
    artifact.presentationDigests.runMetadata !==
      digest.sha256Utf8(serializeCanonicalJson(artifact.runMetadata)) ||
    artifact.presentationDigests.pagesUrl !==
      digest.sha256Utf8(serializeCanonicalJson(artifact.pagesUrl)) ||
    artifact.presentationDigests.discordSettings !==
      digest.sha256Utf8(serializeCanonicalJson(artifact.discordSettings))
  ) {
    throw new TypeError("workflow artifactの公開設定とrun metadataがwitnessに一致しません");
  }
  assertRunConsistency(snapshot, runMetadata);
  assertNotificationActionConsistency(artifact.notificationAction, notificationSelection);
  assertNotificationSelectionConsistency(snapshot, notificationLedger, notificationSelection);
  assertValidatedRunPayloadPublicSafety(artifact, artifact.repositoryInventory, [], digest);
  const run: Omit<PublicationValidatedRun, "proof"> = Object.freeze({
    ...validation,
    snapshot,
    historyInputEvents,
    aiCacheAdditions: aiCacheEntries,
    personalReminderAiCacheAdditions: personalReminderAiCacheEntries,
    notificationLedger,
    notificationSelection,
    notificationPreview,
    repositoryAllowlist: createPublicRepositoryAllowlist(artifact.repositoryInventory).repositories,
  });
  const validated = revalidateSerializedRun(run, digest, () => {
    assertValidatedRunPayloadPublicSafety(artifact, artifact.repositoryInventory, [], digest);
  });
  assertWorkflowValidationConsistency(artifact, validated);
  const validatedArtifact = Object.freeze({
    ...artifact,
    repositoryInventory: validated.repositoryAllowlist,
    snapshot: validated.snapshot,
    historyInputEvents: validated.historyInputEvents,
    notificationLedger: validated.notificationLedger,
    notificationSelection: validated.notificationSelection,
    notificationPreview: validated.notificationPreview,
    aiCacheEntries: validated.aiCacheAdditions,
    personalReminderAiCacheEntries: validated.personalReminderAiCacheAdditions,
    validation: Object.freeze({
      core: validated.core,
      previousNotificationLedger: validated.previousNotificationLedger,
      publicationInputs: validated.publicationInputs,
      metrics: validated.metrics,
      diagnostics: validated.diagnostics,
      evidenceClosureSummary: validated.evidenceClosureSummary,
      evidenceClosureWitness: validated.evidenceClosureWitness,
      finalItemAiLineage: validated.finalItemAiLineage,
      publicDiagnosticsSummary: validated.publicDiagnosticsSummary,
      artifactValueDigests: validated.artifactValueDigests,
    }),
    identityWitness: Object.freeze({
      identity: validated.core.identity,
      executionPolicy: validated.core.executionPolicy,
      baseRevision: validated.core.baseRevision,
      configDigest: validated.core.configDigest,
    }),
    validated,
  });
  return validatedArtifact;
}

function assertRepositoryAllowlistConsistency(
  artifact: ValidatedRunPublicValue,
  inventory: readonly Repository[],
  digest: ContentDigestPort,
): void {
  const collectedAllowlist = inventory.filter(isEligiblePublicRepository);
  const artifactRepositories = new Map(
    artifact.repositoryAllowlist.map((repository) => [repository.id, repository]),
  );
  let mismatch = collectedAllowlist.length !== artifact.repositoryAllowlist.length;
  for (const repository of collectedAllowlist) {
    const artifactRepository = artifactRepositories.get(repository.id);
    if (
      artifactRepository?.owner !== repository.owner ||
      artifactRepository.name !== repository.name
    ) {
      mismatch = true;
    }
  }
  if (
    digest.sha256Utf8(
      serializeCanonicalJson(
        artifact.repositoryInventory.map((repository) => ({
          id: repository.id,
          owner: repository.owner,
          name: repository.name,
          visibility: repository.visibility,
          archived: repository.archived,
          disabled: repository.disabled,
        })),
      ),
    ) !== artifact.allowlistDigest ||
    serializeCanonicalJson(artifact.repositoryInventory) !==
      serializeCanonicalJson(collectedAllowlist)
  ) {
    mismatch = true;
  }
  if (mismatch) {
    throw new StatePublicSafetyError(["repository_allowlist_mismatch"]);
  }
}

/** artifact全体へraw inventoryと既知secretを使った公開安全性検査を適用する。 */
export function assertValidatedRunPayloadPublicSafety(
  artifact: ValidatedRunPublicValue,
  inventory: readonly Repository[],
  knownSecrets: readonly string[],
  digest: ContentDigestPort,
): void {
  assertRepositoryAllowlistConsistency(artifact, inventory, digest);
  assertStatePublicSafety({
    snapshot: artifact.snapshot,
    repositoryInventory: inventory,
    repositoryAllowlist: artifact.repositoryAllowlist,
    additionalValues: [
      artifact.repositoryAllowlist,
      artifact.historyInputEvents,
      artifact.notificationLedger,
      artifact.notificationSelection,
      artifact.notificationPreview,
      artifact.runMetadata,
      ...artifact.aiCacheEntries,
      ...artifact.personalReminderAiCacheEntries,
      artifact.pagesUrl,
      artifact.discordSettings,
      artifact.validation,
      artifact.identityWitness,
      artifact.presentationDigests,
    ],
    knownSecrets,
  });
}

/** workflow artifactの公開repository inventoryを返す。 */
export function validatedRunPayloadRepositoryInventory(
  artifact: Pick<ValidatedRunPayload, "repositoryInventory">,
): readonly Repository[] {
  return artifact.repositoryInventory;
}
