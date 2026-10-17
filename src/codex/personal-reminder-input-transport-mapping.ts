import { z } from "zod";

import type { GraphNodeId } from "../domain/types.js";
import { assertNonNullable } from "../util/index.js";
import type {
  PersonalReminderAiItemContext,
  PersonalReminderAiRelationContext,
  PersonalReminderItemRef,
  PersonalReminderRelationRef,
  PersonalReminderSourceRef,
  PersonalReminderTargetScope,
  PersonalReminderTargetScopeTransport,
} from "./personal-reminder-input-contracts.js";
import {
  PERSONAL_REMINDER_AI_TRANSPORT_LIMITS,
  githubNodeIdSchema,
  personalReminderAiCauseTransportInputSchema,
  personalReminderAiRelationContextSchema,
  personalReminderItemRefSchema,
  personalReminderRelationRefSchema,
  personalReminderSourceRefSchema,
} from "./personal-reminder-input-contracts.js";
import { uniqueSorted } from "./personal-reminder-input-core.js";

/** 連番からitem refを作成する。 */
export function toItemRef(index: number): PersonalReminderItemRef {
  return personalReminderItemRefSchema.parse(`item:${index.toString()}`);
}

/** 連番からrelation refを作成する。 */
export function toRelationRef(index: number): PersonalReminderRelationRef {
  return personalReminderRelationRefSchema.parse(`relation:${index.toString()}`);
}

/** 連番からsource refを作成する。 */
export function toSourceRef(index: number): PersonalReminderSourceRef {
  return personalReminderSourceRefSchema.parse(`source:${index.toString()}`);
}

/** 対象範囲をtransport参照へ変換する。 */
export function createTransportTargetScope(
  scope: PersonalReminderTargetScope,
  itemRefById: ReadonlyMap<GraphNodeId, PersonalReminderItemRef>,
  label: string,
): PersonalReminderTargetScopeTransport {
  if (scope.kind === "item") {
    return { kind: "item" };
  }
  const surfaces = uniqueSorted(
    scope.surfaces,
    (value) => `${value.kind}\u0000${value.nodeId}`,
  ).map((surface) => {
    const itemRef = itemRefById.get(surface.nodeId);
    assertNonNullable(
      itemRef,
      `${label}のexecution surface item refがありません。対象: ${surface.nodeId}`,
    );
    return { kind: surface.kind, itemRef };
  });
  if (scope.kind === "execution_surfaces") {
    return { kind: "execution_surfaces", surfaces };
  }
  return { kind: "item_and_execution_surfaces", surfaces };
}

/** transport参照から対象範囲を復元する。 */
export function resolveTransportTargetScope(
  scope: PersonalReminderTargetScopeTransport,
  itemByRef: ReadonlyMap<PersonalReminderItemRef, PersonalReminderAiItemContext>,
  causeItemRefs: ReadonlySet<PersonalReminderItemRef>,
  label: string,
): PersonalReminderTargetScope {
  if (scope.kind === "item") {
    return { kind: "item" };
  }
  const surfaces = scope.surfaces.map((surface) => {
    if (!causeItemRefs.has(surface.itemRef)) {
      throw new TypeError(
        `${label}のexecution surface item refがcause allowlistにありません。対象: ${surface.itemRef}`,
      );
    }
    const item = itemByRef.get(surface.itemRef);
    assertNonNullable(item, `${label}のexecution surface item refがありません`);
    if (
      (surface.kind === "issue" && item.type !== "issue") ||
      (surface.kind === "pull_request" && item.type !== "pull_request")
    ) {
      throw new TypeError(`${label}のexecution surface種別がitem contextと一致しません`);
    }
    return { kind: surface.kind, nodeId: githubNodeIdSchema.parse(item.nodeId) };
  });
  if (scope.kind === "execution_surfaces") {
    return { kind: "execution_surfaces", surfaces };
  }
  return { kind: "item_and_execution_surfaces", surfaces };
}

/** relation contextを正規化する。 */
export function canonicalRelationContext(
  relation: PersonalReminderAiRelationContext,
): PersonalReminderAiRelationContext {
  return personalReminderAiRelationContextSchema.parse({
    ...relation,
    evidenceSourceIds: uniqueSorted(relation.evidenceSourceIds, (sourceId) => sourceId),
  });
}

/** 個人催促AI transportの容量超過を判定する。 */
export function exceedsPersonalReminderAiTransportCapacity(
  causes: readonly z.input<typeof personalReminderAiCauseTransportInputSchema>[],
  relations: readonly PersonalReminderAiRelationContext[],
  itemCount: number,
  sourceCount: number,
): boolean {
  if (
    causes.length > PERSONAL_REMINDER_AI_TRANSPORT_LIMITS.causes ||
    itemCount > PERSONAL_REMINDER_AI_TRANSPORT_LIMITS.items ||
    relations.length > PERSONAL_REMINDER_AI_TRANSPORT_LIMITS.relations ||
    sourceCount > PERSONAL_REMINDER_AI_TRANSPORT_LIMITS.sources
  ) {
    return true;
  }
  for (const relation of relations) {
    if (
      relation.evidenceSourceIds.length > PERSONAL_REMINDER_AI_TRANSPORT_LIMITS.nestedReferenceIds
    ) {
      return true;
    }
  }
  for (const cause of causes) {
    if (
      cause.itemRefs.length > PERSONAL_REMINDER_AI_TRANSPORT_LIMITS.items ||
      cause.relationRefs.length > PERSONAL_REMINDER_AI_TRANSPORT_LIMITS.relations ||
      cause.sourceRefs.length > PERSONAL_REMINDER_AI_TRANSPORT_LIMITS.sources ||
      cause.evidenceScopes.length > PERSONAL_REMINDER_AI_TRANSPORT_LIMITS.sources ||
      cause.waitingOptions.length > PERSONAL_REMINDER_AI_TRANSPORT_LIMITS.waitingOptions ||
      cause.duplicateOptions.length > PERSONAL_REMINDER_AI_TRANSPORT_LIMITS.duplicateOptions
    ) {
      return true;
    }
    for (const option of [...cause.waitingOptions, ...cause.duplicateOptions]) {
      if (
        option.relationRefs.length > PERSONAL_REMINDER_AI_TRANSPORT_LIMITS.nestedReferenceIds ||
        option.sourceRefs.length > PERSONAL_REMINDER_AI_TRANSPORT_LIMITS.nestedReferenceIds ||
        (option.targetScope.kind !== "item" &&
          option.targetScope.surfaces.length >
            PERSONAL_REMINDER_AI_TRANSPORT_LIMITS.nestedReferenceIds)
      ) {
        return true;
      }
    }
  }
  return false;
}
