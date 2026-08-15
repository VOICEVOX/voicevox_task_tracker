import { z } from "zod";

import { createUtcIsoDateTime, type SourceId, type UtcIsoDateTime } from "../domain/index.js";
import { assertNonNullable } from "../util/index.js";
import {
  parseRelationTextReferences,
  type RelationTextReference,
} from "./extract-relation-candidates.js";

/** relation本文の編集履歴を取得した状態。 */
export type RelationMutationHistory =
  | Readonly<{
      availability: "available";
      edits: readonly RelationMutationEdit[];
    }>
  | Readonly<{
      availability: "unavailable";
      reason: "connection_unavailable";
    }>;

/** relation本文の編集後スナップショット。 */
export type RelationMutationEdit = Readonly<{
  sourceId: SourceId;
  sequence: number;
  createdAt: UtcIsoDateTime;
  editedAt: UtcIsoDateTime;
  deletedAt: UtcIsoDateTime | null;
  diff: string | null;
}>;

/** relation mutation抽出の入力。currentMarkdownは現在値を表す。 */
export type RelationMutationInput = Readonly<{
  contentSourceId: SourceId;
  contentCreatedAt: UtcIsoDateTime | null;
  currentMarkdown: string;
  history: RelationMutationHistory;
}>;

/** relationの追加または削除を表す時刻付きmutation。 */
export type RelationMutation = Readonly<{
  relation: RelationTextReference;
  action: "added" | "removed";
  editedAt: UtcIsoDateTime;
  sourceId: SourceId;
  contentSourceId: SourceId;
  sequence: number;
}>;

/** relation mutationから復元した確定状態区間。 */
export type RelationMutationInterval =
  | Readonly<{
      status: "active";
      relation: RelationTextReference;
      addedAt: UtcIsoDateTime;
      addedSourceIds: readonly [SourceId, ...SourceId[]];
      lastConfirmedAt: UtcIsoDateTime;
    }>
  | Readonly<{
      status: "removed";
      relation: RelationTextReference;
      addedAt: UtcIsoDateTime;
      addedSourceIds: readonly [SourceId, ...SourceId[]];
      removedAt: UtcIsoDateTime;
      removedSourceIds: readonly [SourceId, ...SourceId[]];
    }>;

/** relation時刻の確実性。unknownではintervalを確定値として扱ってはならない。 */
export type RelationMutationTemporalKnowledge =
  | Readonly<{
      status: "exact";
      intervals: readonly RelationMutationInterval[];
    }>
  | Readonly<{
      status: "unknown";
      reason: "history_incomplete" | "current_mismatch" | "preexisting_relation";
    }>;

type RelationMutationUnknownReason =
  | "connection_unavailable"
  | "current_markdown_reference_definition"
  | "diff_null"
  | "deleted_edit"
  | "unsupported_diff_format"
  | "markdown_reference_definition"
  | "repository_public_boundary_unverified";

type RelationMutationUnknownBase = Readonly<{
  status: "unknown";
  contentSourceId: SourceId;
  reason: RelationMutationUnknownReason;
}>;

type RelationMutationUnknownEdit =
  | Readonly<{
      status: "available";
      sourceId: SourceId;
      editedAt: UtcIsoDateTime;
      sequence: number;
    }>
  | Readonly<{
      status: "unavailable";
    }>;

/** relation mutationを復元できなかった診断。raw diffは含めない。 */
export type RelationMutationUnknown = RelationMutationUnknownBase &
  Readonly<{
    edit: RelationMutationUnknownEdit;
  }>;

type RelationMutationAvailableExactResult = Readonly<{
  status: "available";
  contentSourceId: SourceId;
  currentReferences: readonly RelationTextReference[];
  replayedReferences: readonly RelationTextReference[];
  consistency: "consistent";
  temporalKnowledge: Readonly<{
    status: "exact";
    intervals: readonly RelationMutationInterval[];
  }>;
  mutations: readonly RelationMutation[];
  unmatchedRemovals: readonly RelationMutation[];
}>;

