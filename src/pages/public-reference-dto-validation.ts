import { PublicDtoSemanticError } from "./errors.js";
import type {
  PublicDetailsDto,
  PublicItemSummaryDto,
  PublicPersonalReminderResponseDto,
  PublicSummaryDto,
} from "./public-dto-contracts.js";
import { compareStrings } from "./public-dto-primitives.js";

export function assertPublicSummaryWaitingOnReferences(summary: PublicSummaryDto): void {
  const summaryItemNodeIds = new Set(summary.items.map((item) => item.nodeId));
  const externalGraphNodeIds = new Set(
    summary.graph.nodes
      .filter((node) => node.kind === "external_reference")
      .map((node) => node.nodeId),
  );
  const candidateIds = new Set<string>();
  for (const item of summary.items) {
    const waitingOnValues = [
      ...item.waitingOn,
      ...item.currentImplementations.flatMap((implementation) => implementation.waitingOn),
    ];
    for (const waitingOn of waitingOnValues) {
      if (waitingOn.kind === "item") {
        candidateIds.add(waitingOn.candidateId);
      }
    }
    for (const response of item.currentResponses) {
      if (response.status === "waiting") {
        candidateIds.add(response.waitingFor.itemNodeId);
      }
    }
  }
  for (const candidateId of candidateIds) {
    if (summaryItemNodeIds.has(candidateId) || externalGraphNodeIds.has(candidateId)) {
      continue;
    }
    throw new PublicDtoSemanticError(
      `waitingOn項目 ${candidateId}をsummary itemsまたはinitial graphから解決できません`,
    );
  }
}

export function assertPublicDetailsWaitingOnReferences(details: PublicDetailsDto): void {
  const itemNodeIds = new Set(details.items.map((item) => item.summary.nodeId));
  const externalGraphNodeIds = new Set(
    details.graph.nodes
      .filter((node) => node.kind === "external_reference")
      .map((node) => node.nodeId),
  );
  for (const item of details.items) {
    const waitingOnValues = [
      ...item.summary.waitingOn,
      ...item.summary.currentImplementations.flatMap((implementation) => implementation.waitingOn),
    ];
    for (const waitingOn of waitingOnValues) {
      if (
        waitingOn.kind === "item" &&
        !itemNodeIds.has(waitingOn.candidateId) &&
        !externalGraphNodeIds.has(waitingOn.candidateId)
      ) {
        throw new PublicDtoSemanticError(
          `waitingOn項目 ${waitingOn.candidateId}をdetailsの公開項目またはexternal referenceから解決できません`,
        );
      }
    }
  }
}

export function assertPublicCurrentResponseIds(
  items: readonly Readonly<{
    nodeId: string;
    currentResponses: readonly PublicPersonalReminderResponseDto[];
  }>[],
): void {
  const causeIds = new Set<string>();
  for (const item of items) {
    let previousCauseId: string | undefined;
    for (const response of item.currentResponses) {
      if (causeIds.has(response.causeId)) {
        throw new PublicDtoSemanticError(
          `personal reminder responseのcause IDが重複しています。対象: ${response.causeId}`,
        );
      }
      if (previousCauseId != null && compareStrings(previousCauseId, response.causeId) > 0) {
        throw new PublicDtoSemanticError(
          `item ${item.nodeId}のpersonal reminder responseがcause ID順ではありません`,
        );
      }
      causeIds.add(response.causeId);
      previousCauseId = response.causeId;
    }
  }
}

export function assertPublicCurrentResponsesRequireCompletedPlanning(
  items: readonly PublicItemSummaryDto[],
): void {
  for (const item of items) {
    if (item.personalReminderCausePlanningStatus === "completed") {
      continue;
    }
    if (item.currentResponsesUnverified) {
      throw new PublicDtoSemanticError(
        `個人催促planningが完了していない項目に現在の対応の未検証フラグがあります。対象: ${item.nodeId}`,
      );
    }
    if (item.currentResponses.length !== 0) {
      throw new PublicDtoSemanticError(
        `個人催促planningが完了していない項目に現在の対応があります。対象: ${item.nodeId}`,
      );
    }
    if (
      item.currentResponseSubjectChanges.scope !== "bounded" ||
      item.currentResponseSubjectChanges.addableSubjects.length !== 0 ||
      item.currentResponseSubjectChanges.removableSubjects.length !== 0
    ) {
      throw new PublicDtoSemanticError(
        `個人催促planningが完了していない項目に現在対応主体の変化があります。対象: ${item.nodeId}`,
      );
    }
  }
}

export function assertPublicDetailsCurrentResponseReferences(details: PublicDetailsDto): void {
  const graphNodeIds = new Set(details.graph.nodes.map((node) => node.nodeId));
  for (const item of details.items) {
    graphNodeIds.add(item.summary.nodeId);
  }
  for (const item of details.items) {
    for (const response of item.summary.currentResponses) {
      if (response.status !== "waiting") {
        continue;
      }
      if (!graphNodeIds.has(response.waitingFor.itemNodeId)) {
        throw new PublicDtoSemanticError(
          `waiting responseの項目 ${response.waitingFor.itemNodeId}をdetailsから解決できません`,
        );
      }
    }
  }
}
