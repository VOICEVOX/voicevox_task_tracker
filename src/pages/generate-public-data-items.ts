import { isTerminalStatus, type NaturalLanguageDeadlineAssessmentState } from "../domain/index.js";
import type { FinalGraphProjection } from "../graph/final-graph-projection.js";
import type { SnapshotRepository, StateSnapshot } from "../persistence/index.js";
import { assertNonNullable } from "../util/index.js";
import { PublicDtoSemanticError } from "./errors.js";
import { createPublicAiAnalysis } from "./generate-public-data-ai-analysis.js";
import type {
  PublicCurrentResponseSubjectChangesDto,
  PublicDetailsDto,
  PublicItemSummaryDto,
  PublicPersonalReminderResponseDto,
  PublicSummaryDto,
} from "./public-dto-contracts.js";
import { compareStrings } from "./public-dto-primitives.js";

type PublicWaitingOn = PublicItemSummaryDto["waitingOn"][number];
type PublicCurrentImplementation = PublicItemSummaryDto["currentImplementations"][number];
type PublicPersonalReminderCausePlanningStatus =
  PublicItemSummaryDto["personalReminderCausePlanningStatus"];
type PublicPersonalReminderResponse = PublicPersonalReminderResponseDto;

function createPublicWaitingOn(waitingOn: PublicWaitingOn): PublicWaitingOn {
  return {
    kind: waitingOn.kind,
    candidateId: waitingOn.candidateId,
    role: waitingOn.role,
    reasonSummary: waitingOn.reasonSummary,
    confidence: waitingOn.confidence,
  };
}

/** 最新イベントのactorを公開値へ写す。 */
export function createPublicLatestEventActor(
  latestEventActor: StateSnapshot["items"][number]["latestEventActor"],
): PublicDetailsDto["items"][number]["latestEventActor"] {
  if (latestEventActor.status === "absent") {
    return {
      status: latestEventActor.status,
    };
  }
  if (latestEventActor.actor.type === "system") {
    return {
      status: latestEventActor.status,
      actor: {
        type: latestEventActor.actor.type,
        name: latestEventActor.actor.name,
      },
    };
  }
  return {
    status: latestEventActor.status,
    actor: {
      type: latestEventActor.actor.type,
      login: latestEventActor.actor.login,
    },
  };
}

/** 項目ごとの表示用参照を作る。 */
export function createDisplayReferencesByNodeId(
  snapshot: StateSnapshot,
): ReadonlyMap<string, string> {
  const displayReferencesByNodeId = new Map<string, string>();
  for (const item of snapshot.items) {
    displayReferencesByNodeId.set(item.nodeId, item.displayReference);
  }
  for (const reference of snapshot.externalReferences) {
    displayReferencesByNodeId.set(
      reference.nodeId,
      `${reference.repositoryFullName}#${reference.number.toString()}`,
    );
  }
  return displayReferencesByNodeId;
}

function createPublicNextAction(
  item: Pick<StateSnapshot["items"][number], "nextAction" | "waitingOn">,
  displayReferencesByNodeId: ReadonlyMap<string, string>,
): string {
  const candidateIds = [
    ...new Set(
      item.waitingOn
        .filter((waitingOn) => waitingOn.kind === "item")
        .map((waitingOn) => waitingOn.candidateId),
    ),
  ].sort((left, right) => right.length - left.length || compareStrings(left, right));
  let nextAction = item.nextAction;
  for (const candidateId of candidateIds) {
    if (!nextAction.includes(candidateId)) {
      continue;
    }
    const displayReference = displayReferencesByNodeId.get(candidateId);
    if (displayReference == null) {
      throw new PublicDtoSemanticError(
        `nextActionのwaitingOn項目 ${candidateId}をdisplayReferenceへ解決できません`,
      );
    }
    nextAction = nextAction.split(candidateId).join(displayReference);
  }
  return nextAction;
}

