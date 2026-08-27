import { z } from "zod";

import { IMPORTANCE_FACTOR_KINDS } from "../domain/importance.js";
import { notificationReasonSchema } from "../domain/notification-reason.js";
import { assertNonNullable } from "../util/index.js";
import { PublicDtoSemanticError, PublicDtoValidationError } from "./errors.js";

const identifierSchema = z.string().min(1).max(512).regex(/^\S+$/u);
const shortStringSchema = z.string().max(1000);
const dateTimeSchema = z.iso
  .datetime({
    offset: true,
    error: "タイムゾーンを含むISO 8601日時を指定してください",
  })
  .transform((value) => new Date(value).toISOString());
const githubUrlSchema = z
  .url()
  .max(1000)
  .refine((value) => {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.hostname === "github.com" &&
      url.port === "" &&
      url.username === "" &&
      url.password === ""
    );
  }, "GitHubのHTTPS URLを指定してください");
const nonNegativeIntegerSchema = z.number().int().nonnegative();
const statusSchema = z.enum([
  "waiting_for_assessment",
  "waiting_for_owner",
  "waiting_for_decision",
  "waiting_for_review",
  "waiting_for_revision",
  "waiting_for_reply",
  "waiting_for_work",
  "waiting_for_unblock",
  "waiting_for_automation",
  "waiting_for_merge",
  "in_progress",
  "unknown",
  "terminal_merged",
  "terminal_completed",
  "terminal_not_planned",
]);
const severitySchema = z.enum(["none", "watch", "urgent", "critical"]);
const importanceLevelSchema = z.enum(["low", "medium", "high"]);
const deadlineLevelSchema = z.enum([
  "none",
  "over_30_days",
  "within_30_days",
  "within_7_days",
  "within_3_days",
  "within_1_day",
  "overdue",
]);
function isCalendarDate(value: string): boolean {
  const timestamp = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value;
}

