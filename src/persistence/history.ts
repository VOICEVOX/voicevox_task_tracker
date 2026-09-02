import { z } from "zod";

import { serializeCanonicalJson, serializeCanonicalJsonLine } from "./canonical-json.js";
import { StateFormatError, StateHistoryError } from "./errors.js";
import { type LegacyStatus, migrateLegacyStatus } from "./legacy-enum.js";
import { type StateSnapshot } from "./snapshot.js";
import {
  createNotificationReason,
  notificationReasonSchema,
  type Repository,
} from "../domain/index.js";

const STATE_HISTORY_SCHEMA_VERSION_1 = "1";
export const STATE_HISTORY_SCHEMA_VERSION_2 = "2";
export const STATE_HISTORY_SCHEMA_VERSION_3 = "3";
export const STATE_HISTORY_SCHEMA_VERSION_4 = "4";
export const STATE_HISTORY_SCHEMA_VERSION_5 = "5";
export const STATE_HISTORY_SCHEMA_VERSION_6 = "6";

const historySchemaVersionSchema = z.object({
  schemaVersion: z.string().min(1),
});
const identifierSchema = z.string().min(1).max(512).regex(/^\S+$/u);
const dateTimeSchema = z.iso
  .datetime({
    offset: true,
    error: "タイムゾーンを含むISO 8601日時を指定してください",
  })
  .transform((value) => new Date(value).toISOString());
const actorSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.enum(["human", "bot"]),
    nodeId: identifierSchema,
    login: identifierSchema,
  }),
  z.strictObject({
    type: z.literal("system"),
    name: z.string().min(1).max(512),
  }),
]);
const inputEventSchema = z.strictObject({
  sourceId: identifierSchema,
  itemNodeId: identifierSchema,
  kind: z.enum([
    "comment",
    "push",
    "review",
    "review_request",
    "label",
    "assignee",
    "state",
    "relation",
    "ready_for_review",
    "converted_to_draft",
    "added_to_merge_queue",
    "removed_from_merge_queue",
    "auto_merge_enabled",
    "auto_merge_disabled",
  ]),
  actor: actorSchema,
  occurredAt: dateTimeSchema,
});
const inputEventsSchema = z.array(inputEventSchema).superRefine((events, context) => {
  const sourceIdsByItemNodeId = new Map<string, Set<string>>();
  for (const event of events) {
    const sourceIds = sourceIdsByItemNodeId.get(event.itemNodeId);
    if (sourceIds == null) {
      sourceIdsByItemNodeId.set(event.itemNodeId, new Set([event.sourceId]));
      continue;
    }
    if (sourceIds.has(event.sourceId)) {
      context.addIssue({
        code: "custom",
        message: "同じ項目の正規化イベントのsource IDが重複しています",
      });
      continue;
    }
    sourceIds.add(event.sourceId);
  }
});

function isCalendarDate(value: string): boolean {
  const timestamp = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value;
}

const dateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/u)
  .refine(isCalendarDate);
