import { z } from "zod";

import { serializeCanonicalJsonLine } from "../canonical-json/index.js";

export const OPERATIONS_ALERT_LEDGER_SCHEMA_VERSION_1 = "1";
export const OPERATIONS_ALERT_LEDGER_SCHEMA_VERSION_2 = "2";
export const OPERATIONS_ALERT_LEDGER_STATE_PATH_V1 = "state/operations-alert-ledger-v1.json";
const nonEmptyStringSchema = z.string().min(1).max(1000);
const dateTimeSchema = z.iso
  .datetime({ offset: true })
  .transform((value) => new Date(value).toISOString());
const operationsAlertEntrySchema = z.strictObject({
  alertKey: nonEmptyStringSchema,
  incidentId: nonEmptyStringSchema,
  kind: z.enum(["collection", "pages", "discord", "workflow_infrastructure_failure"]),
  occurredAt: dateTimeSchema,
  sentAt: dateTimeSchema,
  discordMessageId: nonEmptyStringSchema,
});
const deliveryReservationSchema = z.strictObject({
  alertKey: nonEmptyStringSchema,
  incidentId: nonEmptyStringSchema,
  kind: operationsAlertEntrySchema.shape.kind,
  occurredAt: dateTimeSchema,
  startedAt: dateTimeSchema,
});
const operationsAlertLedgerVersion1Schema = z
  .strictObject({
    schemaVersion: z.literal(OPERATIONS_ALERT_LEDGER_SCHEMA_VERSION_1),
    operationsAlerts: z.array(operationsAlertEntrySchema),
  })
  .superRefine((ledger, context) => {
    const keys = ledger.operationsAlerts.map((entry) => entry.alertKey);
    if (new Set(keys).size !== keys.length) {
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
  });
const operationsAlertLedgerVersion2Schema = z
  .strictObject({
    schemaVersion: z.literal(OPERATIONS_ALERT_LEDGER_SCHEMA_VERSION_2),
    operationsAlerts: z.array(operationsAlertEntrySchema),
    deliveryReservations: z.array(deliveryReservationSchema),
  })
  .superRefine((ledger, context) => {
    const keys = [
      ...ledger.operationsAlerts.map((entry) => entry.alertKey),
      ...ledger.deliveryReservations.map((entry) => entry.alertKey),
    ];
    if (new Set(keys).size !== keys.length) {
      context.addIssue({
        code: "custom",
        path: ["deliveryReservations"],
        message: "運用障害通知のalertKeyが重複しています",
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
    for (const [index, entry] of ledger.deliveryReservations.entries()) {
      if (entry.startedAt < entry.occurredAt) {
        context.addIssue({
          code: "custom",
          path: ["deliveryReservations", index, "startedAt"],
          message: "運用障害通知の開始時刻は発生時刻以後にしてください",
        });
      }
    }
  });

/** Discord HTTPより前に専用ledgerへ保存する送信予約。 */
export type StateOperationsAlertReservation = z.output<typeof deliveryReservationSchema>;

/** 通常通知と独立して保存する運用障害通知ledger。 */
export type StateOperationsAlertLedger = Readonly<{
  schemaVersion: "2";
  operationsAlerts: readonly z.output<typeof operationsAlertEntrySchema>[];
  deliveryReservations: readonly StateOperationsAlertReservation[];
}>;

/** 運用障害通知ledgerを現行形式へ検証して正規化する。 */
export function createStateOperationsAlertLedger(value: unknown): StateOperationsAlertLedger {
  const version = z.object({ schemaVersion: z.string() }).parse(value).schemaVersion;
  const ledger =
    version === OPERATIONS_ALERT_LEDGER_SCHEMA_VERSION_1
      ? { ...operationsAlertLedgerVersion1Schema.parse(value), deliveryReservations: [] }
      : operationsAlertLedgerVersion2Schema.parse(value);
  operationsAlertLedgerVersion2Schema.parse({
    ...ledger,
    schemaVersion: OPERATIONS_ALERT_LEDGER_SCHEMA_VERSION_2,
  });
  return Object.freeze({
    schemaVersion: OPERATIONS_ALERT_LEDGER_SCHEMA_VERSION_2,
    operationsAlerts: Object.freeze(
      [...ledger.operationsAlerts].sort((left, right) =>
        left.alertKey.localeCompare(right.alertKey),
      ),
    ),
    deliveryReservations: Object.freeze(
      [...ledger.deliveryReservations].sort((left, right) =>
        left.alertKey.localeCompare(right.alertKey),
      ),
    ),
  });
}

/** 運用障害通知ledgerをcanonical JSONへ変換する。 */
export function serializeStateOperationsAlertLedger(ledger: StateOperationsAlertLedger): string {
  return serializeCanonicalJsonLine(createStateOperationsAlertLedger(ledger));
}

/** 運用障害通知ledgerを専用state fileから読む。 */
export function parseStateOperationsAlertLedger(source: string): StateOperationsAlertLedger {
  const value: unknown = JSON.parse(source);
  return createStateOperationsAlertLedger(value);
}

/** 旧版を含む専用ledgerの保存byte列がcanonicalであることを確認する。 */
export function isCanonicalStateOperationsAlertLedgerSource(source: string): boolean {
  const value: unknown = JSON.parse(source);
  const ledger = createStateOperationsAlertLedger(value);
  const version = z.object({ schemaVersion: z.string() }).parse(value).schemaVersion;
  return version === OPERATIONS_ALERT_LEDGER_SCHEMA_VERSION_1
    ? source ===
        serializeCanonicalJsonLine({
          schemaVersion: OPERATIONS_ALERT_LEDGER_SCHEMA_VERSION_1,
          operationsAlerts: ledger.operationsAlerts,
        })
    : source === serializeStateOperationsAlertLedger(ledger);
}
