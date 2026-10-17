import { determineIssuePersonalReminderResponsibilityAuthority } from "../../../domain/issue-state-machine.js";
import type {
  PersonalReminderExecutionSurface,
  PersonalReminderResponsibility,
  PersonalReminderResponsible,
} from "../../../domain/personal-reminder-causes.js";
import type {
  PersonalReminderItem,
  PersonalReminderLocalDecision,
} from "../../../domain/personal-reminder-planning.js";
import { determinePullRequestPersonalReminderResponsibilityAuthority } from "../../../domain/pull-request-state-machine.js";
import type { GitHubNodeId } from "../../../domain/types.js";
import { assertNonNullable } from "../../../util/index.js";
import { compareStrings } from "./personal-reminder-runtime-common.js";
import { isPersonalReminderResponsibleWaitingOn } from "./personal-reminder-runtime-context-values.js";
import type {
  PersonalReminderRuntimeRelatedContext,
  PersonalReminderRuntimeSource,
} from "./personal-reminder-runtime-contracts.js";

function responsibilitySignature(value: PersonalReminderResponsible): string {
  return `${value.kind}\u0000${value.candidateId.toLowerCase()}\u0000${value.role}`;
}

function createResponsibilityScope(
  item: PersonalReminderItem,
  decision: PersonalReminderLocalDecision,
  sources: readonly PersonalReminderRuntimeSource[],
  relatedContexts: readonly PersonalReminderRuntimeRelatedContext[],
): PersonalReminderResponsibility {
  const waitingSourceIds = new Set(decision.waitingOn.flatMap((waitingOn) => waitingOn.sourceIds));
  const surfaces = new Map<GitHubNodeId, PersonalReminderExecutionSurface>();
  let hasSubjectSource = false;
  for (const source of sources) {
    if (!waitingSourceIds.has(source.source.sourceId)) {
      continue;
    }
    if (source.source.itemNodeId === item.nodeId) {
      hasSubjectSource = true;
      continue;
    }
    const related = relatedContexts.find(
      (context) => context.item.nodeId === source.source.itemNodeId,
    )?.item;
    if (related?.type === "pull_request" || related?.type === "issue") {
      surfaces.set(related.nodeId, Object.freeze({ kind: related.type, nodeId: related.nodeId }));
    }
  }
  const sortedSurfaces = [...surfaces.values()].sort((left, right) =>
    compareStrings(left.nodeId, right.nodeId),
  );
  const firstSurface = sortedSurfaces[0];
  const authority = responsibilityAuthority(item, decision);
  if (firstSurface == null) {
    return Object.freeze({ authority, scope: Object.freeze({ kind: "item" }) });
  }
  const surfaceTuple: readonly [
    PersonalReminderExecutionSurface,
    ...PersonalReminderExecutionSurface[],
  ] = [firstSurface, ...sortedSurfaces.slice(1)];
  const scope = hasSubjectSource
    ? Object.freeze({ kind: "item_and_execution_surfaces", surfaces: surfaceTuple })
    : Object.freeze({ kind: "execution_surfaces", surfaces: surfaceTuple });
  return Object.freeze({ authority, scope });
}

function responsibilityAuthority(
  item: PersonalReminderItem,
  decision: PersonalReminderLocalDecision,
): "fixed" | "semantic" {
  if (item.type === "issue" && decision.deterministicRulesVersion === "issue-v14") {
    return determineIssuePersonalReminderResponsibilityAuthority({ issue: item, decision });
  }
  if (item.type === "pull_request" && decision.deterministicRulesVersion === "pull-request-v12") {
    return determinePullRequestPersonalReminderResponsibilityAuthority(decision);
  }
  throw new TypeError(`個人催促責務のitemとstate decisionが一致しません。対象: ${item.nodeId}`);
}

/** local decisionから責務範囲を作る。 */
export function createResponsibilities(
  item: PersonalReminderItem,
  decision: PersonalReminderLocalDecision,
  sources: readonly PersonalReminderRuntimeSource[],
  relatedContexts: readonly PersonalReminderRuntimeRelatedContext[],
): readonly [PersonalReminderResponsibility, ...PersonalReminderResponsibility[]] | undefined {
  const responsibles = decision.waitingOn
    .filter(isPersonalReminderResponsibleWaitingOn)
    .map((waitingOn) =>
      Object.freeze({
        kind: waitingOn.kind,
        candidateId: waitingOn.candidateId,
        role: waitingOn.role,
      }),
    );
  const firstResponsible = responsibles[0];
  if (firstResponsible == null) {
    return undefined;
  }
  const unique = new Map<string, PersonalReminderResponsible>();
  for (const responsible of responsibles) {
    unique.set(responsibilitySignature(responsible), responsible);
  }
  const sorted = [...unique.values()].sort((left, right) =>
    compareStrings(responsibilitySignature(left), responsibilitySignature(right)),
  );
  const first = sorted[0];
  assertNonNullable(first, `個人催促runtimeの責任主体がありません。対象: ${item.nodeId}`);
  const scope = createResponsibilityScope(item, decision, sources, relatedContexts);
  return Object.freeze([scope]);
}
