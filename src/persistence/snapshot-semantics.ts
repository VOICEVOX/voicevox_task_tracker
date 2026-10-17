import type {
  LegacyStateSnapshotFields,
  LegacyStateSnapshotFieldsWithoutAiDependencies,
  LegacyStateSnapshotFieldsWithPersonalReminder,
  LegacyStateSnapshotFieldsWithPersonalReminderVersion17,
  StateSnapshotFields,
} from "./snapshot-contracts.js";
import { assertSnapshotFieldsSemantics } from "./snapshot-field-semantics.js";
import { assertSnapshotGraphSemantics } from "./snapshot-graph-semantics.js";
import type { ElementSchemaVersion } from "./snapshot-schema.js";

/** snapshotの全意味規則を検証する。 */
export function assertSnapshotSemantics(
  snapshot:
    | StateSnapshotFields
    | LegacyStateSnapshotFieldsWithoutAiDependencies
    | LegacyStateSnapshotFields
    | LegacyStateSnapshotFieldsWithPersonalReminder
    | LegacyStateSnapshotFieldsWithPersonalReminderVersion17,
  elementSchemaVersion: ElementSchemaVersion,
  adoptedElementsFormat: "legacy" | "current",
  requireApplications: boolean,
  requireImplementsEndpointTypes: boolean,
): void {
  assertSnapshotFieldsSemantics(
    snapshot,
    elementSchemaVersion,
    adoptedElementsFormat,
    requireApplications,
  );
  assertSnapshotGraphSemantics(snapshot, requireImplementsEndpointTypes);
}
