import { z } from "zod";
import { validateNotificationLedger } from "./notification-ledger-validation.js";

import { serializeCanonicalJsonLine } from "../canonical-json/index.js";
import {
  notificationDeliveryAttemptSchema,
  notificationManualResolutionSchema,
} from "../domain/notification-delivery-attempt.js";
import { pendingNotificationSchema } from "../domain/pending-notification.js";
import { StateFormatError } from "./errors.js";
import {
  type LegacyNotificationReasonCode,
  migrateLegacyNotificationReasonCode,
} from "./legacy-enum.js";
import { compareStateKeys } from "./state-key-order.js";
export {
  createStateOperationsAlertLedger,
  isCanonicalStateOperationsAlertLedgerSource,
  OPERATIONS_ALERT_LEDGER_SCHEMA_VERSION_1,
  OPERATIONS_ALERT_LEDGER_SCHEMA_VERSION_2,
  OPERATIONS_ALERT_LEDGER_STATE_PATH_V1,
  parseStateOperationsAlertLedger,
  serializeStateOperationsAlertLedger,
  type StateOperationsAlertLedger,
  type StateOperationsAlertReservation,
} from "./operations-alert-ledger.js";
export {
  createStateRunReport,
  serializeStateRunReport,
  type StateRunReport,
} from "./state-run-report.js";

const NOTIFICATION_LEDGER_SCHEMA_VERSION_1 = "1";
export const NOTIFICATION_LEDGER_SCHEMA_VERSION_2 = "2";
export const NOTIFICATION_LEDGER_SCHEMA_VERSION_3 = "3";
export const NOTIFICATION_LEDGER_SCHEMA_VERSION_4 = "4";
export const NOTIFICATION_LEDGER_SCHEMA_VERSION_5 = "5";
export const NOTIFICATION_LEDGER_SCHEMA_VERSION_6 = "6";
export const NOTIFICATION_LEDGER_SCHEMA_VERSION_7 = "7";
export const NOTIFICATION_LEDGER_SCHEMA_VERSION_8 = "8";
export const NOTIFICATION_LEDGER_SCHEMA_VERSION_9 = "9";
export const NOTIFICATION_LEDGER_SCHEMA_VERSION_10 = "10";

const nonEmptyStringSchema = z.string().min(1).max(1000);
const deliveryIdSchema = z.string().regex(/^discord-digest:v1:[0-9a-f]{24}:message:[1-9][0-9]*$/u);
const dateTimeSchema = z.iso
  .datetime({
    offset: true,
    error: "タイムゾーンを含むISO 8601日時を指定してください",
  })
  .transform((value) => new Date(value).toISOString());
const severitySchema = z.enum(["none", "watch", "urgent", "critical"]);
const legacyNotificationReasonCodeSchema: z.ZodType<LegacyNotificationReasonCode> = z.enum([
  "none",
  "triage_overdue",
  "review_overdue",
  "author_overdue",
  "owner_unknown",
  "blocker_overdue",
  "newly_unblocked",
  "dependency_cycle",
  "responsibility_changed",
  "ready_to_merge_overdue",
  "automation_stuck",
]);
export const NOTIFICATION_LEDGER_REASON_CODE_VALUES = [
  "none",
  "assessment_overdue",
  "owner_overdue",
  "decision_overdue",
  "review_overdue",
  "revision_overdue",
  "reply_overdue",
  "work_overdue",
  "owner_unknown",
  "blocker_overdue",
  "newly_unblocked",
  "dependency_cycle",
  "responsibility_changed",
  "merge_overdue",
  "automation_stuck",
] as const;
const notificationReasonCodeSchema = z.enum(NOTIFICATION_LEDGER_REASON_CODE_VALUES);
const operationsAlertKindSchema = z.enum([
  "collection",
  "pages",
  "discord",
  "workflow_infrastructure_failure",
]);