const legacyStatusSchema: z.ZodType<LegacyStatus> = z.enum([
  "new_untriaged",
  "needs_maintainer_decision",
  "waiting_for_author",
  "waiting_for_assignee",
  "blocked",
  "ready_to_merge",
  "waiting_for_owner",
  "waiting_for_review",
  "waiting_for_automation",
  "in_progress",
  "unknown",
  "terminal_merged",
  "terminal_completed",
  "terminal_not_planned",
]);
export const STATE_HISTORY_STATUS_VALUES = [
  "waiting_for_assessment",
  "waiting_for_owner",
  "waiting_for_decision",
  "waiting_for_review",
  "waiting_for_revision",
  "waiting_for_reply",
  "waiting_for_work",
  "waiting_for_unblock",
  "waiting_for_automation",
  "waiting_for_merge",
  "in_progress",
  "unknown",
  "terminal_merged",
  "terminal_completed",
  "terminal_not_planned",
] as const;
const statusSchema = z.enum(STATE_HISTORY_STATUS_VALUES);
const waitingOnRoleSchema = z.enum([
  "author",
  "maintainer",
  "reviewer",
  "assignee",
  "respondent",
  "dependency",
  "merge_decider",
  "ci",
  "unknown",
]);
const waitingOnSchema = z.strictObject({
  kind: z.enum(["user", "team", "role", "item", "automation", "unknown"]),
  candidateId: identifierSchema,
  role: waitingOnRoleSchema,
  reasonSummary: z.string().max(1000),
  sourceIds: z.array(identifierSchema).min(1),
  confidence: z.number().min(0).max(1),
});
const notificationWaitingOnReferenceSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("user"),
    candidateId: identifierSchema,
    role: waitingOnRoleSchema,
  }),
  z.strictObject({
    kind: z.literal("team"),
    candidateId: identifierSchema,
    role: waitingOnRoleSchema,
  }),
  z.strictObject({
    kind: z.literal("role"),
    candidateId: identifierSchema,
    role: waitingOnRoleSchema,
  }),
  z.strictObject({
    kind: z.literal("item"),
    candidateId: identifierSchema,
    role: waitingOnRoleSchema,
    displayReference: z.string().min(4).max(600).regex(/^\S+$/u),
  }),
  z.strictObject({
    kind: z.literal("automation"),
    candidateId: identifierSchema,
    role: waitingOnRoleSchema,
  }),
  z.strictObject({
    kind: z.literal("unknown"),
    candidateId: identifierSchema,
    role: waitingOnRoleSchema,
  }),
]);
const notificationWaitingOnRecordSchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("not_recorded"),
  }),
  z.strictObject({
    status: z.literal("recorded"),
    values: z.array(notificationWaitingOnReferenceSchema).min(1),
  }),
]);
const responsibilitySchema = z.strictObject({
  status: statusSchema,
  waitingOn: z.array(waitingOnSchema),
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
const legacyNotificationTimeReasonThresholdSchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("recorded"),
    hours: z.number().nonnegative(),
  }),
  z.strictObject({
    status: z.literal("not_recorded"),
  }),
]);
const legacyNotificationNotApplicableThresholdSchema = z.strictObject({
  status: z.literal("not_applicable"),
});
const legacyNotificationReasonSchema = z.discriminatedUnion("reasonCode", [
  z.strictObject({
    reasonCode: z.literal("assessment_overdue"),
    threshold: legacyNotificationTimeReasonThresholdSchema,
  }),
  z.strictObject({
    reasonCode: z.literal("owner_overdue"),
    threshold: legacyNotificationTimeReasonThresholdSchema,
  }),
  z.strictObject({
    reasonCode: z.literal("decision_overdue"),
    threshold: legacyNotificationTimeReasonThresholdSchema,
  }),
  z.strictObject({
    reasonCode: z.literal("review_overdue"),
    threshold: legacyNotificationTimeReasonThresholdSchema,
  }),
  z.strictObject({
    reasonCode: z.literal("revision_overdue"),
    threshold: legacyNotificationTimeReasonThresholdSchema,
  }),
  z.strictObject({
    reasonCode: z.literal("reply_overdue"),
    threshold: legacyNotificationTimeReasonThresholdSchema,
  }),
  z.strictObject({
    reasonCode: z.literal("merge_overdue"),
    threshold: legacyNotificationTimeReasonThresholdSchema,
  }),
  z.strictObject({
    reasonCode: z.literal("automation_stuck"),
    threshold: legacyNotificationTimeReasonThresholdSchema,
  }),
  z.strictObject({
    reasonCode: z.literal("owner_unknown"),
    threshold: legacyNotificationNotApplicableThresholdSchema,
  }),
  z.strictObject({
    reasonCode: z.literal("blocker_overdue"),
    threshold: legacyNotificationNotApplicableThresholdSchema,
  }),
  z.strictObject({
    reasonCode: z.literal("newly_unblocked"),
    threshold: legacyNotificationNotApplicableThresholdSchema,
  }),
  z.strictObject({
    reasonCode: z.literal("dependency_cycle"),
    threshold: legacyNotificationNotApplicableThresholdSchema,
  }),
  z.strictObject({
    reasonCode: z.literal("responsibility_changed"),
    threshold: legacyNotificationNotApplicableThresholdSchema,
  }),
]);
const evidenceSchema = z.strictObject({
  sourceId: identifierSchema,
  supports: z.enum(["status", "waiting_on", "relation", "progress", "notification", "uncertainty"]),
  summary: z.string().max(1000),
});
const relationContradictionSchema = z.strictObject({
  verdict: z.enum([
    "current_is_blocked_by_target",
    "current_blocks_target",
    "current_implements_target",
    "target_is_subtask_of_current",
    "current_is_subtask_of_target",
    "duplicates",
    "related",
    "none",
  ]),
  confidence: z.number().min(0).max(1),
});
const edgeFieldsSchema = z.strictObject({
  fromNodeId: identifierSchema,
  toNodeId: identifierSchema,
  type: z.enum(["blocks", "parent_of", "implements", "related_to", "duplicates"]),
  provenance: z.enum([
    "native",
    "explicit_text",
    "closing_keyword",
    "checklist",
    "cross_reference",
    "ai_inference",
  ]),
  confidence: z.number().min(0).max(1),
  evidence: z.array(evidenceSchema),
  contradictions: z.array(relationContradictionSchema),
  firstSeenAt: dateTimeSchema,
  lastConfirmedAt: dateTimeSchema,
});
const edgeSchema = z.discriminatedUnion("active", [
  edgeFieldsSchema.extend({
    active: z.literal(true),
  }),
  edgeFieldsSchema.extend({
    active: z.literal(false),
    removedAt: dateTimeSchema,
  }),
]);
const stateHistoryStateEventSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("responsibility_set"),
    nodeId: identifierSchema,
    value: responsibilitySchema,
  }),
  z.strictObject({
    kind: z.literal("responsibility_removed"),
    nodeId: identifierSchema,
  }),
  z.strictObject({
    kind: z.literal("severity_set"),
    nodeId: identifierSchema,
    value: severitySchema,
  }),
  z.strictObject({
    kind: z.literal("severity_removed"),
    nodeId: identifierSchema,
  }),
  z.strictObject({
    kind: z.literal("edge_set"),
    relationId: identifierSchema,
    value: edgeSchema,
  }),
  z.strictObject({
    kind: z.literal("edge_removed"),
    relationId: identifierSchema,
  }),
  z.strictObject({
    kind: z.literal("repository_excluded"),
    repositoryFullName: z.string().regex(/^[^/\s]+\/[^/\s]+$/u),
    reason: z.literal("archived"),
  }),
]);
const notificationSentEventCommonFieldsSchema = z.strictObject({
  kind: z.literal("notification_sent"),
  deliveryId: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
  itemNodeId: identifierSchema,
  repositoryId: identifierSchema,
  type: z.enum(["issue", "pull_request"]),
  displayReference: z.string().min(4).max(600).regex(/^\S+$/u),
  number: z.number().int().positive(),
  title: z.string().max(500),
  url: z
    .url()
    .max(1000)
    .refine((value) => {
      const url = new URL(value);
      return (
        url.protocol === "https:" &&
        url.hostname === "github.com" &&
        url.port === "" &&
        url.username === "" &&
        url.password === ""
      );
    }),
  severity: severitySchema,
  sentAt: dateTimeSchema,
});
const notificationSentEventLegacyFieldsSchema = notificationSentEventCommonFieldsSchema.extend({
  reasonCodes: z.array(notificationReasonCodeSchema).min(1),
});
const notificationSentEventVersion3Schema = notificationSentEventLegacyFieldsSchema.superRefine(
  (event, context) => {
    if (new Set(event.reasonCodes).size !== event.reasonCodes.length) {
      context.addIssue({
        code: "custom",
        path: ["reasonCodes"],
        message: "通知理由コードが重複しています",
      });
    }
  },
);
const notificationSentEventVersion4Schema = notificationSentEventLegacyFieldsSchema
  .extend({
    waitingOn: notificationWaitingOnRecordSchema,
  })
  .superRefine((event, context) => {
    if (new Set(event.reasonCodes).size !== event.reasonCodes.length) {
      context.addIssue({
        code: "custom",
        path: ["reasonCodes"],
        message: "通知理由コードが重複しています",
      });
    }
  });
