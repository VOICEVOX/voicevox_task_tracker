import { z } from "zod";

import {
  dateSchema,
  dateTimeSchema,
  identifierSchema,
  inputEventsSchema,
  legacyNotificationReasonSchema,
  legacyStatusSchema,
  notificationWaitingOnRecordSchema,
  STATE_HISTORY_SCHEMA_VERSION_1,
  STATE_HISTORY_SCHEMA_VERSION_2,
  STATE_HISTORY_SCHEMA_VERSION_3,
  STATE_HISTORY_SCHEMA_VERSION_4,
  STATE_HISTORY_SCHEMA_VERSION_5,
  STATE_HISTORY_SCHEMA_VERSION_6,
  STATE_HISTORY_SCHEMA_VERSION_7,
  stateHistoryStateEventSchema,
} from "./history-fields-schema.js";
import {
  notificationSentEventCommonFieldsSchema,
  notificationSentEventSchema,
  notificationSentEventVersion3Schema,
  notificationSentEventVersion4Schema,
  notificationSentEventVersion6Schema,
} from "./history-notification-schema.js";
import { historyEventKey } from "./history-event-key.js";

export const historyEventVersion6Schema = z.discriminatedUnion("kind", [
  stateHistoryStateEventSchema.options[0],
  stateHistoryStateEventSchema.options[1],
  stateHistoryStateEventSchema.options[2],
  stateHistoryStateEventSchema.options[3],
  stateHistoryStateEventSchema.options[4],
  stateHistoryStateEventSchema.options[5],
  stateHistoryStateEventSchema.options[6],
  notificationSentEventVersion6Schema,
]);
export const historyEventVersion7Schema = z.discriminatedUnion("kind", [
  stateHistoryStateEventSchema.options[0],
  stateHistoryStateEventSchema.options[1],
  stateHistoryStateEventSchema.options[2],
  stateHistoryStateEventSchema.options[3],
  stateHistoryStateEventSchema.options[4],
  stateHistoryStateEventSchema.options[5],
  stateHistoryStateEventSchema.options[6],
  notificationSentEventSchema,
]);
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
export const historyEventVersion5Schema = z.discriminatedUnion("kind", [
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
export const historyEventVersion3Schema = z.discriminatedUnion("kind", [
  stateHistoryStateEventSchema.options[0],
  stateHistoryStateEventSchema.options[1],
  stateHistoryStateEventSchema.options[2],
  stateHistoryStateEventSchema.options[3],
  stateHistoryStateEventSchema.options[4],
  stateHistoryStateEventSchema.options[5],
  stateHistoryStateEventSchema.options[6],
  notificationSentEventVersion3Schema,
]);
export const historyEventVersion4Schema = z.discriminatedUnion("kind", [
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
export const historyRecordVersion1MigrationSchema = z.looseObject({
  schemaVersion: z.literal(STATE_HISTORY_SCHEMA_VERSION_1),
  events: z.array(historyRecordVersion1EventSchema),
});
export const historyRecordVersion2Schema = z
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
export const historyRecordVersion3Schema = z
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
export const historyRecordVersion4Schema = z
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
export const historyRecordVersion5Schema = z
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
export const historyRecordVersion6Schema = z
  .strictObject({
    schemaVersion: z.literal(STATE_HISTORY_SCHEMA_VERSION_6),
    date: dateSchema,
    runId: identifierSchema,
    recordedAt: dateTimeSchema,
    inputEvents: inputEventsSchema,
    events: z.array(historyEventVersion6Schema),
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
export const historyRecordVersion7Schema = z
  .strictObject({
    schemaVersion: z.literal(STATE_HISTORY_SCHEMA_VERSION_7),
    date: dateSchema,
    runId: identifierSchema,
    recordedAt: dateTimeSchema,
    inputEvents: inputEventsSchema,
    events: z.array(historyEventVersion7Schema),
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