const ledgerEntryBaseSchema = z.strictObject({
  notificationKey: nonEmptyStringSchema,
  itemNodeId: nonEmptyStringSchema,
  reasonCode: notificationReasonCodeSchema,
  severity: severitySchema,
  reservedAt: dateTimeSchema,
  cooldownUntil: dateTimeSchema,
});
const reservedLedgerEntrySchema = ledgerEntryBaseSchema.extend({
  status: z.literal("reserved"),
  expiresAt: dateTimeSchema,
});
const sentLedgerEntrySchema = ledgerEntryBaseSchema.extend({
  status: z.literal("sent"),
  sentAt: dateTimeSchema,
  discordMessageId: nonEmptyStringSchema,
});
const dismissedLedgerEntrySchema = ledgerEntryBaseSchema.extend({
  status: z.literal("dismissed"),
  dismissedAt: dateTimeSchema,
});
const ledgerEntrySchema = z.discriminatedUnion("status", [
  reservedLedgerEntrySchema,
  sentLedgerEntrySchema,
]);
const ledgerEntryVersion3Schema = z.discriminatedUnion("status", [
  reservedLedgerEntrySchema,
  sentLedgerEntrySchema,
  dismissedLedgerEntrySchema,
]);
const ledgerEntryVersion4BaseSchema = z.strictObject({
  notificationKey: nonEmptyStringSchema,
  itemNodeId: nonEmptyStringSchema,
  reasonCode: notificationReasonCodeSchema,
  severity: severitySchema,
  reservedAt: dateTimeSchema,
});
const reservedLedgerEntryVersion4Schema = ledgerEntryVersion4BaseSchema.extend({
  status: z.literal("reserved"),
  expiresAt: dateTimeSchema,
});
const sentLedgerEntryVersion4Schema = ledgerEntryVersion4BaseSchema.extend({
  status: z.literal("sent"),
  sentAt: dateTimeSchema,
  discordMessageId: nonEmptyStringSchema,
});
const dismissedLedgerEntryVersion4Schema = ledgerEntryVersion4BaseSchema.extend({
  status: z.literal("dismissed"),
  dismissedAt: dateTimeSchema,
});
const ledgerEntryVersion4Schema = z.discriminatedUnion("status", [
  reservedLedgerEntryVersion4Schema,
  sentLedgerEntryVersion4Schema,
  dismissedLedgerEntryVersion4Schema,
]);
const acknowledgedLedgerEntryVersion5Schema = ledgerEntryVersion4BaseSchema.extend({
  status: z.literal("acknowledged"),
  acknowledgedAt: dateTimeSchema,
});
const ledgerEntryVersion5Schema = z.discriminatedUnion("status", [
  reservedLedgerEntryVersion4Schema,
  sentLedgerEntryVersion4Schema,
  acknowledgedLedgerEntryVersion5Schema,
]);
const deliveryStartedLedgerEntryVersion7Schema = ledgerEntryVersion4BaseSchema.extend({
  status: z.literal("delivery_started"),
  deliveryId: deliveryIdSchema,
  startedAt: dateTimeSchema,
});
const ledgerEntryVersion7Schema = z.discriminatedUnion("status", [
  reservedLedgerEntryVersion4Schema,
  sentLedgerEntryVersion4Schema,
  acknowledgedLedgerEntryVersion5Schema,
  deliveryStartedLedgerEntryVersion7Schema,
]);
const ledgerEntryVersion10BaseSchema = ledgerEntryVersion4BaseSchema.extend({
  lastDeliveryAttempt: notificationDeliveryAttemptSchema.optional(),
  manualResolution: notificationManualResolutionSchema.optional(),
});
const ledgerEntryVersion10Schema = z.discriminatedUnion("status", [
  ledgerEntryVersion10BaseSchema.extend({
    status: z.literal("reserved"),
    expiresAt: dateTimeSchema,
  }),
  ledgerEntryVersion10BaseSchema.extend({
    status: z.literal("delivery_started"),
    deliveryId: deliveryIdSchema,
    startedAt: dateTimeSchema,
  }),
  ledgerEntryVersion10BaseSchema.extend({
    status: z.literal("sent"),
    sentAt: dateTimeSchema,
    discordMessageId: nonEmptyStringSchema,
  }),
  ledgerEntryVersion10BaseSchema.extend({
    status: z.literal("acknowledged"),
    acknowledgedAt: dateTimeSchema,
  }),
]);
const legacyPendingNotificationSchema = pendingNotificationSchema.superRefine(
  (notification, context) => {
    if (notification.target.kind === "personal_reminder") {
      context.addIssue({
        code: "custom",
        path: ["target", "kind"],
        message: "このnotification ledger schema versionではpersonal_reminderを指定できません",
      });
    }
  },
);
const operationsAlertEntrySchema = z.strictObject({
  alertKey: nonEmptyStringSchema,
  incidentId: nonEmptyStringSchema,
  kind: operationsAlertKindSchema,
  occurredAt: dateTimeSchema,
  sentAt: dateTimeSchema,
  discordMessageId: nonEmptyStringSchema,
});
const notificationLedgerSchemaVersionSchema = z.object({
  schemaVersion: z.string().min(1),
});
const notificationLedgerVersion1MigrationSchema = z.looseObject({
  schemaVersion: z.literal(NOTIFICATION_LEDGER_SCHEMA_VERSION_1),
  entries: z.array(
    z.looseObject({
      reasonCode: legacyNotificationReasonCodeSchema,
    }),
  ),
});
const notificationLedgerVersion2Schema = z
  .strictObject({
    schemaVersion: z.literal(NOTIFICATION_LEDGER_SCHEMA_VERSION_2),
    entries: z.array(ledgerEntrySchema),
    operationsAlerts: z.array(operationsAlertEntrySchema),
  })
  .superRefine((ledger, context) => {
    const keys = ledger.entries.map((entry) => entry.notificationKey);
    if (new Set(keys).size !== keys.length) {
      context.addIssue({
        code: "custom",
        path: ["entries"],
        message: "notificationKeyが重複しています",
      });
    }
    const alertKeys = ledger.operationsAlerts.map((entry) => entry.alertKey);
    if (new Set(alertKeys).size !== alertKeys.length) {
      context.addIssue({
        code: "custom",
        path: ["operationsAlerts"],
        message: "運用障害通知のalertKeyが重複しています",
      });
    }
    for (const [index, entry] of ledger.operationsAlerts.entries()) {
      if (entry.sentAt < entry.occurredAt) {
        context.addIssue({
          code: "custom",
          path: ["operationsAlerts", index, "sentAt"],
          message: "送信時刻は障害発生時刻以後にしてください",
        });
      }
    }
    for (const [index, entry] of ledger.entries.entries()) {
      if (entry.cooldownUntil < entry.reservedAt) {
        context.addIssue({
          code: "custom",
          path: ["entries", index, "cooldownUntil"],
          message: "cooldown終了時刻は予約時刻以後にしてください",
        });
      }
      if (entry.status === "reserved" && entry.expiresAt < entry.reservedAt) {
        context.addIssue({
          code: "custom",
          path: ["entries", index, "expiresAt"],
          message: "予約期限は予約時刻以後にしてください",
        });
      }
      if (entry.status === "sent" && entry.sentAt < entry.reservedAt) {
        context.addIssue({
          code: "custom",
          path: ["entries", index, "sentAt"],
          message: "送信時刻は予約時刻以後にしてください",
        });
      }
    }
  });
