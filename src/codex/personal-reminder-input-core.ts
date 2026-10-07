import type { PersonalReminderResponsible } from "../domain/personal-reminder-causes.js";
import type { SourceId } from "../domain/source-id.js";
import type { GraphNodeId } from "../domain/types.js";
import { assertNonNullable } from "../util/index.js";
import type {
  PersonalReminderAiItemContext,
  PersonalReminderAiRelationContext,
  PersonalReminderCauseSemanticInput,
  PersonalReminderTargetScope,
} from "./personal-reminder-input-contracts.js";
import { personalReminderCauseSemanticInputSchema } from "./personal-reminder-input-contracts.js";

/** 文字列を安定した順序で比較する。 */
export function compareStrings(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

/** keyに従って値を重複なく並べる。 */
export function uniqueSorted<T>(values: readonly T[], key: (value: T) => string): T[] {
  const sorted = [...values].sort((left, right) => compareStrings(key(left), key(right)));
  const result: T[] = [];
  let previousKey: string | undefined;
  for (const value of sorted) {
    const currentKey = key(value);
    if (previousKey !== currentKey) {
      result.push(value);
      previousKey = currentKey;
    }
  }
  return result;
}

function canonicalEndpointNodeIds(
  endpointNodeIds: readonly [GraphNodeId, GraphNodeId],
  label: string,
): [GraphNodeId, GraphNodeId] {
  const [first, second] = endpointNodeIds;
  if (first === second) {
    throw new TypeError(`${label}のendpointが同一です。対象: ${first}`);
  }
  if (first < second) {
    return [first, second];
  }
  return [second, first];
}

/** 文字列のUnicode文字数を数える。 */
export function countUnicodeCharacters(value: string): number {
  let count = 0;
  for (const character of value) {
    if (character.length === 0) {
      throw new TypeError("空のUnicode文字を検出しました");
    }
    count += 1;
  }
  return count;
}

/** 配列の先頭要素が存在することを検証する。 */
export function createNonEmptyArray<T>(
  values: readonly T[],
  message: string,
): readonly [T, ...T[]] {
  const [first, ...rest] = values;
  assertNonNullable(first, message);
  return [first, ...rest];
}

/** keyと値の組を作る。 */
export function createMapEntry<Key, Value>(key: Key, value: Value): readonly [Key, Value] {
  return [key, value];
}

/** 文字列の集合に重複がないか検証する。 */
export function validateUniqueStrings(values: readonly string[], label: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      throw new TypeError(`${label}が重複しています。対象: ${value}`);
    }
    seen.add(value);
  }
}

/** 責任主体を比較するためのkeyを作る。 */
export function responsibleKey(
  value: Readonly<{ kind: string; candidateId: string; role: string }>,
): string {
  return `${value.kind}\u0000${value.candidateId.toLowerCase()}\u0000${value.role}`;
}

function scopeNodeIds(
  itemNodeId: GraphNodeId,
  scope: PersonalReminderTargetScope,
): ReadonlySet<GraphNodeId> {
  const nodeIds = new Set<GraphNodeId>([itemNodeId]);
  if (scope.kind !== "item") {
    for (const surface of scope.surfaces) {
      nodeIds.add(surface.nodeId);
    }
  }
  return nodeIds;
}

function causeScopeNodeIds(
  cause: PersonalReminderCauseSemanticInput["cause"],
): ReadonlySet<GraphNodeId> {
  return scopeNodeIds(cause.itemNodeId, cause.responsibility.scope);
}

function optionTargetScopeNodeIds(
  option: Readonly<{
    itemNodeId: GraphNodeId;
    targetScope: PersonalReminderTargetScope;
  }>,
): ReadonlySet<GraphNodeId> {
  return scopeNodeIds(option.itemNodeId, option.targetScope);
}