type RelationMutationAvailableUnknownTemporalResult = Readonly<{
  status: "available";
  contentSourceId: SourceId;
  currentReferences: readonly RelationTextReference[];
  replayedReferences: readonly RelationTextReference[];
  consistency: "consistent" | "history_incomplete" | "mismatch";
  temporalKnowledge: Readonly<{
    status: "unknown";
    reason: "history_incomplete" | "current_mismatch" | "preexisting_relation";
  }>;
  mutations: readonly RelationMutation[];
  unmatchedRemovals: readonly RelationMutation[];
}>;

/** relation mutationの復元結果。時刻unknownの結果は確定intervalを持たない。 */
export type RelationMutationResult =
  | RelationMutationAvailableExactResult
  | RelationMutationAvailableUnknownTemporalResult
  | RelationMutationUnknown;

const sourceIdSchema = z.string().min(3);
const utcIsoDateTimeSchema = z.iso.datetime({ offset: true });
const relationTextReferenceSchema = z
  .object({
    repositoryOwner: z.string().min(1),
    repositoryName: z.string().min(1),
    itemType: z.enum(["issue", "pull_request"]).nullable(),
    number: z.number().int().positive(),
  })
  .strict();
const relationMutationEditSchema = z
  .object({
    sourceId: sourceIdSchema,
    sequence: z.number().int().nonnegative(),
    createdAt: utcIsoDateTimeSchema,
    editedAt: utcIsoDateTimeSchema,
    deletedAt: utcIsoDateTimeSchema.nullable(),
    diff: z.string().nullable(),
  })
  .strict();
const relationMutationHistorySchema = z.discriminatedUnion("availability", [
  z
    .object({
      availability: z.literal("available"),
      edits: z.array(relationMutationEditSchema),
    })
    .strict(),
  z
    .object({
      availability: z.literal("unavailable"),
      reason: z.literal("connection_unavailable"),
    })
    .strict(),
]);
const relationMutationInputSchema = z
  .object({
    contentSourceId: sourceIdSchema,
    contentCreatedAt: utcIsoDateTimeSchema.nullable(),
    currentMarkdown: z.string(),
    history: relationMutationHistorySchema,
  })
  .strict();

interface MutableActiveInterval {
  status: "active";
  relation: RelationTextReference;
  addedAt: UtcIsoDateTime;
  addedSourceIds: Set<SourceId>;
  lastConfirmedAt: UtcIsoDateTime;
}

interface MutableRemovedInterval {
  status: "removed";
  relation: RelationTextReference;
  addedAt: UtcIsoDateTime;
  addedSourceIds: Set<SourceId>;
  removedAt: UtcIsoDateTime;
  removedSourceIds: Set<SourceId>;
}

interface MutableRelation {
  relation: RelationTextReference;
  intervals: (MutableActiveInterval | MutableRemovedInterval)[];
}

interface ParsedSnapshot {
  edit: RelationMutationEdit;
  references: readonly RelationTextReference[];
}

interface SnapshotTransition {
  snapshot: ParsedSnapshot;
  mutations: readonly RelationMutation[];
}