const notificationLedgerVersion3Schema = z
  .strictObject({
    schemaVersion: z.literal(NOTIFICATION_LEDGER_SCHEMA_VERSION_3),
    entries: z.array(ledgerEntryVersion3Schema),
    operationsAlerts: z.array(operationsAlertEntrySchema),
  })
  .superRefine((ledger, context) => {
    const keys = ledger.entries.map((entry) => entry.notificationKey);
    if (new Set(keys).size !== keys.length) {
      context.addIssue({
        code: "custom",
        path: ["entries"],
        message: "notificationKeyが重複しています",
      });
    }
    const alertKeys = ledger.operationsAlerts.map((entry) => entry.alertKey);
    if (new Set(alertKeys).size !== alertKeys.length) {
      context.addIssue({
        code: "custom",
        path: ["operationsAlerts"],
        message: "運用障害通知のalertKeyが重複しています",
      });
    }
    for (const [index, entry] of ledger.operationsAlerts.entries()) {
      if (entry.sentAt < entry.occurredAt) {
        context.addIssue({
          code: "custom",
          path: ["operationsAlerts", index, "sentAt"],
          message: "送信時刻は障害発生時刻以後にしてください",
        });
      }
    }
    for (const [index, entry] of ledger.entries.entries()) {
      if (entry.cooldownUntil < entry.reservedAt) {
        context.addIssue({
          code: "custom",
          path: ["entries", index, "cooldownUntil"],
          message: "cooldown終了時刻は予約時刻以後にしてください",
        });
      }
      if (entry.status === "reserved" && entry.expiresAt < entry.reservedAt) {
        context.addIssue({
          code: "custom",
          path: ["entries", index, "expiresAt"],
          message: "予約期限は予約時刻以後にしてください",
        });
      }
      if (entry.status === "sent" && entry.sentAt < entry.reservedAt) {
        context.addIssue({
          code: "custom",
          path: ["entries", index, "sentAt"],
          message: "送信時刻は予約時刻以後にしてください",
        });
      }
      if (entry.status === "dismissed" && entry.dismissedAt < entry.reservedAt) {
        context.addIssue({
          code: "custom",
          path: ["entries", index, "dismissedAt"],
          message: "抑制時刻は予約時刻以後にしてください",
        });
      }
    }
  });
