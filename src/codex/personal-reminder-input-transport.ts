import { z } from "zod";

import type { ContentDigestPort } from "../application/tracking-run/contracts/content-digest-port.js";
import { serializeCanonicalJson } from "../canonical-json/value.js";
import { PERSONAL_REMINDER_AI_INPUT_SCHEMA_VERSION } from "../domain/personal-reminder-causes.js";
import type { PersonalReminderCauseId } from "../domain/personal-reminder-causes.js";
import type { SourceId } from "../domain/source-id.js";
import type { GitHubNodeId, GraphNodeId } from "../domain/types.js";
import { assertNonNullable } from "../util/index.js";
import type {
  PersonalReminderAiBatchPreparation,
  PersonalReminderAiInput,
  PersonalReminderAiItemContext,
  PersonalReminderAiRelationContext,
  PersonalReminderAiSourceContext,
  PersonalReminderCanonicalRefs,
  PersonalReminderCauseSemanticInput,
  PersonalReminderItemRef,
  PersonalReminderRelationRef,
  PersonalReminderSourceRef,
  PreparedPersonalReminderCauseInput,
} from "./personal-reminder-input-contracts.js";
import {
  personalReminderAiCauseTransportInputSchema,
  personalReminderAiInputSchema,
} from "./personal-reminder-input-contracts.js";
import {
  canonicalResponsible,
  compareStrings,
  countUnicodeCharacters,
  createMapEntry,
  createNonEmptyArray,
  createPersonalReminderCauseSemanticInput,
  uniqueSorted,
} from "./personal-reminder-input-core.js";
import { createPersonalReminderCauseInputFingerprint } from "./personal-reminder-input-assessment.js";
import {
  canonicalRelationContext,
  createTransportTargetScope,
  exceedsPersonalReminderAiTransportCapacity,
  toItemRef,
  toRelationRef,
  toSourceRef,
} from "./personal-reminder-input-transport-mapping.js";
import { serializePersonalReminderAiInput } from "./personal-reminder-input-transport-validation.js";

function cloneSemanticInput(
  input: PersonalReminderCauseSemanticInput,
): PersonalReminderCauseSemanticInput {
  return createPersonalReminderCauseSemanticInput(input);
}

type PersonalReminderTransportInputPreparation =
  | Readonly<{
      status: "prepared";
      input: PersonalReminderAiInput;
      refs: PersonalReminderCanonicalRefs;
      causeInputs: ReadonlyMap<PersonalReminderCauseId, PreparedPersonalReminderCauseInput>;
      itemNodeId: GitHubNodeId;
    }>
  | Readonly<{
      status: "over_capacity";
    }>;