function relationConnectsCauseAndTargetScope(
  relation: PersonalReminderAiRelationContext,
  cause: PersonalReminderCauseSemanticInput["cause"],
  targetScope: Readonly<{
    itemNodeId: GraphNodeId;
    targetScope: PersonalReminderTargetScope;
  }>,
): boolean {
  const causeNodeIds = causeScopeNodeIds(cause);
  const targetNodeIds = optionTargetScopeNodeIds(targetScope);
  return (
    (causeNodeIds.has(relation.fromNodeId) && targetNodeIds.has(relation.toNodeId)) ||
    (causeNodeIds.has(relation.toNodeId) && targetNodeIds.has(relation.fromNodeId))
  );
}

/** 候補relationが原因と対象範囲を接続するか検証する。 */
export function validateOptionRelationIntegrity<Key extends string>(
  option: Readonly<{
    itemNodeId: GraphNodeId;
    targetScope: PersonalReminderTargetScope;
    relationIds: readonly Key[];
  }>,
  cause: PersonalReminderCauseSemanticInput["cause"],
  relationById: ReadonlyMap<Key, PersonalReminderAiRelationContext>,
  label: string,
): void {
  if (option.itemNodeId !== cause.itemNodeId && option.relationIds.length === 0) {
    throw new TypeError(`${label}の別item待機にはrelationが必要です`);
  }
  for (const relationId of option.relationIds) {
    const relation = relationById.get(relationId);
    assertNonNullable(relation, `${label}のrelationがありません。対象: ${relationId}`);
    if (relation.type === "related_to") {
      throw new TypeError(`${label}にrelated_to relationは指定できません。対象: ${relationId}`);
    }
    if (!relationConnectsCauseAndTargetScope(relation, cause, option)) {
      throw new TypeError(`${label}のrelationがcauseと待ち先のscopeを接続していません`);
    }
  }
}

/** 候補の対象範囲に必要な項目contextを検証する。 */
export function validateOptionTargetScope(
  option: Readonly<{
    itemNodeId: GraphNodeId;
    targetScope: PersonalReminderTargetScope;
  }>,
  itemByNodeId: ReadonlyMap<GraphNodeId, PersonalReminderAiItemContext>,
  label: string,
): void {
  if (option.targetScope.kind !== "item") {
    validateUniqueStrings(
      option.targetScope.surfaces.map((value) => `${value.kind}\u0000${value.nodeId}`),
      `${label}のexecution surface`,
    );
  }
  for (const nodeId of optionTargetScopeNodeIds(option)) {
    if (!itemByNodeId.has(nodeId)) {
      throw new TypeError(`${label}のtarget scope item contextがありません。対象: ${nodeId}`);
    }
  }
  if (option.targetScope.kind !== "item") {
    for (const surface of option.targetScope.surfaces) {
      const item = itemByNodeId.get(surface.nodeId);
      assertNonNullable(item, `${label}のexecution surface item contextがありません`);
      if (
        (surface.kind === "issue" && item.type !== "issue") ||
        (surface.kind === "pull_request" && item.type !== "pull_request")
      ) {
        throw new TypeError(`${label}のexecution surface種別がitem contextと一致しません`);
      }
    }
  }
}