const deadlineDateSchema = z.union([
  z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/u)
    .refine(isCalendarDate, {
      message: "実在する日付を指定してください",
    }),
  z.null(),
]);
const publicImportanceSchema = z.strictObject({
  score: z.number().int().min(0).max(100),
  level: importanceLevelSchema,
});
const importanceFactorSchema = z.strictObject({
  kind: z.enum(IMPORTANCE_FACTOR_KINDS),
  points: z.number().positive(),
  detail: z.string().min(1).max(1000),
});
const waitingOnSchema = z.strictObject({
  kind: z.enum(["user", "team", "role", "item", "automation", "unknown"]),
  candidateId: identifierSchema,
  role: z.enum([
    "author",
    "maintainer",
    "reviewer",
    "assignee",
    "respondent",
    "dependency",
    "merge_decider",
    "ci",
    "unknown",
  ]),
  reasonSummary: shortStringSchema,
  confidence: z.number().min(0).max(1),
});
const primaryWaitingOnSchema = z.discriminatedUnion("index", [
  z.strictObject({
    index: z.literal(0),
    selectionReason: shortStringSchema,
  }),
  z.strictObject({
    index: z.literal("not_applicable"),
    selectionReason: shortStringSchema,
  }),
]);
const publicEvidenceSchema = z.strictObject({
  summary: shortStringSchema,
  sourceUrl: githubUrlSchema,
});
const repositoryFreshnessSchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("fresh"),
  }),
  z.strictObject({
    status: z.literal("stale"),
  }),
]);
const publicRepositorySchema = z.strictObject({
  id: identifierSchema,
  name: z.string().min(1).max(256),
  fullName: z.string().min(3).max(513),
  freshness: repositoryFreshnessSchema,
});
const downstreamImpactSchema = z.strictObject({
  nodeId: identifierSchema,
  openNodeCount: nonNegativeIntegerSchema,
  repositoryCount: nonNegativeIntegerSchema,
});
const accountActorSchema = z.strictObject({
  type: z.enum(["human", "bot"]),
  nodeId: identifierSchema,
  login: z.string().min(1).max(256),
});
const itemAuthorSchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("identified"),
    actor: accountActorSchema,
  }),
  z.strictObject({
    status: z.literal("unavailable"),
    reason: z.literal("deleted_account"),
  }),
]);
const publicDeadlineSummarySchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("not_available"),
  }),
  z
    .strictObject({
      status: z.literal("available"),
      date: deadlineDateSchema,
      level: deadlineLevelSchema,
    })
    .superRefine((deadline, context) => {
      if (deadline.date == null && deadline.level !== "none") {
        context.addIssue({
          code: "custom",
          path: ["level"],
          message: "期限日がnullの場合は切迫度をnoneにしてください",
        });
      }
      if (deadline.date != null && deadline.level === "none") {
        context.addIssue({
          code: "custom",
          path: ["level"],
          message: "期限日がある場合は切迫度をnone以外にしてください",
        });
      }
    }),
]);
const publicDeadlineDetailsSchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("not_available"),
  }),
  z
    .strictObject({
      status: z.literal("available"),
      date: deadlineDateSchema,
      level: deadlineLevelSchema,
      rationale: z.string().min(1).max(120),
    })
    .superRefine((deadline, context) => {
      if (deadline.date == null && deadline.level !== "none") {
        context.addIssue({
          code: "custom",
          path: ["level"],
          message: "期限日がnullの場合は切迫度をnoneにしてください",
        });
      }
      if (deadline.date != null && deadline.level === "none") {
        context.addIssue({
          code: "custom",
          path: ["level"],
          message: "期限日がある場合は切迫度をnone以外にしてください",
        });
      }
    }),
]);
const publicItemAiAnalysisSchema = z.strictObject({
  status: z.enum(["used", "failed", "deferred", "not_required", "disabled", "not_recorded"]),
});
const publicItemSummarySchema = z.strictObject({
  nodeId: identifierSchema,
  type: z.enum(["issue", "pull_request"]),
  repositoryId: identifierSchema,
  displayReference: z.string().min(4).max(600),
  number: z.number().int().positive(),
  url: githubUrlSchema,
  title: z.string().max(500),
  deadline: publicDeadlineSummarySchema,
  state: z.enum(["open", "closed", "merged"]),
  author: itemAuthorSchema,
  assignees: z.array(accountActorSchema),
  status: statusSchema,
  waitingOn: z.array(waitingOnSchema),
  primaryWaitingOn: primaryWaitingOnSchema,
  nextAction: shortStringSchema,
  severity: severitySchema,
  importance: publicImportanceSchema,
  attention: publicImportanceSchema,
  priorityWeight: z.number(),
  aiAnalysis: publicItemAiAnalysisSchema,
  confidence: z.number().min(0).max(1),
  githubUpdatedAt: dateTimeSchema,
  stallSince: dateTimeSchema,
  observedAt: dateTimeSchema,
  repositoryFreshness: z.enum(["fresh", "stale"]),
  blockerNodeIds: z.array(identifierSchema),
  downstreamImpact: downstreamImpactSchema,
});
const itemTimestampsSchema = z.strictObject({
  createdAt: dateTimeSchema,
  githubUpdatedAt: dateTimeSchema,
  stallSince: dateTimeSchema,
});
const latestEventActorValueSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.enum(["human", "bot"]),
    login: z.string().min(1).max(256),
  }),
  z.strictObject({
    type: z.literal("system"),
    name: z.string().min(1).max(512),
  }),
]);
const latestEventActorSchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("absent"),
  }),
  z.strictObject({
    status: z.literal("present"),
    actor: latestEventActorValueSchema,
  }),
]);
const responsibilitySchema = z.strictObject({
  status: statusSchema,
  waitingOn: z.array(
    waitingOnSchema.omit({
      reasonSummary: true,
      confidence: true,
    }),
  ),
});
const responsibilityHistoryValueSchema = z.discriminatedUnion("state", [
  z.strictObject({
    state: z.literal("absent"),
  }),
  z.strictObject({
    state: z.literal("present"),
    value: responsibilitySchema,
  }),
]);
const publicItemHistoryEventSchema = z.strictObject({
  kind: z.literal("responsibility_changed"),
  recordedAt: dateTimeSchema,
  before: responsibilityHistoryValueSchema,
  after: responsibilityHistoryValueSchema,
});
const publicItemDetailsSchema = z.strictObject({
  summary: publicItemSummarySchema,
  deadline: publicDeadlineDetailsSchema,
  importanceFactors: z.array(importanceFactorSchema),
  timestamps: itemTimestampsSchema,
  latestEventActor: latestEventActorSchema,
  labels: z.array(z.string().min(1).max(256)),
  reviewState: z.enum([
    "not_applicable",
    "not_requested",
    "requested",
    "changes_requested",
    "approved",
    "unknown",
  ]),
  checkState: z.enum([
    "not_applicable",
    "not_required",
    "pending",
    "passing",
    "failing",
    "conflict",
    "unknown",
  ]),
  evidence: z.array(publicEvidenceSchema),
  uncertainties: z.array(shortStringSchema),
  history: z.array(publicItemHistoryEventSchema),
});
const publicTrackedGraphNodeFieldsSchema = z.strictObject({
  nodeId: identifierSchema,
  repositoryId: identifierSchema,
  state: z.enum(["open", "closed", "merged"]),
  status: statusSchema,
  severity: severitySchema,
});
const publicGraphNodeSchema = z.discriminatedUnion("kind", [
  publicTrackedGraphNodeFieldsSchema.extend({
    kind: z.literal("issue"),
  }),
  publicTrackedGraphNodeFieldsSchema.extend({
    kind: z.literal("pull_request"),
  }),
  z.strictObject({
    nodeId: identifierSchema,
    kind: z.literal("external_reference"),
    repositoryFullName: z.string().min(3).max(513),
    displayReference: z.string().min(4).max(600),
    url: githubUrlSchema,
    title: z.string().max(500),
    state: z.enum(["open", "closed", "merged"]),
  }),
]);
const publicGraphEdgeFieldsSchema = z.strictObject({
  id: identifierSchema,
  fromNodeId: identifierSchema,
  toNodeId: identifierSchema,
  type: z.enum(["blocks", "parent_of", "implements", "related_to", "duplicates"]),
  provenance: z.enum([
    "native",
    "explicit_text",
    "closing_keyword",
    "checklist",
    "cross_reference",
    "ai_inference",
  ]),
  confidence: z.number().min(0).max(1),
});
const publicGraphEdgeSchema = z.discriminatedUnion("active", [
  publicGraphEdgeFieldsSchema.extend({
    active: z.literal(true),
  }),
  publicGraphEdgeFieldsSchema.extend({
    active: z.literal(false),
  }),
]);
const publicInitialGraphSchema = z.strictObject({
  nodes: z.array(
    z.discriminatedUnion("kind", [
      z.strictObject({
        nodeId: identifierSchema,
        kind: z.literal("issue"),
      }),
      z.strictObject({
        nodeId: identifierSchema,
        kind: z.literal("pull_request"),
      }),
      z.strictObject({
        nodeId: identifierSchema,
        kind: z.literal("external_reference"),
        displayReference: z.string().min(4).max(600),
      }),
    ]),
  ),
  maxNodes: z.number().int().positive(),
});
const publicGraphSchema = z.strictObject({
  nodes: z.array(publicGraphNodeSchema),
  edges: z.array(publicGraphEdgeSchema),
  frontierNodeIds: z.array(identifierSchema),
});
const publicConfidenceThresholdsSchema = z
  .strictObject({
    high: z.number().min(0).max(1),
    medium: z.number().min(0).max(1),
  })
  .refine((thresholds) => thresholds.high >= thresholds.medium, {
    message: "high confidence閾値はmedium confidence閾値以上にしてください",
    path: ["high"],
  });
