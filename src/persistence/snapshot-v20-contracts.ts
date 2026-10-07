import type { Sha256Hash } from "../canonical-json/index.js";
import type {
  TrackedItemAiAnalysis,
  TrackedItemAiAnalysisMigrationAdoptedElements,
} from "../domain/index.js";
import type { FinalGraphProjection } from "../graph/final-graph-projection.js";
import type {
  SnapshotCollectionItem,
  SnapshotTrackedItem,
  StateSnapshot as StateSnapshotVersion19,
} from "./snapshot-contracts.js";

type Version20AiAnalysis =
  | Omit<Extract<TrackedItemAiAnalysis, { origin: "current" }>, "retainedElements">
  | (Omit<
      Extract<TrackedItemAiAnalysis, { origin: "migration" }>,
      "adoptedElements" | "retainedElements"
    > &
      Readonly<{ adoptedElements: TrackedItemAiAnalysisMigrationAdoptedElements }>);

type Version20TrackedItem = Omit<SnapshotTrackedItem, "aiAnalysis"> &
  Readonly<{ aiAnalysis: Version20AiAnalysis }>;
type Version20CollectionItem = Omit<SnapshotCollectionItem, "aiAnalysis"> &
  Readonly<{ aiAnalysis: Version20AiAnalysis }>;

/** tracker-stateへ保存するschema version 20のsnapshot。 */
export type StateSnapshot = Omit<StateSnapshotVersion19, "schemaVersion" | "items" | "collection"> &
  Readonly<{
    schemaVersion: "20";
    items: readonly Version20TrackedItem[];
    collection: Readonly<{
      repositories: readonly (Omit<
        StateSnapshotVersion19["collection"]["repositories"][number],
        "items"
      > &
        Readonly<{ items: readonly Version20CollectionItem[] }>)[];
    }>;
    finalGraphProjection: FinalGraphProjection;
    finalGraphProjectionDigest: Sha256Hash;
  }>;