const notificationLedgerVersion4Schema = z
  .strictObject({
    schemaVersion: z.literal(NOTIFICATION_LEDGER_SCHEMA_VERSION_4),
    entries: z.array(ledgerEntryVersion4Schema),
    operationsAlerts: z.array(operationsAlertEntrySchema),
  })
  .superRefine((ledger, context) => {
    const keys = ledger.entries.map((entry) => entry.notificationKey);
    if (new Set(keys).size !== keys.length) {
      context.addIssue({
        code: "custom",
        path: ["entries"],
        message: "notificationKeyが重複しています",
      });
    }
    const alertKeys = ledger.operationsAlerts.map((entry) => entry.alertKey);
    if (new Set(alertKeys).size !== alertKeys.length) {
      context.addIssue({
        code: "custom",
        path: ["operationsAlerts"],
        message: "運用障害通知のalertKeyが重複しています",
      });
    }
    for (const [index, entry] of ledger.operationsAlerts.entries()) {
      if (entry.sentAt < entry.occurredAt) {
        context.addIssue({
          code: "custom",
          path: ["operationsAlerts", index, "sentAt"],
          message: "送信時刻は障害発生時刻以後にしてください",
        });
      }
    }
    for (const [index, entry] of ledger.entries.entries()) {
      if (entry.status === "reserved" && entry.expiresAt < entry.reservedAt) {
        context.addIssue({
          code: "custom",
          path: ["entries", index, "expiresAt"],
          message: "予約期限は予約時刻以後にしてください",
        });
      }
      if (entry.status === "sent" && entry.sentAt < entry.reservedAt) {
        context.addIssue({
          code: "custom",
          path: ["entries", index, "sentAt"],
          message: "送信時刻は予約時刻以後にしてください",
        });
      }
      if (entry.status === "dismissed" && entry.dismissedAt < entry.reservedAt) {
        context.addIssue({
          code: "custom",
          path: ["entries", index, "dismissedAt"],
          message: "抑制時刻は予約時刻以後にしてください",
        });
      }
    }
  });
const notificationLedgerVersion5Schema = z
  .strictObject({
    schemaVersion: z.literal(NOTIFICATION_LEDGER_SCHEMA_VERSION_5),
    entries: z.array(ledgerEntryVersion5Schema),
    operationsAlerts: z.array(operationsAlertEntrySchema),
  })
  .superRefine((ledger, context) => {
    const keys = ledger.entries.map((entry) => entry.notificationKey);
    if (new Set(keys).size !== keys.length) {
      context.addIssue({
        code: "custom",
        path: ["entries"],
        message: "notificationKeyが重複しています",
      });
    }
    const alertKeys = ledger.operationsAlerts.map((entry) => entry.alertKey);
    if (new Set(alertKeys).size !== alertKeys.length) {
      context.addIssue({
        code: "custom",
        path: ["operationsAlerts"],
        message: "運用障害通知のalertKeyが重複しています",
      });
    }
    for (const [index, entry] of ledger.operationsAlerts.entries()) {
      if (entry.sentAt < entry.occurredAt) {
        context.addIssue({
          code: "custom",
          path: ["operationsAlerts", index, "sentAt"],
          message: "送信時刻は障害発生時刻以後にしてください",
        });
      }
    }
    for (const [index, entry] of ledger.entries.entries()) {
      if (entry.status === "reserved" && entry.expiresAt < entry.reservedAt) {
        context.addIssue({
          code: "custom",
          path: ["entries", index, "expiresAt"],
          message: "予約期限は予約時刻以後にしてください",
        });
      }
      if (entry.status === "sent" && entry.sentAt < entry.reservedAt) {
        context.addIssue({
          code: "custom",
          path: ["entries", index, "sentAt"],
          message: "送信時刻は予約時刻以後にしてください",
        });
      }
      if (entry.status === "acknowledged" && entry.acknowledgedAt < entry.reservedAt) {
        context.addIssue({
          code: "custom",
          path: ["entries", index, "acknowledgedAt"],
          message: "確認時刻は予約時刻以後にしてください",
        });
      }
    }
  });