/** Issueごとの現在の実装PRを作る。 */
export function createCurrentImplementationsByIssueNodeId(
  snapshot: StateSnapshot,
  repositoriesById: ReadonlyMap<string, SnapshotRepository>,
  displayReferencesByNodeId: ReadonlyMap<string, string>,
): ReadonlyMap<string, readonly PublicCurrentImplementation[]> {
  const itemsByNodeId = new Map<string, StateSnapshot["items"][number]>(
    snapshot.items.map((item) => [item.nodeId, item]),
  );
  const externalNodeIds = new Set<string>(
    snapshot.externalReferences.map((reference) => reference.nodeId),
  );
  const implementationsByIssueNodeId = new Map<string, Map<string, PublicCurrentImplementation>>();
  for (const relation of snapshot.relations) {
    if (!relation.active || relation.type !== "implements" || relation.provenance !== "native") {
      continue;
    }
    if (externalNodeIds.has(relation.fromNodeId) || externalNodeIds.has(relation.toNodeId)) {
      continue;
    }
    const implementation = itemsByNodeId.get(relation.fromNodeId);
    const targetIssue = itemsByNodeId.get(relation.toNodeId);
    assertNonNullable(implementation, `implements relation ${relation.id}の実装項目がありません`);
    assertNonNullable(targetIssue, `implements relation ${relation.id}の対象項目がありません`);
    if (implementation.type !== "pull_request" || targetIssue.type !== "issue") {
      continue;
    }
    if (implementation.state === "open" && isTerminalStatus(implementation.status)) {
      throw new PublicDtoSemanticError(
        `implements relation ${relation.id}の実装PRはGitHub stateがopenなのにterminal statusです`,
      );
    }
    if (targetIssue.state === "open" && isTerminalStatus(targetIssue.status)) {
      throw new PublicDtoSemanticError(
        `implements relation ${relation.id}の対象IssueはGitHub stateがopenなのにterminal statusです`,
      );
    }
    if (implementation.state !== "open" || targetIssue.state !== "open") {
      continue;
    }
    const implementationRepository = repositoriesById.get(implementation.repositoryId);
    const targetRepository = repositoriesById.get(targetIssue.repositoryId);
    assertNonNullable(
      implementationRepository,
      `implements relation ${relation.id}の実装repositoryがありません`,
    );
    assertNonNullable(
      targetRepository,
      `implements relation ${relation.id}の対象repositoryがありません`,
    );
    if (implementationRepository.freshness !== "fresh" || targetRepository.freshness !== "fresh") {
      continue;
    }
    const implementations = implementationsByIssueNodeId.get(targetIssue.nodeId);
    const currentImplementation: PublicCurrentImplementation = {
      nodeId: implementation.nodeId,
      repositoryId: implementation.repositoryId,
      displayReference: implementation.displayReference,
      number: implementation.number,
      url: implementation.url,
      title: implementation.title,
      status: implementation.status,
      waitingOn: implementation.waitingOn.map(createPublicWaitingOn),
      nextAction: createPublicNextAction(implementation, displayReferencesByNodeId),
    };
    if (implementations == null) {
      implementationsByIssueNodeId.set(
        targetIssue.nodeId,
        new Map([[implementation.nodeId, currentImplementation]]),
      );
      continue;
    }
    if (!implementations.has(implementation.nodeId)) {
      implementations.set(implementation.nodeId, currentImplementation);
    }
  }
  return new Map(
    [...implementationsByIssueNodeId.entries()].map(([issueNodeId, implementations]) => [
      issueNodeId,
      Object.freeze(
        [...implementations.values()].sort((left, right) =>
          compareStrings(left.nodeId, right.nodeId),
        ),
      ),
    ]),
  );
}

