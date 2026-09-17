import { z } from "zod";

import {
  aiAnalysisElementSchema,
  type AiAnalysisElement,
  type AiAnalysisElementApplication,
} from "./ai-analysis-elements.js";
import type { GitHubNodeId, GraphNodeId } from "./types.js";
import { UnreachableError } from "../util/index.js";

const githubNodeIdSchema = z.string().min(1).regex(/^\S+$/u).brand<"GitHubNodeId">();

const graphNodeIdSchema = z.custom<GraphNodeId>(
  (value) => typeof value === "string" && value.length > 0 && /^\S+$/u.test(value),
  "graph node IDは空にできず空白を含められません",
);

const aiAnalysisDependencyElementSchema = z.enum([
  "status",
  "waitingOn",
  "nextAction",
  "primaryWaitingOn",
  "confidence",
  "evidence",
  "uncertainties",
  "deadline",
  "deadlineLevel",
  "lastProgressAt",
  "stallSince",
  "severity",
  "downstreamImpact",
  "importance",
  "attention",
  "blockers",
  "relationSet",
]);

/** 最終値のAI依存を記録する要素一覧。 */
export const AI_ANALYSIS_DEPENDENCY_ELEMENTS = Object.freeze(
  aiAnalysisDependencyElementSchema.options,
);

export type AiAnalysisDependencyElement = z.output<typeof aiAnalysisDependencyElementSchema>;

type AiAnalysisDependencyProducerBase = Readonly<{
  nodeId: GitHubNodeId;
  element: AiAnalysisElement;
}>;

/** 最終値へ寄与したAI入力のproducer。 */
export type AiAnalysisDependencyProducer =
  | (AiAnalysisDependencyProducerBase &
      Readonly<{
        kind: "item_element";
      }>)
  | Readonly<{
      kind: "relation";
      relationId: string;
      producer: AiAnalysisDependencyProducerBase;
    }>
  | Readonly<{
      kind: "relation_candidate";
      candidateId: string;
      endpointNodeIds: readonly [GraphNodeId, GraphNodeId];
      producer: Readonly<{
        nodeId: GitHubNodeId;
        element: "relations";
      }>;
    }>;

export type AiAnalysisDependencyUnknownReason =
  "migration" | "not_recorded" | "proof_unknown" | "stale_repository";

export type AiAnalysisDependency =
  | Readonly<{
      status: "not_dependent";
    }>
  | Readonly<{
      status: "current";
      producers: readonly AiAnalysisDependencyProducer[];
    }>
  | Readonly<{
      status: "unverified";
      producers: readonly AiAnalysisDependencyProducer[];
    }>
  | Readonly<{
      status: "unknown";
      reason: "migration" | "not_recorded" | "stale_repository";
      producers?: readonly AiAnalysisDependencyProducer[] | undefined;
    }>
  | Readonly<{
      status: "unknown";
      reason: "proof_unknown";
      producers: readonly AiAnalysisDependencyProducer[];
    }>;

export type TrackedItemAiDependencies = Readonly<
  Record<AiAnalysisDependencyElement, AiAnalysisDependency>
>;

const dependencyProducerBaseSchema = z.strictObject({
  nodeId: githubNodeIdSchema,
  element: aiAnalysisElementSchema,
});

const relationCandidateEndpointNodeIdsSchema = z
  .tuple([graphNodeIdSchema, graphNodeIdSchema])
  .readonly()
  .superRefine((endpointNodeIds, context) => {
    const first = endpointNodeIds[0];
    const second = endpointNodeIds[1];
    if (first === second) {
      context.addIssue({
        code: "custom",
        message: "relation candidateのendpointが重複しています",
      });
      return;
    }
    if (first > second) {
      context.addIssue({
        code: "custom",
        message: "relation candidateのendpoint順序が正規化されていません",
      });
    }
  });

const relationCandidateProducerSchema = z.strictObject({
  nodeId: githubNodeIdSchema,
  element: z.literal("relations"),
});

