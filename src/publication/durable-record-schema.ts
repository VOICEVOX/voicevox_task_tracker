import { z } from "zod";
import { freezeJsonValue } from "../util/freeze-json-value.js";
import { initialStateWriteManifestSchema } from "../application/tracking-run/contracts/initial-state-write-manifest.js";

import { publicRunDiagnosticsSchema } from "../application/tracking-run/contracts/public-diagnostics.js";
import { publicationInputsSchema } from "../application/tracking-run/contracts/publication-inputs.js";
import { baseStateRevisionSchema } from "../application/tracking-run/contracts/run-core.js";
import { runtimeIdentitySchema } from "../application/tracking-run/contracts/runtime-identity.js";
import type { ContentDigestPort } from "../application/tracking-run/contracts/content-digest-port.js";
import { pagesPublicUrlSchema } from "../application/tracking-run/receipt-schema.js";
import {
  readDurablePublicationRecoveryBootstrap,
  readDurablePublicationRecoveryBootstrapV2,
  runtimeRecoveryPlanV1Schema,
  runtimeRecoveryPlanV2Schema,
} from "../application/tracking-run/recovery-bootstrap.js";
import {
  runExecutionPolicySchema,
  runIdentitySchema,
} from "../application/tracking-run/request.js";
import { serializeCanonicalJson, serializeCanonicalJsonLine } from "../canonical-json/value.js";
import {
  discordSettingsSchema,
  notificationSelectionSchema,
} from "../discord/notification-selection-schema.js";
import { pendingNotificationSchema } from "../domain/index.js";
import { PUBLIC_DTO_SCHEMA_VERSION } from "../pages/public-dto-primitives.js";
import { NOTIFICATION_LEDGER_REASON_CODE_VALUES } from "../persistence/state-documents.js";
import { runMetricsSchema } from "./run-report.js";
import { analysisStageRecordSchema } from "./analysis-stage-record.js";

const validatedRecords = new WeakSet<DurablePublicationRecord>();

const sha256Schema = z.string().regex(/^sha256:[0-9a-f]{64}$/u);
const MAX_RECORD_BYTES = 8 * 1024 * 1024;
export const DURABLE_PUBLICATION_RECORD_SCHEMA_VERSION = 3;
const acknowledgedLedgerEntrySchema = z.strictObject({
  notificationKey: z.string().min(1).max(1000),
  itemNodeId: z.string().min(1).max(1000),
  reasonCode: z.enum(NOTIFICATION_LEDGER_REASON_CODE_VALUES),
  severity: z.enum(["none", "watch", "urgent", "critical"]),
  reservedAt: z.iso.datetime({ offset: true }),
  status: z.literal("acknowledged"),
  acknowledgedAt: z.iso.datetime({ offset: true }),
});

const initialStateContentDigestsSchema = z.strictObject({
  snapshot: sha256Schema,
  historyInputEvents: sha256Schema,
  initialStateWriteManifest: sha256Schema,
  aiCacheAdditions: sha256Schema,
  personalReminderAiCacheAdditions: sha256Schema,
  notificationLedger: sha256Schema,
});
const legacyInitialStateContentDigestsSchema = initialStateContentDigestsSchema.omit({
  initialStateWriteManifest: true,
});
const versionedInitialStateContentDigestsSchema = legacyInitialStateContentDigestsSchema.extend({
  initialStateWriteManifest: sha256Schema.optional(),
});

const initialPagesProjectionSchema = z.strictObject({
  phase: z.literal("initial"),
  snapshot: z.strictObject({
    kind: z.literal("initial_state_snapshot"),
    path: z.string().regex(/^state\/[A-Za-z0-9._/-]+$/u),
    digest: sha256Schema,
  }),
  repositoryAllowlist: z.array(
    z.strictObject({
      id: z.string().min(1),
      owner: z.string().min(1),
      name: z.string().min(1),
      visibility: z.literal("public"),
      archived: z.literal(false),
      disabled: z.literal(false),
      observedAt: z.iso.datetime({ offset: true }),
    }),
  ),
  repositoryAllowlistDigest: sha256Schema,
  publicDtoSchemaVersion: z.literal(PUBLIC_DTO_SCHEMA_VERSION),
  generatedAt: z.iso.datetime({ offset: true }),
  settings: publicationInputsSchema.shape.pages.extend({ url: pagesPublicUrlSchema }),
});