function createTransportInput(
  inputs: readonly PersonalReminderCauseSemanticInput[],
  digest: ContentDigestPort,
): PersonalReminderTransportInputPreparation {
  const itemById = new Map<GraphNodeId, PersonalReminderAiItemContext>();
  const relationById = new Map<string, PersonalReminderAiRelationContext>();
  const sourceById = new Map<SourceId, PersonalReminderAiSourceContext>();
  const rootItemNodeId = inputs[0]?.cause.itemNodeId;
  assertNonNullable(rootItemNodeId, "個人催促AIの原因がありません");
  for (const input of inputs) {
    if (input.completeness.status !== "complete" || input.pendingRelations.length !== 0) {
      throw new TypeError("不完全または未確定relationを含む入力はAI batchへ送れません");
    }
    if (input.cause.itemNodeId !== rootItemNodeId) {
      throw new TypeError("同じitemの原因だけを個人催促AI batchへまとめてください");
    }
    for (const item of input.items) {
      const previous = itemById.get(item.nodeId);
      if (previous != null && serializeCanonicalJson(previous) !== serializeCanonicalJson(item)) {
        throw new TypeError(`同じitem node IDに異なるcontextがあります。対象: ${item.nodeId}`);
      }
      itemById.set(item.nodeId, item);
    }
    for (const relation of input.relations) {
      const canonicalRelation = canonicalRelationContext(relation);
      const previous = relationById.get(canonicalRelation.id);
      if (
        previous != null &&
        serializeCanonicalJson(previous) !== serializeCanonicalJson(canonicalRelation)
      ) {
        throw new TypeError(
          `同じrelation IDに異なるcontextがあります。対象: ${canonicalRelation.id}`,
        );
      }
      relationById.set(canonicalRelation.id, canonicalRelation);
    }
    for (const source of input.sources) {
      const previous = sourceById.get(source.sourceId);
      if (previous != null && serializeCanonicalJson(previous) !== serializeCanonicalJson(source)) {
        throw new TypeError(`同じsource IDに異なるcontextがあります。対象: ${source.sourceId}`);
      }
      sourceById.set(source.sourceId, source);
    }
  }
  const items = [...itemById.values()].sort((left, right) =>
    compareStrings(left.nodeId, right.nodeId),
  );
  const relations = [...relationById.values()].sort((left, right) =>
    compareStrings(left.id, right.id),
  );
  const sources = [...sourceById.values()].sort((left, right) =>
    compareStrings(left.sourceId, right.sourceId),
  );
  const itemRefById = new Map<GraphNodeId, PersonalReminderItemRef>();
  const relationRefById = new Map<string, PersonalReminderRelationRef>();
  const sourceRefById = new Map<SourceId, PersonalReminderSourceRef>();
  for (const [index, item] of items.entries()) {
    itemRefById.set(item.nodeId, toItemRef(index));
  }
  for (const [index, relation] of relations.entries()) {
    relationRefById.set(relation.id, toRelationRef(index));
  }
  for (const [index, source] of sources.entries()) {
    sourceRefById.set(source.sourceId, toSourceRef(index));
  }
  const rootItem = itemById.get(rootItemNodeId);
  assertNonNullable(rootItem, "原因のitem contextがありません");

  const transportCauses: z.input<typeof personalReminderAiCauseTransportInputSchema>[] = [];
  const causeInputs = new Map<PersonalReminderCauseId, PreparedPersonalReminderCauseInput>();
  const seenCauseIds = new Set<PersonalReminderCauseId>();
  for (const sourceInput of inputs) {
    const input = cloneSemanticInput(sourceInput);
    const causeId = input.cause.causeId;
    if (seenCauseIds.has(causeId)) {
      throw new TypeError(`個人催促原因IDが重複しています。対象: ${causeId}`);
    }
    seenCauseIds.add(causeId);
    const itemRefs = uniqueSorted(input.items, (item) => item.nodeId).map((item) => {
      const ref = itemRefById.get(item.nodeId);
      assertNonNullable(ref, `item refがありません。対象: ${item.nodeId}`);
      return ref;
    });
    const relationRefs = uniqueSorted(input.relations, (relation) => relation.id).map(
      (relation) => {
        const ref = relationRefById.get(relation.id);
        assertNonNullable(ref, `relation refがありません。対象: ${relation.id}`);
        return ref;
      },
    );
    const sourceRefs = uniqueSorted(input.sources, (source) => source.sourceId).map((source) => {
      const ref = sourceRefById.get(source.sourceId);
      assertNonNullable(ref, `source refがありません。対象: ${source.sourceId}`);
      return ref;
    });
    const evidenceScopes = uniqueSorted(input.evidenceScopes, (scope) => scope.sourceId).map(
      (scope) => {
        const sourceRef = sourceRefById.get(scope.sourceId);
        assertNonNullable(
          sourceRef,
          `evidence scopeのsource refがありません。対象: ${scope.sourceId}`,
        );
        const [firstRole, ...restRoles] = createNonEmptyArray(
          uniqueSorted(scope.roles, (role) => role),
          "evidence scopeのroleがありません",
        );
        return {
          sourceRef,
          roles: [firstRole, ...restRoles],
        };
      },
    );
    const waitingOptions = uniqueSorted(input.waitingOptions, (option) => option.optionId).map(
      (option) => {
        const itemRef = itemRefById.get(option.itemNodeId);
        assertNonNullable(
          itemRef,
          `waiting optionのitem refがありません。対象: ${option.itemNodeId}`,
        );
        const relationRefsForOption = uniqueSorted(
          option.relationIds,
          (relationId) => relationId,
        ).map((relationId) => {
          const relationRef = relationRefById.get(relationId);
          assertNonNullable(
            relationRef,
            `waiting optionのrelation refがありません。対象: ${relationId}`,
          );
          return relationRef;
        });
        const sourceRefsForOption = uniqueSorted(
          option.evidenceSourceIds,
          (sourceId) => sourceId,
        ).map((sourceId) => {
          const sourceRef = sourceRefById.get(sourceId);
          assertNonNullable(sourceRef, `waiting optionのsource refがありません。対象: ${sourceId}`);
          return sourceRef;
        });
        const [firstSource, ...restSources] = createNonEmptyArray(
          sourceRefsForOption,
          "waiting optionのsourceがありません",
        );
        return {
          optionId: option.optionId,
          itemRef,
          targetScope: createTransportTargetScope(
            option.targetScope,
            itemRefById,
            `waiting option ${option.optionId}`,
          ),
          action: option.action,
          relationRefs: relationRefsForOption,
          sourceRefs: [firstSource, ...restSources],
        };
      },
    );
    const duplicateOptions = uniqueSorted(
      input.duplicateOptions,
      (option) => option.canonicalCauseId,
    ).map((option) => {
      const itemRef = itemRefById.get(option.itemNodeId);
      assertNonNullable(
        itemRef,
        `duplicate optionのitem refがありません。対象: ${option.itemNodeId}`,
      );
      const relationRefsForOption = uniqueSorted(
        option.relationIds,
        (relationId) => relationId,
      ).map((relationId) => {
        const relationRef = relationRefById.get(relationId);
        assertNonNullable(
          relationRef,
          `duplicate optionのrelation refがありません。対象: ${relationId}`,
        );
        return relationRef;
      });
      const sourceRefsForOption = uniqueSorted(
        option.evidenceSourceIds,
        (sourceId) => sourceId,
      ).map((sourceId) => {
        const sourceRef = sourceRefById.get(sourceId);
        assertNonNullable(sourceRef, `duplicate optionのsource refがありません。対象: ${sourceId}`);
        return sourceRef;
      });
      const [firstRelation, ...restRelations] = createNonEmptyArray(
        relationRefsForOption,
        "duplicate optionのrelationがありません",
      );
      const [firstSource, ...restSources] = createNonEmptyArray(
        sourceRefsForOption,
        "duplicate optionのsourceがありません",
      );
      const [firstResponsible, ...restResponsible] = createNonEmptyArray(
        canonicalResponsible(option.responsible),
        "duplicate optionの責任主体がありません",
      );
      return {
        canonicalCauseId: option.canonicalCauseId,
        itemRef,
        targetScope: createTransportTargetScope(
          option.targetScope,
          itemRefById,
          `duplicate option ${option.canonicalCauseId}`,
        ),
        responsible: [firstResponsible, ...restResponsible],
        action: option.action,
        relationRefs: [firstRelation, ...restRelations],
        sourceRefs: [firstSource, ...restSources],
      };
    });
    const [firstItemRef, ...restItemRefs] = createNonEmptyArray(
      itemRefs,
      "原因のitem refがありません",
    );
    const [firstSourceRef, ...restSourceRefs] = createNonEmptyArray(
      sourceRefs,
      "原因のsource refがありません",
    );
    transportCauses.push({
      causeId,
      cause: input.cause,
      completeness: input.completeness,
      itemRefs: [firstItemRef, ...restItemRefs],
      relationRefs,
      sourceRefs: [firstSourceRef, ...restSourceRefs],
      evidenceScopes,
      waitingOptions,
      duplicateOptions,
    });
    causeInputs.set(
      causeId,
      Object.freeze({
        input,
        inputFingerprint: createPersonalReminderCauseInputFingerprint(input, digest),
      }),
    );
  }

  if (
    exceedsPersonalReminderAiTransportCapacity(
      transportCauses,
      relations,
      items.length,
      sources.length,
    )
  ) {
    return Object.freeze({
      status: "over_capacity",
    });
  }

  const transportInput = personalReminderAiInputSchema.parse({
    schemaVersion: PERSONAL_REMINDER_AI_INPUT_SCHEMA_VERSION,
    item: {
      nodeId: rootItem.nodeId,
      url: rootItem.url,
    },
    causes: transportCauses,
    items: items.map((item, index) => ({
      ref: toItemRef(index),
      item,
    })),
    relations: relations.map((relation, index) => ({
      ref: toRelationRef(index),
      relation,
    })),
    sources: sources.map((source, index) => ({
      ref: toSourceRef(index),
      source,
    })),
  });
  const refs: PersonalReminderCanonicalRefs = Object.freeze({
    items: new Map(items.map((item, index) => createMapEntry(toItemRef(index), item.nodeId))),
    relations: new Map(
      relations.map((relation, index) => createMapEntry(toRelationRef(index), relation.id)),
    ),
    sources: new Map(
      sources.map((source, index) => createMapEntry(toSourceRef(index), source.sourceId)),
    ),
  });
  return Object.freeze({
    status: "prepared",
    input: transportInput,
    refs,
    causeInputs,
    itemNodeId: rootItemNodeId,
  });
}