const publicAiStateSchema = z.union([
  z.strictObject({
    enabled: z.literal(false),
    available: z.literal(false),
    degraded: z.literal(false),
  }),
  z.strictObject({
    enabled: z.literal(true),
    available: z.literal(true),
    degraded: z.boolean(),
  }),
  z.strictObject({
    enabled: z.literal(true),
    available: z.literal(false),
    degraded: z.literal(true),
  }),
]);
const publicSummaryDtoSchema = z.strictObject({
  schemaVersion: z.literal("7"),
  runId: identifierSchema,
  generatedAt: dateTimeSchema,
  observedAt: dateTimeSchema,
  timezone: identifierSchema,
  ai: publicAiStateSchema,
  confidenceThresholds: publicConfidenceThresholdsSchema,
  repositories: z.array(publicRepositorySchema),
  items: z.array(publicItemSummarySchema),
  graph: publicInitialGraphSchema,
});
const publicDetailsDtoSchema = z.strictObject({
  schemaVersion: z.literal("7"),
  runId: identifierSchema,
  generatedAt: dateTimeSchema,
  items: z.array(publicItemDetailsSchema),
  graph: publicGraphSchema,
});
const publicNotificationHistoryItemSchema = z.strictObject({
  nodeId: identifierSchema,
  type: z.enum(["issue", "pull_request"]),
  repositoryId: identifierSchema,
  displayReference: z.string().min(4).max(600),
  number: z.number().int().positive(),
  title: z.string().max(500),
  url: githubUrlSchema,
});
const publicNotificationHistoryWaitingOnSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("user"),
    candidateId: identifierSchema,
    role: waitingOnSchema.shape.role,
  }),
  z.strictObject({
    kind: z.literal("team"),
    candidateId: identifierSchema,
    role: waitingOnSchema.shape.role,
  }),
  z.strictObject({
    kind: z.literal("role"),
    candidateId: identifierSchema,
    role: waitingOnSchema.shape.role,
  }),
  z.strictObject({
    kind: z.literal("item"),
    candidateId: identifierSchema,
    role: waitingOnSchema.shape.role,
    displayReference: z.string().min(4).max(600),
  }),
  z.strictObject({
    kind: z.literal("automation"),
    candidateId: identifierSchema,
    role: waitingOnSchema.shape.role,
  }),
  z.strictObject({
    kind: z.literal("unknown"),
    candidateId: identifierSchema,
    role: waitingOnSchema.shape.role,
  }),
]);
const publicNotificationHistoryEntrySchema = z
  .strictObject({
    item: publicNotificationHistoryItemSchema,
    waitingOn: z.array(publicNotificationHistoryWaitingOnSchema).min(1),
    reasons: z.array(notificationReasonSchema).min(1),
    sentAt: dateTimeSchema,
  })
  .superRefine((entry, context) => {
    const reasonCodes = entry.reasons.map((reason) => reason.reasonCode);
    if (new Set(reasonCodes).size !== reasonCodes.length) {
      context.addIssue({
        code: "custom",
        path: ["reasons"],
        message: "通知理由コードが重複しています",
      });
    }
    for (const [index, reason] of entry.reasons.entries()) {
      if (reason.threshold.status === "not_recorded") {
        context.addIssue({
          code: "custom",
          path: ["reasons", index, "threshold"],
          message: "公開通知履歴に基準時間未記録の理由を含めることはできません",
        });
      }
    }
  });