const notificationOutboxSchema = z.discriminatedUnion("action", [
  z.strictObject({
    action: z.literal("send"),
    delivery: z.enum(["send", "no_candidates"]),
    selectedContext: notificationSelectionSchema,
    pagesUrl: z.strictObject({ kind: z.literal("initial_pages_deployment_url") }),
    settings: discordSettingsSchema,
    previousLedgerDigest: sha256Schema,
    initialLedgerDigest: sha256Schema,
  }),
  z.strictObject({
    action: z.literal("hold"),
    delivery: z.literal("held"),
    pendingNotifications: z.array(pendingNotificationSchema),
    previousLedgerDigest: sha256Schema,
    initialLedgerDigest: sha256Schema,
  }),
  z.strictObject({
    action: z.literal("acknowledge-current"),
    delivery: z.literal("acknowledged"),
    acknowledgedEntries: z.array(acknowledgedLedgerEntrySchema),
    pendingNotifications: z.array(pendingNotificationSchema),
    previousLedgerDigest: sha256Schema,
    initialLedgerDigest: sha256Schema,
  }),
]);

const runFinalizationPolicySchema = z.strictObject({
  notificationCountSource: z.literal("outbox_keys_with_sent_ledger_status"),
  metricsSource: z.literal("validated_run_and_notification_settlement_receipt"),
  completeSuccessRequires: z.tuple([
    z.literal("initial_pages_deployed"),
    z.literal("notifications_settled"),
  ]),
  configuredTrackingStartAt: publicationInputsSchema.shape.configuredTrackingStartAt,
  trackingStartAtCondition: z.literal("complete_success"),
  report: z.strictObject({
    runId: z.string().regex(/^tracker-run:[0-9a-f]{64}$/u),
    scheduledFor: z.iso.datetime({ offset: true }),
    startedAt: z.iso.datetime({ offset: true }),
    status: z.enum(["success", "fallback"]),
    metrics: runMetricsSchema,
    diagnostics: publicRunDiagnosticsSchema,
    completionSource: z.literal("notification_settlement_receipt"),
  }),
  ledgerAndHistorySource: z.literal("notification_settlement_receipt"),
  markerPhase: z.literal("run_finalized"),
});

const notificationHistoryPagesPolicySchema = z.discriminatedUnion("action", [
  z.strictObject({
    action: z.literal("send"),
    requirement: z.literal("when_sent_history_added"),
    context: z.literal("outbox_selected_context"),
  }),
  z.strictObject({ action: z.literal("hold"), requirement: z.literal("not_required") }),
  z.strictObject({
    action: z.literal("acknowledge-current"),
    requirement: z.literal("not_required"),
  }),
]);

export const durablePublicationRecordTemplateSchema = z.strictObject({
  runIdentity: runIdentitySchema,
  executionPolicy: runExecutionPolicySchema,
  baseStateRevision: baseStateRevisionSchema,
  configDigest: sha256Schema,
  initialStateValueDigests: initialStateContentDigestsSchema,
  initialPagesProjection: initialPagesProjectionSchema,
  notificationOutbox: notificationOutboxSchema,
  runFinalizationPolicy: runFinalizationPolicySchema,
  notificationHistoryPagesPolicy: notificationHistoryPagesPolicySchema,
});

const durablePublicationRecordV1Schema = z.strictObject({
  recoveryBootstrapVersion: z.literal(1),
  schemaVersion: z.literal(1),
  runIdentity: runIdentitySchema,
  executionPolicy: runExecutionPolicySchema,
  checkpointDigest: sha256Schema,
  checkpointFileDigest: sha256Schema,
  runtimeIdentity: runtimeIdentitySchema,
  runtimeRecoveryPlan: runtimeRecoveryPlanV1Schema,
  configDigest: sha256Schema,
  baseStateRevision: baseStateRevisionSchema,
  initialStateContentDigests: versionedInitialStateContentDigestsSchema,
  initialStateWriteManifest: initialStateWriteManifestSchema.optional(),
  initialPagesProjection: initialPagesProjectionSchema,
  notificationOutbox: notificationOutboxSchema,
  runFinalizationPolicy: runFinalizationPolicySchema,
  notificationHistoryPagesPolicy: notificationHistoryPagesPolicySchema,
  recordDigest: sha256Schema,
});

