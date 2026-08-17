import { readFile } from "node:fs/promises";

import { z } from "zod";

import { createAiCacheEntry, type AiCacheEntry } from "../codex/index.js";
import {
  createGitHubNodeId,
  createGitHubRepositoryId,
  createUtcIsoDateTime,
  type Repository,
} from "../domain/index.js";
import {
  type DiscordDeliverySettings,
  type DiscordNotificationSelection,
} from "../discord/index.js";
import { createPublicRepositoryAllowlist } from "../github/index.js";
import {
  assertStatePublicSafety,
  createStateHistoryInputEvents,
  createStateNotificationLedger,
  createStateSnapshot,
  StatePublicSafetyError,
  type StateNotificationLedger,
  type StateHistoryInputEvent,
  type StateSnapshot,
} from "../persistence/index.js";
import { assertNonNullable } from "../util/index.js";
import { CliWorkflowArtifactError } from "./errors.js";

const actionsSecretNameSchema = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/u);
const nonNegativeIntegerSchema = z.number().int().nonnegative();
const dateTimeSchema = z.iso
  .datetime({
    offset: true,
    error: "タイムゾーンを含むISO 8601日時を指定してください",
  })
  .transform((value) => createUtcIsoDateTime(value));
const nodeIdSchema = z
  .string()
  .min(1)
  .transform((value) => createGitHubNodeId(value));
const repositoryIdSchema = z
  .string()
  .min(1)
  .transform((value) => createGitHubRepositoryId(value));