const publicNotificationHistoryDtoSchema = z
  .strictObject({
    schemaVersion: z.literal("3"),
    runId: identifierSchema,
    generatedAt: dateTimeSchema,
    notifications: z.array(publicNotificationHistoryEntrySchema),
  })
  .superRefine((history, context) => {
    for (const [index, notification] of history.notifications.entries()) {
      if (notification.sentAt > history.generatedAt) {
        context.addIssue({
          code: "custom",
          path: ["notifications", index, "sentAt"],
          message: "通知送信時刻は公開データ生成時刻以前にしてください",
        });
      }
      const previous = history.notifications[index - 1];
      if (previous != null && comparePublicNotificationHistoryEntries(previous, notification) > 0) {
        context.addIssue({
          code: "custom",
          path: ["notifications", index],
          message: "通知履歴が決定論的な降順になっていません",
        });
      }
    }
  });

/** Web初期表示で共有するschema version 7の公開summary DTO。 */
export type PublicSummaryDto = z.output<typeof publicSummaryDtoSchema>;

/** Web詳細表示で共有するschema version 7の公開details DTO。 */
export type PublicDetailsDto = z.output<typeof publicDetailsDtoSchema>;

/** 公開summary DTO内の項目。 */
export type PublicItemSummaryDto = z.output<typeof publicItemSummarySchema>;

