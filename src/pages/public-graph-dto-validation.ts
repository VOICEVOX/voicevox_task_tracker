import { isTerminalStatus } from "../domain/status.js";
import { assertNonNullable } from "../util/index.js";
import { PublicDtoSemanticError } from "./errors.js";
import type {
  PublicDetailsDto,
  PublicGraphEdgeDto,
  PublicGraphNodeDto,
  PublicItemSummaryDto,
} from "./public-dto-contracts.js";
import { compareStrings } from "./public-dto-primitives.js";
import {
  parsePublicItemDisplayReference,
  parsePublicItemUrl,
} from "./public-history-dto-validation.js";
import {
  assertPublicItemSummarySemantics,
  assertPublicUniqueSortedIds,
  comparePublicCurrentImplementations,
} from "./public-reminder-dto-validation.js";

export function assertPublicNativeGraphEdgeCurrentness(edges: readonly PublicGraphEdgeDto[]): void {
  for (const edge of edges) {
    if (edge.provenance === "native" && edge.aiCurrentness !== "not_dependent") {
      throw new PublicDtoSemanticError(
        `native graph edge ${edge.id}のAI現在性はnot_dependentでなければなりません`,
      );
    }
  }
}

export function assertPublicUnverifiedRelationSemantics(details: PublicDetailsDto): void {
  const itemsByNodeId = new Map(details.items.map((item) => [item.summary.nodeId, item.summary]));
  const activeSupportsByMeaning = new Map<string, PublicGraphEdgeDto[]>();
  for (const edge of details.graph.edges) {
    if (!edge.active) {
      continue;
    }
    const meaningKey = JSON.stringify([edge.type, edge.fromNodeId, edge.toNodeId]);
    const supports = activeSupportsByMeaning.get(meaningKey);
    if (supports == null) {
      activeSupportsByMeaning.set(meaningKey, [edge]);
    } else {
      supports.push(edge);
    }
  }
  for (const supports of activeSupportsByMeaning.values()) {
    if (supports.some((edge) => edge.aiCurrentness !== "unverified")) {
      continue;
    }
    const firstSupport = supports[0];
    assertNonNullable(firstSupport, "active relation supportがありません");
    for (const nodeId of [firstSupport.fromNodeId, firstSupport.toNodeId]) {
      const item = itemsByNodeId.get(nodeId);
      if (item == null) {
        continue;
      }
      if (!item.aiAnalysis.unverifiedValues.includes("relations")) {
        throw new PublicDtoSemanticError(
          `AI未検証supportだけを持つactive relation ${firstSupport.id}の項目 ${nodeId}にAI未検証値relationsがありません`,
        );
      }
    }
  }
}