const repositoryAllowlistEntrySchema = z.strictObject({
  id: repositoryIdSchema,
  owner: z.string().min(1),
  name: z.string().min(1),
});
const severitySchema = z.enum(["none", "watch", "urgent", "critical"]);
const notificationReasonCodeSchema = z.enum([
  "assessment_overdue",
  "owner_overdue",
  "decision_overdue",
  "review_overdue",
  "revision_overdue",
  "reply_overdue",
  "owner_unknown",
  "blocker_overdue",
  "newly_unblocked",
  "dependency_cycle",
  "responsibility_changed",
  "merge_overdue",
  "automation_stuck",
]);
const selectedReasonSchema = z.strictObject({
  reasonCode: notificationReasonCodeSchema,
  notificationKey: z.string().min(1).max(1000),
  cooldownUntil: dateTimeSchema,
});
const notificationCandidateSchema = z.strictObject({
  itemNodeId: nodeIdSchema,
  reasonCode: notificationReasonCodeSchema,
  reasons: z.array(selectedReasonSchema).min(1),
  severity: severitySchema,
  downstreamImpact: z.strictObject({
    nodeId: nodeIdSchema,
    openNodeCount: z.number().int().nonnegative(),
    repositoryCount: z.number().int().nonnegative(),
  }),
  priorityWeight: z.number(),
});
const ledgerReservationSchema = z.strictObject({
  notificationKey: z.string().min(1).max(1000),
  itemNodeId: nodeIdSchema,
  reasonCode: notificationReasonCodeSchema,
  severity: severitySchema,
  reservedAt: dateTimeSchema,
  expiresAt: dateTimeSchema,
  cooldownUntil: dateTimeSchema,
  status: z.literal("reserved"),
});
const notificationSelectionSchema = z.discriminatedUnion("action", [
  z.strictObject({
    action: z.literal("skip_digest"),
    reason: z.literal("no_candidates"),
    candidates: z.tuple([]),
    ledgerReservations: z.tuple([]),
  }),
  z.strictObject({
    action: z.literal("create_digest"),
    candidates: z.array(notificationCandidateSchema).min(1),
    ledgerReservations: z.array(ledgerReservationSchema).min(1),
  }),
]);
const discordSettingsSchema = z.strictObject({
  enabled: z.boolean(),
  webhookSecretName: actionsSecretNameSchema,
  operationsWebhookSecretName: actionsSecretNameSchema,
  mentions: z.strictObject({
    enabled: z.boolean(),
    users: z.record(z.string().min(1), z.string().regex(/^\d{17,20}$/u)),
  }),
  retry: z
    .strictObject({
      maxAttempts: z.number().int().positive(),
      initialDelaySeconds: z.number().nonnegative(),
      maxDelaySeconds: z.number().nonnegative(),
    })
    .refine((retry) => retry.initialDelaySeconds <= retry.maxDelaySeconds, {
      message: "Discord retryの初期待機時間は最大待機時間以下にしてください",
    }),
});
const runMetadataMetricsSchema = z.strictObject({
  repositoryCount: nonNegativeIntegerSchema,
  itemCount: nonNegativeIntegerSchema,
  changedItemCount: nonNegativeIntegerSchema,
  activeEdgeCount: nonNegativeIntegerSchema,
  aiCallCount: nonNegativeIntegerSchema,
  aiCacheHitCount: nonNegativeIntegerSchema,
  aiRetainedResultCount: nonNegativeIntegerSchema,
  estimatedInputTokens: nonNegativeIntegerSchema,
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
const workflowArtifactSchema = z.strictObject({
  schemaVersion: z.literal("1"),
  kind: z.literal("validated_public_run"),
  repositoryAllowlist: z.array(repositoryAllowlistEntrySchema),
  snapshot: z.unknown(),
  historyInputEvents: z.array(z.unknown()),
  notificationLedger: z.unknown(),
  notificationSelection: z.unknown(),
  runMetadata: runMetadataSchema,
  aiCacheEntries: z.array(z.unknown()),
  pagesUrl: z.url(),
  discordSettings: discordSettingsSchema,
});

export type WorkflowArtifactRepositoryAllowlistEntry = Readonly<{
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
export type WorkflowArtifact = Readonly<{
  schemaVersion: "1";
  kind: "validated_public_run";
  repositoryAllowlist: readonly WorkflowArtifactRepositoryAllowlistEntry[];
  snapshot: StateSnapshot;
  historyInputEvents: readonly StateHistoryInputEvent[];
  notificationLedger: StateNotificationLedger;
  notificationSelection: DiscordNotificationSelection;
  runMetadata: WorkflowRunMetadata;
  aiCacheEntries: readonly AiCacheEntry[];
  pagesUrl: string;
  discordSettings: DiscordDeliverySettings;
}>;

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
      reason: "no_candidates",
      candidates: emptyValues(),
      ledgerReservations: emptyValues(),
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

function createRepositoryAllowlist(
  values: readonly z.output<typeof repositoryAllowlistEntrySchema>[],
): readonly WorkflowArtifactRepositoryAllowlistEntry[] {
  const entries: readonly WorkflowArtifactRepositoryAllowlistEntry[] = values.map((value) =>
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

function repositoryInventory(snapshot: StateSnapshot): readonly Repository[] {
  return Object.freeze(
    snapshot.repositories.map((repository) =>
      Object.freeze({
        id: repository.id,
        owner: repository.owner,
        name: repository.name,
        visibility: repository.visibility,
        archived: repository.archived,
        disabled: repository.disabled,
        observedAt: repository.observedAt,
      }),
    ),
  );
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
  const reasonKeys: string[] = [];

  for (const candidate of selection.candidates) {
    if (!itemIds.has(candidate.itemNodeId)) {
      throw new TypeError("workflow artifactの通知候補がsnapshot外の項目を参照しています");
    }
    if (
      candidate.downstreamImpact.nodeId !== candidate.itemNodeId ||
      !candidate.reasons.some((reason) => reason.reasonCode === candidate.reasonCode)
    ) {
      throw new TypeError("workflow artifactの通知候補内で項目または主理由が一致しません");
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
        reservation.severity !== candidate.severity ||
        reservation.cooldownUntil !== reason.cooldownUntil
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
        ledgerEntry.expiresAt !== reservation.expiresAt ||
        ledgerEntry.cooldownUntil !== reservation.cooldownUntil
      ) {
        throw new TypeError("workflow artifactの通知予約がledgerへ反映されていません");
      }
    }
  }
  if (new Set(reasonKeys).size !== reasonKeys.length || reasonKeys.length !== reservations.size) {
    throw new TypeError("workflow artifactの通知候補と予約の対応が一意ではありません");
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
export function createWorkflowArtifact(value: unknown): WorkflowArtifact {
  const result = workflowArtifactSchema.safeParse(value);
  if (!result.success) {
    throw new TypeError("workflow artifactがschemaに適合しません", {
      cause: result.error,
    });
  }
  const snapshot = createStateSnapshot(result.data.snapshot);
  const historyInputEvents = createStateHistoryInputEvents(result.data.historyInputEvents);
  const notificationLedger = createStateNotificationLedger(result.data.notificationLedger);
  const notificationSelection = createNotificationSelection(result.data.notificationSelection);
  const runMetadata = createWorkflowRunMetadata(result.data.runMetadata);
  const aiCacheEntries = createAiCacheEntries(result.data.aiCacheEntries);
  const artifact = Object.freeze({
    schemaVersion: "1",
    kind: "validated_public_run",
    repositoryAllowlist: createRepositoryAllowlist(result.data.repositoryAllowlist),
    snapshot,
    historyInputEvents,
    notificationLedger,
    notificationSelection,
    runMetadata,
    aiCacheEntries,
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
  } satisfies WorkflowArtifact);
  assertRunConsistency(snapshot, runMetadata);
  assertNotificationSelectionConsistency(snapshot, notificationLedger, notificationSelection);
  assertWorkflowArtifactPublicSafety(artifact, repositoryInventory(snapshot), []);
  return artifact;
}

function assertRepositoryAllowlistConsistency(
  artifact: WorkflowArtifact,
  inventory: readonly Repository[],
): void {
  const collectedAllowlist = createPublicRepositoryAllowlist(inventory).repositories;
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
  if (mismatch) {
    throw new StatePublicSafetyError(["repository_allowlist_mismatch"]);
  }
}

/** artifact全体へraw inventoryと既知secretを使った公開安全性検査を適用する。 */
export function assertWorkflowArtifactPublicSafety(
  artifact: WorkflowArtifact,
  inventory: readonly Repository[],
  knownSecrets: readonly string[],
): void {
  assertRepositoryAllowlistConsistency(artifact, inventory);
  assertStatePublicSafety({
    snapshot: artifact.snapshot,
    repositoryInventory: inventory,
    additionalValues: [
      artifact.repositoryAllowlist,
      artifact.historyInputEvents,
      artifact.notificationLedger,
      artifact.notificationSelection,
      artifact.runMetadata,
      ...artifact.aiCacheEntries,
      artifact.pagesUrl,
      artifact.discordSettings,
    ],
    knownSecrets,
  });
}

/** workflow artifactから公開repository inventoryを復元する。 */
export function workflowArtifactRepositoryInventory(
  artifact: WorkflowArtifact,
): readonly Repository[] {
  return repositoryInventory(artifact.snapshot);
}

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error != null && "code" in error && error.code === code;
}

/** 前stageが出力したJSON artifactを読み、全境界検証をやり直す。 */
export async function readWorkflowArtifactFile(path: string): Promise<WorkflowArtifact> {
  let source: string;
  try {
    source = await readFile(path, "utf8");
  } catch (error: unknown) {
    throw new CliWorkflowArtifactError(
      path,
      hasErrorCode(error, "ENOENT") ? "missing" : "invalid",
      {
        cause: error,
      },
    );
  }
  let value: unknown;
  try {
    const parseJson: (input: string) => unknown = JSON.parse;
    value = parseJson(source);
  } catch (error: unknown) {
    throw new CliWorkflowArtifactError(path, "invalid", { cause: error });
  }
  try {
    return createWorkflowArtifact(value);
  } catch (error: unknown) {
    throw new CliWorkflowArtifactError(path, "invalid", { cause: error });
  }
}
