import type {
  GitHubNodeId,
  GitHubRepositoryId,
  TrackedItemInputEvent,
  UtcIsoDateTime,
} from "../../../domain/index.js";
import type { TrackedItemAiAnalysis } from "../../../domain/tracked-item-ai-analysis.js";
import type { Relation } from "../../../domain/relation.js";
import type {
  RunAiCacheAddition,
  RunPersonalCacheAddition,
} from "./run-validation-cache-witness.js";
import type {
  RunValidationLedger,
  RunNotificationSelection,
} from "./run-validation-final-checks.js";

export type ReferenceOwner =
  Readonly<{ kind: "item"; id: string }> | Readonly<{ kind: "relation"; id: string }>;

export type MaterializedEvidenceReference = Readonly<{
  sourceId: string;
  path: readonly (string | number)[];
  owner: ReferenceOwner;
}>;

export type MaterializedReferenceValues = Readonly<{
  snapshot: Readonly<{
    generatedAt: UtcIsoDateTime;
    items: readonly Readonly<{
      nodeId: GitHubNodeId;
      repositoryId: GitHubRepositoryId;
      inputEvents: readonly TrackedItemInputEvent[];
      aiAnalysis: TrackedItemAiAnalysis;
      personalReminderCauses: readonly Readonly<{ causeId: string }>[];
    }>[];
    relations: readonly Pick<
      Relation,
      "active" | "fromNodeId" | "id" | "provenance" | "toNodeId" | "type"
    >[];
    collection: Readonly<{
      repositories: readonly Readonly<{
        repositoryId: GitHubRepositoryId;
        items: readonly Readonly<{
          nodeId: GitHubNodeId;
          repositoryId: GitHubRepositoryId;
          aiAnalysis: TrackedItemAiAnalysis;
        }>[];
      }>[];
    }>;
  }>;
  historyInputEvents: readonly Readonly<{ itemNodeId: string }>[];
  aiCacheAdditions: readonly RunAiCacheAddition[];
  personalReminderAiCacheAdditions: readonly RunPersonalCacheAddition[];
  previousNotificationLedger: RunValidationLedger;
  notificationLedger: RunValidationLedger;
  notificationSelection: RunNotificationSelection;
}>;
