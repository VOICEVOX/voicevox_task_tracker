import { serializeCanonicalJson } from "../canonical-json/value.js";
import { assertNonNullable } from "../util/index.js";
import type {
  PersonalReminderAiInput,
  PersonalReminderItemRef,
  PersonalReminderRelationRef,
  PersonalReminderSourceRef,
  PersonalReminderTargetScope,
} from "./personal-reminder-input-contracts.js";
import { personalReminderAiInputSchema } from "./personal-reminder-input-contracts.js";
import {
  responsibleKey,
  validateOptionRelationIntegrity,
  validateOptionTargetScope,
  validateUniqueStrings,
} from "./personal-reminder-input-core.js";
import { resolveTransportTargetScope } from "./personal-reminder-input-transport-mapping.js";

function validateTransportInputIntegrity(input: PersonalReminderAiInput): void {
  const itemRefValues = input.items.map((value) => value.ref);
  const relationRefValues = input.relations.map((value) => value.ref);
  const sourceRefValues = input.sources.map((value) => value.ref);
  validateUniqueStrings(itemRefValues, "transport item ref");
  validateUniqueStrings(relationRefValues, "transport relation ref");
  validateUniqueStrings(sourceRefValues, "transport source ref");
  const itemRefs = new Set(itemRefValues);
  const relationRefs = new Set(relationRefValues);
  const sourceRefs = new Set(sourceRefValues);
  const itemByRef = new Map(input.items.map((value) => [value.ref, value.item]));
  const itemByNodeId = new Map(input.items.map((value) => [value.item.nodeId, value.item]));
  const relationByRef = new Map(input.relations.map((value) => [value.ref, value.relation]));
  const sourceByRef = new Map(input.sources.map((value) => [value.ref, value.source]));
  const itemNodeIdValues = input.items.map((value) => value.item.nodeId);
  validateUniqueStrings(itemNodeIdValues, "transport item node ID");
  const itemNodeIds = new Set(itemNodeIdValues);
  const rootItem = input.items.find((value) => value.item.nodeId === input.item.nodeId);
  assertNonNullable(rootItem, "transport inputのitem identityがitemsにありません");
  if (rootItem.item.url !== input.item.url) {
    throw new TypeError("transport inputのitem URLがitemsのcontextと一致しません");
  }
  const relationIdValues = input.relations.map((value) => value.relation.id);
  const sourceIdValues = input.sources.map((value) => value.source.sourceId);
  validateUniqueStrings(relationIdValues, "transport relation ID");
  validateUniqueStrings(sourceIdValues, "transport source ID");
  const relationIds = new Set(relationIdValues);
  const sourceIds = new Set(sourceIdValues);
  for (const relation of input.relations) {
    if (
      !itemNodeIds.has(relation.relation.fromNodeId) ||
      !itemNodeIds.has(relation.relation.toNodeId)
    ) {
      throw new TypeError(`transport relation ${relation.relation.id}の端点がありません`);
    }
    validateUniqueStrings(
      relation.relation.evidenceSourceIds,
      `transport relation ${relation.relation.id}のsource ID`,
    );
    for (const sourceId of relation.relation.evidenceSourceIds) {
      if (!sourceIds.has(sourceId)) {
        throw new TypeError(`transport relationのsourceがありません。対象: ${sourceId}`);
      }
    }
  }
  for (const source of input.sources) {
    if (!itemNodeIds.has(source.source.itemNodeId)) {
      throw new TypeError(`transport sourceのitemがありません。対象: ${source.source.sourceId}`);
    }
  }
  const causeIds = new Set<string>();
  for (const cause of input.causes) {
    if (cause.completeness.status !== "complete") {
      throw new TypeError(`不完全なcauseをtransportへ含められません。対象: ${cause.causeId}`);
    }
    if (causeIds.has(cause.causeId)) {
      throw new TypeError(`transport inputのcause IDが重複しています。対象: ${cause.causeId}`);
    }
    causeIds.add(cause.causeId);
    if (cause.causeId !== cause.cause.causeId) {
      throw new TypeError(`causeの外側と内側のIDが一致しません。対象: ${cause.causeId}`);
    }
    if (cause.cause.itemNodeId !== input.item.nodeId) {
      throw new TypeError(
        `causeのitem node IDがtransport itemと一致しません。対象: ${cause.causeId}`,
      );
    }
    const causeItemRefValues = [...cause.itemRefs];
    const causeRelationRefValues = [...cause.relationRefs];
    const causeSourceRefValues = [...cause.sourceRefs];
    validateUniqueStrings(causeItemRefValues, `cause ${cause.causeId}のitem ref`);
    validateUniqueStrings(causeRelationRefValues, `cause ${cause.causeId}のrelation ref`);
    validateUniqueStrings(causeSourceRefValues, `cause ${cause.causeId}のsource ref`);
    const causeItemRefs = new Set(causeItemRefValues);
    const causeRelationRefs = new Set(causeRelationRefValues);
    const causeSourceRefs = new Set(causeSourceRefValues);
    validateUniqueStrings(
      cause.cause.responsible.map((value) => responsibleKey(value)),
      `cause ${cause.causeId}の責任主体`,
    );
    if (cause.cause.responsibility.scope.kind !== "item") {
      validateUniqueStrings(
        cause.cause.responsibility.scope.surfaces.map(
          (value) => `${value.kind}\u0000${value.nodeId}`,
        ),
        `cause ${cause.causeId}のexecution surface`,
      );
    }
    validateUniqueStrings(
      cause.evidenceScopes.map((value) => value.sourceRef),
      `cause ${cause.causeId}のevidence source ref`,
    );
    validateUniqueStrings(
      cause.waitingOptions.map((value) => value.optionId),
      `cause ${cause.causeId}のwaiting option ID`,
    );
    validateUniqueStrings(
      cause.duplicateOptions.map((value) => value.canonicalCauseId),
      `cause ${cause.causeId}のduplicate option ID`,
    );
    for (const ref of causeItemRefValues) {
      if (!itemRefs.has(ref)) {
        throw new TypeError(`causeのitem refがありません。対象: ${ref}`);
      }
    }
    for (const ref of causeRelationRefValues) {
      if (!relationRefs.has(ref)) {
        throw new TypeError(`causeのrelation refがありません。対象: ${ref}`);
      }
    }
    for (const ref of causeSourceRefValues) {
      if (!sourceRefs.has(ref)) {
        throw new TypeError(`causeのsource refがありません。対象: ${ref}`);
      }
    }
    if (!causeItemRefValues.some((ref) => itemByRef.get(ref)?.nodeId === cause.cause.itemNodeId)) {
      throw new TypeError(
        `causeのitem allowlistにsubject itemがありません。対象: ${cause.causeId}`,
      );
    }
    for (const scope of cause.evidenceScopes) {
      if (!causeSourceRefs.has(scope.sourceRef)) {
        throw new TypeError(
          `causeのevidence source refがallowlistにありません。対象: ${scope.sourceRef}`,
        );
      }
      validateUniqueStrings(scope.roles, `cause ${cause.causeId}のevidence role`);
    }
    const validateOption = (
      option: Readonly<{
        itemRef: PersonalReminderItemRef;
        targetScope: PersonalReminderTargetScope;
        relationRefs: readonly PersonalReminderRelationRef[];
        sourceRefs: readonly PersonalReminderSourceRef[];
      }>,
      label: string,
    ): void => {
      if (!causeItemRefs.has(option.itemRef)) {
        throw new TypeError(
          `${label}のitem refがcause allowlistにありません。対象: ${option.itemRef}`,
        );
      }
      validateUniqueStrings(option.relationRefs, `${label}のrelation ref`);
      validateUniqueStrings(option.sourceRefs, `${label}のsource ref`);
      for (const ref of option.relationRefs) {
        if (!causeRelationRefs.has(ref)) {
          throw new TypeError(`${label}のrelation refがcause allowlistにありません。対象: ${ref}`);
        }
      }
      for (const ref of option.sourceRefs) {
        if (!causeSourceRefs.has(ref)) {
          throw new TypeError(`${label}のsource refがcause allowlistにありません。対象: ${ref}`);
        }
      }
      const targetItem = itemByRef.get(option.itemRef);
      assertNonNullable(targetItem, `${label}のitem refがありません。対象: ${option.itemRef}`);
      validateOptionTargetScope(
        {
          itemNodeId: targetItem.nodeId,
          targetScope: option.targetScope,
        },
        itemByNodeId,
        label,
      );
      validateOptionRelationIntegrity(
        {
          itemNodeId: targetItem.nodeId,
          targetScope: option.targetScope,
          relationIds: option.relationRefs,
        },
        cause.cause,
        relationByRef,
        label,
      );
    };
    for (const option of cause.waitingOptions) {
      validateOption(
        {
          ...option,
          targetScope: resolveTransportTargetScope(
            option.targetScope,
            itemByRef,
            causeItemRefs,
            `waiting option ${option.optionId} of cause ${cause.causeId}`,
          ),
        },
        `waiting option ${option.optionId} of cause ${cause.causeId}`,
      );
    }
    for (const option of cause.duplicateOptions) {
      validateUniqueStrings(
        option.responsible.map((value) => responsibleKey(value)),
        `duplicate option ${option.canonicalCauseId} of cause ${cause.causeId}の責任主体`,
      );
      validateOption(
        {
          ...option,
          targetScope: resolveTransportTargetScope(
            option.targetScope,
            itemByRef,
            causeItemRefs,
            `duplicate option ${option.canonicalCauseId} of cause ${cause.causeId}`,
          ),
        },
        `duplicate option ${option.canonicalCauseId} of cause ${cause.causeId}`,
      );
    }
    for (const ref of causeRelationRefValues) {
      const relation = relationByRef.get(ref);
      assertNonNullable(relation, `causeのrelation refがありません。対象: ${ref}`);
      if (!relationIds.has(relation.id)) {
        throw new TypeError(`causeのrelation IDがtransportにありません。対象: ${relation.id}`);
      }
      if (relation.type === "related_to") {
        throw new TypeError(`causeにrelated_to relationは指定できません。対象: ${relation.id}`);
      }
    }
    for (const ref of causeSourceRefValues) {
      const source = sourceByRef.get(ref);
      assertNonNullable(source, `causeのsource refがありません。対象: ${ref}`);
      if (!sourceIds.has(source.sourceId)) {
        throw new TypeError(`causeのsource IDがtransportにありません。対象: ${source.sourceId}`);
      }
    }
  }
}

/** 未検証値から個人催促AI入力を作成する。 */
export function createPersonalReminderAiInput(value: unknown): PersonalReminderAiInput {
  const parsed = personalReminderAiInputSchema.parse(value);
  validateTransportInputIntegrity(parsed);
  return parsed;
}

/** 個人催促AI入力をcanonical JSONへ直列化する。 */
export function serializePersonalReminderAiInput(input: PersonalReminderAiInput): string {
  return `${serializeCanonicalJson(createPersonalReminderAiInput(input))}\n`;
}
