import { z } from "zod";

import {
  AI_ANALYSIS_REUSE_PROOF_SCHEMA_VERSION,
  aiAnalysisElementApplicationsSchema,
  aiAnalysisElementReuseProofSchema,
  aiAnalysisStatusSchema,
  type AiAnalysisElementApplications,
} from "../domain/ai-analysis-elements.js";
import {
  AI_ANALYSIS_ELEMENTS,
  aiAnalysisDependencyForApplication,
  migratedAiAnalysisDependency,
  migratedTrackedItemAiDependencies,
  type AiAnalysisDependency,
  type GitHubNodeId,
  type RelationProvenance,
  type RelationType,
  type TrackedItemAiDependencies,
  type TrackedItemState,
} from "../domain/index.js";

export const legacyStatusSchema = aiAnalysisStatusSchema;

function migratedRelationAiDependency(provenance: RelationProvenance): AiAnalysisDependency {
  if (provenance === "native") {
    return Object.freeze({ status: "not_dependent" });
  }
  return migratedAiAnalysisDependency();
}

const legacyMigrationItemEndpointSchema = z.object({
  nodeId: z.string().min(1),
  type: z.enum(["issue", "pull_request"]),
});

const legacyMigrationExternalEndpointSchema = z.object({
  nodeId: z.string().min(1),
  url: z.string().min(1),
});

type LegacyMigratableRelation = Readonly<{
  fromNodeId: string;
  toNodeId: string;
  type: RelationType;
  provenance: RelationProvenance;
}>;

type LegacyMigrationGraphNode = Readonly<{
  nodeId: string;
  state: TrackedItemState;
}>;

type ActiveLegacyMigratableRelation = LegacyMigratableRelation &
  Readonly<{
    active: boolean;
  }>;

type MigratedLegacyRelation<RelationValue extends LegacyMigratableRelation> = Readonly<
  Omit<RelationValue, "type" | "aiDependency"> & {
    type: RelationType;
    aiDependency: AiAnalysisDependency;
  }
>;

function legacyExternalReferenceItemType(urlValue: string): "issue" | "pull_request" | undefined {
  let url: URL;
  try {
    url = new URL(urlValue);
  } catch {
    return undefined;
  }
  const pathSegments = url.pathname.split("/").filter((segment) => segment.length !== 0);
  const itemPathKind = pathSegments[2];
  const itemNumber = pathSegments[3];
  if (
    url.hostname !== "github.com" ||
    pathSegments.length < 4 ||
    itemNumber == null ||
    !/^[1-9][0-9]*$/u.test(itemNumber)
  ) {
    return undefined;
  }
  if (itemPathKind === "issues") {
    return "issue";
  }
  if (itemPathKind === "pull") {
    return "pull_request";
  }
  return undefined;
}

function legacyMigrationNodeTypes(
  items: readonly unknown[],
  externalReferences: readonly unknown[],
): ReadonlyMap<string, "issue" | "pull_request"> {
  const nodeTypes = new Map<string, "issue" | "pull_request">();
  for (const value of items) {
    const item = legacyMigrationItemEndpointSchema.safeParse(value);
    if (item.success) {
      nodeTypes.set(item.data.nodeId, item.data.type);
    }
  }
  for (const value of externalReferences) {
    const reference = legacyMigrationExternalEndpointSchema.safeParse(value);
    if (!reference.success || nodeTypes.has(reference.data.nodeId)) {
      continue;
    }
    const itemType = legacyExternalReferenceItemType(reference.data.url);
    if (itemType != null) {
      nodeTypes.set(reference.data.nodeId, itemType);
    }
  }
  return nodeTypes;
}

export function migrateLegacyRelations<RelationValue extends LegacyMigratableRelation>(
  relations: readonly RelationValue[],
  items: readonly unknown[],
  externalReferences: readonly unknown[],
): readonly MigratedLegacyRelation<RelationValue>[] {
  const nodeTypes = legacyMigrationNodeTypes(items, externalReferences);
  return Object.freeze(
    relations.map((relation) => {
      const type =
        relation.type === "implements" &&
        (nodeTypes.get(relation.fromNodeId) !== "pull_request" ||
          nodeTypes.get(relation.toNodeId) !== "issue")
          ? "related_to"
          : relation.type;
      return Object.freeze({
        ...relation,
        type,
        aiDependency: migratedRelationAiDependency(relation.provenance),
      });
    }),
  );
}