/** 項目の公開summaryを作る。 */
export function createItemSummary(
  item: StateSnapshot["items"][number],
  repository: SnapshotRepository,
  currentImplementations: readonly PublicCurrentImplementation[],
  currentResponses: readonly PublicPersonalReminderResponse[],
  currentResponsesUnverified: boolean,
  currentResponseSubjectChanges: PublicCurrentResponseSubjectChangesDto,
  personalReminderCausePlanningStatus: PublicPersonalReminderCausePlanningStatus,
  displayReferencesByNodeId: ReadonlyMap<string, string>,
  projectedItem: FinalGraphProjection["items"][number],
  downstreamImpact: PublicItemSummaryDto["downstreamImpact"],
  priorityWeight: number,
): PublicItemSummaryDto {
  return {
    nodeId: item.nodeId,
    type: item.type,
    repositoryId: item.repositoryId,
    displayReference: item.displayReference,
    number: item.number,
    url: item.url,
    title: item.title,
    deadline: createPublicDeadlineSummary(item.deadlineAssessment, projectedItem.deadlineLevel),
    state: item.state,
    author:
      item.author.status === "unavailable"
        ? {
            ...item.author,
          }
        : {
            ...item.author,
            actor: {
              ...item.author.actor,
            },
          },
    assignees: item.assignees.map((assignee) => ({
      ...assignee,
    })),
    status: item.status,
    waitingOn: item.waitingOn.map(createPublicWaitingOn),
    primaryWaitingOn: {
      ...item.primaryWaitingOn,
    },
    nextAction: createPublicNextAction(item, displayReferencesByNodeId),
    severity: item.severity,
    importance: {
      score: item.importance.score,
      level: item.importance.level,
    },
    attention: {
      score: item.attention.score,
      level: item.attention.level,
    },
    priorityWeight,
    aiAnalysis: createPublicAiAnalysis(
      item,
      projectedItem.effectiveBlockerNodeIds,
      projectedItem.retainedOnlyBlockerNodeIds,
    ),
    confidence: item.confidence,
    githubUpdatedAt: item.githubUpdatedAt,
    stallSince: item.stallSince,
    observedAt: item.observedAt,
    repositoryFreshness: repository.freshness,
    blockerNodeIds: [...projectedItem.blockerNodeIds],
    downstreamImpact: {
      ...downstreamImpact,
    },
    currentImplementations: [...currentImplementations],
    currentResponses: [...currentResponses],
    currentResponsesUnverified,
    currentResponseSubjectChanges:
      currentResponseSubjectChanges.scope === "unbounded"
        ? { scope: "unbounded" }
        : {
            scope: "bounded",
            addableSubjects: currentResponseSubjectChanges.addableSubjects.map((subject) => ({
              ...subject,
            })),
            removableSubjects: currentResponseSubjectChanges.removableSubjects.map((subject) => ({
              ...subject,
            })),
          },
    personalReminderCausePlanningStatus,
  };
}

/** summaryとdetailsの個人催促応答の一致を検証する。 */
export function assertPublicSummaryDetailsCurrentResponses(
  summary: PublicSummaryDto,
  details: PublicDetailsDto,
): void {
  const detailsSummariesByNodeId = new Map<string, PublicItemSummaryDto>(
    details.items.map((item) => [item.summary.nodeId, item.summary]),
  );
  for (const item of summary.items) {
    const detailsSummary = detailsSummariesByNodeId.get(item.nodeId);
    assertNonNullable(detailsSummary, `item ${item.nodeId}のdetails summaryがありません`);
    if (item.currentResponsesUnverified !== detailsSummary.currentResponsesUnverified) {
      throw new PublicDtoSemanticError(
        `item ${item.nodeId}のsummaryとdetailsでcurrentResponsesUnverifiedが一致しません`,
      );
    }
    if (
      JSON.stringify(item.currentResponseSubjectChanges) !==
      JSON.stringify(detailsSummary.currentResponseSubjectChanges)
    ) {
      throw new PublicDtoSemanticError(
        `item ${item.nodeId}のsummaryとdetailsでcurrentResponseSubjectChangesが一致しません`,
      );
    }
    if (item.currentResponses.length !== detailsSummary.currentResponses.length) {
      throw new PublicDtoSemanticError(
        `item ${item.nodeId}のsummaryとdetailsでcurrentResponsesの件数が一致しません`,
      );
    }
    for (const response of item.currentResponses) {
      const detailsResponse: PublicPersonalReminderResponse | undefined =
        detailsSummary.currentResponses.find((candidate) => candidate.causeId === response.causeId);
      assertNonNullable(detailsResponse, `item ${item.nodeId}のdetails responseがありません`);
      if (
        response.causeId !== detailsResponse.causeId ||
        response.subjectMembershipUnverified !== detailsResponse.subjectMembershipUnverified
      ) {
        throw new PublicDtoSemanticError(
          `item ${item.nodeId}のsummaryとdetailsでcurrent responseが一致しません`,
        );
      }
    }
  }
}

function createPublicDeadlineSummary(
  assessment: NaturalLanguageDeadlineAssessmentState,
  level: FinalGraphProjection["items"][number]["deadlineLevel"],
): PublicItemSummaryDto["deadline"] {
  if (assessment.status === "not_available") {
    return {
      status: "not_available",
    };
  }
  return {
    status: "available",
    date: assessment.value.date,
    level,
  };
}

/** 項目の公開期限詳細を作る。 */
export function createPublicDeadlineDetails(
  assessment: NaturalLanguageDeadlineAssessmentState,
  level: FinalGraphProjection["items"][number]["deadlineLevel"],
): PublicDetailsDto["items"][number]["deadline"] {
  if (assessment.status === "not_available") {
    return {
      status: "not_available",
    };
  }
  return {
    status: "available",
    date: assessment.value.date,
    level,
    rationale: assessment.value.rationale,
  };
}
