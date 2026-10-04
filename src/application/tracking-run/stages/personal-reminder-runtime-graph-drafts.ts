import type {
  PersonalReminderCauseAiDependencies,
  PersonalReminderExecutionSurface,
  PersonalReminderResponsible,
} from "../../../domain/personal-reminder-causes.js";
import type {
  PersonalReminderCauseDraft,
  PersonalReminderItem,
} from "../../../domain/personal-reminder-planning.js";
import type { GitHubNodeId } from "../../../domain/types.js";
import type { ReconciledGraphEdge } from "../../../graph/index.js";
import { assertNonNullable } from "../../../util/index.js";
import { compareStrings, createNonEmptySourceIds } from "./personal-reminder-runtime-common.js";
import { candidateEndpointItemByNodeId } from "./personal-reminder-runtime-context-values.js";
import type {
  PersonalReminderGraphDraftProjection,
  PersonalReminderRuntimeContext,
  PersonalReminderRuntimeContextItem,
} from "./personal-reminder-runtime-contracts.js";
import { activeRelationIsEffective } from "./personal-reminder-runtime-relations.js";

function graphRelationSupportRank(
  relation: ReconciledGraphEdge & Readonly<{ active: true }>,
): number {
  if (relation.authoritative) {
    return 0;
  }
  switch (relation.aiDependency.status) {
    case "current":
      return 1;
    case "unverified":
      return 2;
    case "unknown":
      return 3;
    case "not_dependent":
      return 4;
    default:
      throw new TypeError(`implements relationのAI依存状態が不正です。対象: ${relation.id}`);
  }
}

function compareGraphRelationSupport(
  left: ReconciledGraphEdge & Readonly<{ active: true }>,
  right: ReconciledGraphEdge & Readonly<{ active: true }>,
): number {
  const rankDifference = graphRelationSupportRank(left) - graphRelationSupportRank(right);
  return rankDifference === 0 ? compareStrings(left.id, right.id) : rankDifference;
}

function graphRelationAiDependencies(
  relation: ReconciledGraphEdge & Readonly<{ active: true }>,
): PersonalReminderCauseAiDependencies {
  return Object.freeze({
    presence: relation.aiDependency,
    responseMembership: Object.freeze({ status: "not_dependent" }),
    responsible: relation.aiDependency,
    action: Object.freeze({ status: "not_dependent" }),
    evidence: relation.aiDependency,
  });
}

function makeGraphDraft(
  item: PersonalReminderItem,
  relation: ReconciledGraphEdge & Readonly<{ active: true }>,
  authorLogin: string,
  surfaces: readonly PersonalReminderExecutionSurface[],
): PersonalReminderCauseDraft {
  const sourceIds = createNonEmptySourceIds(
    relation.evidence.map((evidence) => evidence.sourceId),
    `implements relation ${relation.id}`,
  );
  const firstSurface = surfaces[0];
  assertNonNullable(
    firstSurface,
    `implements relationのexecution surfaceがありません。対象: ${relation.id}`,
  );
  const surfaceTuple: readonly [
    PersonalReminderExecutionSurface,
    ...PersonalReminderExecutionSurface[],
  ] = [firstSurface, ...surfaces.slice(1)];
  const responsible: PersonalReminderResponsible = Object.freeze({
    kind: "user",
    candidateId: authorLogin,
    role: "assignee",
  });
  const responsibleTuple: readonly [PersonalReminderResponsible, ...PersonalReminderResponsible[]] =
    [responsible];
  return Object.freeze({
    itemNodeId: item.nodeId,
    reasonCode: "work_overdue",
    responsible: responsibleTuple,
    action: Object.freeze({ kind: "work", summary: "実装項目を進める" }),
    evidenceSourceIds: sourceIds,
    responsibilityBasis: Object.freeze({
      sourceIds,
      occurredAt: relation.firstSeenAt,
      precision: "event",
    }),
    responsibility: Object.freeze({
      authority: "semantic",
      scope: Object.freeze({
        kind: "execution_surfaces",
        surfaces: surfaceTuple,
      }),
    }),
    aiDependencies: graphRelationAiDependencies(relation),
  });
}

/** 最終graphの実装関係から原因候補を作る。 */
export function graphDerivedDrafts(
  context: PersonalReminderRuntimeContext,
  item: PersonalReminderRuntimeContextItem,
  localDrafts: readonly PersonalReminderCauseDraft[],
): PersonalReminderGraphDraftProjection {
  if (
    item.item.type !== "issue" ||
    item.item.state !== "open" ||
    item.item.assignees.length !== 0
  ) {
    return Object.freeze({
      drafts: Object.freeze([]),
    });
  }
  const grouped = new Map<
    string,
    { login: string; relations: (ReconciledGraphEdge & Readonly<{ active: true }>)[] }
  >();
  for (const relation of context.graph.activeRelations) {
    if (!activeRelationIsEffective(context.graph, relation) || relation.type !== "implements") {
      continue;
    }
    if (relation.toNodeId !== item.item.nodeId) {
      continue;
    }
    const implementation = candidateEndpointItemByNodeId(context, relation.fromNodeId);
    if (implementation?.type !== "pull_request" || implementation.state !== "open") {
      continue;
    }
    if (implementation.author.status !== "identified" || implementation.author.type !== "human") {
      continue;
    }
    const login = implementation.author.login;
    const key = login.toLowerCase();
    const existing = grouped.get(key);
    if (existing == null) {
      grouped.set(key, { login, relations: [relation] });
    } else {
      existing.relations.push(relation);
    }
  }
  const localWorkActors = new Set(
    localDrafts
      .filter((draft) => draft.action.kind === "work")
      .flatMap((draft) =>
        draft.responsible.map((responsible) => responsible.candidateId.toLowerCase()),
      ),
  );
  const drafts: PersonalReminderCauseDraft[] = [];
  for (const group of [...grouped.values()].sort((left, right) =>
    compareStrings(left.login, right.login),
  )) {
    const firstRelation = [...group.relations].sort(compareGraphRelationSupport)[0];
    assertNonNullable(firstRelation, "graph由来責務のrelationがありません");
    if (localWorkActors.has(group.login.toLowerCase())) {
      continue;
    }
    const surfacesByNodeId = new Map<GitHubNodeId, PersonalReminderExecutionSurface>();
    for (const relation of group.relations) {
      const implementation = candidateEndpointItemByNodeId(context, relation.fromNodeId);
      assertNonNullable(
        implementation,
        `implements relationの実装項目がありません。対象: ${relation.id}`,
      );
      if (implementation.type !== "pull_request") {
        throw new TypeError(`implements relationの実装項目種別が不正です。対象: ${relation.id}`);
      }
      surfacesByNodeId.set(
        implementation.nodeId,
        Object.freeze({ kind: implementation.type, nodeId: implementation.nodeId }),
      );
    }
    const surfaces = [...surfacesByNodeId.values()].sort((left, right) =>
      compareStrings(left.nodeId, right.nodeId),
    );
    drafts.push(makeGraphDraft(item.item, firstRelation, group.login, surfaces));
  }
  return Object.freeze({
    drafts: Object.freeze(drafts),
  });
}
