import { z } from "zod";

import { StateHistoryError } from "./errors.js";
import type {
  edgeSchema,
  inputEventSchema,
  responsibilitySchema,
  severitySchema,
} from "./history-fields-schema.js";
import type {
  notificationSentEventSchema,
  notificationSentEventVersion4Schema,
  notificationSentPersonalReminderSchema,
} from "./history-notification-schema.js";
import type {
  historyEventVersion3Schema,
  historyEventVersion4Schema,
  historyEventVersion5Schema,
  historyEventVersion6Schema,
  historyEventVersion7Schema,
  historyRecordVersion1MigrationSchema,
  historyRecordVersion2Schema,
  historyRecordVersion3Schema,
  historyRecordVersion4Schema,
  historyRecordVersion5Schema,
  historyRecordVersion6Schema,
  historyRecordVersion7Schema,
} from "./history-record-schema.js";
import type { StateSnapshot } from "./snapshot-contracts.js";

/** 日次履歴の生成に使うsnapshotの確定済み保存値。 */
export type StateHistorySnapshot = Pick<
  StateSnapshot,
  "run" | "generatedAt" | "items" | "relations" | "repositories"
>;

/** 履歴へ保存する責務状態。 */
export type StateHistoryResponsibility = z.output<typeof responsibilitySchema>;

/** 履歴へ保存するedge状態。 */
export type StateHistoryEdge = z.output<typeof edgeSchema>;

/** 日次履歴の一つの変更event。 */
export type StateHistoryEvent = z.output<typeof historyEventVersion7Schema>;

/** Discord通知送信を保存する履歴event。 */
export type StateHistoryNotificationEvent = z.output<typeof notificationSentEventSchema>;

/** Discord通知送信時の個人催促context。 */
export type StateHistoryNotificationPersonalReminder = z.output<
  typeof notificationSentPersonalReminderSchema
>;

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

export type StateHistoryRecordVersion1 = z.output<typeof historyRecordVersion1MigrationSchema>;
export type StateHistoryRecordVersion2 = z.output<typeof historyRecordVersion2Schema>;
export type StateHistoryRecordVersion3 = z.output<typeof historyRecordVersion3Schema>;
export type StateHistoryRecordVersion4 = z.output<typeof historyRecordVersion4Schema>;
export type StateHistoryRecordVersion5 = z.output<typeof historyRecordVersion5Schema>;
export type StateHistoryRecordVersion6 = z.output<typeof historyRecordVersion6Schema>;
export type StateHistoryRecordVersion7 = z.output<typeof historyRecordVersion7Schema>;
export type StateHistoryEventVersion3 = z.output<typeof historyEventVersion3Schema>;
export type StateHistoryEventVersion4 = z.output<typeof historyEventVersion4Schema>;
export type StateHistoryEventVersion5 = z.output<typeof historyEventVersion5Schema>;
export type StateHistoryEventVersion6 = z.output<typeof historyEventVersion6Schema>;
export type StateHistoryNotificationEventVersion4 = z.output<
  typeof notificationSentEventVersion4Schema
>;
export type StateHistoryRecordVersionParser = (value: unknown) => StateHistoryRecord;

/** 一つの完全runが生成したschema version 7の日次履歴record。 */
export type StateHistoryRecord = StateHistoryRecordVersion7;

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

export type StateHistoryProjection = Readonly<{
  responsibilities: ReadonlyMap<string, StateHistoryResponsibility>;
  edges: ReadonlyMap<string, StateHistoryEdge>;
  severities: ReadonlyMap<string, z.output<typeof severitySchema>>;
}>;

export function compareStrings(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}
