import { z } from "zod";
import {
  buildSourceId,
  createGitHubNodeId,
  createUtcIsoDateTime,
  parseSourceId,
  type FreshObservedGitHubIssue,
  type FreshObservedGitHubPullRequest,
  type GitHubAccountActor,
  type SourceId,
  type UtcIsoDateTime,
  type WaitingOn,
} from "../domain/index.js";
import { assertNonNullable } from "../util/index.js";

/** causeの責任者または根拠イベントを起こしたhuman actor。 */
export type NotificationCauseActor = GitHubAccountActor & Readonly<{ type: "human" }>;

export type FreshObservedGitHubItem = FreshObservedGitHubIssue | FreshObservedGitHubPullRequest;

/** causeが直接対応付けた構造化timeline eventの要約。 */
export type NotificationCauseEvidence = Readonly<{
  sourceId: SourceId;
  occurredAt: UtcIsoDateTime;
  actor: NotificationCauseActor;
}>;

const notificationCauseActorSchema = z
  .strictObject({
    type: z.literal("human"),
    nodeId: z.string().min(1),
    login: z.string().min(1),
  })
  .transform(({ nodeId, login }): NotificationCauseActor =>
    Object.freeze({
      type: "human",
      nodeId: createGitHubNodeId(nodeId),
      login,
    }),
  );

const notificationCauseSourceIdSchema = z
  .string()
  .min(3)
  .transform((sourceId) => {
    const parts = parseSourceId(sourceId);
    return buildSourceId(parts.kind, parts.originalId);
  });

const notificationCauseEvidenceSchema = z
  .strictObject({
    sourceId: notificationCauseSourceIdSchema,
    occurredAt: z.iso
      .datetime({
        offset: true,
        error: "タイムゾーンを含むISO 8601日時を指定してください",
      })
      .transform(createUtcIsoDateTime),
    actor: notificationCauseActorSchema,
  })
  .transform((evidence): NotificationCauseEvidence => Object.freeze(evidence));

const notificationCauseEvidenceListSchema = z
  .array(notificationCauseEvidenceSchema)
  .min(1)
  .transform((evidence): readonly [NotificationCauseEvidence, ...NotificationCauseEvidence[]] => {
    const [first, ...rest] = evidence;
    assertNonNullable(first, "cause evidenceがありません");
    return Object.freeze([first, ...rest]);
  });

export const notificationDependencyCauseSchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("not_applicable"),
  }),
  z.strictObject({
    status: z.literal("complete"),
    evidence: notificationCauseEvidenceListSchema,
  }),
  z.strictObject({
    status: z.literal("indeterminate"),
  }),
]);

/** 通知理由の原因対応結果を検証するcause schema。 */
export const notificationCauseSchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("complete"),
    responsible: notificationCauseActorSchema,
    evidence: notificationCauseEvidenceListSchema,
  }),
  z.strictObject({
    status: z.literal("indeterminate"),
  }),
]);

/** 通知理由の原因対応結果を表す検証済みcause。 */
export type NotificationCause = z.output<typeof notificationCauseSchema>;

export type NotificationCauseEvidenceList = readonly [
  NotificationCauseEvidence,
  ...NotificationCauseEvidence[],
];

/** 責任者が確定する前の依存解消cause。 */
export type NotificationDependencyCause =
  | Readonly<{
      status: "not_applicable";
    }>
  | Readonly<{
      status: "complete";
      evidence: NotificationCauseEvidenceList;
    }>
  | Readonly<{
      status: "indeterminate";
    }>;

type PreviousResponsibility = Readonly<{
  waitingOn: readonly WaitingOn[];
  observedAt: UtcIsoDateTime;
}>;

/** 通知理由のcauseを正規化eventと依存解消から導出する入力。 */
export type CreateNotificationCausesInput = Readonly<{
  item: FreshObservedGitHubItem;
  currentWaitingOn: readonly WaitingOn[];
  previous:
    | Readonly<{
        availability: "not_available";
      }>
    | Readonly<{
        availability: "available";
        value: PreviousResponsibility;
      }>;
  currentResponsibilityBasis: Readonly<{
    sourceIds: readonly [SourceId, ...SourceId[]];
    occurredAt: UtcIsoDateTime;
  }>;
  dependencyCause: NotificationDependencyCause;
  selfCommitmentCause: NotificationCause;
  hasUnobservedHeadChange: boolean;
  evaluatedAt: UtcIsoDateTime;
}>;

/** 通知選別へ渡す理由ごとのcause。 */
export type NotificationCauses = Readonly<{
  responsibility_changed: NotificationCause;
  newly_unblocked: NotificationCause;
}>;