/** 公開details DTO内の項目。 */
export type PublicItemDetailsDto = z.output<typeof publicItemDetailsSchema>;

/** 公開DTO内のグラフnode。 */
export type PublicGraphNodeDto = z.output<typeof publicGraphNodeSchema>;

/** 公開DTO内のグラフedge。 */
export type PublicGraphEdgeDto = z.output<typeof publicGraphEdgeSchema>;

/** 公開DTO内の項目履歴差分。 */
export type PublicItemHistoryEventDto = z.output<typeof publicItemHistoryEventSchema>;

/** 通知履歴の公開DTO。 */
export type PublicNotificationHistoryDto = z.output<typeof publicNotificationHistoryDtoSchema>;

/** 通知履歴の公開entry。 */
export type PublicNotificationHistoryEntryDto = z.output<
  typeof publicNotificationHistoryEntrySchema
>;

/** 通知履歴entryを送信時刻降順と表示情報で比較する。 */
export function comparePublicNotificationHistoryEntries(
  left: PublicNotificationHistoryEntryDto,
  right: PublicNotificationHistoryEntryDto,
): number {
  if (left.sentAt > right.sentAt) {
    return -1;
  }
  if (left.sentAt < right.sentAt) {
    return 1;
  }
  if (left.item.displayReference < right.item.displayReference) {
    return -1;
  }
  if (left.item.displayReference > right.item.displayReference) {
    return 1;
  }
  if (left.item.url < right.item.url) {
    return -1;
  }
  if (left.item.url > right.item.url) {
    return 1;
  }
  const reasonCount = Math.min(left.reasons.length, right.reasons.length);
  for (let index = 0; index < reasonCount; index += 1) {
    const leftReason = left.reasons[index];
    const rightReason = right.reasons[index];
    if (leftReason == null || rightReason == null) {
      throw new TypeError("通知履歴の理由を取得できません");
    }
    if (leftReason.reasonCode < rightReason.reasonCode) {
      return -1;
    }
    if (leftReason.reasonCode > rightReason.reasonCode) {
      return 1;
    }
    const leftThreshold = JSON.stringify(leftReason.threshold);
    const rightThreshold = JSON.stringify(rightReason.threshold);
    if (leftThreshold < rightThreshold) {
      return -1;
    }
    if (leftThreshold > rightThreshold) {
      return 1;
    }
  }
  if (left.reasons.length < right.reasons.length) {
    return -1;
  }
  if (left.reasons.length > right.reasons.length) {
    return 1;
  }
  return 0;
}

type PublicNotificationHistoryDisplayIdentity = Readonly<{
  number: number;
  owner: string;
  repository: string;
}>;

type PublicNotificationHistoryUrlIdentity = Readonly<{
  number: number;
  owner: string;
  repository: string;
  type: "issue" | "pull_request";
}>;