const notificationLedgerVersion6Schema = z
  .strictObject({
    schemaVersion: z.literal(NOTIFICATION_LEDGER_SCHEMA_VERSION_6),
    entries: z.array(ledgerEntryVersion5Schema),
    operationsAlerts: z.array(operationsAlertEntrySchema),
    pendingNotifications: z.array(legacyPendingNotificationSchema),
  })
  .superRefine((ledger, context) => {
    const keys = ledger.entries.map((entry) => entry.notificationKey);
    if (new Set(keys).size !== keys.length) {
      context.addIssue({
        code: "custom",
        path: ["entries"],
        message: "notificationKeyが重複しています",
      });
    }
    const alertKeys = ledger.operationsAlerts.map((entry) => entry.alertKey);
    if (new Set(alertKeys).size !== alertKeys.length) {
      context.addIssue({
        code: "custom",
        path: ["operationsAlerts"],
        message: "alertKeyが重複しています",
      });
    }
    for (const [index, entry] of ledger.operationsAlerts.entries()) {
      if (entry.sentAt < entry.occurredAt) {
        context.addIssue({
          code: "custom",
          path: ["operationsAlerts", index, "sentAt"],
          message: "運用障害通知の送信時刻は発生時刻以後にしてください",
        });
      }
    }
    for (const [index, entry] of ledger.entries.entries()) {
      if (entry.status === "reserved" && entry.expiresAt < entry.reservedAt) {
        context.addIssue({
          code: "custom",
          path: ["entries", index, "expiresAt"],
          message: "予約期限は予約時刻以後にしてください",
        });
      }
      if (entry.status === "sent" && entry.sentAt < entry.reservedAt) {
        context.addIssue({
          code: "custom",
          path: ["entries", index, "sentAt"],
          message: "送信時刻は予約時刻以後にしてください",
        });
      }
      if (entry.status === "acknowledged" && entry.acknowledgedAt < entry.reservedAt) {
        context.addIssue({
          code: "custom",
          path: ["entries", index, "acknowledgedAt"],
          message: "確認時刻は予約時刻以後にしてください",
        });
      }
    }
    const pendingKeys = new Set<string>();
    const itemReasonKeys = new Set<string>();
    const cycleKeys = new Set<string>();
    for (const [index, notification] of ledger.pendingNotifications.entries()) {
      if (pendingKeys.has(notification.notificationKey)) {
        context.addIssue({
          code: "custom",
          path: ["pendingNotifications", index, "notificationKey"],
          message: "送信待ち通知のnotificationKeyが重複しています",
        });
      }
      pendingKeys.add(notification.notificationKey);
      const itemReasonKey = JSON.stringify([
        notification.itemNodeId,
        notification.reason.reasonCode,
      ]);
      if (notification.target.kind === "cycle") {
        const cycleKey = JSON.stringify([
          notification.itemNodeId,
          notification.reason.reasonCode,
          notification.target.cycleId,
        ]);
        if (cycleKeys.has(cycleKey)) {
          context.addIssue({
            code: "custom",
            path: ["pendingNotifications", index],
            message: "同じ項目、理由、cycleの送信待ち通知が重複しています",
          });
        }
        cycleKeys.add(cycleKey);
      } else if (itemReasonKeys.has(itemReasonKey)) {
        context.addIssue({
          code: "custom",
          path: ["pendingNotifications", index],
          message: "同じ項目と理由の送信待ち通知が重複しています",
        });
      } else {
        itemReasonKeys.add(itemReasonKey);
      }
    }
  });
const notificationLedgerVersion7Schema = z
  .strictObject({
    schemaVersion: z.literal(NOTIFICATION_LEDGER_SCHEMA_VERSION_7),
    entries: z.array(ledgerEntryVersion7Schema),
    operationsAlerts: z.array(operationsAlertEntrySchema),
    pendingNotifications: z.array(legacyPendingNotificationSchema),
  })
  .superRefine(validateNotificationLedger);
const notificationLedgerVersion8Schema = z
  .strictObject({
    schemaVersion: z.literal(NOTIFICATION_LEDGER_SCHEMA_VERSION_8),
    entries: z.array(ledgerEntryVersion7Schema),
    operationsAlerts: z.array(operationsAlertEntrySchema),
    pendingNotifications: z.array(pendingNotificationSchema),
  })
  .superRefine(validateNotificationLedger);
const notificationLedgerVersion9Schema = z
  .strictObject({
    schemaVersion: z.literal(NOTIFICATION_LEDGER_SCHEMA_VERSION_9),
    entries: z.array(ledgerEntryVersion7Schema),
    pendingNotifications: z.array(pendingNotificationSchema),
  })
  .superRefine((ledger, context) => {
    validateNotificationLedger({ ...ledger, operationsAlerts: [] }, context);
  });
const combinedNotificationLedgerVersion9Schema = z
  .strictObject({
    schemaVersion: z.literal(NOTIFICATION_LEDGER_SCHEMA_VERSION_9),
    entries: z.array(ledgerEntryVersion7Schema),
    operationsAlerts: z.array(operationsAlertEntrySchema),
    pendingNotifications: z.array(pendingNotificationSchema),
  })
  .superRefine(validateNotificationLedger);
const notificationLedgerVersion10Schema = z
  .strictObject({
    schemaVersion: z.literal(NOTIFICATION_LEDGER_SCHEMA_VERSION_10),
    entries: z.array(ledgerEntryVersion10Schema),
    pendingNotifications: z.array(pendingNotificationSchema),
  })
  .superRefine((ledger, context) => {
    validateNotificationLedger({ ...ledger, operationsAlerts: [] }, context);
  });
const combinedNotificationLedgerVersion10Schema = z
  .strictObject({
    schemaVersion: z.literal(NOTIFICATION_LEDGER_SCHEMA_VERSION_10),
    entries: z.array(ledgerEntryVersion10Schema),
    operationsAlerts: z.array(operationsAlertEntrySchema),
    pendingNotifications: z.array(pendingNotificationSchema),
  })
  .superRefine(validateNotificationLedger);
