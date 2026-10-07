import { PublicDtoSemanticError } from "./errors.js";
import type {
  PublicCurrentResponseSubjectDto,
  PublicItemSummaryDto,
  PublicPersonalReminderResponseDto,
} from "./public-dto-contracts.js";
import { compareStrings } from "./public-dto-primitives.js";

export function comparePublicCurrentImplementations(
  left: PublicItemSummaryDto["currentImplementations"][number],
  right: PublicItemSummaryDto["currentImplementations"][number],
): number {
  if (left.nodeId < right.nodeId) {
    return -1;
  }
  if (left.nodeId > right.nodeId) {
    return 1;
  }
  return 0;
}

const publicPersonalReminderUnverifiedValueOrder: readonly PublicPersonalReminderResponseDto["unverifiedValues"][number][] =
  ["status", "responsible", "action", "evidence", "waitingFor"];

function assertPublicPersonalReminderResponses(
  itemNodeId: string,
  responses: readonly PublicPersonalReminderResponseDto[],
): void {
  for (const response of responses) {
    if (new Set(response.unverifiedValues).size !== response.unverifiedValues.length) {
      throw new PublicDtoSemanticError(
        `item ${itemNodeId}のpersonal reminder response ${response.causeId}のAI未検証値が重複しています`,
      );
    }
    let previousValue: PublicPersonalReminderResponseDto["unverifiedValues"][number] | undefined;
    for (const value of response.unverifiedValues) {
      if (previousValue != null) {
        const previousOrder = publicPersonalReminderUnverifiedValueOrder.indexOf(previousValue);
        const currentOrder = publicPersonalReminderUnverifiedValueOrder.indexOf(value);
        if (previousOrder >= currentOrder) {
          throw new PublicDtoSemanticError(
            `item ${itemNodeId}のpersonal reminder response ${response.causeId}のAI未検証値が固定順ではありません`,
          );
        }
      }
      previousValue = value;
    }
    if (response.status !== "waiting" && response.unverifiedValues.includes("waitingFor")) {
      throw new PublicDtoSemanticError(
        `item ${itemNodeId}のwaitingでないpersonal reminder responseにwaitingForのAI未検証値があります`,
      );
    }
    if (
      response.unverifiedValues.includes("waitingFor") &&
      !response.unverifiedValues.includes("status")
    ) {
      throw new PublicDtoSemanticError(
        `item ${itemNodeId}のpersonal reminder responseでwaitingForのAI未検証値にstatusが伴っていません`,
      );
    }
    if (
      response.unverifiedValues.includes("responsible") &&
      response.responsible.some((responsible) => responsible.kind !== "role") &&
      !response.subjectMembershipUnverified
    ) {
      throw new PublicDtoSemanticError(
        `item ${itemNodeId}のpersonal reminder responseでresponsibleのAI未検証値にsubject membershipの未検証が伴っていません`,
      );
    }
  }
}

function publicCurrentResponseSubjectKey(subject: PublicCurrentResponseSubjectDto): string {
  return `${subject.kind}\u0000${subject.candidateId.toLowerCase()}`;
}

function assertPublicCurrentResponseSubjects(
  itemNodeId: string,
  description: string,
  subjects: readonly PublicCurrentResponseSubjectDto[],
): void {
  const keys = subjects.map(publicCurrentResponseSubjectKey);
  if (new Set(keys).size !== keys.length) {
    throw new PublicDtoSemanticError(`item ${itemNodeId}の${description}が重複しています`);
  }
  let previousKey: string | undefined;
  for (const key of keys) {
    if (previousKey != null && compareStrings(previousKey, key) > 0) {
      throw new PublicDtoSemanticError(
        `item ${itemNodeId}の${description}が決定論的な順序になっていません`,
      );
    }
    previousKey = key;
  }
}

function assertPublicCurrentResponseSubjectChanges(item: PublicItemSummaryDto): void {
  const changes = item.currentResponseSubjectChanges;
  if (changes.scope === "unbounded") {
    return;
  }
  assertPublicCurrentResponseSubjects(
    item.nodeId,
    "追加可能な現在対応主体",
    changes.addableSubjects,
  );
  assertPublicCurrentResponseSubjects(
    item.nodeId,
    "削除可能な現在対応主体",
    changes.removableSubjects,
  );
}

const publicUnverifiedValueOrder: readonly PublicItemSummaryDto["aiAnalysis"]["unverifiedValues"][number][] =
  [
    "status",
    "waitingOn",
    "primaryWaitingOn",
    "nextAction",
    "confidence",
    "evidence",
    "uncertainties",
    "deadline",
    "staleness",
    "downstreamImpact",
    "importance",
    "attention",
    "blockers",
    "relations",
  ];

function assertPublicUnverifiedValues(
  itemNodeId: string,
  values: readonly PublicItemSummaryDto["aiAnalysis"]["unverifiedValues"][number][],
): void {
  if (new Set(values).size !== values.length) {
    throw new PublicDtoSemanticError(`item ${itemNodeId}のAI未検証値が重複しています`);
  }
  let previousValue: PublicItemSummaryDto["aiAnalysis"]["unverifiedValues"][number] | undefined;
  for (const value of values) {
    if (previousValue != null) {
      const previousOrder = publicUnverifiedValueOrder.indexOf(previousValue);
      const currentOrder = publicUnverifiedValueOrder.indexOf(value);
      if (previousOrder >= currentOrder) {
        throw new PublicDtoSemanticError(`item ${itemNodeId}のAI未検証値が固定順ではありません`);
      }
    }
    previousValue = value;
  }
}

export function assertPublicUniqueSortedIds(ids: readonly string[], description: string): void {
  if (new Set(ids).size !== ids.length) {
    throw new PublicDtoSemanticError(`${description}が重複しています`);
  }
  let previousId: string | undefined;
  for (const id of ids) {
    if (previousId != null && compareStrings(previousId, id) > 0) {
      throw new PublicDtoSemanticError(`${description}が決定論的な順序になっていません`);
    }
    previousId = id;
  }
}

export function assertPublicItemSummarySemantics(item: PublicItemSummaryDto): void {
  assertPublicUnverifiedValues(item.nodeId, item.aiAnalysis.unverifiedValues);
  assertPublicUniqueSortedIds(item.blockerNodeIds, `item ${item.nodeId}のblocker node ID`);
  if (item.status === "waiting_for_unblock") {
    if (item.primaryWaitingOn.index !== 0) {
      throw new PublicDtoSemanticError(
        `item ${item.nodeId}はwaiting_for_unblockですがprimary waitingOnがありません`,
      );
    }
    const primaryWaitingOn = item.waitingOn[0];
    if (
      primaryWaitingOn?.kind !== "item" ||
      primaryWaitingOn.role !== "dependency" ||
      !item.blockerNodeIds.includes(primaryWaitingOn.candidateId)
    ) {
      throw new PublicDtoSemanticError(
        `item ${item.nodeId}のprimary waitingOnがblocker node IDに含まれていません`,
      );
    }
  }
  assertPublicPersonalReminderResponses(item.nodeId, item.currentResponses);
  assertPublicCurrentResponseSubjectChanges(item);
}