const durablePublicationRecordV2Schema = durablePublicationRecordV1Schema.extend({
  schemaVersion: z.literal(2),
  runtimeRecoveryPlan: runtimeRecoveryPlanV2Schema,
});

const durablePublicationRecordV3Schema = durablePublicationRecordV2Schema.extend({
  schemaVersion: z.literal(3),
  analysisStageRecord: analysisStageRecordSchema,
});

export const durablePublicationRecordSchema = z
  .discriminatedUnion("schemaVersion", [
    durablePublicationRecordV1Schema,
    durablePublicationRecordV2Schema,
    durablePublicationRecordV3Schema,
  ])
  .superRefine((record, context) => {
    if (
      record.initialStateWriteManifest == null ||
      record.initialStateContentDigests.initialStateWriteManifest == null
    ) {
      context.addIssue({
        code: "custom",
        message: "現行durable publication recordに初回write manifestがありません",
      });
    }
  });

const legacyDurablePublicationRecordV1Schema = durablePublicationRecordV1Schema
  .omit({ initialStateWriteManifest: true })
  .extend({ initialStateContentDigests: legacyInitialStateContentDigestsSchema });
const legacyDurablePublicationRecordV2Schema = legacyDurablePublicationRecordV1Schema.extend({
  schemaVersion: z.literal(2),
  runtimeRecoveryPlan: runtimeRecoveryPlanV2Schema,
});
const legacyDurablePublicationRecordV3Schema = legacyDurablePublicationRecordV2Schema.extend({
  schemaVersion: z.literal(3),
  analysisStageRecord: analysisStageRecordSchema,
});
const legacyDurablePublicationRecordSchema = z.discriminatedUnion("schemaVersion", [
  legacyDurablePublicationRecordV1Schema,
  legacyDurablePublicationRecordV2Schema,
  legacyDurablePublicationRecordV3Schema,
]);

/** checkpoint成立前に確定できる業務値だけのrecord template。 */
export type DurablePublicationRecordTemplate = z.output<
  typeof durablePublicationRecordTemplateSchema
>;

/** 初回state commitで保存する全field確定済みrecord。 */
export type DurablePublicationRecord = z.output<typeof durablePublicationRecordSchema>;

/** Git state読込時だけ受ける旧形式を含むrecord。 */
export type VersionedDurablePublicationRecord = DurablePublicationRecord;

/** 永続recordを末尾改行付きcanonical JSONへ変換する。 */
export function encodeDurablePublicationRecord(
  record: DurablePublicationRecord,
  digest: ContentDigestPort,
): Uint8Array {
  return new TextEncoder().encode(
    serializeCanonicalJsonLine(
      validatedRecords.has(record) ? record : parseDurablePublicationRecord(record, digest),
    ),
  );
}

