import type { StateSnapshot as StateSnapshotVersion19 } from "./snapshot-contracts.js";
import { projectSnapshotFinalGraph } from "./snapshot-final-graph-projection.js";
import { createStateSnapshot } from "./snapshot-v20.js";
import type { StateSnapshot } from "./snapshot-v20-contracts.js";

/** 旧snapshotの保存値だけから公開投影を確定し、現行形式へ移行する。 */
export function migrateVersion19FinalGraphProjection(
  snapshot: StateSnapshotVersion19,
  timezone: string,
): StateSnapshot {
  return createStateSnapshot({
    ...snapshot,
    schemaVersion: "20",
    ...projectSnapshotFinalGraph(snapshot, timezone),
  });
}