const notificationSentEventSchema = notificationSentEventCommonFieldsSchema
  .extend({
    waitingOn: notificationWaitingOnRecordSchema,
    reasons: z.array(notificationReasonSchema).min(1),
  })
  .superRefine((event, context) => {
    const reasonCodes = event.reasons.map((reason) => reason.reasonCode);
    if (new Set(reasonCodes).size !== reasonCodes.length) {
      context.addIssue({
        code: "custom",
        path: ["reasons"],
        message: "通知理由コードが重複しています",
      });
    }
  });
const notificationSentEventVersion5Schema = notificationSentEventCommonFieldsSchema
  .extend({
    waitingOn: notificationWaitingOnRecordSchema,
    reasons: z.array(legacyNotificationReasonSchema).min(1),
  })
  .superRefine((event, context) => {
    const reasonCodes = event.reasons.map((reason) => reason.reasonCode);
    if (new Set(reasonCodes).size !== reasonCodes.length) {
      context.addIssue({
        code: "custom",
        path: ["reasons"],
        message: "通知理由コードが重複しています",
      });
    }
  });
const historyEventSchema = z.discriminatedUnion("kind", [
  stateHistoryStateEventSchema.options[0],
  stateHistoryStateEventSchema.options[1],
  stateHistoryStateEventSchema.options[2],
  stateHistoryStateEventSchema.options[3],
  stateHistoryStateEventSchema.options[4],
  stateHistoryStateEventSchema.options[5],
  stateHistoryStateEventSchema.options[6],
  notificationSentEventSchema,
]);
const historyEventVersion5Schema = z.discriminatedUnion("kind", [
  stateHistoryStateEventSchema.options[0],
  stateHistoryStateEventSchema.options[1],
  stateHistoryStateEventSchema.options[2],
  stateHistoryStateEventSchema.options[3],
  stateHistoryStateEventSchema.options[4],
  stateHistoryStateEventSchema.options[5],
  stateHistoryStateEventSchema.options[6],
  notificationSentEventVersion5Schema,
]);
const historyEventVersion2Schema = stateHistoryStateEventSchema;
const historyEventVersion3Schema = z.discriminatedUnion("kind", [
  stateHistoryStateEventSchema.options[0],
  stateHistoryStateEventSchema.options[1],
  stateHistoryStateEventSchema.options[2],
  stateHistoryStateEventSchema.options[3],
  stateHistoryStateEventSchema.options[4],
  stateHistoryStateEventSchema.options[5],
  stateHistoryStateEventSchema.options[6],
  notificationSentEventVersion3Schema,
]);
const historyEventVersion4Schema = z.discriminatedUnion("kind", [
  stateHistoryStateEventSchema.options[0],
  stateHistoryStateEventSchema.options[1],
  stateHistoryStateEventSchema.options[2],
  stateHistoryStateEventSchema.options[3],
  stateHistoryStateEventSchema.options[4],
  stateHistoryStateEventSchema.options[5],
  stateHistoryStateEventSchema.options[6],
  notificationSentEventVersion4Schema,
]);
const historyRecordVersion1EventSchema = z.union([
  z.looseObject({
    kind: z.literal("responsibility_set"),
    value: z.looseObject({
      status: legacyStatusSchema,
    }),
  }),
  z.looseObject({
    kind: z.enum([
      "responsibility_removed",
      "severity_set",
      "severity_removed",
      "edge_set",
      "edge_removed",
      "repository_excluded",
    ]),
  }),
]);
const historyRecordVersion1MigrationSchema = z.looseObject({
  schemaVersion: z.literal(STATE_HISTORY_SCHEMA_VERSION_1),
  events: z.array(historyRecordVersion1EventSchema),
});
const historyRecordVersion2Schema = z
  .strictObject({
    schemaVersion: z.literal(STATE_HISTORY_SCHEMA_VERSION_2),
    date: dateSchema,
    runId: identifierSchema,
    recordedAt: dateTimeSchema,
    inputEvents: inputEventsSchema,
    events: z.array(historyEventVersion2Schema),
  })
  .superRefine((record, context) => {
    const keys = record.events.map(historyEventKey);
    if (new Set(keys).size !== keys.length) {
      context.addIssue({
        code: "custom",
        path: ["events"],
        message: "同じ対象と分類のeventが重複しています",
      });
    }
  });
const historyRecordVersion3Schema = z
  .strictObject({
    schemaVersion: z.literal(STATE_HISTORY_SCHEMA_VERSION_3),
    date: dateSchema,
    runId: identifierSchema,
    recordedAt: dateTimeSchema,
    inputEvents: inputEventsSchema,
    events: z.array(historyEventVersion3Schema),
  })
  .superRefine((record, context) => {
    const keys = record.events.map(historyEventKey);
    if (new Set(keys).size !== keys.length) {
      context.addIssue({
        code: "custom",
        path: ["events"],
        message: "同じ対象と分類のeventが重複しています",
      });
    }
  });
const historyRecordVersion4Schema = z
  .strictObject({
    schemaVersion: z.literal(STATE_HISTORY_SCHEMA_VERSION_4),
    date: dateSchema,
    runId: identifierSchema,
    recordedAt: dateTimeSchema,
    inputEvents: inputEventsSchema,
    events: z.array(historyEventVersion4Schema),
  })
  .superRefine((record, context) => {
    const keys = record.events.map(historyEventKey);
    if (new Set(keys).size !== keys.length) {
      context.addIssue({
        code: "custom",
        path: ["events"],
        message: "同じ対象と分類のeventが重複しています",
      });
    }
  });
const historyRecordVersion5Schema = z
  .strictObject({
    schemaVersion: z.literal(STATE_HISTORY_SCHEMA_VERSION_5),
    date: dateSchema,
    runId: identifierSchema,
    recordedAt: dateTimeSchema,
    inputEvents: inputEventsSchema,
    events: z.array(historyEventVersion5Schema),
  })
  .superRefine((record, context) => {
    const keys = record.events.map(historyEventKey);
    if (new Set(keys).size !== keys.length) {
      context.addIssue({
        code: "custom",
        path: ["events"],
        message: "同じ対象と分類のeventが重複しています",
      });
    }
  });
