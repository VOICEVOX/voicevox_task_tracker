import { serializeCanonicalJson } from "../../../canonical-json/value.js";
import type {
  GitHubNodeId,
  GitHubRepositoryId,
  TrackedItemInputEvent,
} from "../../../domain/types.js";
import type {
  CurrentInputEvent,
  EvidenceUse,
  OwnedHistoricalInputEvent,
} from "../contracts/evidence-closure.js";
import { RunCompletenessError } from "./run-completeness-error.js";

function compareStrings(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

/** 前回入力イベントを取り出すsnapshotの最小投影。 */
export type HistoricalInputEventSnapshotInput = Readonly<{
  items: readonly Readonly<{
    nodeId: GitHubNodeId;
    repositoryId: GitHubRepositoryId;
    inputEvents: readonly TrackedItemInputEvent[];
  }>[];
}>;

/** 前回snapshotの入力イベントを保存位置と所有項目付きで取り出す。 */
export function collectOwnedHistoricalInputEvents(
  items: HistoricalInputEventSnapshotInput["items"],
): readonly OwnedHistoricalInputEvent[] {
  const records: OwnedHistoricalInputEvent[] = [];
  for (const [itemIndex, item] of items.entries()) {
    for (const [eventIndex, event] of item.inputEvents.entries()) {
      records.push(
        Object.freeze({
          owner: Object.freeze({ itemNodeId: item.nodeId, repositoryId: item.repositoryId }),
          path: Object.freeze(["items", itemIndex, "inputEvents", eventIndex] as const),
          event: Object.freeze({ sourceId: event.sourceId, url: event.url }),
        }),
      );
    }
  }
  return Object.freeze(
    records.sort((left, right) =>
      compareStrings(serializeCanonicalJson(left), serializeCanonicalJson(right)),
    ),
  );
}

/** 前回入力イベントをsource IDごとに索引化する。 */
export function indexHistoricalInputEvents(
  records: readonly OwnedHistoricalInputEvent[],
): ReadonlyMap<string, readonly OwnedHistoricalInputEvent[]> {
  const indexed = new Map<string, OwnedHistoricalInputEvent[]>();
  for (const record of records) {
    const entries = indexed.get(record.event.sourceId) ?? [];
    entries.push(record);
    indexed.set(record.event.sourceId, entries);
  }
  return new Map([...indexed].map(([sourceId, entries]) => [sourceId, Object.freeze(entries)]));
}

/** source利用位置から現在の入力イベントと所有項目を取り出す。 */
export function currentInputEventAtUse(
  use: EvidenceUse,
  items: readonly Readonly<{
    nodeId: GitHubNodeId;
    repositoryId: GitHubRepositoryId;
    inputEvents: readonly TrackedItemInputEvent[];
  }>[],
  container: "outward" | "snapshot",
): CurrentInputEvent | undefined {
  if (use.purpose !== "item_input_event") return undefined;
  const path = use.path;
  const itemIndex = path[container === "outward" ? 1 : 2];
  const eventIndex = path[4];
  const validPath =
    container === "outward"
      ? path[0] === "items" && path[2] === "item" && path[3] === "inputEvents"
      : path[0] === "snapshot" && path[1] === "items" && path[3] === "inputEvents";
  if (
    path.length !== 6 ||
    !validPath ||
    path[5] !== "sourceId" ||
    typeof itemIndex !== "number" ||
    typeof eventIndex !== "number"
  ) {
    throw new RunCompletenessError("invalid_reference", use.sourceId, path, use);
  }
  const item = items[itemIndex];
  const event = item?.inputEvents[eventIndex];
  if (
    item == null ||
    event == null ||
    use.destination.kind !== "item" ||
    use.destination.itemNodeId !== item.nodeId ||
    event.sourceId !== use.sourceId
  ) {
    throw new RunCompletenessError("invalid_reference", use.sourceId, path, use);
  }
  return Object.freeze({ itemNodeId: item.nodeId, repositoryId: item.repositoryId, event });
}