function validateSemanticInputIntegrity(input: PersonalReminderCauseSemanticInput): void {
  const itemNodeIds = input.items.map((value) => value.nodeId);
  validateUniqueStrings(itemNodeIds, "item node ID");
  const itemIds = new Set(itemNodeIds);
  const itemByNodeId = new Map(input.items.map((value) => [value.nodeId, value]));
  const relationIdValues = input.relations.map((value) => value.id);
  validateUniqueStrings(relationIdValues, "relation ID");
  const relationIds = new Set(relationIdValues);
  const pendingRelationIdValues = input.pendingRelations.map((value) => value.candidateId);
  validateUniqueStrings(pendingRelationIdValues, "pending relation candidate ID");
  const sourceIdValues = input.sources.map((value) => value.sourceId);
  validateUniqueStrings(sourceIdValues, "source ID");
  const sourceIds = new Set(sourceIdValues);
  validateUniqueStrings(
    input.evidenceScopes.map((value) => value.sourceId),
    "evidence scope source ID",
  );
  validateUniqueStrings(
    input.waitingOptions.map((value) => value.optionId),
    "waiting option ID",
  );
  validateUniqueStrings(
    input.duplicateOptions.map((value) => value.canonicalCauseId),
    "duplicate option canonical cause ID",
  );
  validateUniqueStrings(
    input.cause.responsible.map((value) => responsibleKey(value)),
    "cause responsible actor",
  );
  const allowsMissingRelatedItem =
    input.completeness.status === "incomplete" &&
    input.completeness.missing.includes("related_item");
  const allowsMissingRelationEvidence =
    input.completeness.status === "incomplete" &&
    input.completeness.missing.includes("relation_evidence");
  if (input.cause.responsibility.scope.kind !== "item") {
    validateUniqueStrings(
      input.cause.responsibility.scope.surfaces.map(
        (value) => `${value.kind}\u0000${value.nodeId}`,
      ),
      "cause execution surface",
    );
  }
  if (!itemIds.has(input.cause.itemNodeId)) {
    throw new TypeError("原因のitem node IDがitem contextにありません");
  }
  const relationById = new Map(input.relations.map((relation) => [relation.id, relation]));
  const relationEvidenceSourceIds = new Set(
    input.relations.flatMap((relation) => relation.evidenceSourceIds),
  );
  const pendingRelationEvidenceSourceIds = new Set(
    input.pendingRelations.flatMap((relation) => relation.evidenceSourceIds),
  );
  const canUseMissingRelationEvidenceSource = (sourceId: SourceId): boolean =>
    allowsMissingRelationEvidence &&
    (relationEvidenceSourceIds.has(sourceId) || pendingRelationEvidenceSourceIds.has(sourceId));
  const causeNodeIds = causeScopeNodeIds(input.cause);
  for (const relation of input.relations) {
    const hasMissingEndpoint = !itemIds.has(relation.fromNodeId) || !itemIds.has(relation.toNodeId);
    if (hasMissingEndpoint && !allowsMissingRelatedItem) {
      throw new TypeError(`relation ${relation.id}の端点がitem contextにありません`);
    }
    validateUniqueStrings(relation.evidenceSourceIds, `relation ${relation.id}のsource ID`);
    for (const sourceId of relation.evidenceSourceIds) {
      if (!sourceIds.has(sourceId) && !canUseMissingRelationEvidenceSource(sourceId)) {
        throw new TypeError(`relation ${relation.id}の根拠sourceがありません。対象: ${sourceId}`);
      }
    }
  }
  if (
    input.pendingRelations.length !== 0 &&
    (input.completeness.status !== "incomplete" || !allowsMissingRelationEvidence)
  ) {
    throw new TypeError(
      "pending relationを含む入力にはrelation_evidence不足を含むincompleteが必要です",
    );
  }
  for (const relation of input.pendingRelations) {
    const [firstEndpoint, secondEndpoint] = canonicalEndpointNodeIds(
      relation.endpointNodeIds,
      `pending relation ${relation.candidateId}`,
    );
    if (!causeNodeIds.has(firstEndpoint) && !causeNodeIds.has(secondEndpoint)) {
      throw new TypeError(
        `pending relation ${relation.candidateId}がcause scopeに接続していません`,
      );
    }
    const hasMissingEndpoint = !itemIds.has(firstEndpoint) || !itemIds.has(secondEndpoint);
    if (hasMissingEndpoint && (!allowsMissingRelatedItem || !allowsMissingRelationEvidence)) {
      throw new TypeError(
        `pending relation ${relation.candidateId}の端点がitem contextにありません`,
      );
    }
    validateUniqueStrings(
      relation.evidenceSourceIds,
      `pending relation ${relation.candidateId}のsource ID`,
    );
    for (const sourceId of relation.evidenceSourceIds) {
      if (!sourceIds.has(sourceId) && !canUseMissingRelationEvidenceSource(sourceId)) {
        throw new TypeError(
          `pending relation ${relation.candidateId}の根拠sourceがありません。対象: ${sourceId}`,
        );
      }
    }
  }
  for (const source of input.sources) {
    if (!itemIds.has(source.itemNodeId)) {
      const isRelationEvidence =
        relationEvidenceSourceIds.has(source.sourceId) ||
        pendingRelationEvidenceSourceIds.has(source.sourceId);
      if (!allowsMissingRelatedItem || !isRelationEvidence) {
        throw new TypeError(`source ${source.sourceId}のitem node IDがitem contextにありません`);
      }
    }
  }
  for (const scope of input.evidenceScopes) {
    validateUniqueStrings(scope.roles, `evidence scope ${scope.sourceId}のrole`);
    const sourceId = scope.sourceId;
    if (!sourceIds.has(sourceId)) {
      throw new TypeError(`evidence scopeのsourceがありません。対象: ${sourceId}`);
    }
  }
  for (const option of input.waitingOptions) {
    if (!itemIds.has(option.itemNodeId)) {
      throw new TypeError(`waiting option ${option.optionId}のitemがありません`);
    }
    validateOptionTargetScope(option, itemByNodeId, `waiting option ${option.optionId}`);
    validateUniqueStrings(option.relationIds, `waiting option ${option.optionId}のrelation ID`);
    validateUniqueStrings(option.evidenceSourceIds, `waiting option ${option.optionId}のsource ID`);
    for (const relationId of option.relationIds) {
      if (!relationIds.has(relationId)) {
        throw new TypeError(`waiting option ${option.optionId}のrelationがありません`);
      }
    }
    for (const sourceId of option.evidenceSourceIds) {
      if (!sourceIds.has(sourceId) && !canUseMissingRelationEvidenceSource(sourceId)) {
        throw new TypeError(`waiting option ${option.optionId}のsourceがありません`);
      }
    }
    validateOptionRelationIntegrity(
      option,
      input.cause,
      relationById,
      `waiting option ${option.optionId}`,
    );
  }
  for (const option of input.duplicateOptions) {
    if (!itemIds.has(option.itemNodeId)) {
      throw new TypeError(`duplicate option ${option.canonicalCauseId}のitemがありません`);
    }
    validateOptionTargetScope(option, itemByNodeId, `duplicate option ${option.canonicalCauseId}`);
    validateUniqueStrings(
      option.relationIds,
      `duplicate option ${option.canonicalCauseId}のrelation ID`,
    );
    validateUniqueStrings(
      option.evidenceSourceIds,
      `duplicate option ${option.canonicalCauseId}のsource ID`,
    );
    for (const relationId of option.relationIds) {
      if (!relationIds.has(relationId)) {
        throw new TypeError(`duplicate option ${option.canonicalCauseId}のrelationがありません`);
      }
    }
    for (const sourceId of option.evidenceSourceIds) {
      if (!sourceIds.has(sourceId) && !canUseMissingRelationEvidenceSource(sourceId)) {
        throw new TypeError(`duplicate option ${option.canonicalCauseId}のsourceがありません`);
      }
    }
    validateOptionRelationIntegrity(
      option,
      input.cause,
      relationById,
      `duplicate option ${option.canonicalCauseId}`,
    );
  }
}

