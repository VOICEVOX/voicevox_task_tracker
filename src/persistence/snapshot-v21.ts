import { Ajv2020 } from "ajv/dist/2020.js";
import { z } from "zod";

import currentSnapshotSchema from "../../schemas/snapshot-v23.schema.json" with { type: "json" };
import snapshotSchema from "../../schemas/snapshot-v21.schema.json" with { type: "json" };
import { serializeCanonicalJsonLine, type Sha256Hash } from "../canonical-json/index.js";
import {
  AI_ANALYSIS_ELEMENT_INPUT_PROJECTION_VERSIONS,
  AI_ANALYSIS_ELEMENT_REVISIONS,
} from "../codex/generic-ai-definition.js";
import { AI_ANALYSIS_ELEMENTS } from "../domain/ai-analysis-elements.js";
import type {
  Evidence,
  GraphNodeId,
  SourceId,
  TrackedItem,
  TrackedItemAiAnalysis,
  TrackedItemState,
} from "../domain/index.js";
import type { FinalGraphProjection } from "../graph/final-graph-projection.js";
import { StateFormatError, StateSnapshotSchemaError } from "./errors.js";
import type {
  SnapshotCollectionItem,
  SnapshotTrackedItem,
  StateSnapshot as StateSnapshotVersion19,
} from "./snapshot-contracts.js";
import {
  assertPersonalReminderEvidenceClosure as assertVersion19PersonalReminderEvidenceClosure,
  assertPersonalReminderEvidenceRecordsClosure as assertVersion19PersonalReminderEvidenceRecordsClosure,
} from "./snapshot-evidence-closure.js";
import { assertFinalGraphProjectionSemantics } from "./snapshot-final-graph-validation.js";
import type { StateSnapshot as StateSnapshotVersion20 } from "./snapshot-v20-contracts.js";
import { createStateSnapshot as createVersion20Snapshot } from "./snapshot-v20.js";
import { createStateSnapshot as createVersion19Snapshot } from "./snapshot.js";

/** tracker-stateへ保存するschema version 21のcurrent snapshot。 */
export type StateSnapshot = Omit<StateSnapshotVersion19, "schemaVersion"> &
  Readonly<{
    schemaVersion: "21";
    finalGraphProjection: FinalGraphProjection;
    finalGraphProjectionDigest: Sha256Hash;
  }>;

const snapshotVersionSchema = z.object({ schemaVersion: z.literal("21") });
const ajv = new Ajv2020({
  allErrors: true,
  coerceTypes: false,
  removeAdditional: false,
  strict: true,
  useDefaults: false,
});
ajv.addFormat("date-time", {
  type: "string",
  validate: (value: string) => {
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(value)) {
      return false;
    }
    return !Number.isNaN(Date.parse(value));
  },
});
const validateLegacySnapshotSchema = ajv.compile<StateSnapshot>(snapshotSchema);
const validateSnapshotSchema = ajv.compile<StateSnapshot>({
  ...snapshotSchema,
  $id: `${snapshotSchema.$id}/current-ai`,
  $defs: {
    ...snapshotSchema.$defs,
    trackedItemAiAnalysis: currentSnapshotSchema.$defs.trackedItemAiAnalysis,
  },
});

/** 現行snapshotから旧版の共通保存値を取り出す。 */
export function version19SnapshotFields(snapshot: StateSnapshot): StateSnapshotVersion19 {
  return createVersion19Snapshot(projectVersion19SnapshotFields(snapshot));
}

function projectVersion19SnapshotFields(snapshot: StateSnapshot): Omit<
  StateSnapshotVersion19,
  "items" | "collection"
> &
  Readonly<{
    items: readonly ReturnType<typeof legacyAiAnalysisItem<SnapshotTrackedItem>>[];
    collection: Readonly<{
      repositories: readonly (Omit<
        StateSnapshotVersion19["collection"]["repositories"][number],
        "items"
      > &
        Readonly<{
          items: readonly ReturnType<typeof legacyAiAnalysisItem<SnapshotCollectionItem>>[];
        }>)[];
    }>;
  }> {
  const { finalGraphProjection, finalGraphProjectionDigest, items, collection, ...fields } =
    snapshot;
  void finalGraphProjection;
  void finalGraphProjectionDigest;
  return {
    ...fields,
    schemaVersion: "19",
    items: items.map(legacyAiAnalysisItem),
    collection: {
      repositories: collection.repositories.map((repository) => ({
        ...repository,
        items: repository.items.map(legacyAiAnalysisItem),
      })),
    },
  };
}