function compareStrings(left: string, right: string): -1 | 0 | 1 {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function compareNumbers(left: number, right: number): -1 | 0 | 1 {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function compareReferenceKeys(
  left: RelationTextReference,
  right: RelationTextReference,
): -1 | 0 | 1 {
  return compareStrings(
    createRelationMutationReferenceKey(left),
    createRelationMutationReferenceKey(right),
  );
}

/** relation mutation参照のcanonical keyを生成する。 */
export function createRelationMutationReferenceKey(reference: RelationTextReference): string {
  return `${reference.repositoryOwner.toLowerCase()}/${reference.repositoryName.toLowerCase()}#${reference.number.toString()}`;
}

function compareEditPosition(
  left: Pick<RelationMutationEdit, "editedAt" | "sequence" | "sourceId">,
  right: Pick<RelationMutationEdit, "editedAt" | "sequence" | "sourceId">,
): -1 | 0 | 1 {
  const editedAtOrder = compareStrings(left.editedAt, right.editedAt);
  if (editedAtOrder !== 0) {
    return editedAtOrder;
  }
  const sequenceOrder = compareNumbers(left.sequence, right.sequence);
  return sequenceOrder !== 0 ? sequenceOrder : compareStrings(left.sourceId, right.sourceId);
}

function compareMutations(left: RelationMutation, right: RelationMutation): -1 | 0 | 1 {
  const editOrder = compareEditPosition(left, right);
  if (editOrder !== 0) {
    return editOrder;
  }
  const relationOrder = compareReferenceKeys(left.relation, right.relation);
  if (relationOrder !== 0) {
    return relationOrder;
  }
  return compareStrings(left.action, right.action);
}

function createSourceIdTuple(sourceIds: ReadonlySet<SourceId>): readonly [SourceId, ...SourceId[]] {
  const sortedSourceIds = [...sourceIds].sort(compareStrings);
  const firstSourceId = sortedSourceIds[0];
  assertNonNullable(firstSourceId, "relation mutationのsource IDがありません");
  return Object.freeze([firstSourceId, ...sortedSourceIds.slice(1)]);
}

function validateInput(input: RelationMutationInput): void {
  const result = relationMutationInputSchema.safeParse(input);
  if (!result.success) {
    throw new TypeError("relation mutation入力が不正です", { cause: result.error });
  }
  if (input.contentCreatedAt != null) {
    if (createUtcIsoDateTime(input.contentCreatedAt) !== input.contentCreatedAt) {
      throw new TypeError("relation mutationのcontent作成時刻をUTCへ正規化してください");
    }
  }
  if (input.history.availability !== "available") {
    return;
  }
  for (const edit of input.history.edits) {
    if (createUtcIsoDateTime(edit.createdAt) !== edit.createdAt) {
      throw new TypeError("relation mutationの編集record作成時刻をUTCへ正規化してください");
    }
    if (createUtcIsoDateTime(edit.editedAt) !== edit.editedAt) {
      throw new TypeError("relation mutationの編集時刻をUTCへ正規化してください");
    }
    if (edit.deletedAt != null && createUtcIsoDateTime(edit.deletedAt) !== edit.deletedAt) {
      throw new TypeError("relation mutationの削除時刻をUTCへ正規化してください");
    }
  }
}

function unknownResult(
  contentSourceId: SourceId,
  reason: RelationMutationUnknownReason,
  edit: RelationMutationEdit | undefined,
): RelationMutationUnknown {
  if (edit == null) {
    return Object.freeze({
      status: "unknown",
      contentSourceId,
      reason,
      edit: Object.freeze({ status: "unavailable" }),
    });
  }
  return Object.freeze({
    status: "unknown",
    contentSourceId,
    reason,
    edit: Object.freeze({
      status: "available",
      sourceId: edit.sourceId,
      editedAt: edit.editedAt,
      sequence: edit.sequence,
    }),
  });
}

function isUnsupportedDiffFormat(diff: string): boolean {
  return /(?:^|\n)@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@(?:\n|$)/u.test(diff);
}

function parseSnapshot(
  contentSourceId: SourceId,
  edit: RelationMutationEdit,
): readonly RelationTextReference[] | RelationMutationUnknown {
  if (edit.diff == null) {
    return unknownResult(contentSourceId, "diff_null", edit);
  }
  if (isUnsupportedDiffFormat(edit.diff)) {
    return unknownResult(contentSourceId, "unsupported_diff_format", edit);
  }
  const parsed = parseRelationTextReferences(edit.diff);
  if (parsed.status === "unknown") {
    return unknownResult(contentSourceId, "markdown_reference_definition", edit);
  }
  const referencesByKey = new Map<string, RelationTextReference>();
  for (const reference of parsed.references) {
    const validation = relationTextReferenceSchema.safeParse(reference);
    if (!validation.success) {
      throw new TypeError("relation本文参照が不正です", { cause: validation.error });
    }
    referencesByKey.set(createRelationMutationReferenceKey(reference), reference);
  }
  return Object.freeze([...referencesByKey.values()].sort(compareReferenceKeys));
}

function parseCurrentSnapshot(
  contentSourceId: SourceId,
  currentMarkdown: string,
): readonly RelationTextReference[] | RelationMutationUnknown {
  const parsed = parseRelationTextReferences(currentMarkdown);
  if (parsed.status === "unknown") {
    return unknownResult(contentSourceId, "current_markdown_reference_definition", undefined);
  }
  const referencesByKey = new Map<string, RelationTextReference>();
  for (const reference of parsed.references) {
    const validation = relationTextReferenceSchema.safeParse(reference);
    if (!validation.success) {
      throw new TypeError("relation本文参照が不正です", { cause: validation.error });
    }
    referencesByKey.set(createRelationMutationReferenceKey(reference), reference);
  }
  return Object.freeze([...referencesByKey.values()].sort(compareReferenceKeys));
}

function isReferenceSnapshot(
  value: readonly RelationTextReference[] | RelationMutationUnknown,
): value is readonly RelationTextReference[] {
  return Array.isArray(value);
}

function createMutation(
  relation: RelationTextReference,
  action: RelationMutation["action"],
  edit: RelationMutationEdit,
  contentSourceId: SourceId,
): RelationMutation {
  return Object.freeze({
    relation,
    action,
    editedAt: edit.editedAt,
    sourceId: edit.sourceId,
    contentSourceId,
    sequence: edit.sequence,
  });
}

function appendDifference(
  mutations: RelationMutation[],
  previous: readonly RelationTextReference[],
  next: readonly RelationTextReference[],
  edit: RelationMutationEdit,
  contentSourceId: SourceId,
): void {
  const previousByKey = new Map(
    previous.map((reference) => [createRelationMutationReferenceKey(reference), reference]),
  );
  const nextByKey = new Map(
    next.map((reference) => [createRelationMutationReferenceKey(reference), reference]),
  );
  for (const reference of next) {
    if (!previousByKey.has(createRelationMutationReferenceKey(reference))) {
      mutations.push(createMutation(reference, "added", edit, contentSourceId));
    }
  }
  for (const reference of previous) {
    if (!nextByKey.has(createRelationMutationReferenceKey(reference))) {
      mutations.push(createMutation(reference, "removed", edit, contentSourceId));
    }
  }
}

function createIntervalFromMutation(mutation: RelationMutation): MutableActiveInterval {
  return {
    status: "active",
    relation: mutation.relation,
    addedAt: mutation.editedAt,
    addedSourceIds: new Set([mutation.sourceId]),
    lastConfirmedAt: mutation.editedAt,
  };
}

function createPreexistingInterval(
  relation: RelationTextReference,
  firstEdit: RelationMutationEdit,
  addedAt: UtcIsoDateTime,
): MutableActiveInterval {
  return {
    status: "active",
    relation,
    addedAt,
    addedSourceIds: new Set([firstEdit.sourceId]),
    lastConfirmedAt: firstEdit.editedAt,
  };
}

function applyMutation(
  mutation: RelationMutation,
  relationsByKey: Map<string, MutableRelation>,
  unmatchedRemovals: RelationMutation[],
): void {
  const key = createRelationMutationReferenceKey(mutation.relation);
  const relation = relationsByKey.get(key);
  if (mutation.action === "added") {
    if (relation == null) {
      relationsByKey.set(key, {
        relation: mutation.relation,
        intervals: [createIntervalFromMutation(mutation)],
      });
      return;
    }
    const lastInterval = relation.intervals.at(-1);
    assertNonNullable(lastInterval, "relation mutationのintervalがありません");
    if (lastInterval.status === "active") {
      lastInterval.addedSourceIds.add(mutation.sourceId);
      lastInterval.lastConfirmedAt = mutation.editedAt;
      return;
    }
    relation.intervals.push(createIntervalFromMutation(mutation));
    return;
  }
  if (relation == null) {
    unmatchedRemovals.push(mutation);
    return;
  }
  const lastInterval = relation.intervals.at(-1);
  assertNonNullable(lastInterval, "relation mutationのintervalがありません");
  if (lastInterval.status === "removed") {
    unmatchedRemovals.push(mutation);
    return;
  }
  relation.intervals[relation.intervals.length - 1] = {
    status: "removed",
    relation: relation.relation,
    addedAt: lastInterval.addedAt,
    addedSourceIds: new Set(lastInterval.addedSourceIds),
    removedAt: mutation.editedAt,
    removedSourceIds: new Set([mutation.sourceId]),
  };
}

function confirmSnapshot(
  snapshot: readonly RelationTextReference[],
  editedAt: UtcIsoDateTime,
  relationsByKey: ReadonlyMap<string, MutableRelation>,
): void {
  for (const reference of snapshot) {
    const relation = relationsByKey.get(createRelationMutationReferenceKey(reference));
    assertNonNullable(relation, "relation mutationのsnapshotに対応するintervalがありません");
    const lastInterval = relation.intervals.at(-1);
    if (lastInterval?.status !== "active") {
      throw new TypeError("relation mutationのsnapshotがactive intervalと一致しません");
    }
    relation.relation = reference;
    lastInterval.relation = reference;
    lastInterval.lastConfirmedAt = editedAt;
  }
}

function freezeInterval(
  interval: MutableActiveInterval | MutableRemovedInterval,
): RelationMutationInterval {
  if (interval.status === "active") {
    return Object.freeze({
      status: "active",
      relation: interval.relation,
      addedAt: interval.addedAt,
      addedSourceIds: createSourceIdTuple(interval.addedSourceIds),
      lastConfirmedAt: interval.lastConfirmedAt,
    });
  }
  return Object.freeze({
    status: "removed",
    relation: interval.relation,
    addedAt: interval.addedAt,
    addedSourceIds: createSourceIdTuple(interval.addedSourceIds),
    removedAt: interval.removedAt,
    removedSourceIds: createSourceIdTuple(interval.removedSourceIds),
  });
}

function sameReferenceSets(
  left: readonly RelationTextReference[],
  right: readonly RelationTextReference[],
): boolean {
  if (left.length !== right.length) {
    return false;
  }
  return left.every((reference) =>
    right.some(
      (candidate) =>
        createRelationMutationReferenceKey(reference) ===
        createRelationMutationReferenceKey(candidate),
    ),
  );
}

function activeReferences(
  relationsByKey: ReadonlyMap<string, MutableRelation>,
): readonly RelationTextReference[] {
  return Object.freeze(
    [...relationsByKey.values()]
      .filter((relation) => relation.intervals.at(-1)?.status === "active")
      .map((relation) => relation.relation)
      .sort(compareReferenceKeys),
  );
}

function freezeIntervals(
  relationsByKey: ReadonlyMap<string, MutableRelation>,
): readonly RelationMutationInterval[] {
  return Object.freeze(
    [...relationsByKey.values()]
      .flatMap((relation) => relation.intervals.map(freezeInterval))
      .sort((left, right) => {
        const relationOrder = compareReferenceKeys(left.relation, right.relation);
        if (relationOrder !== 0) {
          return relationOrder;
        }
        return compareStrings(left.addedAt, right.addedAt);
      }),
  );
}

function validateUniqueEditSources(edits: readonly RelationMutationEdit[]): void {
  const seen = new Set<SourceId>();
  for (const edit of edits) {
    if (seen.has(edit.sourceId)) {
      throw new TypeError(`relation mutationのedit source IDが重複しています: ${edit.sourceId}`);
    }
    seen.add(edit.sourceId);
  }
}

function resolvePreexistingAt(
  edits: readonly RelationMutationEdit[],
  contentCreatedAt: UtcIsoDateTime | null,
): UtcIsoDateTime | null {
  if (contentCreatedAt == null || edits.length === 0) {
    return null;
  }
  if (edits.every((edit) => edit.createdAt === contentCreatedAt)) {
    return contentCreatedAt;
  }
  return null;
}

function createTransitions(
  snapshots: readonly ParsedSnapshot[],
  contentSourceId: SourceId,
): Readonly<{
  mutations: readonly RelationMutation[];
  transitions: readonly SnapshotTransition[];
}> {
  const mutations: RelationMutation[] = [];
  const transitions: SnapshotTransition[] = [];
  const firstSnapshot = snapshots[0];
  assertNonNullable(firstSnapshot, "relation mutationのsnapshotがありません");
  for (let index = 1; index < snapshots.length; index += 1) {
    const previousSnapshot = snapshots[index - 1];
    const snapshot = snapshots[index];
    assertNonNullable(previousSnapshot, "relation mutationのsnapshot順序が不正です");
    assertNonNullable(snapshot, "relation mutationのsnapshot順序が不正です");
    const transitionMutations: RelationMutation[] = [];
    appendDifference(
      transitionMutations,
      previousSnapshot.references,
      snapshot.references,
      snapshot.edit,
      contentSourceId,
    );
    mutations.push(...transitionMutations);
    transitions.push({
      snapshot,
      mutations: Object.freeze(transitionMutations),
    });
  }
  mutations.sort(compareMutations);
  return Object.freeze({
    mutations: Object.freeze(mutations),
    transitions: Object.freeze(transitions),
  });
}

function replayReferenceSet(
  initialReferences: readonly RelationTextReference[],
  transitions: readonly SnapshotTransition[],
): Readonly<{
  references: readonly RelationTextReference[];
  unmatchedRemovals: readonly RelationMutation[];
}> {
  const referencesByKey = new Map(
    initialReferences.map((reference) => [
      createRelationMutationReferenceKey(reference),
      reference,
    ]),
  );
  const unmatchedRemovals: RelationMutation[] = [];
  for (const transition of transitions) {
    for (const mutation of transition.mutations) {
      const key = createRelationMutationReferenceKey(mutation.relation);
      if (mutation.action === "added") {
        referencesByKey.set(key, mutation.relation);
      } else if (!referencesByKey.delete(key)) {
        unmatchedRemovals.push(mutation);
      }
    }
  }
  return Object.freeze({
    references: Object.freeze([...referencesByKey.values()].sort(compareReferenceKeys)),
    unmatchedRemovals: Object.freeze(unmatchedRemovals.sort(compareMutations)),
  });
}

function createExactResult(
  contentSourceId: SourceId,
  currentReferences: readonly RelationTextReference[],
  replayedReferences: readonly RelationTextReference[],
  mutations: readonly RelationMutation[],
  unmatchedRemovals: readonly RelationMutation[],
  intervals: readonly RelationMutationInterval[],
): RelationMutationAvailableExactResult {
  return Object.freeze({
    status: "available",
    contentSourceId,
    currentReferences: Object.freeze(currentReferences),
    replayedReferences: Object.freeze(replayedReferences),
    consistency: "consistent",
    temporalKnowledge: Object.freeze({
      status: "exact",
      intervals: Object.freeze(intervals),
    }),
    mutations: Object.freeze(mutations),
    unmatchedRemovals: Object.freeze(unmatchedRemovals),
  });
}

function createUnknownTemporalResult(
  contentSourceId: SourceId,
  currentReferences: readonly RelationTextReference[],
  replayedReferences: readonly RelationTextReference[],
  mutations: readonly RelationMutation[],
  unmatchedRemovals: readonly RelationMutation[],
  reason: "history_incomplete" | "current_mismatch" | "preexisting_relation",
): RelationMutationAvailableUnknownTemporalResult {
  let consistency: "consistent" | "history_incomplete" | "mismatch";
  if (reason === "history_incomplete") {
    consistency = "history_incomplete";
  } else if (reason === "current_mismatch") {
    consistency = "mismatch";
  } else {
    consistency = "consistent";
  }
  return Object.freeze({
    status: "available",
    contentSourceId,
    currentReferences: Object.freeze(currentReferences),
    replayedReferences: Object.freeze(replayedReferences),
    consistency,
    temporalKnowledge: Object.freeze({
      status: "unknown",
      reason,
    }),
    mutations: Object.freeze(mutations),
    unmatchedRemovals: Object.freeze(unmatchedRemovals),
  });
}

/** 現在本文と編集後スナップショットからrelation mutationを復元する。 */
export function extractRelationMutations(input: RelationMutationInput): RelationMutationResult {
  validateInput(input);
  if (input.history.availability === "available") {
    validateUniqueEditSources(input.history.edits);
  }
  const currentSnapshot = parseCurrentSnapshot(input.contentSourceId, input.currentMarkdown);
  if (!isReferenceSnapshot(currentSnapshot)) {
    return currentSnapshot;
  }
  if (input.history.availability === "unavailable") {
    return unknownResult(input.contentSourceId, "connection_unavailable", undefined);
  }
  const sortedEdits = [...input.history.edits].sort(compareEditPosition);
  if (sortedEdits.length === 0) {
    if (currentSnapshot.length === 0) {
      return createExactResult(input.contentSourceId, currentSnapshot, [], [], [], []);
    }
    return createUnknownTemporalResult(
      input.contentSourceId,
      currentSnapshot,
      [],
      [],
      [],
      "history_incomplete",
    );
  }

  const snapshots: ParsedSnapshot[] = [];
  for (const edit of sortedEdits) {
    if (edit.deletedAt != null) {
      return unknownResult(input.contentSourceId, "deleted_edit", edit);
    }
    const references = parseSnapshot(input.contentSourceId, edit);
    if (!isReferenceSnapshot(references)) {
      return references;
    }
    snapshots.push({ edit, references });
  }
  const firstSnapshot = snapshots[0];
  const lastSnapshot = snapshots.at(-1);
  assertNonNullable(firstSnapshot, "relation mutationのsnapshotがありません");
  assertNonNullable(lastSnapshot, "relation mutationのsnapshotがありません");
  const transitionResult = createTransitions(snapshots, input.contentSourceId);
  const replayedSet = replayReferenceSet(firstSnapshot.references, transitionResult.transitions);
  const currentMatches = sameReferenceSets(currentSnapshot, lastSnapshot.references);
  const preexistingAt = resolvePreexistingAt(sortedEdits, input.contentCreatedAt);
  if (!currentMatches) {
    return createUnknownTemporalResult(
      input.contentSourceId,
      currentSnapshot,
      replayedSet.references,
      transitionResult.mutations,
      replayedSet.unmatchedRemovals,
      "current_mismatch",
    );
  }
  if (firstSnapshot.references.length > 0 && preexistingAt == null) {
    return createUnknownTemporalResult(
      input.contentSourceId,
      currentSnapshot,
      replayedSet.references,
      transitionResult.mutations,
      replayedSet.unmatchedRemovals,
      "preexisting_relation",
    );
  }

  const relationsByKey = new Map<string, MutableRelation>();
  if (preexistingAt != null) {
    for (const reference of firstSnapshot.references) {
      relationsByKey.set(createRelationMutationReferenceKey(reference), {
        relation: reference,
        intervals: [createPreexistingInterval(reference, firstSnapshot.edit, preexistingAt)],
      });
    }
  }
  confirmSnapshot(firstSnapshot.references, firstSnapshot.edit.editedAt, relationsByKey);
  for (const transition of transitionResult.transitions) {
    const unmatchedRemovals: RelationMutation[] = [];
    for (const mutation of transition.mutations) {
      applyMutation(mutation, relationsByKey, unmatchedRemovals);
    }
    if (unmatchedRemovals.length > 0) {
      throw new TypeError("relation mutationのreplayで対応する追加がありません");
    }
    confirmSnapshot(
      transition.snapshot.references,
      transition.snapshot.edit.editedAt,
      relationsByKey,
    );
  }
  const replayedReferences = activeReferences(relationsByKey);
  if (!sameReferenceSets(currentSnapshot, replayedReferences)) {
    throw new TypeError("relation mutationのreplay結果が検証済みsnapshotと一致しません");
  }
  return createExactResult(
    input.contentSourceId,
    currentSnapshot,
    replayedReferences,
    transitionResult.mutations,
    [],
    freezeIntervals(relationsByKey),
  );
}