/** 未検証値から個人催促原因単位の意味入力を作成する。 */
export function createPersonalReminderCauseSemanticInput(
  value: unknown,
): PersonalReminderCauseSemanticInput {
  const parsed = personalReminderCauseSemanticInputSchema.parse(value);
  const normalized: PersonalReminderCauseSemanticInput = {
    ...parsed,
    pendingRelations: parsed.pendingRelations.map((relation) => ({
      ...relation,
      endpointNodeIds: canonicalEndpointNodeIds(
        relation.endpointNodeIds,
        `pending relation ${relation.candidateId}`,
      ),
    })),
  };
  validateSemanticInputIntegrity(normalized);
  return normalized;
}

/** 責任主体を正規化して並べる。 */
export function canonicalResponsible(
  responsible: readonly PersonalReminderResponsible[],
): readonly PersonalReminderResponsible[] {
  return uniqueSorted(
    responsible.map((value) => ({
      ...value,
      candidateId: value.candidateId.toLowerCase(),
    })),
    responsibleKey,
  );
}

function canonicalScope(scope: PersonalReminderTargetScope): unknown {
  if (scope.kind === "item") {
    return scope;
  }
  return {
    ...scope,
    surfaces: uniqueSorted(scope.surfaces, (value) => `${value.kind}\u0000${value.nodeId}`),
  };
}