const historyRecordVersion6Schema = z
  .strictObject({
    schemaVersion: z.literal(STATE_HISTORY_SCHEMA_VERSION_6),
    date: dateSchema,
    runId: identifierSchema,
    recordedAt: dateTimeSchema,
    inputEvents: inputEventsSchema,
    events: z.array(historyEventSchema),
  })
  .superRefine((record, context) => {
    const keys = record.events.map(historyEventKey);
    if (new Set(keys).size !== keys.length) {
      context.addIssue({
        code: "custom",
        path: ["events"],
        message: "同じ対象と分類のeventが重複しています",
      });
    }
  });

/** 履歴へ保存する責務状態。 */
export type StateHistoryResponsibility = z.output<typeof responsibilitySchema>;

/** 履歴へ保存するedge状態。 */
export type StateHistoryEdge = z.output<typeof edgeSchema>;

/** 日次履歴の一つの変更event。 */
export type StateHistoryEvent = z.output<typeof historyEventSchema>;

/** Discord通知送信を保存する履歴event。 */
export type StateHistoryNotificationEvent = z.output<typeof notificationSentEventSchema>;

/** 日次履歴へ保存する一つの正規化入力イベント。 */
export type StateHistoryInputEvent = z.output<typeof inputEventSchema>;

/** 通知時点のsnapshotからwaitingOn項目の表示参照を解決する。 */
export function resolveStateHistoryNotificationItemDisplayReference(
  snapshot: StateSnapshot,
  candidateId: string,
): string {
  const itemsByNodeId = new Map<string, StateSnapshot["items"][number]>(
    snapshot.items.map((item) => [item.nodeId, item]),
  );
  if (itemsByNodeId.size !== snapshot.items.length) {
    throw new StateHistoryError("snapshotのitem node IDが重複しています");
  }
  const externalReferencesByNodeId = new Map<string, StateSnapshot["externalReferences"][number]>(
    snapshot.externalReferences.map((reference) => [reference.nodeId, reference]),
  );
  if (externalReferencesByNodeId.size !== snapshot.externalReferences.length) {
    throw new StateHistoryError("snapshotのexternal reference node IDが重複しています");
  }
  const item = itemsByNodeId.get(candidateId);
  const externalReference = externalReferencesByNodeId.get(candidateId);
  if (item != null && externalReference != null) {
    throw new StateHistoryError("snapshotでitemとexternal referenceのnode IDが重複しています");
  }
  if (item != null) {
    return item.displayReference;
  }
  if (externalReference != null) {
    return `${externalReference.repositoryFullName}#${externalReference.number.toString()}`;
  }
  throw new StateHistoryError(
    `通知送信eventのitem waitingOn参照をsnapshotから解決できません。対象: ${candidateId}`,
  );
}

type StateHistoryRecordVersion1 = z.output<typeof historyRecordVersion1MigrationSchema>;
type StateHistoryRecordVersion2 = z.output<typeof historyRecordVersion2Schema>;
type StateHistoryRecordVersion3 = z.output<typeof historyRecordVersion3Schema>;
type StateHistoryRecordVersion4 = z.output<typeof historyRecordVersion4Schema>;
type StateHistoryRecordVersion5 = z.output<typeof historyRecordVersion5Schema>;
type StateHistoryRecordVersion6 = z.output<typeof historyRecordVersion6Schema>;
type StateHistoryEventVersion3 = z.output<typeof historyEventVersion3Schema>;
type StateHistoryEventVersion4 = z.output<typeof historyEventVersion4Schema>;
type StateHistoryEventVersion5 = z.output<typeof historyEventVersion5Schema>;
type StateHistoryNotificationEventVersion4 = z.output<typeof notificationSentEventVersion4Schema>;
type StateHistoryRecordVersionParser = (value: unknown) => StateHistoryRecord;

/** 一つの完全runが生成したschema version 6の日次履歴record。 */
export type StateHistoryRecord = StateHistoryRecordVersion6;

/** 履歴を指定時点まで再生した責務・edge・severity状態。 */
export type ReplayedStateHistory = Readonly<{
  responsibilities: ReadonlyMap<string, StateHistoryResponsibility>;
  edges: ReadonlyMap<string, StateHistoryEdge>;
  severities: ReadonlyMap<string, z.output<typeof severitySchema>>;
}>;

/** 履歴差分の値が存在するかを明示する型。 */
export type StateHistoryValue<T> =
  | Readonly<{
      status: "absent";
    }>
  | Readonly<{
      status: "present";
      value: T;
    }>;

/** 履歴の二時点間で変化した一つの値。 */
export type StateHistoryDifference<T> = Readonly<{
  id: string;
  before: StateHistoryValue<T>;
  after: StateHistoryValue<T>;
}>;

/** 二日間の責務・edge・severity差分。 */
export type StateHistoryDiff = Readonly<{
  fromDate: string;
  toDate: string;
  responsibilities: readonly StateHistoryDifference<StateHistoryResponsibility>[];
  edges: readonly StateHistoryDifference<StateHistoryEdge>[];
  severities: readonly StateHistoryDifference<z.output<typeof severitySchema>>[];
}>;

type StateHistoryProjection = Readonly<{
  responsibilities: ReadonlyMap<string, StateHistoryResponsibility>;
  edges: ReadonlyMap<string, StateHistoryEdge>;
  severities: ReadonlyMap<string, z.output<typeof severitySchema>>;
}>;