function legacyAiAnalysisItem<Item extends Pick<TrackedItem, "aiAnalysis">>(
  item: Item,
): Omit<Item, "aiAnalysis"> &
  Readonly<{ aiAnalysis: Omit<TrackedItemAiAnalysis, "retainedElements"> }> {
  const { retainedElements, adoptedElements, ...analysis } = item.aiAnalysis;
  return {
    ...item,
    aiAnalysis: {
      ...analysis,
      adoptedElements: { ...retainedElements, ...adoptedElements },
    },
  };
}

function assertCurrentAiElements(snapshot: StateSnapshot): void {
  for (const item of [
    ...snapshot.items,
    ...snapshot.collection.repositories.flatMap((repository) => repository.items),
  ]) {
    for (const element of AI_ANALYSIS_ELEMENTS) {
      const application = item.aiAnalysis.applications[element];
      const current = item.aiAnalysis.adoptedElements[element];
      const retained = item.aiAnalysis.retainedElements[element];
      if (current != null && retained != null) {
        throw new StateSnapshotSchemaError(1);
      }
      if (application.status === "current_ai" ? current == null : current != null) {
        throw new StateSnapshotSchemaError(1);
      }
      if (
        application.status === "current_ai" &&
        (current?.reuseProof.status !== "verified" ||
          current.reuseProof.revision !== AI_ANALYSIS_ELEMENT_REVISIONS[element] ||
          current.reuseProof.inputProjectionVersion !==
            AI_ANALYSIS_ELEMENT_INPUT_PROJECTION_VERSIONS[element])
      ) {
        throw new StateSnapshotSchemaError(1);
      }
    }
  }
}

function splitAiAnalysis(
  analysis: StateSnapshotVersion20["items"][number]["aiAnalysis"],
): TrackedItemAiAnalysis {
  let adoptedElements: TrackedItemAiAnalysis["adoptedElements"] = {};
  let retainedElements: TrackedItemAiAnalysis["retainedElements"] = {};
  for (const element of AI_ANALYSIS_ELEMENTS) {
    const adopted = analysis.adoptedElements[element];
    if (adopted == null) {
      continue;
    }
    if (analysis.applications[element].status === "current_ai") {
      if (adopted.origin !== "current") {
        throw new StateSnapshotSchemaError(1);
      }
      adoptedElements = { ...adoptedElements, [element]: adopted };
    } else {
      retainedElements = { ...retainedElements, [element]: adopted };
    }
  }
  return Object.freeze({
    ...analysis,
    adoptedElements: Object.freeze(adoptedElements),
    retainedElements: Object.freeze(retainedElements),
  });
}

function splitTrackedItem(item: StateSnapshotVersion20["items"][number]): SnapshotTrackedItem {
  if (
    item.status === "terminal_merged" ||
    item.status === "terminal_completed" ||
    item.status === "terminal_not_planned"
  ) {
    if (item.waitingOn.length !== 0) {
      throw new StateSnapshotSchemaError(1);
    }
    const waitingOn: readonly [] = [];
    return Object.freeze({
      ...item,
      status: item.status,
      waitingOn: Object.freeze(waitingOn),
      aiAnalysis: splitAiAnalysis(item.aiAnalysis),
    });
  }
  return Object.freeze({
    ...item,
    status: item.status,
    waitingOn: item.waitingOn,
    aiAnalysis: splitAiAnalysis(item.aiAnalysis),
  });
}

function splitCollectionItem(
  item: StateSnapshotVersion20["collection"]["repositories"][number]["items"][number],
): SnapshotCollectionItem {
  if (item.state === "closed") {
    if (item.terminalAt == null) {
      throw new StateSnapshotSchemaError(1);
    }
    return Object.freeze({
      ...item,
      state: "closed",
      terminalAt: item.terminalAt,
      aiAnalysis: splitAiAnalysis(item.aiAnalysis),
    });
  }
  return Object.freeze({
    ...item,
    state: "open",
    terminalAt: null,
    aiAnalysis: splitAiAnalysis(item.aiAnalysis),
  });
}