function assertDurablePublicationRecordContent(
  record: VersionedDurablePublicationRecord,
  digest: ContentDigestPort,
): void {
  const { recordDigest, ...payload } = record;
  if (digest.sha256Utf8(serializeCanonicalJson(payload)) !== recordDigest) {
    throw new TypeError("durable publication recordのdigestが一致しません");
  }
  const manifest = record.initialStateWriteManifest;
  if (manifest != null) {
    if (
      digest.sha256Utf8(serializeCanonicalJson(manifest)) !==
      record.initialStateContentDigests.initialStateWriteManifest
    ) {
      throw new TypeError("初回write manifestがcheckpointの業務digestと一致しません");
    }
    const paths = [
      manifest.history.file.path,
      ...manifest.aiCache.map((file) => file.path),
      ...manifest.personalReminderAiCache.map((file) => file.path),
      ...manifest.deletions.map((entry) => entry.path),
    ];
    if (
      new Set(paths).size !== paths.length ||
      manifest.history.file.operation === "unchanged" ||
      [...manifest.aiCache, ...manifest.personalReminderAiCache].some(
        (file) => file.operation === "modified" && file.beforeDigest === file.afterDigest,
      ) ||
      [...manifest.aiCache, ...manifest.personalReminderAiCache].some(
        (file) => file.operation === "unchanged" && file.beforeDigest !== file.afterDigest,
      ) ||
      [manifest.aiCache, manifest.personalReminderAiCache, manifest.deletions].some((entries) =>
        entries.some((entry, index) => {
          if (index === 0) {
            return false;
          }
          const previous = entries.at(index - 1);
          return previous != null && previous.path.localeCompare(entry.path, "en") >= 0;
        }),
      )
    ) {
      throw new TypeError("初回write manifestのpathまたは操作が不正です");
    }
  }
  if (record.schemaVersion === 1) {
    readDurablePublicationRecoveryBootstrap(
      new TextEncoder().encode(serializeCanonicalJsonLine(record)),
      digest,
    );
  } else {
    readDurablePublicationRecoveryBootstrapV2(
      new TextEncoder().encode(serializeCanonicalJsonLine(record)),
      digest,
    );
    if (record.executionPolicy.executionShape !== "split_workflow") {
      throw new TypeError("V2以降の永続recordは分割workflowだけに使用できます");
    }
  }
  if (
    record.schemaVersion === 3 &&
    (record.analysisStageRecord.runId !== record.runIdentity.runId ||
      record.analysisStageRecord.invocationId !== record.runIdentity.invocationId ||
      record.analysisStageRecord.checkpointDigest !== record.checkpointDigest ||
      record.analysisStageRecord.checkpointFileDigest !== record.checkpointFileDigest ||
      serializeCanonicalJson(record.analysisStageRecord.baseStateRevision) !==
        serializeCanonicalJson(record.baseStateRevision))
  ) {
    throw new TypeError("解析段階記録と永続recordの結合が一致しません");
  }
  if (
    record.initialStateContentDigests.snapshot !== record.initialPagesProjection.snapshot.digest ||
    record.initialStateContentDigests.notificationLedger !==
      record.notificationOutbox.initialLedgerDigest ||
    record.runIdentity.runId !== record.runFinalizationPolicy.report.runId ||
    record.executionPolicy.notificationAction !== record.notificationOutbox.action ||
    record.executionPolicy.notificationAction !== record.notificationHistoryPagesPolicy.action ||
    record.runIdentity.scheduledFor !== record.runFinalizationPolicy.report.scheduledFor ||
    record.runIdentity.startedAt !== record.runFinalizationPolicy.report.startedAt
  ) {
    throw new TypeError("durable publication recordの業務値が一致しません");
  }
  if (
    record.notificationOutbox.action === "send" &&
    (record.notificationOutbox.delivery === "send") !==
      (record.notificationOutbox.selectedContext.action === "create_digest")
  ) {
    throw new TypeError("durable publication recordの通知対象がactionと一致しません");
  }
  if (
    record.runtimeRecoveryPlan.kind === "not_reproducible" &&
    record.executionPolicy.effectTarget !== "recording"
  ) {
    throw new TypeError("永続stateへ回復不能なrecordを保存できません");
  }
}

/** full recordの業務field、相互参照、canonical digestを検証する。 */
export function parseDurablePublicationRecord(
  value: unknown,
  digest: ContentDigestPort,
): DurablePublicationRecord {
  const record = durablePublicationRecordSchema.parse(value);
  assertDurablePublicationRecordContent(record, digest);
  freezeJsonValue(record);
  validatedRecords.add(record);
  return record;
}

function parseCanonicalRecord(bytes: Uint8Array): unknown {
  if (bytes.length > MAX_RECORD_BYTES) {
    throw new TypeError("durable publication recordが許容するbyte数を超えています");
  }
  const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const raw: unknown = JSON.parse(source);
  if (source !== serializeCanonicalJsonLine(raw)) {
    throw new TypeError("durable publication recordがcanonical JSONではありません");
  }
  return raw;
}

/** 旧record契約を厳密に検証し、現行recordもそのまま読む。 */
export function decodeLegacyOrCurrentDurablePublicationRecord(
  bytes: Uint8Array,
  digest: ContentDigestPort,
): VersionedDurablePublicationRecord {
  const raw = parseCanonicalRecord(bytes);
  const legacy = legacyDurablePublicationRecordSchema.safeParse(raw);
  if (!legacy.success) {
    return parseDurablePublicationRecord(raw, digest);
  }
  assertDurablePublicationRecordContent(legacy.data, digest);
  freezeJsonValue(legacy.data);
  return legacy.data;
}

/** canonical JSONのfull recordを読む。 */
export function decodeDurablePublicationRecord(
  bytes: Uint8Array,
  digest: ContentDigestPort,
): DurablePublicationRecord {
  return parseDurablePublicationRecord(parseCanonicalRecord(bytes), digest);
}