/** 同じitemの原因入力を一つの専用AI batchへまとめる。 */
export function preparePersonalReminderAiBatch(
  inputs: readonly [PersonalReminderCauseSemanticInput, ...PersonalReminderCauseSemanticInput[]],
  digest: ContentDigestPort,
): PersonalReminderAiBatchPreparation {
  if (inputs.length === 0) {
    throw new TypeError("個人催促AI batchの原因がありません");
  }
  const normalizedInputs = inputs
    .map((value) => createPersonalReminderCauseSemanticInput(value))
    .sort((left, right) => compareStrings(left.cause.causeId, right.cause.causeId));
  const transport = createTransportInput(normalizedInputs, digest);
  if (transport.status === "over_capacity") {
    return transport;
  }
  const normalizedInput = serializePersonalReminderAiInput(transport.input);
  const batchInputFingerprint = digest.sha256Utf8(serializeCanonicalJson(transport.input));
  return Object.freeze({
    status: "prepared",
    batch: Object.freeze({
      id: `personal-reminder-batch:${batchInputFingerprint}`,
      itemNodeId: transport.itemNodeId,
      input: transport.input,
      normalizedInput,
      inputCharacters: countUnicodeCharacters(normalizedInput),
      batchInputFingerprint,
      refs: transport.refs,
      causeInputs: transport.causeInputs,
    }),
  });
}