export function createLegacyGraphMigration<RelationValue extends ActiveLegacyMigratableRelation>(
  relations: readonly RelationValue[],
  items: readonly LegacyMigrationGraphNode[],
  externalReferences: readonly LegacyMigrationGraphNode[],
): Readonly<{
  relations: readonly MigratedLegacyRelation<RelationValue>[];
  nativeOpenBlockerTargetNodeIds: ReadonlySet<string>;
}> {
  const migratedRelations = migrateLegacyRelations(relations, items, externalReferences);
  const openNodeIds = new Set(
    [...items, ...externalReferences]
      .filter((node) => node.state === "open")
      .map((node) => node.nodeId),
  );
  const nativeOpenBlockerTargetNodeIds = new Set<string>();
  for (const relation of migratedRelations) {
    if (
      relation.active &&
      relation.type === "blocks" &&
      relation.provenance === "native" &&
      openNodeIds.has(relation.fromNodeId) &&
      openNodeIds.has(relation.toNodeId)
    ) {
      nativeOpenBlockerTargetNodeIds.add(relation.toNodeId);
    }
  }
  return Object.freeze({
    relations: migratedRelations,
    nativeOpenBlockerTargetNodeIds,
  });
}

export function legacyReuseProof() {
  return aiAnalysisElementReuseProofSchema.parse({
    status: "unknown",
    reuseSchemaVersion: AI_ANALYSIS_REUSE_PROOF_SCHEMA_VERSION,
    reason: "legacy_migration",
  });
}

export function migratedAiAnalysisElementApplications(): AiAnalysisElementApplications {
  return Object.freeze(
    aiAnalysisElementApplicationsSchema.parse(
      Object.fromEntries(
        AI_ANALYSIS_ELEMENTS.map((element) => [
          element,
          Object.freeze({
            status: "unknown",
            reason: "migration",
          }),
        ]),
      ),
    ),
  );
}

export function migratedTrackedItemAiDependenciesForApplications(
  nodeId: GitHubNodeId,
  applications: AiAnalysisElementApplications,
): TrackedItemAiDependencies {
  const migrated = migratedTrackedItemAiDependencies();
  const status = aiAnalysisDependencyForApplication(nodeId, "status", applications.status);
  const waitingOn = aiAnalysisDependencyForApplication(nodeId, "waitingOn", applications.waitingOn);
  const nextAction = aiAnalysisDependencyForApplication(
    nodeId,
    "nextAction",
    applications.nextAction,
  );
  const deadline = aiAnalysisDependencyForApplication(nodeId, "deadline", applications.deadline);
  return Object.freeze({
    ...migrated,
    status,
    waitingOn,
    primaryWaitingOn: waitingOn,
    nextAction,
    deadline,
    deadlineLevel: deadline,
  });
}

export function migrateTrackedItemAiStateForNativeBlocker(
  nodeId: GitHubNodeId,
  applications: AiAnalysisElementApplications,
  nativeOpenBlockerTargetNodeIds: ReadonlySet<string>,
): Readonly<{
  applications: AiAnalysisElementApplications;
  aiDependencies: TrackedItemAiDependencies;
}> {
  if (!nativeOpenBlockerTargetNodeIds.has(nodeId)) {
    return Object.freeze({
      applications,
      aiDependencies: migratedTrackedItemAiDependenciesForApplications(nodeId, applications),
    });
  }
  const normalizedApplications = Object.freeze(
    aiAnalysisElementApplicationsSchema.parse({
      ...applications,
      status: { status: "deterministic_fallback" },
      waitingOn: { status: "deterministic_fallback" },
      nextAction: { status: "deterministic_fallback" },
    }),
  );
  const dependencies = migratedTrackedItemAiDependenciesForApplications(
    nodeId,
    normalizedApplications,
  );
  const migrationDependency = migratedAiAnalysisDependency();
  const deterministicDependency = Object.freeze({
    status: "not_dependent",
  } satisfies AiAnalysisDependency);
  return Object.freeze({
    applications: normalizedApplications,
    aiDependencies: Object.freeze({
      ...dependencies,
      status: deterministicDependency,
      waitingOn: migrationDependency,
      primaryWaitingOn: migrationDependency,
      nextAction: deterministicDependency,
    }),
  });
}
