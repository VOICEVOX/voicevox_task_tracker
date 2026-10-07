import type { TrackedItemAiDependencies } from "./ai-analysis-dependencies.js";
import type { Importance } from "./importance.js";
import type {
  PersonalReminderCause,
  PersonalReminderCausePlanning,
} from "./personal-reminder-causes.js";
import type { TrackedItemAiAnalysis } from "./tracked-item-ai-analysis.js";
import type {
  Evidence,
  GitHubAccountActor,
  GitHubItemDisplayReference,
  GitHubItemUrl,
  GitHubNodeId,
  GitHubRepositoryId,
  NonTerminalStatus,
  ObservedGitHubItemAuthor,
  PrimaryWaitingOn,
  ReviewState,
  CheckState,
  TerminalStatus,
  TrackedItemInputEvent,
  TrackedItemLatestEventActor,
  TrackedItemState,
  TrackedItemType,
  TrackingNotificationClass,
  UtcIsoDateTime,
  WaitingOn,
} from "./types.js";

type TrackedItemFields = Readonly<{
  nodeId: GitHubNodeId;
  type: TrackedItemType;
  repositoryId: GitHubRepositoryId;
  displayReference: GitHubItemDisplayReference;
  number: number;
  url: GitHubItemUrl;
  title: string;
  importance: Importance;
  author: ObservedGitHubItemAuthor;
  latestEventActor: TrackedItemLatestEventActor;
  state: TrackedItemState;
  notificationClass: TrackingNotificationClass;
  primaryWaitingOn: PrimaryWaitingOn;
  nextAction: string;
  createdAt: UtcIsoDateTime;
  githubUpdatedAt: UtcIsoDateTime;
  lastHumanActivityAt: UtcIsoDateTime;
  lastProgressAt: UtcIsoDateTime;
  statusSince: UtcIsoDateTime;
  ownerSince: UtcIsoDateTime;
  stallSince: UtcIsoDateTime;
  observedAt: UtcIsoDateTime;
  labels: readonly string[];
  assignees: readonly GitHubAccountActor[];
  reviewState: ReviewState;
  checkState: CheckState;
  aiAnalysis: TrackedItemAiAnalysis;
  aiDependencies: TrackedItemAiDependencies;
  personalReminderCauses: readonly PersonalReminderCause[];
  personalReminderCausePlanning: PersonalReminderCausePlanning;
  inputEvents: readonly TrackedItemInputEvent[];
  confidence: number;
  evidence: readonly Evidence[];
  uncertainties: readonly string[];
}>;

/** nodeIdを正本とし、renameで変わり得る表示用別名を分離した追跡項目。 */
export type TrackedItem =
  | (TrackedItemFields &
      Readonly<{
        status: NonTerminalStatus;
        waitingOn: readonly WaitingOn[];
      }>)
  | (TrackedItemFields &
      Readonly<{
        status: TerminalStatus;
        waitingOn: readonly [];
      }>);