function parsePublicNotificationHistoryDisplayReference(
  displayReference: string,
): PublicNotificationHistoryDisplayIdentity {
  const match = /^([^/\s#?%]+)\/([^/\s#?%]+)#([1-9]\d*)$/u.exec(displayReference);
  if (match == null) {
    throw new PublicDtoSemanticError(
      "通知履歴の表示参照がowner/repository#number形式ではありません",
    );
  }
  const owner = match[1];
  const repository = match[2];
  const numberText = match[3];
  assertNonNullable(owner, "通知履歴の表示参照ownerを取得できません");
  assertNonNullable(repository, "通知履歴の表示参照repositoryを取得できません");
  assertNonNullable(numberText, "通知履歴の表示参照numberを取得できません");
  const number = Number.parseInt(numberText, 10);
  if (!Number.isSafeInteger(number)) {
    throw new PublicDtoSemanticError("通知履歴の表示参照numberが安全な整数ではありません");
  }
  return {
    owner,
    repository,
    number,
  };
}

function parsePublicNotificationHistoryUrl(urlValue: string): PublicNotificationHistoryUrlIdentity {
  if (urlValue.includes("?") || urlValue.includes("#") || urlValue.includes("\\")) {
    throw new PublicDtoSemanticError(
      "通知履歴のURLにquery、hash、または不正な区切り文字があります",
    );
  }
  const url = new URL(urlValue);
  if (
    url.protocol !== "https:" ||
    url.hostname !== "github.com" ||
    url.port !== "" ||
    url.username !== "" ||
    url.password !== ""
  ) {
    throw new PublicDtoSemanticError("通知履歴のURLがGitHubのHTTPS URLではありません");
  }
  const match = /^\/([^/\s?#%]+)\/([^/\s?#%]+)\/(issues|pull)\/([1-9]\d*)$/u.exec(url.pathname);
  if (match == null) {
    throw new PublicDtoSemanticError(
      "通知履歴のURL pathがIssueまたはPull Requestの形式ではありません",
    );
  }
  const owner = match[1];
  const repository = match[2];
  const kind = match[3];
  const numberText = match[4];
  assertNonNullable(owner, "通知履歴のURL ownerを取得できません");
  assertNonNullable(repository, "通知履歴のURL repositoryを取得できません");
  assertNonNullable(kind, "通知履歴のURL種別を取得できません");
  assertNonNullable(numberText, "通知履歴のURL numberを取得できません");
  const number = Number.parseInt(numberText, 10);
  if (!Number.isSafeInteger(number)) {
    throw new PublicDtoSemanticError("通知履歴のURL numberが安全な整数ではありません");
  }
  return {
    owner,
    repository,
    number,
    type: kind === "issues" ? "issue" : "pull_request",
  };
}

function assertPublicNotificationHistoryEntryItem(entry: PublicNotificationHistoryEntryDto): void {
  const displayIdentity = parsePublicNotificationHistoryDisplayReference(
    entry.item.displayReference,
  );
  const urlIdentity = parsePublicNotificationHistoryUrl(entry.item.url);
  if (
    displayIdentity.owner !== urlIdentity.owner ||
    displayIdentity.repository !== urlIdentity.repository ||
    displayIdentity.number !== urlIdentity.number ||
    entry.item.number !== displayIdentity.number ||
    entry.item.type !== urlIdentity.type
  ) {
    throw new PublicDtoSemanticError(
      `通知履歴の表示参照とURLのitem identityが一致しません。対象: ${entry.item.nodeId}`,
    );
  }
  for (const waitingOn of entry.waitingOn) {
    if (waitingOn.kind === "item") {
      parsePublicNotificationHistoryDisplayReference(waitingOn.displayReference);
    }
  }
}

function assertPublicSummaryWaitingOnReferences(summary: PublicSummaryDto): void {
  const summaryItemNodeIds = new Set(summary.items.map((item) => item.nodeId));
  const externalGraphNodeIds = new Set(
    summary.graph.nodes
      .filter((node) => node.kind === "external_reference")
      .map((node) => node.nodeId),
  );
  const candidateIds = new Set<string>();
  for (const item of summary.items) {
    for (const waitingOn of item.waitingOn) {
      if (waitingOn.kind === "item") {
        candidateIds.add(waitingOn.candidateId);
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

/** 未検証の値を共有公開summary DTOへ変換する。 */
export function createPublicSummaryDto(value: unknown): PublicSummaryDto {
  const result = publicSummaryDtoSchema.safeParse(value);
  if (!result.success) {
    throw new PublicDtoValidationError("summary", {
      cause: result.error,
    });
  }
  assertPublicSummaryWaitingOnReferences(result.data);
  return result.data;
}

/** 未検証の値を共有公開details DTOへ変換する。 */
export function createPublicDetailsDto(value: unknown): PublicDetailsDto {
  const result = publicDetailsDtoSchema.safeParse(value);
  if (!result.success) {
    throw new PublicDtoValidationError("details", {
      cause: result.error,
    });
  }
  return result.data;
}

/** 未検証の値を共有公開notification history DTOへ変換する。 */
export function createPublicNotificationHistoryDto(value: unknown): PublicNotificationHistoryDto {
  const result = publicNotificationHistoryDtoSchema.safeParse(value);
  if (!result.success) {
    throw new PublicDtoValidationError("notification-history", {
      cause: result.error,
    });
  }
  for (const notification of result.data.notifications) {
    assertPublicNotificationHistoryEntryItem(notification);
  }
  return result.data;
}