export const aiAnalysisDependencyProducerSchema = z.union([
  dependencyProducerBaseSchema.extend({
    kind: z.literal("item_element"),
  }),
  z.strictObject({
    kind: z.literal("relation"),
    relationId: z.string().min(1).regex(/^\S+$/u),
    producer: dependencyProducerBaseSchema,
  }),
  z.strictObject({
    kind: z.literal("relation_candidate"),
    candidateId: z.string().min(1).regex(/^\S+$/u),
    endpointNodeIds: relationCandidateEndpointNodeIdsSchema,
    producer: relationCandidateProducerSchema,
  }),
]);

type DependencyProducerLike =
  | Readonly<{
      kind: "item_element";
      nodeId: string;
      element: AiAnalysisElement;
    }>
  | Readonly<{
      kind: "relation";
      relationId: string;
      producer: Readonly<{
        nodeId: string;
        element: AiAnalysisElement;
      }>;
    }>
  | Readonly<{
      kind: "relation_candidate";
      candidateId: string;
      endpointNodeIds: readonly [string, string];
      producer: Readonly<{
        nodeId: string;
        element: "relations";
      }>;
    }>;

const dependencyProducersSchema = z
  .array(aiAnalysisDependencyProducerSchema)
  .min(1)
  .readonly()
  .superRefine((producers, context) => {
    const signatures = producers.map(producerSignature);
    if (new Set(signatures).size !== signatures.length) {
      context.addIssue({
        code: "custom",
        message: "AI依存producerが重複しています",
      });
    }
  });

const unknownAiAnalysisDependencySchema = z.discriminatedUnion("reason", [
  z.strictObject({
    status: z.literal("unknown"),
    reason: z.literal("migration"),
    producers: dependencyProducersSchema.optional(),
  }),
  z.strictObject({
    status: z.literal("unknown"),
    reason: z.literal("not_recorded"),
    producers: dependencyProducersSchema.optional(),
  }),
  z.strictObject({
    status: z.literal("unknown"),
    reason: z.literal("stale_repository"),
    producers: dependencyProducersSchema.optional(),
  }),
  z.strictObject({
    status: z.literal("unknown"),
    reason: z.literal("proof_unknown"),
    producers: dependencyProducersSchema,
  }),
]);

export const aiAnalysisDependencySchema = z.union([
  z.strictObject({
    status: z.literal("not_dependent"),
  }),
  z.strictObject({
    status: z.literal("current"),
    producers: dependencyProducersSchema,
  }),
  z.strictObject({
    status: z.literal("unverified"),
    producers: dependencyProducersSchema,
  }),
  unknownAiAnalysisDependencySchema,
]);

export const trackedItemAiDependenciesSchema = z.strictObject(
  Object.fromEntries(
    AI_ANALYSIS_DEPENDENCY_ELEMENTS.map((element) => [element, aiAnalysisDependencySchema]),
  ),
);

/** 保存形式上producerlessな移行・未記録入力を否定できないか判定する。 */
export function aiAnalysisDependencyMayContainProducerlessUnrecordedInput(
  dependency: AiAnalysisDependency,
): boolean {
  return (
    dependency.status === "unknown" &&
    (dependency.reason === "migration" || dependency.reason === "not_recorded")
  );
}

function producerSignature(producer: DependencyProducerLike): string {
  if (producer.kind === "item_element") {
    return JSON.stringify([producer.kind, producer.nodeId, producer.element]);
  }
  if (producer.kind === "relation_candidate") {
    return JSON.stringify([
      producer.kind,
      producer.candidateId,
      producer.endpointNodeIds[0],
      producer.endpointNodeIds[1],
      producer.producer.nodeId,
      producer.producer.element,
    ]);
  }
  return JSON.stringify([
    producer.kind,
    producer.relationId,
    producer.producer.nodeId,
    producer.producer.element,
  ]);
}