type StateNotificationLedgerVersion1 = z.output<typeof notificationLedgerVersion1MigrationSchema>;
type StateNotificationLedgerVersion2 = z.output<typeof notificationLedgerVersion2Schema>;
type StateNotificationLedgerVersion3 = z.output<typeof notificationLedgerVersion3Schema>;
type StateNotificationLedgerVersion4 = z.output<typeof notificationLedgerVersion4Schema>;
type StateNotificationLedgerVersion5 = z.output<typeof notificationLedgerVersion5Schema>;
type StateNotificationLedgerVersion6 = z.output<typeof notificationLedgerVersion6Schema>;
type StateNotificationLedgerVersion7 = z.output<typeof notificationLedgerVersion7Schema>;
type StateNotificationLedgerVersion8 = z.output<typeof notificationLedgerVersion8Schema>;
type StateNotificationLedgerVersion10 = z.output<typeof combinedNotificationLedgerVersion10Schema>;
type StateNotificationLedgerVersionParser = (value: unknown) => StateNotificationLedger;

/** 通常通知の予約、送信開始、送信結果、確認済みledger entry、送信待ち通知、送信済み運用障害を保持するledger。 */
export type StateNotificationLedger = StateNotificationLedgerVersion10;
function createFormatError(kind: string, error: z.ZodError): StateFormatError {
  return StateFormatError.fromZodError(kind, error);
}

function parseStateNotificationLedgerVersion1(value: unknown): StateNotificationLedgerVersion1 {
  const result = notificationLedgerVersion1MigrationSchema.safeParse(value);
  if (!result.success) {
    throw createFormatError("notification ledger", result.error);
  }
  return result.data;
}

function migrateStateNotificationLedgerVersion1(
  ledger: StateNotificationLedgerVersion1,
): StateNotificationLedger {
  return migrateStateNotificationLedgerVersion2(
    parseStateNotificationLedgerVersion2({
      ...ledger,
      schemaVersion: NOTIFICATION_LEDGER_SCHEMA_VERSION_2,
      entries: ledger.entries.map((entry) => ({
        ...entry,
        reasonCode: migrateLegacyNotificationReasonCode(entry.reasonCode),
      })),
      operationsAlerts: [],
    }),
  );
}

function parseStateNotificationLedgerVersion2(value: unknown): StateNotificationLedgerVersion2 {
  const result = notificationLedgerVersion2Schema.safeParse(value);
  if (!result.success) {
    throw createFormatError("notification ledger", result.error);
  }
  return result.data;
}

function migrateStateNotificationLedgerVersion2(
  ledger: StateNotificationLedgerVersion2,
): StateNotificationLedger {
  return migrateStateNotificationLedgerVersion3({
    schemaVersion: NOTIFICATION_LEDGER_SCHEMA_VERSION_3,
    entries: ledger.entries,
    operationsAlerts: ledger.operationsAlerts,
  });
}

function parseStateNotificationLedgerVersion3(value: unknown): StateNotificationLedgerVersion3 {
  const result = notificationLedgerVersion3Schema.safeParse(value);
  if (!result.success) {
    throw createFormatError("notification ledger", result.error);
  }
  return result.data;
}

function migrateStateNotificationLedgerVersion3(
  ledger: StateNotificationLedgerVersion3,
): StateNotificationLedger {
  return migrateStateNotificationLedgerVersion4(
    parseStateNotificationLedgerVersion4({
      schemaVersion: NOTIFICATION_LEDGER_SCHEMA_VERSION_4,
      entries: ledger.entries.map((entry) => {
        const { cooldownUntil, ...entryWithoutCooldownUntil } = entry;
        void cooldownUntil;
        return entryWithoutCooldownUntil;
      }),
      operationsAlerts: ledger.operationsAlerts,
    }),
  );
}

function parseStateNotificationLedgerVersion4(value: unknown): StateNotificationLedgerVersion4 {
  const result = notificationLedgerVersion4Schema.safeParse(value);
  if (!result.success) {
    throw createFormatError("notification ledger", result.error);
  }
  return result.data;
}

function migrateStateNotificationLedgerVersion4(
  ledger: StateNotificationLedgerVersion4,
): StateNotificationLedger {
  return migrateStateNotificationLedgerVersion5(
    parseStateNotificationLedgerVersion5({
      schemaVersion: NOTIFICATION_LEDGER_SCHEMA_VERSION_5,
      entries: ledger.entries.map((entry) => {
        if (entry.status !== "dismissed") {
          return entry;
        }
        return {
          notificationKey: entry.notificationKey,
          itemNodeId: entry.itemNodeId,
          reasonCode: entry.reasonCode,
          severity: entry.severity,
          reservedAt: entry.reservedAt,
          status: "acknowledged",
          acknowledgedAt: entry.dismissedAt,
        };
      }),
      operationsAlerts: ledger.operationsAlerts,
    }),
  );
}

function parseStateNotificationLedgerVersion5(value: unknown): StateNotificationLedgerVersion5 {
  const result = notificationLedgerVersion5Schema.safeParse(value);
  if (!result.success) {
    throw createFormatError("notification ledger", result.error);
  }
  return result.data;
}

