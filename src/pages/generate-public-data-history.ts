import { createUtcIsoDateTime, type UtcIsoDateTime } from "../domain/index.js";
import {
  parseStateHistoryRecords,
  serializeStateHistoryRecords,
  type StateHistoryRecord,
  type StateHistoryResponsibility,
  type StateSnapshot,
} from "../persistence/index.js";
import { PublicDtoSemanticError } from "./errors.js";
import type { PublicItemHistoryEventDto } from "./public-dto-contracts.js";
import { compareStrings } from "./public-dto-primitives.js";

type ResponsibilityHistoryValue = Extract<
  PublicItemHistoryEventDto,
  Readonly<{ kind: "responsibility_changed" }>
>["before"];
export type PublicHistory = Readonly<{
  itemEventsByNodeId: ReadonlyMap<string, readonly PublicItemHistoryEventDto[]>;
}>;

function compareHistoryRecords(left: StateHistoryRecord, right: StateHistoryRecord): number {
  const recordedAtOrder = compareStrings(left.recordedAt, right.recordedAt);
  if (recordedAtOrder !== 0) {
    return recordedAtOrder;
  }
  return compareStrings(left.runId, right.runId);
}

/** 履歴レコードを検証して時刻順へ整列する。 */
export function validateHistoryRecords(
  records: readonly StateHistoryRecord[],
  generatedAt: string,
): readonly StateHistoryRecord[] {
  if (records.length === 0) {
    return Object.freeze([]);
  }
  const validated = parseStateHistoryRecords(serializeStateHistoryRecords(records));
  const runIds = validated.map((record) => record.runId);
  if (new Set(runIds).size !== runIds.length) {
    throw new PublicDtoSemanticError("history recordのrun IDが重複しています");
  }
  if (validated.some((record) => record.recordedAt > generatedAt)) {
    throw new PublicDtoSemanticError("snapshot生成後のhistory recordを公開できません");
  }
  return Object.freeze([...validated].sort(compareHistoryRecords));
}

/** 通知履歴を含む公開DTOの生成時刻を決める。 */
export function publicDtoGeneratedAt(
  records: readonly StateHistoryRecord[],
  snapshot: StateSnapshot,
): UtcIsoDateTime {
  let generatedAt = snapshot.generatedAt;
  for (const record of records) {
    for (const event of record.events) {
      if (event.kind !== "notification_sent") {
        continue;
      }
      if (record.runId !== snapshot.run.id) {
        if (event.sentAt > snapshot.generatedAt) {
          throw new PublicDtoSemanticError(
            "別runの通知送信時刻がsnapshot生成時刻より新しくなっています",
          );
        }
        continue;
      }
      if (event.sentAt > generatedAt) {
        generatedAt = createUtcIsoDateTime(event.sentAt);
      }
    }
  }
  return generatedAt;
}

function responsibilityHistoryValue(
  value: StateHistoryResponsibility | undefined,
): ResponsibilityHistoryValue {
  if (value == null) {
    return {
      state: "absent",
    };
  }
  return {
    state: "present",
    value: {
      status: value.status,
      waitingOn: value.waitingOn.map((waitingOn) => ({
        kind: waitingOn.kind,
        candidateId: waitingOn.candidateId,
        role: waitingOn.role,
      })),
    },
  };
}

function appendItemHistoryEvent(
  eventsByNodeId: Map<string, PublicItemHistoryEventDto[]>,
  nodeId: string,
  event: PublicItemHistoryEventDto,
): void {
  const events = eventsByNodeId.get(nodeId);
  if (events == null) {
    eventsByNodeId.set(nodeId, [event]);
    return;
  }
  events.push(event);
}

/** 責務履歴を公開項目の履歴へ写す。 */
export function createPublicHistory(records: readonly StateHistoryRecord[]): PublicHistory {
  const responsibilities = new Map<string, StateHistoryResponsibility>();
  const itemEventsByNodeId = new Map<string, PublicItemHistoryEventDto[]>();

  for (const record of records) {
    for (const event of record.events) {
      switch (event.kind) {
        case "responsibility_set": {
          const before = responsibilities.get(event.nodeId);
          const historyEvent: PublicItemHistoryEventDto = {
            kind: "responsibility_changed",
            recordedAt: record.recordedAt,
            before: responsibilityHistoryValue(before),
            after: responsibilityHistoryValue(event.value),
          };
          responsibilities.set(event.nodeId, event.value);
          appendItemHistoryEvent(itemEventsByNodeId, event.nodeId, historyEvent);
          break;
        }
        case "responsibility_removed": {
          const before = responsibilities.get(event.nodeId);
          if (before == null) {
            throw new PublicDtoSemanticError(
              `責務履歴の削除対象がありません。node ID: ${event.nodeId}`,
            );
          }
          const historyEvent: PublicItemHistoryEventDto = {
            kind: "responsibility_changed",
            recordedAt: record.recordedAt,
            before: responsibilityHistoryValue(before),
            after: responsibilityHistoryValue(undefined),
          };
          responsibilities.delete(event.nodeId);
          appendItemHistoryEvent(itemEventsByNodeId, event.nodeId, historyEvent);
          break;
        }
        case "severity_set":
        case "severity_removed":
        case "edge_set":
        case "edge_removed": {
          break;
        }
        case "repository_excluded": {
          break;
        }
        case "notification_sent": {
          break;
        }
      }
    }
  }

  return Object.freeze({
    itemEventsByNodeId: new Map(
      [...itemEventsByNodeId.entries()].map(([nodeId, events]) => [
        nodeId,
        Object.freeze([...events]),
      ]),
    ),
  });
}