function compareStrings(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function compareInputEvents(left: StateHistoryInputEvent, right: StateHistoryInputEvent): number {
  const occurredAtComparison = compareStrings(left.occurredAt, right.occurredAt);
  if (occurredAtComparison !== 0) {
    return occurredAtComparison;
  }
  const sourceIdComparison = compareStrings(left.sourceId, right.sourceId);
  if (sourceIdComparison !== 0) {
    return sourceIdComparison;
  }
  return compareStrings(left.itemNodeId, right.itemNodeId);
}

/** 未検証の値を検証済みかつ決定論的順序の正規化入力イベントへ変換する。 */
export function createStateHistoryInputEvents(value: unknown): readonly StateHistoryInputEvent[] {
  const result = inputEventsSchema.safeParse(value);
  if (!result.success) {
    throw StateFormatError.fromZodError("state履歴の入力イベント", result.error);
  }
  return Object.freeze(
    [...result.data].sort(compareInputEvents).map((event) =>
      Object.freeze({
        ...event,
        actor: Object.freeze({ ...event.actor }),
      }),
    ),
  );
}

function historyEventKey(
  event:
    | StateHistoryEvent
    | StateHistoryEventVersion3
    | StateHistoryEventVersion4
    | StateHistoryEventVersion5,
): string {
  switch (event.kind) {
    case "responsibility_set":
    case "responsibility_removed":
      return `responsibility:${event.nodeId}`;
    case "severity_set":
    case "severity_removed":
      return `severity:${event.nodeId}`;
    case "edge_set":
    case "edge_removed":
      return `edge:${event.relationId}`;
    case "repository_excluded":
      return `repository_excluded:${event.repositoryFullName}`;
    case "notification_sent":
      return `notification_sent:${event.deliveryId}:${event.itemNodeId}`;
  }
}

function createRepositoryExclusionEvents(
  previousSnapshot: StateSnapshot | undefined,
  currentSnapshot: StateSnapshot,
  repositoryInventory: readonly Repository[],
): readonly StateHistoryEvent[] {
  if (previousSnapshot == null) {
    return Object.freeze([]);
  }
  const currentRepositoryIds = new Set(
    currentSnapshot.repositories.map((repository) => repository.id),
  );
  const inventoryById = new Map(
    repositoryInventory.map((repository) => [repository.id, repository]),
  );
  const events: StateHistoryEvent[] = [];
  for (const previousRepository of previousSnapshot.repositories) {
    if (currentRepositoryIds.has(previousRepository.id)) {
      continue;
    }
    const currentInventoryRepository = inventoryById.get(previousRepository.id);
    if (
      currentInventoryRepository?.visibility === "public" &&
      currentInventoryRepository.archived
    ) {
      events.push({
        kind: "repository_excluded",
        repositoryFullName: `${currentInventoryRepository.owner}/${currentInventoryRepository.name}`,
        reason: "archived",
      });
    }
  }
  return Object.freeze(events);
}

function snapshotInputEventItems(
  snapshot: StateSnapshot,
): ReadonlyMap<string, ReadonlySet<string>> {
  const itemNodeIdsBySourceId = new Map<string, Set<string>>();
  for (const item of snapshot.items) {
    for (const event of item.inputEvents) {
      const itemNodeIds = itemNodeIdsBySourceId.get(event.sourceId);
      if (itemNodeIds == null) {
        itemNodeIdsBySourceId.set(event.sourceId, new Set([item.nodeId]));
        continue;
      }
      if (itemNodeIds.has(item.nodeId)) {
        throw new StateHistoryError("snapshot内で同じ項目の入力イベントsource IDが重複しています");
      }
      itemNodeIds.add(item.nodeId);
    }
  }
  return itemNodeIdsBySourceId;
}

function createNewInputEvents(
  previousSnapshot: StateSnapshot | undefined,
  currentSnapshot: StateSnapshot,
  value: readonly StateHistoryInputEvent[],
): readonly StateHistoryInputEvent[] {
  const inputEvents = createStateHistoryInputEvents(value);
  const previousItemNodeIdsBySourceId =
    previousSnapshot == null
      ? new Map<string, ReadonlySet<string>>()
      : snapshotInputEventItems(previousSnapshot);
  const currentItemNodeIdsBySourceId = snapshotInputEventItems(currentSnapshot);
  const events: StateHistoryInputEvent[] = [];
  for (const event of inputEvents) {
    const currentItemNodeIds = currentItemNodeIdsBySourceId.get(event.sourceId);
    if (currentItemNodeIds?.has(event.itemNodeId) !== true) {
      throw new StateHistoryError("正規化イベントが現在のsnapshotの対象項目に存在しません");
    }
    const previousItemNodeIds = previousItemNodeIdsBySourceId.get(event.sourceId);
    if (previousItemNodeIds?.has(event.itemNodeId) !== true) {
      events.push(event);
    }
  }
  return Object.freeze(events);
}

function createProjection(snapshot: StateSnapshot): StateHistoryProjection {
  return {
    responsibilities: new Map(
      snapshot.items.map((item) => [
        item.nodeId,
        {
          status: item.status,
          waitingOn: item.waitingOn.map((waitingOn) => ({
            ...waitingOn,
            sourceIds: [...waitingOn.sourceIds],
          })),
        },
      ]),
    ),
    edges: new Map(
      snapshot.relations.map((relation) => [
        relation.id,
        relation.active
          ? Object.freeze({
              fromNodeId: relation.fromNodeId,
              toNodeId: relation.toNodeId,
              type: relation.type,
              provenance: relation.provenance,
              confidence: relation.confidence,
              evidence: relation.evidence.map((entry) => ({ ...entry })),
              contradictions: relation.contradictions.map((contradiction) => ({
                ...contradiction,
              })),
              firstSeenAt: relation.firstSeenAt,
              lastConfirmedAt: relation.lastConfirmedAt,
              active: true,
            })
          : Object.freeze({
              fromNodeId: relation.fromNodeId,
              toNodeId: relation.toNodeId,
              type: relation.type,
              provenance: relation.provenance,
              confidence: relation.confidence,
              evidence: relation.evidence.map((entry) => ({ ...entry })),
              contradictions: relation.contradictions.map((contradiction) => ({
                ...contradiction,
              })),
              firstSeenAt: relation.firstSeenAt,
              lastConfirmedAt: relation.lastConfirmedAt,
              active: false,
              removedAt: relation.removedAt,
            }),
      ]),
    ),
    severities: new Map(snapshot.items.map((item) => [item.nodeId, item.severity])),
  };
}

function valuesEqual(left: unknown, right: unknown): boolean {
  return serializeCanonicalJson(left) === serializeCanonicalJson(right);
}

function createSetAndRemoveEvents<T>(
  category: "responsibility" | "edge" | "severity",
  previous: ReadonlyMap<string, T>,
  current: ReadonlyMap<string, T>,
): StateHistoryEvent[] {
  const events: StateHistoryEvent[] = [];
  const identifiers = [...new Set([...previous.keys(), ...current.keys()])].sort(compareStrings);
  for (const identifier of identifiers) {
    const previousValue = previous.get(identifier);
    const currentValue = current.get(identifier);
    if (currentValue == null) {
      if (previousValue == null) {
        throw new StateHistoryError("履歴差分の削除対象を取得できません");
      }
      if (category === "responsibility") {
        events.push({
          kind: "responsibility_removed",
          nodeId: identifier,
        });
      } else if (category === "edge") {
        events.push({
          kind: "edge_removed",
          relationId: identifier,
        });
      } else {
        events.push({
          kind: "severity_removed",
          nodeId: identifier,
        });
      }
      continue;
    }
    if (previousValue != null && valuesEqual(previousValue, currentValue)) {
      continue;
    }
    if (category === "responsibility") {
      const result = responsibilitySchema.safeParse(currentValue);
      if (!result.success) {
        throw new StateHistoryError("責務差分を検証できません");
      }
      events.push({
        kind: "responsibility_set",
        nodeId: identifier,
        value: result.data,
      });
    } else if (category === "edge") {
      const result = edgeSchema.safeParse(currentValue);
      if (!result.success) {
        throw new StateHistoryError("edge差分を検証できません");
      }
      events.push({
        kind: "edge_set",
        relationId: identifier,
        value: result.data,
      });
    } else {
      const result = severitySchema.safeParse(currentValue);
      if (!result.success) {
        throw new StateHistoryError("severity差分を検証できません");
      }
      events.push({
        kind: "severity_set",
        nodeId: identifier,
        value: result.data,
      });
    }
  }
  return events;
}

function createEmptyProjection(): StateHistoryProjection {
  return {
    responsibilities: new Map(),
    edges: new Map(),
    severities: new Map(),
  };
}

function parseStateHistoryRecordVersion1(value: unknown): StateHistoryRecordVersion1 {
  const result = historyRecordVersion1MigrationSchema.safeParse(value);
  if (!result.success) {
    throw StateFormatError.fromZodError("state history", result.error);
  }
  return result.data;
}

function migrateStateHistoryRecordVersion1(record: StateHistoryRecordVersion1): StateHistoryRecord {
  return migrateStateHistoryRecordVersion2(
    parseStateHistoryRecordVersion2({
      ...record,
      schemaVersion: STATE_HISTORY_SCHEMA_VERSION_2,
      events: record.events.map((event) =>
        event.kind === "responsibility_set"
          ? {
              ...event,
              value: {
                ...event.value,
                status: migrateLegacyStatus(event.value.status),
              },
            }
          : event,
      ),
    }),
  );
}

function parseStateHistoryRecordVersion2(value: unknown): StateHistoryRecordVersion2 {
  const result = historyRecordVersion2Schema.safeParse(value);
  if (!result.success) {
    throw StateFormatError.fromZodError("state history", result.error);
  }
  return result.data;
}

function migrateStateHistoryRecordVersion2(record: StateHistoryRecordVersion2): StateHistoryRecord {
  return migrateStateHistoryRecordVersion3(
    parseStateHistoryRecordVersion3({
      ...record,
      schemaVersion: STATE_HISTORY_SCHEMA_VERSION_3,
    }),
  );
}

function parseStateHistoryRecordVersion3(value: unknown): StateHistoryRecordVersion3 {
  const result = historyRecordVersion3Schema.safeParse(value);
  if (!result.success) {
    throw StateFormatError.fromZodError("state history", result.error);
  }
  return result.data;
}

function migrateStateHistoryRecordVersion3(record: StateHistoryRecordVersion3): StateHistoryRecord {
  return migrateStateHistoryRecordVersion4(
    parseStateHistoryRecordVersion4({
      ...record,
      schemaVersion: STATE_HISTORY_SCHEMA_VERSION_4,
      events: record.events.map((event) =>
        event.kind === "notification_sent"
          ? {
              ...event,
              waitingOn: {
                status: "not_recorded",
              },
            }
          : event,
      ),
    }),
  );
}

function parseStateHistoryRecordVersion4(value: unknown): StateHistoryRecordVersion4 {
  const result = historyRecordVersion4Schema.safeParse(value);
  if (!result.success) {
    throw StateFormatError.fromZodError("state history", result.error);
  }
  return result.data;
}

function migrateNotificationReasonCode(
  reasonCode: z.output<typeof notificationReasonCodeSchema>,
): z.output<typeof notificationReasonSchema> {
  switch (reasonCode) {
    case "assessment_overdue":
    case "owner_overdue":
    case "decision_overdue":
    case "review_overdue":
    case "revision_overdue":
    case "reply_overdue":
    case "merge_overdue":
    case "automation_stuck":
      return createNotificationReason(reasonCode, {
        status: "not_recorded",
      });
    case "owner_unknown":
    case "blocker_overdue":
    case "newly_unblocked":
    case "dependency_cycle":
    case "responsibility_changed":
      return createNotificationReason(reasonCode, {
        status: "not_applicable",
      });
  }
}

function migrateNotificationSentEventVersion4(
  event: StateHistoryNotificationEventVersion4,
): z.output<typeof notificationSentEventSchema> {
  const { reasonCodes, ...fields } = event;
  return {
    ...fields,
    reasons: reasonCodes.map(migrateNotificationReasonCode),
  };
}

function migrateStateHistoryRecordVersion4(record: StateHistoryRecordVersion4): StateHistoryRecord {
  return migrateStateHistoryRecordVersion5(
    parseStateHistoryRecordVersion5({
      ...record,
      schemaVersion: STATE_HISTORY_SCHEMA_VERSION_5,
      events: record.events.map((event) =>
        event.kind === "notification_sent" ? migrateNotificationSentEventVersion4(event) : event,
      ),
    }),
  );
}

function parseStateHistoryRecordVersion5(value: unknown): StateHistoryRecordVersion5 {
  const result = historyRecordVersion5Schema.safeParse(value);
  if (!result.success) {
    throw StateFormatError.fromZodError("state history", result.error);
  }
  return result.data;
}

function migrateStateHistoryRecordVersion5(record: StateHistoryRecordVersion5): StateHistoryRecord {
  return migrateStateHistoryRecordVersion6(
    parseStateHistoryRecordVersion6({
      ...record,
      schemaVersion: STATE_HISTORY_SCHEMA_VERSION_6,
      events: record.events.map((event) => event),
    }),
  );
}

function parseStateHistoryRecordVersion6(value: unknown): StateHistoryRecordVersion6 {
  const result = historyRecordVersion6Schema.safeParse(value);
  if (!result.success) {
    throw StateFormatError.fromZodError("state history", result.error);
  }
  return result.data;
}

function migrateStateHistoryRecordVersion6(record: StateHistoryRecordVersion6): StateHistoryRecord {
  return Object.freeze(record);
}

function createStateHistoryRecordVersionParser<TVersion>(
  parser: (value: unknown) => TVersion,
  migration: (record: TVersion) => StateHistoryRecord,
): StateHistoryRecordVersionParser {
  return (value) => migration(parser(value));
}

const stateHistoryRecordVersionParsers: ReadonlyMap<string, StateHistoryRecordVersionParser> =
  new Map([
    [
      STATE_HISTORY_SCHEMA_VERSION_1,
      createStateHistoryRecordVersionParser(
        parseStateHistoryRecordVersion1,
        migrateStateHistoryRecordVersion1,
      ),
    ],
    [
      STATE_HISTORY_SCHEMA_VERSION_2,
      createStateHistoryRecordVersionParser(
        parseStateHistoryRecordVersion2,
        migrateStateHistoryRecordVersion2,
      ),
    ],
    [
      STATE_HISTORY_SCHEMA_VERSION_3,
      createStateHistoryRecordVersionParser(
        parseStateHistoryRecordVersion3,
        migrateStateHistoryRecordVersion3,
      ),
    ],
    [
      STATE_HISTORY_SCHEMA_VERSION_4,
      createStateHistoryRecordVersionParser(
        parseStateHistoryRecordVersion4,
        migrateStateHistoryRecordVersion4,
      ),
    ],
    [
      STATE_HISTORY_SCHEMA_VERSION_5,
      createStateHistoryRecordVersionParser(
        parseStateHistoryRecordVersion5,
        migrateStateHistoryRecordVersion5,
      ),
    ],
    [
      STATE_HISTORY_SCHEMA_VERSION_6,
      createStateHistoryRecordVersionParser(
        parseStateHistoryRecordVersion6,
        migrateStateHistoryRecordVersion6,
      ),
    ],
  ]);

function parseVersionedStateHistoryRecord(value: unknown): StateHistoryRecord {
  const versionResult = historySchemaVersionSchema.safeParse(value);
  if (!versionResult.success) {
    throw StateFormatError.fromZodError("state history", versionResult.error);
  }
  const parser = stateHistoryRecordVersionParsers.get(versionResult.data.schemaVersion);
  if (parser == null) {
    throw new StateFormatError("state history", {
      cause: new TypeError("state historyのschemaVersionは未対応です"),
    });
  }
  return parser(value);
}

function validateHistoryRecord(value: unknown): StateHistoryRecord {
  return migrateStateHistoryRecordVersion6(parseStateHistoryRecordVersion6(value));
}

/** previous snapshotからcurrent snapshotへの日次履歴recordを生成する。 */
export function createStateHistoryRecord(
  previousSnapshot: StateSnapshot | undefined,
  currentSnapshot: StateSnapshot,
  date: string,
  repositoryInventory: readonly Repository[],
  inputEvents: readonly StateHistoryInputEvent[],
): StateHistoryRecord {
  if (!isCalendarDate(date)) {
    throw new StateHistoryError("履歴の日付が不正です");
  }
  const previous =
    previousSnapshot == null ? createEmptyProjection() : createProjection(previousSnapshot);
  const current = createProjection(currentSnapshot);
  const events = [
    ...createSetAndRemoveEvents(
      "responsibility",
      previous.responsibilities,
      current.responsibilities,
    ),
    ...createSetAndRemoveEvents("edge", previous.edges, current.edges),
    ...createSetAndRemoveEvents("severity", previous.severities, current.severities),
    ...createRepositoryExclusionEvents(previousSnapshot, currentSnapshot, repositoryInventory),
  ].sort((left, right) => compareStrings(historyEventKey(left), historyEventKey(right)));

  return validateHistoryRecord({
    schemaVersion: STATE_HISTORY_SCHEMA_VERSION_6,
    date,
    runId: currentSnapshot.run.id,
    recordedAt: currentSnapshot.generatedAt,
    inputEvents: createNewInputEvents(previousSnapshot, currentSnapshot, inputEvents),
    events,
  });
}

/** 対象runの履歴recordへDiscord通知送信eventを追記する。 */
export function appendStateHistoryNotificationEvents(
  existingSource: string,
  runId: string,
  notificationEvents: readonly StateHistoryNotificationEvent[],
): string {
  const records = [...parseStateHistoryRecords(existingSource)];
  const targetRecords = records.filter((record) => record.runId === runId);
  if (targetRecords.length !== 1) {
    throw new StateHistoryError("通知履歴を追記するrun IDが一意に定まりません");
  }
  const targetRecord = targetRecords[0];
  if (targetRecord == null) {
    throw new StateHistoryError("通知履歴を追記する履歴recordを取得できません");
  }
  const validatedEvents = notificationEvents.map((event) => {
    const result = notificationSentEventSchema.safeParse(event);
    if (!result.success) {
      throw StateFormatError.fromZodError("state history notification event", result.error);
    }
    return result.data;
  });
  const existingKeys = new Set(targetRecord.events.map((event) => historyEventKey(event)));
  const newKeys = new Set<string>();
  for (const event of validatedEvents) {
    const key = historyEventKey(event);
    if (existingKeys.has(key) || newKeys.has(key)) {
      throw new StateHistoryError("同じ通知送信eventが既に存在します");
    }
    if (event.sentAt < targetRecord.recordedAt) {
      throw new StateHistoryError("通知送信時刻が履歴recordの記録時刻より前です");
    }
    newKeys.add(key);
  }
  const updatedRecord = validateHistoryRecord({
    ...targetRecord,
    schemaVersion: STATE_HISTORY_SCHEMA_VERSION_6,
    events: [...targetRecord.events, ...validatedEvents].sort((left, right) =>
      compareStrings(historyEventKey(left), historyEventKey(right)),
    ),
  });
  const updatedRecords = records.map((record) => (record.runId === runId ? updatedRecord : record));
  return serializeStateHistoryRecords(updatedRecords);
}

/** JSON Lines文字列から日次履歴recordを検証して読み取る。 */
export function parseStateHistoryRecords(source: string): readonly StateHistoryRecord[] {
  if (source.length === 0) {
    throw new StateFormatError("state history", {
      cause: new TypeError("state historyが空です"),
    });
  }
  const lines = source.split("\n");
  if (lines.at(-1) === "") {
    lines.pop();
  }
  if (lines.length === 0 || lines.some((line) => line.length === 0)) {
    throw new StateFormatError("state history", {
      cause: new TypeError("空のJSON Lines recordがあります"),
    });
  }

  return Object.freeze(
    lines.map((line) => {
      let value: unknown;
      try {
        const parseJson: (text: string) => unknown = JSON.parse;
        value = parseJson(line);
      } catch (error: unknown) {
        throw new StateFormatError("state history", {
          cause: new SyntaxError("JSON Linesの構文が不正です", {
            cause: error,
          }),
        });
      }
      return parseVersionedStateHistoryRecord(value);
    }),
  );
}

/** 日次履歴recordを末尾改行付きcanonical JSON Linesへ変換する。 */
export function serializeStateHistoryRecords(records: readonly StateHistoryRecord[]): string {
  if (records.length === 0) {
    throw new StateHistoryError("保存する履歴recordがありません");
  }
  return records
    .map((record) => serializeCanonicalJsonLine(validateHistoryRecord(record)))
    .join("");
}

/** 既存の日次履歴へrun IDが一意なrecordを追加する。 */
export function appendStateHistoryRecord(
  existingSource: string | undefined,
  record: StateHistoryRecord,
): string {
  const records = existingSource == null ? [] : [...parseStateHistoryRecords(existingSource)];
  if (records.some((existing) => existing.runId === record.runId)) {
    throw new StateHistoryError("同じrun IDの履歴recordが既に存在します");
  }
  if (records.some((existing) => existing.date !== record.date)) {
    throw new StateHistoryError("日次履歴ファイルに異なる日付のrecordがあります");
  }
  records.push(validateHistoryRecord(record));
  return serializeStateHistoryRecords(records);
}

function applyHistoryEvent(
  projection: {
    responsibilities: Map<string, StateHistoryResponsibility>;
    edges: Map<string, StateHistoryEdge>;
    severities: Map<string, z.output<typeof severitySchema>>;
  },
  event: StateHistoryEvent,
): void {
  switch (event.kind) {
    case "responsibility_set":
      projection.responsibilities.set(event.nodeId, event.value);
      return;
    case "responsibility_removed":
      projection.responsibilities.delete(event.nodeId);
      return;
    case "severity_set":
      projection.severities.set(event.nodeId, event.value);
      return;
    case "severity_removed":
      projection.severities.delete(event.nodeId);
      return;
    case "edge_set":
      projection.edges.set(event.relationId, event.value);
      return;
    case "edge_removed":
      projection.edges.delete(event.relationId);
      return;
    case "repository_excluded":
      return;
  }
}

/** 履歴を指定日まで順に適用して状態を再構成する。 */
export function replayStateHistory(
  records: readonly StateHistoryRecord[],
  throughDate: string,
): ReplayedStateHistory {
  if (!isCalendarDate(throughDate)) {
    throw new StateHistoryError("再生終了日が不正です");
  }
  const duplicateRunIds = records.map((record) => record.runId);
  if (new Set(duplicateRunIds).size !== duplicateRunIds.length) {
    throw new StateHistoryError("履歴内でrun IDが重複しています");
  }
  const sortedRecords = records
    .map((record, index) => ({
      record: validateHistoryRecord(record),
      index,
    }))
    .sort((left, right) => {
      const dateComparison = compareStrings(left.record.date, right.record.date);
      if (dateComparison !== 0) {
        return dateComparison;
      }
      return left.index - right.index;
    });
  const projection = {
    responsibilities: new Map<string, StateHistoryResponsibility>(),
    edges: new Map<string, StateHistoryEdge>(),
    severities: new Map<string, z.output<typeof severitySchema>>(),
  };
  for (const { record } of sortedRecords) {
    if (record.date > throughDate) {
      break;
    }
    for (const event of record.events) {
      applyHistoryEvent(projection, event);
    }
  }
  return Object.freeze({
    responsibilities: new Map(projection.responsibilities),
    edges: new Map(projection.edges),
    severities: new Map(projection.severities),
  });
}

function createHistoryValue<T>(
  values: ReadonlyMap<string, T>,
  identifier: string,
): StateHistoryValue<T> {
  const value = values.get(identifier);
  if (value == null) {
    return Object.freeze({
      status: "absent",
    });
  }
  return Object.freeze({
    status: "present",
    value,
  });
}

function createDifferences<T>(
  before: ReadonlyMap<string, T>,
  after: ReadonlyMap<string, T>,
): readonly StateHistoryDifference<T>[] {
  const identifiers = [...new Set([...before.keys(), ...after.keys()])].sort(compareStrings);
  return Object.freeze(
    identifiers
      .filter((identifier) => {
        if (before.has(identifier) !== after.has(identifier)) {
          return true;
        }
        const beforeValue = before.get(identifier);
        const afterValue = after.get(identifier);
        if (beforeValue == null || afterValue == null) {
          throw new StateHistoryError("履歴差分の比較対象を取得できません");
        }
        return !valuesEqual(beforeValue, afterValue);
      })
      .map((identifier) =>
        Object.freeze({
          id: identifier,
          before: createHistoryValue(before, identifier),
          after: createHistoryValue(after, identifier),
        }),
      ),
  );
}

/** 履歴を二日分まで再生して責務・edge・severity差分を返す。 */
export function diffStateHistory(
  records: readonly StateHistoryRecord[],
  fromDate: string,
  toDate: string,
): StateHistoryDiff {
  if (!isCalendarDate(fromDate) || !isCalendarDate(toDate) || fromDate > toDate) {
    throw new StateHistoryError("比較する日付範囲が不正です");
  }
  const before = replayStateHistory(records, fromDate);
  const after = replayStateHistory(records, toDate);
  return Object.freeze({
    fromDate,
    toDate,
    responsibilities: createDifferences(before.responsibilities, after.responsibilities),
    edges: createDifferences(before.edges, after.edges),
    severities: createDifferences(before.severities, after.severities),
  });
}