function migrateStateNotificationLedgerVersion5(
  ledger: StateNotificationLedgerVersion5,
): StateNotificationLedger {
  return migrateStateNotificationLedgerVersion6(
    parseStateNotificationLedgerVersion6({
      schemaVersion: NOTIFICATION_LEDGER_SCHEMA_VERSION_6,
      entries: ledger.entries,
      operationsAlerts: ledger.operationsAlerts,
      pendingNotifications: [],
    }),
  );
}

function parseStateNotificationLedgerVersion6(value: unknown): StateNotificationLedgerVersion6 {
  const result = notificationLedgerVersion6Schema.safeParse(value);
  if (!result.success) {
    throw createFormatError("notification ledger", result.error);
  }
  return result.data;
}

function parseStateNotificationLedgerVersion7(value: unknown): StateNotificationLedgerVersion7 {
  const result = notificationLedgerVersion7Schema.safeParse(value);
  if (!result.success) {
    throw createFormatError("notification ledger", result.error);
  }
  return result.data;
}

function parseStateNotificationLedgerVersion8(value: unknown): StateNotificationLedgerVersion8 {
  const result = notificationLedgerVersion8Schema.safeParse(value);
  if (!result.success) {
    throw createFormatError("notification ledger", result.error);
  }
  return result.data;
}

function migrateStateNotificationLedgerVersion6(
  ledger: StateNotificationLedgerVersion6,
): StateNotificationLedger {
  return migrateStateNotificationLedgerVersion7(
    parseStateNotificationLedgerVersion7({
      schemaVersion: NOTIFICATION_LEDGER_SCHEMA_VERSION_7,
      entries: ledger.entries,
      operationsAlerts: ledger.operationsAlerts,
      pendingNotifications: ledger.pendingNotifications,
    }),
  );
}

function migrateStateNotificationLedgerVersion7(
  ledger: StateNotificationLedgerVersion7,
): StateNotificationLedger {
  return normalizeStateNotificationLedger(
    parseStateNotificationLedgerVersion8({
      schemaVersion: NOTIFICATION_LEDGER_SCHEMA_VERSION_8,
      entries: ledger.entries,
      operationsAlerts: ledger.operationsAlerts,
      pendingNotifications: ledger.pendingNotifications,
    }),
  );
}

function normalizeStateNotificationLedger(
  ledger: Pick<
    StateNotificationLedgerVersion10,
    "entries" | "operationsAlerts" | "pendingNotifications"
  >,
): StateNotificationLedger {
  return {
    schemaVersion: NOTIFICATION_LEDGER_SCHEMA_VERSION_10,
    entries: [...ledger.entries].sort((left, right) =>
      compareStateKeys(left.notificationKey, right.notificationKey),
    ),
    operationsAlerts: [...ledger.operationsAlerts].sort((left, right) =>
      compareStateKeys(left.alertKey, right.alertKey),
    ),
    pendingNotifications: [...ledger.pendingNotifications].sort((left, right) =>
      compareStateKeys(left.notificationKey, right.notificationKey),
    ),
  };
}

function createStateNotificationLedgerVersionParser<TVersion>(
  parser: (value: unknown) => TVersion,
  migration: (ledger: TVersion) => StateNotificationLedger,
): StateNotificationLedgerVersionParser {
  return (value) => migration(parser(value));
}

const stateNotificationLedgerVersionParsers: ReadonlyMap<
  string,
  StateNotificationLedgerVersionParser
> = new Map([
  [
    NOTIFICATION_LEDGER_SCHEMA_VERSION_1,
    createStateNotificationLedgerVersionParser(
      parseStateNotificationLedgerVersion1,
      migrateStateNotificationLedgerVersion1,
    ),
  ],
  [
    NOTIFICATION_LEDGER_SCHEMA_VERSION_2,
    createStateNotificationLedgerVersionParser(
      parseStateNotificationLedgerVersion2,
      migrateStateNotificationLedgerVersion2,
    ),
  ],
  [
    NOTIFICATION_LEDGER_SCHEMA_VERSION_3,
    createStateNotificationLedgerVersionParser(
      parseStateNotificationLedgerVersion3,
      migrateStateNotificationLedgerVersion3,
    ),
  ],
  [
    NOTIFICATION_LEDGER_SCHEMA_VERSION_4,
    createStateNotificationLedgerVersionParser(
      parseStateNotificationLedgerVersion4,
      migrateStateNotificationLedgerVersion4,
    ),
  ],
  [
    NOTIFICATION_LEDGER_SCHEMA_VERSION_5,
    createStateNotificationLedgerVersionParser(
      parseStateNotificationLedgerVersion5,
      migrateStateNotificationLedgerVersion5,
    ),
  ],
  [
    NOTIFICATION_LEDGER_SCHEMA_VERSION_6,
    createStateNotificationLedgerVersionParser(
      parseStateNotificationLedgerVersion6,
      migrateStateNotificationLedgerVersion6,
    ),
  ],
  [
    NOTIFICATION_LEDGER_SCHEMA_VERSION_7,
    createStateNotificationLedgerVersionParser(
      parseStateNotificationLedgerVersion7,
      migrateStateNotificationLedgerVersion7,
    ),
  ],
  [
    NOTIFICATION_LEDGER_SCHEMA_VERSION_8,
    createStateNotificationLedgerVersionParser(
      parseStateNotificationLedgerVersion8,
      normalizeStateNotificationLedger,
    ),
  ],
  [
    NOTIFICATION_LEDGER_SCHEMA_VERSION_9,
    createStateNotificationLedgerVersionParser(
      (value) => combinedNotificationLedgerVersion9Schema.parse(value),
      normalizeStateNotificationLedger,
    ),
  ],
  [
    NOTIFICATION_LEDGER_SCHEMA_VERSION_10,
    createStateNotificationLedgerVersionParser(
      (value) => combinedNotificationLedgerVersion10Schema.parse(value),
      normalizeStateNotificationLedger,
    ),
  ],
]);