export function assertPublicUnverifiedBlockerSemantics(details: PublicDetailsDto): void {
  const graphNodeStates = new Map<string, PublicGraphNodeDto["state"]>();
  for (const node of details.graph.nodes) {
    if (graphNodeStates.has(node.nodeId)) {
      throw new PublicDtoSemanticError(`details graphのnode ID ${node.nodeId}が重複しています`);
    }
    graphNodeStates.set(node.nodeId, node.state);
  }
  for (const item of details.items) {
    assertPublicItemSummarySemantics(item.summary);
    assertPublicUniqueSortedIds(
      item.blockerUnverifiedReasons.map((entry) => entry.nodeId),
      `item ${item.summary.nodeId}のblocker未検証理由のnode ID`,
    );
    const blockerUnverifiedReasonOrder: readonly (typeof item.blockerUnverifiedReasons)[number]["reasons"][number][] =
      ["relation_support", "retained_waiting", "waiting_value"];
    const reasonsByNodeId = new Map<
      string,
      Set<(typeof item.blockerUnverifiedReasons)[number]["reasons"][number]>
    >();
    for (const entry of item.blockerUnverifiedReasons) {
      if (new Set(entry.reasons).size !== entry.reasons.length) {
        throw new PublicDtoSemanticError(
          `item ${item.summary.nodeId}のblocker ${entry.nodeId}の未検証理由が重複しています`,
        );
      }
      let previousReason: (typeof entry.reasons)[number] | undefined;
      for (const reason of entry.reasons) {
        if (
          previousReason != null &&
          blockerUnverifiedReasonOrder.indexOf(previousReason) >=
            blockerUnverifiedReasonOrder.indexOf(reason)
        ) {
          throw new PublicDtoSemanticError(
            `item ${item.summary.nodeId}のblocker ${entry.nodeId}の未検証理由が固定順ではありません`,
          );
        }
        previousReason = reason;
      }
      reasonsByNodeId.set(entry.nodeId, new Set(entry.reasons));
    }
    const supportsByMeaning = new Map<string, PublicGraphEdgeDto[]>();
    for (const edge of details.graph.edges) {
      if (
        !edge.active ||
        edge.type !== "blocks" ||
        edge.toNodeId !== item.summary.nodeId ||
        graphNodeStates.get(edge.fromNodeId) !== "open" ||
        graphNodeStates.get(edge.toNodeId) !== "open"
      ) {
        continue;
      }
      const meaningKey = JSON.stringify([edge.type, edge.fromNodeId, edge.toNodeId]);
      const existing = supportsByMeaning.get(meaningKey);
      if (existing == null) {
        supportsByMeaning.set(meaningKey, [edge]);
      } else {
        existing.push(edge);
      }
    }
    const expectedBlockerNodeIds = new Set<string>();
    const effectiveUnverifiedBlockerNodeIds = new Set<string>();
    for (const meaningSupports of supportsByMeaning.values()) {
      const firstSupport = meaningSupports[0];
      assertNonNullable(firstSupport, "blocks supportがありません");
      expectedBlockerNodeIds.add(firstSupport.fromNodeId);
      let allUnverified = true;
      for (const support of meaningSupports) {
        if (support.aiCurrentness !== "unverified") {
          allUnverified = false;
        }
      }
      if (allUnverified) {
        effectiveUnverifiedBlockerNodeIds.add(firstSupport.fromNodeId);
      }
    }
    const waitingBlockerNodeIds = new Set<string>();
    if (item.summary.status === "waiting_for_unblock") {
      for (const waitingOn of item.summary.waitingOn) {
        if (waitingOn.kind !== "item" || waitingOn.role !== "dependency") {
          continue;
        }
        if (!graphNodeStates.has(waitingOn.candidateId)) {
          throw new PublicDtoSemanticError(
            `item ${item.summary.nodeId}のwaitingOn項目 ${waitingOn.candidateId}を公開項目またはexternal referenceへ解決できません`,
          );
        }
        waitingBlockerNodeIds.add(waitingOn.candidateId);
      }
    }
    const retainedOnlyBlockerNodeIds = new Set(
      item.summary.repositoryFreshness === "stale"
        ? [...waitingBlockerNodeIds].filter((nodeId) => !expectedBlockerNodeIds.has(nodeId))
        : [],
    );
    for (const nodeId of waitingBlockerNodeIds) {
      expectedBlockerNodeIds.add(nodeId);
    }
    const expectedBlockerNodeIdValues = [...expectedBlockerNodeIds].sort(compareStrings);
    if (
      expectedBlockerNodeIdValues.length !== item.summary.blockerNodeIds.length ||
      expectedBlockerNodeIdValues.some(
        (nodeId, index) => nodeId !== item.summary.blockerNodeIds[index],
      )
    ) {
      throw new PublicDtoSemanticError(
        `item ${item.summary.nodeId}のblocker node IDが有効なblockerと保持中の待ち相手から導出した集合と一致しません`,
      );
    }
    for (const blockerNodeId of reasonsByNodeId.keys()) {
      if (!expectedBlockerNodeIds.has(blockerNodeId)) {
        throw new PublicDtoSemanticError(
          `item ${item.summary.nodeId}のblocker未検証理由のnode IDがblocker node IDの部分集合ではありません`,
        );
      }
    }
    const nodeIdsForReason = (
      reason: (typeof item.blockerUnverifiedReasons)[number]["reasons"][number],
    ): Set<string> =>
      new Set(
        [...reasonsByNodeId.entries()]
          .filter(([, reasons]) => reasons.has(reason))
          .map(([nodeId]) => nodeId),
      );
    const relationSupportReasonNodeIds = nodeIdsForReason("relation_support");
    if (
      relationSupportReasonNodeIds.size !== effectiveUnverifiedBlockerNodeIds.size ||
      [...effectiveUnverifiedBlockerNodeIds].some(
        (nodeId) => !relationSupportReasonNodeIds.has(nodeId),
      )
    ) {
      throw new PublicDtoSemanticError(
        `item ${item.summary.nodeId}のrelation_support理由がAI未検証の有効blockerと一致しません`,
      );
    }
    const retainedWaitingReasonNodeIds = nodeIdsForReason("retained_waiting");
    if (
      retainedWaitingReasonNodeIds.size !== retainedOnlyBlockerNodeIds.size ||
      [...retainedOnlyBlockerNodeIds].some((nodeId) => !retainedWaitingReasonNodeIds.has(nodeId))
    ) {
      throw new PublicDtoSemanticError(
        `item ${item.summary.nodeId}のretained_waiting理由が保持中blockerと一致しません`,
      );
    }
    const waitingValueReasonNodeIds = nodeIdsForReason("waiting_value");
    if (
      waitingValueReasonNodeIds.size !== 0 &&
      (waitingValueReasonNodeIds.size !== waitingBlockerNodeIds.size ||
        [...waitingBlockerNodeIds].some((nodeId) => !waitingValueReasonNodeIds.has(nodeId)))
    ) {
      throw new PublicDtoSemanticError(
        `item ${item.summary.nodeId}のwaiting_value理由は待ち相手すべてに付与するか省略してください`,
      );
    }
    if (
      effectiveUnverifiedBlockerNodeIds.size > 0 &&
      !item.summary.aiAnalysis.unverifiedValues.includes("blockers")
    ) {
      throw new PublicDtoSemanticError(
        `item ${item.summary.nodeId}のAI未検証blocks supportに対応するAI未検証値blockersがありません`,
      );
    }
    if (
      retainedOnlyBlockerNodeIds.size > 0 &&
      !item.summary.aiAnalysis.unverifiedValues.includes("waitingOn")
    ) {
      throw new PublicDtoSemanticError(
        `item ${item.summary.nodeId}の保持中blockerに対応するAI未検証値waitingOnがありません`,
      );
    }
    if (
      waitingValueReasonNodeIds.size > 0 &&
      !item.summary.aiAnalysis.unverifiedValues.includes("waitingOn")
    ) {
      throw new PublicDtoSemanticError(
        `item ${item.summary.nodeId}のwaiting_value理由に対応するAI未検証値waitingOnがありません`,
      );
    }
    if (
      waitingBlockerNodeIds.size > 0 &&
      retainedOnlyBlockerNodeIds.size === 0 &&
      item.summary.aiAnalysis.unverifiedValues.includes("waitingOn") &&
      waitingValueReasonNodeIds.size === 0
    ) {
      throw new PublicDtoSemanticError(
        `item ${item.summary.nodeId}のAI未検証値waitingOnに対応するwaiting_value理由がありません`,
      );
    }
    const primaryWaitingOn = item.summary.waitingOn[0];
    if (
      item.summary.status === "waiting_for_unblock" &&
      primaryWaitingOn?.kind === "item" &&
      primaryWaitingOn.role === "dependency" &&
      retainedOnlyBlockerNodeIds.has(primaryWaitingOn.candidateId) &&
      (!item.summary.aiAnalysis.unverifiedValues.includes("primaryWaitingOn") ||
        !item.summary.aiAnalysis.unverifiedValues.includes("nextAction"))
    ) {
      throw new PublicDtoSemanticError(
        `item ${item.summary.nodeId}の保持中primary blockerに対応するAI未検証値がありません`,
      );
    }
    if (
      retainedOnlyBlockerNodeIds.size > 0 &&
      supportsByMeaning.size === 0 &&
      !item.summary.aiAnalysis.unverifiedValues.includes("status")
    ) {
      throw new PublicDtoSemanticError(
        `item ${item.summary.nodeId}の有効なblockerがないwaiting_for_unblockにAI未検証値statusがありません`,
      );
    }
  }
}