/** 未検証の値をschema検証済みの現行snapshotへ変換する。 */
export function createStateSnapshot(value: unknown): StateSnapshot {
  return createSnapshot(value, "current");
}

/** 旧保存形式のAI証明を当時のschemaで検証する。 */
export function createLegacyStateSnapshot(value: unknown): StateSnapshot {
  return createSnapshot(value, "legacy");
}

function createSnapshot(value: unknown, proofVersion: "current" | "legacy"): StateSnapshot {
  snapshotVersionSchema.parse(value);
  const validate =
    proofVersion === "current" ? validateSnapshotSchema : validateLegacySnapshotSchema;
  if (!validate(value)) {
    throw new StateSnapshotSchemaError(validate.errors?.length ?? 1);
  }
  if (proofVersion === "current") assertCurrentAiElements(value);
  const base = createVersion20Snapshot({
    ...projectVersion19SnapshotFields(value),
    schemaVersion: "20",
    finalGraphProjection: value.finalGraphProjection,
    finalGraphProjectionDigest: value.finalGraphProjectionDigest,
  });
  const snapshot = Object.freeze({
    ...base,
    schemaVersion: "21",
    items: Object.freeze(base.items.map(splitTrackedItem)),
    collection: Object.freeze({
      repositories: Object.freeze(
        base.collection.repositories.map((repository) =>
          Object.freeze({
            ...repository,
            items: Object.freeze(repository.items.map(splitCollectionItem)),
          }),
        ),
      ),
    }),
  } satisfies StateSnapshot);
  assertFinalGraphProjectionSemantics(snapshot);
  return snapshot;
}

/** 現行snapshotを末尾改行付きcanonical JSONへ変換する。 */
export function serializeStateSnapshot(snapshot: StateSnapshot): string {
  return serializeCanonicalJsonLine(createLegacyStateSnapshot(snapshot));
}

/** canonical JSONから現行snapshotを検証して読み取る。 */
export function parseStateSnapshot(source: string): StateSnapshot {
  let value: unknown;
  try {
    const parseJson: (text: string) => unknown = JSON.parse;
    value = parseJson(source);
  } catch (error: unknown) {
    throw new StateFormatError("snapshot", { cause: error });
  }
  return createLegacyStateSnapshot(value);
}

/** 保存済み公開投影に含まれるeffective graph状態を返す。 */
export function snapshotEffectiveGraphStateByNodeId(
  snapshot: StateSnapshot,
): ReadonlyMap<GraphNodeId, TrackedItemState> {
  const nodeIdByValue = new Map<string, GraphNodeId>([
    ...snapshot.items.map((item): [string, GraphNodeId] => [item.nodeId, item.nodeId]),
    ...snapshot.externalReferences.map((reference): [string, GraphNodeId] => [
      reference.nodeId,
      reference.nodeId,
    ]),
  ]);
  const states = new Map<GraphNodeId, TrackedItemState>();
  for (const node of snapshot.finalGraphProjection.nodes) {
    const nodeId = nodeIdByValue.get(node.nodeId);
    if (nodeId == null) {
      throw new StateSnapshotSchemaError(1);
    }
    states.set(nodeId, node.effectiveState);
  }
  return states;
}

/** personal reminderのEvidence参照が現行snapshot内で閉じていることを検証する。 */
export function assertPersonalReminderEvidenceClosure(snapshot: StateSnapshot): void {
  assertVersion19PersonalReminderEvidenceClosure(version19SnapshotFields(snapshot));
}

/** personal reminderのEvidence recordを現行snapshot内で照合する。 */
export function assertPersonalReminderEvidenceRecordsClosure(
  snapshot: StateSnapshot,
  expectedEvidenceBySourceId: ReadonlyMap<SourceId, readonly Evidence[]>,
): void {
  assertVersion19PersonalReminderEvidenceRecordsClosure(
    version19SnapshotFields(snapshot),
    expectedEvidenceBySourceId,
  );
}