function parseVersionedStateNotificationLedger(value: unknown): StateNotificationLedger {
  const versionResult = notificationLedgerSchemaVersionSchema.safeParse(value);
  if (!versionResult.success) {
    throw createFormatError("notification ledger", versionResult.error);
  }
  const parser = stateNotificationLedgerVersionParsers.get(versionResult.data.schemaVersion);
  if (parser == null) {
    throw new StateFormatError("notification ledger", {
      cause: new TypeError("notification ledgerのschemaVersionは未対応です"),
    });
  }
  return parser(value);
}

/** 未検証の値をnotification ledgerへ変換する。 */
export function createStateNotificationLedger(value: unknown): StateNotificationLedger {
  return parseVersionedStateNotificationLedger(value);
}

/** 初回bootstrap用の空notification ledgerを生成する。 */
export function createEmptyStateNotificationLedger(): StateNotificationLedger {
  return {
    schemaVersion: NOTIFICATION_LEDGER_SCHEMA_VERSION_10,
    entries: [],
    operationsAlerts: [],
    pendingNotifications: [],
  };
}

/** notification ledgerを末尾改行付きcanonical JSONへ変換する。 */
export function serializeStateNotificationLedger(ledger: StateNotificationLedger): string {
  const validated = createStateNotificationLedger(ledger);
  return serializeCanonicalJsonLine(
    notificationLedgerVersion10Schema.parse({
      schemaVersion: NOTIFICATION_LEDGER_SCHEMA_VERSION_10,
      entries: validated.entries,
      pendingNotifications: validated.pendingNotifications,
    }),
  );
}

/** JSONからnotification ledgerを検証して読み取る。 */
export function parseStateNotificationLedger(source: string): StateNotificationLedger {
  let value: unknown;
  try {
    const parseJson: (text: string) => unknown = JSON.parse;
    value = parseJson(source);
  } catch (error: unknown) {
    throw new StateFormatError("notification ledger", {
      cause: new SyntaxError("JSON構文が不正です", {
        cause: error,
      }),
    });
  }
  const version = notificationLedgerSchemaVersionSchema.parse(value);
  if (version.schemaVersion === NOTIFICATION_LEDGER_SCHEMA_VERSION_10) {
    return createStateNotificationLedger({
      ...notificationLedgerVersion10Schema.parse(value),
      operationsAlerts: [],
    });
  }
  if (version.schemaVersion === NOTIFICATION_LEDGER_SCHEMA_VERSION_9) {
    return createStateNotificationLedger({
      ...notificationLedgerVersion9Schema.parse(value),
      operationsAlerts: [],
    });
  }
  return parseVersionedStateNotificationLedger(value);
}

/** marker付き旧ledgerのcanonical sourceとdigest対象を入口で検証する。 */
export function parseRunTransactionNotificationLedger(source: string): Readonly<{
  ledger: StateNotificationLedger;
  legacyDigestValue?: z.output<typeof notificationLedgerVersion9Schema>;
}> {
  const ledger = parseStateNotificationLedger(source);
  if (source === serializeStateNotificationLedger(ledger)) {
    return Object.freeze({ ledger });
  }
  const parseJson: (text: string) => unknown = JSON.parse;
  const legacy = notificationLedgerVersion9Schema.parse(parseJson(source));
  if (source !== serializeCanonicalJsonLine(legacy)) {
    throw new StateFormatError("notification ledger", {
      cause: new TypeError("marker付きstateの通常ledgerがcanonical JSONではありません"),
    });
  }
  return Object.freeze({ ledger, legacyDigestValue: legacy });
}