export function assertPublicCurrentImplementations(items: readonly PublicItemSummaryDto[]): void {
  const summaryItemsByNodeId = new Map(items.map((item) => [item.nodeId, item]));
  for (const item of items) {
    if (item.type !== "issue" || item.state !== "open") {
      if (item.currentImplementations.length !== 0) {
        throw new PublicDtoSemanticError(
          `Issue以外またはopenでないIssue ${item.nodeId}にcurrentImplementationsがあります`,
        );
      }
      continue;
    }
    if (item.currentImplementations.length !== 0 && isTerminalStatus(item.status)) {
      throw new PublicDtoSemanticError(
        `Issue ${item.nodeId}はGitHub stateがopenなのにterminal statusでcurrentImplementationsを持っています`,
      );
    }
    const implementationNodeIds = new Set<string>();
    for (const [index, implementation] of item.currentImplementations.entries()) {
      if (implementationNodeIds.has(implementation.nodeId)) {
        throw new PublicDtoSemanticError(
          `Issue ${item.nodeId}のcurrentImplementationsにPR ${implementation.nodeId}が重複しています`,
        );
      }
      implementationNodeIds.add(implementation.nodeId);
      const previous = item.currentImplementations[index - 1];
      if (previous != null && comparePublicCurrentImplementations(previous, implementation) > 0) {
        throw new PublicDtoSemanticError(
          `Issue ${item.nodeId}のcurrentImplementationsが決定論的な順序になっていません`,
        );
      }
      const implementationSummary = summaryItemsByNodeId.get(implementation.nodeId);
      if (implementationSummary?.type !== "pull_request") {
        throw new PublicDtoSemanticError(
          `Issue ${item.nodeId}のcurrentImplementationsに対応するopen PR summaryがありません`,
        );
      }
      if (implementationSummary.state !== "open") {
        throw new PublicDtoSemanticError(
          `Issue ${item.nodeId}のcurrentImplementationsに対応するopen PR summaryがありません`,
        );
      }
      if (isTerminalStatus(implementationSummary.status)) {
        throw new PublicDtoSemanticError(
          `PR ${implementation.nodeId}はGitHub stateがopenなのにterminal statusでcurrentImplementationsに含まれています`,
        );
      }
      if (
        item.repositoryFreshness !== "fresh" ||
        implementationSummary.repositoryFreshness !== "fresh"
      ) {
        throw new PublicDtoSemanticError(
          `Issue ${item.nodeId}のcurrentImplementationsに対応するPR repositoryがfreshではありません`,
        );
      }
      const displayIdentity = parsePublicItemDisplayReference(implementation.displayReference);
      const urlIdentity = parsePublicItemUrl(implementation.url);
      if (
        urlIdentity.type !== "pull_request" ||
        displayIdentity.owner !== urlIdentity.owner ||
        displayIdentity.repository !== urlIdentity.repository ||
        displayIdentity.number !== urlIdentity.number ||
        implementation.number !== displayIdentity.number ||
        implementation.repositoryId !== implementationSummary.repositoryId ||
        implementation.displayReference !== implementationSummary.displayReference ||
        implementation.number !== implementationSummary.number ||
        implementation.url !== implementationSummary.url ||
        implementation.title !== implementationSummary.title ||
        implementation.status !== implementationSummary.status ||
        JSON.stringify(implementation.waitingOn) !==
          JSON.stringify(implementationSummary.waitingOn) ||
        implementation.nextAction !== implementationSummary.nextAction
      ) {
        throw new PublicDtoSemanticError(
          `Issue ${item.nodeId}のcurrentImplementationsとPR ${implementation.nodeId}のsummaryが一致しません`,
        );
      }
    }
  }
}
