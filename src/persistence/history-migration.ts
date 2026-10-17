import { z } from "zod";

import { createNotificationReason, notificationReasonSchema } from "../domain/index.js";
import { StateFormatError } from "./errors.js";
import type {
  StateHistoryNotificationEventVersion4,
  StateHistoryRecord,
  StateHistoryRecordVersion1,
  StateHistoryRecordVersion2,
  StateHistoryRecordVersion3,
  StateHistoryRecordVersion4,
  StateHistoryRecordVersion5,
  StateHistoryRecordVersion6,
  StateHistoryRecordVersion7,
  StateHistoryRecordVersionParser,
} from "./history-contracts.js";
import type { notificationReasonCodeSchema } from "./history-fields-schema.js";
import {
  STATE_HISTORY_SCHEMA_VERSION_1,
  STATE_HISTORY_SCHEMA_VERSION_2,
  STATE_HISTORY_SCHEMA_VERSION_3,
  STATE_HISTORY_SCHEMA_VERSION_4,
  STATE_HISTORY_SCHEMA_VERSION_5,
  STATE_HISTORY_SCHEMA_VERSION_6,
  STATE_HISTORY_SCHEMA_VERSION_7,
  historySchemaVersionSchema,
} from "./history-fields-schema.js";
import type { notificationSentEventVersion6Schema } from "./history-notification-schema.js";
import {
  historyRecordVersion1MigrationSchema,
  historyRecordVersion2Schema,
  historyRecordVersion3Schema,
  historyRecordVersion4Schema,
  historyRecordVersion5Schema,
  historyRecordVersion6Schema,
  historyRecordVersion7Schema,
} from "./history-record-schema.js";
import { migrateLegacyStatus } from "./legacy-enum.js";

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
): z.output<typeof notificationSentEventVersion6Schema> {
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
  return migrateStateHistoryRecordVersion7(
    parseStateHistoryRecordVersion7({
      ...record,
      schemaVersion: STATE_HISTORY_SCHEMA_VERSION_7,
      events: record.events.map((event) =>
        event.kind === "notification_sent"
          ? {
              ...event,
              personalReminders: [],
            }
          : event,
      ),
    }),
  );
}

function parseStateHistoryRecordVersion7(value: unknown): StateHistoryRecordVersion7 {
  const result = historyRecordVersion7Schema.safeParse(value);
  if (!result.success) {
    throw StateFormatError.fromZodError("state history", result.error);
  }
  return result.data;
}

function migrateStateHistoryRecordVersion7(record: StateHistoryRecordVersion7): StateHistoryRecord {
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
    [
      STATE_HISTORY_SCHEMA_VERSION_7,
      createStateHistoryRecordVersionParser(
        parseStateHistoryRecordVersion7,
        migrateStateHistoryRecordVersion7,
      ),
    ],
  ]);

export function parseVersionedStateHistoryRecord(value: unknown): StateHistoryRecord {
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

export function validateHistoryRecord(value: unknown): StateHistoryRecord {
  return migrateStateHistoryRecordVersion7(parseStateHistoryRecordVersion7(value));
}