function compareStrings(left: string, right: string): -1 | 0 | 1 {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function normalizeProducer(producer: AiAnalysisDependencyProducer): AiAnalysisDependencyProducer {
  if (producer.kind === "item_element") {
    return Object.freeze({
      kind: producer.kind,
      nodeId: producer.nodeId,
      element: producer.element,
    });
  }
  if (producer.kind === "relation") {
    return Object.freeze({
      kind: producer.kind,
      relationId: producer.relationId,
      producer: Object.freeze({
        nodeId: producer.producer.nodeId,
        element: producer.producer.element,
      }),
    });
  }
  const endpointNodeIds: readonly [GraphNodeId, GraphNodeId] = [
    producer.endpointNodeIds[0],
    producer.endpointNodeIds[1],
  ];
  return Object.freeze({
    kind: producer.kind,
    candidateId: producer.candidateId,
    endpointNodeIds: Object.freeze(endpointNodeIds),
    producer: Object.freeze({
      nodeId: producer.producer.nodeId,
      element: producer.producer.element,
    }),
  });
}

function unknownReasonPriority(reason: AiAnalysisDependencyUnknownReason): number {
  switch (reason) {
    case "migration":
      return 0;
    case "not_recorded":
      return 1;
    case "proof_unknown":
      return 2;
    case "stale_repository":
      return -1;
    default:
      throw new UnreachableError(reason);
  }
}

function normalizeProducers(
  producers: readonly AiAnalysisDependencyProducer[],
): readonly AiAnalysisDependencyProducer[] {
  const relationCandidateDefinitions = new Map<string, string>();
  for (const producer of producers) {
    if (producer.kind !== "relation_candidate") {
      continue;
    }
    const definition = JSON.stringify([
      producer.endpointNodeIds[0],
      producer.endpointNodeIds[1],
      producer.producer.nodeId,
    ]);
    const existing = relationCandidateDefinitions.get(producer.candidateId);
    if (existing != null && existing !== definition) {
      throw new TypeError(
        `relation candidate ${producer.candidateId}に異なるendpointまたはownerがあります`,
      );
    }
    relationCandidateDefinitions.set(producer.candidateId, definition);
  }
  const normalized = [
    ...new Map(
      producers.map((producer) => {
        const normalizedProducer = normalizeProducer(producer);
        return [producerSignature(normalizedProducer), normalizedProducer];
      }),
    ).values(),
  ].sort((left, right) => compareStrings(producerSignature(left), producerSignature(right)));
  const [first, ...remaining] = normalized;
  if (first == null) {
    throw new TypeError("AI依存producerがありません");
  }
  return Object.freeze([first, ...remaining]);
}

function createUnknownAiAnalysisDependency(
  reason: AiAnalysisDependencyUnknownReason,
  producers: readonly AiAnalysisDependencyProducer[] | undefined,
): AiAnalysisDependency {
  if (reason === "proof_unknown") {
    if (producers == null) {
      throw new TypeError("producerless proof_unknownは許可されません");
    }
    return Object.freeze({ status: "unknown", reason, producers });
  }
  return Object.freeze({
    status: "unknown",
    reason,
    ...(producers == null ? {} : { producers }),
  });
}

/** AI依存をproducer署名順へ正規化する。 */
export function normalizeAiAnalysisDependency(
  dependency: AiAnalysisDependency,
): AiAnalysisDependency {
  const parsedDependency = aiAnalysisDependencySchema.parse(dependency);
  if (parsedDependency.status === "not_dependent") {
    return Object.freeze({ status: "not_dependent" });
  }
  const producers = parsedDependency.producers;
  if (
    producers == null &&
    parsedDependency.status === "unknown" &&
    parsedDependency.reason === "proof_unknown"
  ) {
    throw new TypeError("producerless proof_unknownは許可されません");
  }
  return Object.freeze({
    ...parsedDependency,
    ...(producers == null ? {} : { producers: normalizeProducers(producers) }),
  });
}

/** AI分析要素の適用記録から最終値の依存状態を作る。 */
export function aiAnalysisDependencyForApplication(
  nodeId: GitHubNodeId,
  element: AiAnalysisElement,
  application: AiAnalysisElementApplication,
): AiAnalysisDependency {
  const producer = Object.freeze({
    kind: "item_element",
    nodeId,
    element,
  }) satisfies AiAnalysisDependencyProducer;
  switch (application.status) {
    case "current_ai":
      return Object.freeze({
        status: "current",
        producers: Object.freeze([producer]),
      });
    case "retained_ai":
    case "unavailable":
      return Object.freeze({
        status: "unverified",
        producers: Object.freeze([producer]),
      });
    case "unknown":
      return Object.freeze({
        status: "unknown",
        reason: application.reason,
        producers: Object.freeze([producer]),
      });
    case "not_required":
    case "deterministic_fallback":
    case "disabled":
      return Object.freeze({
        status: "not_dependent",
      });
    default:
      throw new UnreachableError(application);
  }
}

/** 未判定の推定関係候補に対するAI依存を作る。 */
export function aiAnalysisDependencyForMissingRelationCandidateAssessment(
  nodeId: GitHubNodeId,
  application: AiAnalysisElementApplication,
): AiAnalysisDependency {
  const applicationDependency = aiAnalysisDependencyForApplication(
    nodeId,
    "relations",
    application,
  );
  if (
    applicationDependency.status !== "current" &&
    applicationDependency.status !== "not_dependent"
  ) {
    return applicationDependency;
  }
  return aiAnalysisDependencyForApplication(nodeId, "relations", {
    status: "unknown",
    reason: "proof_unknown",
  });
}

function normalizeRelationCandidateEndpointNodeIds(
  endpointNodeIds: readonly [GraphNodeId, GraphNodeId],
): readonly [GraphNodeId, GraphNodeId] {
  const first = endpointNodeIds[0];
  const second = endpointNodeIds[1];
  if (first.length === 0 || second.length === 0) {
    throw new TypeError("relation candidateのendpointは空にできません");
  }
  if (/\s/u.test(first) || /\s/u.test(second)) {
    throw new TypeError("relation candidateのendpointに空白は使えません");
  }
  if (first === second) {
    throw new TypeError("relation candidateのendpointが重複しています");
  }
  return first < second ? Object.freeze([first, second]) : Object.freeze([second, first]);
}

/** 関係候補のAI依存へ実際のrelation適用元を結び付ける。 */
export function aiAnalysisDependencyForRelationCandidate(
  candidateId: string,
  endpointNodeIds: readonly [GraphNodeId, GraphNodeId],
  dependency: AiAnalysisDependency,
): AiAnalysisDependency {
  if (candidateId.length === 0 || /\s/u.test(candidateId)) {
    throw new TypeError("relation candidate IDは空にできず空白を含められません");
  }
  const normalizedEndpointNodeIds = normalizeRelationCandidateEndpointNodeIds(endpointNodeIds);
  if (dependency.status === "not_dependent") {
    return Object.freeze({ status: "not_dependent" });
  }
  const endpointNodeIdSet = new Set<GraphNodeId>(normalizedEndpointNodeIds);
  const producers = dependency.producers?.map((producer) => {
    if (producer.kind !== "item_element" || producer.element !== "relations") {
      throw new TypeError(
        "relation candidateのAI依存producerはitemのrelationsでなければなりません",
      );
    }
    if (!endpointNodeIdSet.has(producer.nodeId)) {
      throw new TypeError("relation candidateのAI依存producer nodeがendpointではありません");
    }
    return Object.freeze({
      kind: "relation_candidate",
      candidateId,
      endpointNodeIds: normalizedEndpointNodeIds,
      producer: Object.freeze({
        nodeId: producer.nodeId,
        element: "relations",
      }),
    }) satisfies AiAnalysisDependencyProducer;
  });
  if (dependency.status === "unknown") {
    if (dependency.producers?.length === 0) {
      throw new TypeError("relation candidateのAI依存producerが空です");
    }
    return createUnknownAiAnalysisDependency(
      dependency.reason,
      producers == null ? undefined : normalizeProducers(producers),
    );
  }
  if (producers == null || producers.length === 0) {
    throw new TypeError("relation candidateのAI依存producerがありません");
  }
  return Object.freeze({
    status: dependency.status,
    producers: normalizeProducers(producers),
  });
}

/** AI入力の依存producerをrelation経由のproducerへ変換する。 */
function relationAiDependencyProducer(
  relationId: string,
  producer: AiAnalysisDependencyProducerBase,
): AiAnalysisDependencyProducer {
  if (relationId.length === 0) {
    throw new TypeError("relation IDは空にできません");
  }
  return Object.freeze({
    kind: "relation",
    relationId,
    producer: Object.freeze({
      nodeId: producer.nodeId,
      element: producer.element,
    }),
  }) satisfies AiAnalysisDependencyProducer;
}

/** relationのAI依存を項目側のrelation producerへ変換する。 */
export function aiAnalysisDependencyForRelation(
  relationId: string,
  dependency: AiAnalysisDependency,
): AiAnalysisDependency {
  if (dependency.status === "not_dependent") {
    return Object.freeze({ status: "not_dependent" });
  }
  if (dependency.status === "unknown") {
    const producers = dependency.producers?.map((producer) => {
      if (producer.kind !== "item_element") {
        throw new TypeError("relationのAI依存producerを再度relationへ変換できません");
      }
      return relationAiDependencyProducer(relationId, producer);
    });
    return createUnknownAiAnalysisDependency(
      dependency.reason,
      producers == null || producers.length === 0 ? undefined : normalizeProducers(producers),
    );
  }
  const producers = normalizeProducers(
    dependency.producers.map((producer) => {
      if (producer.kind !== "item_element") {
        throw new TypeError("relationのAI依存producerを再度relationへ変換できません");
      }
      return relationAiDependencyProducer(relationId, producer);
    }),
  );
  return Object.freeze({
    status: dependency.status,
    producers,
  });
}

/** 実際に選択された依存だけを合成する。 */
export function combineAiAnalysisDependencies(
  dependencies: readonly AiAnalysisDependency[],
): AiAnalysisDependency {
  if (dependencies.length === 0) {
    throw new TypeError("AI依存の合成対象がありません");
  }
  const producers = dependencies.flatMap((dependency) => {
    if (dependency.status === "not_dependent") {
      return [];
    }
    return dependency.producers ?? [];
  });
  const statuses = new Set(dependencies.map((dependency) => dependency.status));
  const normalizedProducers = producers.length === 0 ? undefined : normalizeProducers(producers);
  if (statuses.has("unknown")) {
    const unknownDependencies = dependencies.filter(
      (dependency): dependency is Extract<AiAnalysisDependency, { status: "unknown" }> =>
        dependency.status === "unknown",
    );
    const firstUnknownDependency = unknownDependencies[0];
    if (firstUnknownDependency == null) {
      throw new TypeError("AI依存unknownの理由がありません");
    }
    const reason = unknownDependencies.reduce(
      (selected, dependency) =>
        unknownReasonPriority(dependency.reason) < unknownReasonPriority(selected)
          ? dependency.reason
          : selected,
      firstUnknownDependency.reason,
    );
    return createUnknownAiAnalysisDependency(reason, normalizedProducers);
  }
  if (statuses.has("unverified")) {
    if (normalizedProducers == null) {
      throw new TypeError("AI依存unverifiedのproducerがありません");
    }
    return Object.freeze({
      status: "unverified",
      producers: normalizedProducers,
    });
  }
  if (statuses.has("current")) {
    if (normalizedProducers == null) {
      throw new TypeError("AI依存currentのproducerがありません");
    }
    return Object.freeze({
      status: "current",
      producers: normalizedProducers,
    });
  }
  return Object.freeze({
    status: "not_dependent",
  });
}

/** 移行で復元できない最終値のAI依存を作る。 */
export function migratedAiAnalysisDependency(): AiAnalysisDependency {
  return Object.freeze({
    status: "unknown",
    reason: "migration",
  });
}

/** 全最終値を移行unknownで初期化する。 */
export function migratedTrackedItemAiDependencies(): TrackedItemAiDependencies {
  const dependency = migratedAiAnalysisDependency();
  return Object.freeze({
    status: dependency,
    waitingOn: dependency,
    nextAction: dependency,
    primaryWaitingOn: dependency,
    confidence: dependency,
    evidence: dependency,
    uncertainties: dependency,
    deadline: dependency,
    deadlineLevel: dependency,
    lastProgressAt: dependency,
    stallSince: dependency,
    severity: dependency,
    downstreamImpact: dependency,
    importance: dependency,
    attention: dependency,
    blockers: dependency,
    relationSet: dependency,
  });
}