/** 意味入力の配列と対象範囲を正規化する。 */
export function canonicalSemanticInput(input: PersonalReminderCauseSemanticInput): unknown {
  const responsibility = input.cause.responsibility;
  const completeness =
    input.completeness.status === "complete"
      ? input.completeness
      : {
          status: input.completeness.status,
          missing: uniqueSorted(input.completeness.missing, (value) => value),
        };
  const relations = uniqueSorted(input.relations, (value) => value.id).map((value) => ({
    ...value,
    evidenceSourceIds: uniqueSorted(value.evidenceSourceIds, (sourceId) => sourceId),
  }));
  const waitingOptions = uniqueSorted(input.waitingOptions, (value) => value.optionId).map(
    (value) => ({
      ...value,
      targetScope: canonicalScope(value.targetScope),
      relationIds: uniqueSorted(value.relationIds, (relationId) => relationId),
      evidenceSourceIds: uniqueSorted(value.evidenceSourceIds, (sourceId) => sourceId),
    }),
  );
  const duplicateOptions = uniqueSorted(
    input.duplicateOptions,
    (value) => `${value.canonicalCauseId}\u0000${value.itemNodeId}`,
  ).map((value) => ({
    ...value,
    targetScope: canonicalScope(value.targetScope),
    responsible: canonicalResponsible(value.responsible),
    relationIds: uniqueSorted(value.relationIds, (relationId) => relationId),
    evidenceSourceIds: uniqueSorted(value.evidenceSourceIds, (sourceId) => sourceId),
  }));
  return {
    cause: {
      causeId: input.cause.causeId,
      itemNodeId: input.cause.itemNodeId,
      reasonCode: input.cause.reasonCode,
      responsible: canonicalResponsible(input.cause.responsible),
      responsibility: {
        authority: responsibility.authority,
        scope: canonicalScope(responsibility.scope),
      },
      action: {
        kind: input.cause.action.kind,
        summary: input.cause.action.summary,
      },
    },
    completeness,
    items: uniqueSorted(input.items, (value) => value.nodeId),
    relations,
    pendingRelations: uniqueSorted(input.pendingRelations, (value) => value.candidateId).map(
      (value) => ({
        candidateId: value.candidateId,
        endpointNodeIds: canonicalEndpointNodeIds(
          value.endpointNodeIds,
          `pending relation ${value.candidateId}`,
        ),
        status: value.status,
        reason: value.reason,
        evidenceSourceIds: uniqueSorted(value.evidenceSourceIds, (sourceId) => sourceId),
      }),
    ),
    sources: uniqueSorted(input.sources, (value) => value.sourceId),
    evidenceScopes: uniqueSorted(input.evidenceScopes, (value) => value.sourceId).map((value) => ({
      sourceId: value.sourceId,
      roles: uniqueSorted(value.roles, (role) => role),
    })),
    waitingOptions,
    duplicateOptions,
  };
}
