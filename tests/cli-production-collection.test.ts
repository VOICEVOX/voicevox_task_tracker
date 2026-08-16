import { join } from "node:path";

import { z } from "zod";
import { describe, expect, it } from "vitest";

import {
  createProductionCliApplication,
  type ProductionRuntimeAdapters,
} from "../src/cli/production-runtime.js";
import { createWorkflowArtifact, type WorkflowArtifact } from "../src/cli/workflow-artifact.js";
import {
  createAiCacheEntry,
  createAiCacheKey,
  hashCanonicalJson,
  parseSha256Hash,
  serializeCanonicalJson,
  type CodexAnalysisInput,
  type SchemaValidCodexAnalysisOutput,
} from "../src/codex/index.js";
import { loadConfig, type Config } from "../src/config/index.js";
import { type DiscordDigestDelivery } from "../src/discord/index.js";
import {
  buildSourceId,
  createExternalReferenceNodeId,
  createGitHubNodeId,
  createGitHubRepositoryId,
  createUtcIsoDateTime,
  DETERMINISTIC_RULES_VERSION,
  type GitHubItemDisplayReference,
  type GitHubItemUrl,
  type GitHubNodeId,
  type NotificationReasonCode,
  type ObservedGitHubItemState,
  type Repository,
  type UtcIsoDateTime,
} from "../src/domain/index.js";
import {
  createGitHubBodyFingerprint,
  createGitHubPullRequestVolatileMetadataFromDetail,
  createPublicRepositoryAllowlist,
  finalizeGitHubItemsWithVolatileMetadata,
  GitHubApiBudgetExceededError,
  GitHubPullRequestVolatileRaceError,
  GitHubPullRequestVolatileRaceRetryExhaustedError,
  GitHubResponseSchemaValidationError,
  GitHubRetryExhaustedError,
  resolveGitHubRelationReference,
  type EnumeratedGitHubItem,
  type GitHubItemDetail,
  type GitHubCheckContext,
  type GitHubItemMilestone,
  type GitHubInboundCrossReferenceCandidate,
  type GitHubItemAccount,
  type GitHubIssueComment,
  type GitHubNativeClosingIssue,
  type GitHubNativeDependency,
  type GitHubNativeHierarchy,
  type GitHubReferencedItem,
  type GitHubTimelineEvent,
  type GitHubUserContentEdit,
  type GitHubPullRequestVolatileMetadata,
  type PublicRepository,
} from "../src/github/index.js";
import { type RelationAssessmentVerdict } from "../src/graph/index.js";
import {
  CacheOnlyPersistenceSession,
  createCacheDocument,
  createStateSnapshot,
  MemoryStateBranchAdapter,
  type GitHubItemCacheRelationCandidate,
  type StateSnapshot,
} from "../src/persistence/index.js";
import { type GeneratedPublicData } from "../src/pages/index.js";
import { assertNonNullable } from "../src/util/index.js";

const PRIVATE_KEY = [
  "-----BEGIN PRIVATE KEY-----",
  "production-collection-test-key",
  "-----END PRIVATE KEY-----",
].join("\n");
const START_AT = "2026-01-01T00:00:00.000Z";
const FIRST_RUN_AT = "2026-08-01T00:00:00.000Z";
const SECOND_RUN_AT = "2026-08-02T00:00:00.000Z";
const THIRD_RUN_AT = "2026-08-04T00:00:00.000Z";
const FOURTH_RUN_AT = "2026-08-05T00:00:00.000Z";
const OLD_ITEM_AT = "2025-12-01T00:00:00.000Z";
const displayReferenceSchema = z.custom<GitHubItemDisplayReference>(
  (value) => typeof value === "string" && /^[^/\s]+\/[^#\s]+#[1-9]\d*$/u.test(value),
);

type CacheRelationNodeFixture = Extract<
  GitHubItemCacheRelationCandidate["relation"],
  { type: "blocks" }
>["blocker"];

type CacheCandidateCorruption = "current_reference_mismatch" | "node_alias";

function corruptExternalCacheNode(
  node: CacheRelationNodeFixture,
  corruption: CacheCandidateCorruption,
): CacheRelationNodeFixture {
  if (node.scope !== "external_public") {
    return node;
  }
  if (corruption === "node_alias") {
    return {
      ...node,
      nodeId: createExternalReferenceNodeId("external:github:malformed-cache-alias"),
    };
  }
  return {
    ...node,
    repositoryName: "malformed-cache-reference",
  };
}

function corruptExternalCacheCandidate(
  candidate: GitHubItemCacheRelationCandidate,
  corruption: CacheCandidateCorruption,
): GitHubItemCacheRelationCandidate {
  switch (candidate.relation.type) {
    case "blocks":
      return {
        ...candidate,
        relation: {
          ...candidate.relation,
          blocker: corruptExternalCacheNode(candidate.relation.blocker, corruption),
          blocked: corruptExternalCacheNode(candidate.relation.blocked, corruption),
        },
      };
    case "parent_of":
      return {
        ...candidate,
        relation: {
          ...candidate.relation,
          parent: corruptExternalCacheNode(candidate.relation.parent, corruption),
          subtask: corruptExternalCacheNode(candidate.relation.subtask, corruption),
        },
      };
    case "implements":
      return {
        ...candidate,
        relation: {
          ...candidate.relation,
          implementation: corruptExternalCacheNode(candidate.relation.implementation, corruption),
          target: corruptExternalCacheNode(candidate.relation.target, corruption),
        },
      };
    case "unclassified":
      return {
        ...candidate,
        relation: {
          ...candidate.relation,
          referencing: corruptExternalCacheNode(candidate.relation.referencing, corruption),
          referenced: corruptExternalCacheNode(candidate.relation.referenced, corruption),
        },
      };
  }
}

function cacheCandidateHasExternalNode(candidate: GitHubItemCacheRelationCandidate): boolean {
  switch (candidate.relation.type) {
    case "blocks":
      return (
        candidate.relation.blocker.scope === "external_public" ||
        candidate.relation.blocked.scope === "external_public"
      );
    case "parent_of":
      return (
        candidate.relation.parent.scope === "external_public" ||
        candidate.relation.subtask.scope === "external_public"
      );
    case "implements":
      return (
        candidate.relation.implementation.scope === "external_public" ||
        candidate.relation.target.scope === "external_public"
      );
    case "unclassified":
      return (
        candidate.relation.referencing.scope === "external_public" ||
        candidate.relation.referenced.scope === "external_public"
      );
  }
}

type IssueStateFixture =
  | Readonly<{
      state: "open";
    }>
  | Readonly<{
      state: "closed";
      closedAt: UtcIsoDateTime;
    }>;

interface RepositoryFixture {
  repository: Repository;
  openItems: EnumeratedGitHubItem[];
  individualItems: Map<string, EnumeratedGitHubItem>;
  details: Map<GitHubNodeId, GitHubItemDetail>;
  enumerationFailsWith503: boolean;
}

type DetailCall = Readonly<{
  targets: readonly Readonly<{
    nodeId: GitHubNodeId;
  }>[];
}>;

type VolatileProbeCall = Readonly<{
  pullRequestNodeIds: readonly GitHubNodeId[];
}>;

type ExternalRelationGraphqlRequest = Readonly<{
  owner: string;
  name: string;
  number: number;
  itemType: "issue" | "pull_request" | null;
}>;

type ExternalRelationGraphqlResponseFactory = (
  request: ExternalRelationGraphqlRequest,
) => Readonly<Record<string, unknown>>;

type ExternalRelationGraphqlItemOptions = Readonly<{
  itemType: "issue" | "pull_request";
  visibility: "PUBLIC" | "PRIVATE" | "INTERNAL";
  archived: boolean;
  disabled: boolean;
  nodeId?: string;
  state?: "OPEN" | "CLOSED";
}>;

function createRepository(id: string, name: string, observedAt: string): Repository {
  return Object.freeze({
    id: createGitHubRepositoryId(id),
    owner: "VOICEVOX",
    name,
    visibility: "public",
    archived: false,
    disabled: false,
    observedAt: createUtcIsoDateTime(observedAt),
  });
}

function requirePublicRepository(repository: Repository): PublicRepository {
  const value = createPublicRepositoryAllowlist([repository]).repositories[0];
  if (value == null) {
    throw new TypeError("公開repository fixtureを作成できません");
  }
  return value;
}

function createIssueItem(
  options: Readonly<{
    repository: PublicRepository;
    number: number;
    fingerprint: string;
    updatedAt: UtcIsoDateTime;
    observedAt: UtcIsoDateTime;
    state: IssueStateFixture;
  }>,
): EnumeratedGitHubItem {
  const nodeId = createGitHubNodeId(`I_${options.repository.name}_${options.number.toString()}`);
  const url =
    `https://github.com/${options.repository.owner}/${options.repository.name}/issues/${options.number.toString()}` satisfies GitHubItemUrl;
  const displayReference = displayReferenceSchema.parse(
    `${options.repository.owner}/${options.repository.name}#${options.number.toString()}`,
  );
  const stateFields: ObservedGitHubItemState =
    options.state.state === "open"
      ? Object.freeze({
          state: "open",
          stateReason: null,
          closedAt: null,
        })
      : Object.freeze({
          state: "closed",
          stateReason: "completed",
          closedAt: options.state.closedAt,
        });
  return Object.freeze({
    nodeId,
    repositoryId: options.repository.id,
    displayReference,
    number: options.number,
    url,
    title: `項目${options.number.toString()}`,
    bodyFingerprint: createGitHubBodyFingerprint(`body-${options.fingerprint}`),
    bodyLocator: Object.freeze({
      kind: "github_item_body",
      repositoryId: options.repository.id,
      itemNodeId: nodeId,
      number: options.number,
    }),
    author: Object.freeze({
      kind: "account",
      account: Object.freeze({
        nodeId: createGitHubNodeId(`U_author_${options.number.toString()}`),
        login: `author-${options.number.toString()}`,
        apiType: "User",
      }),
    }),
    createdAt: createUtcIsoDateTime("2026-07-01T00:00:00.000Z"),
    updatedAt: options.updatedAt,
    assignees: Object.freeze([]),
    labels: Object.freeze([]),
    milestone: null,
    itemFingerprint: createGitHubBodyFingerprint(`item-${options.fingerprint}`),
    observedAt: options.observedAt,
    type: "issue",
    draft: "not_applicable",
    ...stateFields,
  });
}

function replaceCreatedAt(
  item: EnumeratedGitHubItem,
  createdAt: UtcIsoDateTime,
): EnumeratedGitHubItem {
  return Object.freeze({
    ...item,
    createdAt,
  });
}

function createOldIssueItem(
  repository: PublicRepository,
  number: number,
  fingerprint: string,
  observedAt: UtcIsoDateTime,
): EnumeratedGitHubItem {
  const oldItemAt = createUtcIsoDateTime(OLD_ITEM_AT);
  return replaceCreatedAt(
    createIssueItem({
      repository,
      number,
      fingerprint,
      updatedAt: oldItemAt,
      observedAt,
      state: Object.freeze({ state: "open" }),
    }),
    oldItemAt,
  );
}

function replaceWithAutomationDashboard(
  item: EnumeratedGitHubItem,
  title: string,
): EnumeratedGitHubItem {
  return Object.freeze({
    ...item,
    title,
    author: Object.freeze({
      kind: "account",
      account: Object.freeze({
        nodeId: createGitHubNodeId("BOT_RENOVATE"),
        login: "renovate[bot]",
        apiType: "Bot",
      }),
    }),
  });
}

function createPullRequestItem(
  options: Readonly<{
    repository: PublicRepository;
    number: number;
    fingerprint: string;
    updatedAt: UtcIsoDateTime;
    observedAt: UtcIsoDateTime;
  }>,
): EnumeratedGitHubItem {
  const issue = createIssueItem({
    ...options,
    state: Object.freeze({ state: "open" }),
  });
  return Object.freeze({
    ...issue,
    type: "pull_request",
    draft: false,
    mergeStatus: "not_merged",
    url: `https://github.com/${options.repository.owner}/${options.repository.name}/pull/${options.number.toString()}`,
  } satisfies EnumeratedGitHubItem);
}

function alignPullRequestBodyFingerprint(item: EnumeratedGitHubItem): EnumeratedGitHubItem {
  if (item.type !== "pull_request") {
    throw new TypeError("Pull Request以外の本文fingerprintは調整できません");
  }
  return Object.freeze({
    ...item,
    bodyFingerprint: createGitHubBodyFingerprint("required checkの失敗原因を判定する"),
  });
}

function createMergedPullRequestItem(
  options: Readonly<{
    repository: PublicRepository;
    number: number;
    fingerprint: string;
    closedAt: UtcIsoDateTime;
    mergedAt: UtcIsoDateTime;
    observedAt: UtcIsoDateTime;
  }>,
): EnumeratedGitHubItem {
  const issue = createIssueItem({
    repository: options.repository,
    number: options.number,
    fingerprint: options.fingerprint,
    updatedAt: options.mergedAt,
    observedAt: options.observedAt,
    state: Object.freeze({
      state: "closed",
      closedAt: options.closedAt,
    }),
  });
  return Object.freeze({
    ...issue,
    type: "pull_request",
    draft: false,
    mergeStatus: "merged",
    mergedAt: options.mergedAt,
    url: `https://github.com/${options.repository.owner}/${options.repository.name}/pull/${options.number.toString()}`,
  } satisfies EnumeratedGitHubItem);
}

function createFailedCheckPullRequestDetail(
  item: EnumeratedGitHubItem,
  observedAt: UtcIsoDateTime,
): Extract<GitHubItemDetail, Readonly<{ type: "pull_request" }>> {
  const headSourceId = buildSourceId("github_commit", `${item.nodeId}:head`);
  const checkSourceId = buildSourceId("github_check_rollup", item.nodeId);
  const contextSourceId = buildSourceId("github_check_run", `${item.nodeId}:test`);
  const stateTimeline =
    item.state === "closed"
      ? Object.freeze([
          Object.freeze({
            sourceId: buildSourceId("github_timeline_event", `${item.nodeId}:closed`),
            nodeId: createGitHubNodeId(`${item.nodeId}:closed`),
            sequence: 0,
            occurredAt: item.closedAt,
            actor: Object.freeze({
              status: "unavailable",
              reason: "github_did_not_return_actor",
            }),
            kind: "closed",
          } satisfies GitHubTimelineEvent),
          ...(item.type === "pull_request" && item.mergeStatus === "merged"
            ? [
                Object.freeze({
                  sourceId: buildSourceId("github_timeline_event", `${item.nodeId}:merged`),
                  nodeId: createGitHubNodeId(`${item.nodeId}:merged`),
                  sequence: 1,
                  occurredAt: item.mergedAt,
                  actor: Object.freeze({
                    status: "unavailable",
                    reason: "github_did_not_return_actor",
                  }),
                  kind: "merged",
                } satisfies GitHubTimelineEvent),
              ]
            : []),
        ])
      : Object.freeze([]);
  return Object.freeze({
    sourceId: buildSourceId("github_item_detail", item.nodeId),
    nodeId: item.nodeId,
    repositoryId: item.repositoryId,
    number: item.number,
    type: "pull_request",
    reviewDecision: null,
    bodySourceId: buildSourceId("github_item_body", item.nodeId),
    body: "required checkの失敗原因を判定する",
    lastEditedAt: null,
    bodyUserContentEdits: Object.freeze({
      availability: "unavailable",
      reason: "connection_null",
    }),
    comments: Object.freeze([]),
    timeline: stateTimeline,
    inboundCrossReferences: Object.freeze([]),
    reviews: Object.freeze([]),
    reviewThreads: Object.freeze([]),
    reviewRequests: Object.freeze({
      current: Object.freeze([]),
      history: Object.freeze([]),
    }),
    nativeClosingIssues: Object.freeze([]),
    headSha: `head-${item.nodeId}`,
    headCommit: Object.freeze({
      sourceId: headSourceId,
      nodeId: createGitHubNodeId(`C_${item.nodeId}`),
      sha: `head-${item.nodeId}`,
      committedAt: observedAt,
      pushedAt: Object.freeze({
        status: "available",
        value: observedAt,
      }),
    }),
    mergeState: Object.freeze({
      mergeability: "mergeable",
      mergeState: "unstable",
      autoMerge: Object.freeze({
        status: "not_enabled",
      }),
      mergeQueue: Object.freeze({
        status: "not_queued",
      }),
      checks: Object.freeze({
        status: "configured",
        sourceId: checkSourceId,
        nodeId: createGitHubNodeId(`CHECKS_${item.nodeId}`),
        combinedState: "failure",
        contexts: Object.freeze([
          Object.freeze({
            type: "check_run",
            sourceId: contextSourceId,
            nodeId: createGitHubNodeId(`CHECK_${item.nodeId}`),
            name: "test",
            status: "completed",
            conclusion: "failure",
            completedAt: observedAt,
          }),
        ]),
      }),
    }),
    observedAt,
  });
}

function createDuplicateComments(
  item: EnumeratedGitHubItem,
  occurredAt: UtcIsoDateTime,
): readonly GitHubIssueComment[] {
  const nodeId = createGitHubNodeId(`IC_${item.nodeId}`);
  const comment = Object.freeze({
    sourceId: buildSourceId("github_issue_comment", nodeId),
    nodeId,
    sequence: 0,
    author: Object.freeze({
      status: "identified",
      account: Object.freeze({
        sourceId: buildSourceId("github_account", "U_commenter"),
        nodeId: createGitHubNodeId("U_commenter"),
        login: "commenter",
        apiType: "User",
      }),
    }),
    body: "重複したコメント",
    createdAt: occurredAt,
    lastEditedAt: null,
    updatedAt: occurredAt,
    url: `${item.url}#issuecomment-${nodeId}`,
    userContentEdits: Object.freeze({
      availability: "unavailable",
      reason: "connection_null",
    }),
  } satisfies GitHubIssueComment);
  return Object.freeze([
    comment,
    Object.freeze({
      ...comment,
      sequence: 1,
    }),
  ]);
}

function createIssueDetail(
  options: Readonly<{
    item: EnumeratedGitHubItem;
    body: string;
    observedAt: UtcIsoDateTime;
    nativeDependencies: readonly GitHubNativeDependency[];
    duplicateComments: boolean;
  }>,
): GitHubItemDetail {
  const stateTimeline =
    options.item.state === "closed"
      ? Object.freeze([
          Object.freeze({
            sourceId: buildSourceId("github_timeline_event", `${options.item.nodeId}:closed`),
            nodeId: createGitHubNodeId(`${options.item.nodeId}:closed`),
            sequence: 0,
            occurredAt: options.item.closedAt,
            actor: Object.freeze({
              status: "unavailable",
              reason: "github_did_not_return_actor",
            }),
            kind: "closed",
          } satisfies GitHubTimelineEvent),
        ])
      : Object.freeze([]);
  return Object.freeze({
    sourceId: buildSourceId("github_item_detail", options.item.nodeId),
    nodeId: options.item.nodeId,
    repositoryId: options.item.repositoryId,
    number: options.item.number,
    type: "issue",
    bodySourceId: buildSourceId("github_item_body", options.item.nodeId),
    body: options.body,
    lastEditedAt: null,
    bodyUserContentEdits: Object.freeze({
      availability: "unavailable",
      reason: "connection_null",
    }),
    comments: options.duplicateComments
      ? createDuplicateComments(options.item, options.observedAt)
      : Object.freeze([]),
    timeline: stateTimeline,
    inboundCrossReferences: Object.freeze([]),
    nativeDependencies: Object.freeze({
      availability: "available",
      relations: options.nativeDependencies,
    }),
    nativeHierarchy: Object.freeze({
      availability: "available",
      relations: Object.freeze([]),
    }),
    observedAt: options.observedAt,
  });
}

function createNativeBlocker(
  blocked: EnumeratedGitHubItem,
  blocker: EnumeratedGitHubItem,
): GitHubNativeDependency {
  const repositoryName = new URL(blocker.url).pathname.split("/")[2];
  if (repositoryName == null || repositoryName.length === 0) {
    throw new TypeError("blocker URLからrepository名を取得できません");
  }
  return Object.freeze({
    sourceId: buildSourceId("github_native_dependency", `${blocked.nodeId}:${blocker.nodeId}`),
    authoritative: true,
    provenance: "native",
    direction: "blocked_by",
    relatedItem: Object.freeze({
      sourceId: buildSourceId("github_item", blocker.nodeId),
      nodeId: blocker.nodeId,
      repositoryId: blocker.repositoryId,
      repositoryOwner: "VOICEVOX",
      repositoryName,
      repositoryArchived: false,
      repositoryDisabled: false,
      type: blocker.type,
      number: blocker.number,
      url: blocker.url,
      createdAt: blocker.createdAt,
      state:
        blocker.type === "pull_request" && blocker.mergeStatus === "merged"
          ? "merged"
          : blocker.state,
    }),
  });
}

function createNativeDependencyTimelineEvent(
  blocked: EnumeratedGitHubItem,
  blocker: EnumeratedGitHubItem,
  action: "added" | "removed",
  occurredAt: UtcIsoDateTime,
  sequence: number,
): GitHubTimelineEvent {
  return Object.freeze({
    sourceId: buildSourceId(
      "github_timeline_event",
      `${blocked.nodeId}:${blocker.nodeId}:${action}:${sequence.toString()}`,
    ),
    nodeId: createGitHubNodeId(
      `${blocked.nodeId}:${blocker.nodeId}:${action}:${sequence.toString()}`,
    ),
    sequence,
    occurredAt,
    actor: Object.freeze({
      status: "unavailable",
      reason: "github_did_not_return_actor",
    }),
    kind: action === "added" ? "blocked_by_added" : "blocked_by_removed",
    blockingIssue: createReferencedItem(blocker),
  });
}

function createReferencedItem(item: EnumeratedGitHubItem): GitHubReferencedItem {
  const urlParts = new URL(item.url).pathname.split("/");
  const repositoryOwner = urlParts[1];
  const repositoryName = urlParts[2];
  if (
    repositoryOwner == null ||
    repositoryOwner.length === 0 ||
    repositoryName == null ||
    repositoryName.length === 0
  ) {
    throw new TypeError("参照項目URLからrepository情報を取得できません");
  }
  return Object.freeze({
    sourceId: buildSourceId("github_item", item.nodeId),
    nodeId: item.nodeId,
    repositoryId: item.repositoryId,
    repositoryOwner,
    repositoryName,
    repositoryArchived: false,
    repositoryDisabled: false,
    type: item.type,
    number: item.number,
    url: item.url,
    createdAt: item.createdAt,
    state: item.type === "pull_request" && item.mergeStatus === "merged" ? "merged" : item.state,
  });
}

function createExternalRelationGraphqlResponse(
  request: ExternalRelationGraphqlRequest,
  options: ExternalRelationGraphqlItemOptions,
): Readonly<Record<string, unknown>> {
  const itemNumber = request.number;
  const itemPath = options.itemType === "issue" ? "issues" : "pull";
  const itemNodeId = options.nodeId ?? `I_external_${request.name}_${itemNumber.toString()}`;
  const item = Object.freeze({
    __typename: options.itemType === "issue" ? "Issue" : "PullRequest",
    id: itemNodeId,
    number: itemNumber,
    url: `https://github.com/${request.owner}/${request.name}/${itemPath}/${itemNumber.toString()}`,
    createdAt: "2026-07-01T00:00:00.000Z",
    ...(options.itemType === "issue"
      ? { issueState: options.state ?? "OPEN" }
      : { pullRequestState: options.state ?? "OPEN" }),
    repository: Object.freeze({
      id: `R_external_${request.name}`,
      name: request.name,
      visibility: options.visibility,
      isArchived: options.archived,
      isDisabled: options.disabled,
      owner: Object.freeze({ login: request.owner }),
    }),
  });
  if (options.itemType === "issue") {
    return Object.freeze({
      repository: Object.freeze({
        issue: item,
      }),
    });
  }
  return Object.freeze({
    repository: Object.freeze({
      pullRequest: item,
    }),
  });
}

function createNativeBlocking(
  blocker: EnumeratedGitHubItem,
  blocked: EnumeratedGitHubItem,
): GitHubNativeDependency {
  return Object.freeze({
    sourceId: buildSourceId("github_native_dependency", `${blocker.nodeId}:${blocked.nodeId}`),
    authoritative: true,
    provenance: "native",
    direction: "blocking",
    relatedItem: createReferencedItem(blocked),
  });
}

function createNativeClosingIssue(
  pullRequest: EnumeratedGitHubItem,
  issue: EnumeratedGitHubItem,
): GitHubNativeClosingIssue {
  return Object.freeze({
    sourceId: buildSourceId("github_native_closing_issue", `${pullRequest.nodeId}:${issue.nodeId}`),
    authoritative: true,
    provenance: "native",
    relatedItem: createReferencedItem(issue),
  });
}

function createInboundCrossReference(
  target: EnumeratedGitHubItem,
  source: EnumeratedGitHubItem,
  observedAt: UtcIsoDateTime,
  willCloseTarget: boolean,
): Readonly<{
  event: GitHubTimelineEvent;
  candidate: GitHubInboundCrossReferenceCandidate;
}> {
  const sourceItem = createReferencedItem(source);
  const eventNodeId = createGitHubNodeId(`CRE_${target.nodeId}_${source.nodeId}`);
  const eventSourceId = buildSourceId("github_timeline_event", eventNodeId);
  return Object.freeze({
    event: Object.freeze({
      sourceId: eventSourceId,
      nodeId: eventNodeId,
      sequence: 0,
      occurredAt: observedAt,
      actor: Object.freeze({
        status: "unavailable",
        reason: "github_did_not_return_actor",
      }),
      kind: "cross_referenced",
      source: sourceItem,
      willCloseTarget,
    } satisfies GitHubTimelineEvent),
    candidate: Object.freeze({
      sourceId: buildSourceId("github_inbound_cross_reference", `${eventNodeId}:${source.nodeId}`),
      candidateOnly: true,
      provenance: "cross_reference",
      eventSourceId,
      sourceItem,
      willCloseTarget,
    } satisfies GitHubInboundCrossReferenceCandidate),
  });
}

function createIssueDetailWithInboundCrossReferences(
  item: EnumeratedGitHubItem,
  sources: readonly EnumeratedGitHubItem[],
  observedAt: UtcIsoDateTime,
): GitHubItemDetail {
  const references = sources.map((source) =>
    createInboundCrossReference(item, source, observedAt, false),
  );
  return Object.freeze({
    ...createIssueDetail({
      item,
      body: "本文",
      observedAt,
      nativeDependencies: Object.freeze([]),
      duplicateComments: false,
    }),
    timeline: Object.freeze(references.map((reference) => reference.event)),
    inboundCrossReferences: Object.freeze(references.map((reference) => reference.candidate)),
  });
}

function createRelationStateConflictIssueFixture(observedAt: UtcIsoDateTime): Readonly<{
  fixture: RepositoryFixture;
  tracked: EnumeratedGitHubItem;
  sourceOpen: EnumeratedGitHubItem;
  sourceClosed: EnumeratedGitHubItem;
}> {
  const repository = createRepository("R_relation_state_error", "relation-state-error", observedAt);
  const publicRepository = requirePublicRepository(repository);
  const fixture = createRepositoryFixture(repository);
  const tracked = createIssueItem({
    repository: publicRepository,
    number: 1,
    fingerprint: "tracked-state-error",
    updatedAt: observedAt,
    observedAt,
    state: Object.freeze({ state: "open" }),
  });
  const sourceOpen = createIssueItem({
    repository: publicRepository,
    number: 2,
    fingerprint: "source-state-error-open",
    updatedAt: observedAt,
    observedAt,
    state: Object.freeze({ state: "open" }),
  });
  const sourceClosed = createIssueItem({
    repository: publicRepository,
    number: 2,
    fingerprint: "source-state-error-closed",
    updatedAt: observedAt,
    observedAt,
    state: Object.freeze({ state: "closed", closedAt: observedAt }),
  });
  fixture.openItems = [tracked, sourceOpen];
  fixture.details.set(
    tracked.nodeId,
    createIssueDetailWithInboundCrossReferences(tracked, [sourceClosed], observedAt),
  );
  fixture.details.set(
    sourceOpen.nodeId,
    createIssueDetail({
      item: sourceOpen,
      body: "本文",
      observedAt,
      nativeDependencies: Object.freeze([]),
      duplicateComments: false,
    }),
  );
  return Object.freeze({ fixture, tracked, sourceOpen, sourceClosed });
}

function createInferredRelationFixture(observedAt: UtcIsoDateTime): Readonly<{
  repository: Repository;
  fixture: RepositoryFixture;
  items: readonly EnumeratedGitHubItem[];
  referencing: EnumeratedGitHubItem;
}> {
  const repository = createRepository(
    "R_semantic_retry_relation",
    "semantic-retry-relation",
    observedAt,
  );
  const publicRepository = requirePublicRepository(repository);
  const fixture = createRepositoryFixture(repository);
  const referencing = createIssueItem({
    repository: publicRepository,
    number: 1,
    fingerprint: "semantic-retry-referencing",
    updatedAt: observedAt,
    observedAt,
    state: Object.freeze({
      state: "closed",
      closedAt: observedAt,
    }),
  });
  const referenced = createIssueItem({
    repository: publicRepository,
    number: 2,
    fingerprint: "semantic-retry-referenced",
    updatedAt: observedAt,
    observedAt,
    state: Object.freeze({
      state: "closed",
      closedAt: observedAt,
    }),
  });
  const blocker = createIssueItem({
    repository: publicRepository,
    number: 3,
    fingerprint: "semantic-retry-blocker",
    updatedAt: observedAt,
    observedAt,
    state: Object.freeze({
      state: "closed",
      closedAt: observedAt,
    }),
  });
  const items = Object.freeze([referencing, referenced, blocker]);
  for (const item of items) {
    fixture.individualItems.set(item.url, item);
  }
  fixture.details.set(
    referencing.nodeId,
    createIssueDetail({
      item: referencing,
      body: `${referenced.url} を参照します`,
      observedAt,
      nativeDependencies: Object.freeze([]),
      duplicateComments: false,
    }),
  );
  fixture.details.set(
    referenced.nodeId,
    createIssueDetail({
      item: referenced,
      body: "本文",
      observedAt,
      nativeDependencies: Object.freeze([createNativeBlocker(referenced, blocker)]),
      duplicateComments: false,
    }),
  );
  fixture.details.set(
    blocker.nodeId,
    createIssueDetail({
      item: blocker,
      body: "本文",
      observedAt,
      nativeDependencies: Object.freeze([]),
      duplicateComments: false,
    }),
  );
  return Object.freeze({ repository, fixture, items, referencing });
}

function createExternalNativeBlocker(
  blocked: EnumeratedGitHubItem,
  options: Readonly<{
    state: "open" | "closed";
    repositoryArchived: boolean;
    repositoryDisabled: boolean;
  }>,
): GitHubNativeDependency {
  const externalNodeId = createGitHubNodeId("I_external_blocker");
  return Object.freeze({
    sourceId: buildSourceId("github_native_dependency", `${blocked.nodeId}:${externalNodeId}`),
    authoritative: true,
    provenance: "native",
    direction: "blocked_by",
    relatedItem: Object.freeze({
      sourceId: buildSourceId("github_item", externalNodeId),
      nodeId: externalNodeId,
      repositoryId: createGitHubRepositoryId("R_external_public"),
      repositoryOwner: "external-owner",
      repositoryName: "external-repository",
      repositoryArchived: options.repositoryArchived,
      repositoryDisabled: options.repositoryDisabled,
      type: "issue",
      number: 42,
      url: "https://github.com/external-owner/external-repository/issues/42",
      createdAt: blocked.createdAt,
      state: options.state,
    }),
  });
}

function createRepositoryFixture(repository: Repository): RepositoryFixture {
  return {
    repository,
    openItems: [],
    individualItems: new Map(),
    details: new Map(),
    enumerationFailsWith503: false,
  };
}

async function createTestConfig(
  options: Readonly<{
    explicitIncludes: readonly string[];
    retentionDays: number;
    aiEnabled: boolean;
  }>,
): Promise<Config> {
  const base = await loadConfig(join(import.meta.dirname, "fixtures/config.valid.yml"));
  return Object.freeze({
    ...base,
    tracking: Object.freeze({
      ...base.tracking,
      startAt: START_AT,
      include: [...options.explicitIncludes],
      retentionDaysAfterTerminal: options.retentionDays,
    }),
    maintainers: Object.freeze({
      defaults: ["production-test-maintainer"],
      repositories: Object.freeze({}),
    }),
    ai: Object.freeze({
      ...base.ai,
      enabled: options.aiEnabled,
    }),
    notifications: Object.freeze({
      ...base.notifications,
      discord: Object.freeze({
        ...base.notifications.discord,
        enabled: false,
      }),
    }),
  });
}

function configWithBudget(
  config: Config,
  maxCallsPerRun: number,
  maxEstimatedCostUsdPerRun: number,
): Config {
  return Object.freeze({
    ...config,
    ai: Object.freeze({
      ...config.ai,
      budget: Object.freeze({
        ...config.ai.budget,
        maxCallsPerRun,
        maxEstimatedCostUsdPerRun,
      }),
    }),
  });
}

function configWithRelationExpansionLimit(config: Config, maxItemsPerRun: number): Config {
  return Object.freeze({
    ...config,
    tracking: Object.freeze({
      ...config.tracking,
      relationExpansion: Object.freeze({
        maxItemsPerRun,
      }),
    }),
  });
}

function requireSingleRepository(repositories: readonly PublicRepository[]): PublicRepository {
  const repository = repositories[0];
  if (repository == null || repositories.length !== 1) {
    throw new TypeError("repository単位の収集呼び出しではありません");
  }
  return repository;
}

function requireWorkflowSnapshot(artifacts: readonly unknown[]): StateSnapshot {
  const artifact = artifacts.at(-1);
  if (typeof artifact !== "object" || artifact == null) {
    throw new TypeError("workflow artifactがありません");
  }
  if ("snapshot" in artifact) {
    return createStateSnapshot(artifact.snapshot);
  }
  if ("result" in artifact) {
    const result = artifact.result;
    if (typeof result === "object" && result != null && "snapshot" in result) {
      return createStateSnapshot(result.snapshot);
    }
  }
  throw new TypeError(`workflow artifactにsnapshotがありません。値: ${JSON.stringify(artifact)}`);
}

function requireCollectAnalyzeArtifact(artifacts: readonly unknown[]): WorkflowArtifact {
  const artifact = artifacts.at(-1);
  if (typeof artifact !== "object" || artifact == null || !("kind" in artifact)) {
    throw new TypeError(`collect-analyze artifactがありません。値: ${JSON.stringify(artifact)}`);
  }
  return createWorkflowArtifact(artifact);
}

const requireDryRunSnapshot = requireWorkflowSnapshot;

function requireCollectionItem(
  snapshot: StateSnapshot,
  nodeId: GitHubNodeId,
): StateSnapshot["collection"]["repositories"][number]["items"][number] {
  const item = snapshot.collection.repositories
    .flatMap((repository) => repository.items)
    .find((candidate) => candidate.nodeId === nodeId);
  if (item == null) {
    throw new TypeError(`snapshotの収集項目がありません。対象: ${nodeId}`);
  }
  return item;
}

function requireCodexAuthorCandidateId(input: CodexAnalysisInput): string {
  const authorCandidateId = input.item.authorCandidateId;
  if (authorCandidateId == null) {
    throw new TypeError(`Codex入力の作者候補IDがありません。対象: ${input.item.nodeId}`);
  }
  return authorCandidateId;
}

function createCodexOutput(
  input: CodexAnalysisInput,
  options: Readonly<{
    status:
      | "waiting_for_review"
      | "waiting_for_revision"
      | "waiting_for_reply"
      | "waiting_for_automation"
      | "in_progress"
      | "unknown";
    waitingOn: Readonly<{
      candidateId: string;
      kind: "user" | "team" | "role" | "item" | "automation" | "unknown";
      role:
        | "author"
        | "maintainer"
        | "reviewer"
        | "assignee"
        | "respondent"
        | "dependency"
        | "merge_decider"
        | "ci"
        | "unknown";
      sourceId: string;
    }>;
    latestMeaningfulSourceId: string | null;
    confidence: number;
    relationVerdict: RelationAssessmentVerdict;
    notification: Readonly<{
      recommended: boolean;
      reasonCode: NotificationReasonCode;
      reasonSummary: string;
    }>;
  }>,
): SchemaValidCodexAnalysisOutput {
  const evidenceSource = input.sources[0];
  if (evidenceSource == null) {
    throw new TypeError("Codex入力にsourceがありません");
  }
  return {
    schemaVersion: "2",
    item: {
      nodeId: input.item.nodeId,
      url: input.item.url,
    },
    status: options.status,
    waitingOn: [
      {
        kind: options.waitingOn.kind,
        candidateId: options.waitingOn.candidateId,
        role: options.waitingOn.role,
        reasonSummary: "本番経路fixtureの判定です",
        sourceIds: [options.waitingOn.sourceId],
        confidence: options.confidence,
      },
    ],
    nextAction: "本番経路fixtureの次の対応を行う",
    relations: input.candidates.relations.map((candidate) => ({
      candidateId: candidate.id,
      verdict: options.relationVerdict,
      reasonSummary: "本番経路fixtureの関係判定です",
      sourceIds: [evidenceSource.id],
      confidence: options.confidence,
    })),
    progress: {
      latestMeaningfulSourceId: options.latestMeaningfulSourceId,
      reasonSummary: "本番経路fixtureの進捗判定です",
      confidence: options.confidence,
    },
    importance: {
      significantFeature: false,
      explicitDeadline: false,
      futureRisk: false,
      rationale: "本番経路fixtureに重要度の自然言語要因はありません",
    },
    evidence: [
      {
        sourceId: evidenceSource.id,
        supports: "status",
        summary: "本番経路fixtureの根拠です",
      },
    ],
    confidence: options.confidence,
    uncertainties: [],
    notification: options.notification,
  };
}

function createCodexOutputWithUnknownRelationSource(
  input: CodexAnalysisInput,
): SchemaValidCodexAnalysisOutput {
  const source = input.sources[0];
  if (source == null) {
    throw new TypeError("semantic再試行fixtureのsourceがありません");
  }
  const output = createCodexOutput(input, {
    status: "in_progress",
    waitingOn: {
      candidateId: requireCodexAuthorCandidateId(input),
      kind: "user",
      role: "author",
      sourceId: source.id,
    },
    latestMeaningfulSourceId: null,
    confidence: 0.95,
    relationVerdict: "related",
    notification: {
      recommended: false,
      reasonCode: "none",
      reasonSummary: "通知しません",
    },
  });
  if (output.relations.length === 0) {
    throw new TypeError("semantic再試行fixtureのinferred relationがありません");
  }
  return {
    ...output,
    relations: output.relations.map((relation) => ({
      ...relation,
      sourceIds: [buildSourceId("github_item_body", "semantic-retry-unknown-relation-source")],
    })),
  };
}

function executeSuccessfulCodexAnalysis(input: CodexAnalysisInput): Promise<unknown> {
  const source = input.sources[0];
  if (source == null) {
    throw new TypeError("Codex成功fixtureのsourceがありません");
  }
  return Promise.resolve(
    createCodexOutput(input, {
      status: "in_progress",
      waitingOn: {
        candidateId: requireCodexAuthorCandidateId(input),
        kind: "user",
        role: "assignee",
        sourceId: source.id,
      },
      latestMeaningfulSourceId: null,
      confidence: 0.95,
      relationVerdict: "related",
      notification: {
        recommended: false,
        reasonCode: "none",
        reasonSummary: "通知しません",
      },
    }),
  );
}

type CollectionHarnessApplication = ReturnType<typeof createProductionCliApplication>;
type CollectionHarnessRunResult = ReturnType<CollectionHarnessApplication["run"]>;
type CollectionHarness = Readonly<{
  artifacts: unknown[];
  reportSources: Map<string, string>;
  codexInputs: CodexAnalysisInput[];
  detailCalls: DetailCall[];
  volatileProbeCalls: VolatileProbeCall[];
  externalRelationGraphqlCalls: ExternalRelationGraphqlRequest[];
  discordCandidateNodeIds: GitHubNodeId[][];
  individualCalls: string[][];
  sleepDelays: number[];
  stateAdapter: MemoryStateBranchAdapter;
  publicData: GeneratedPublicData[];
  codexExecutionCount: () => number;
  normalDiscordCallCount: () => number;
  operationsDiscordCallCount: () => number;
  setInventory: (value: readonly Repository[]) => void;
  setConfig: (value: Config) => void;
  runDaily: (at: string) => CollectionHarnessRunResult;
  runAllOpenBackfill: (at: string, repositoryFullName: string) => CollectionHarnessRunResult;
  runDry: (at: string) => CollectionHarnessRunResult;
  readSnapshot: (at: string) => Promise<StateSnapshot>;
  runCollectAnalyze: (at: string) => CollectionHarnessRunResult;
  runCollectAnalyzeAt: (at: string, scheduledAt: string) => CollectionHarnessRunResult;
}>;

function createCollectionHarness(
  options: Readonly<{
    repositories: readonly RepositoryFixture[];
    config: Config;
    executeCodexAnalysis?: (input: CodexAnalysisInput) => Promise<unknown>;
    enumerateGitHubItemsByIdentifiers?: ProductionRuntimeAdapters["enumerateGitHubItemsByIdentifiers"];
    probeGitHubPullRequestVolatileMetadataWithRetry?: ProductionRuntimeAdapters["probeGitHubPullRequestVolatileMetadataWithRetry"];
    collectGitHubItemDetails?: ProductionRuntimeAdapters["collectGitHubItemDetails"];
    resolveGitHubRelationReference?: ProductionRuntimeAdapters["resolveGitHubRelationReference"];
    externalRelationResponse?: ExternalRelationGraphqlResponseFactory;
    sleep?: ProductionRuntimeAdapters["sleep"];
    collectionCompletedAt?: string;
    scheduledRun?: boolean;
  }>,
): CollectionHarness {
  const stateAdapter = new MemoryStateBranchAdapter();
  const artifacts: unknown[] = [];
  const reportSources = new Map<string, string>();
  const publicData: GeneratedPublicData[] = [];
  const discordCandidateNodeIds: GitHubNodeId[][] = [];
  const detailCalls: DetailCall[] = [];
  const volatileProbeCalls: VolatileProbeCall[] = [];
  const externalRelationGraphqlCalls: ExternalRelationGraphqlRequest[] = [];
  const individualCalls: string[][] = [];
  const sleepDelays: number[] = [];
  let normalDiscordCallCount = 0;
  let operationsDiscordCallCount = 0;
  let codexExecutionCount = 0;
  const codexInputs: CodexAnalysisInput[] = [];
  let currentTime = FIRST_RUN_AT;
  let inventory = options.repositories.map((fixture) => fixture.repository);
  let config = options.config;
  let resolveRelationReference: ProductionRuntimeAdapters["resolveGitHubRelationReference"];
  if (options.resolveGitHubRelationReference == null) {
    resolveRelationReference = resolveGitHubRelationReference;
  } else {
    resolveRelationReference = options.resolveGitHubRelationReference;
  }
  const fixturesByRepositoryId = new Map(
    options.repositories.map((fixture) => [fixture.repository.id, fixture]),
  );
  const runtimeAdapters: ProductionRuntimeAdapters = Object.freeze({
    environment: Object.freeze({
      GH_APP_ID: "123",
      GH_APP_PRIVATE_KEY: PRIVATE_KEY,
      GH_APP_INSTALLATION_ID: "456",
      HOME: "/tmp",
      OPENAI_API_KEY: "production-collection-openai-key",
      PATH: "/usr/bin",
      ...(options.scheduledRun === true
        ? Object.freeze({
            GITHUB_EVENT_NAME: "schedule",
            GITHUB_RUN_ATTEMPT: "1",
          })
        : Object.freeze({
            GITHUB_EVENT_NAME: "workflow_dispatch",
            GITHUB_RUN_ATTEMPT: "1",
          })),
    }),
    repositoryPath: join(import.meta.dirname, ".."),
    pagesOutputDirectory: "unused-pages",
    loadConfig: () => Promise.resolve(config),
    openCacheSession: (adapter, configuration, allowlist) =>
      CacheOnlyPersistenceSession.open(adapter, configuration, allowlist),
    discoverRepositoryInventory: () => Promise.resolve(Object.freeze([...inventory])),
    enumerateOpenGitHubItems: (input) => {
      const repository = requireSingleRepository(input.allowlist.repositories);
      const fixture = fixturesByRepositoryId.get(repository.id);
      if (fixture == null) {
        throw new TypeError(`repository fixtureがありません。対象: ${repository.id}`);
      }
      if (fixture.enumerationFailsWith503) {
        throw new GitHubRetryExhaustedError(503, 4, {
          cause: new Error("repository fixture 503"),
        });
      }
      return Promise.resolve(Object.freeze([...fixture.openItems]));
    },
    enumerateGitHubItemsByIdentifiers: (input) => {
      individualCalls.push([...input.identifiers]);
      if (options.enumerateGitHubItemsByIdentifiers != null) {
        return options.enumerateGitHubItemsByIdentifiers(input);
      }
      const items = input.identifiers.map((identifier) => {
        for (const fixture of options.repositories) {
          const item =
            fixture.individualItems.get(identifier) ??
            [...fixture.individualItems.values()].find(
              (candidate) => candidate.nodeId === identifier || candidate.url === identifier,
            );
          if (item != null && input.allowlist.has(item.repositoryId)) {
            return item;
          }
        }
        throw new TypeError(`個別項目fixtureがありません。対象: ${identifier}`);
      });
      return Promise.resolve(Object.freeze(items));
    },
    probeGitHubPullRequestVolatileMetadataWithRetry: async (input) => {
      volatileProbeCalls.push(
        Object.freeze({ pullRequestNodeIds: Object.freeze([...input.pullRequestNodeIds]) }),
      );
      if (options.probeGitHubPullRequestVolatileMetadataWithRetry != null) {
        return options.probeGitHubPullRequestVolatileMetadataWithRetry(input);
      }
      const metadata: GitHubPullRequestVolatileMetadata[] = [];
      for (const nodeId of input.pullRequestNodeIds) {
        const detail = options.repositories
          .map((fixture) => fixture.details.get(nodeId))
          .find((candidate) => candidate != null);
        if (detail?.type !== "pull_request") {
          throw new TypeError(`volatile probe用Pull Request detailがありません。対象: ${nodeId}`);
        }
        metadata.push(createGitHubPullRequestVolatileMetadataFromDetail(detail));
      }
      const collection = Object.freeze({ items: Object.freeze(metadata) });
      await input.validateDetail?.(collection);
      return collection;
    },
    collectGitHubItemDetails: (input) => {
      detailCalls.push(
        Object.freeze({
          targets: Object.freeze(
            input.targets.map((target) =>
              Object.freeze({
                nodeId: target.item.nodeId,
              }),
            ),
          ),
        }),
      );
      if (options.collectGitHubItemDetails != null) {
        return options.collectGitHubItemDetails(input);
      }
      const items = input.targets.map((target) => {
        const item = target.item;
        const fixture = fixturesByRepositoryId.get(item.repositoryId);
        const detail = fixture?.details.get(item.nodeId);
        if (detail == null) {
          throw new TypeError(`詳細fixtureがありません。対象: ${item.nodeId}`);
        }
        return detail;
      });
      if (options.collectionCompletedAt != null) {
        currentTime = options.collectionCompletedAt;
      }
      return Promise.resolve(
        Object.freeze({
          capabilities: Object.freeze({
            nativeDependencies: "available",
            nativeHierarchy: "available",
          }),
          items: Object.freeze(items),
        }),
      );
    },
    executeCodexAnalysis: (input) => {
      codexExecutionCount += 1;
      codexInputs.push(input);
      return (
        options.executeCodexAnalysis?.(input) ?? Promise.reject(new TypeError("Codex失敗fixture"))
      );
    },
    readReplayFixture: () => Promise.reject(new TypeError("replay fixtureは読みません")),
    readReplayState: () => Promise.reject(new TypeError("replay stateは読みません")),
    readGoldenFixtures: () => Promise.reject(new TypeError("golden fixtureは読みません")),
    readWorkflowArtifact: () => Promise.reject(new TypeError("workflow artifactは読みません")),
    verifyStateDirectory: () => Promise.reject(new TypeError("永続stateは検証しません")),
    resolveGitHubRelationReference: resolveRelationReference,
    createGitHubClient: () =>
      Promise.resolve(
        Object.freeze({
          installationId: 456,
          request: () => Promise.reject(new TypeError("GitHub RESTはmock adapter内だけで使います")),
          graphql: (query: string, variables: Readonly<Record<string, unknown>>) => {
            if (!query.includes("query GitHubRelationReference")) {
              return Promise.reject(new TypeError("GitHub GraphQLはmock adapter内だけで使います"));
            }
            const parsedVariables = z
              .object({
                owner: z.string(),
                name: z.string(),
                number: z.number().int(),
              })
              .parse(variables);
            const hasIssueField = query.includes("issue(number: $number)");
            const hasPullRequestField = query.includes("pullRequest(number: $number)");
            let itemType: ExternalRelationGraphqlRequest["itemType"];
            if (hasIssueField && hasPullRequestField) {
              itemType = null;
            } else if (hasIssueField) {
              itemType = "issue";
            } else if (hasPullRequestField) {
              itemType = "pull_request";
            } else {
              throw new TypeError("relation reference queryの項目種別がありません");
            }
            const request = Object.freeze({
              ...parsedVariables,
              itemType,
            });
            externalRelationGraphqlCalls.push(request);
            const responseFactory = options.externalRelationResponse;
            if (responseFactory == null) {
              throw new TypeError("external relation response fixtureがありません");
            }
            return Promise.resolve(responseFactory(request));
          },
          getRateLimitSnapshot: () =>
            Object.freeze({
              source: "rest",
              limit: 5000,
              remaining: 4000,
              resetAt: currentTime,
              observedAt: currentTime,
              resource: "core",
            }),
        }),
      ),
    createStateBranchAdapter: () => stateAdapter,
    codexProcessRunner: (request) => {
      if (request.arguments.length === 1 && request.arguments[0] === "--version") {
        return Promise.resolve({
          exitCode: 0,
          signal: null,
          timedOut: false,
        });
      }
      return Promise.reject(new TypeError("Codex subprocessは起動しません"));
    },
    discordHttpClient: Object.freeze({
      execute: () => Promise.reject(new TypeError("Discord HTTPは呼びません")),
    }),
    now: () => new Date(currentTime),
    sleep: (delayMilliseconds) => {
      sleepDelays.push(delayMilliseconds);
      assertNonNullable(options.sleep, "collection harnessのsleepがありません");
      return options.sleep(delayMilliseconds);
    },
    random: () => 0,
    writeStandardOutput: () => Promise.resolve(),
    writeJsonArtifact: (_path, value) => {
      artifacts.push(value);
      return Promise.resolve();
    },
    writeTextFile: (path, source) => {
      reportSources.set(path, source);
      return Promise.resolve();
    },
    writePublicData: (_outputDirectory, data) => {
      publicData.push(data);
      return Promise.resolve({
        summaryPath: "unused-pages/summary.json",
        detailsPath: "unused-pages/details.json",
        summaryBytes: 1,
        detailsBytes: 1,
      });
    },
    sendDiscord: (input) => {
      if (input.pagesDeployment.status === "succeeded") {
        normalDiscordCallCount += 1;
      } else {
        operationsDiscordCallCount += 1;
      }
      discordCandidateNodeIds.push(input.candidates.map((candidate) => candidate.itemNodeId));
      return Promise.resolve(
        Object.freeze({
          status: "skipped",
          reason: "no_candidates",
        } satisfies DiscordDigestDelivery),
      );
    },
  });
  const application = createProductionCliApplication(runtimeAdapters);
  const scheduledFor = (at: string): UtcIsoDateTime => {
    const startedAt = new Date(at);
    const scheduledAt = new Date(
      Date.UTC(
        startedAt.getUTCFullYear(),
        startedAt.getUTCMonth(),
        startedAt.getUTCDate(),
        23,
        0,
        0,
        0,
      ),
    );
    if (scheduledAt > startedAt) {
      scheduledAt.setUTCDate(scheduledAt.getUTCDate() - 1);
    }
    return createUtcIsoDateTime(scheduledAt.toISOString());
  };
  return {
    artifacts,
    reportSources,
    codexInputs,
    detailCalls,
    volatileProbeCalls,
    externalRelationGraphqlCalls,
    discordCandidateNodeIds,
    individualCalls,
    sleepDelays,
    stateAdapter,
    publicData,
    codexExecutionCount: () => codexExecutionCount,
    normalDiscordCallCount: () => normalDiscordCallCount,
    operationsDiscordCallCount: () => operationsDiscordCallCount,
    setInventory: (value: readonly Repository[]) => {
      inventory = [...value];
    },
    setConfig: (value: Config) => {
      config = value;
    },
    runDaily: (at: string) => {
      currentTime = at;
      return application.run([
        "daily",
        "--config",
        "unused-config.yml",
        "--report",
        "unused-report.json",
        "--scheduled-for",
        scheduledFor(at),
      ]);
    },
    runAllOpenBackfill: (at: string, repositoryFullName: string) => {
      currentTime = at;
      return application.run([
        "backfill",
        "--mode",
        "all-open",
        "--repository",
        repositoryFullName,
        "--config",
        "unused-config.yml",
        "--report",
        "unused-report.json",
        "--scheduled-for",
        scheduledFor(at),
      ]);
    },
    runDry: async (at: string) => {
      currentTime = at;
      const result = await application.run([
        "dry-run",
        "--config",
        "unused-config.yml",
        "--artifact",
        "unused-artifact.json",
        "--report",
        "unused-report.json",
        "--scheduled-for",
        scheduledFor(at),
      ]);
      if (result.exitCode !== 0) {
        artifacts.push(result);
      }
      return result;
    },
    readSnapshot: async (at: string): Promise<StateSnapshot> => {
      const result = await application.run([
        "dry-run",
        "--config",
        "unused-config.yml",
        "--artifact",
        "unused-artifact.json",
        "--report",
        "unused-report.json",
        "--scheduled-for",
        scheduledFor(at),
      ]);
      if (result.exitCode !== 0) {
        throw new TypeError("cacheからsnapshotを再構成できません");
      }
      return requireWorkflowSnapshot(artifacts);
    },
    runCollectAnalyze: (at: string) => {
      currentTime = at;
      return application.run([
        "collect-analyze",
        "--config",
        "unused-config.yml",
        "--artifact",
        "unused-artifact.json",
        "--report",
        "unused-report.json",
        "--scheduled-for",
        scheduledFor(at),
      ]);
    },
    runCollectAnalyzeAt: (at: string, scheduledAt: string) => {
      currentTime = at;
      return application.run([
        "collect-analyze",
        "--config",
        "unused-config.yml",
        "--artifact",
        "unused-artifact.json",
        "--report",
        "unused-report.json",
        "--scheduled-for",
        scheduledAt,
      ]);
    },
  };
}

function setIssueDetails(
  fixture: RepositoryFixture,
  items: readonly EnumeratedGitHubItem[],
  observedAt: UtcIsoDateTime,
): void {
  fixture.details = new Map(
    items.map((item) => [
      item.nodeId,
      createIssueDetail({
        item,
        body: "本文",
        observedAt,
        nativeDependencies: Object.freeze([]),
        duplicateComments: false,
      }),
    ]),
  );
}

async function collectRelationCandidateDiagnostics(
  endpointAvailability: "resolved" | "unavailable",
): Promise<
  Readonly<{
    diagnostics: readonly string[];
    identifierCanaries: readonly string[];
  }>
> {
  const repository = createRepository(
    "R_relation_candidate_diagnostic",
    "relation-candidate-diagnostic",
    FIRST_RUN_AT,
  );
  const publicRepository = requirePublicRepository(repository);
  const unavailableRepository = requirePublicRepository(
    createRepository(
      "R_relation_candidate_unavailable",
      "relation-repository-identifier-canary",
      FIRST_RUN_AT,
    ),
  );
  const targetRepository =
    endpointAvailability === "resolved" ? publicRepository : unavailableRepository;
  const fixture = createRepositoryFixture(repository);
  const observedAt = createUtcIsoDateTime(FIRST_RUN_AT);
  const tracked = createIssueItem({
    repository: publicRepository,
    number: 1,
    fingerprint: "relation-diagnostic-root",
    updatedAt: observedAt,
    observedAt,
    state: Object.freeze({ state: "open" }),
  });
  const target = Object.freeze({
    ...createOldIssueItem(targetRepository, 2, "relation-diagnostic-target", observedAt),
    title: "relation-title-identifier-canary",
  });
  const body = "relation-body-identifier-canary";
  fixture.openItems = [tracked];
  fixture.details.set(
    tracked.nodeId,
    createIssueDetail({
      item: tracked,
      body,
      observedAt,
      nativeDependencies: Object.freeze([createNativeBlocker(tracked, target)]),
      duplicateComments: false,
    }),
  );
  if (endpointAvailability === "resolved") {
    fixture.individualItems.set(target.nodeId, target);
    fixture.details.set(
      target.nodeId,
      createIssueDetail({
        item: target,
        body: "本文",
        observedAt,
        nativeDependencies: Object.freeze([]),
        duplicateComments: false,
      }),
    );
  }
  const config = await createTestConfig({
    explicitIncludes: [],
    retentionDays: 180,
    aiEnabled: false,
  });
  const harness = createCollectionHarness({ repositories: [fixture], config });

  const result = await harness.runDry(FIRST_RUN_AT);
  if (result.command !== "dry-run" || result.exitCode !== 0) {
    throw new TypeError("関係候補diagnostic fixtureのrunが成功しませんでした");
  }
  return Object.freeze({
    diagnostics: result.result.report.diagnostics,
    identifierCanaries: Object.freeze([
      target.nodeId,
      target.url,
      target.title,
      targetRepository.name,
      publicRepository.name,
      body,
    ]),
  });
}

describe("本番収集の接続", () => {
  it("収集中に追加されたコメントを収集完了時刻で評価する", async () => {
    const runStartedAt = "2026-08-01T09:50:26.872Z";
    const commentOccurredAt = createUtcIsoDateTime("2026-08-01T09:54:30.000Z");
    const collectionCompletedAt = "2026-08-01T09:58:30.000Z";
    const repository = createRepository(
      "R_comment_during_collection",
      "comment-during-collection",
      runStartedAt,
    );
    const fixture = createRepositoryFixture(repository);
    const item = createIssueItem({
      repository: requirePublicRepository(repository),
      number: 1,
      fingerprint: "comment-during-collection",
      updatedAt: commentOccurredAt,
      observedAt: createUtcIsoDateTime(runStartedAt),
      state: Object.freeze({ state: "open" }),
    });
    const comment = createDuplicateComments(item, commentOccurredAt)[0];
    if (comment == null) {
      throw new TypeError("収集中コメントfixtureを作成できません");
    }
    fixture.openItems = [item];
    fixture.details.set(
      item.nodeId,
      Object.freeze({
        ...createIssueDetail({
          item,
          body: "本文",
          observedAt: createUtcIsoDateTime(runStartedAt),
          nativeDependencies: Object.freeze([]),
          duplicateComments: false,
        }),
        comments: Object.freeze([comment]),
      }),
    );
    const config = await createTestConfig({
      explicitIncludes: [],
      retentionDays: 180,
      aiEnabled: false,
    });
    const harness = createCollectionHarness({
      repositories: [fixture],
      config,
      collectionCompletedAt,
    });

    const result = await harness.runCollectAnalyze(runStartedAt);
    const artifactSource = harness.artifacts.at(-1);
    if (artifactSource == null) {
      throw new TypeError("収集中コメントfixtureのworkflow artifactがありません");
    }
    if (result.command !== "collect-analyze") {
      throw new TypeError("収集中コメントfixtureがcollect-analyze結果ではありません");
    }
    const artifact = createWorkflowArtifact(artifactSource);
    const snapshot = artifact.snapshot;
    const trackedItem = snapshot.items.find((candidate) => candidate.nodeId === item.nodeId);
    const collectionItem = requireCollectionItem(snapshot, item.nodeId);

    expect(result.exitCode).toBe(0);
    expect(result.result.report.startedAt).toBe(runStartedAt);
    expect(snapshot.generatedAt).toBe(collectionCompletedAt);
    expect(snapshot.repositories[0]?.observedAt).toBe(collectionCompletedAt);
    expect(snapshot.collection.repositories[0]?.successfulAt).toBe(collectionCompletedAt);
    expect(collectionItem.observedAt).toBe(collectionCompletedAt);
    expect(trackedItem).toMatchObject({
      observedAt: collectionCompletedAt,
      lastHumanActivityAt: commentOccurredAt,
    });
    expect(Object.hasOwn(artifact, "historyInputEvents")).toBe(false);
  });

  it("Pull Request作成前のcommittedDateをincremental_collection相当の経路で処理できる", async () => {
    const repository = createRepository(
      "R_pre_creation_commit",
      "pre-creation-commit",
      FIRST_RUN_AT,
    );
    const publicRepository = requirePublicRepository(repository);
    const fixture = createRepositoryFixture(repository);
    const observedAt = createUtcIsoDateTime(FIRST_RUN_AT);
    const item = createPullRequestItem({
      repository: publicRepository,
      number: 1,
      fingerprint: "pre-creation-commit",
      updatedAt: observedAt,
      observedAt,
    });
    const detail = createFailedCheckPullRequestDetail(item, observedAt);
    fixture.openItems = [item];
    fixture.details.set(
      item.nodeId,
      Object.freeze({
        ...detail,
        headCommit: Object.freeze({
          ...detail.headCommit,
          committedAt: createUtcIsoDateTime("2026-06-30T00:00:00.000Z"),
          pushedAt: Object.freeze({
            status: "unavailable",
            reason: "github_did_not_return_pushed_at",
          }),
        }),
      }),
    );
    const config = await createTestConfig({
      explicitIncludes: [],
      retentionDays: 180,
      aiEnabled: false,
    });
    const harness = createCollectionHarness({
      repositories: [fixture],
      config,
    });

    const result = await harness.runDaily(FIRST_RUN_AT);

    expect(result.exitCode).toBe(0);
  });

  it("staleness時刻範囲違反をreducerからrun reportの固定診断へ渡す", async () => {
    const repository = createRepository(
      "R_staleness_diagnostic",
      "staleness-diagnostic",
      FIRST_RUN_AT,
    );
    const publicRepository = requirePublicRepository(repository);
    const fixture = createRepositoryFixture(repository);
    const observedAt = createUtcIsoDateTime(FIRST_RUN_AT);
    const itemCreatedAt = createUtcIsoDateTime("2026-07-31T00:00:00.000Z");
    const requestedAt = createUtcIsoDateTime("2026-07-30T00:00:00.000Z");
    const item = replaceCreatedAt(
      createPullRequestItem({
        repository: publicRepository,
        number: 1,
        fingerprint: "staleness-diagnostic",
        updatedAt: observedAt,
        observedAt,
      }),
      itemCreatedAt,
    );
    const detail = createFailedCheckPullRequestDetail(item, observedAt);
    const reviewRequestNodeId = createGitHubNodeId("RR_staleness_diagnostic");
    const reviewerNodeId = createGitHubNodeId("U_staleness_reviewer");
    const reviewRequestSourceId = buildSourceId("github_review_request", reviewRequestNodeId);
    const reviewRequestedEvent = Object.freeze({
      sourceId: buildSourceId("github_timeline_event", `${reviewRequestNodeId}:added`),
      nodeId: createGitHubNodeId(`${reviewRequestNodeId}:added`),
      sequence: 0,
      occurredAt: itemCreatedAt,
      actor: Object.freeze({ status: "unavailable", reason: "github_did_not_return_actor" }),
      kind: "review_requested",
      target: Object.freeze({
        type: "user",
        sourceId: buildSourceId("github_user", reviewerNodeId),
        nodeId: reviewerNodeId,
        login: "staleness-reviewer",
        apiType: "User",
      }),
    } satisfies GitHubTimelineEvent);
    fixture.openItems = [item];
    fixture.details.set(
      item.nodeId,
      Object.freeze({
        ...detail,
        timeline: Object.freeze([reviewRequestedEvent]),
        reviewRequests: Object.freeze({
          current: Object.freeze([
            Object.freeze({
              sourceId: reviewRequestSourceId,
              nodeId: reviewRequestNodeId,
              target: Object.freeze({
                type: "user",
                sourceId: buildSourceId("github_user", reviewerNodeId),
                nodeId: reviewerNodeId,
                login: "staleness-reviewer",
                apiType: "User",
              }),
              requestedAt: Object.freeze({ status: "available", value: requestedAt }),
            }),
          ]),
          history: Object.freeze([]),
        }),
        mergeState: Object.freeze({
          ...detail.mergeState,
          checks: Object.freeze({ status: "not_configured" }),
        }),
      }),
    );
    const config = await createTestConfig({
      explicitIncludes: [],
      retentionDays: 180,
      aiEnabled: false,
    });
    const harness = createCollectionHarness({ repositories: [fixture], config });

    const result = await harness.runDry(FIRST_RUN_AT);
    if (result.command !== "dry-run") {
      throw new TypeError("staleness診断fixtureがdry-run結果を返しませんでした");
    }

    expect(result.exitCode, JSON.stringify(result)).toBe(1);
    expect(result.result.report).toMatchObject({
      status: "failure",
      failedStage: "reducer",
      complete: false,
    });
    expect(result.result.report.diagnostics).toContainEqual(
      expect.stringContaining("errorType=StalenessReductionError<-StalenessTimestampRangeError"),
    );
    expect(result.result.report.diagnostics).toContainEqual(
      expect.stringContaining(
        `itemNodeId=${item.nodeId} basisKind=status createdAt=${itemCreatedAt} occurredAt=${requestedAt} evaluatedAt=${observedAt}`,
      ),
    );
  });

  it("作成時刻が異なるPull Requestで共有するcommit sourceの最古時刻をedgeへ使う", async () => {
    const repository = createRepository(
      "R_shared_commit_occurred_at",
      "shared-commit-occurred-at",
      FIRST_RUN_AT,
    );
    const publicRepository = requirePublicRepository(repository);
    const fixture = createRepositoryFixture(repository);
    const observedAt = createUtcIsoDateTime(FIRST_RUN_AT);
    const commitOccurredAt = createUtcIsoDateTime("2026-07-10T03:13:05.000Z");
    const earlierPullRequest = replaceCreatedAt(
      createPullRequestItem({
        repository: publicRepository,
        number: 1,
        fingerprint: "shared-commit-occurred-at-earlier",
        updatedAt: observedAt,
        observedAt,
      }),
      createUtcIsoDateTime("2026-07-05T10:13:26.000Z"),
    );
    const laterPullRequest = replaceCreatedAt(
      createPullRequestItem({
        repository: publicRepository,
        number: 2,
        fingerprint: "shared-commit-occurred-at-later",
        updatedAt: observedAt,
        observedAt,
      }),
      createUtcIsoDateTime("2026-07-10T07:03:33.000Z"),
    );
    const sharedCommitNodeId = createGitHubNodeId("C_shared_commit_occurred_at");
    const sharedSourceId = buildSourceId("github_commit", sharedCommitNodeId);
    const sharedHeadSha = "shared-commit-occurred-at-head";
    const earlierDetail = createFailedCheckPullRequestDetail(earlierPullRequest, observedAt);
    const laterDetail = createFailedCheckPullRequestDetail(laterPullRequest, observedAt);
    const sharedHeadCommit = Object.freeze({
      ...earlierDetail.headCommit,
      sourceId: sharedSourceId,
      nodeId: sharedCommitNodeId,
      sha: sharedHeadSha,
      committedAt: commitOccurredAt,
      pushedAt: Object.freeze({
        status: "unavailable",
        reason: "github_did_not_return_pushed_at",
      }),
    });
    const crossReference = createInboundCrossReference(
      earlierPullRequest,
      laterPullRequest,
      observedAt,
      false,
    );
    fixture.openItems = [earlierPullRequest, laterPullRequest];
    fixture.details.set(
      earlierPullRequest.nodeId,
      Object.freeze({
        ...earlierDetail,
        headSha: sharedHeadSha,
        headCommit: sharedHeadCommit,
        inboundCrossReferences: Object.freeze([
          Object.freeze({
            ...crossReference.candidate,
            eventSourceId: sharedSourceId,
          }),
        ]),
      }),
    );
    fixture.details.set(
      laterPullRequest.nodeId,
      Object.freeze({
        ...laterDetail,
        headSha: sharedHeadSha,
        headCommit: sharedHeadCommit,
      }),
    );
    const config = await createTestConfig({
      explicitIncludes: [],
      retentionDays: 180,
      aiEnabled: true,
    });
    const harness = createCollectionHarness({
      repositories: [fixture],
      config,
      executeCodexAnalysis: (input) => {
        const source = input.sources[0];
        if (source == null) {
          throw new TypeError("共有commit時刻fixtureのsourceがありません");
        }
        return Promise.resolve(
          createCodexOutput(input, {
            status: "in_progress",
            waitingOn: {
              candidateId: requireCodexAuthorCandidateId(input),
              kind: "user",
              role: "assignee",
              sourceId: source.id,
            },
            latestMeaningfulSourceId: null,
            confidence: 0.7,
            relationVerdict: "related",
            notification: {
              recommended: false,
              reasonCode: "none",
              reasonSummary: "通知しません",
            },
          }),
        );
      },
    });

    const result = await harness.runCollectAnalyze(FIRST_RUN_AT);
    const artifact = requireCollectAnalyzeArtifact(harness.artifacts);
    const snapshot = artifact.snapshot;
    const relation = snapshot.relations.find((candidate) =>
      candidate.evidence.some((evidence) => evidence.sourceId === sharedSourceId),
    );
    expect(result.exitCode).toBe(0);
    expect(relation).toMatchObject({
      active: true,
      firstSeenAt: commitOccurredAt,
    });
  });

  it("AI無効時の有効状態と利用可否をrun成功状態から分離して保存する", async () => {
    const repository = createRepository("R_ai_disabled", "ai-disabled", FIRST_RUN_AT);
    const fixture = createRepositoryFixture(repository);
    const observedAt = createUtcIsoDateTime(FIRST_RUN_AT);
    const item = createIssueItem({
      repository: requirePublicRepository(repository),
      number: 1,
      fingerprint: "ai-disabled-v1",
      updatedAt: observedAt,
      observedAt,
      state: Object.freeze({ state: "open" }),
    });
    fixture.openItems = [item];
    setIssueDetails(fixture, [item], observedAt);
    const config = await createTestConfig({
      explicitIncludes: [],
      retentionDays: 180,
      aiEnabled: false,
    });
    const harness = createCollectionHarness({
      repositories: [fixture],
      config,
    });

    const result = await harness.runCollectAnalyze(FIRST_RUN_AT);
    const artifact = requireCollectAnalyzeArtifact(harness.artifacts);
    const snapshot = artifact.snapshot;

    expect(result.exitCode).toBe(0);
    expect(snapshot.run.status).toBe("success");
    expect(snapshot.ai).toEqual({
      enabled: false,
      available: false,
      degraded: false,
    });
    expect(snapshot.items[0]?.aiAnalysis).toEqual({
      status: "disabled",
    });
  });

  it("確定規則だけで高信頼に判定した項目はAI分析不要として保存する", async () => {
    const repository = createRepository("R_ai_not_required", "ai-not-required", FIRST_RUN_AT);
    const fixture = createRepositoryFixture(repository);
    const observedAt = createUtcIsoDateTime(FIRST_RUN_AT);
    const item = createIssueItem({
      repository: requirePublicRepository(repository),
      number: 1,
      fingerprint: "ai-not-required-v1",
      updatedAt: observedAt,
      observedAt,
      state: Object.freeze({
        state: "closed",
        closedAt: observedAt,
      }),
    });
    fixture.individualItems.set(item.url, item);
    setIssueDetails(fixture, [item], observedAt);
    const config = await createTestConfig({
      explicitIncludes: [item.url],
      retentionDays: 180,
      aiEnabled: true,
    });
    const harness = createCollectionHarness({
      repositories: [fixture],
      config,
    });

    await harness.runDry(FIRST_RUN_AT);
    const snapshot = requireDryRunSnapshot(harness.artifacts);

    expect(harness.codexExecutionCount()).toBe(0);
    expect(snapshot.items[0]?.aiAnalysis).toEqual({
      status: "not_required",
    });
  });

  it("空本文のhuman commentだけを持つ確定項目はAI分析を省く", async () => {
    const repository = createRepository(
      "R_ai_empty_human_comment",
      "ai-empty-human-comment",
      FIRST_RUN_AT,
    );
    const fixture = createRepositoryFixture(repository);
    const observedAt = createUtcIsoDateTime(FIRST_RUN_AT);
    const item = createIssueItem({
      repository: requirePublicRepository(repository),
      number: 1,
      fingerprint: "ai-empty-human-comment-v1",
      updatedAt: observedAt,
      observedAt,
      state: Object.freeze({
        state: "closed",
        closedAt: observedAt,
      }),
    });
    const commenterNodeId = createGitHubNodeId("U_empty_commenter");
    const commentNodeId = createGitHubNodeId("IC_empty_human_comment");
    const emptyComment = Object.freeze({
      sourceId: buildSourceId("github_issue_comment", commentNodeId),
      nodeId: commentNodeId,
      sequence: 0,
      author: Object.freeze({
        status: "identified",
        account: Object.freeze({
          sourceId: buildSourceId("github_account", commenterNodeId),
          nodeId: commenterNodeId,
          login: "empty-commenter",
          apiType: "User",
        }),
      }),
      body: "",
      createdAt: observedAt,
      lastEditedAt: null,
      updatedAt: observedAt,
      url: `${item.url}#issuecomment-${commentNodeId}`,
      userContentEdits: Object.freeze({
        availability: "unavailable",
        reason: "connection_null",
      }),
    } satisfies GitHubIssueComment);
    fixture.individualItems.set(item.url, item);
    fixture.details.set(
      item.nodeId,
      Object.freeze({
        ...createIssueDetail({
          item,
          body: "本文",
          observedAt,
          nativeDependencies: Object.freeze([]),
          duplicateComments: false,
        }),
        comments: Object.freeze([emptyComment]),
      }),
    );
    const config = await createTestConfig({
      explicitIncludes: [item.url],
      retentionDays: 180,
      aiEnabled: true,
    });
    const harness = createCollectionHarness({
      repositories: [fixture],
      config,
    });

    const result = await harness.runDry(FIRST_RUN_AT);
    const snapshot = requireDryRunSnapshot(harness.artifacts);
    const trackedItem = snapshot.items.find((candidate) => candidate.nodeId === item.nodeId);

    expect(result.exitCode).toBe(0);
    expect(harness.codexExecutionCount()).toBe(0);
    expect(trackedItem?.aiAnalysis).toEqual({
      status: "not_required",
    });
  });

  it("担当外のinferred関係候補はAI分析要否に影響せず担当するinferred候補はAI分析する", async () => {
    const repository = createRepository(
      "R_ai_relation_assessment_owner",
      "ai-relation-assessment-owner",
      FIRST_RUN_AT,
    );
    const publicRepository = requirePublicRepository(repository);
    const fixture = createRepositoryFixture(repository);
    const observedAt = createUtcIsoDateTime(FIRST_RUN_AT);
    const referencing = createIssueItem({
      repository: publicRepository,
      number: 1,
      fingerprint: "ai-relation-referencing",
      updatedAt: observedAt,
      observedAt,
      state: Object.freeze({
        state: "closed",
        closedAt: observedAt,
      }),
    });
    const referenced = createIssueItem({
      repository: publicRepository,
      number: 2,
      fingerprint: "ai-relation-referenced",
      updatedAt: observedAt,
      observedAt,
      state: Object.freeze({
        state: "closed",
        closedAt: observedAt,
      }),
    });
    const blocker = createIssueItem({
      repository: publicRepository,
      number: 3,
      fingerprint: "ai-relation-authoritative-blocker",
      updatedAt: observedAt,
      observedAt,
      state: Object.freeze({
        state: "closed",
        closedAt: observedAt,
      }),
    });
    for (const item of [referencing, referenced, blocker]) {
      fixture.individualItems.set(item.url, item);
    }
    fixture.details.set(
      referencing.nodeId,
      createIssueDetail({
        item: referencing,
        body: `${referenced.url} を参照します`,
        observedAt,
        nativeDependencies: Object.freeze([]),
        duplicateComments: false,
      }),
    );
    fixture.details.set(
      referenced.nodeId,
      createIssueDetail({
        item: referenced,
        body: "担当する関係候補はauthoritativeです",
        observedAt,
        nativeDependencies: Object.freeze([createNativeBlocker(referenced, blocker)]),
        duplicateComments: false,
      }),
    );
    fixture.details.set(
      blocker.nodeId,
      createIssueDetail({
        item: blocker,
        body: "authoritative関係候補のblockerです",
        observedAt,
        nativeDependencies: Object.freeze([]),
        duplicateComments: false,
      }),
    );
    const config = await createTestConfig({
      explicitIncludes: [referencing.url, referenced.url, blocker.url],
      retentionDays: 180,
      aiEnabled: true,
    });
    const harness = createCollectionHarness({
      repositories: [fixture],
      config,
      executeCodexAnalysis: (input) => {
        const source = input.sources[0];
        if (source == null) {
          throw new TypeError("relation担当fixtureのsourceがありません");
        }
        return Promise.resolve(
          createCodexOutput(input, {
            status: "in_progress",
            waitingOn: {
              candidateId: requireCodexAuthorCandidateId(input),
              kind: "user",
              role: "author",
              sourceId: source.id,
            },
            latestMeaningfulSourceId: null,
            confidence: 0.95,
            relationVerdict: "related",
            notification: {
              recommended: false,
              reasonCode: "none",
              reasonSummary: "通知しません",
            },
          }),
        );
      },
    });

    const result = await harness.runDry(FIRST_RUN_AT);
    const snapshot = requireDryRunSnapshot(harness.artifacts);
    const referencedTrackedItem = snapshot.items.find(
      (candidate) => candidate.nodeId === referenced.nodeId,
    );

    expect(result.exitCode).toBe(0);
    expect(harness.codexInputs.map((input) => input.item.nodeId)).toEqual([referencing.nodeId]);
    expect(harness.codexInputs[0]?.candidates.relations).toHaveLength(1);
    expect(referencedTrackedItem?.aiAnalysis).toEqual({
      status: "not_required",
    });
  });

  it("inferred relationの未知source IDを1回再試行してartifactとcacheを作成する", async () => {
    const observedAt = createUtcIsoDateTime(FIRST_RUN_AT);
    const relationFixture = createInferredRelationFixture(observedAt);
    const config = await createTestConfig({
      explicitIncludes: relationFixture.items.map((item) => item.url),
      retentionDays: 180,
      aiEnabled: true,
    });
    let executionCount = 0;
    const harness = createCollectionHarness({
      repositories: [relationFixture.fixture],
      config,
      executeCodexAnalysis: (input) => {
        executionCount += 1;
        if (executionCount === 1) {
          return Promise.resolve(createCodexOutputWithUnknownRelationSource(input));
        }
        return executeSuccessfulCodexAnalysis(input);
      },
    });

    const result = await harness.runCollectAnalyze(FIRST_RUN_AT);
    if (result.command !== "collect-analyze") {
      throw new TypeError("semantic再試行fixtureがcollect-analyze結果ではありません");
    }
    const artifact = requireCollectAnalyzeArtifact(harness.artifacts);
    const trackedItem = artifact.snapshot.items.find(
      (item) => item.nodeId === relationFixture.referencing.nodeId,
    );

    expect(result.exitCode).toBe(0);
    expect(harness.codexExecutionCount()).toBe(2);
    expect(trackedItem?.aiAnalysis).toMatchObject({ status: "used" });
    expect(artifact.cacheOnlyPayload.aiCacheEntries).toHaveLength(1);
    expect(artifact.cacheOnlyPayload.aiCacheEntries[0]?.nodeId).toBe(
      relationFixture.referencing.nodeId,
    );
  });

  it("inferred relationの未知source IDが再試行後も不正ならcompletenessで公開副作用を止める", async () => {
    const observedAt = createUtcIsoDateTime(FIRST_RUN_AT);
    const relationFixture = createInferredRelationFixture(observedAt);
    const config = await createTestConfig({
      explicitIncludes: relationFixture.items.map((item) => item.url),
      retentionDays: 180,
      aiEnabled: true,
    });
    const harness = createCollectionHarness({
      repositories: [relationFixture.fixture],
      config,
      executeCodexAnalysis: (input) =>
        Promise.resolve(createCodexOutputWithUnknownRelationSource(input)),
    });

    const result = await harness.runCollectAnalyze(FIRST_RUN_AT);
    if (result.command !== "collect-analyze") {
      throw new TypeError("semantic停止fixtureがcollect-analyze結果ではありません");
    }

    expect(result.exitCode).toBe(1);
    expect(result.result.report).toMatchObject({
      status: "failure",
      failedStage: "completeness_validation",
      complete: false,
    });
    expect(harness.codexExecutionCount()).toBe(2);
    expect(harness.artifacts).toEqual([]);
    expect(harness.publicData).toEqual([]);
    expect(harness.normalDiscordCallCount()).toBe(0);
    expect(result.result.effects).toEqual({
      cacheCommitted: false,
      pagesBuilt: false,
      discordAttempted: false,
      artifactWritten: false,
    });
    expect(await harness.stateAdapter.resolveHead("tracker-state-v3")).toEqual({
      status: "missing",
    });
  });

  it("AI対象がない正常runを利用可能として保存する", async () => {
    const repository = createRepository("R_ai_no_targets", "ai-no-targets", FIRST_RUN_AT);
    const fixture = createRepositoryFixture(repository);
    const config = await createTestConfig({
      explicitIncludes: [],
      retentionDays: 180,
      aiEnabled: true,
    });
    const harness = createCollectionHarness({
      repositories: [fixture],
      config,
    });

    const result = await harness.runDry(FIRST_RUN_AT);
    const snapshot = requireDryRunSnapshot(harness.artifacts);

    expect(result.exitCode).toBe(0);
    expect(harness.codexExecutionCount()).toBe(0);
    expect(snapshot.run.status).toBe("success");
    expect(snapshot.ai).toEqual({
      enabled: true,
      available: true,
      degraded: false,
    });
  });

  it("一部のAI分析が失敗しても成功結果があれば利用可能として保存する", async () => {
    const repository = createRepository("R_ai_partial_failure", "ai-partial-failure", FIRST_RUN_AT);
    const publicRepository = requirePublicRepository(repository);
    const fixture = createRepositoryFixture(repository);
    const observedAt = createUtcIsoDateTime(FIRST_RUN_AT);
    const succeededItem = createIssueItem({
      repository: publicRepository,
      number: 1,
      fingerprint: "ai-partial-success",
      updatedAt: observedAt,
      observedAt,
      state: Object.freeze({ state: "open" }),
    });
    const failedItem = createIssueItem({
      repository: publicRepository,
      number: 2,
      fingerprint: "ai-partial-failure",
      updatedAt: observedAt,
      observedAt,
      state: Object.freeze({ state: "open" }),
    });
    fixture.openItems = [succeededItem, failedItem];
    for (const item of fixture.openItems) {
      fixture.details.set(
        item.nodeId,
        createIssueDetail({
          item,
          body: "AI部分失敗を検証します",
          observedAt,
          nativeDependencies: Object.freeze([]),
          duplicateComments: false,
        }),
      );
    }
    const config = await createTestConfig({
      explicitIncludes: [],
      retentionDays: 180,
      aiEnabled: true,
    });
    const harness = createCollectionHarness({
      repositories: [fixture],
      config,
      executeCodexAnalysis: (input) => {
        const source = input.sources[0];
        if (source == null) {
          throw new TypeError("AI部分失敗fixtureのsourceがありません");
        }
        const output = createCodexOutput(input, {
          status: "in_progress",
          waitingOn: {
            candidateId: requireCodexAuthorCandidateId(input),
            kind: "user",
            role: "assignee",
            sourceId: source.id,
          },
          latestMeaningfulSourceId: null,
          confidence: 0.95,
          relationVerdict: "related",
          notification: {
            recommended: false,
            reasonCode: "none",
            reasonSummary: "通知しません",
          },
        });
        if (input.item.nodeId === succeededItem.nodeId) {
          return Promise.resolve(output);
        }
        return Promise.resolve({
          ...output,
          item: {
            ...output.item,
            nodeId: "I_other",
          },
        });
      },
    });

    const result = await harness.runDry(FIRST_RUN_AT);
    if (result.exitCode !== 0) {
      throw new TypeError(JSON.stringify(result));
    }
    const snapshot = requireDryRunSnapshot(harness.artifacts);

    expect(result.exitCode).toBe(0);
    expect(harness.codexExecutionCount()).toBe(3);
    expect(snapshot.run.status).toBe("fallback");
    expect(snapshot.ai).toEqual({
      enabled: true,
      available: true,
      degraded: true,
    });
    expect(
      snapshot.items.find((candidate) => candidate.nodeId === succeededItem.nodeId)?.aiAnalysis,
    ).toMatchObject({
      status: "used",
    });
    expect(
      snapshot.items.find((candidate) => candidate.nodeId === failedItem.nodeId)?.aiAnalysis,
    ).toEqual({
      status: "failed",
    });
  });

  it("milestoneを期限と信頼できないタイトルを含めてsnapshotと公開summaryへ渡す", async () => {
    const repository = createRepository("R_milestone", "milestone", FIRST_RUN_AT);
    const fixture = createRepositoryFixture(repository);
    const observedAt = createUtcIsoDateTime(FIRST_RUN_AT);
    const baseItem = createIssueItem({
      repository: requirePublicRepository(repository),
      number: 1,
      fingerprint: "milestone-v1",
      updatedAt: observedAt,
      observedAt,
      state: Object.freeze({ state: "open" }),
    });
    const itemMilestone = Object.freeze({
      nodeId: createGitHubNodeId("M_milestone_v1"),
      number: 1,
      title: "<script>サンプルリリース</script>",
      state: "open",
      dueOn: createUtcIsoDateTime("2026-09-01T00:00:00Z"),
    } satisfies GitHubItemMilestone);
    const item = Object.freeze({
      ...baseItem,
      milestone: itemMilestone,
    });
    fixture.openItems = [item];
    setIssueDetails(fixture, [item], observedAt);
    const config = await createTestConfig({
      explicitIncludes: [],
      retentionDays: 180,
      aiEnabled: true,
    });
    const harness = createCollectionHarness({
      repositories: [fixture],
      config,
      executeCodexAnalysis: executeSuccessfulCodexAnalysis,
    });

    const result = await harness.runCollectAnalyze(FIRST_RUN_AT);
    const snapshot = requireCollectAnalyzeArtifact(harness.artifacts).snapshot;
    const expectedMilestone = {
      nodeId: "M_milestone_v1",
      number: 1,
      title: "<script>サンプルリリース</script>",
      state: "open",
      dueOn: "2026-09-01T00:00:00.000Z",
    };
    const expectedImportance = {
      score: 10,
      level: "low",
      factors: [
        {
          kind: "milestoneDeadline",
          points: 10,
          detail: "期限付きのopen milestoneで10点です",
        },
      ],
    };
    const publicData = requireCollectAnalyzeArtifact(harness.artifacts).pages;

    expect(result.exitCode).toBe(0);
    expect(snapshot.schemaVersion).toBe("8");
    expect(snapshot.items[0]?.milestone).toEqual(expectedMilestone);
    expect(snapshot.items[0]?.importance).toEqual(expectedImportance);
    expect(snapshot.items[0]?.attention).toEqual({
      score: 4,
      level: "low",
    });
    expect(publicData.summary.schemaVersion).toBe("5");
    expect(publicData.summary.items[0]?.milestone).toEqual(expectedMilestone);
    expect(publicData.summary.items[0]?.importance).toEqual({
      score: 10,
      level: "low",
    });
    expect(publicData.summary.items[0]?.attention).toEqual({
      score: 4,
      level: "low",
    });
    expect(publicData.details.schemaVersion).toBe("5");
    expect(publicData.details.items[0]?.summary.milestone).toEqual(expectedMilestone);
    expect(publicData.details.items[0]?.importanceFactors).toEqual(expectedImportance.factors);
  });

  it.each([
    {
      name: "高信頼のCodex判定なら自然言語の3要因を加点する",
      aiEnabled: true,
      confidence: 0.95,
      expectedScore: 75,
      expectedFactorKinds: [
        "priorityLabel",
        "significantFeature",
        "explicitDeadline",
        "futureRisk",
      ],
      expectedCodexExecutionCount: 1,
    },
    {
      name: "低信頼のCodex判定なら自然言語の3要因を加点しない",
      aiEnabled: true,
      confidence: 0.64,
      expectedScore: 25,
      expectedFactorKinds: ["priorityLabel"],
      expectedCodexExecutionCount: 1,
    },
    {
      name: "Codex判定がなければ決定論的要因だけを加点する",
      aiEnabled: false,
      confidence: 0.95,
      expectedScore: 25,
      expectedFactorKinds: ["priorityLabel"],
      expectedCodexExecutionCount: 0,
    },
  ])("$name", async (fixtureOptions) => {
    const repository = createRepository(
      `R_importance_${fixtureOptions.expectedCodexExecutionCount.toString()}_${fixtureOptions.confidence.toString()}`,
      `importance-${fixtureOptions.expectedCodexExecutionCount.toString()}-${fixtureOptions.confidence.toString().replace(".", "-")}`,
      FIRST_RUN_AT,
    );
    const fixture = createRepositoryFixture(repository);
    const observedAt = createUtcIsoDateTime(FIRST_RUN_AT);
    const baseItem = createIssueItem({
      repository: requirePublicRepository(repository),
      number: 1,
      fingerprint: `importance-${fixtureOptions.name}`,
      updatedAt: observedAt,
      observedAt,
      state: Object.freeze({ state: "open" }),
    });
    const item = Object.freeze({
      ...baseItem,
      labels: Object.freeze(["優先度：高"]),
    });
    fixture.openItems = [item];
    fixture.details.set(
      item.nodeId,
      createIssueDetail({
        item,
        body: "主要機能を期限までに変更し、将来の互換性問題を避ける",
        observedAt,
        nativeDependencies: Object.freeze([]),
        duplicateComments: false,
      }),
    );
    const config = await createTestConfig({
      explicitIncludes: [],
      retentionDays: 180,
      aiEnabled: fixtureOptions.aiEnabled,
    });
    const harness = createCollectionHarness({
      repositories: [fixture],
      config,
      executeCodexAnalysis: (input) => {
        const source = input.sources[0];
        if (source == null) {
          throw new TypeError("重要度fixtureのsourceがありません");
        }
        return Promise.resolve({
          ...createCodexOutput(input, {
            status: "in_progress",
            waitingOn: {
              candidateId: requireCodexAuthorCandidateId(input),
              kind: "user",
              role: "assignee",
              sourceId: source.id,
            },
            latestMeaningfulSourceId: null,
            confidence: fixtureOptions.confidence,
            relationVerdict: "related",
            notification: {
              recommended: false,
              reasonCode: "none",
              reasonSummary: "通知しません",
            },
          }),
          importance: {
            significantFeature: true,
            explicitDeadline: true,
            futureRisk: true,
            rationale: "主要機能に期限と将来の互換性リスクがあります",
          },
        });
      },
    });

    expect((await harness.runCollectAnalyze(FIRST_RUN_AT)).exitCode).toBe(0);
    const snapshot = requireCollectAnalyzeArtifact(harness.artifacts).snapshot;
    const importance = snapshot.items[0]?.importance;

    expect(harness.codexExecutionCount()).toBe(fixtureOptions.expectedCodexExecutionCount);
    expect(importance?.score).toBe(fixtureOptions.expectedScore);
    expect(importance?.factors.map((factor) => factor.kind)).toEqual(
      fixtureOptions.expectedFactorKinds,
    );
  });

  it.each([
    { status: "failed", maxCallsPerRun: 1, secondExecutionFails: true },
    { status: "deferred", maxCallsPerRun: 0, secondExecutionFails: false },
  ] satisfies readonly {
    status: "failed" | "deferred";
    maxCallsPerRun: number;
    secondExecutionFails: boolean;
  }[])("AI $status時はlatest importanceだけを代替する", async (fixtureOptions) => {
    const repository = createRepository(
      `R_latest_importance_${fixtureOptions.status}`,
      `latest-importance-${fixtureOptions.status}`,
      FIRST_RUN_AT,
    );
    const publicRepository = requirePublicRepository(repository);
    const fixture = createRepositoryFixture(repository);
    const firstObservedAt = createUtcIsoDateTime(FIRST_RUN_AT);
    const firstFingerprint = `latest-importance-${fixtureOptions.status}-v1`;
    const firstItem = createIssueItem({
      repository: publicRepository,
      number: 1,
      fingerprint: firstFingerprint,
      updatedAt: firstObservedAt,
      observedAt: firstObservedAt,
      state: Object.freeze({ state: "open" }),
    });
    fixture.openItems = [firstItem];
    fixture.details.set(
      firstItem.nodeId,
      createIssueDetail({
        item: firstItem,
        body: "@requested-user へ重要機能の期限対応を依頼します",
        observedAt: firstObservedAt,
        nativeDependencies: Object.freeze([]),
        duplicateComments: false,
      }),
    );
    const baseConfig = await createTestConfig({
      explicitIncludes: [],
      retentionDays: 180,
      aiEnabled: true,
    });
    let executionFails = false;
    const harness = createCollectionHarness({
      repositories: [fixture],
      config: baseConfig,
      executeCodexAnalysis: (input) => {
        if (executionFails) {
          return Promise.reject(new TypeError("latest importance fallback fixture"));
        }
        const source = input.sources[0];
        if (source == null) {
          throw new TypeError("latest importance fixtureのsourceがありません");
        }
        return Promise.resolve({
          ...createCodexOutput(input, {
            status: "in_progress",
            waitingOn: {
              candidateId: requireCodexAuthorCandidateId(input),
              kind: "user",
              role: "assignee",
              sourceId: source.id,
            },
            latestMeaningfulSourceId: null,
            confidence: 0.95,
            relationVerdict: "related",
            notification: {
              recommended: false,
              reasonCode: "none",
              reasonSummary: "通知しません",
            },
          }),
          importance: {
            significantFeature: true,
            explicitDeadline: true,
            futureRisk: true,
            rationale: "直近の検証済み重要度です",
          },
        });
      },
    });

    const firstResult = await harness.runCollectAnalyze(FIRST_RUN_AT);
    expect(harness.codexExecutionCount()).toBe(1);
    const firstArtifact = requireCollectAnalyzeArtifact(harness.artifacts);
    if (firstResult.exitCode !== 0) {
      throw new TypeError(
        `初回latest importance生成に失敗しました。${JSON.stringify(firstResult)}`,
      );
    }
    expect(firstArtifact.snapshot.items[0]?.aiAnalysis).toMatchObject({ status: "used" });
    expect(
      firstArtifact.snapshot.items[0]?.importance.factors.map((factor) => factor.kind),
    ).toEqual(["significantFeature", "explicitDeadline", "futureRisk"]);
    expect(firstArtifact.cacheOnlyPayload.latestImportanceCaches).toHaveLength(1);
    expect(firstArtifact.cacheOnlyPayload.aiCacheEntries).toHaveLength(1);
    const firstSession = await CacheOnlyPersistenceSession.open(
      harness.stateAdapter,
      baseConfig.state,
      createPublicRepositoryAllowlist([repository]),
    );
    await firstSession.persist({
      evaluatedAt: firstObservedAt,
      ...firstArtifact.cacheOnlyPayload,
      knownSecrets: [],
    });

    const secondObservedAt = createUtcIsoDateTime(SECOND_RUN_AT);
    const secondFingerprint = `latest-importance-${fixtureOptions.status}-v2`;
    const secondItem = createIssueItem({
      repository: publicRepository,
      number: 1,
      fingerprint: secondFingerprint,
      updatedAt: secondObservedAt,
      observedAt: secondObservedAt,
      state: Object.freeze({ state: "open" }),
    });
    fixture.openItems = [secondItem];
    fixture.details.set(
      secondItem.nodeId,
      createIssueDetail({
        item: secondItem,
        body: "@requested-user へ変更後の対応を依頼します",
        observedAt: secondObservedAt,
        nativeDependencies: Object.freeze([]),
        duplicateComments: false,
      }),
    );
    executionFails = fixtureOptions.secondExecutionFails;
    harness.setConfig(configWithBudget(baseConfig, fixtureOptions.maxCallsPerRun, 10));
    harness.artifacts.length = 0;

    const result = await harness.runCollectAnalyze(SECOND_RUN_AT);
    if (result.exitCode !== 0) {
      throw new TypeError(`latest importance fallbackに失敗しました。${JSON.stringify(result)}`);
    }
    const artifact = requireCollectAnalyzeArtifact(harness.artifacts);
    const tracked = artifact.snapshot.items[0];

    expect(result.exitCode).toBe(0);
    expect(tracked?.aiAnalysis).toEqual({ status: fixtureOptions.status });
    expect(tracked?.importance.factors.map((factor) => factor.kind)).toEqual([
      "significantFeature",
      "explicitDeadline",
      "futureRisk",
    ]);
    expect(tracked?.status).not.toBe("in_progress");
    expect(
      artifact.notificationSelection.candidates.some(
        (candidate) => candidate.itemNodeId === secondItem.nodeId,
      ),
    ).toBe(false);
    expect(artifact.cacheOnlyPayload.latestImportanceCaches).toEqual(
      firstArtifact.cacheOnlyPayload.latestImportanceCaches,
    );
  });

  it.each([
    { kind: "version", firstConfidence: 0.95 },
    { kind: "confidence", firstConfidence: 0.7 },
  ] satisfies readonly {
    kind: "version" | "confidence";
    firstConfidence: number;
  }[])("$kind変更後は互換性のないlatest importanceを代替利用しない", async (options) => {
    const repository = createRepository(
      `R_latest_incompatible_${options.kind}`,
      `latest-incompatible-${options.kind}`,
      FIRST_RUN_AT,
    );
    const publicRepository = requirePublicRepository(repository);
    const fixture = createRepositoryFixture(repository);
    const firstObservedAt = createUtcIsoDateTime(FIRST_RUN_AT);
    const firstItem = createIssueItem({
      repository: publicRepository,
      number: 1,
      fingerprint: `latest-incompatible-${options.kind}-v1`,
      updatedAt: firstObservedAt,
      observedAt: firstObservedAt,
      state: Object.freeze({ state: "open" }),
    });
    fixture.openItems = [firstItem];
    fixture.details.set(
      firstItem.nodeId,
      createIssueDetail({
        item: firstItem,
        body: "@requested-user に対応を依頼します",
        observedAt: firstObservedAt,
        nativeDependencies: Object.freeze([]),
        duplicateComments: false,
      }),
    );
    const config = await createTestConfig({
      explicitIncludes: [],
      retentionDays: 180,
      aiEnabled: true,
    });
    let executionFails = false;
    const harness = createCollectionHarness({
      repositories: [fixture],
      config,
      executeCodexAnalysis: (input) => {
        if (executionFails) {
          return Promise.reject(new TypeError("非互換latest importance fixture"));
        }
        const source = input.sources[0];
        if (source == null) {
          throw new TypeError("非互換latest importance fixtureのsourceがありません");
        }
        return Promise.resolve({
          ...createCodexOutput(input, {
            status: "in_progress",
            waitingOn: {
              candidateId: requireCodexAuthorCandidateId(input),
              kind: "user",
              role: "assignee",
              sourceId: source.id,
            },
            latestMeaningfulSourceId: null,
            confidence: options.firstConfidence,
            relationVerdict: "related",
            notification: {
              recommended: false,
              reasonCode: "none",
              reasonSummary: "通知しません",
            },
          }),
          importance: {
            significantFeature: true,
            explicitDeadline: true,
            futureRisk: true,
            rationale: "変更前の重要度です",
          },
        });
      },
    });

    expect((await harness.runDaily(FIRST_RUN_AT)).exitCode).toBe(0);
    const secondObservedAt = createUtcIsoDateTime(SECOND_RUN_AT);
    const secondItem = createIssueItem({
      repository: publicRepository,
      number: 1,
      fingerprint: `latest-incompatible-${options.kind}-v2`,
      updatedAt: secondObservedAt,
      observedAt: secondObservedAt,
      state: Object.freeze({ state: "open" }),
    });
    fixture.openItems = [secondItem];
    fixture.details.set(
      secondItem.nodeId,
      createIssueDetail({
        item: secondItem,
        body: "@requested-user に変更後の対応を依頼します",
        observedAt: secondObservedAt,
        nativeDependencies: Object.freeze([]),
        duplicateComments: false,
      }),
    );
    const nextConfig =
      options.kind === "version"
        ? Object.freeze({
            ...config,
            ai: Object.freeze({ ...config.ai, promptVersion: `${config.ai.promptVersion}-v2` }),
          })
        : Object.freeze({
            ...config,
            ai: Object.freeze({
              ...config.ai,
              confidence: Object.freeze({ high: 0.8, medium: 0.8 }),
            }),
          });
    harness.setConfig(nextConfig);
    executionFails = true;
    harness.artifacts.length = 0;

    const result = await harness.runCollectAnalyze(SECOND_RUN_AT);
    const artifact = requireCollectAnalyzeArtifact(harness.artifacts);
    if (result.command !== "collect-analyze") {
      throw new TypeError("非互換latest importance fixtureのcommandが不正です");
    }

    expect(result.exitCode).toBe(0);
    expect(artifact.snapshot.items[0]?.importance.factors).toEqual([]);
    expect(artifact.cacheOnlyPayload.latestImportanceCaches).toEqual([]);
    expect(result.result.report.diagnostics).toContainEqual(
      expect.stringMatching(/node ID: .*cache key:/u),
    );
  });

  it("AI失敗時にlatest importanceがなければ決定論的重要度だけを使う", async () => {
    const repository = createRepository(
      "R_latest_importance_missing",
      "latest-importance-missing",
      FIRST_RUN_AT,
    );
    const fixture = createRepositoryFixture(repository);
    const observedAt = createUtcIsoDateTime(FIRST_RUN_AT);
    const baseItem = createIssueItem({
      repository: requirePublicRepository(repository),
      number: 1,
      fingerprint: "latest-importance-missing",
      updatedAt: observedAt,
      observedAt,
      state: Object.freeze({ state: "open" }),
    });
    const item = Object.freeze({ ...baseItem, labels: Object.freeze(["優先度：高"]) });
    fixture.openItems = [item];
    fixture.details.set(
      item.nodeId,
      createIssueDetail({
        item,
        body: "@requested-user へ自然言語判定が必要な対応を依頼します",
        observedAt,
        nativeDependencies: Object.freeze([]),
        duplicateComments: false,
      }),
    );
    const config = await createTestConfig({
      explicitIncludes: [],
      retentionDays: 180,
      aiEnabled: true,
    });
    const harness = createCollectionHarness({
      repositories: [fixture],
      config,
      executeCodexAnalysis: () => Promise.reject(new TypeError("AI失敗fixture")),
    });

    const result = await harness.runCollectAnalyze(FIRST_RUN_AT);
    if (result.exitCode !== 0) {
      throw new TypeError(`latestなしのAI失敗runに失敗しました。${JSON.stringify(result)}`);
    }
    const artifact = requireCollectAnalyzeArtifact(harness.artifacts);

    expect(artifact.snapshot.items[0]?.aiAnalysis).toEqual({ status: "failed" });
    expect(artifact.snapshot.items[0]?.importance.factors.map((factor) => factor.kind)).toEqual([
      "priorityLabel",
    ]);
    expect(artifact.cacheOnlyPayload.latestImportanceCaches).toEqual([]);
    expect(artifact.cacheOnlyPayload.aiCacheEntries).toEqual([]);
  });

  it("新しいcurrent成功でlatest importanceを更新して過去AI resultも保持する", async () => {
    const repository = createRepository(
      "R_latest_importance_update",
      "latest-importance-update",
      FIRST_RUN_AT,
    );
    const publicRepository = requirePublicRepository(repository);
    const fixture = createRepositoryFixture(repository);
    const firstObservedAt = createUtcIsoDateTime(FIRST_RUN_AT);
    const firstItem = createIssueItem({
      repository: publicRepository,
      number: 1,
      fingerprint: "latest-importance-update-v1",
      updatedAt: firstObservedAt,
      observedAt: firstObservedAt,
      state: Object.freeze({ state: "open" }),
    });
    fixture.openItems = [firstItem];
    fixture.details.set(
      firstItem.nodeId,
      createIssueDetail({
        item: firstItem,
        body: "@requested-user へ初回対応を依頼します",
        observedAt: firstObservedAt,
        nativeDependencies: Object.freeze([]),
        duplicateComments: false,
      }),
    );
    const config = await createTestConfig({
      explicitIncludes: [],
      retentionDays: 180,
      aiEnabled: true,
    });
    let executionFails = false;
    const harness = createCollectionHarness({
      repositories: [fixture],
      config,
      executeCodexAnalysis: (input) =>
        executionFails
          ? Promise.reject(new TypeError("stale latest index fixture"))
          : executeSuccessfulCodexAnalysis(input),
    });

    expect((await harness.runCollectAnalyze(FIRST_RUN_AT)).exitCode).toBe(0);
    const firstArtifact = requireCollectAnalyzeArtifact(harness.artifacts);
    const firstLatest = firstArtifact.cacheOnlyPayload.latestImportanceCaches[0];
    if (firstLatest == null) {
      throw new TypeError("初回latest importanceがありません");
    }
    const session = await CacheOnlyPersistenceSession.open(
      harness.stateAdapter,
      config.state,
      createPublicRepositoryAllowlist([repository]),
    );
    await session.persist({
      evaluatedAt: firstObservedAt,
      ...firstArtifact.cacheOnlyPayload,
      knownSecrets: [],
    });

    const secondObservedAt = createUtcIsoDateTime(SECOND_RUN_AT);
    const secondItem = createIssueItem({
      repository: publicRepository,
      number: 1,
      fingerprint: "latest-importance-update-v2",
      updatedAt: secondObservedAt,
      observedAt: secondObservedAt,
      state: Object.freeze({ state: "open" }),
    });
    fixture.openItems = [secondItem];
    fixture.details.set(
      secondItem.nodeId,
      createIssueDetail({
        item: secondItem,
        body: "@requested-user へ更新後の対応を依頼します",
        observedAt: secondObservedAt,
        nativeDependencies: Object.freeze([]),
        duplicateComments: false,
      }),
    );
    harness.artifacts.length = 0;

    expect((await harness.runCollectAnalyze(SECOND_RUN_AT)).exitCode).toBe(0);
    const secondArtifact = requireCollectAnalyzeArtifact(harness.artifacts);
    const secondLatest = secondArtifact.cacheOnlyPayload.latestImportanceCaches[0];
    if (secondLatest == null) {
      throw new TypeError("更新後latest importanceがありません");
    }

    expect(secondLatest.metadata.executedAt).toBe(SECOND_RUN_AT);
    expect(secondLatest.aiCacheReference.cacheKey).not.toBe(firstLatest.aiCacheReference.cacheKey);
    expect(secondArtifact.cacheOnlyPayload.aiCacheEntries).toHaveLength(2);

    const secondSession = await CacheOnlyPersistenceSession.open(
      harness.stateAdapter,
      config.state,
      createPublicRepositoryAllowlist([repository]),
    );
    await secondSession.persist({
      evaluatedAt: secondObservedAt,
      ...secondArtifact.cacheOnlyPayload,
      knownSecrets: [],
    });
    const head = await harness.stateAdapter.resolveHead("tracker-state-v3");
    if (head.status !== "present") {
      throw new TypeError("stale latest index fixtureのstate branchがありません");
    }
    const files = await harness.stateAdapter.readBranchFiles("tracker-state-v3");
    const latestPath = [...files.keys()].find((path) =>
      path.startsWith("state/ai-latest-importance/"),
    );
    if (latestPath == null) {
      throw new TypeError("stale latest index fixtureのlatest文書がありません");
    }
    await harness.stateAdapter.commit({
      branch: "tracker-state-v3",
      expectedHead: head,
      updates: [
        {
          path: latestPath,
          bytes: new TextEncoder().encode(`${serializeCanonicalJson(firstLatest)}\n`),
        },
      ],
      deletions: [],
      message: "stale latest index fixture",
      committedAt: SECOND_RUN_AT,
    });
    const thirdObservedAt = createUtcIsoDateTime(THIRD_RUN_AT);
    const thirdItem = createIssueItem({
      repository: publicRepository,
      number: 1,
      fingerprint: "latest-importance-update-v3",
      updatedAt: thirdObservedAt,
      observedAt: thirdObservedAt,
      state: Object.freeze({ state: "open" }),
    });
    fixture.openItems = [thirdItem];
    fixture.details.set(
      thirdItem.nodeId,
      createIssueDetail({
        item: thirdItem,
        body: "@requested-user へ再更新後の対応を依頼します",
        observedAt: thirdObservedAt,
        nativeDependencies: Object.freeze([]),
        duplicateComments: false,
      }),
    );
    executionFails = true;
    harness.artifacts.length = 0;

    expect((await harness.runCollectAnalyze(THIRD_RUN_AT)).exitCode).toBe(0);
    const repairedLatest = requireCollectAnalyzeArtifact(harness.artifacts).cacheOnlyPayload
      .latestImportanceCaches[0];

    expect(repairedLatest?.aiCacheReference.cacheKey).toBe(secondLatest.aiCacheReference.cacheKey);
  });

  it("latest importance index欠落時にAI resultから再構築する", async () => {
    const repository = createRepository(
      "R_latest_importance_rebuild",
      "latest-importance-rebuild",
      FIRST_RUN_AT,
    );
    const publicRepository = requirePublicRepository(repository);
    const fixture = createRepositoryFixture(repository);
    const observedAt = createUtcIsoDateTime(FIRST_RUN_AT);
    const fingerprint = "latest-importance-rebuild-v1";
    const item = createIssueItem({
      repository: publicRepository,
      number: 1,
      fingerprint,
      updatedAt: observedAt,
      observedAt,
      state: Object.freeze({ state: "open" }),
    });
    fixture.openItems = [item];
    fixture.details.set(
      item.nodeId,
      createIssueDetail({
        item,
        body: `body-${fingerprint}`,
        observedAt,
        nativeDependencies: Object.freeze([]),
        duplicateComments: false,
      }),
    );
    const config = await createTestConfig({
      explicitIncludes: [],
      retentionDays: 180,
      aiEnabled: true,
    });
    const harness = createCollectionHarness({
      repositories: [fixture],
      config,
      executeCodexAnalysis: executeSuccessfulCodexAnalysis,
    });

    const firstResult = await harness.runDaily(FIRST_RUN_AT);
    expect(firstResult.exitCode, JSON.stringify(firstResult)).toBe(0);
    const head = await harness.stateAdapter.resolveHead("tracker-state-v3");
    if (head.status !== "present") {
      throw new TypeError("latest importance再構築fixtureのstate branchがありません");
    }
    const files = await harness.stateAdapter.readBranchFiles("tracker-state-v3");
    const latestPaths = [...files.keys()].filter((path) =>
      path.startsWith("state/ai-latest-importance/"),
    );
    if (latestPaths.length !== 1) {
      throw new TypeError("latest importance再構築fixtureのindexが1件ではありません");
    }
    await harness.stateAdapter.commit({
      branch: "tracker-state-v3",
      expectedHead: head,
      updates: [],
      deletions: latestPaths,
      message: "latest importance index欠落fixture",
      committedAt: FIRST_RUN_AT,
    });
    harness.detailCalls.length = 0;
    harness.artifacts.length = 0;

    const result = await harness.runCollectAnalyze(SECOND_RUN_AT);
    const artifact = requireCollectAnalyzeArtifact(harness.artifacts);

    expect(result.exitCode).toBe(0);
    expect(harness.detailCalls).toEqual([]);
    expect(artifact.cacheOnlyPayload.latestImportanceCaches).toHaveLength(1);
    expect(artifact.cacheOnlyPayload.latestImportanceCaches[0]?.nodeId).toBe(item.nodeId);
    expect(artifact.cacheOnlyPayload.aiCacheEntries).toHaveLength(1);
  });

  it("両側detailの同じnative依存を1候補へ統合してIssue状態を判定する", async () => {
    const repository = createRepository(
      "R_bidirectional_native_dependency",
      "bidirectional-native-dependency",
      FIRST_RUN_AT,
    );
    const publicRepository = requirePublicRepository(repository);
    const fixture = createRepositoryFixture(repository);
    const observedAt = createUtcIsoDateTime(FIRST_RUN_AT);
    const blocked = createIssueItem({
      repository: publicRepository,
      number: 1,
      fingerprint: "bidirectional-native-blocked",
      updatedAt: observedAt,
      observedAt,
      state: Object.freeze({ state: "open" }),
    });
    const blocker = createIssueItem({
      repository: publicRepository,
      number: 2,
      fingerprint: "bidirectional-native-blocker",
      updatedAt: observedAt,
      observedAt,
      state: Object.freeze({ state: "open" }),
    });
    const blockedBy = createNativeBlocker(blocked, blocker);
    const blocking = createNativeBlocking(blocker, blocked);
    fixture.openItems = [blocked, blocker];
    fixture.details.set(
      blocked.nodeId,
      createIssueDetail({
        item: blocked,
        body: "blocker側にも同じnative依存があります",
        observedAt,
        nativeDependencies: Object.freeze([blockedBy]),
        duplicateComments: false,
      }),
    );
    fixture.details.set(
      blocker.nodeId,
      createIssueDetail({
        item: blocker,
        body: "blocked側にも同じnative依存があります",
        observedAt,
        nativeDependencies: Object.freeze([blocking]),
        duplicateComments: false,
      }),
    );
    const config = await createTestConfig({
      explicitIncludes: [],
      retentionDays: 180,
      aiEnabled: true,
    });
    const harness = createCollectionHarness({
      repositories: [fixture],
      config,
    });

    const result = await harness.runDry(FIRST_RUN_AT);
    const snapshot = requireDryRunSnapshot(harness.artifacts);
    const trackedItem = snapshot.items.find((item) => item.nodeId === blocked.nodeId);
    const relations = snapshot.relations.filter(
      (relation) => relation.fromNodeId === blocker.nodeId && relation.toNodeId === blocked.nodeId,
    );
    const relationSourceIds = [blockedBy.sourceId, blocking.sourceId].sort();

    expect(result.exitCode).toBe(0);
    expect(trackedItem).toMatchObject({
      status: "waiting_for_unblock",
      statusSince: blocked.createdAt,
      ownerSince: blocked.createdAt,
      waitingOn: [
        {
          candidateId: blocker.nodeId,
          sourceIds: relationSourceIds,
        },
      ],
    });
    expect(relations).toHaveLength(1);
    expect(relations[0]?.evidence.map((evidence) => evidence.sourceId).sort()).toEqual(
      relationSourceIds,
    );
  });

  it("PR本文と両側native closing情報を1件のauthoritative implements edgeへ統合する", async () => {
    const repository = createRepository("R_native_closing", "native-closing", FIRST_RUN_AT);
    const publicRepository = requirePublicRepository(repository);
    const fixture = createRepositoryFixture(repository);
    const observedAt = createUtcIsoDateTime(FIRST_RUN_AT);
    const issue = createIssueItem({
      repository: publicRepository,
      number: 1391,
      fingerprint: "native-closing-issue",
      updatedAt: observedAt,
      observedAt,
      state: Object.freeze({ state: "open" }),
    });
    const pullRequest = createPullRequestItem({
      repository: publicRepository,
      number: 1392,
      fingerprint: "native-closing-pull-request",
      updatedAt: observedAt,
      observedAt,
    });
    const crossReference = createInboundCrossReference(issue, pullRequest, observedAt, true);
    const nativeClosingIssue = createNativeClosingIssue(pullRequest, issue);
    const pullRequestDetail = createFailedCheckPullRequestDetail(pullRequest, observedAt);
    fixture.openItems = [issue, pullRequest];
    fixture.details.set(
      issue.nodeId,
      Object.freeze({
        ...createIssueDetail({
          item: issue,
          body: "本文",
          observedAt,
          nativeDependencies: Object.freeze([]),
          duplicateComments: false,
        }),
        timeline: Object.freeze([crossReference.event]),
        inboundCrossReferences: Object.freeze([crossReference.candidate]),
      }),
    );
    fixture.details.set(
      pullRequest.nodeId,
      Object.freeze({
        ...pullRequestDetail,
        body: "close #1391",
        comments: Object.freeze([]),
        nativeClosingIssues: Object.freeze([nativeClosingIssue]),
      }),
    );
    const config = await createTestConfig({
      explicitIncludes: [],
      retentionDays: 180,
      aiEnabled: true,
    });
    const harness = createCollectionHarness({
      repositories: [fixture],
      config,
      executeCodexAnalysis: (input) => {
        const source = input.sources[0];
        if (source == null) {
          throw new TypeError("native closing fixtureのsourceがありません");
        }
        return Promise.resolve(
          createCodexOutput(input, {
            status: "in_progress",
            waitingOn: {
              candidateId: requireCodexAuthorCandidateId(input),
              kind: "user",
              role: "author",
              sourceId: source.id,
            },
            latestMeaningfulSourceId: null,
            confidence: 0.95,
            relationVerdict: "current_implements_target",
            notification: {
              recommended: false,
              reasonCode: "none",
              reasonSummary: "通知しません",
            },
          }),
        );
      },
    });

    const result = await harness.runDry(FIRST_RUN_AT);
    const snapshot = requireDryRunSnapshot(harness.artifacts);
    const relations = snapshot.relations.filter(
      (relation) =>
        relation.active &&
        relation.type === "implements" &&
        relation.fromNodeId === pullRequest.nodeId &&
        relation.toNodeId === issue.nodeId,
    );
    const input = harness.codexInputs.find(
      (candidate) => candidate.item.nodeId === pullRequest.nodeId,
    );

    expect(result.exitCode).toBe(0);
    expect(input?.candidates.relations).toHaveLength(1);
    expect(relations).toHaveLength(1);
    expect(relations[0]).toMatchObject({
      provenance: "native",
      confidence: 1,
    });
    expect(relations[0]?.evidence.map((evidence) => evidence.sourceId).sort()).toEqual(
      [nativeClosingIssue.sourceId, crossReference.event.sourceId].sort(),
    );
  });

  it("同じ2 node間の複数active blocks edgeを統合してIssue状態を判定する", async () => {
    const repository = createRepository(
      "R_multiple_block_edges",
      "multiple-block-edges",
      FIRST_RUN_AT,
    );
    const publicRepository = requirePublicRepository(repository);
    const fixture = createRepositoryFixture(repository);
    const firstObservedAt = createUtcIsoDateTime(FIRST_RUN_AT);
    const blocked = createIssueItem({
      repository: publicRepository,
      number: 1,
      fingerprint: "multiple-block-edges-first",
      updatedAt: firstObservedAt,
      observedAt: firstObservedAt,
      state: Object.freeze({ state: "open" }),
    });
    const otherBlocker = createIssueItem({
      repository: publicRepository,
      number: 2,
      fingerprint: "multiple-block-edges-other-blocker",
      updatedAt: firstObservedAt,
      observedAt: firstObservedAt,
      state: Object.freeze({ state: "open" }),
    });
    const blocker = createIssueItem({
      repository: publicRepository,
      number: 3,
      fingerprint: "multiple-block-edges-blocker",
      updatedAt: firstObservedAt,
      observedAt: firstObservedAt,
      state: Object.freeze({ state: "open" }),
    });
    const body = `推定依存候補は ${blocker.url} です`;
    fixture.openItems = [blocked, otherBlocker, blocker];
    setIssueDetails(fixture, [blocked, otherBlocker, blocker], firstObservedAt);
    fixture.details.set(
      blocked.nodeId,
      createIssueDetail({
        item: blocked,
        body,
        observedAt: firstObservedAt,
        nativeDependencies: Object.freeze([]),
        duplicateComments: false,
      }),
    );
    const config = await createTestConfig({
      explicitIncludes: [],
      retentionDays: 180,
      aiEnabled: true,
    });
    const harness = createCollectionHarness({
      repositories: [fixture],
      config,
      executeCodexAnalysis: (input) => {
        const source = input.sources[0];
        if (source == null) {
          throw new TypeError("複数blocks edge fixtureのsourceがありません");
        }
        return Promise.resolve(
          createCodexOutput(input, {
            status: "in_progress",
            waitingOn: {
              candidateId: requireCodexAuthorCandidateId(input),
              kind: "user",
              role: "assignee",
              sourceId: source.id,
            },
            latestMeaningfulSourceId: null,
            confidence: 0.7,
            relationVerdict: "current_is_blocked_by_target",
            notification: {
              recommended: false,
              reasonCode: "none",
              reasonSummary: "通知しません",
            },
          }),
        );
      },
    });

    expect((await harness.runCollectAnalyze(FIRST_RUN_AT)).exitCode).toBe(0);
    const firstSnapshot = requireCollectAnalyzeArtifact(harness.artifacts).snapshot;
    expect(firstSnapshot.items.find((item) => item.nodeId === blocked.nodeId)?.status).not.toBe(
      "waiting_for_unblock",
    );

    const secondObservedAt = createUtcIsoDateTime(SECOND_RUN_AT);
    const changedBlocked = createIssueItem({
      repository: publicRepository,
      number: 1,
      fingerprint: "multiple-block-edges-second",
      updatedAt: secondObservedAt,
      observedAt: secondObservedAt,
      state: Object.freeze({ state: "open" }),
    });
    const nativeDependency = createNativeBlocker(changedBlocked, blocker);
    const otherNativeDependency = createNativeBlocker(changedBlocked, otherBlocker);
    fixture.openItems = [changedBlocked, otherBlocker, blocker];
    fixture.details.set(
      changedBlocked.nodeId,
      Object.freeze({
        ...createIssueDetail({
          item: changedBlocked,
          body,
          observedAt: secondObservedAt,
          nativeDependencies: Object.freeze([nativeDependency, otherNativeDependency]),
          duplicateComments: false,
        }),
        lastEditedAt: secondObservedAt,
        bodyUserContentEdits: Object.freeze({
          availability: "available",
          edits: Object.freeze([
            Object.freeze({
              sourceId: buildSourceId("github_user_content_edit", `${changedBlocked.nodeId}:empty`),
              sequence: 0,
              createdAt: changedBlocked.createdAt,
              deletedAt: null,
              diff: "",
              editedAt: changedBlocked.createdAt,
              editor: Object.freeze({
                status: "unavailable",
                reason: "github_did_not_return_actor",
              }),
              updatedAt: changedBlocked.createdAt,
            }),
            Object.freeze({
              sourceId: buildSourceId(
                "github_user_content_edit",
                `${changedBlocked.nodeId}:relation-added`,
              ),
              sequence: 1,
              createdAt: changedBlocked.createdAt,
              deletedAt: null,
              diff: body,
              editedAt: secondObservedAt,
              editor: Object.freeze({
                status: "unavailable",
                reason: "github_did_not_return_actor",
              }),
              updatedAt: secondObservedAt,
            }),
          ]),
        }),
      }),
    );
    harness.artifacts.length = 0;

    const result = await harness.runDry(SECOND_RUN_AT);
    const snapshot = requireDryRunSnapshot(harness.artifacts);
    const trackedItem = snapshot.items.find((item) => item.nodeId === blocked.nodeId);
    const relations = snapshot.relations
      .filter(
        (relation) =>
          relation.active &&
          relation.type === "blocks" &&
          relation.fromNodeId === blocker.nodeId &&
          relation.toNodeId === blocked.nodeId,
      )
      .sort((left, right) => left.provenance.localeCompare(right.provenance));
    expect(result.exitCode).toBe(0);
    expect(relations).toHaveLength(2);
    expect(relations).toMatchObject([
      {
        provenance: "explicit_text",
        confidence: 0.7,
        firstSeenAt: blocked.createdAt,
      },
      {
        provenance: "native",
        confidence: 1,
        firstSeenAt: changedBlocked.createdAt,
      },
    ]);
    expect(trackedItem).toMatchObject({
      status: "waiting_for_unblock",
      statusSince: changedBlocked.createdAt,
      primaryWaitingOn: {
        index: 0,
      },
      waitingOn: [
        {
          candidateId: otherBlocker.nodeId,
          role: "dependency",
          confidence: 1,
          sourceIds: [otherNativeDependency.sourceId],
        },
        {
          candidateId: blocker.nodeId,
          role: "dependency",
          confidence: 1,
          sourceIds: [
            buildSourceId("github_user_content_edit", `${changedBlocked.nodeId}:relation-added`),
          ],
        },
      ],
    });
  });

  it("本文編集で追加したblocks relationの時刻をstatus起点にする", async () => {
    const repository = createRepository("R_body_relation_time", "body-relation-time", FIRST_RUN_AT);
    const publicRepository = requirePublicRepository(repository);
    const fixture = createRepositoryFixture(repository);
    const observedAt = createUtcIsoDateTime(FIRST_RUN_AT);
    const relationAddedAt = createUtcIsoDateTime("2026-07-31T12:00:00.000Z");
    const blocked = createIssueItem({
      repository: publicRepository,
      number: 1,
      fingerprint: "body-relation-time-blocked",
      updatedAt: relationAddedAt,
      observedAt,
      state: Object.freeze({ state: "open" }),
    });
    const relationAddedSourceId = buildSourceId(
      "github_user_content_edit",
      `${blocked.nodeId}:blocked`,
    );
    const blocker = createIssueItem({
      repository: publicRepository,
      number: 2,
      fingerprint: "body-relation-time-blocker",
      updatedAt: observedAt,
      observedAt,
      state: Object.freeze({ state: "open" }),
    });
    const body = `対応は ${blocker.url} にblockedされています`;
    const baseDetail = createIssueDetail({
      item: blocked,
      body,
      observedAt,
      nativeDependencies: Object.freeze([]),
      duplicateComments: false,
    });
    fixture.openItems = [blocked, blocker];
    fixture.details.set(
      blocked.nodeId,
      Object.freeze({
        ...baseDetail,
        lastEditedAt: relationAddedAt,
        bodyUserContentEdits: Object.freeze({
          availability: "available",
          edits: Object.freeze([
            Object.freeze({
              sourceId: buildSourceId("github_user_content_edit", `${blocked.nodeId}:initial`),
              sequence: 0,
              createdAt: blocked.createdAt,
              deletedAt: null,
              diff: "",
              editedAt: blocked.createdAt,
              editor: Object.freeze({
                status: "unavailable",
                reason: "github_did_not_return_actor",
              }),
              updatedAt: blocked.createdAt,
            }),
            Object.freeze({
              sourceId: relationAddedSourceId,
              sequence: 1,
              createdAt: blocked.createdAt,
              deletedAt: null,
              diff: body,
              editedAt: relationAddedAt,
              editor: Object.freeze({
                status: "unavailable",
                reason: "github_did_not_return_actor",
              }),
              updatedAt: relationAddedAt,
            }),
          ]),
        }),
      } satisfies GitHubItemDetail),
    );
    fixture.details.set(
      blocker.nodeId,
      createIssueDetail({
        item: blocker,
        body: "blocker側の本文です",
        observedAt,
        nativeDependencies: Object.freeze([]),
        duplicateComments: false,
      }),
    );
    const config = await createTestConfig({
      explicitIncludes: [],
      retentionDays: 180,
      aiEnabled: true,
    });
    const harness = createCollectionHarness({
      repositories: [fixture],
      config,
      executeCodexAnalysis: (input) => {
        const source = input.sources[0];
        if (source == null) {
          throw new TypeError("本文relation時刻fixtureのsourceがありません");
        }
        return Promise.resolve(
          createCodexOutput(input, {
            status: "in_progress",
            waitingOn: {
              candidateId: requireCodexAuthorCandidateId(input),
              kind: "user",
              role: "assignee",
              sourceId: source.id,
            },
            latestMeaningfulSourceId: null,
            confidence: 0.95,
            relationVerdict:
              input.item.nodeId === blocked.nodeId
                ? "current_is_blocked_by_target"
                : "current_blocks_target",
            notification: {
              recommended: false,
              reasonCode: "none",
              reasonSummary: "通知しません",
            },
          }),
        );
      },
    });

    const result = await harness.runCollectAnalyze(FIRST_RUN_AT);
    if (result.exitCode !== 0) {
      throw new TypeError(`本文relation時刻fixtureに失敗しました。${JSON.stringify(result)}`);
    }
    const item = requireCollectAnalyzeArtifact(harness.artifacts).snapshot.items.find(
      (candidate) => candidate.nodeId === blocked.nodeId,
    );

    expect(result.exitCode).toBe(0);
    expect(item).toMatchObject({
      status: "waiting_for_unblock",
      statusSince: relationAddedAt,
      ownerSince: relationAddedAt,
      stallSince: relationAddedAt,
      waitingOn: [
        expect.objectContaining({
          candidateId: blocker.nodeId,
          sourceIds: [relationAddedSourceId],
        }),
      ],
    });
    expect(
      requireCollectAnalyzeArtifact(harness.artifacts).pages.details.items.find(
        (candidate) => candidate.summary.nodeId === blocked.nodeId,
      )?.evidence,
    ).toContainEqual(expect.objectContaining({ sourceUrl: blocked.url }));
  });

  it("本文編集で削除したexact AI blocks relationを現在graphへ戻さずnewly unblockedへ渡す", async () => {
    const repository = createRepository(
      "R_body_relation_removed",
      "body-relation-removed",
      FIRST_RUN_AT,
    );
    const publicRepository = requirePublicRepository(repository);
    const fixture = createRepositoryFixture(repository);
    const firstObservedAt = createUtcIsoDateTime(FIRST_RUN_AT);
    const relationAddedAt = createUtcIsoDateTime("2026-07-31T23:00:00.000Z");
    const relationRemovedAt = createUtcIsoDateTime("2026-08-01T23:00:00.000Z");
    const firstBlocked = createIssueItem({
      repository: publicRepository,
      number: 1,
      fingerprint: "body-relation-removed-v1",
      updatedAt: relationAddedAt,
      observedAt: firstObservedAt,
      state: Object.freeze({ state: "open" }),
    });
    const prioritizedFirstBlocked = Object.freeze({
      ...firstBlocked,
      labels: Object.freeze(["優先度：高"]),
    });
    const firstBlocker = createIssueItem({
      repository: publicRepository,
      number: 2,
      fingerprint: "body-relation-removal-blocker",
      updatedAt: firstObservedAt,
      observedAt: firstObservedAt,
      state: Object.freeze({ state: "open" }),
    });
    const relationBody = `対応は ${firstBlocker.url} にblockedされています`;
    const initialEditSourceId = buildSourceId(
      "github_user_content_edit",
      `${prioritizedFirstBlocked.nodeId}:initial`,
    );
    const addedEditSourceId = buildSourceId(
      "github_user_content_edit",
      `${prioritizedFirstBlocked.nodeId}:added`,
    );
    const removedEditSourceId = buildSourceId(
      "github_user_content_edit",
      `${prioritizedFirstBlocked.nodeId}:removed`,
    );
    const createEdit = (
      sourceId: ReturnType<typeof buildSourceId>,
      sequence: number,
      editedAt: UtcIsoDateTime,
      diff: string,
    ): GitHubUserContentEdit =>
      Object.freeze({
        sourceId,
        sequence,
        createdAt: prioritizedFirstBlocked.createdAt,
        deletedAt: null,
        diff,
        editedAt,
        editor: Object.freeze({
          status: "unavailable",
          reason: "github_did_not_return_actor",
        }),
        updatedAt: editedAt,
      } satisfies GitHubUserContentEdit);
    const initialDetail = createIssueDetail({
      item: prioritizedFirstBlocked,
      body: relationBody,
      observedAt: firstObservedAt,
      nativeDependencies: Object.freeze([]),
      duplicateComments: false,
    });
    fixture.openItems = [prioritizedFirstBlocked, firstBlocker];
    fixture.details.set(
      prioritizedFirstBlocked.nodeId,
      Object.freeze({
        ...initialDetail,
        lastEditedAt: relationAddedAt,
        bodyUserContentEdits: Object.freeze({
          availability: "available",
          edits: Object.freeze([
            createEdit(initialEditSourceId, 0, prioritizedFirstBlocked.createdAt, ""),
            createEdit(addedEditSourceId, 1, relationAddedAt, relationBody),
          ]),
        }),
      } satisfies GitHubItemDetail),
    );
    fixture.details.set(
      firstBlocker.nodeId,
      Object.freeze({
        ...createIssueDetail({
          item: firstBlocker,
          body: "blocker側の本文です",
          observedAt: firstObservedAt,
          nativeDependencies: Object.freeze([]),
          duplicateComments: false,
        }),
        bodyUserContentEdits: Object.freeze({
          availability: "available",
          edits: Object.freeze([]),
        }),
      } satisfies GitHubItemDetail),
    );
    const config = await createTestConfig({
      explicitIncludes: [],
      retentionDays: 180,
      aiEnabled: true,
    });
    let runNumber = 0;
    const harness = createCollectionHarness({
      repositories: [fixture],
      config,
      scheduledRun: true,
      executeCodexAnalysis: (input) => {
        if (runNumber > 0) {
          return Promise.reject(new TypeError("現在入力のAI relation判定を利用しません"));
        }
        const source = input.sources[0];
        if (source == null) {
          throw new TypeError("本文relation削除fixtureのsourceがありません");
        }
        return Promise.resolve(
          createCodexOutput(input, {
            status: "in_progress",
            waitingOn: {
              candidateId: requireCodexAuthorCandidateId(input),
              kind: "user",
              role: "assignee",
              sourceId: source.id,
            },
            latestMeaningfulSourceId: null,
            confidence: 0.95,
            relationVerdict:
              input.item.nodeId === prioritizedFirstBlocked.nodeId
                ? "current_is_blocked_by_target"
                : "current_blocks_target",
            notification: {
              recommended: false,
              reasonCode: "none",
              reasonSummary: "通知しません",
            },
          }),
        );
      },
    });

    expect((await harness.runDaily(FIRST_RUN_AT)).exitCode).toBe(0);
    runNumber += 1;
    const secondObservedAt = createUtcIsoDateTime(SECOND_RUN_AT);
    const currentBlocked = createIssueItem({
      repository: publicRepository,
      number: 1,
      fingerprint: "body-relation-removed-v2",
      updatedAt: relationRemovedAt,
      observedAt: secondObservedAt,
      state: Object.freeze({ state: "open" }),
    });
    const prioritizedCurrentBlocked = Object.freeze({
      ...currentBlocked,
      labels: Object.freeze(["優先度：高"]),
    });
    const currentBlocker = createIssueItem({
      repository: publicRepository,
      number: 2,
      fingerprint: "body-relation-removal-blocker",
      updatedAt: firstObservedAt,
      observedAt: secondObservedAt,
      state: Object.freeze({ state: "open" }),
    });
    const currentDetail = createIssueDetail({
      item: prioritizedCurrentBlocked,
      body: "",
      observedAt: secondObservedAt,
      nativeDependencies: Object.freeze([]),
      duplicateComments: false,
    });
    fixture.openItems = [prioritizedCurrentBlocked, currentBlocker];
    fixture.details.set(
      prioritizedCurrentBlocked.nodeId,
      Object.freeze({
        ...currentDetail,
        lastEditedAt: relationRemovedAt,
        bodyUserContentEdits: Object.freeze({
          availability: "available",
          edits: Object.freeze([
            createEdit(initialEditSourceId, 0, prioritizedFirstBlocked.createdAt, ""),
            createEdit(addedEditSourceId, 1, relationAddedAt, relationBody),
            createEdit(removedEditSourceId, 2, relationRemovedAt, ""),
          ]),
        }),
      } satisfies GitHubItemDetail),
    );
    fixture.details.set(
      currentBlocker.nodeId,
      Object.freeze({
        ...createIssueDetail({
          item: currentBlocker,
          body: "blocker側の本文です",
          observedAt: secondObservedAt,
          nativeDependencies: Object.freeze([]),
          duplicateComments: false,
        }),
        bodyUserContentEdits: Object.freeze({
          availability: "available",
          edits: Object.freeze([]),
        }),
      } satisfies GitHubItemDetail),
    );
    harness.artifacts.length = 0;

    const result = await harness.runCollectAnalyze(SECOND_RUN_AT);
    const artifact = requireCollectAnalyzeArtifact(harness.artifacts);
    expect(result.exitCode).toBe(0);
    expect(artifact.snapshot.relations).not.toContainEqual(
      expect.objectContaining({
        type: "blocks",
        fromNodeId: currentBlocker.nodeId,
        toNodeId: prioritizedCurrentBlocked.nodeId,
        active: true,
      }),
    );
    expect(
      artifact.snapshot.items.find((item) => item.nodeId === prioritizedCurrentBlocked.nodeId),
    ).toMatchObject({
      importance: {
        score: 25,
        factors: [expect.objectContaining({ kind: "priorityLabel" })],
      },
      attention: { score: 25 },
    });
    expect(
      artifact.notificationSelection.candidates.find(
        (candidate) => candidate.itemNodeId === prioritizedCurrentBlocked.nodeId,
      )?.reasons,
    ).toContainEqual(
      expect.objectContaining({
        reasonCode: "newly_unblocked",
      }),
    );
  });

  it("automation dashboardをgraphに残しつつ既定digestから除外する", async () => {
    const repository = createRepository("R_automation", "automation", FIRST_RUN_AT);
    const fixture = createRepositoryFixture(repository);
    const observedAt = createUtcIsoDateTime(FIRST_RUN_AT);
    const item = replaceWithAutomationDashboard(
      createIssueItem({
        repository: requirePublicRepository(repository),
        number: 1,
        fingerprint: "automation-dashboard",
        updatedAt: observedAt,
        observedAt,
        state: Object.freeze({ state: "open" }),
      }),
      "依存更新ダッシュボード",
    );
    fixture.openItems = [item];
    setIssueDetails(fixture, [item], observedAt);
    const baseConfig = await createTestConfig({
      explicitIncludes: [],
      retentionDays: 180,
      aiEnabled: false,
    });
    const config = Object.freeze({
      ...baseConfig,
      notifications: Object.freeze({
        ...baseConfig.notifications,
        automationNoiseTitles: ["依存更新ダッシュボード"],
      }),
    });
    const harness = createCollectionHarness({ repositories: [fixture], config });

    const result = await harness.runCollectAnalyze(FIRST_RUN_AT);
    const artifact = requireCollectAnalyzeArtifact(harness.artifacts);
    const snapshot = artifact.snapshot;

    expect(result.exitCode).toBe(0);
    expect(snapshot.items).toContainEqual(
      expect.objectContaining({
        nodeId: item.nodeId,
        notificationClass: "automation_noise",
      }),
    );
    expect(artifact.pages.details.graph.nodes).toContainEqual(
      expect.objectContaining({
        nodeId: item.nodeId,
      }),
    );
    expect(harness.discordCandidateNodeIds).toEqual([]);
  });

  it("tracked項目の本文とコメントから参照された開始日前項目を追跡する", async () => {
    const repository = createRepository("R_outbound_reference", "outbound-reference", FIRST_RUN_AT);
    const publicRepository = requirePublicRepository(repository);
    const fixture = createRepositoryFixture(repository);
    const observedAt = createUtcIsoDateTime(FIRST_RUN_AT);
    const oldItemAt = createUtcIsoDateTime(OLD_ITEM_AT);
    const tracked = createIssueItem({
      repository: publicRepository,
      number: 1,
      fingerprint: "tracked",
      updatedAt: observedAt,
      observedAt,
      state: Object.freeze({ state: "open" }),
    });
    const bodyReferenced = replaceCreatedAt(
      createIssueItem({
        repository: publicRepository,
        number: 2,
        fingerprint: "body-referenced",
        updatedAt: oldItemAt,
        observedAt,
        state: Object.freeze({ state: "open" }),
      }),
      oldItemAt,
    );
    const commentReferenced = replaceCreatedAt(
      createIssueItem({
        repository: publicRepository,
        number: 3,
        fingerprint: "comment-referenced",
        updatedAt: oldItemAt,
        observedAt,
        state: Object.freeze({ state: "open" }),
      }),
      oldItemAt,
    );
    const commentNodeId = createGitHubNodeId("IC_outbound_reference");
    const referenceComment = Object.freeze({
      sourceId: buildSourceId("github_issue_comment", commentNodeId),
      nodeId: commentNodeId,
      sequence: 0,
      author: Object.freeze({
        status: "identified",
        account: Object.freeze({
          sourceId: buildSourceId("github_account", "U_outbound_reference"),
          nodeId: createGitHubNodeId("U_outbound_reference"),
          login: "outbound-reference-author",
          apiType: "User",
        }),
      }),
      body: `${commentReferenced.url} をコメントから参照します`,
      createdAt: observedAt,
      lastEditedAt: null,
      updatedAt: observedAt,
      url: tracked.url,
      userContentEdits: Object.freeze({
        availability: "unavailable",
        reason: "connection_null",
      }),
    } satisfies GitHubIssueComment);
    fixture.openItems = [tracked, bodyReferenced, commentReferenced];
    setIssueDetails(fixture, fixture.openItems, observedAt);
    fixture.details.set(
      tracked.nodeId,
      Object.freeze({
        ...createIssueDetail({
          item: tracked,
          body: `${bodyReferenced.url} を本文から参照します`,
          observedAt,
          nativeDependencies: Object.freeze([]),
          duplicateComments: false,
        }),
        comments: Object.freeze([referenceComment]),
      }),
    );
    const baseConfig = await createTestConfig({
      explicitIncludes: [],
      retentionDays: 180,
      aiEnabled: true,
    });
    const config = Object.freeze({
      ...baseConfig,
      tracking: Object.freeze({
        ...baseConfig.tracking,
        autoInclude: Object.freeze({
          ...baseConfig.tracking.autoInclude,
          referencesTracked: false,
        }),
      }),
    });
    const harness = createCollectionHarness({
      repositories: [fixture],
      config,
      executeCodexAnalysis: executeSuccessfulCodexAnalysis,
    });

    const result = await harness.runDry(FIRST_RUN_AT);
    const trackedNodeIds = requireDryRunSnapshot(harness.artifacts).items.map(
      (item) => item.nodeId,
    );

    expect(result.exitCode).toBe(0);
    expect(trackedNodeIds).toHaveLength(3);
    expect(trackedNodeIds).toEqual(
      expect.arrayContaining([tracked.nodeId, bodyReferenced.nodeId, commentReferenced.nodeId]),
    );
  });

  it("tracked項目へのcross-reference元である開始日前項目を追跡する", async () => {
    const repository = createRepository("R_inbound_reference", "inbound-reference", FIRST_RUN_AT);
    const publicRepository = requirePublicRepository(repository);
    const fixture = createRepositoryFixture(repository);
    const observedAt = createUtcIsoDateTime(FIRST_RUN_AT);
    const oldItemAt = createUtcIsoDateTime(OLD_ITEM_AT);
    const tracked = createIssueItem({
      repository: publicRepository,
      number: 1,
      fingerprint: "tracked",
      updatedAt: observedAt,
      observedAt,
      state: Object.freeze({ state: "open" }),
    });
    const source = replaceCreatedAt(
      createIssueItem({
        repository: publicRepository,
        number: 2,
        fingerprint: "cross-reference-source",
        updatedAt: oldItemAt,
        observedAt,
        state: Object.freeze({ state: "open" }),
      }),
      oldItemAt,
    );
    const sourceItem = Object.freeze({
      sourceId: buildSourceId("github_item", source.nodeId),
      nodeId: source.nodeId,
      repositoryId: source.repositoryId,
      repositoryOwner: publicRepository.owner,
      repositoryName: publicRepository.name,
      repositoryArchived: false,
      repositoryDisabled: false,
      type: source.type,
      number: source.number,
      url: source.url,
      createdAt: source.createdAt,
      state: source.state,
    } satisfies GitHubReferencedItem);
    const eventNodeId = createGitHubNodeId("CRE_inbound_reference");
    const eventSourceId = buildSourceId("github_timeline_event", eventNodeId);
    const crossReferenceEvent = Object.freeze({
      sourceId: eventSourceId,
      nodeId: eventNodeId,
      sequence: 0,
      occurredAt: observedAt,
      actor: Object.freeze({
        status: "unavailable",
        reason: "github_did_not_return_actor",
      }),
      kind: "cross_referenced",
      source: sourceItem,
      willCloseTarget: false,
    } satisfies GitHubTimelineEvent);
    const inboundCrossReference = Object.freeze({
      sourceId: buildSourceId("github_inbound_cross_reference", `${eventNodeId}:${source.nodeId}`),
      candidateOnly: true,
      provenance: "cross_reference",
      eventSourceId,
      sourceItem,
      willCloseTarget: false,
    } satisfies GitHubInboundCrossReferenceCandidate);
    fixture.openItems = [tracked, source];
    setIssueDetails(fixture, fixture.openItems, observedAt);
    fixture.details.set(
      tracked.nodeId,
      Object.freeze({
        ...createIssueDetail({
          item: tracked,
          body: "本文",
          observedAt,
          nativeDependencies: Object.freeze([]),
          duplicateComments: false,
        }),
        timeline: Object.freeze([crossReferenceEvent]),
        inboundCrossReferences: Object.freeze([inboundCrossReference]),
      }),
    );
    const baseConfig = await createTestConfig({
      explicitIncludes: [],
      retentionDays: 180,
      aiEnabled: true,
    });
    const config = Object.freeze({
      ...baseConfig,
      tracking: Object.freeze({
        ...baseConfig.tracking,
        autoInclude: Object.freeze({
          ...baseConfig.tracking.autoInclude,
          referencedByTracked: false,
        }),
      }),
    });
    const harness = createCollectionHarness({
      repositories: [fixture],
      config,
      executeCodexAnalysis: executeSuccessfulCodexAnalysis,
    });

    const result = await harness.runDry(FIRST_RUN_AT);
    const trackedNodeIds = requireDryRunSnapshot(harness.artifacts).items.map(
      (item) => item.nodeId,
    );

    expect(result.exitCode).toBe(0);
    expect(trackedNodeIds).toHaveLength(2);
    expect(trackedNodeIds).toEqual(expect.arrayContaining([tracked.nodeId, source.nodeId]));
  });

  it("open列挙に含まれない古い参照先を同じrunで取得して追跡候補へ入れる", async () => {
    const repository = createRepository(
      "R_relation_expansion_reference",
      "relation-expansion-reference",
      FIRST_RUN_AT,
    );
    const publicRepository = requirePublicRepository(repository);
    const fixture = createRepositoryFixture(repository);
    const firstObservedAt = createUtcIsoDateTime(FIRST_RUN_AT);
    const firstTracked = createIssueItem({
      repository: publicRepository,
      number: 1,
      fingerprint: "tracked-reference-v1",
      updatedAt: firstObservedAt,
      observedAt: firstObservedAt,
      state: Object.freeze({ state: "open" }),
    });
    const firstReferenced = createOldIssueItem(
      publicRepository,
      2,
      "old-reference",
      firstObservedAt,
    );
    fixture.openItems = [firstTracked, firstReferenced];
    setIssueDetails(fixture, fixture.openItems, firstObservedAt);
    const config = await createTestConfig({
      explicitIncludes: [],
      retentionDays: 180,
      aiEnabled: true,
    });
    const harness = createCollectionHarness({
      repositories: [fixture],
      config,
      executeCodexAnalysis: executeSuccessfulCodexAnalysis,
    });
    expect((await harness.runDaily(FIRST_RUN_AT)).exitCode).toBe(0);
    harness.detailCalls.length = 0;
    harness.individualCalls.length = 0;

    const secondObservedAt = createUtcIsoDateTime(SECOND_RUN_AT);
    const secondTracked = createIssueItem({
      repository: publicRepository,
      number: 1,
      fingerprint: "tracked-reference-v2",
      updatedAt: secondObservedAt,
      observedAt: secondObservedAt,
      state: Object.freeze({ state: "open" }),
    });
    const secondReferenced = createOldIssueItem(
      publicRepository,
      2,
      "old-reference",
      secondObservedAt,
    );
    fixture.openItems = [secondTracked];
    fixture.individualItems.set(secondReferenced.nodeId, secondReferenced);
    setIssueDetails(fixture, [secondTracked, secondReferenced], secondObservedAt);
    fixture.details.set(
      secondTracked.nodeId,
      createIssueDetail({
        item: secondTracked,
        body: "本文",
        observedAt: secondObservedAt,
        nativeDependencies: Object.freeze([createNativeBlocker(secondTracked, secondReferenced)]),
        duplicateComments: false,
      }),
    );

    const result = await harness.runDry(SECOND_RUN_AT);
    const snapshot = requireDryRunSnapshot(harness.artifacts);

    expect(result.exitCode).toBe(0);
    expect(harness.individualCalls).toEqual([[secondReferenced.nodeId]]);
    expect(
      harness.detailCalls.flatMap((call) => call.targets.map((target) => target.nodeId)),
    ).toContain(secondReferenced.nodeId);
    expect(snapshot.items.map((item) => item.nodeId)).toEqual(
      expect.arrayContaining([secondTracked.nodeId, secondReferenced.nodeId]),
    );
    expect(requireCollectionItem(snapshot, secondReferenced.nodeId)).toMatchObject({
      nodeId: secondReferenced.nodeId,
    });
  });

  it("relation expansionで取得した未追跡Issueのcomment sourceをcache contextへ含める", async () => {
    const repository = createRepository(
      "R_relation_expansion_cache_comment",
      "relation-expansion-cache-comment",
      FIRST_RUN_AT,
    );
    const publicRepository = requirePublicRepository(repository);
    const fixture = createRepositoryFixture(repository);
    const observedAt = createUtcIsoDateTime(FIRST_RUN_AT);
    const commentOccurredAt = createUtcIsoDateTime("2025-12-02T00:00:00.000Z");
    const root = createIssueItem({
      repository: publicRepository,
      number: 1,
      fingerprint: "relation-expansion-cache-comment-root",
      updatedAt: observedAt,
      observedAt,
      state: Object.freeze({ state: "open" }),
    });
    const target = createOldIssueItem(
      publicRepository,
      2,
      "relation-expansion-cache-comment-target",
      observedAt,
    );
    const comment = createDuplicateComments(target, commentOccurredAt)[0];
    if (comment == null) {
      throw new TypeError("cache contextのcomment fixtureを作成できません");
    }
    const targetComment = Object.freeze({
      ...comment,
      body: "@requested-user へ対応します",
      createdAt: commentOccurredAt,
      updatedAt: commentOccurredAt,
      url: `${target.url}#issuecomment-${comment.nodeId}`,
    });
    fixture.openItems = [root];
    fixture.individualItems.set(target.nodeId, target);
    fixture.details.set(
      root.nodeId,
      createIssueDetailWithInboundCrossReferences(root, [target], observedAt),
    );
    fixture.details.set(
      target.nodeId,
      Object.freeze({
        ...createIssueDetail({
          item: target,
          body: "本文",
          observedAt,
          nativeDependencies: Object.freeze([]),
          duplicateComments: false,
        }),
        comments: Object.freeze([targetComment]),
      }),
    );
    const baseConfig = await createTestConfig({
      explicitIncludes: [root.url],
      retentionDays: 180,
      aiEnabled: true,
    });
    const config = Object.freeze({
      ...baseConfig,
      tracking: Object.freeze({
        ...baseConfig.tracking,
        autoInclude: Object.freeze({
          ...baseConfig.tracking.autoInclude,
          createdAfterStart: false,
          changedAfterStart: false,
          referencedByTracked: false,
          referencesTracked: false,
        }),
      }),
    });
    const harness = createCollectionHarness({
      repositories: [fixture],
      config,
      executeCodexAnalysis: executeSuccessfulCodexAnalysis,
    });

    const result = await harness.runCollectAnalyze(FIRST_RUN_AT);
    const artifact = requireCollectAnalyzeArtifact(harness.artifacts);
    const targetCache = artifact.cacheOnlyPayload.itemCaches.find(
      (item) => item.nodeId === target.nodeId,
    );
    if (targetCache == null) {
      throw new TypeError("未追跡relation targetのcache文書がありません");
    }
    const commentSource = targetCache.analysisFacts.codexValidationContext.sources.find(
      (source) => source.id === targetComment.sourceId,
    );
    const mentionedCandidate = targetCache.analysisFacts.mentionedWaitingOnCandidates.find(
      (candidate) => candidate.id === "requested-user" && candidate.kind === "user",
    );
    if (mentionedCandidate == null) {
      throw new TypeError("未追跡relation targetのmention候補がありません");
    }

    expect(result.exitCode).toBe(0);
    expect(artifact.snapshot.items.map((item) => item.nodeId)).toContain(root.nodeId);
    expect(artifact.snapshot.items.map((item) => item.nodeId)).not.toContain(target.nodeId);
    expect(targetCache.aiAnalysisStatus).toBe("not_recorded");
    expect(targetCache.analysisFacts.explicitRequestCandidates).toContainEqual({
      sourceId: targetComment.sourceId,
      occurredAt: commentOccurredAt,
    });
    expect(mentionedCandidate.sourceIds).toEqual([targetComment.sourceId]);
    expect(commentSource).toEqual({
      id: targetComment.sourceId,
      kind: "comment",
      actorType: "human",
      createdAt: commentOccurredAt,
    });
    expect(commentSource).not.toHaveProperty("content");
  });

  it("関係先のURL列挙結果が要求項目と一致しなければdetailを取得しない", async () => {
    const repository = createRepository(
      "R_relation_expansion_mismatch",
      "relation-expansion-mismatch",
      FIRST_RUN_AT,
    );
    const publicRepository = requirePublicRepository(repository);
    const fixture = createRepositoryFixture(repository);
    const observedAt = createUtcIsoDateTime(FIRST_RUN_AT);
    const root = createIssueItem({
      repository: publicRepository,
      number: 1,
      fingerprint: "relation-expansion-mismatch-root",
      updatedAt: observedAt,
      observedAt,
      state: Object.freeze({ state: "open" }),
    });
    const target = createOldIssueItem(
      publicRepository,
      2,
      "relation-expansion-mismatch-target",
      observedAt,
    );
    const mismatchedTargets = Object.freeze([
      Object.freeze({
        ...target,
        nodeId: createGitHubNodeId("I_relation-expansion-mismatch-other"),
      }),
      Object.freeze({
        ...target,
        url: `https://github.com/${publicRepository.owner}/${publicRepository.name}/issues/3` satisfies GitHubItemUrl,
      }),
    ] satisfies readonly EnumeratedGitHubItem[]);
    fixture.openItems = [root];
    fixture.details.set(
      root.nodeId,
      createIssueDetail({
        item: root,
        body: "本文",
        observedAt,
        nativeDependencies: Object.freeze([createNativeBlocker(root, target)]),
        duplicateComments: false,
      }),
    );
    const config = await createTestConfig({
      explicitIncludes: [],
      retentionDays: 180,
      aiEnabled: false,
    });
    for (const mismatchedTarget of mismatchedTargets) {
      fixture.individualItems.set(target.url, mismatchedTarget);
      const harness = createCollectionHarness({ repositories: [fixture], config });

      const result = await harness.runCollectAnalyze(FIRST_RUN_AT);
      if (result.command !== "collect-analyze") {
        throw new TypeError("関係先URL不一致fixtureがcollect-analyze結果ではありません");
      }

      expect(result.exitCode).toBe(1);
      expect(result.result.report).toMatchObject({
        status: "failure",
        failedStage: "incremental_collection",
        complete: false,
      });
      expect(harness.individualCalls).toEqual([[target.url]]);
      expect(harness.detailCalls).toEqual([{ targets: [{ nodeId: root.nodeId }] }]);
      expect(harness.artifacts).toEqual([]);
      expect(harness.publicData).toEqual([]);
    }
  });

  it("同じ関係先node IDの異なるURLを後勝ちで採用しない", async () => {
    const repository = createRepository(
      "R_relation_expansion_conflict",
      "relation-expansion-conflict",
      FIRST_RUN_AT,
    );
    const publicRepository = requirePublicRepository(repository);
    const fixture = createRepositoryFixture(repository);
    const observedAt = createUtcIsoDateTime(FIRST_RUN_AT);
    const firstRoot = createIssueItem({
      repository: publicRepository,
      number: 1,
      fingerprint: "relation-expansion-conflict-first",
      updatedAt: observedAt,
      observedAt,
      state: Object.freeze({ state: "open" }),
    });
    const secondRoot = createIssueItem({
      repository: publicRepository,
      number: 2,
      fingerprint: "relation-expansion-conflict-second",
      updatedAt: observedAt,
      observedAt,
      state: Object.freeze({ state: "open" }),
    });
    const target = createOldIssueItem(
      publicRepository,
      3,
      "relation-expansion-conflict-target",
      observedAt,
    );
    const conflictingTarget = Object.freeze({
      ...target,
      url: `https://github.com/${publicRepository.owner.toLowerCase()}/${publicRepository.name}/issues/3` satisfies GitHubItemUrl,
    }) satisfies EnumeratedGitHubItem;
    fixture.openItems = [firstRoot, secondRoot];
    fixture.details.set(
      firstRoot.nodeId,
      createIssueDetail({
        item: firstRoot,
        body: "本文",
        observedAt,
        nativeDependencies: Object.freeze([createNativeBlocker(firstRoot, target)]),
        duplicateComments: false,
      }),
    );
    fixture.details.set(
      secondRoot.nodeId,
      createIssueDetail({
        item: secondRoot,
        body: "本文",
        observedAt,
        nativeDependencies: Object.freeze([createNativeBlocker(secondRoot, conflictingTarget)]),
        duplicateComments: false,
      }),
    );
    const config = await createTestConfig({
      explicitIncludes: [],
      retentionDays: 180,
      aiEnabled: false,
    });
    const harness = createCollectionHarness({ repositories: [fixture], config });

    const result = await harness.runCollectAnalyze(FIRST_RUN_AT);
    if (result.command !== "collect-analyze") {
      throw new TypeError("関係先競合fixtureがcollect-analyze結果ではありません");
    }

    expect(result.exitCode).toBe(1);
    expect(result.result.report).toMatchObject({
      status: "failure",
      failedStage: "incremental_collection",
      complete: false,
    });
    expect(harness.individualCalls).toEqual([]);
    expect(harness.sleepDelays).toEqual([]);
    expect(harness.artifacts).toEqual([]);
    expect(harness.publicData).toEqual([]);
  });

  it("open列挙に含まれないinbound cross-reference元を同じrunで追跡候補へ入れる", async () => {
    const repository = createRepository(
      "R_relation_expansion_inbound",
      "relation-expansion-inbound",
      FIRST_RUN_AT,
    );
    const publicRepository = requirePublicRepository(repository);
    const fixture = createRepositoryFixture(repository);
    const observedAt = createUtcIsoDateTime(FIRST_RUN_AT);
    const tracked = createIssueItem({
      repository: publicRepository,
      number: 1,
      fingerprint: "tracked-inbound",
      updatedAt: observedAt,
      observedAt,
      state: Object.freeze({ state: "open" }),
    });
    const source = createOldIssueItem(publicRepository, 2, "old-inbound-source", observedAt);
    fixture.openItems = [tracked];
    fixture.individualItems.set(source.nodeId, source);
    setIssueDetails(fixture, [tracked, source], observedAt);
    fixture.details.set(
      tracked.nodeId,
      createIssueDetailWithInboundCrossReferences(tracked, [source], observedAt),
    );
    const config = await createTestConfig({
      explicitIncludes: [],
      retentionDays: 180,
      aiEnabled: true,
    });
    const harness = createCollectionHarness({
      repositories: [fixture],
      config,
      executeCodexAnalysis: executeSuccessfulCodexAnalysis,
    });

    const result = await harness.runDry(FIRST_RUN_AT);
    const snapshot = requireDryRunSnapshot(harness.artifacts);

    expect(result.exitCode).toBe(0);
    expect(harness.individualCalls).toEqual([[source.url]]);
    expect(snapshot.items.map((item) => item.nodeId)).toEqual(
      expect.arrayContaining([tracked.nodeId, source.nodeId]),
    );
    expect(requireCollectionItem(snapshot, source.nodeId)).toMatchObject({
      nodeId: source.nodeId,
    });
  });

  it("merge済みPull Requestが列挙結果とcross-reference元に現れても関係候補を抽出する", async () => {
    const repository = createRepository(
      "R_merged_inbound_reference",
      "merged-inbound-reference",
      FIRST_RUN_AT,
    );
    const publicRepository = requirePublicRepository(repository);
    const fixture = createRepositoryFixture(repository);
    const observedAt = createUtcIsoDateTime(FIRST_RUN_AT);
    const tracked = createIssueItem({
      repository: publicRepository,
      number: 1,
      fingerprint: "tracked-merged-inbound",
      updatedAt: observedAt,
      observedAt,
      state: Object.freeze({ state: "open" }),
    });
    const source = createMergedPullRequestItem({
      repository: publicRepository,
      number: 2,
      fingerprint: "merged-inbound-source",
      closedAt: observedAt,
      mergedAt: observedAt,
      observedAt,
    });
    const sourceDetail = createFailedCheckPullRequestDetail(source, observedAt);
    fixture.openItems = [tracked];
    fixture.individualItems.set(source.nodeId, source);
    fixture.details.set(
      tracked.nodeId,
      createIssueDetailWithInboundCrossReferences(tracked, [source], observedAt),
    );
    fixture.details.set(
      source.nodeId,
      Object.freeze({
        ...sourceDetail,
        timeline: Object.freeze([
          Object.freeze({
            sourceId: buildSourceId("github_timeline_event", `ME_${source.nodeId}`),
            nodeId: createGitHubNodeId(`ME_${source.nodeId}`),
            sequence: 0,
            occurredAt: observedAt,
            actor: Object.freeze({
              status: "unavailable",
              reason: "github_did_not_return_actor",
            }),
            kind: "merged",
          } satisfies GitHubTimelineEvent),
        ]),
        mergeState: Object.freeze({
          ...sourceDetail.mergeState,
          checks: Object.freeze({
            status: "not_configured",
          }),
        }),
      }),
    );
    const config = await createTestConfig({
      explicitIncludes: [],
      retentionDays: 180,
      aiEnabled: true,
    });
    const harness = createCollectionHarness({
      repositories: [fixture],
      config,
      executeCodexAnalysis: executeSuccessfulCodexAnalysis,
    });

    const result = await harness.runDry(FIRST_RUN_AT);
    const snapshot = requireDryRunSnapshot(harness.artifacts);

    expect(result.exitCode).toBe(0);
    expect(harness.individualCalls).toEqual([[source.url]]);
    expect(snapshot.items.map((item) => item.nodeId)).toEqual(
      expect.arrayContaining([tracked.nodeId, source.nodeId]),
    );
  });

  it("stateだけの関係参照競合は最新状態の再取得後に関係候補を抽出する", async () => {
    const repository = createRepository(
      "R_relation_state_refresh",
      "relation-state-refresh",
      FIRST_RUN_AT,
    );
    const publicRepository = requirePublicRepository(repository);
    const fixture = createRepositoryFixture(repository);
    const observedAt = createUtcIsoDateTime(FIRST_RUN_AT);
    const tracked = createIssueItem({
      repository: publicRepository,
      number: 1,
      fingerprint: "tracked-state-refresh",
      updatedAt: observedAt,
      observedAt,
      state: Object.freeze({ state: "open" }),
    });
    const sourceOpen = createPullRequestItem({
      repository: publicRepository,
      number: 2,
      fingerprint: "source-state-refresh-open",
      updatedAt: observedAt,
      observedAt,
    });
    const sourceMerged = createMergedPullRequestItem({
      repository: publicRepository,
      number: 2,
      fingerprint: "source-state-refresh-merged",
      closedAt: observedAt,
      mergedAt: observedAt,
      observedAt,
    });
    fixture.openItems = [tracked, sourceOpen];
    fixture.details.set(
      tracked.nodeId,
      createIssueDetailWithInboundCrossReferences(tracked, [sourceMerged], observedAt),
    );
    fixture.details.set(
      sourceOpen.nodeId,
      createFailedCheckPullRequestDetail(sourceOpen, observedAt),
    );
    const config = await createTestConfig({
      explicitIncludes: [],
      retentionDays: 180,
      aiEnabled: true,
    });
    const mergedSourceDetail = createFailedCheckPullRequestDetail(sourceMerged, observedAt);
    const mergedSourceTimeline = Object.freeze([
      Object.freeze({
        sourceId: buildSourceId("github_timeline_event", `MERGED_${sourceMerged.nodeId}`),
        nodeId: createGitHubNodeId(`MERGED_${sourceMerged.nodeId}`),
        sequence: 0,
        occurredAt: observedAt,
        actor: Object.freeze({
          status: "unavailable",
          reason: "github_did_not_return_actor",
        }),
        kind: "merged",
      } satisfies GitHubTimelineEvent),
    ]);
    let refreshCount = 0;
    const harness = createCollectionHarness({
      repositories: [fixture],
      config,
      executeCodexAnalysis: executeSuccessfulCodexAnalysis,
      sleep: () => Promise.resolve(),
      enumerateGitHubItemsByIdentifiers: (input) => {
        refreshCount += input.identifiers.length;
        fixture.details.set(
          sourceOpen.nodeId,
          Object.freeze({
            ...mergedSourceDetail,
            timeline: mergedSourceTimeline,
            mergeState: Object.freeze({
              ...mergedSourceDetail.mergeState,
              checks: Object.freeze({
                status: "not_configured",
              }),
            }),
          }),
        );
        return Promise.resolve(
          Object.freeze(
            input.identifiers.map((identifier) => {
              if (identifier === sourceOpen.url) {
                return sourceMerged;
              }
              if (identifier === tracked.url) {
                return tracked;
              }
              throw new TypeError("state競合fixtureの親詳細再取得対象が不正です");
            }),
          ),
        );
      },
    });

    const result = await harness.runCollectAnalyze(FIRST_RUN_AT);
    const artifact = requireCollectAnalyzeArtifact(harness.artifacts);
    const snapshot = artifact.snapshot;
    const sourceCache = artifact.cacheOnlyPayload.itemCaches.find(
      (document) => document.nodeId === sourceOpen.nodeId,
    );
    assertNonNullable(sourceCache, "state再取得fixtureのitem cacheがありません");
    const trackedCache = artifact.cacheOnlyPayload.itemCaches.find(
      (document) => document.nodeId === tracked.nodeId,
    );
    assertNonNullable(trackedCache, "state再取得fixtureの親item cacheがありません");
    const sourceCandidateNode = trackedCache.relationCandidates
      .flatMap((candidate) => {
        switch (candidate.relation.type) {
          case "blocks":
            return [candidate.relation.blocker, candidate.relation.blocked];
          case "parent_of":
            return [candidate.relation.parent, candidate.relation.subtask];
          case "implements":
            return [candidate.relation.implementation, candidate.relation.target];
          case "unclassified":
            return [candidate.relation.referencing, candidate.relation.referenced];
        }
      })
      .find((node) => node.nodeId === sourceOpen.nodeId);
    assertNonNullable(sourceCandidateNode, "state再取得fixtureのrelation candidateがありません");

    expect(result.exitCode, JSON.stringify(result)).toBe(0);
    expect(refreshCount).toBe(2);
    expect(harness.individualCalls).toEqual([[sourceOpen.url, tracked.url]]);
    expect(harness.sleepDelays).toEqual([2000]);
    expect(harness.detailCalls.at(-1)).toEqual({
      targets: [{ nodeId: tracked.nodeId }, { nodeId: sourceOpen.nodeId }],
    });
    expect(requireCollectionItem(snapshot, sourceOpen.nodeId).state).toBe("closed");
    expect(sourceCache.currentObservation.state).toBe("closed");
    expect(sourceCache.replay.currentState).toBe("merged");
    expect(sourceCandidateNode.state).toBe("merged");
    const codexNodeIds = harness.codexInputs.map((input) => input.item.nodeId);
    expect(codexNodeIds).toHaveLength(2);
    expect(new Set(codexNodeIds)).toEqual(new Set([tracked.nodeId, sourceOpen.nodeId]));
  });

  it("allowlist外external publicのstate競合は再取得せず元エラーを伝播する", async () => {
    const observedAt = createUtcIsoDateTime(FIRST_RUN_AT);
    const { fixture, tracked } = createRelationStateConflictIssueFixture(observedAt);
    fixture.openItems = [tracked];
    fixture.details.set(
      tracked.nodeId,
      createIssueDetail({
        item: tracked,
        body: "本文",
        observedAt,
        nativeDependencies: Object.freeze([
          createExternalNativeBlocker(tracked, {
            state: "open",
            repositoryArchived: false,
            repositoryDisabled: false,
          }),
          createExternalNativeBlocker(tracked, {
            state: "closed",
            repositoryArchived: false,
            repositoryDisabled: false,
          }),
        ]),
        duplicateComments: false,
      }),
    );
    const config = await createTestConfig({
      explicitIncludes: [],
      retentionDays: 180,
      aiEnabled: false,
    });
    let refreshCount = 0;
    const harness = createCollectionHarness({
      repositories: [fixture],
      config,
      sleep: () => Promise.resolve(),
      enumerateGitHubItemsByIdentifiers: () => {
        refreshCount += 1;
        throw new TypeError("external publicの再取得は呼ばれません");
      },
    });

    const result = await harness.runCollectAnalyze(FIRST_RUN_AT);

    expect(result.exitCode).toBe(1);
    expect(refreshCount).toBe(0);
    expect(harness.individualCalls).toEqual([]);
    expect(harness.sleepDelays).toEqual([]);
    if (result.command !== "collect-analyze") {
      throw new TypeError("external public競合fixtureがcollect-analyze結果ではありません");
    }
    expect(result.result.report.diagnostics.join(" ")).toContain(
      "errorType=RelationReferenceConflictError",
    );
    expect(result.result.report.diagnostics.join(" ")).not.toContain("errorType=TypeError");
  });

  it("既知のmerged PRとopenの親detail参照を再取得後にmergedで一致させる", async () => {
    const observedAt = createUtcIsoDateTime(FIRST_RUN_AT);
    const repository = createRepository(
      "R_relation_merged_reference",
      "relation-merged-reference",
      observedAt,
    );
    const publicRepository = requirePublicRepository(repository);
    const fixture = createRepositoryFixture(repository);
    const tracked = createIssueItem({
      repository: publicRepository,
      number: 1,
      fingerprint: "tracked-merged-reference",
      updatedAt: observedAt,
      observedAt,
      state: Object.freeze({ state: "open" }),
    });
    const sourceMerged = createMergedPullRequestItem({
      repository: publicRepository,
      number: 2,
      fingerprint: "source-merged-reference",
      closedAt: observedAt,
      mergedAt: observedAt,
      observedAt,
    });
    const sourceOpen = createPullRequestItem({
      repository: publicRepository,
      number: 2,
      fingerprint: "source-open-reference",
      updatedAt: observedAt,
      observedAt,
    });
    fixture.openItems = [tracked];
    fixture.individualItems.set(sourceMerged.url, sourceMerged);
    fixture.details.set(
      tracked.nodeId,
      createIssueDetailWithInboundCrossReferences(tracked, [sourceOpen], observedAt),
    );
    fixture.details.set(
      sourceMerged.nodeId,
      createFailedCheckPullRequestDetail(sourceMerged, observedAt),
    );
    const config = await createTestConfig({
      explicitIncludes: [sourceMerged.url],
      retentionDays: 180,
      aiEnabled: true,
    });
    const harness = createCollectionHarness({
      repositories: [fixture],
      config,
      executeCodexAnalysis: executeSuccessfulCodexAnalysis,
      sleep: () => Promise.resolve(),
      enumerateGitHubItemsByIdentifiers: (input) => {
        if (input.identifiers.includes(tracked.url)) {
          fixture.details.set(
            tracked.nodeId,
            createIssueDetailWithInboundCrossReferences(tracked, [sourceMerged], observedAt),
          );
        }
        return Promise.resolve(
          Object.freeze(
            input.identifiers.map((identifier) => {
              if (identifier === sourceMerged.url) {
                return sourceMerged;
              }
              if (identifier === tracked.url) {
                return tracked;
              }
              throw new TypeError("merged PR fixtureの再取得対象が不正です");
            }),
          ),
        );
      },
    });

    const result = await harness.runCollectAnalyze(FIRST_RUN_AT);
    const artifact = requireCollectAnalyzeArtifact(harness.artifacts);
    const snapshot = artifact.snapshot;
    const sourceCache = artifact.cacheOnlyPayload.itemCaches.find(
      (document) => document.nodeId === sourceMerged.nodeId,
    );
    assertNonNullable(sourceCache, "merged PR fixtureのitem cacheがありません");

    expect(result.exitCode, JSON.stringify(result)).toBe(0);
    expect(harness.individualCalls).toEqual([[sourceMerged.url], [sourceMerged.url, tracked.url]]);
    expect(harness.sleepDelays).toEqual([2000]);
    expect(requireCollectionItem(snapshot, sourceMerged.nodeId).state).toBe("closed");
    expect(sourceCache.currentObservation.state).toBe("closed");
    expect(sourceCache.replay.currentState).toBe("merged");
  });

  it("全relation経路の複数repositoryの親detailをrepository単位で再取得する", async () => {
    const observedAt = createUtcIsoDateTime(FIRST_RUN_AT);
    const {
      fixture: sourceFixture,
      tracked,
      sourceOpen,
      sourceClosed,
    } = createRelationStateConflictIssueFixture(observedAt);
    const parentRepositoryRecord = createRepository(
      "R_relation_refresh_parent",
      "relation-refresh-parent",
      observedAt,
    );
    const parentRepository = requirePublicRepository(parentRepositoryRecord);
    const parentFixture = createRepositoryFixture(parentRepositoryRecord);
    const dependencyParent = createIssueItem({
      repository: parentRepository,
      number: 3,
      fingerprint: "relation-refresh-dependency-parent",
      updatedAt: observedAt,
      observedAt,
      state: Object.freeze({ state: "open" }),
    });
    const hierarchyParent = createIssueItem({
      repository: parentRepository,
      number: 4,
      fingerprint: "relation-refresh-hierarchy-parent",
      updatedAt: observedAt,
      observedAt,
      state: Object.freeze({ state: "open" }),
    });
    const closingParent = createPullRequestItem({
      repository: parentRepository,
      number: 5,
      fingerprint: "relation-refresh-closing-parent",
      updatedAt: observedAt,
      observedAt,
    });
    const hierarchyRelation = Object.freeze({
      sourceId: buildSourceId(
        "github_native_hierarchy",
        `${hierarchyParent.nodeId}:${sourceClosed.nodeId}`,
      ),
      authoritative: true,
      provenance: "native",
      relationship: "sub_issue",
      relatedItem: createReferencedItem(sourceClosed),
    } satisfies GitHubNativeHierarchy);
    const dependencyDetail = createIssueDetail({
      item: dependencyParent,
      body: "本文",
      observedAt,
      nativeDependencies: Object.freeze([createNativeBlocker(dependencyParent, sourceClosed)]),
      duplicateComments: false,
    });
    const hierarchyDetail = Object.freeze({
      ...createIssueDetail({
        item: hierarchyParent,
        body: "本文",
        observedAt,
        nativeDependencies: Object.freeze([]),
        duplicateComments: false,
      }),
      nativeHierarchy: Object.freeze({
        availability: "available",
        relations: Object.freeze([hierarchyRelation]),
      }),
    });
    const closingDetail = Object.freeze({
      ...createFailedCheckPullRequestDetail(closingParent, observedAt),
      nativeClosingIssues: Object.freeze([createNativeClosingIssue(closingParent, sourceClosed)]),
    });
    sourceFixture.openItems = [tracked, sourceOpen];
    sourceFixture.details.set(
      tracked.nodeId,
      createIssueDetailWithInboundCrossReferences(tracked, [sourceClosed], observedAt),
    );
    sourceFixture.details.set(
      sourceOpen.nodeId,
      createIssueDetail({
        item: sourceOpen,
        body: "本文",
        observedAt,
        nativeDependencies: Object.freeze([]),
        duplicateComments: false,
      }),
    );
    parentFixture.openItems = [dependencyParent, hierarchyParent, closingParent];
    parentFixture.details.set(dependencyParent.nodeId, dependencyDetail);
    parentFixture.details.set(hierarchyParent.nodeId, hierarchyDetail);
    parentFixture.details.set(closingParent.nodeId, closingDetail);
    const config = await createTestConfig({
      explicitIncludes: [],
      retentionDays: 180,
      aiEnabled: true,
    });
    const refreshedParents = [tracked, dependencyParent, hierarchyParent, closingParent];
    const harness = createCollectionHarness({
      repositories: [sourceFixture, parentFixture],
      config,
      executeCodexAnalysis: executeSuccessfulCodexAnalysis,
      sleep: () => Promise.resolve(),
      enumerateGitHubItemsByIdentifiers: (input) => {
        sourceFixture.details.set(
          tracked.nodeId,
          createIssueDetailWithInboundCrossReferences(tracked, [sourceOpen], observedAt),
        );
        parentFixture.details.set(
          dependencyParent.nodeId,
          createIssueDetail({
            item: dependencyParent,
            body: "本文",
            observedAt,
            nativeDependencies: Object.freeze([createNativeBlocker(dependencyParent, sourceOpen)]),
            duplicateComments: false,
          }),
        );
        parentFixture.details.set(
          hierarchyParent.nodeId,
          Object.freeze({
            ...hierarchyDetail,
            nativeHierarchy: Object.freeze({
              availability: "available",
              relations: Object.freeze([
                Object.freeze({
                  ...hierarchyRelation,
                  relatedItem: createReferencedItem(sourceOpen),
                }),
              ]),
            }),
          }),
        );
        parentFixture.details.set(
          closingParent.nodeId,
          Object.freeze({
            ...closingDetail,
            nativeClosingIssues: Object.freeze([
              createNativeClosingIssue(closingParent, sourceOpen),
            ]),
          }),
        );
        const refreshedByUrl = new Map<string, EnumeratedGitHubItem>([
          [sourceOpen.url, sourceOpen],
          ...refreshedParents.map((item): readonly [string, EnumeratedGitHubItem] => [
            item.url,
            item,
          ]),
        ]);
        return Promise.resolve(
          Object.freeze(
            input.identifiers.map((identifier) => {
              const item = refreshedByUrl.get(identifier);
              assertNonNullable(item, "全relation経路fixtureの再取得項目がありません");
              return item;
            }),
          ),
        );
      },
    });

    const result = await harness.runCollectAnalyze(FIRST_RUN_AT);
    const artifact = requireCollectAnalyzeArtifact(harness.artifacts);
    const snapshot = artifact.snapshot;
    const cacheCandidateStates = (nodeId: GitHubNodeId): readonly string[] => {
      const document = artifact.cacheOnlyPayload.itemCaches.find(
        (candidate) => candidate.nodeId === nodeId,
      );
      assertNonNullable(document, "全relation経路fixtureのitem cacheがありません");
      return document.relationCandidates
        .flatMap((candidate) => {
          switch (candidate.relation.type) {
            case "blocks":
              return [candidate.relation.blocker, candidate.relation.blocked];
            case "parent_of":
              return [candidate.relation.parent, candidate.relation.subtask];
            case "implements":
              return [candidate.relation.implementation, candidate.relation.target];
            case "unclassified":
              return [candidate.relation.referencing, candidate.relation.referenced];
          }
        })
        .filter((node) => node.nodeId === sourceOpen.nodeId)
        .map((node) => node.state);
    };

    expect(result.exitCode, JSON.stringify(result)).toBe(0);
    expect(harness.individualCalls).toEqual([
      [sourceOpen.url, tracked.url],
      [dependencyParent.url, hierarchyParent.url, closingParent.url],
    ]);
    expect(harness.sleepDelays).toEqual([2000]);
    expect(harness.detailCalls.slice(-2).flatMap((call) => call.targets)).toEqual(
      expect.arrayContaining(
        [sourceOpen, ...refreshedParents].map((item) => ({ nodeId: item.nodeId })),
      ),
    );
    for (const item of [sourceOpen, ...refreshedParents]) {
      expect(requireCollectionItem(snapshot, item.nodeId).state).toBe("open");
      const document = artifact.cacheOnlyPayload.itemCaches.find(
        (candidate) => candidate.nodeId === item.nodeId,
      );
      assertNonNullable(document, "全relation経路fixtureのcache文書がありません");
      expect(document.currentObservation.state).toBe("open");
      expect(document.replay.currentState).toBe("open");
      expect(cacheCandidateStates(item.nodeId)).toContain("open");
    }
  });

  it("relation expansion外側loopを跨ぐstate競合retryがrun全体上限で失敗する", async () => {
    const repository = createRepository(
      "R_relation_state_refresh_chain",
      "relation-state-refresh-chain",
      FIRST_RUN_AT,
    );
    const publicRepository = requirePublicRepository(repository);
    const fixture = createRepositoryFixture(repository);
    const observedAt = createUtcIsoDateTime(FIRST_RUN_AT);
    const tracked = createIssueItem({
      repository: publicRepository,
      number: 1,
      fingerprint: "tracked-state-refresh-chain",
      updatedAt: observedAt,
      observedAt,
      state: Object.freeze({ state: "open" }),
    });
    const sourceOpenItems = [
      createIssueItem({
        repository: publicRepository,
        number: 2,
        fingerprint: "source-state-refresh-chain-open-one",
        updatedAt: observedAt,
        observedAt,
        state: Object.freeze({ state: "open" }),
      }),
      createIssueItem({
        repository: publicRepository,
        number: 3,
        fingerprint: "source-state-refresh-chain-open-two",
        updatedAt: observedAt,
        observedAt,
        state: Object.freeze({ state: "open" }),
      }),
      createIssueItem({
        repository: publicRepository,
        number: 4,
        fingerprint: "source-state-refresh-chain-open-three",
        updatedAt: observedAt,
        observedAt,
        state: Object.freeze({ state: "open" }),
      }),
    ];
    const sourceClosedItems = [
      createIssueItem({
        repository: publicRepository,
        number: 2,
        fingerprint: "source-state-refresh-chain-closed-one",
        updatedAt: observedAt,
        observedAt,
        state: Object.freeze({ state: "closed", closedAt: observedAt }),
      }),
      createIssueItem({
        repository: publicRepository,
        number: 3,
        fingerprint: "source-state-refresh-chain-closed-two",
        updatedAt: observedAt,
        observedAt,
        state: Object.freeze({ state: "closed", closedAt: observedAt }),
      }),
      createIssueItem({
        repository: publicRepository,
        number: 4,
        fingerprint: "source-state-refresh-chain-closed-three",
        updatedAt: observedAt,
        observedAt,
        state: Object.freeze({ state: "closed", closedAt: observedAt }),
      }),
    ];
    const sourceOpenOne = sourceOpenItems[0];
    const sourceOpenTwo = sourceOpenItems[1];
    const sourceOpenThree = sourceOpenItems[2];
    const sourceClosedOne = sourceClosedItems[0];
    assertNonNullable(sourceOpenOne, "relation expansion chainの1件目がありません");
    assertNonNullable(sourceOpenTwo, "relation expansion chainの2件目がありません");
    assertNonNullable(sourceOpenThree, "relation expansion chainの3件目がありません");
    assertNonNullable(sourceClosedOne, "relation expansion chainのclosed 1件目がありません");
    fixture.openItems = [tracked];
    fixture.details.set(
      tracked.nodeId,
      createIssueDetailWithInboundCrossReferences(tracked, [sourceClosedOne], observedAt),
    );
    let relationExpansionCount = 0;
    let refreshCount = 0;
    const config = await createTestConfig({
      explicitIncludes: [],
      retentionDays: 180,
      aiEnabled: false,
    });
    const harness = createCollectionHarness({
      repositories: [fixture],
      config,
      sleep: () => Promise.resolve(),
      enumerateGitHubItemsByIdentifiers: (input) => {
        if (input.identifiers.length === 1) {
          const sourceIndex = sourceOpenItems.findIndex(
            (item) => item.url === input.identifiers[0],
          );
          const source = sourceOpenItems[sourceIndex];
          assertNonNullable(source, "relation expansion chainの対象がありません");
          relationExpansionCount += 1;
          fixture.details.set(
            source.nodeId,
            createIssueDetail({
              item: source,
              body: "本文",
              observedAt,
              nativeDependencies: Object.freeze([]),
              duplicateComments: false,
            }),
          );
          return Promise.resolve(Object.freeze([source]));
        }
        refreshCount += 1;
        const source = sourceClosedItems[refreshCount - 1];
        assertNonNullable(source, "relation expansion chainのrefresh対象がありません");
        const nextClosed = sourceClosedItems[refreshCount];
        assertNonNullable(nextClosed, "relation expansion chainの次のclosed対象がありません");
        fixture.details.set(
          tracked.nodeId,
          createIssueDetailWithInboundCrossReferences(
            tracked,
            Object.freeze([source, nextClosed]),
            observedAt,
          ),
        );
        fixture.details.set(
          source.nodeId,
          createIssueDetail({
            item: source,
            body: "本文",
            observedAt,
            nativeDependencies: Object.freeze([]),
            duplicateComments: false,
          }),
        );
        return Promise.resolve(
          Object.freeze(
            input.identifiers.map((identifier) => {
              if (identifier === source.url) {
                return source;
              }
              if (identifier === tracked.url) {
                return tracked;
              }
              throw new TypeError("relation expansion chainの再取得識別子が不正です");
            }),
          ),
        );
      },
    });

    const result = await harness.runCollectAnalyze(FIRST_RUN_AT);

    expect(result.exitCode).toBe(1);
    expect(relationExpansionCount).toBe(3);
    expect(refreshCount).toBe(2);
    expect(harness.individualCalls).toEqual([
      [sourceOpenOne.url],
      [sourceOpenOne.url, tracked.url],
      [sourceOpenTwo.url],
      [sourceOpenTwo.url, tracked.url],
      [sourceOpenThree.url],
    ]);
    expect(harness.sleepDelays).toEqual([2000, 4000]);
    if (result.command !== "collect-analyze") {
      throw new TypeError("relation expansion chain fixtureがcollect-analyze結果ではありません");
    }
    expect(result.result.report).toMatchObject({
      status: "failure",
      failedStage: "incremental_collection",
      complete: false,
    });
    expect(result.result.report.diagnostics.join(" ")).toContain(
      "errorType=RelationReferenceConflictError",
    );
  });

  it("state競合の再取得でAPI予算エラーを再試行しない", async () => {
    const observedAt = createUtcIsoDateTime(FIRST_RUN_AT);
    const { fixture, tracked, sourceOpen } = createRelationStateConflictIssueFixture(observedAt);
    const config = await createTestConfig({
      explicitIncludes: [],
      retentionDays: 180,
      aiEnabled: false,
    });
    const budgetError = new GitHubApiBudgetExceededError({
      source: "rest",
      limit: 5000,
      remaining: 1,
      resetAt: observedAt,
      observedAt,
      resource: "core",
    });
    const harness = createCollectionHarness({
      repositories: [fixture],
      config,
      sleep: () => Promise.resolve(),
      enumerateGitHubItemsByIdentifiers: () => Promise.reject(budgetError),
    });

    const result = await harness.runCollectAnalyze(FIRST_RUN_AT);

    expect(result.exitCode).toBe(1);
    expect(harness.individualCalls).toEqual([[sourceOpen.url, tracked.url]]);
    expect(harness.sleepDelays).toEqual([2000]);
    if (result.command !== "collect-analyze") {
      throw new TypeError("API予算エラーfixtureがcollect-analyze結果ではありません");
    }
    expect(result.result.report.diagnostics.join(" ")).toContain("GitHubApiBudgetExceededError");
  });

  it("state競合の再取得でGitHub schemaエラーを再試行しない", async () => {
    const observedAt = createUtcIsoDateTime(FIRST_RUN_AT);
    const { fixture, tracked, sourceOpen } = createRelationStateConflictIssueFixture(observedAt);
    const config = await createTestConfig({
      explicitIncludes: [],
      retentionDays: 180,
      aiEnabled: false,
    });
    const parseResult = z.object({ expected: z.string() }).safeParse({});
    if (parseResult.success) {
      throw new TypeError("schemaエラーfixtureを作成できません");
    }
    const schemaError = new GitHubResponseSchemaValidationError(
      "関係参照state再取得fixture",
      parseResult.error,
    );
    const harness = createCollectionHarness({
      repositories: [fixture],
      config,
      sleep: () => Promise.resolve(),
      enumerateGitHubItemsByIdentifiers: () => Promise.reject(schemaError),
    });

    const result = await harness.runCollectAnalyze(FIRST_RUN_AT);

    expect(result.exitCode).toBe(1);
    expect(harness.individualCalls).toEqual([[sourceOpen.url, tracked.url]]);
    expect(harness.sleepDelays).toEqual([2000]);
    if (result.command !== "collect-analyze") {
      throw new TypeError("schemaエラーfixtureがcollect-analyze結果ではありません");
    }
    expect(result.result.report.diagnostics.join(" ")).toContain(
      "GitHubResponseSchemaValidationError",
    );
  });

  it("state競合の再取得結果の件数とidentity不一致をcause付きで失敗させる", async () => {
    type MismatchKind =
      "count" | "duplicateNodeId" | "repositoryId" | "nodeId" | "number" | "type" | "url";
    const mismatchKinds: readonly MismatchKind[] = [
      "count",
      "duplicateNodeId",
      "repositoryId",
      "nodeId",
      "number",
      "type",
      "url",
    ];
    for (const mismatchKind of mismatchKinds) {
      const observedAt = createUtcIsoDateTime(FIRST_RUN_AT);
      const { fixture, tracked, sourceOpen } = createRelationStateConflictIssueFixture(observedAt);
      const config = await createTestConfig({
        explicitIncludes: [],
        retentionDays: 180,
        aiEnabled: false,
      });
      const wrongRepository = requirePublicRepository(
        createRepository("R_wrong_relation_identity", "wrong-relation-identity", observedAt),
      );
      const harness = createCollectionHarness({
        repositories: [fixture],
        config,
        sleep: () => Promise.resolve(),
        enumerateGitHubItemsByIdentifiers: (input) => {
          if (mismatchKind === "count") {
            return Promise.resolve(Object.freeze([]));
          }
          const refreshed = (() => {
            switch (mismatchKind) {
              case "duplicateNodeId":
                return sourceOpen;
              case "repositoryId":
                return Object.freeze({
                  ...sourceOpen,
                  repositoryId: wrongRepository.id,
                });
              case "nodeId":
                return Object.freeze({
                  ...sourceOpen,
                  nodeId: createGitHubNodeId("wrong-node"),
                });
              case "number":
                return Object.freeze({ ...sourceOpen, number: sourceOpen.number + 1 });
              case "type":
                if (sourceOpen.type !== "issue") {
                  throw new TypeError("identity fixtureのsourceがIssueではありません");
                }
                return Object.freeze({
                  ...sourceOpen,
                  type: "pull_request",
                  draft: false,
                  mergeStatus: "not_merged",
                }) satisfies EnumeratedGitHubItem;
              case "url":
                return Object.freeze({
                  ...sourceOpen,
                  url: `${sourceOpen.url}/mismatch` satisfies GitHubItemUrl,
                });
            }
          })();
          return Promise.resolve(
            Object.freeze(
              input.identifiers.map((identifier) => {
                if (mismatchKind === "duplicateNodeId") {
                  return sourceOpen;
                }
                return identifier === sourceOpen.url ? refreshed : tracked;
              }),
            ),
          );
        },
      });

      const result = await harness.runCollectAnalyze(FIRST_RUN_AT);

      expect(result.exitCode, mismatchKind).toBe(1);
      expect(harness.individualCalls, mismatchKind).toEqual([[sourceOpen.url, tracked.url]]);
      expect(harness.sleepDelays, mismatchKind).toEqual([2000]);
      if (result.command !== "collect-analyze") {
        throw new TypeError("identity不一致fixtureがcollect-analyze結果ではありません");
      }
      expect(result.result.report).toMatchObject({
        status: "failure",
        failedStage: "incremental_collection",
        complete: false,
      });
      expect(result.result.report.diagnostics.join(" ")).toContain(
        "errorType=TypeError<-RelationReferenceConflictError",
      );
    }
  });

  it("state競合の親detail再取得エラーを変換せず伝播する", async () => {
    const observedAt = createUtcIsoDateTime(FIRST_RUN_AT);
    const { fixture, tracked, sourceOpen } = createRelationStateConflictIssueFixture(observedAt);
    const config = await createTestConfig({
      explicitIncludes: [],
      retentionDays: 180,
      aiEnabled: false,
    });
    let detailCallCount = 0;
    const detailError = new TypeError("関係参照親detail取得fixtureの失敗");
    const harness = createCollectionHarness({
      repositories: [fixture],
      config,
      sleep: () => Promise.resolve(),
      collectGitHubItemDetails: (input) => {
        detailCallCount += 1;
        if (detailCallCount === 2) {
          throw detailError;
        }
        return Promise.resolve(
          Object.freeze({
            capabilities: Object.freeze({
              nativeDependencies: "available",
              nativeHierarchy: "available",
            }),
            items: Object.freeze(
              input.targets.map((target) => {
                const detail = fixture.details.get(target.item.nodeId);
                assertNonNullable(detail, "detailエラーfixtureの詳細がありません");
                return detail;
              }),
            ),
          }),
        );
      },
      enumerateGitHubItemsByIdentifiers: (input) =>
        Promise.resolve(
          Object.freeze(
            input.identifiers.map((identifier) => {
              if (identifier === sourceOpen.url) {
                return sourceOpen;
              }
              if (identifier === tracked.url) {
                return tracked;
              }
              throw new TypeError("detailエラーfixtureの再取得対象が不正です");
            }),
          ),
        ),
    });

    const result = await harness.runCollectAnalyze(FIRST_RUN_AT);

    expect(result.exitCode).toBe(1);
    expect(detailCallCount).toBe(2);
    expect(harness.individualCalls).toEqual([[sourceOpen.url, tracked.url]]);
    expect(harness.sleepDelays).toEqual([2000]);
    if (result.command !== "collect-analyze") {
      throw new TypeError("detailエラーfixtureがcollect-analyze結果ではありません");
    }
    expect(result.result.report.diagnostics.join(" ")).toContain("errorType=TypeError");
    expect(result.result.report.diagnostics.join(" ")).not.toContain("TypeError<-");
  });

  it("state競合のPull Request volatile probeエラーを変換せず伝播する", async () => {
    const repository = createRepository(
      "R_relation_probe_error",
      "relation-probe-error",
      FIRST_RUN_AT,
    );
    const publicRepository = requirePublicRepository(repository);
    const fixture = createRepositoryFixture(repository);
    const observedAt = createUtcIsoDateTime(FIRST_RUN_AT);
    const tracked = createIssueItem({
      repository: publicRepository,
      number: 1,
      fingerprint: "tracked-probe-error",
      updatedAt: observedAt,
      observedAt,
      state: Object.freeze({ state: "open" }),
    });
    const sourceOpen = createPullRequestItem({
      repository: publicRepository,
      number: 2,
      fingerprint: "source-probe-error-open",
      updatedAt: observedAt,
      observedAt,
    });
    const sourceMerged = createMergedPullRequestItem({
      repository: publicRepository,
      number: 2,
      fingerprint: "source-probe-error-merged",
      closedAt: observedAt,
      mergedAt: observedAt,
      observedAt,
    });
    fixture.openItems = [tracked, sourceOpen];
    fixture.details.set(
      tracked.nodeId,
      createIssueDetailWithInboundCrossReferences(tracked, [sourceMerged], observedAt),
    );
    fixture.details.set(
      sourceOpen.nodeId,
      createFailedCheckPullRequestDetail(sourceOpen, observedAt),
    );
    const config = await createTestConfig({
      explicitIncludes: [],
      retentionDays: 180,
      aiEnabled: false,
    });
    let probeCallCount = 0;
    const probeError = new TypeError("関係参照volatile probe取得fixtureの失敗");
    const mergedSourceDetail = createFailedCheckPullRequestDetail(sourceMerged, observedAt);
    const harness = createCollectionHarness({
      repositories: [fixture],
      config,
      sleep: () => Promise.resolve(),
      enumerateGitHubItemsByIdentifiers: (input) => {
        fixture.details.set(sourceOpen.nodeId, mergedSourceDetail);
        return Promise.resolve(
          Object.freeze(
            input.identifiers.map((identifier) => {
              if (identifier === sourceOpen.url) {
                return sourceMerged;
              }
              if (identifier === tracked.url) {
                return tracked;
              }
              throw new TypeError("probeエラーfixtureの再取得対象が不正です");
            }),
          ),
        );
      },
      probeGitHubPullRequestVolatileMetadataWithRetry: async (input) => {
        probeCallCount += 1;
        if (probeCallCount === 2) {
          throw probeError;
        }
        const metadata = input.pullRequestNodeIds.map((nodeId) => {
          const detail = fixture.details.get(nodeId);
          assertNonNullable(detail, "probeエラーfixtureの詳細がありません");
          if (detail.type !== "pull_request") {
            throw new TypeError("probeエラーfixtureのdetail種別が不正です");
          }
          return createGitHubPullRequestVolatileMetadataFromDetail(detail);
        });
        const collection = Object.freeze({ items: Object.freeze(metadata) });
        await input.validateDetail?.(collection);
        return collection;
      },
    });

    const result = await harness.runCollectAnalyze(FIRST_RUN_AT);

    expect(result.exitCode).toBe(1);
    expect(probeCallCount).toBe(2);
    expect(harness.individualCalls).toEqual([[sourceOpen.url, tracked.url]]);
    expect(harness.sleepDelays).toEqual([2000]);
    if (result.command !== "collect-analyze") {
      throw new TypeError("probeエラーfixtureがcollect-analyze結果ではありません");
    }
    expect(result.result.report.diagnostics.join(" ")).toContain("errorType=TypeError");
    expect(result.result.report.diagnostics.join(" ")).not.toContain("TypeError<-");
  });

  it("state以外の関係参照競合は再取得せず失敗させる", async () => {
    const observedAt = createUtcIsoDateTime(FIRST_RUN_AT);
    const { fixture, tracked } = createRelationStateConflictIssueFixture(observedAt);
    const trackedDetail = fixture.details.get(tracked.nodeId);
    assertNonNullable(trackedDetail, "identity競合fixtureのtracked詳細がありません");
    const reference = trackedDetail.inboundCrossReferences[0];
    assertNonNullable(reference, "identity競合fixtureの参照がありません");
    fixture.details.set(
      tracked.nodeId,
      Object.freeze({
        ...trackedDetail,
        inboundCrossReferences: Object.freeze([
          Object.freeze({
            ...reference,
            sourceItem: Object.freeze({
              ...reference.sourceItem,
              repositoryArchived: true,
            }),
          }),
        ]),
      }),
    );
    const config = await createTestConfig({
      explicitIncludes: [],
      retentionDays: 180,
      aiEnabled: false,
    });
    let refreshCount = 0;
    const harness = createCollectionHarness({
      repositories: [fixture],
      config,
      sleep: () => Promise.resolve(),
      enumerateGitHubItemsByIdentifiers: () => {
        refreshCount += 1;
        throw new TypeError("identity競合fixtureの再取得は呼ばれません");
      },
    });

    const result = await harness.runCollectAnalyze(FIRST_RUN_AT);

    expect(result.exitCode).toBe(1);
    expect(refreshCount).toBe(0);
    expect(harness.individualCalls).toEqual([]);
    expect(harness.sleepDelays).toEqual([]);
    if (result.command !== "collect-analyze") {
      throw new TypeError("identity競合fixtureがcollect-analyze結果ではありません");
    }
    expect(result.result.report.diagnostics.join(" ")).toContain("RelationReferenceConflictError");
  });

  it("後続detailで判明するnative chainを深度3まで取得して深度4を取得しない", async () => {
    const repository = createRepository(
      "R_relation_expansion_depth",
      "relation-expansion-depth",
      FIRST_RUN_AT,
    );
    const publicRepository = requirePublicRepository(repository);
    const fixture = createRepositoryFixture(repository);
    const observedAt = createUtcIsoDateTime(FIRST_RUN_AT);
    const tracked = createIssueItem({
      repository: publicRepository,
      number: 1,
      fingerprint: "tracked-depth",
      updatedAt: observedAt,
      observedAt,
      state: Object.freeze({ state: "open" }),
    });
    const depthOne = createOldIssueItem(publicRepository, 2, "depth-one", observedAt);
    const depthTwo = createOldIssueItem(publicRepository, 3, "depth-two", observedAt);
    const depthThree = createOldIssueItem(publicRepository, 4, "depth-three", observedAt);
    const depthFour = createOldIssueItem(publicRepository, 5, "depth-four", observedAt);
    fixture.openItems = [tracked];
    for (const item of [depthOne, depthTwo, depthThree, depthFour]) {
      fixture.individualItems.set(item.nodeId, item);
    }
    setIssueDetails(fixture, [tracked, depthOne, depthTwo, depthThree, depthFour], observedAt);
    fixture.details.set(
      tracked.nodeId,
      createIssueDetail({
        item: tracked,
        body: "本文",
        observedAt,
        nativeDependencies: Object.freeze([createNativeBlocker(tracked, depthOne)]),
        duplicateComments: false,
      }),
    );
    fixture.details.set(
      depthOne.nodeId,
      createIssueDetail({
        item: depthOne,
        body: "本文",
        observedAt,
        nativeDependencies: Object.freeze([createNativeBlocker(depthOne, depthTwo)]),
        duplicateComments: false,
      }),
    );
    fixture.details.set(
      depthTwo.nodeId,
      createIssueDetail({
        item: depthTwo,
        body: "本文",
        observedAt,
        nativeDependencies: Object.freeze([createNativeBlocker(depthTwo, depthThree)]),
        duplicateComments: false,
      }),
    );
    fixture.details.set(
      depthThree.nodeId,
      createIssueDetail({
        item: depthThree,
        body: "本文",
        observedAt,
        nativeDependencies: Object.freeze([createNativeBlocker(depthThree, depthFour)]),
        duplicateComments: false,
      }),
    );
    const config = await createTestConfig({
      explicitIncludes: [],
      retentionDays: 180,
      aiEnabled: false,
    });
    const harness = createCollectionHarness({ repositories: [fixture], config });

    const result = await harness.runDry(FIRST_RUN_AT);
    const snapshot = requireDryRunSnapshot(harness.artifacts);

    expect(result.exitCode).toBe(0);
    expect(harness.individualCalls).toEqual([[depthOne.url], [depthTwo.url], [depthThree.url]]);
    expect(snapshot.items.map((item) => item.nodeId)).toEqual(
      expect.arrayContaining([tracked.nodeId, depthOne.nodeId, depthTwo.nodeId, depthThree.nodeId]),
    );
    expect(snapshot.items.map((item) => item.nodeId)).not.toContain(depthFour.nodeId);
    expect(
      snapshot.collection.repositories.flatMap((current) =>
        current.items.map((item) => item.nodeId),
      ),
    ).not.toContain(depthFour.nodeId);
  });

  it("nativeの循環とfan-inでも各nodeを一度だけ個別取得する", async () => {
    const repository = createRepository(
      "R_relation_expansion_cycle",
      "relation-expansion-cycle",
      FIRST_RUN_AT,
    );
    const publicRepository = requirePublicRepository(repository);
    const fixture = createRepositoryFixture(repository);
    const observedAt = createUtcIsoDateTime(FIRST_RUN_AT);
    const tracked = createIssueItem({
      repository: publicRepository,
      number: 1,
      fingerprint: "tracked-cycle",
      updatedAt: observedAt,
      observedAt,
      state: Object.freeze({ state: "open" }),
    });
    const first = createOldIssueItem(publicRepository, 2, "cycle-first", observedAt);
    const second = createOldIssueItem(publicRepository, 3, "cycle-second", observedAt);
    const shared = createOldIssueItem(publicRepository, 4, "cycle-shared", observedAt);
    fixture.openItems = [tracked];
    for (const item of [first, second, shared]) {
      fixture.individualItems.set(item.nodeId, item);
    }
    setIssueDetails(fixture, [tracked, first, second, shared], observedAt);
    fixture.details.set(
      tracked.nodeId,
      createIssueDetail({
        item: tracked,
        body: "本文",
        observedAt,
        nativeDependencies: Object.freeze([
          createNativeBlocker(tracked, first),
          createNativeBlocker(tracked, second),
        ]),
        duplicateComments: false,
      }),
    );
    fixture.details.set(
      first.nodeId,
      createIssueDetail({
        item: first,
        body: "本文",
        observedAt,
        nativeDependencies: Object.freeze([createNativeBlocker(first, shared)]),
        duplicateComments: false,
      }),
    );
    fixture.details.set(
      second.nodeId,
      createIssueDetail({
        item: second,
        body: "本文",
        observedAt,
        nativeDependencies: Object.freeze([createNativeBlocker(second, shared)]),
        duplicateComments: false,
      }),
    );
    fixture.details.set(
      shared.nodeId,
      createIssueDetail({
        item: shared,
        body: "本文",
        observedAt,
        nativeDependencies: Object.freeze([createNativeBlocker(shared, tracked)]),
        duplicateComments: false,
      }),
    );
    const config = await createTestConfig({
      explicitIncludes: [],
      retentionDays: 180,
      aiEnabled: false,
    });
    const harness = createCollectionHarness({ repositories: [fixture], config });

    const result = await harness.runDry(FIRST_RUN_AT);
    const requestedUrls = harness.individualCalls.flat();

    expect(result.exitCode).toBe(0);
    expect(harness.individualCalls).toEqual([[first.url, second.url], [shared.url]]);
    expect(requestedUrls).toHaveLength(3);
    expect(new Set(requestedUrls).size).toBe(3);
  });

  it("参照系の連鎖を追跡根から1 hopで止めて2 hop目を取得しない", async () => {
    const repository = createRepository(
      "R_relation_expansion_reference_depth",
      "relation-expansion-reference-depth",
      FIRST_RUN_AT,
    );
    const publicRepository = requirePublicRepository(repository);
    const fixture = createRepositoryFixture(repository);
    const observedAt = createUtcIsoDateTime(FIRST_RUN_AT);
    const tracked = createIssueItem({
      repository: publicRepository,
      number: 1,
      fingerprint: "tracked-reference-depth",
      updatedAt: observedAt,
      observedAt,
      state: Object.freeze({ state: "open" }),
    });
    const firstSource = createOldIssueItem(publicRepository, 2, "reference-depth-one", observedAt);
    const secondSource = createOldIssueItem(publicRepository, 3, "reference-depth-two", observedAt);
    fixture.openItems = [tracked];
    fixture.individualItems.set(firstSource.nodeId, firstSource);
    fixture.individualItems.set(secondSource.nodeId, secondSource);
    setIssueDetails(fixture, [tracked, firstSource, secondSource], observedAt);
    fixture.details.set(
      tracked.nodeId,
      createIssueDetailWithInboundCrossReferences(tracked, [firstSource], observedAt),
    );
    fixture.details.set(
      firstSource.nodeId,
      createIssueDetailWithInboundCrossReferences(firstSource, [secondSource], observedAt),
    );
    const config = await createTestConfig({
      explicitIncludes: [],
      retentionDays: 180,
      aiEnabled: true,
    });
    const harness = createCollectionHarness({
      repositories: [fixture],
      config,
      executeCodexAnalysis: executeSuccessfulCodexAnalysis,
    });

    const result = await harness.runDry(FIRST_RUN_AT);
    const snapshot = requireDryRunSnapshot(harness.artifacts);

    expect(result.exitCode).toBe(0);
    expect(harness.individualCalls).toEqual([[firstSource.url]]);
    expect(snapshot.items.map((item) => item.nodeId)).toContain(firstSource.nodeId);
    expect(snapshot.items.map((item) => item.nodeId)).not.toContain(secondSource.nodeId);
  });

  it("関係先展開上限に到達したrunでcacheとPagesと通常Discord通知を変更しない", async () => {
    const repository = createRepository(
      "R_relation_expansion_limit",
      "relation-expansion-limit",
      FIRST_RUN_AT,
    );
    const publicRepository = requirePublicRepository(repository);
    const fixture = createRepositoryFixture(repository);
    const firstObservedAt = createUtcIsoDateTime(FIRST_RUN_AT);
    const firstTracked = createIssueItem({
      repository: publicRepository,
      number: 1,
      fingerprint: "limit-v1",
      updatedAt: firstObservedAt,
      observedAt: firstObservedAt,
      state: Object.freeze({ state: "open" }),
    });
    fixture.openItems = [firstTracked];
    setIssueDetails(fixture, [firstTracked], firstObservedAt);
    const baseConfig = await createTestConfig({
      explicitIncludes: [],
      retentionDays: 180,
      aiEnabled: false,
    });
    const config = configWithRelationExpansionLimit(baseConfig, 1);
    const harness = createCollectionHarness({ repositories: [fixture], config });

    const firstResult = await harness.runDaily(FIRST_RUN_AT);
    expect(firstResult.exitCode).toBe(0);
    const stateBefore = new Map(await harness.stateAdapter.readBranchFiles("tracker-state-v3"));
    const publicDataCountBefore = harness.publicData.length;
    const normalDiscordCallCountBefore = harness.normalDiscordCallCount();
    harness.individualCalls.length = 0;

    const secondObservedAt = createUtcIsoDateTime(SECOND_RUN_AT);
    const secondTracked = createIssueItem({
      repository: publicRepository,
      number: 1,
      fingerprint: "limit-v2",
      updatedAt: secondObservedAt,
      observedAt: secondObservedAt,
      state: Object.freeze({ state: "open" }),
    });
    const firstTarget = createOldIssueItem(
      publicRepository,
      2,
      "limit-first-target",
      secondObservedAt,
    );
    const secondTarget = createOldIssueItem(
      publicRepository,
      3,
      "limit-second-target",
      secondObservedAt,
    );
    fixture.openItems = [secondTracked];
    fixture.individualItems.set(firstTarget.nodeId, firstTarget);
    fixture.individualItems.set(secondTarget.nodeId, secondTarget);
    setIssueDetails(fixture, [secondTracked, firstTarget, secondTarget], secondObservedAt);
    fixture.details.set(
      secondTracked.nodeId,
      createIssueDetail({
        item: secondTracked,
        body: "本文",
        observedAt: secondObservedAt,
        nativeDependencies: Object.freeze([
          createNativeBlocker(secondTracked, firstTarget),
          createNativeBlocker(secondTracked, secondTarget),
        ]),
        duplicateComments: false,
      }),
    );

    const secondResult = await harness.runDaily(SECOND_RUN_AT);
    const stateAfter = await harness.stateAdapter.readBranchFiles("tracker-state-v3");
    if (secondResult.command !== "daily") {
      throw new TypeError("関係先展開上限fixtureがdaily結果ではありません");
    }

    expect(secondResult.exitCode).toBe(1);
    expect(secondResult.result.report).toMatchObject({
      status: "failure",
      failedStage: "incremental_collection",
      complete: false,
    });
    expect(secondResult.result.report.diagnostics).toContainEqual(
      expect.stringContaining(
        "relationExpansionLimit=1 relationExpansionFetchedCount=0 relationExpansionUnfetchedCount=2",
      ),
    );
    expect(secondResult.result.effects).toEqual({
      cacheCommitted: false,
      pagesBuilt: false,
      discordAttempted: true,
      artifactWritten: false,
    });
    expect(harness.individualCalls).toEqual([]);
    expect(stateAfter).toEqual(stateBefore);
    expect(harness.publicData).toHaveLength(publicDataCountBefore);
    expect(harness.normalDiscordCallCount()).toBe(normalDiscordCallCountBefore);
    expect(harness.operationsDiscordCallCount()).toBe(1);
  });

  it("最終状態で未取得端点を持つ関係候補の件数をdiagnosticへ出す", async () => {
    const result = await collectRelationCandidateDiagnostics("unavailable");

    expect(result.diagnostics).toContain("端点を取得できなかった関係候補を1件除外しました");
  });

  it("反復中に未完成だった関係候補が解決されればdiagnosticを出さない", async () => {
    const result = await collectRelationCandidateDiagnostics("resolved");

    expect(
      result.diagnostics.filter((diagnostic) =>
        diagnostic.startsWith("端点を取得できなかった関係候補を"),
      ),
    ).toEqual([]);
  });

  it("落とした関係候補のdiagnosticへ識別子や入力内容を出さない", async () => {
    const result = await collectRelationCandidateDiagnostics("unavailable");
    const diagnostic = result.diagnostics.find((candidate) =>
      candidate.startsWith("端点を取得できなかった関係候補を"),
    );
    if (diagnostic == null) {
      throw new TypeError("落とした関係候補のdiagnosticがありません");
    }

    for (const identifier of result.identifierCanaries) {
      expect(diagnostic).not.toContain(identifier);
    }
  });

  it("詳細取得済み項目の活動時刻を作れないrunは失敗する", async () => {
    const repository = createRepository("R_invalid_activity", "invalid-activity", FIRST_RUN_AT);
    const publicRepository = requirePublicRepository(repository);
    const fixture = createRepositoryFixture(repository);
    const observedAt = createUtcIsoDateTime(FIRST_RUN_AT);
    const item = replaceCreatedAt(
      createIssueItem({
        repository: publicRepository,
        number: 1,
        fingerprint: "invalid-activity",
        updatedAt: observedAt,
        observedAt,
        state: Object.freeze({ state: "open" }),
      }),
      createUtcIsoDateTime(SECOND_RUN_AT),
    );
    fixture.openItems = [item];
    setIssueDetails(fixture, [item], observedAt);
    const config = await createTestConfig({
      explicitIncludes: [],
      retentionDays: 180,
      aiEnabled: false,
    });
    const harness = createCollectionHarness({ repositories: [fixture], config });

    const result = await harness.runDaily(FIRST_RUN_AT);
    if (result.command !== "daily") {
      throw new TypeError("活動時刻fixtureがdaily結果ではありません");
    }

    expect(result.exitCode).toBe(1);
    expect(harness.detailCalls).toHaveLength(1);
    expect(result.result.report).toMatchObject({
      status: "failure",
      failedStage: "incremental_collection",
    });
  });

  it("判定規則変更項目と初回判定のupdated_at変更項目を全履歴で収集する", async () => {
    const repository = createRepository("R_mixed_windows", "mixed-windows", FIRST_RUN_AT);
    const publicRepository = requirePublicRepository(repository);
    const fixture = createRepositoryFixture(repository);
    const firstObservedAt = createUtcIsoDateTime(FIRST_RUN_AT);
    const firstTracked = createIssueItem({
      repository: publicRepository,
      number: 1,
      fingerprint: "tracked-v1",
      updatedAt: firstObservedAt,
      observedAt: firstObservedAt,
      state: Object.freeze({ state: "open" }),
    });
    const firstUntracked = createOldIssueItem(publicRepository, 2, "untracked-v1", firstObservedAt);
    fixture.openItems = [firstTracked, firstUntracked];
    setIssueDetails(fixture, fixture.openItems, firstObservedAt);
    const config = await createTestConfig({
      explicitIncludes: [],
      retentionDays: 180,
      aiEnabled: false,
    });
    const harness = createCollectionHarness({ repositories: [fixture], config });

    expect((await harness.runDaily(FIRST_RUN_AT)).exitCode).toBe(0);
    harness.detailCalls.length = 0;
    const secondObservedAt = createUtcIsoDateTime(SECOND_RUN_AT);
    const secondTracked = createIssueItem({
      repository: publicRepository,
      number: 1,
      fingerprint: "tracked-v1",
      updatedAt: firstObservedAt,
      observedAt: secondObservedAt,
      state: Object.freeze({ state: "open" }),
    });
    const secondUntracked = replaceCreatedAt(
      createIssueItem({
        repository: publicRepository,
        number: 2,
        fingerprint: "untracked-v2",
        updatedAt: secondObservedAt,
        observedAt: secondObservedAt,
        state: Object.freeze({ state: "open" }),
      }),
      createUtcIsoDateTime(OLD_ITEM_AT),
    );
    fixture.openItems = [secondTracked, secondUntracked];
    setIssueDetails(fixture, fixture.openItems, secondObservedAt);
    harness.setConfig(
      Object.freeze({
        ...config,
        ai: Object.freeze({
          ...config.ai,
          promptVersion: "mixed-windows-v2",
        }),
      }),
    );

    const result = await harness.runDry(SECOND_RUN_AT);

    expect(result.exitCode).toBe(0);
    expect(harness.detailCalls).toEqual([
      {
        targets: [
          {
            nodeId: secondTracked.nodeId,
          },
          {
            nodeId: secondUntracked.nodeId,
          },
        ],
      },
    ]);
  });

  it("503のrepository項目を表示へ保持してfresh判定と通知から除外する", async () => {
    const firstRepository = createRepository("R_fresh", "fresh", FIRST_RUN_AT);
    const secondRepository = createRepository("R_stale", "stale", FIRST_RUN_AT);
    const firstFixture = createRepositoryFixture(firstRepository);
    const secondFixture = createRepositoryFixture(secondRepository);
    const observedAt = createUtcIsoDateTime(FIRST_RUN_AT);
    const firstItem = createIssueItem({
      repository: requirePublicRepository(firstRepository),
      number: 1,
      fingerprint: "fresh-v1",
      updatedAt: observedAt,
      observedAt,
      state: Object.freeze({ state: "open" }),
    });
    const secondItem = Object.freeze({
      ...createIssueItem({
        repository: requirePublicRepository(secondRepository),
        number: 1,
        fingerprint: "stale-v1",
        updatedAt: observedAt,
        observedAt,
        state: Object.freeze({ state: "open" }),
      }),
      labels: Object.freeze(["優先度：高"]),
    });
    firstFixture.openItems = [firstItem];
    secondFixture.openItems = [secondItem];
    setIssueDetails(firstFixture, [firstItem], observedAt);
    setIssueDetails(secondFixture, [secondItem], observedAt);
    secondFixture.details.set(
      secondItem.nodeId,
      createIssueDetail({
        item: secondItem,
        body: "本文",
        observedAt,
        nativeDependencies: Object.freeze([createNativeBlocker(secondItem, firstItem)]),
        duplicateComments: false,
      }),
    );
    const baseConfig = await createTestConfig({
      explicitIncludes: [],
      retentionDays: 180,
      aiEnabled: false,
    });
    const config = Object.freeze({
      ...baseConfig,
      importance: Object.freeze({
        ...baseConfig.importance,
        weights: Object.freeze({
          ...baseConfig.importance.weights,
          priorityLabelMultiplier: 4,
        }),
      }),
    });
    const harness = createCollectionHarness({
      repositories: [firstFixture, secondFixture],
      config,
    });
    expect((await harness.runDaily(FIRST_RUN_AT)).exitCode).toBe(0);
    secondFixture.enumerationFailsWith503 = true;
    harness.detailCalls.length = 0;
    harness.artifacts.length = 0;

    const result = await harness.runCollectAnalyze(SECOND_RUN_AT);
    const artifact = requireCollectAnalyzeArtifact(harness.artifacts);
    const snapshot = artifact.snapshot;
    const staleRepository = snapshot.repositories.find(
      (repository) => repository.id === secondRepository.id,
    );
    const freshTrackedItem = snapshot.items.find((item) => item.nodeId === firstItem.nodeId);
    const staleTrackedItem = snapshot.items.find((item) => item.nodeId === secondItem.nodeId);
    const stalePublicItem = artifact.pages.details.items.find(
      (item) => item.summary.nodeId === secondItem.nodeId,
    );

    expect(result).toMatchObject({ exitCode: 0 });
    expect(staleRepository).toEqual({
      ...requirePublicRepository(secondRepository),
      observedAt: FIRST_RUN_AT,
      freshness: "stale",
      failedAt: SECOND_RUN_AT,
    });
    expect(staleTrackedItem).toMatchObject({
      nodeId: secondItem.nodeId,
      title: secondItem.title,
      url: secondItem.url,
      observedAt: FIRST_RUN_AT,
      status: "waiting_for_unblock",
      aiAnalysis: { status: "disabled" },
      importance: {
        score: 100,
        level: "high",
      },
      importanceAssessment: { status: "not_available" },
      attention: { score: 0 },
    });
    expect(stalePublicItem?.summary).toMatchObject({
      nodeId: secondItem.nodeId,
      title: secondItem.title,
      url: secondItem.url,
      observedAt: FIRST_RUN_AT,
      repositoryFreshness: "stale",
      blockerNodeIds: [],
      downstreamImpact: {
        nodeId: secondItem.nodeId,
        openNodeCount: 0,
        repositoryCount: 0,
      },
    });
    expect(snapshot.relations).not.toContainEqual(
      expect.objectContaining({
        toNodeId: secondItem.nodeId,
      }),
    );
    expect(freshTrackedItem?.importance.factors).not.toContainEqual(
      expect.objectContaining({ kind: "downstreamImpact" }),
    );
    expect(freshTrackedItem?.importance.score).toBe(0);
    expect(freshTrackedItem?.attention.score).toBe(0);
    expect(
      harness.detailCalls.flatMap((call) => call.targets.map((target) => target.nodeId)),
    ).not.toContain(secondItem.nodeId);
    expect(harness.codexExecutionCount()).toBe(0);
    expect(artifact.notificationSelection.candidates).toEqual([]);
    expect(harness.discordCandidateNodeIds).toEqual([[]]);
  });

  it("cacheがないrepositoryの503ではartifactと公開出力とcache保存を行わない", async () => {
    const repository = createRepository("R_stale_cacheless", "stale-cacheless", FIRST_RUN_AT);
    const fixture = createRepositoryFixture(repository);
    fixture.enumerationFailsWith503 = true;
    const config = await createTestConfig({
      explicitIncludes: [],
      retentionDays: 180,
      aiEnabled: false,
    });
    const harness = createCollectionHarness({ repositories: [fixture], config });

    const result = await harness.runCollectAnalyze(FIRST_RUN_AT);

    expect(result.exitCode).toBe(1);
    expect(harness.artifacts).toEqual([]);
    expect(harness.publicData).toEqual([]);
    expect(harness.normalDiscordCallCount()).toBe(0);
    expect(await harness.stateAdapter.resolveHead("tracker-state-v3")).toEqual({
      status: "missing",
    });
  });

  it.each([
    {
      description: "private化",
      visibility: "private",
      archived: false,
      disabled: false,
    },
    {
      description: "archive化",
      visibility: "public",
      archived: true,
      disabled: false,
    },
    {
      description: "disabled化",
      visibility: "public",
      archived: false,
      disabled: true,
    },
  ] satisfies readonly {
    description: string;
    visibility: "private" | "public";
    archived: boolean;
    disabled: boolean;
  }[])(
    "公開cache保存後に追跡repositoryが$descriptionになるとcache境界で停止する",
    async ({ visibility, archived, disabled }) => {
      const repository = createRepository(
        "R_repository_boundary_transition",
        "repository-boundary-transition",
        FIRST_RUN_AT,
      );
      const publicRepository = requirePublicRepository(repository);
      const fixture = createRepositoryFixture(repository);
      const observedAt = createUtcIsoDateTime(FIRST_RUN_AT);
      const item = createIssueItem({
        repository: publicRepository,
        number: 1,
        fingerprint: "repository-boundary-transition",
        updatedAt: observedAt,
        observedAt,
        state: Object.freeze({ state: "open" }),
      });
      fixture.openItems = [item];
      fixture.details.set(
        item.nodeId,
        createIssueDetail({
          item,
          body: "公開cache境界のfixtureです",
          observedAt,
          nativeDependencies: Object.freeze([]),
          duplicateComments: false,
        }),
      );
      const config = await createTestConfig({
        explicitIncludes: [],
        retentionDays: 180,
        aiEnabled: false,
      });
      const harness = createCollectionHarness({ repositories: [fixture], config });

      expect((await harness.runDaily(FIRST_RUN_AT)).exitCode).toBe(0);
      const headBefore = await harness.stateAdapter.resolveHead("tracker-state-v3");
      const normalDiscordCallsBefore = harness.normalDiscordCallCount();
      const invalidRepository: Repository = Object.freeze({
        ...repository,
        visibility,
        archived,
        disabled,
      });
      harness.setInventory([invalidRepository]);
      harness.artifacts.length = 0;
      harness.publicData.length = 0;
      harness.reportSources.clear();

      const result = await harness.runCollectAnalyze(SECOND_RUN_AT);

      expect(result.exitCode).toBe(1);
      expect(harness.artifacts).toEqual([]);
      expect(harness.publicData).toEqual([]);
      expect(harness.normalDiscordCallCount()).toBe(normalDiscordCallsBefore);
      expect(await harness.stateAdapter.resolveHead("tracker-state-v3")).toEqual(headBefore);
    },
  );

  it.each(["item cache欠落", "repository index不一致"])(
    "503のstale復元時に%sなら公開出力を作らず失敗する",
    async (failureKind) => {
      const repository = createRepository(
        `R_stale_invalid_${failureKind === "item cache欠落" ? "missing" : "identity"}`,
        failureKind === "item cache欠落" ? "stale-cache-missing" : "stale-index-mismatch",
        FIRST_RUN_AT,
      );
      const fixture = createRepositoryFixture(repository);
      const observedAt = createUtcIsoDateTime(FIRST_RUN_AT);
      const item = createIssueItem({
        repository: requirePublicRepository(repository),
        number: 1,
        fingerprint: `stale-invalid-${failureKind}`,
        updatedAt: observedAt,
        observedAt,
        state: Object.freeze({ state: "open" }),
      });
      fixture.openItems = [item];
      setIssueDetails(fixture, [item], observedAt);
      const config = await createTestConfig({
        explicitIncludes: [],
        retentionDays: 180,
        aiEnabled: false,
      });
      const harness = createCollectionHarness({ repositories: [fixture], config });
      expect((await harness.runDaily(FIRST_RUN_AT)).exitCode).toBe(0);
      const head = await harness.stateAdapter.resolveHead("tracker-state-v3");
      if (head.status !== "present") {
        throw new TypeError("stale不整合fixtureのstate branchがありません");
      }
      const files = await harness.stateAdapter.readBranchFiles("tracker-state-v3");
      const itemPath = [...files.keys()].find((path) => path.startsWith("state/github-items/"));
      const repositoryFile = [...files].find(([path]) =>
        path.startsWith("state/github-repositories/"),
      );
      assertNonNullable(itemPath, "stale不整合fixtureのitem cache pathがありません");
      assertNonNullable(repositoryFile, "stale不整合fixtureのrepository cacheがありません");
      if (failureKind === "item cache欠落") {
        await harness.stateAdapter.commit({
          branch: "tracker-state-v3",
          expectedHead: head,
          updates: [],
          deletions: [itemPath],
          message: "stale item cache欠落fixture",
          committedAt: FIRST_RUN_AT,
        });
      } else {
        const repositoryDocument = createCacheDocument(
          JSON.parse(new TextDecoder().decode(repositoryFile[1])),
        );
        if (repositoryDocument.kind !== "github_repository") {
          throw new TypeError("stale不整合fixtureがrepository cacheではありません");
        }
        const repositoryIndex = repositoryDocument.items[0];
        assertNonNullable(repositoryIndex, "stale不整合fixtureのrepository indexがありません");
        const invalidDocument = createCacheDocument({
          ...repositoryDocument,
          items: [
            {
              ...repositoryIndex,
              itemFingerprint: createGitHubBodyFingerprint("stale-index-mismatch"),
            },
          ],
        });
        await harness.stateAdapter.commit({
          branch: "tracker-state-v3",
          expectedHead: head,
          updates: [
            {
              path: repositoryFile[0],
              bytes: new TextEncoder().encode(`${serializeCanonicalJson(invalidDocument)}\n`),
            },
          ],
          deletions: [],
          message: "stale repository index不一致fixture",
          committedAt: FIRST_RUN_AT,
        });
      }
      const corruptedHead = await harness.stateAdapter.resolveHead("tracker-state-v3");
      fixture.enumerationFailsWith503 = true;
      harness.artifacts.length = 0;
      harness.publicData.length = 0;

      const result = await harness.runCollectAnalyze(SECOND_RUN_AT);

      expect(result.exitCode).toBe(1);
      expect(harness.artifacts).toEqual([]);
      expect(harness.publicData).toEqual([]);
      expect(await harness.stateAdapter.resolveHead("tracker-state-v3")).toEqual(corruptedHead);
    },
  );

  it("AI有効でも503のstale項目はdetailとCodexと過去AI重要度を使わない", async () => {
    const repository = createRepository("R_stale_ai_enabled", "stale-ai-enabled", FIRST_RUN_AT);
    const fixture = createRepositoryFixture(repository);
    const observedAt = createUtcIsoDateTime(FIRST_RUN_AT);
    const item = Object.freeze({
      ...createIssueItem({
        repository: requirePublicRepository(repository),
        number: 1,
        fingerprint: "stale-ai-enabled",
        updatedAt: observedAt,
        observedAt,
        state: Object.freeze({ state: "open" }),
      }),
      labels: Object.freeze(["優先度：高"]),
    });
    fixture.openItems = [item];
    setIssueDetails(fixture, [item], observedAt);
    const config = await createTestConfig({
      explicitIncludes: [],
      retentionDays: 180,
      aiEnabled: true,
    });
    const harness = createCollectionHarness({
      repositories: [fixture],
      config,
      executeCodexAnalysis: executeSuccessfulCodexAnalysis,
    });
    expect((await harness.runDaily(FIRST_RUN_AT)).exitCode).toBe(0);
    const codexExecutionCount = harness.codexExecutionCount();
    const cacheSession = await CacheOnlyPersistenceSession.open(
      harness.stateAdapter,
      config.state,
      createPublicRepositoryAllowlist([repository]),
    );
    const loaded = await cacheSession.load({
      evaluatedAt: observedAt,
      knownSecrets: [],
    });
    if (loaded.status !== "available") {
      throw new TypeError("stale AI有効fixtureのcacheがありません");
    }
    harness.setConfig(
      Object.freeze({
        ...config,
        ai: Object.freeze({
          ...config.ai,
          promptVersion: "stale-ai-enabled-v2",
        }),
      }),
    );
    fixture.enumerationFailsWith503 = true;
    harness.detailCalls.length = 0;
    harness.artifacts.length = 0;

    const result = await harness.runCollectAnalyze(SECOND_RUN_AT);
    const artifact = requireCollectAnalyzeArtifact(harness.artifacts);
    const staleItem = artifact.snapshot.items.find((candidate) => candidate.nodeId === item.nodeId);

    expect(result.exitCode).toBe(0);
    expect(harness.detailCalls).toEqual([]);
    expect(harness.codexExecutionCount()).toBe(codexExecutionCount);
    expect(staleItem).toMatchObject({
      aiAnalysis: { status: "not_recorded" },
      importanceAssessment: { status: "not_available" },
      importance: {
        score: 25,
        factors: [expect.objectContaining({ kind: "priorityLabel" })],
      },
    });
    expect(artifact.cacheOnlyPayload.repositoryCaches).toEqual(loaded.repositoryCaches);
    expect(artifact.cacheOnlyPayload.itemCaches).toEqual(loaded.itemCaches);
    expect(artifact.cacheOnlyPayload.latestImportanceCaches).toEqual(loaded.latestImportanceCaches);
    expect(artifact.cacheOnlyPayload.aiCacheEntries).toEqual(loaded.aiCacheEntries);
  });

  it.each([
    {
      description: "private化",
      visibility: "PRIVATE",
      archived: false,
      disabled: false,
      state: "OPEN",
      succeeds: false,
    },
    {
      description: "公開項目のstate変化",
      visibility: "PUBLIC",
      archived: false,
      disabled: false,
      state: "CLOSED",
      succeeds: true,
    },
    {
      description: "archive化",
      visibility: "PUBLIC",
      archived: true,
      disabled: false,
      state: "OPEN",
      succeeds: false,
    },
    {
      description: "無効化",
      visibility: "PUBLIC",
      archived: false,
      disabled: true,
      state: "OPEN",
      succeeds: false,
    },
  ] satisfies readonly {
    description: string;
    visibility: ExternalRelationGraphqlItemOptions["visibility"];
    archived: boolean;
    disabled: boolean;
    state: NonNullable<ExternalRelationGraphqlItemOptions["state"]>;
    succeeds: boolean;
  }[])(
    "503 stale cacheの外部候補を$descriptionとして再検証する",
    async ({ visibility, archived, disabled, state, succeeds }) => {
      const repository = createRepository(
        `R_stale_external_${visibility.toLowerCase()}`,
        `stale-external-${visibility.toLowerCase()}`,
        FIRST_RUN_AT,
      );
      const publicRepository = requirePublicRepository(repository);
      const fixture = createRepositoryFixture(repository);
      const observedAt = createUtcIsoDateTime(FIRST_RUN_AT);
      const source = createIssueItem({
        repository: publicRepository,
        number: 1,
        fingerprint: `stale-external-${visibility.toLowerCase()}`,
        updatedAt: observedAt,
        observedAt,
        state: Object.freeze({ state: "open" }),
      });
      fixture.openItems = [source];
      fixture.details.set(
        source.nodeId,
        createIssueDetail({
          item: source,
          body: "stale external native relation",
          observedAt,
          nativeDependencies: Object.freeze([
            createExternalNativeBlocker(source, {
              state: "open",
              repositoryArchived: false,
              repositoryDisabled: false,
            }),
          ]),
          duplicateComments: false,
        }),
      );
      const baseConfig = await createTestConfig({
        explicitIncludes: [],
        retentionDays: 180,
        aiEnabled: true,
      });
      let externalVisibility: ExternalRelationGraphqlItemOptions["visibility"] = "PUBLIC";
      let externalArchived = false;
      let externalDisabled = false;
      let externalState: NonNullable<ExternalRelationGraphqlItemOptions["state"]> = "OPEN";
      const harness = createCollectionHarness({
        repositories: [fixture],
        config: baseConfig,
        executeCodexAnalysis: executeSuccessfulCodexAnalysis,
        externalRelationResponse: (request) =>
          createExternalRelationGraphqlResponse(request, {
            itemType: "issue",
            visibility: externalVisibility,
            archived: externalArchived,
            disabled: externalDisabled,
            nodeId: "I_external_blocker",
            state: externalState,
          }),
      });

      expect((await harness.runDaily(FIRST_RUN_AT)).exitCode).toBe(0);
      const firstArtifactCount = harness.artifacts.length;
      const firstPublicDataCount = harness.publicData.length;
      const firstCodexExecutionCount = harness.codexExecutionCount();
      const firstHead = await harness.stateAdapter.resolveHead("tracker-state-v3");
      fixture.enumerationFailsWith503 = true;
      externalVisibility = visibility;
      externalArchived = archived;
      externalDisabled = disabled;
      externalState = state;

      const secondResult = await harness.runCollectAnalyze(SECOND_RUN_AT);

      expect(harness.externalRelationGraphqlCalls).toHaveLength(2);
      expect(harness.detailCalls).toHaveLength(1);
      if (!succeeds) {
        if (secondResult.command !== "collect-analyze") {
          throw new TypeError("stale external boundary fixtureがcollect-analyze結果ではありません");
        }
        expect(secondResult.exitCode).toBe(1);
        expect(secondResult.result.report.diagnostics).toContainEqual(
          expect.stringContaining(
            `publicBoundaryViolationKind=cache_relation_candidate publicBoundaryViolationCount=1 sourceItemNodeId=${source.nodeId}`,
          ),
        );
        expect(harness.artifacts).toHaveLength(firstArtifactCount);
        expect(harness.publicData).toHaveLength(firstPublicDataCount);
        expect(harness.codexExecutionCount()).toBe(firstCodexExecutionCount);
        expect(await harness.stateAdapter.resolveHead("tracker-state-v3")).toEqual(firstHead);
        expect(JSON.stringify(secondResult.result.report)).not.toContain("external-owner");
        return;
      }

      expect(secondResult.exitCode).toBe(0);
      const artifact = requireCollectAnalyzeArtifact(harness.artifacts);
      const itemCache = artifact.cacheOnlyPayload.itemCaches.find(
        (candidate) => candidate.nodeId === source.nodeId,
      );
      if (itemCache == null) {
        throw new TypeError("stale external cacheのitem cacheがありません");
      }
      const externalCandidateNode = itemCache.relationCandidates
        .flatMap((candidate) => {
          switch (candidate.relation.type) {
            case "blocks":
              return [candidate.relation.blocker, candidate.relation.blocked];
            case "parent_of":
              return [candidate.relation.parent, candidate.relation.subtask];
            case "implements":
              return [candidate.relation.implementation, candidate.relation.target];
            case "unclassified":
              return [candidate.relation.referencing, candidate.relation.referenced];
          }
        })
        .find((node) => node.scope === "external_public");
      if (externalCandidateNode == null) {
        throw new TypeError("stale external cacheの候補nodeがありません");
      }
      expect(externalCandidateNode.state).toBe("open");
      expect(JSON.stringify(artifact)).not.toContain("CLOSED");
    },
  );

  it("503のterminal項目を180日目まで表示し期限後は表示しない", async () => {
    const repository = createRepository(
      "R_stale_terminal_retention",
      "stale-terminal-retention",
      FIRST_RUN_AT,
    );
    const fixture = createRepositoryFixture(repository);
    const observedAt = createUtcIsoDateTime(FIRST_RUN_AT);
    const terminalAt = createUtcIsoDateTime("2026-02-03T00:00:00.000Z");
    const item = replaceCreatedAt(
      createIssueItem({
        repository: requirePublicRepository(repository),
        number: 1,
        fingerprint: "stale-terminal-retention",
        updatedAt: terminalAt,
        observedAt,
        state: Object.freeze({ state: "closed", closedAt: terminalAt }),
      }),
      createUtcIsoDateTime("2026-01-01T00:00:00.000Z"),
    );
    fixture.openItems = [item];
    setIssueDetails(fixture, [item], observedAt);
    const config = await createTestConfig({
      explicitIncludes: [],
      retentionDays: 180,
      aiEnabled: false,
    });
    const harness = createCollectionHarness({ repositories: [fixture], config });
    expect((await harness.runDaily(FIRST_RUN_AT)).exitCode).toBe(0);
    fixture.enumerationFailsWith503 = true;
    harness.detailCalls.length = 0;
    harness.artifacts.length = 0;

    expect((await harness.runCollectAnalyze(SECOND_RUN_AT)).exitCode).toBe(0);
    expect(requireCollectAnalyzeArtifact(harness.artifacts).snapshot.items).toContainEqual(
      expect.objectContaining({ nodeId: item.nodeId, observedAt: FIRST_RUN_AT }),
    );
    expect(harness.detailCalls).toEqual([]);
    harness.artifacts.length = 0;

    expect((await harness.runCollectAnalyze(THIRD_RUN_AT)).exitCode).toBe(0);
    expect(
      requireCollectAnalyzeArtifact(harness.artifacts).snapshot.items.map(
        (candidate) => candidate.nodeId,
      ),
    ).not.toContain(item.nodeId);
    expect(harness.detailCalls).toEqual([]);
  });

  it("closeとmergeしたterminal endpointのblocks edgeをruntimeとPagesでinactiveにする", async () => {
    const repository = createRepository("R_terminal_edges", "terminal-edges", FIRST_RUN_AT);
    const publicRepository = requirePublicRepository(repository);
    const fixture = createRepositoryFixture(repository);
    const observedAt = createUtcIsoDateTime(FIRST_RUN_AT);
    const closedAt = createUtcIsoDateTime("2026-07-31T20:00:00.000Z");
    const mergedAt = createUtcIsoDateTime("2026-07-31T16:00:00.000Z");
    const blocked = createIssueItem({
      repository: publicRepository,
      number: 1,
      fingerprint: "terminal-edge-blocked",
      updatedAt: observedAt,
      observedAt,
      state: Object.freeze({ state: "open" }),
    });
    const closedBlocker = createIssueItem({
      repository: publicRepository,
      number: 2,
      fingerprint: "terminal-edge-closed-blocker",
      updatedAt: closedAt,
      observedAt,
      state: Object.freeze({ state: "closed", closedAt }),
    });
    const mergedBlocker = createMergedPullRequestItem({
      repository: publicRepository,
      number: 3,
      fingerprint: "terminal-edge-merged-blocker",
      closedAt,
      mergedAt,
      observedAt,
    });
    const blockedDetail = createIssueDetail({
      item: blocked,
      body: "終了した依存項目を待ちません",
      observedAt,
      nativeDependencies: Object.freeze([
        createNativeBlocker(blocked, closedBlocker),
        createNativeBlocker(blocked, mergedBlocker),
      ]),
      duplicateComments: false,
    });
    fixture.openItems = [blocked];
    fixture.individualItems.set(closedBlocker.nodeId, closedBlocker);
    fixture.individualItems.set(mergedBlocker.nodeId, mergedBlocker);
    fixture.details.set(
      blocked.nodeId,
      Object.freeze({
        ...blockedDetail,
        timeline: Object.freeze([
          createNativeDependencyTimelineEvent(
            blocked,
            closedBlocker,
            "added",
            blocked.createdAt,
            0,
          ),
          createNativeDependencyTimelineEvent(
            blocked,
            mergedBlocker,
            "added",
            blocked.createdAt,
            1,
          ),
        ]),
      }),
    );
    fixture.details.set(
      closedBlocker.nodeId,
      createIssueDetail({
        item: closedBlocker,
        body: "完了したIssueです",
        observedAt,
        nativeDependencies: Object.freeze([]),
        duplicateComments: false,
      }),
    );
    fixture.details.set(
      mergedBlocker.nodeId,
      createFailedCheckPullRequestDetail(mergedBlocker, observedAt),
    );
    const config = await createTestConfig({
      explicitIncludes: [],
      retentionDays: 180,
      aiEnabled: false,
    });
    const harness = createCollectionHarness({ repositories: [fixture], config });

    const result = await harness.runCollectAnalyze(FIRST_RUN_AT);
    const artifact = requireCollectAnalyzeArtifact(harness.artifacts);
    const mergedBlockerCache = artifact.cacheOnlyPayload.itemCaches.find(
      (item) => item.nodeId === mergedBlocker.nodeId,
    );
    if (mergedBlockerCache == null) {
      throw new TypeError("merged Pull Requestのitem cacheがありません");
    }
    const blockedSnapshotItem = artifact.snapshot.items.find(
      (item) => item.nodeId === blocked.nodeId,
    );
    const blockedSummary = artifact.pages.summary.items.find(
      (item) => item.nodeId === blocked.nodeId,
    );
    const terminalRelations = artifact.snapshot.relations.filter(
      (relation) => relation.toNodeId === blocked.nodeId,
    );
    const terminalPageEdges = artifact.pages.details.graph.edges.filter(
      (edge) => edge.toNodeId === blocked.nodeId,
    );

    expect(result.exitCode).toBe(0);
    expect(mergedBlockerCache.lifecycle).toEqual({
      kind: "terminal",
      terminalAt: mergedAt,
      expiresAt: createUtcIsoDateTime("2027-01-27T16:00:00.000Z"),
    });
    expect(mergedBlockerCache.currentObservation.closedAt).toBe(closedAt);
    if (result.command !== "collect-analyze") {
      throw new TypeError("terminal edge fixtureのcommandが不正です");
    }
    expect(result.result.report.metrics.activeEdgeCount).toBe(0);
    expect(artifact.runMetadata.metrics.activeEdgeCount).toBe(0);
    expect(blockedSnapshotItem?.waitingOn).not.toContainEqual(
      expect.objectContaining({ candidateId: closedBlocker.nodeId }),
    );
    expect(blockedSnapshotItem?.waitingOn).not.toContainEqual(
      expect.objectContaining({ candidateId: mergedBlocker.nodeId }),
    );
    expect(terminalRelations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          fromNodeId: closedBlocker.nodeId,
          toNodeId: blocked.nodeId,
          active: false,
          removedAt: closedAt,
        }),
        expect.objectContaining({
          fromNodeId: mergedBlocker.nodeId,
          toNodeId: blocked.nodeId,
          active: false,
          removedAt: mergedAt,
        }),
      ]),
    );
    expect(terminalPageEdges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          fromNodeId: closedBlocker.nodeId,
          toNodeId: blocked.nodeId,
          active: false,
        }),
        expect.objectContaining({
          fromNodeId: mergedBlocker.nodeId,
          toNodeId: blocked.nodeId,
          active: false,
        }),
      ]),
    );
    expect(blockedSummary).toMatchObject({
      blockerNodeIds: [],
      downstreamImpact: {
        nodeId: blocked.nodeId,
        openNodeCount: 0,
        repositoryCount: 0,
      },
    });
  });

  it("warm cacheはdetailを再取得せずcold runとgraph重要度attention通知候補が一致する", async () => {
    const repository = createRepository("R_warm_equivalence", "warm-equivalence", FIRST_RUN_AT);
    const publicRepository = requirePublicRepository(repository);
    const createObservedItem = (observedAt: UtcIsoDateTime): EnumeratedGitHubItem =>
      createIssueItem({
        repository: publicRepository,
        number: 1,
        fingerprint: "warm-equivalence-v1",
        updatedAt: createUtcIsoDateTime(FIRST_RUN_AT),
        observedAt,
        state: Object.freeze({ state: "open" }),
      });
    const executeWarmEquivalentCodexAnalysis = (input: CodexAnalysisInput): Promise<unknown> => {
      const source = input.sources[0];
      if (source == null) {
        throw new TypeError("warm equivalence fixtureのsourceがありません");
      }
      return Promise.resolve({
        ...createCodexOutput(input, {
          status: "in_progress",
          waitingOn: {
            candidateId: requireCodexAuthorCandidateId(input),
            kind: "user",
            role: "assignee",
            sourceId: source.id,
          },
          latestMeaningfulSourceId: null,
          confidence: 0.95,
          relationVerdict: "related",
          notification: {
            recommended: false,
            reasonCode: "none",
            reasonSummary: "通知しません",
          },
        }),
        importance: {
          significantFeature: true,
          explicitDeadline: true,
          futureRisk: false,
          rationale: "warmとcoldの重要度を一致させるfixtureです",
        },
      });
    };
    const config = await createTestConfig({
      explicitIncludes: [],
      retentionDays: 180,
      aiEnabled: true,
    });
    const warmFixture = createRepositoryFixture(repository);
    const firstItem = createObservedItem(createUtcIsoDateTime(FIRST_RUN_AT));
    warmFixture.openItems = [firstItem];
    warmFixture.details.set(
      firstItem.nodeId,
      createIssueDetail({
        item: firstItem,
        body: "body-warm-equivalence-v1",
        observedAt: firstItem.observedAt,
        nativeDependencies: Object.freeze([]),
        duplicateComments: false,
      }),
    );
    const warmHarness = createCollectionHarness({
      repositories: [warmFixture],
      config,
      executeCodexAnalysis: executeWarmEquivalentCodexAnalysis,
    });

    expect((await warmHarness.runDaily(FIRST_RUN_AT)).exitCode).toBe(0);
    const warmCodexExecutionCount = warmHarness.codexExecutionCount();
    expect(warmCodexExecutionCount).toBe(1);
    const persistedPaths = [
      ...(await warmHarness.stateAdapter.readBranchFiles("tracker-state-v3")).keys(),
    ];
    expect(
      persistedPaths.every(
        (path) =>
          path.startsWith("state/github-repositories/") ||
          path.startsWith("state/github-items/") ||
          path.startsWith("state/ai-latest-importance/") ||
          path.startsWith("state/ai-results/"),
      ),
    ).toBe(true);
    const warmSession = await CacheOnlyPersistenceSession.open(
      warmHarness.stateAdapter,
      config.state,
      createPublicRepositoryAllowlist([repository]),
    );
    const warmLoaded = await warmSession.load({
      evaluatedAt: createUtcIsoDateTime(FIRST_RUN_AT),
      knownSecrets: [],
    });
    if (warmLoaded.status !== "available" || warmLoaded.itemCaches.length !== 1) {
      throw new TypeError(`warm cacheを読み取れません。${JSON.stringify(warmLoaded)}`);
    }
    warmHarness.detailCalls.length = 0;
    warmHarness.individualCalls.length = 0;
    const secondItem = createObservedItem(createUtcIsoDateTime(SECOND_RUN_AT));
    warmFixture.openItems = [secondItem];
    warmFixture.details.set(
      secondItem.nodeId,
      createIssueDetail({
        item: secondItem,
        body: "body-warm-equivalence-v1",
        observedAt: secondItem.observedAt,
        nativeDependencies: Object.freeze([]),
        duplicateComments: false,
      }),
    );
    const warmResult = await warmHarness.runCollectAnalyze(SECOND_RUN_AT);
    const warmArtifact = requireCollectAnalyzeArtifact(warmHarness.artifacts);

    const coldFixture = createRepositoryFixture(repository);
    const coldItem = createObservedItem(createUtcIsoDateTime(SECOND_RUN_AT));
    coldFixture.openItems = [coldItem];
    coldFixture.details.set(
      coldItem.nodeId,
      createIssueDetail({
        item: coldItem,
        body: "body-warm-equivalence-v1",
        observedAt: coldItem.observedAt,
        nativeDependencies: Object.freeze([]),
        duplicateComments: false,
      }),
    );
    const coldHarness = createCollectionHarness({
      repositories: [coldFixture],
      config,
      executeCodexAnalysis: executeWarmEquivalentCodexAnalysis,
    });
    const coldResult = await coldHarness.runCollectAnalyze(SECOND_RUN_AT);
    const coldArtifact = requireCollectAnalyzeArtifact(coldHarness.artifacts);

    expect(warmResult.exitCode).toBe(0);
    expect(coldResult.exitCode).toBe(0);
    expect(warmHarness.detailCalls).toEqual([]);
    expect(warmHarness.codexExecutionCount()).toBe(warmCodexExecutionCount);
    expect(coldHarness.codexExecutionCount()).toBe(1);
    expect(coldHarness.detailCalls).toEqual([
      {
        targets: [{ nodeId: firstItem.nodeId }],
      },
    ]);
    expect(warmHarness.individualCalls).toEqual([]);
    expect(coldHarness.individualCalls).toEqual([]);
    expect(warmArtifact.snapshot.items).toEqual(coldArtifact.snapshot.items);
    expect(
      warmArtifact.snapshot.items.map((item) => ({
        nodeId: item.nodeId,
        importance: item.importance,
        attention: item.attention,
      })),
    ).toEqual(
      coldArtifact.snapshot.items.map((item) => ({
        nodeId: item.nodeId,
        importance: item.importance,
        attention: item.attention,
      })),
    );
    expect(warmArtifact.snapshot.relations).toEqual(coldArtifact.snapshot.relations);
    expect(warmArtifact.pages.details).toEqual(coldArtifact.pages.details);
    expect(warmArtifact.notificationSelection.candidates).toEqual(
      coldArtifact.notificationSelection.candidates,
    );
    expect(warmHarness.volatileProbeCalls).toEqual([]);
    expect(coldHarness.volatileProbeCalls).toEqual([]);
  });

  it("Pull Requestのvolatile差分だけでdetailを再取得して次のwarm runでは省略する", async () => {
    const repository = createRepository("R_volatile_warm", "volatile-warm", FIRST_RUN_AT);
    const publicRepository = requirePublicRepository(repository);
    const fixture = createRepositoryFixture(repository);
    const createItem = (observedAt: UtcIsoDateTime): EnumeratedGitHubItem =>
      alignPullRequestBodyFingerprint(
        createPullRequestItem({
          repository: publicRepository,
          number: 1,
          fingerprint: "volatile-warm",
          updatedAt: createUtcIsoDateTime(FIRST_RUN_AT),
          observedAt,
        }),
      );
    const firstItem = createItem(createUtcIsoDateTime(FIRST_RUN_AT));
    const firstDetail = createFailedCheckPullRequestDetail(
      firstItem,
      createUtcIsoDateTime(FIRST_RUN_AT),
    );
    fixture.openItems = [firstItem];
    fixture.details.set(firstItem.nodeId, firstDetail);
    const config = await createTestConfig({
      explicitIncludes: [],
      retentionDays: 180,
      aiEnabled: false,
    });
    const harness = createCollectionHarness({ repositories: [fixture], config });

    expect((await harness.runDaily(FIRST_RUN_AT)).exitCode).toBe(0);
    harness.detailCalls.length = 0;
    harness.volatileProbeCalls.length = 0;
    const secondItem = createItem(createUtcIsoDateTime(SECOND_RUN_AT));
    const secondDetail = Object.freeze({
      ...firstDetail,
      mergeState: Object.freeze({
        ...firstDetail.mergeState,
        mergeState: "blocked",
      }),
      observedAt: createUtcIsoDateTime(SECOND_RUN_AT),
    } satisfies GitHubItemDetail);
    fixture.openItems = [secondItem];
    fixture.details.set(secondItem.nodeId, secondDetail);

    const changedResult = await harness.runDaily(SECOND_RUN_AT);
    expect(changedResult.exitCode).toBe(0);
    expect(harness.volatileProbeCalls).toEqual([{ pullRequestNodeIds: [secondItem.nodeId] }]);
    expect(harness.detailCalls).toEqual([
      {
        targets: [{ nodeId: secondItem.nodeId }],
      },
    ]);
    const session = await CacheOnlyPersistenceSession.open(
      harness.stateAdapter,
      config.state,
      createPublicRepositoryAllowlist([repository]),
    );
    const loaded = await session.load({
      evaluatedAt: createUtcIsoDateTime(SECOND_RUN_AT),
      knownSecrets: Object.freeze([]),
    });
    if (loaded.status !== "available") {
      throw new TypeError("volatile差分保存後のcacheを読み取れません");
    }
    const repositoryItem = loaded.repositoryCaches[0]?.items[0];
    const itemCache = loaded.itemCaches[0];
    if (repositoryItem == null || itemCache == null) {
      throw new TypeError("volatile差分保存後のrepositoryまたはitem cacheがありません");
    }
    expect(repositoryItem.itemFingerprint).toBe(itemCache.itemFingerprint);
    expect(itemCache.itemFingerprint).not.toBe(secondItem.itemFingerprint);

    harness.detailCalls.length = 0;
    harness.volatileProbeCalls.length = 0;
    const thirdItem = createItem(createUtcIsoDateTime(THIRD_RUN_AT));
    const thirdDetail = Object.freeze({
      ...secondDetail,
      observedAt: createUtcIsoDateTime(THIRD_RUN_AT),
    } satisfies GitHubItemDetail);
    fixture.openItems = [thirdItem];
    fixture.details.set(thirdItem.nodeId, thirdDetail);

    const warmResult = await harness.runCollectAnalyze(THIRD_RUN_AT);
    const warmArtifact = requireCollectAnalyzeArtifact(harness.artifacts);
    const warmSnapshotItem = requireCollectionItem(warmArtifact.snapshot, thirdItem.nodeId);
    const warmItemCache = warmArtifact.cacheOnlyPayload.itemCaches.find(
      (document) => document.nodeId === thirdItem.nodeId,
    );
    const expectedWarmItem = finalizeGitHubItemsWithVolatileMetadata({
      items: [thirdItem],
      volatileMetadata: [createGitHubPullRequestVolatileMetadataFromDetail(thirdDetail)],
    }).items[0];

    expect(warmResult.exitCode).toBe(0);
    expect(harness.volatileProbeCalls).toEqual([{ pullRequestNodeIds: [thirdItem.nodeId] }]);
    expect(harness.detailCalls).toEqual([]);
    expect(warmSnapshotItem.itemFingerprint).toBe(expectedWarmItem?.itemFingerprint);
    expect(warmItemCache?.currentObservation.itemFingerprint).toBe(
      expectedWarmItem?.itemFingerprint,
    );
  });

  it("probeとdetailでvolatile値が変化してもdetailの値を正本にして保存する", async () => {
    const repository = createRepository("R_volatile_retry", "volatile-retry", FIRST_RUN_AT);
    const fixture = createRepositoryFixture(repository);
    const item = alignPullRequestBodyFingerprint(
      createPullRequestItem({
        repository: requirePublicRepository(repository),
        number: 1,
        fingerprint: "volatile-retry",
        updatedAt: createUtcIsoDateTime(FIRST_RUN_AT),
        observedAt: createUtcIsoDateTime(FIRST_RUN_AT),
      }),
    );
    const detail = createFailedCheckPullRequestDetail(item, createUtcIsoDateTime(FIRST_RUN_AT));
    const actualMetadata = createGitHubPullRequestVolatileMetadataFromDetail(detail);
    const mismatchedMetadata = createGitHubPullRequestVolatileMetadataFromDetail(
      Object.freeze({
        ...detail,
        mergeState: Object.freeze({
          ...detail.mergeState,
          mergeState: "blocked",
        }),
      }),
    );
    fixture.openItems = [item];
    fixture.details.set(item.nodeId, detail);
    let attemptCount = 0;
    const config = await createTestConfig({
      explicitIncludes: [],
      retentionDays: 180,
      aiEnabled: false,
    });
    const harness = createCollectionHarness({
      repositories: [fixture],
      config,
      probeGitHubPullRequestVolatileMetadataWithRetry: async (input) => {
        const validateDetail = input.validateDetail;
        if (validateDetail == null) {
          throw new TypeError("volatile retry fixtureのdetail照合callbackがありません");
        }
        const races: GitHubPullRequestVolatileRaceError[] = [];
        const attempts = Object.freeze([
          Object.freeze({ status: "probe_race" }),
          Object.freeze({ status: "metadata", value: mismatchedMetadata }),
        ]);
        for (const attempt of attempts) {
          attemptCount += 1;
          if (attempt.status === "probe_race") {
            races.push(
              new GitHubPullRequestVolatileRaceError("check_context_page", item.nodeId, {
                cause: new TypeError("probe中にcheckが変化しました"),
              }),
            );
            continue;
          }
          const collection = Object.freeze({ items: Object.freeze([attempt.value]) });
          try {
            await validateDetail(collection);
            return collection;
          } catch (error: unknown) {
            if (!(error instanceof GitHubPullRequestVolatileRaceError)) {
              throw error;
            }
            races.push(error);
          }
        }
        throw new GitHubPullRequestVolatileRaceRetryExhaustedError(races);
      },
    });

    const result = await harness.runCollectAnalyze(FIRST_RUN_AT);
    const artifact = requireCollectAnalyzeArtifact(harness.artifacts);
    const expectedItem = finalizeGitHubItemsWithVolatileMetadata({
      items: [item],
      volatileMetadata: [actualMetadata],
    }).items[0];
    const repositoryItem = artifact.cacheOnlyPayload.repositoryCaches
      .flatMap((document) => document.items)
      .find((candidate) => candidate.nodeId === item.nodeId);
    const itemCache = artifact.cacheOnlyPayload.itemCaches.find(
      (document) => document.nodeId === item.nodeId,
    );
    const snapshotItem = requireCollectionItem(artifact.snapshot, item.nodeId);

    expect(result.exitCode).toBe(0);
    expect(attemptCount).toBe(2);
    expect(harness.detailCalls).toEqual([{ targets: [{ nodeId: item.nodeId }] }]);
    expect(harness.artifacts).toHaveLength(1);
    expect(expectedItem).toBeDefined();
    expect(snapshotItem.itemFingerprint).toBe(expectedItem?.itemFingerprint);
    expect(repositoryItem?.itemFingerprint).toBe(expectedItem?.itemFingerprint);
    expect(itemCache?.itemFingerprint).toBe(expectedItem?.itemFingerprint);
    expect(itemCache?.currentObservation.itemFingerprint).toBe(expectedItem?.itemFingerprint);
    expect(itemCache?.itemFingerprint).not.toBe(
      finalizeGitHubItemsWithVolatileMetadata({
        items: [item],
        volatileMetadata: [mismatchedMetadata],
      }).items[0]?.itemFingerprint,
    );
  });

  it("責務再生不一致では対象nodeだけ現行itemとdetailを再取得して反映する", async () => {
    const repository = createRepository(
      "R_responsibility_replay_retry",
      "responsibility-replay-retry",
      FIRST_RUN_AT,
    );
    const publicRepository = requirePublicRepository(repository);
    const fixture = createRepositoryFixture(repository);
    const assignee = Object.freeze({
      nodeId: createGitHubNodeId("U_responsibility_replay_retry"),
      login: "responsibility-replay-retry",
      apiType: "User",
    }) satisfies GitHubItemAccount;
    const item = Object.freeze({
      ...createIssueItem({
        repository: publicRepository,
        number: 1,
        fingerprint: "responsibility-replay-retry-initial",
        updatedAt: createUtcIsoDateTime(FIRST_RUN_AT),
        observedAt: createUtcIsoDateTime(FIRST_RUN_AT),
        state: Object.freeze({ state: "open" }),
      }),
      assignees: Object.freeze([assignee]),
    }) satisfies EnumeratedGitHubItem;
    const refreshedItem = Object.freeze({
      ...item,
      title: "再列挙後の項目",
      itemFingerprint: createGitHubBodyFingerprint("responsibility-replay-retry-refreshed"),
    }) satisfies EnumeratedGitHubItem;
    const otherItem = createIssueItem({
      repository: publicRepository,
      number: 2,
      fingerprint: "responsibility-replay-retry-other",
      updatedAt: createUtcIsoDateTime(FIRST_RUN_AT),
      observedAt: createUtcIsoDateTime(FIRST_RUN_AT),
      state: Object.freeze({ state: "open" }),
    });
    const observedAt = createUtcIsoDateTime(FIRST_RUN_AT);
    const initialDetail = createIssueDetail({
      item,
      body: "初回detail",
      observedAt,
      nativeDependencies: Object.freeze([]),
      duplicateComments: false,
    });
    const otherDetail = createIssueDetail({
      item: otherItem,
      body: "別項目detail",
      observedAt,
      nativeDependencies: Object.freeze([]),
      duplicateComments: false,
    });
    const assignmentEvent = Object.freeze({
      sourceId: buildSourceId("github_timeline_event", "responsibility-replay-retry-assigned"),
      nodeId: createGitHubNodeId("TE_responsibility_replay_retry_assigned"),
      sequence: 0,
      occurredAt: createUtcIsoDateTime("2026-07-02T00:00:00.000Z"),
      actor: Object.freeze({
        status: "unavailable",
        reason: "github_did_not_return_actor",
      }),
      kind: "assigned",
      assignee: Object.freeze({
        type: "account",
        account: Object.freeze({
          sourceId: buildSourceId("github_actor", assignee.nodeId),
          ...assignee,
        }),
      }),
    } satisfies GitHubTimelineEvent);
    const refreshedDetail = Object.freeze({
      ...initialDetail,
      body: "再取得後detail",
      timeline: Object.freeze([assignmentEvent]),
    }) satisfies GitHubItemDetail;
    fixture.openItems = [item, otherItem];
    fixture.individualItems.set(item.nodeId, refreshedItem);
    let detailCollectionAttempt = 0;
    const config = await createTestConfig({
      explicitIncludes: [],
      retentionDays: 180,
      aiEnabled: false,
    });
    const harness = createCollectionHarness({
      repositories: [fixture],
      config,
      sleep: () => Promise.resolve(),
      collectGitHubItemDetails: (input) => {
        detailCollectionAttempt += 1;
        if (detailCollectionAttempt === 1) {
          return Promise.resolve(
            Object.freeze({
              capabilities: Object.freeze({
                nativeDependencies: "available",
                nativeHierarchy: "available",
              }),
              items: Object.freeze(
                input.targets.map((target) =>
                  target.item.nodeId === item.nodeId ? initialDetail : otherDetail,
                ),
              ),
            }),
          );
        }
        if (input.targets.length !== 1 || input.targets[0]?.item.nodeId !== item.nodeId) {
          throw new TypeError("責務再生retryが対象node以外を取得しました");
        }
        return Promise.resolve(
          Object.freeze({
            capabilities: Object.freeze({
              nativeDependencies: "available",
              nativeHierarchy: "available",
            }),
            items: Object.freeze([refreshedDetail]),
          }),
        );
      },
    });

    const result = await harness.runCollectAnalyze(FIRST_RUN_AT);
    const artifact = requireCollectAnalyzeArtifact(harness.artifacts);
    const snapshotItem = requireCollectionItem(artifact.snapshot, item.nodeId);
    const repositoryItem = artifact.cacheOnlyPayload.repositoryCaches
      .flatMap((document) => document.items)
      .find((candidate) => candidate.nodeId === item.nodeId);
    const itemCache = artifact.cacheOnlyPayload.itemCaches.find(
      (document) => document.nodeId === item.nodeId,
    );

    expect(result.exitCode).toBe(0);
    expect(detailCollectionAttempt).toBe(2);
    expect(harness.individualCalls).toEqual([[item.nodeId]]);
    expect(harness.detailCalls).toEqual([
      { targets: [{ nodeId: item.nodeId }, { nodeId: otherItem.nodeId }] },
      { targets: [{ nodeId: item.nodeId }] },
    ]);
    expect(snapshotItem.itemFingerprint).toBe(refreshedItem.itemFingerprint);
    expect(repositoryItem?.itemFingerprint).toBe(refreshedItem.itemFingerprint);
    expect(itemCache?.currentObservation.title).toBe(refreshedItem.title);
    expect(itemCache?.currentObservation.events).toContainEqual(
      expect.objectContaining({
        kind: "assignee",
        action: "added",
        itemNodeId: item.nodeId,
      }),
    );
    expect(itemCache?.replay.currentResponsibilities).toEqual([
      { kind: "assignee", nodeId: assignee.nodeId },
    ]);
  });

  it("責務再生retryの再列挙number不一致ではdetailを追加取得しない", async () => {
    const repository = createRepository(
      "R_responsibility_replay_retry_number_mismatch",
      "responsibility-replay-retry-number-mismatch",
      FIRST_RUN_AT,
    );
    const publicRepository = requirePublicRepository(repository);
    const fixture = createRepositoryFixture(repository);
    const assignee = Object.freeze({
      nodeId: createGitHubNodeId("U_responsibility_replay_retry_number_mismatch"),
      login: "responsibility-replay-retry-number-mismatch",
      apiType: "User",
    }) satisfies GitHubItemAccount;
    const item = Object.freeze({
      ...createIssueItem({
        repository: publicRepository,
        number: 1,
        fingerprint: "responsibility-replay-retry-number-mismatch",
        updatedAt: createUtcIsoDateTime(FIRST_RUN_AT),
        observedAt: createUtcIsoDateTime(FIRST_RUN_AT),
        state: Object.freeze({ state: "open" }),
      }),
      assignees: Object.freeze([assignee]),
    }) satisfies EnumeratedGitHubItem;
    const mismatchedItem = Object.freeze({
      ...item,
      number: 2,
    }) satisfies EnumeratedGitHubItem;
    const detail = createIssueDetail({
      item,
      body: "責務再生retryのnumber不一致fixture",
      observedAt: createUtcIsoDateTime(FIRST_RUN_AT),
      nativeDependencies: Object.freeze([]),
      duplicateComments: false,
    });
    fixture.openItems = [item];
    fixture.individualItems.set(item.nodeId, mismatchedItem);
    fixture.details.set(item.nodeId, detail);
    const config = await createTestConfig({
      explicitIncludes: [],
      retentionDays: 180,
      aiEnabled: false,
    });
    const harness = createCollectionHarness({
      repositories: [fixture],
      config,
      sleep: () => Promise.resolve(),
    });

    const result = await harness.runCollectAnalyze(FIRST_RUN_AT);
    const head = await harness.stateAdapter.resolveHead("tracker-state-v3");
    if (result.command !== "collect-analyze") {
      throw new TypeError("責務再生retry number不一致fixtureがcollect-analyze結果ではありません");
    }

    expect(result.exitCode).toBe(1);
    expect(result.result.report).toMatchObject({
      status: "failure",
      failedStage: "incremental_collection",
      complete: false,
    });
    expect(harness.individualCalls).toEqual([[item.nodeId]]);
    expect(harness.detailCalls).toEqual([{ targets: [{ nodeId: item.nodeId }] }]);
    expect(harness.sleepDelays).toEqual([2000]);
    expect(harness.artifacts).toEqual([]);
    expect(harness.publicData).toEqual([]);
    expect(head).toEqual({ status: "missing" });
  });

  it("detail取得失敗では部分artifactとcacheとPagesを残さない", async () => {
    const repository = createRepository(
      "R_volatile_retry_exhausted",
      "volatile-retry-exhausted",
      FIRST_RUN_AT,
    );
    const fixture = createRepositoryFixture(repository);
    const item = alignPullRequestBodyFingerprint(
      createPullRequestItem({
        repository: requirePublicRepository(repository),
        number: 1,
        fingerprint: "volatile-retry-exhausted",
        updatedAt: createUtcIsoDateTime(FIRST_RUN_AT),
        observedAt: createUtcIsoDateTime(FIRST_RUN_AT),
      }),
    );
    const detail = createFailedCheckPullRequestDetail(item, createUtcIsoDateTime(FIRST_RUN_AT));
    const actualMetadata = createGitHubPullRequestVolatileMetadataFromDetail(detail);
    fixture.openItems = [item];
    fixture.details.set(item.nodeId, detail);
    const config = await createTestConfig({
      explicitIncludes: [],
      retentionDays: 180,
      aiEnabled: false,
    });
    const harness = createCollectionHarness({
      repositories: [fixture],
      config,
      probeGitHubPullRequestVolatileMetadataWithRetry: async (input) => {
        await input.validateDetail?.(Object.freeze({ items: Object.freeze([actualMetadata]) }));
        throw new TypeError("detail取得fixture失敗");
      },
    });

    const result = await harness.runCollectAnalyze(FIRST_RUN_AT);
    const head = await harness.stateAdapter.resolveHead("tracker-state-v3");
    if (result.command !== "collect-analyze") {
      throw new TypeError("volatile retry exhaustion fixtureがcollect-analyze結果ではありません");
    }

    expect(result.exitCode).toBe(1);
    expect(result.result.report).toMatchObject({
      status: "failure",
      failedStage: "incremental_collection",
      complete: false,
    });
    expect(result.result.effects).toEqual({
      cacheCommitted: false,
      pagesBuilt: false,
      discordAttempted: false,
      artifactWritten: false,
    });
    expect(harness.detailCalls).toHaveLength(1);
    expect(harness.artifacts).toEqual([]);
    expect(harness.publicData).toEqual([]);
    expect(head).toEqual({ status: "missing" });
  });

  it("責務再生不一致が上限まで続けば設定どおり待機して全体を失敗させる", async () => {
    const repository = createRepository(
      "R_responsibility_replay_retry_exhausted",
      "responsibility-replay-retry-exhausted",
      FIRST_RUN_AT,
    );
    const publicRepository = requirePublicRepository(repository);
    const fixture = createRepositoryFixture(repository);
    const assignee = Object.freeze({
      nodeId: createGitHubNodeId("U_responsibility_replay_retry_exhausted"),
      login: "responsibility-replay-retry-exhausted",
      apiType: "User",
    }) satisfies GitHubItemAccount;
    const item = Object.freeze({
      ...createIssueItem({
        repository: publicRepository,
        number: 1,
        fingerprint: "responsibility-replay-retry-exhausted",
        updatedAt: createUtcIsoDateTime(FIRST_RUN_AT),
        observedAt: createUtcIsoDateTime(FIRST_RUN_AT),
        state: Object.freeze({ state: "open" }),
      }),
      assignees: Object.freeze([assignee]),
    }) satisfies EnumeratedGitHubItem;
    const detail = createIssueDetail({
      item,
      body: "責務再生retry上限fixture",
      observedAt: createUtcIsoDateTime(FIRST_RUN_AT),
      nativeDependencies: Object.freeze([]),
      duplicateComments: false,
    });
    fixture.openItems = [item];
    fixture.individualItems.set(item.nodeId, item);
    fixture.details.set(item.nodeId, detail);
    const baseConfig = await createTestConfig({
      explicitIncludes: [],
      retentionDays: 180,
      aiEnabled: false,
    });
    const config = Object.freeze({
      ...baseConfig,
      operations: Object.freeze({
        ...baseConfig.operations,
        retry: Object.freeze({
          ...baseConfig.operations.retry,
          maxAttempts: 3,
          initialDelaySeconds: 2,
          maxDelaySeconds: 3,
        }),
      }),
    });
    const harness = createCollectionHarness({
      repositories: [fixture],
      config,
      sleep: () => Promise.resolve(),
    });

    const result = await harness.runCollectAnalyze(FIRST_RUN_AT);
    const head = await harness.stateAdapter.resolveHead("tracker-state-v3");

    if (result.command !== "collect-analyze") {
      throw new TypeError("責務再生retry上限fixtureがcollect-analyze結果ではありません");
    }

    expect(result.exitCode).toBe(1);
    expect(result.result.report).toMatchObject({
      status: "failure",
      failedStage: "incremental_collection",
      complete: false,
    });
    expect(
      result.result.report.diagnostics.some((diagnostic) =>
        diagnostic.includes("ResponsibilityReplayRetryExhaustedError"),
      ),
    ).toBe(true);
    expect(harness.individualCalls).toEqual([[item.nodeId], [item.nodeId]]);
    expect(harness.detailCalls).toEqual([
      { targets: [{ nodeId: item.nodeId }] },
      { targets: [{ nodeId: item.nodeId }] },
      { targets: [{ nodeId: item.nodeId }] },
    ]);
    expect(harness.sleepDelays).toEqual([2000, 3000]);
    expect(result.result.effects).toEqual({
      cacheCommitted: false,
      pagesBuilt: false,
      discordAttempted: false,
      artifactWritten: false,
    });
    expect(harness.artifacts).toEqual([]);
    expect(harness.publicData).toEqual([]);
    expect(head).toEqual({ status: "missing" });
  });

  it("detailのPull Request identity不整合では部分artifactとcacheとPagesを残さない", async () => {
    const repository = createRepository(
      "R_volatile_identity_mismatch",
      "volatile-identity-mismatch",
      FIRST_RUN_AT,
    );
    const fixture = createRepositoryFixture(repository);
    const item = alignPullRequestBodyFingerprint(
      createPullRequestItem({
        repository: requirePublicRepository(repository),
        number: 1,
        fingerprint: "volatile-identity-mismatch",
        updatedAt: createUtcIsoDateTime(FIRST_RUN_AT),
        observedAt: createUtcIsoDateTime(FIRST_RUN_AT),
      }),
    );
    const detail = createFailedCheckPullRequestDetail(item, createUtcIsoDateTime(FIRST_RUN_AT));
    const actualMetadata = createGitHubPullRequestVolatileMetadataFromDetail(detail);
    const invalidDetail = Object.freeze({
      ...detail,
      headSha: "different-head-sha",
    } satisfies GitHubItemDetail);
    fixture.openItems = [item];
    fixture.details.set(item.nodeId, invalidDetail);
    const config = await createTestConfig({
      explicitIncludes: [],
      retentionDays: 180,
      aiEnabled: false,
    });
    const harness = createCollectionHarness({
      repositories: [fixture],
      config,
      probeGitHubPullRequestVolatileMetadataWithRetry: async (input) => {
        const collection = Object.freeze({ items: Object.freeze([actualMetadata]) });
        await input.validateDetail?.(collection);
        return collection;
      },
    });

    const result = await harness.runCollectAnalyze(FIRST_RUN_AT);
    const head = await harness.stateAdapter.resolveHead("tracker-state-v3");
    if (result.command !== "collect-analyze") {
      throw new TypeError("volatile identity mismatch fixtureがcollect-analyze結果ではありません");
    }

    expect(result.exitCode).toBe(1);
    expect(result.result.report).toMatchObject({
      status: "failure",
      failedStage: "incremental_collection",
      complete: false,
    });
    expect(result.result.effects).toEqual({
      cacheCommitted: false,
      pagesBuilt: false,
      discordAttempted: false,
      artifactWritten: false,
    });
    expect(harness.detailCalls).toEqual([{ targets: [{ nodeId: item.nodeId }] }]);
    expect(harness.individualCalls).toEqual([]);
    expect(harness.sleepDelays).toEqual([]);
    expect(harness.artifacts).toEqual([]);
    expect(harness.publicData).toEqual([]);
    expect(head).toEqual({ status: "missing" });
  });

  it("relation expansionで追加したPull Requestもprobe後のfingerprintで保存する", async () => {
    const repository = createRepository(
      "R_volatile_relation_expansion",
      "volatile-relation-expansion",
      FIRST_RUN_AT,
    );
    const publicRepository = requirePublicRepository(repository);
    const fixture = createRepositoryFixture(repository);
    const observedAt = createUtcIsoDateTime(FIRST_RUN_AT);
    const root = createIssueItem({
      repository: publicRepository,
      number: 1,
      fingerprint: "volatile-expansion-root",
      updatedAt: observedAt,
      observedAt,
      state: Object.freeze({ state: "open" }),
    });
    const target = alignPullRequestBodyFingerprint(
      createPullRequestItem({
        repository: publicRepository,
        number: 2,
        fingerprint: "volatile-expansion-target",
        updatedAt: observedAt,
        observedAt,
      }),
    );
    fixture.openItems = [root];
    fixture.individualItems.set(target.nodeId, target);
    fixture.details.set(
      root.nodeId,
      createIssueDetail({
        item: root,
        body: "Pull Requestの完了を待ちます",
        observedAt,
        nativeDependencies: Object.freeze([createNativeBlocker(root, target)]),
        duplicateComments: false,
      }),
    );
    fixture.details.set(target.nodeId, createFailedCheckPullRequestDetail(target, observedAt));
    const config = await createTestConfig({
      explicitIncludes: [],
      retentionDays: 180,
      aiEnabled: false,
    });
    const harness = createCollectionHarness({ repositories: [fixture], config });

    const result = await harness.runCollectAnalyze(FIRST_RUN_AT);
    const artifact = requireCollectAnalyzeArtifact(harness.artifacts);
    const repositoryItem = artifact.cacheOnlyPayload.repositoryCaches
      .flatMap((document) => document.items)
      .find((candidate) => candidate.nodeId === target.nodeId);
    const itemCache = artifact.cacheOnlyPayload.itemCaches.find(
      (document) => document.nodeId === target.nodeId,
    );

    expect(result.exitCode).toBe(0);
    expect(harness.individualCalls).toContainEqual([target.url]);
    expect(harness.volatileProbeCalls).toEqual([{ pullRequestNodeIds: [target.nodeId] }]);
    expect(harness.detailCalls).toEqual([
      { targets: [{ nodeId: root.nodeId }] },
      { targets: [{ nodeId: target.nodeId }] },
    ]);
    expect(repositoryItem?.itemFingerprint).toBe(itemCache?.itemFingerprint);
    expect(itemCache?.itemFingerprint).not.toBe(target.itemFingerprint);
  });

  it("503でstaleになったrepositoryではPull Request probeを呼ばない", async () => {
    const repository = createRepository("R_volatile_stale", "volatile-stale", FIRST_RUN_AT);
    const fixture = createRepositoryFixture(repository);
    const item = alignPullRequestBodyFingerprint(
      createPullRequestItem({
        repository: requirePublicRepository(repository),
        number: 1,
        fingerprint: "volatile-stale",
        updatedAt: createUtcIsoDateTime(FIRST_RUN_AT),
        observedAt: createUtcIsoDateTime(FIRST_RUN_AT),
      }),
    );
    fixture.openItems = [item];
    fixture.details.set(
      item.nodeId,
      createFailedCheckPullRequestDetail(item, createUtcIsoDateTime(FIRST_RUN_AT)),
    );
    const config = await createTestConfig({
      explicitIncludes: [],
      retentionDays: 180,
      aiEnabled: false,
    });
    const harness = createCollectionHarness({ repositories: [fixture], config });

    expect((await harness.runDaily(FIRST_RUN_AT)).exitCode).toBe(0);
    fixture.enumerationFailsWith503 = true;
    harness.volatileProbeCalls.length = 0;

    const result = await harness.runCollectAnalyze(SECOND_RUN_AT);

    expect(result.exitCode).toBe(0);
    expect(harness.volatileProbeCalls).toEqual([]);
  });

  it("現在の解析versionと異なるexact AI entryはfresh詳細から再判定する", async () => {
    const repository = createRepository(
      "R_exact_ai_identity_refresh",
      "exact-ai-identity-refresh",
      FIRST_RUN_AT,
    );
    const fixture = createRepositoryFixture(repository);
    const observedAt = createUtcIsoDateTime(FIRST_RUN_AT);
    const fingerprint = "@requested-user に対応をお願いします";
    const item = createIssueItem({
      repository: requirePublicRepository(repository),
      number: 1,
      fingerprint,
      updatedAt: observedAt,
      observedAt,
      state: Object.freeze({ state: "open" }),
    });
    fixture.openItems = [item];
    fixture.details.set(
      item.nodeId,
      createIssueDetail({
        item,
        body: `body-${fingerprint}`,
        observedAt,
        nativeDependencies: Object.freeze([]),
        duplicateComments: false,
      }),
    );
    const config = await createTestConfig({
      explicitIncludes: [],
      retentionDays: 180,
      aiEnabled: true,
    });
    const coldHarness = createCollectionHarness({
      repositories: [fixture],
      config,
      executeCodexAnalysis: executeSuccessfulCodexAnalysis,
    });

    expect((await coldHarness.runCollectAnalyze(FIRST_RUN_AT)).exitCode).toBe(0);
    const coldArtifact = requireCollectAnalyzeArtifact(coldHarness.artifacts);
    const currentEntryValue = coldArtifact.cacheOnlyPayload.aiCacheEntries[0];
    const currentItemCache = coldArtifact.cacheOnlyPayload.itemCaches[0];
    if (currentEntryValue == null || currentItemCache == null) {
      throw new TypeError("exact AI identity fixtureのcache payloadがありません");
    }
    const currentEntry = createAiCacheEntry(currentEntryValue);
    if (currentItemCache.aiCacheReference.status !== "available") {
      throw new TypeError("exact AI identity fixtureのitem cache参照がありません");
    }
    const incompatibleIdentity = Object.freeze({
      deterministicRulesVersion: currentEntry.metadata.deterministicRulesVersion,
      model: `${currentEntry.metadata.model}-incompatible`,
      reasoningEffort: currentEntry.metadata.reasoningEffort,
      backendVersion: currentEntry.metadata.backendVersion,
      promptVersion: currentEntry.metadata.promptVersion,
      schemaVersion: currentEntry.metadata.schemaVersion,
    });
    const incompatibleEntry = createAiCacheEntry({
      ...currentEntry,
      cacheKey: createAiCacheKey({
        ...incompatibleIdentity,
        inputHash: parseSha256Hash(currentEntry.metadata.inputHash),
      }),
      metadata: {
        ...currentEntry.metadata,
        model: incompatibleIdentity.model,
      },
    });
    const incompatibleItemCache = createCacheDocument({
      ...currentItemCache,
      aiCacheReference: {
        ...currentItemCache.aiCacheReference,
        cacheKey: incompatibleEntry.cacheKey,
        identityHash: hashCanonicalJson(incompatibleIdentity),
      },
    });
    if (incompatibleItemCache.kind !== "github_item") {
      throw new TypeError("exact AI identity fixtureのitem cacheを生成できません");
    }
    const warmHarness = createCollectionHarness({
      repositories: [fixture],
      config,
      executeCodexAnalysis: executeSuccessfulCodexAnalysis,
    });
    const session = await CacheOnlyPersistenceSession.open(
      warmHarness.stateAdapter,
      config.state,
      createPublicRepositoryAllowlist([repository]),
    );
    await session.persist({
      ...coldArtifact.cacheOnlyPayload,
      itemCaches: Object.freeze([incompatibleItemCache]),
      aiCacheEntries: Object.freeze([incompatibleEntry]),
      latestImportanceCaches: Object.freeze([]),
      evaluatedAt: observedAt,
      knownSecrets: Object.freeze([]),
    });

    const result = await warmHarness.runCollectAnalyze(FIRST_RUN_AT);

    expect(result.exitCode).toBe(0);
    expect(warmHarness.detailCalls).toEqual([
      {
        targets: [{ nodeId: item.nodeId }],
      },
    ]);
    expect(warmHarness.codexInputs).toHaveLength(1);
    if (result.command !== "collect-analyze") {
      throw new TypeError("exact AI identity fixtureがcollect-analyze結果ではありません");
    }
    expect(result.result.report.diagnostics).toContainEqual(
      expect.stringContaining("現在の解析versionと互換性がない"),
    );
  });

  it("exactな責務epochだけをresponsibility changed通知へ渡す", async () => {
    const repository = createRepository(
      "R_temporal_responsibility",
      "temporal-responsibility",
      FIRST_RUN_AT,
    );
    const fixture = createRepositoryFixture(repository);
    const observedAt = createUtcIsoDateTime(FIRST_RUN_AT);
    const assignedAt = createUtcIsoDateTime("2026-07-31T22:00:00.000Z");
    const assignee = Object.freeze({
      nodeId: createGitHubNodeId("U_temporal_responsibility"),
      login: "temporal-responsibility",
      apiType: "User",
    });
    const item = Object.freeze({
      ...createIssueItem({
        repository: requirePublicRepository(repository),
        number: 1,
        fingerprint: "temporal-responsibility",
        updatedAt: assignedAt,
        observedAt,
        state: Object.freeze({ state: "open" }),
      }),
      assignees: Object.freeze([assignee]),
      labels: Object.freeze(["優先度：高"]),
    });
    const detail = createIssueDetail({
      item,
      body: "担当者が決まりました",
      observedAt,
      nativeDependencies: Object.freeze([]),
      duplicateComments: false,
    });
    fixture.openItems = [item];
    fixture.details.set(
      item.nodeId,
      Object.freeze({
        ...detail,
        timeline: Object.freeze([
          Object.freeze({
            sourceId: buildSourceId("github_timeline_event", `${item.nodeId}:assigned`),
            nodeId: createGitHubNodeId(`${item.nodeId}:assigned`),
            sequence: 0,
            occurredAt: assignedAt,
            actor: Object.freeze({
              status: "identified",
              account: Object.freeze({
                sourceId: buildSourceId("github_account", assignee.nodeId),
                ...assignee,
              }),
            }),
            kind: "assigned",
            assignee: Object.freeze({
              type: "account",
              account: Object.freeze({
                sourceId: buildSourceId("github_account", assignee.nodeId),
                ...assignee,
              }),
            }),
          } satisfies GitHubTimelineEvent),
        ]),
      }),
    );
    const config = await createTestConfig({
      explicitIncludes: [],
      retentionDays: 180,
      aiEnabled: false,
    });
    const harness = createCollectionHarness({
      repositories: [fixture],
      config,
      scheduledRun: true,
    });

    const result = await harness.runCollectAnalyze(FIRST_RUN_AT);
    const artifact = requireCollectAnalyzeArtifact(harness.artifacts);
    const candidate = artifact.notificationSelection.candidates.find(
      (current) => current.itemNodeId === item.nodeId,
    );

    expect(result.exitCode).toBe(0);
    expect(candidate?.reasons).toContainEqual({ reasonCode: "responsibility_changed" });
  });

  it("workflow_dispatchは非08:00時刻でも通知項目を作らず通常digestをskipする", async () => {
    const repository = createRepository(
      "R_manual_notification_window",
      "manual-notification-window",
      FIRST_RUN_AT,
    );
    const publicRepository = requirePublicRepository(repository);
    const fixture = createRepositoryFixture(repository);
    const observedAt = createUtcIsoDateTime(FIRST_RUN_AT);
    const assignedAt = createUtcIsoDateTime("2026-07-31T22:00:00.000Z");
    const assignee = Object.freeze({
      nodeId: createGitHubNodeId("U_manual_notification_window"),
      login: "manual-notification-window",
      apiType: "User",
    }) satisfies GitHubItemAccount;
    const item = Object.freeze({
      ...createIssueItem({
        repository: publicRepository,
        number: 1,
        fingerprint: "manual-notification-window",
        updatedAt: assignedAt,
        observedAt,
        state: Object.freeze({ state: "open" }),
      }),
      assignees: Object.freeze([assignee]),
    });
    const detail = createIssueDetail({
      item,
      body: "workflow_dispatchの通知時刻fixture",
      observedAt,
      nativeDependencies: Object.freeze([]),
      duplicateComments: false,
    });
    const account = Object.freeze({
      sourceId: buildSourceId("github_account", assignee.nodeId),
      ...assignee,
    });
    fixture.openItems = [item];
    fixture.details.set(
      item.nodeId,
      Object.freeze({
        ...detail,
        timeline: Object.freeze([
          Object.freeze({
            sourceId: buildSourceId("github_timeline_event", `${item.nodeId}:assigned`),
            nodeId: createGitHubNodeId(`${item.nodeId}:assigned`),
            sequence: 0,
            occurredAt: assignedAt,
            actor: Object.freeze({ status: "identified", account }),
            kind: "assigned",
            assignee: Object.freeze({ type: "account", account }),
          } satisfies GitHubTimelineEvent),
        ]),
      }),
    );
    const config = await createTestConfig({
      explicitIncludes: [],
      retentionDays: 180,
      aiEnabled: false,
    });
    const harness = createCollectionHarness({ repositories: [fixture], config });

    const result = await harness.runCollectAnalyzeAt(FIRST_RUN_AT, FIRST_RUN_AT);
    const artifact = requireCollectAnalyzeArtifact(harness.artifacts);

    expect(result.exitCode).toBe(0);
    expect(artifact.notificationSelection).toEqual({
      action: "skip_digest",
      reason: "manual",
      candidates: [],
    });
    expect(harness.normalDiscordCallCount()).toBe(0);
  });

  it("同時刻の責務addとremoveが相殺される場合はresponsibility changed通知を作らない", async () => {
    const repository = createRepository(
      "R_temporal_responsibility_noop",
      "temporal-responsibility-noop",
      FIRST_RUN_AT,
    );
    const fixture = createRepositoryFixture(repository);
    const observedAt = createUtcIsoDateTime(FIRST_RUN_AT);
    const responsibilityAt = createUtcIsoDateTime("2026-07-31T22:00:00.000Z");
    const assignee = Object.freeze({
      nodeId: createGitHubNodeId("U_temporal_responsibility_noop"),
      login: "temporal-responsibility-noop",
      apiType: "User",
    });
    const item = Object.freeze({
      ...createIssueItem({
        repository: requirePublicRepository(repository),
        number: 1,
        fingerprint: "temporal-responsibility-noop",
        updatedAt: responsibilityAt,
        observedAt,
        state: Object.freeze({ state: "open" }),
      }),
      labels: Object.freeze(["優先度：高"]),
    });
    const detail = createIssueDetail({
      item,
      body: "同時刻の責務変更",
      observedAt,
      nativeDependencies: Object.freeze([]),
      duplicateComments: false,
    });
    const account = Object.freeze({
      sourceId: buildSourceId("github_account", assignee.nodeId),
      ...assignee,
    });
    fixture.openItems = [item];
    fixture.details.set(
      item.nodeId,
      Object.freeze({
        ...detail,
        timeline: Object.freeze([
          Object.freeze({
            sourceId: buildSourceId("github_timeline_event", `${item.nodeId}:assigned`),
            nodeId: createGitHubNodeId(`${item.nodeId}:assigned`),
            sequence: 0,
            occurredAt: responsibilityAt,
            actor: Object.freeze({ status: "identified", account }),
            kind: "assigned",
            assignee: Object.freeze({ type: "account", account }),
          } satisfies GitHubTimelineEvent),
          Object.freeze({
            sourceId: buildSourceId("github_timeline_event", `${item.nodeId}:unassigned`),
            nodeId: createGitHubNodeId(`${item.nodeId}:unassigned`),
            sequence: 1,
            occurredAt: responsibilityAt,
            actor: Object.freeze({ status: "identified", account }),
            kind: "unassigned",
            assignee: Object.freeze({ type: "account", account }),
          } satisfies GitHubTimelineEvent),
        ]),
      }),
    );
    const config = await createTestConfig({
      explicitIncludes: [],
      retentionDays: 180,
      aiEnabled: false,
    });
    const harness = createCollectionHarness({
      repositories: [fixture],
      config,
      scheduledRun: true,
    });

    const result = await harness.runCollectAnalyze(FIRST_RUN_AT);
    const artifact = requireCollectAnalyzeArtifact(harness.artifacts);
    const candidate = artifact.notificationSelection.candidates.find(
      (current) => current.itemNodeId === item.nodeId,
    );

    expect(result.exitCode).toBe(0);
    expect(candidate?.reasons ?? []).not.toContainEqual({
      reasonCode: "responsibility_changed",
    });
  });

  it("cycleの作成と解消と再作成をexact eventから通知へ渡す", async () => {
    const repository = createRepository("R_temporal_cycle", "temporal-cycle", FIRST_RUN_AT);
    const publicRepository = requirePublicRepository(repository);
    const fixture = createRepositoryFixture(repository);
    const observedAt = createUtcIsoDateTime(FIRST_RUN_AT);
    const firstCycleAt = createUtcIsoDateTime("2026-07-31T20:00:00.000Z");
    const removedAt = createUtcIsoDateTime("2026-07-31T21:00:00.000Z");
    const recreatedAt = createUtcIsoDateTime("2026-07-31T22:00:00.000Z");
    const first = Object.freeze({
      ...createIssueItem({
        repository: publicRepository,
        number: 1,
        fingerprint: "temporal-cycle-first",
        updatedAt: recreatedAt,
        observedAt,
        state: Object.freeze({ state: "open" }),
      }),
      labels: Object.freeze(["優先度：高"]),
    });
    const second = Object.freeze({
      ...createIssueItem({
        repository: publicRepository,
        number: 2,
        fingerprint: "temporal-cycle-second",
        updatedAt: recreatedAt,
        observedAt,
        state: Object.freeze({ state: "open" }),
      }),
      labels: Object.freeze(["優先度：高"]),
    });
    const firstDetail = createIssueDetail({
      item: first,
      body: "二つ目の項目を待ちます",
      observedAt,
      nativeDependencies: Object.freeze([createNativeBlocker(first, second)]),
      duplicateComments: false,
    });
    const secondDetail = createIssueDetail({
      item: second,
      body: "一つ目の項目を待ちます",
      observedAt,
      nativeDependencies: Object.freeze([createNativeBlocker(second, first)]),
      duplicateComments: false,
    });
    fixture.openItems = [first, second];
    fixture.details.set(
      first.nodeId,
      Object.freeze({
        ...firstDetail,
        bodyUserContentEdits: Object.freeze({
          availability: "available",
          edits: Object.freeze([]),
        }),
        timeline: Object.freeze([
          createNativeDependencyTimelineEvent(first, second, "added", first.createdAt, 0),
        ]),
      }),
    );
    fixture.details.set(
      second.nodeId,
      Object.freeze({
        ...secondDetail,
        bodyUserContentEdits: Object.freeze({
          availability: "available",
          edits: Object.freeze([]),
        }),
        timeline: Object.freeze([
          createNativeDependencyTimelineEvent(second, first, "added", firstCycleAt, 0),
          createNativeDependencyTimelineEvent(second, first, "removed", removedAt, 1),
          createNativeDependencyTimelineEvent(second, first, "added", recreatedAt, 2),
        ]),
      }),
    );
    const config = await createTestConfig({
      explicitIncludes: [],
      retentionDays: 180,
      aiEnabled: false,
    });
    const harness = createCollectionHarness({
      repositories: [fixture],
      config,
      scheduledRun: true,
    });

    const result = await harness.runCollectAnalyze(FIRST_RUN_AT);
    const artifact = requireCollectAnalyzeArtifact(harness.artifacts);
    const cycleCandidates = artifact.notificationSelection.candidates.filter((candidate) =>
      candidate.reasons.some((reason) => reason.reasonCode === "dependency_cycle"),
    );

    expect(result.exitCode).toBe(0);
    expect(new Set(cycleCandidates.map((candidate) => candidate.itemNodeId))).toEqual(
      new Set([first.nodeId, second.nodeId]),
    );
    expect(artifact.snapshot.relations.filter((relation) => relation.active)).toHaveLength(2);
  });

  it("AI無効時もsemantic不整合なAI cache参照をfresh詳細で正規化する", async () => {
    const repository = createRepository(
      "R_disabled_invalid_ai_cache",
      "disabled-invalid-ai-cache",
      FIRST_RUN_AT,
    );
    const fixture = createRepositoryFixture(repository);
    const observedAt = createUtcIsoDateTime(FIRST_RUN_AT);
    const fingerprint = "@requested-user に対応をお願いします";
    const item = createIssueItem({
      repository: requirePublicRepository(repository),
      number: 1,
      fingerprint,
      updatedAt: observedAt,
      observedAt,
      state: Object.freeze({ state: "open" }),
    });
    fixture.openItems = [item];
    fixture.details.set(
      item.nodeId,
      createIssueDetail({
        item,
        body: `body-${fingerprint}`,
        observedAt,
        nativeDependencies: Object.freeze([]),
        duplicateComments: false,
      }),
    );
    const enabledConfig = await createTestConfig({
      explicitIncludes: [],
      retentionDays: 180,
      aiEnabled: true,
    });
    const harness = createCollectionHarness({
      repositories: [fixture],
      config: enabledConfig,
      executeCodexAnalysis: executeSuccessfulCodexAnalysis,
    });

    expect((await harness.runDaily(FIRST_RUN_AT)).exitCode).toBe(0);
    expect(harness.codexExecutionCount()).toBe(1);
    const head = await harness.stateAdapter.resolveHead("tracker-state-v3");
    if (head.status !== "present") {
      throw new TypeError("AI cache不整合fixtureのstate branchがありません");
    }
    const files = await harness.stateAdapter.readBranchFiles("tracker-state-v3");
    const aiCacheFiles = [...files].filter(([path]) => path.startsWith("state/ai-results/"));
    if (aiCacheFiles.length !== 1) {
      throw new TypeError(
        `AI cache不整合fixtureのentry数が不正です。件数: ${aiCacheFiles.length.toString()}`,
      );
    }
    const aiCacheFile = aiCacheFiles[0];
    if (aiCacheFile == null) {
      throw new TypeError("AI cache不整合fixtureのentryがありません");
    }
    const [aiCachePath, aiCacheBytes] = aiCacheFile;
    const entry = createAiCacheEntry(JSON.parse(new TextDecoder().decode(aiCacheBytes)));
    const evidence = entry.output.evidence[0];
    if (evidence == null) {
      throw new TypeError("AI cache不整合fixtureのevidenceがありません");
    }
    const invalidOutput = Object.freeze({
      ...entry.output,
      evidence: Object.freeze([
        Object.freeze({
          ...evidence,
          sourceId: buildSourceId("github_item_body", "I_semantic_invalid_source"),
        }),
      ]),
    });
    const invalidEntry = createAiCacheEntry({
      ...entry,
      metadata: {
        ...entry.metadata,
        outputHash: hashCanonicalJson(invalidOutput),
      },
      output: invalidOutput,
    });
    await harness.stateAdapter.commit({
      branch: "tracker-state-v3",
      expectedHead: head,
      updates: [
        {
          path: aiCachePath,
          bytes: new TextEncoder().encode(`${serializeCanonicalJson(invalidEntry)}\n`),
        },
      ],
      deletions: [],
      message: "semantic不整合AI cache fixture",
      committedAt: FIRST_RUN_AT,
    });
    const disabledConfig = await createTestConfig({
      explicitIncludes: [],
      retentionDays: 180,
      aiEnabled: false,
    });
    harness.setConfig(disabledConfig);
    harness.detailCalls.length = 0;

    const result = await harness.runDaily(SECOND_RUN_AT);
    if (result.command !== "daily") {
      throw new TypeError("AI cache不整合fixtureがdaily結果ではありません");
    }
    const session = await CacheOnlyPersistenceSession.open(
      harness.stateAdapter,
      disabledConfig.state,
      createPublicRepositoryAllowlist([repository]),
    );
    const loaded = await session.load({
      evaluatedAt: createUtcIsoDateTime(SECOND_RUN_AT),
      knownSecrets: [],
    });
    if (loaded.status !== "available") {
      throw new TypeError("正規化後のAI cacheを読み取れません");
    }

    expect(result.exitCode).toBe(0);
    expect(harness.detailCalls).toEqual([
      {
        targets: [{ nodeId: item.nodeId }],
      },
    ]);
    expect(harness.codexExecutionCount()).toBe(1);
    expect(result.result.report.diagnostics).toContainEqual(
      expect.stringContaining(
        "warm cacheのAI semantic validationに失敗したためfresh詳細を再取得します",
      ),
    );
    expect(loaded.itemCaches).toHaveLength(1);
    expect(loaded.itemCaches[0]).toMatchObject({
      nodeId: item.nodeId,
      aiAnalysisStatus: "disabled",
      aiCacheReference: { status: "unavailable" },
    });
    expect(loaded.aiCacheEntries).toEqual([]);
  });

  it("open列挙にないclosed項目を明示includeから個別取得する", async () => {
    const repository = createRepository("R_explicit", "explicit", FIRST_RUN_AT);
    const publicRepository = requirePublicRepository(repository);
    const fixture = createRepositoryFixture(repository);
    const observedAt = createUtcIsoDateTime(FIRST_RUN_AT);
    const item = createIssueItem({
      repository: publicRepository,
      number: 1,
      fingerprint: "closed-explicit",
      updatedAt: observedAt,
      observedAt,
      state: Object.freeze({
        state: "closed",
        closedAt: observedAt,
      }),
    });
    fixture.individualItems.set(item.url, item);
    setIssueDetails(fixture, [item], observedAt);
    const config = await createTestConfig({
      explicitIncludes: [item.url],
      retentionDays: 180,
      aiEnabled: false,
    });
    const harness = createCollectionHarness({ repositories: [fixture], config });

    const result = await harness.runDry(FIRST_RUN_AT);
    const snapshot = requireDryRunSnapshot(harness.artifacts);

    expect(result.exitCode).toBe(0);
    expect(harness.individualCalls).toContainEqual([item.url]);
    expect(harness.detailCalls[0]?.targets.map((target) => target.nodeId)).toEqual([item.nodeId]);
    expect(snapshot.items[0]).toMatchObject({
      nodeId: item.nodeId,
      state: "closed",
      status: "terminal_completed",
    });
  });

  it("Codex出力検証違反の要約をrun reportのdiagnosticsへ載せる", async () => {
    const repository = createRepository(
      "R_codex_validation_diagnostic",
      "codex-validation-diagnostic",
      FIRST_RUN_AT,
    );
    const fixture = createRepositoryFixture(repository);
    const observedAt = createUtcIsoDateTime(FIRST_RUN_AT);
    const item = createIssueItem({
      repository: requirePublicRepository(repository),
      number: 1,
      fingerprint: "codex-validation-diagnostic",
      updatedAt: observedAt,
      observedAt,
      state: Object.freeze({ state: "open" }),
    });
    fixture.openItems = [item];
    fixture.details.set(
      item.nodeId,
      createIssueDetail({
        item,
        body: "@requested-user に対応をお願いします",
        observedAt,
        nativeDependencies: Object.freeze([]),
        duplicateComments: false,
      }),
    );
    const config = await createTestConfig({
      explicitIncludes: [],
      retentionDays: 180,
      aiEnabled: true,
    });
    const harness = createCollectionHarness({
      repositories: [fixture],
      config,
      executeCodexAnalysis: (input) => {
        const bodySource = input.sources.find((source) => source.kind === "body");
        if (bodySource == null) {
          throw new TypeError("検証違反diagnostic fixtureのbody sourceがありません");
        }
        const output = createCodexOutput(input, {
          status: "in_progress",
          waitingOn: {
            candidateId: "requested-user",
            kind: "user",
            role: "assignee",
            sourceId: bodySource.id,
          },
          latestMeaningfulSourceId: null,
          confidence: 0.9,
          relationVerdict: "related",
          notification: {
            recommended: false,
            reasonCode: "none",
            reasonSummary: "通知しません",
          },
        });
        return Promise.resolve({
          ...output,
          item: {
            ...output.item,
            nodeId: "I_other",
          },
        });
      },
    });

    const result = await harness.runDry(FIRST_RUN_AT);
    if (result.command !== "dry-run") {
      throw new TypeError("検証違反diagnostic fixtureがdry-run結果を返しませんでした");
    }
    const snapshot = requireDryRunSnapshot(harness.artifacts);

    expect(result.exitCode).toBe(0);
    expect(snapshot.ai).toEqual({
      enabled: true,
      available: false,
      degraded: true,
    });
    expect(snapshot.items[0]?.aiAnalysis).toEqual({
      status: "failed",
    });
    expect(result.result.report.diagnostics).toContain(
      `codex_fallback item=${item.nodeId} reason=semantic_validation_failed errorType=CodexOutputSemanticValidationError validationIssueCount=1 validationIssue0Path=/item/nodeId validationIssue0Code=item_node_id_mismatch`,
    );
  });

  it("reviewとcheckの集約状態をsnapshotと公開DTOへ保存する", async () => {
    const repository = createRepository("R_pr_aggregate", "pr-aggregate", FIRST_RUN_AT);
    const publicRepository = requirePublicRepository(repository);
    const fixture = createRepositoryFixture(repository);
    const observedAt = createUtcIsoDateTime(FIRST_RUN_AT);
    const item = createPullRequestItem({
      repository: publicRepository,
      number: 1,
      fingerprint: "aggregate-state",
      updatedAt: observedAt,
      observedAt,
    });
    const detail = createFailedCheckPullRequestDetail(item, observedAt);
    fixture.openItems = [item];
    fixture.details.set(
      item.nodeId,
      Object.freeze({
        ...detail,
        reviews: Object.freeze([
          Object.freeze({
            sourceId: buildSourceId("github_pull_request_review", "approved"),
            nodeId: createGitHubNodeId("V_approved"),
            sequence: 0,
            state: "approved",
            author: Object.freeze({
              status: "identified",
              account: Object.freeze({
                sourceId: buildSourceId("github_account", "U_reviewer"),
                nodeId: createGitHubNodeId("U_reviewer"),
                login: "reviewer",
                apiType: "User",
              }),
            }),
            commit: Object.freeze({
              status: "available",
              sourceId: detail.headCommit.sourceId,
              nodeId: detail.headCommit.nodeId,
              sha: detail.headSha,
            }),
            submittedAt: observedAt,
            body: "承認します",
            url: `${item.url}#pullrequestreview-1`,
          } satisfies (typeof detail.reviews)[number]),
        ]),
      }),
    );
    const config = await createTestConfig({
      explicitIncludes: [],
      retentionDays: 180,
      aiEnabled: false,
    });
    const harness = createCollectionHarness({ repositories: [fixture], config });

    const result = await harness.runCollectAnalyze(FIRST_RUN_AT);
    const artifact = requireCollectAnalyzeArtifact(harness.artifacts);
    const snapshot = artifact.snapshot;
    const snapshotItem = snapshot.items.find((candidate) => candidate.nodeId === item.nodeId);
    const publicItem = artifact.pages.details.items.find(
      (candidate) => candidate.summary.nodeId === item.nodeId,
    );

    expect(result.exitCode).toBe(0);
    expect(snapshotItem).toMatchObject({
      reviewState: "approved",
      checkState: "failing",
    });
    expect(publicItem).toMatchObject({
      reviewState: "approved",
      checkState: "failing",
    });
  });

  it("Pull Requestのreview本文をcontent付きsourceとしてCodexへ渡す", async () => {
    const repository = createRepository("R_codex_review", "codex-review", FIRST_RUN_AT);
    const publicRepository = requirePublicRepository(repository);
    const fixture = createRepositoryFixture(repository);
    const observedAt = createUtcIsoDateTime(FIRST_RUN_AT);
    const item = createPullRequestItem({
      repository: publicRepository,
      number: 1,
      fingerprint: "review-content",
      updatedAt: observedAt,
      observedAt,
    });
    const detail = createFailedCheckPullRequestDetail(item, observedAt);
    const reviewer = Object.freeze({
      status: "identified",
      account: Object.freeze({
        sourceId: buildSourceId("github_account", "U_review_content"),
        nodeId: createGitHubNodeId("U_review_content"),
        login: "review-content",
        apiType: "User",
      }),
    } satisfies (typeof detail.reviews)[number]["author"]);
    const reviewSourceId = buildSourceId("github_pull_request_review", "V_review_content");
    const emptyReviewSourceId = buildSourceId("github_pull_request_review", "V_empty_review");
    const commentSourceId = buildSourceId(
      "github_pull_request_review_comment",
      "PRRC_review_content",
    );
    fixture.openItems = [item];
    fixture.details.set(
      item.nodeId,
      Object.freeze({
        ...detail,
        reviews: Object.freeze([
          Object.freeze({
            sourceId: reviewSourceId,
            nodeId: createGitHubNodeId("V_review_content"),
            sequence: 0,
            state: "commented",
            author: reviewer,
            commit: Object.freeze({
              status: "available",
              sourceId: detail.headCommit.sourceId,
              nodeId: detail.headCommit.nodeId,
              sha: detail.headSha,
            }),
            submittedAt: observedAt,
            body: "レビュー全体の確認事項です",
            url: `${item.url}#pullrequestreview-1`,
          } satisfies (typeof detail.reviews)[number]),
          Object.freeze({
            sourceId: emptyReviewSourceId,
            nodeId: createGitHubNodeId("V_empty_review"),
            sequence: 1,
            state: "dismissed",
            author: reviewer,
            commit: Object.freeze({
              status: "available",
              sourceId: detail.headCommit.sourceId,
              nodeId: detail.headCommit.nodeId,
              sha: detail.headSha,
            }),
            submittedAt: observedAt,
            body: "",
            url: `${item.url}#pullrequestreview-2`,
          } satisfies (typeof detail.reviews)[number]),
        ]),
        reviewThreads: Object.freeze([
          Object.freeze({
            sourceId: buildSourceId("github_pull_request_review_thread", "PRRT_review_content"),
            nodeId: createGitHubNodeId("PRRT_review_content"),
            sequence: 0,
            isResolved: true,
            isOutdated: false,
            path: "src/example.ts",
            resolvedBy: reviewer,
            comments: Object.freeze([
              Object.freeze({
                sourceId: commentSourceId,
                nodeId: createGitHubNodeId("PRRC_review_content"),
                sequence: 0,
                author: reviewer,
                body: "この条件は必要でしょうか",
                createdAt: observedAt,
                lastEditedAt: null,
                updatedAt: observedAt,
                url: `${item.url}#discussion_r1`,
                userContentEdits: Object.freeze({
                  availability: "unavailable",
                  reason: "connection_null",
                }),
              } satisfies (typeof detail.reviewThreads)[number]["comments"][number]),
            ]),
          } satisfies (typeof detail.reviewThreads)[number]),
        ]),
      }),
    );
    const config = await createTestConfig({
      explicitIncludes: [],
      retentionDays: 180,
      aiEnabled: true,
    });
    const harness = createCollectionHarness({
      repositories: [fixture],
      config,
      executeCodexAnalysis: (input) =>
        Promise.resolve(
          createCodexOutput(input, {
            status: "in_progress",
            waitingOn: {
              candidateId: requireCodexAuthorCandidateId(input),
              kind: "user",
              role: "assignee",
              sourceId: commentSourceId,
            },
            latestMeaningfulSourceId: commentSourceId,
            confidence: 0.95,
            relationVerdict: "related",
            notification: {
              recommended: false,
              reasonCode: "none",
              reasonSummary: "通知しません",
            },
          }),
        ),
    });

    const result = await harness.runDry(FIRST_RUN_AT);
    const input = harness.codexInputs[0];
    if (input == null) {
      throw new TypeError("review本文を確認するCodex入力がありません");
    }

    expect(result.exitCode).toBe(0);
    expect(input.sources.filter((source) => source.id === commentSourceId)).toEqual([
      {
        id: commentSourceId,
        kind: "comment",
        actorType: "human",
        createdAt: observedAt,
        content: "この条件は必要でしょうか",
      },
    ]);
    expect(input.sources.filter((source) => source.id === reviewSourceId)).toEqual([
      {
        id: reviewSourceId,
        kind: "review",
        actorType: "human",
        createdAt: observedAt,
        content: "レビュー全体の確認事項です",
      },
    ]);
    expect(input.sources.filter((source) => source.id === emptyReviewSourceId)).toEqual([
      {
        id: emptyReviewSourceId,
        kind: "review",
        actorType: "human",
        createdAt: observedAt,
        content: "",
      },
    ]);
  });

  it("時刻付きの現行review requestをsource recordとしてCodexへ渡す", async () => {
    const repository = createRepository(
      "R_codex_review_request",
      "codex-review-request",
      FIRST_RUN_AT,
    );
    const publicRepository = requirePublicRepository(repository);
    const fixture = createRepositoryFixture(repository);
    const observedAt = createUtcIsoDateTime(FIRST_RUN_AT);
    const requestedAt = createUtcIsoDateTime("2026-07-31T12:00:00.000Z");
    const item = createPullRequestItem({
      repository: publicRepository,
      number: 1,
      fingerprint: "review-request-source",
      updatedAt: observedAt,
      observedAt,
    });
    const detail = createFailedCheckPullRequestDetail(item, observedAt);
    const activityComment = createDuplicateComments(item, requestedAt)[0];
    if (activityComment == null) {
      throw new TypeError("review request用のhuman commentがありません");
    }
    const reviewRequestNodeId = createGitHubNodeId("RR_codex_review_request");
    const reviewRequestSourceId = buildSourceId("github_review_request", reviewRequestNodeId);
    const reviewerNodeId = createGitHubNodeId("U_codex_review_request");
    fixture.openItems = [item];
    fixture.details.set(
      item.nodeId,
      Object.freeze({
        ...detail,
        comments: Object.freeze([activityComment]),
        timeline: Object.freeze([
          Object.freeze({
            sourceId: buildSourceId("github_timeline_event", reviewRequestNodeId),
            nodeId: createGitHubNodeId("TRR_codex_review_request"),
            sequence: 0,
            occurredAt: requestedAt,
            actor: Object.freeze({
              status: "unavailable",
              reason: "github_did_not_return_actor",
            }),
            kind: "review_requested",
            target: Object.freeze({
              type: "user",
              sourceId: buildSourceId("github_user", reviewerNodeId),
              nodeId: reviewerNodeId,
              login: "codex-reviewer",
              apiType: "User",
            }),
          } satisfies GitHubTimelineEvent),
        ]),
        reviewRequests: Object.freeze({
          current: Object.freeze([
            Object.freeze({
              sourceId: reviewRequestSourceId,
              nodeId: reviewRequestNodeId,
              target: Object.freeze({
                type: "user",
                sourceId: buildSourceId("github_user", reviewerNodeId),
                nodeId: reviewerNodeId,
                login: "codex-reviewer",
                apiType: "User",
              }),
              requestedAt: Object.freeze({
                status: "available",
                value: requestedAt,
              }),
            }),
          ]),
          history: Object.freeze([]),
        }),
        mergeState: Object.freeze({
          ...detail.mergeState,
          checks: Object.freeze({
            status: "not_configured",
          }),
        }),
      }),
    );
    const config = await createTestConfig({
      explicitIncludes: [],
      retentionDays: 180,
      aiEnabled: true,
    });
    const harness = createCollectionHarness({
      repositories: [fixture],
      config,
      executeCodexAnalysis: (input) =>
        Promise.resolve(
          createCodexOutput(input, {
            status: "waiting_for_review",
            waitingOn: {
              candidateId: "codex-reviewer",
              kind: "user",
              role: "reviewer",
              sourceId: reviewRequestSourceId,
            },
            latestMeaningfulSourceId: activityComment.sourceId,
            confidence: 0.95,
            relationVerdict: "related",
            notification: {
              recommended: false,
              reasonCode: "none",
              reasonSummary: "通知しません",
            },
          }),
        ),
    });

    const result = await harness.runDry(FIRST_RUN_AT);
    const input = harness.codexInputs[0];
    if (input == null) {
      throw new TypeError("review requestを確認するCodex入力がありません");
    }

    expect(result.exitCode).toBe(0);
    expect(input.sources.filter((source) => source.id === reviewRequestSourceId)).toEqual([
      {
        id: reviewRequestSourceId,
        kind: "review_request",
        actorType: "system",
        createdAt: requestedAt,
      },
    ]);
    expect(input.deterministicSignals["waitingOn"]).toMatchObject([
      {
        candidateId: "codex-reviewer",
        sourceIds: [reviewRequestSourceId],
      },
    ]);
  });

  it("review threadの現在状態IDを使わずcomment sourceへ根拠を差し替える", async () => {
    const repository = createRepository(
      "R_codex_review_thread",
      "codex-review-thread",
      FIRST_RUN_AT,
    );
    const publicRepository = requirePublicRepository(repository);
    const fixture = createRepositoryFixture(repository);
    const observedAt = createUtcIsoDateTime(FIRST_RUN_AT);
    const commentAt = createUtcIsoDateTime("2026-07-31T12:00:00.000Z");
    const item = createPullRequestItem({
      repository: publicRepository,
      number: 1,
      fingerprint: "review-thread-source",
      updatedAt: observedAt,
      observedAt,
    });
    const detail = createFailedCheckPullRequestDetail(item, observedAt);
    const reviewer = Object.freeze({
      status: "identified",
      account: Object.freeze({
        sourceId: buildSourceId("github_account", "U_codex_review_thread"),
        nodeId: createGitHubNodeId("U_codex_review_thread"),
        login: "thread-reviewer",
        apiType: "User",
      }),
    } satisfies (typeof detail.reviewThreads)[number]["resolvedBy"]);
    const threadSourceId = buildSourceId(
      "github_pull_request_review_thread",
      "PRRT_codex_review_thread",
    );
    const commentSourceId = buildSourceId(
      "github_pull_request_review_comment",
      "PRRC_codex_review_thread",
    );
    fixture.openItems = [item];
    fixture.details.set(
      item.nodeId,
      Object.freeze({
        ...detail,
        reviewThreads: Object.freeze([
          Object.freeze({
            sourceId: threadSourceId,
            nodeId: createGitHubNodeId("PRRT_codex_review_thread"),
            sequence: 0,
            isResolved: false,
            isOutdated: false,
            path: "src/example.ts",
            resolvedBy: reviewer,
            comments: Object.freeze([
              Object.freeze({
                sourceId: commentSourceId,
                nodeId: createGitHubNodeId("PRRC_codex_review_thread"),
                sequence: 0,
                author: reviewer,
                body: "この条件を修正してください",
                createdAt: commentAt,
                lastEditedAt: null,
                updatedAt: commentAt,
                url: `${item.url}#discussion_r_codex_review_thread`,
                userContentEdits: Object.freeze({
                  availability: "unavailable",
                  reason: "connection_null",
                }),
              } satisfies (typeof detail.reviewThreads)[number]["comments"][number]),
            ]),
          } satisfies (typeof detail.reviewThreads)[number]),
        ]),
        mergeState: Object.freeze({
          ...detail.mergeState,
          checks: Object.freeze({
            status: "not_configured",
          }),
        }),
      }),
    );
    const config = await createTestConfig({
      explicitIncludes: [],
      retentionDays: 180,
      aiEnabled: true,
    });
    const harness = createCollectionHarness({
      repositories: [fixture],
      config,
      executeCodexAnalysis: (input) =>
        Promise.resolve(
          createCodexOutput(input, {
            status: "waiting_for_revision",
            waitingOn: {
              candidateId: requireCodexAuthorCandidateId(input),
              kind: "user",
              role: "author",
              sourceId: commentSourceId,
            },
            latestMeaningfulSourceId: commentSourceId,
            confidence: 0.95,
            relationVerdict: "related",
            notification: {
              recommended: false,
              reasonCode: "none",
              reasonSummary: "通知しません",
            },
          }),
        ),
    });

    const result = await harness.runDry(FIRST_RUN_AT);
    const input = harness.codexInputs[0];
    if (input == null) {
      throw new TypeError("review threadを確認するCodex入力がありません");
    }

    expect(result.exitCode).toBe(0);
    expect(input.sources.some((source) => source.id === threadSourceId)).toBe(false);
    expect(input.sources.some((source) => source.id === commentSourceId)).toBe(true);
    expect(input.deterministicSignals["waitingOn"]).toMatchObject([
      {
        sourceIds: [commentSourceId],
      },
    ]);
    expect(input.candidates.waitingOn).toContainEqual(
      expect.objectContaining({
        sourceIds: [commentSourceId],
      }),
    );
  });

  it("auto-mergeをrecord化しmerge queueを追加イベントへ差し替える", async () => {
    const repository = createRepository("R_codex_automation", "codex-automation", FIRST_RUN_AT);
    const publicRepository = requirePublicRepository(repository);
    const fixture = createRepositoryFixture(repository);
    const observedAt = createUtcIsoDateTime(FIRST_RUN_AT);
    const queuedAt = createUtcIsoDateTime("2026-07-31T10:00:00.000Z");
    const autoMergeEnabledAt = createUtcIsoDateTime("2026-07-31T11:00:00.000Z");
    const item = createPullRequestItem({
      repository: publicRepository,
      number: 1,
      fingerprint: "automation-source",
      updatedAt: observedAt,
      observedAt,
    });
    const detail = createFailedCheckPullRequestDetail(item, observedAt);
    const activityComment = createDuplicateComments(item, autoMergeEnabledAt)[0];
    if (activityComment == null) {
      throw new TypeError("automation用のhuman commentがありません");
    }
    const actor = Object.freeze({
      status: "identified",
      account: Object.freeze({
        sourceId: buildSourceId("github_account", "U_codex_automation"),
        nodeId: createGitHubNodeId("U_codex_automation"),
        login: "automation-operator",
        apiType: "User",
      }),
    } satisfies (typeof detail.reviews)[number]["author"]);
    const mergeQueueSourceId = buildSourceId("github_merge_queue_entry", "MQE_codex_automation");
    const queueEventSourceId = buildSourceId("github_timeline_event", "ATMQE_codex_automation");
    const autoMergeSourceId = buildSourceId("github_auto_merge_request", item.nodeId);
    const autoMergeEventSourceId = buildSourceId("github_timeline_event", "AMEE_codex_automation");
    fixture.openItems = [item];
    fixture.details.set(
      item.nodeId,
      Object.freeze({
        ...detail,
        comments: Object.freeze([activityComment]),
        timeline: Object.freeze([
          Object.freeze({
            sourceId: queueEventSourceId,
            nodeId: createGitHubNodeId("ATMQE_codex_automation"),
            sequence: 0,
            occurredAt: queuedAt,
            actor,
            kind: "added_to_merge_queue",
          } satisfies GitHubTimelineEvent),
          Object.freeze({
            sourceId: autoMergeEventSourceId,
            nodeId: createGitHubNodeId("AMEE_codex_automation"),
            sequence: 1,
            occurredAt: autoMergeEnabledAt,
            actor,
            kind: "auto_merge_enabled",
          } satisfies GitHubTimelineEvent),
        ]),
        mergeState: Object.freeze({
          ...detail.mergeState,
          autoMerge: Object.freeze({
            status: "enabled",
            sourceId: autoMergeSourceId,
            enabledAt: autoMergeEnabledAt,
            enabledBy: actor,
            mergeMethod: "squash",
          }),
          mergeQueue: Object.freeze({
            status: "queued",
            sourceId: mergeQueueSourceId,
            nodeId: createGitHubNodeId("MQE_codex_automation"),
          }),
          checks: Object.freeze({
            status: "not_configured",
          }),
        }),
      }),
    );
    const config = await createTestConfig({
      explicitIncludes: [],
      retentionDays: 180,
      aiEnabled: true,
    });
    const harness = createCollectionHarness({
      repositories: [fixture],
      config,
      executeCodexAnalysis: (input) =>
        Promise.resolve(
          createCodexOutput(input, {
            status: "waiting_for_automation",
            waitingOn: {
              candidateId: "merge_queue",
              kind: "automation",
              role: "ci",
              sourceId: queueEventSourceId,
            },
            latestMeaningfulSourceId: activityComment.sourceId,
            confidence: 0.95,
            relationVerdict: "related",
            notification: {
              recommended: false,
              reasonCode: "none",
              reasonSummary: "通知しません",
            },
          }),
        ),
    });

    const result = await harness.runDry(FIRST_RUN_AT);
    const input = harness.codexInputs[0];
    if (input == null) {
      throw new TypeError("automationを確認するCodex入力がありません");
    }

    expect(result.exitCode).toBe(0);
    expect(input.sources.filter((source) => source.id === autoMergeSourceId)).toEqual([
      {
        id: autoMergeSourceId,
        kind: "auto_merge_request",
        actorType: "human",
        createdAt: autoMergeEnabledAt,
        mergeMethod: "squash",
      },
    ]);
    expect(input.sources.some((source) => source.id === mergeQueueSourceId)).toBe(false);
    expect(input.sources.some((source) => source.id === queueEventSourceId)).toBe(true);
    expect(input.sources.some((source) => source.id === autoMergeEventSourceId)).toBe(true);
    expect(input.deterministicSignals["waitingOn"]).toMatchObject([
      {
        candidateId: "merge_queue",
        sourceIds: [queueEventSourceId],
      },
      {
        candidateId: "auto_merge",
        sourceIds: [autoMergeSourceId],
      },
    ]);
  });

  it("mentionの明示依頼とhuman commentの意味判定を状態と進捗時刻へ反映する", async () => {
    const repository = createRepository("R_codex_issue", "codex-issue", FIRST_RUN_AT);
    const fixture = createRepositoryFixture(repository);
    const observedAt = createUtcIsoDateTime(FIRST_RUN_AT);
    const item = createIssueItem({
      repository: requirePublicRepository(repository),
      number: 1,
      fingerprint: "mention-progress",
      updatedAt: observedAt,
      observedAt,
      state: Object.freeze({ state: "open" }),
    });
    const meaningfulAt = createUtcIsoDateTime("2026-07-31T20:00:00.000Z");
    const commentFixture = createDuplicateComments(item, meaningfulAt)[0];
    if (commentFixture == null) {
      throw new TypeError("進捗判定用commentがありません");
    }
    const meaningfulComment = Object.freeze({
      ...commentFixture,
      body: "依頼された調査へ回答し、結論を共有しました",
    });
    const chatCommentNodeId = createGitHubNodeId(`IC_chat_${item.nodeId}`);
    const chatComment = Object.freeze({
      ...commentFixture,
      sourceId: buildSourceId("github_issue_comment", chatCommentNodeId),
      nodeId: chatCommentNodeId,
      sequence: 1,
      author: Object.freeze({
        status: "identified",
        account: Object.freeze({
          sourceId: buildSourceId("github_account", "U_chat_commenter"),
          nodeId: createGitHubNodeId("U_chat_commenter"),
          login: "chat-commenter",
          apiType: "User",
        }),
      }),
      body: "ありがとうございます。今日は暑いですね",
      createdAt: observedAt,
      lastEditedAt: null,
      updatedAt: observedAt,
      url: `${item.url}#issuecomment-${chatCommentNodeId}`,
      userContentEdits: Object.freeze({
        availability: "unavailable",
        reason: "connection_null",
      }),
    } satisfies GitHubIssueComment);
    const comments = Object.freeze([meaningfulComment, chatComment]);
    fixture.openItems = [item];
    fixture.details.set(
      item.nodeId,
      Object.freeze({
        ...createIssueDetail({
          item,
          body: "@requested-user に対応をお願いします",
          observedAt,
          nativeDependencies: Object.freeze([]),
          duplicateComments: false,
        }),
        comments,
      }),
    );
    const config = await createTestConfig({
      explicitIncludes: [],
      retentionDays: 180,
      aiEnabled: true,
    });
    const harness = createCollectionHarness({
      repositories: [fixture],
      config,
      executeCodexAnalysis: (input) => {
        const bodySource = input.sources.find((source) => source.kind === "body");
        if (bodySource == null) {
          throw new TypeError("Codex入力にbody sourceがありません");
        }
        return Promise.resolve(
          createCodexOutput(input, {
            status: "waiting_for_reply",
            waitingOn: {
              candidateId: "requested-user",
              kind: "user",
              role: "respondent",
              sourceId: bodySource.id,
            },
            latestMeaningfulSourceId: meaningfulComment.sourceId,
            confidence: 0.95,
            relationVerdict: "related",
            notification: {
              recommended: false,
              reasonCode: "none",
              reasonSummary: "通知しません",
            },
          }),
        );
      },
    });

    const result = await harness.runCollectAnalyze(FIRST_RUN_AT);
    const artifact = requireCollectAnalyzeArtifact(harness.artifacts);
    const snapshot = artifact.snapshot;
    const input = harness.codexInputs[0];
    const trackedItem = snapshot.items[0];
    if (trackedItem?.aiAnalysis.status !== "used") {
      throw new TypeError("判定からAI cache entryを参照できません");
    }
    const aiAnalysis = trackedItem.aiAnalysis;
    const cacheSource = artifact.cacheOnlyPayload.aiCacheEntries.find(
      (entry) => entry.cacheKey === aiAnalysis.cacheKey,
    );
    if (cacheSource == null) {
      throw new TypeError("判定が参照するAI cache entryがありません");
    }
    const cacheEntry = cacheSource;
    const publicItem = artifact.pages.details.items.find(
      (candidate) => candidate.summary.nodeId === item.nodeId,
    );

    expect(result.exitCode).toBe(0);
    expect(input?.candidates.waitingOn.map((candidate) => candidate.id)).toContain(
      "requested-user",
    );
    const mentionedWaitingOnCandidates = z
      .array(
        z.object({
          id: z.string(),
          kind: z.enum(["user", "team"]),
        }),
      )
      .parse(input?.deterministicSignals["mentionedWaitingOnCandidates"]);
    expect(
      mentionedWaitingOnCandidates
        .map((candidate) => ({ id: candidate.id, kind: candidate.kind }))
        .sort((left, right) => left.id.localeCompare(right.id)),
    ).toEqual([{ id: "requested-user", kind: "user" }]);
    expect(trackedItem).toMatchObject({
      status: "waiting_for_reply",
      lastHumanActivityAt: FIRST_RUN_AT,
      lastProgressAt: meaningfulAt,
      author: {
        status: "identified",
        actor: {
          login: "author-1",
        },
      },
      latestEventActor: {
        status: "present",
        actor: {
          login: "chat-commenter",
        },
      },
      waitingOn: [
        expect.objectContaining({
          candidateId: "requested-user",
          kind: "user",
          role: "respondent",
        }),
      ],
    });
    expect(cacheEntry.cacheKey).toBe(trackedItem.aiAnalysis.cacheKey);
    expect(cacheEntry.metadata).toEqual({
      deterministicRulesVersion: DETERMINISTIC_RULES_VERSION,
      model: config.ai.model,
      reasoningEffort: config.ai.execution.reasoningEffort,
      backendVersion: "codex-cli-0.145.0",
      promptVersion: config.ai.promptVersion,
      schemaVersion: "2",
      inputHash: cacheEntry.metadata.inputHash,
      outputHash: cacheEntry.metadata.outputHash,
      executedAt: FIRST_RUN_AT,
    });
    expect(cacheEntry.metadata.inputHash).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(cacheEntry.metadata.outputHash).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(trackedItem.inputEvents).toEqual(
      expect.arrayContaining([
        {
          sourceId: meaningfulComment.sourceId,
          url: meaningfulComment.url,
        },
        {
          sourceId: chatComment.sourceId,
          url: chatComment.url,
        },
      ]),
    );
    expect(publicItem).toMatchObject({
      summary: {
        author: trackedItem.author,
        assignees: trackedItem.assignees,
        aiAnalysis: {
          status: "used",
        },
      },
      latestEventActor: {
        status: "present",
        actor: {
          type: "human",
          login: "chat-commenter",
        },
      },
    });
    expect(publicItem).not.toHaveProperty("aiAnalysis");
    expect(publicItem).not.toHaveProperty("inputEvents");
  });

  it("userとteamのmention候補をcache validatorのcanonical順で保存する", async () => {
    const repository = createRepository(
      "R_mention_candidate_order",
      "mention-candidate-order",
      FIRST_RUN_AT,
    );
    const fixture = createRepositoryFixture(repository);
    const observedAt = createUtcIsoDateTime(FIRST_RUN_AT);
    const item = createIssueItem({
      repository: requirePublicRepository(repository),
      number: 1,
      fingerprint: "mention-candidate-order",
      updatedAt: observedAt,
      observedAt,
      state: Object.freeze({ state: "open" }),
    });
    const body = "@alpha と @voicevox/zeta に確認をお願いします";
    fixture.openItems = [item];
    fixture.details.set(
      item.nodeId,
      createIssueDetail({
        item,
        body,
        observedAt,
        nativeDependencies: Object.freeze([]),
        duplicateComments: false,
      }),
    );
    const config = await createTestConfig({
      explicitIncludes: [],
      retentionDays: 180,
      aiEnabled: true,
    });
    const harness = createCollectionHarness({
      repositories: [fixture],
      config,
      executeCodexAnalysis: executeSuccessfulCodexAnalysis,
    });

    const result = await harness.runCollectAnalyze(FIRST_RUN_AT);
    if (result.command !== "collect-analyze") {
      throw new TypeError("mention候補順序fixtureがcollect-analyze結果ではありません");
    }
    const artifact = requireCollectAnalyzeArtifact(harness.artifacts);
    const input = harness.codexInputs[0];
    if (input == null) {
      throw new TypeError("mention候補順序fixtureのCodex入力がありません");
    }
    const itemCache = artifact.cacheOnlyPayload.itemCaches.find(
      (candidate) => candidate.nodeId === item.nodeId,
    );
    if (itemCache == null) {
      throw new TypeError("mention候補順序fixtureのitem cacheがありません");
    }
    const expectedCandidates = [
      {
        id: "voicevox/zeta",
        kind: "team",
      },
      {
        id: "alpha",
        kind: "user",
      },
    ] satisfies readonly Readonly<{ id: string; kind: "user" | "team" }>[];

    expect(result.exitCode).toBe(0);
    expect(input.deterministicSignals["mentionedWaitingOnCandidates"]).toMatchObject(
      expectedCandidates,
    );
    expect(
      itemCache.analysisFacts.mentionedWaitingOnCandidates.map(({ id, kind }) => ({ id, kind })),
    ).toEqual(expectedCandidates);
  });

  it("fresh repository cacheのitemをcache validatorのcanonical順で保存する", async () => {
    const repository = createRepository(
      "R_repository_cache_item_order",
      "repository-cache-item-order",
      FIRST_RUN_AT,
    );
    const publicRepository = requirePublicRepository(repository);
    const fixture = createRepositoryFixture(repository);
    const observedAt = createUtcIsoDateTime(FIRST_RUN_AT);
    const uppercaseZNodeId = createGitHubNodeId("I_kwDOZ");
    const lowercaseANodeId = createGitHubNodeId("I_kwDOa");
    const upperTemplate = createIssueItem({
      repository: publicRepository,
      number: 1,
      fingerprint: "repository-cache-item-order-upper",
      updatedAt: observedAt,
      observedAt,
      state: Object.freeze({ state: "open" }),
    });
    const lowerTemplate = createIssueItem({
      repository: publicRepository,
      number: 2,
      fingerprint: "repository-cache-item-order-lower",
      updatedAt: observedAt,
      observedAt,
      state: Object.freeze({ state: "open" }),
    });
    const upperItem = Object.freeze({
      ...upperTemplate,
      nodeId: uppercaseZNodeId,
      bodyLocator: Object.freeze({
        ...upperTemplate.bodyLocator,
        itemNodeId: uppercaseZNodeId,
      }),
    });
    const lowerItem = Object.freeze({
      ...lowerTemplate,
      nodeId: lowercaseANodeId,
      bodyLocator: Object.freeze({
        ...lowerTemplate.bodyLocator,
        itemNodeId: lowercaseANodeId,
      }),
    });
    fixture.openItems = [lowerItem, upperItem];
    fixture.details.set(
      uppercaseZNodeId,
      createIssueDetail({
        item: upperItem,
        body: "本文1",
        observedAt,
        nativeDependencies: Object.freeze([]),
        duplicateComments: false,
      }),
    );
    fixture.details.set(
      lowercaseANodeId,
      createIssueDetail({
        item: lowerItem,
        body: "本文2",
        observedAt,
        nativeDependencies: Object.freeze([]),
        duplicateComments: false,
      }),
    );
    const config = await createTestConfig({
      explicitIncludes: [],
      retentionDays: 180,
      aiEnabled: false,
    });
    const harness = createCollectionHarness({ repositories: [fixture], config });

    const result = await harness.runCollectAnalyze(FIRST_RUN_AT);
    expect(result.command).toBe("collect-analyze");
    expect(result.exitCode).toBe(0);
    const artifact = requireCollectAnalyzeArtifact(harness.artifacts);
    const repositoryCache = artifact.cacheOnlyPayload.repositoryCaches.find(
      (candidate) => candidate.repository.repositoryId === repository.id,
    );
    if (repositoryCache == null) {
      throw new TypeError("repository cache順序fixtureのrepository cacheがありません");
    }

    expect(repositoryCache.items.map((item) => item.nodeId)).toEqual([
      uppercaseZNodeId,
      lowercaseANodeId,
    ]);
  });

  it("AI判定を使わない項目でも責務主体のコメントをstallSinceへ反映する", async () => {
    const repository = createRepository(
      "R_responsible_activity",
      "responsible-activity",
      FIRST_RUN_AT,
    );
    const fixture = createRepositoryFixture(repository);
    const observedAt = createUtcIsoDateTime(FIRST_RUN_AT);
    const commentedAt = createUtcIsoDateTime("2026-07-29T17:20:56.000Z");
    const assignee = Object.freeze({
      nodeId: createGitHubNodeId("U_responsible_user"),
      login: "responsible-user",
      apiType: "User",
    });
    const item = Object.freeze({
      ...createIssueItem({
        repository: requirePublicRepository(repository),
        number: 1,
        fingerprint: "responsible-activity",
        updatedAt: commentedAt,
        observedAt,
        state: Object.freeze({ state: "open" }),
      }),
      assignees: Object.freeze([assignee]),
    });
    const commentNodeId = createGitHubNodeId("IC_responsible_activity");
    const comment = Object.freeze({
      sourceId: buildSourceId("github_issue_comment", commentNodeId),
      nodeId: commentNodeId,
      sequence: 0,
      author: Object.freeze({
        status: "identified",
        account: Object.freeze({
          sourceId: buildSourceId("github_account", assignee.nodeId),
          ...assignee,
        }),
      }),
      body: "責務主体が状況をコメントしました",
      createdAt: commentedAt,
      lastEditedAt: null,
      updatedAt: commentedAt,
      url: `${item.url}#issuecomment-${commentNodeId}`,
      userContentEdits: Object.freeze({
        availability: "unavailable",
        reason: "connection_null",
      }),
    } satisfies GitHubIssueComment);
    fixture.openItems = [item];
    fixture.details.set(
      item.nodeId,
      Object.freeze({
        ...createIssueDetail({
          item,
          body: "本文",
          observedAt,
          nativeDependencies: Object.freeze([]),
          duplicateComments: false,
        }),
        comments: Object.freeze([comment]),
        timeline: Object.freeze([
          Object.freeze({
            sourceId: buildSourceId("github_timeline_event", `${item.nodeId}:assigned`),
            nodeId: createGitHubNodeId(`${item.nodeId}:assigned`),
            sequence: 0,
            occurredAt: commentedAt,
            actor: Object.freeze({
              status: "unavailable",
              reason: "github_did_not_return_actor",
            }),
            kind: "assigned",
            assignee: Object.freeze({
              type: "account",
              account: Object.freeze({
                sourceId: buildSourceId("github_account", assignee.nodeId),
                ...assignee,
              }),
            }),
          } satisfies GitHubTimelineEvent),
        ]),
      }),
    );
    const config = await createTestConfig({
      explicitIncludes: [],
      retentionDays: 180,
      aiEnabled: false,
    });
    const harness = createCollectionHarness({ repositories: [fixture], config });

    const result = await harness.runDry(FIRST_RUN_AT);
    const snapshot = requireDryRunSnapshot(harness.artifacts);
    const trackedItem = snapshot.items.find((candidate) => candidate.nodeId === item.nodeId);

    expect(result.exitCode).toBe(0);
    expect(harness.codexInputs).toEqual([]);
    expect(trackedItem).toMatchObject({
      status: "waiting_for_work",
      waitingOn: [
        expect.objectContaining({
          kind: "user",
          candidateId: assignee.login,
          role: "assignee",
        }),
      ],
      ownerSince: commentedAt,
      stallSince: commentedAt,
      lastProgressAt: item.createdAt,
      lastHumanActivityAt: commentedAt,
      aiAnalysis: {
        status: "disabled",
      },
    });
  });

  it("reducerの検証済み通知提案を通知選別へ渡す", async () => {
    const repository = createRepository("R_codex_notification", "codex-notification", FIRST_RUN_AT);
    const publicRepository = requirePublicRepository(repository);
    const fixture = createRepositoryFixture(repository);
    const observedAt = createUtcIsoDateTime(FIRST_RUN_AT);
    const notificationEvidenceAt = createUtcIsoDateTime("2026-07-31T23:00:00.000Z");
    const unrelatedEvidenceAt = createUtcIsoDateTime("2026-07-31T23:30:00.000Z");
    const notificationBody = "@requested-user に対応をお願いします";
    const unrelatedCommentSourceId = buildSourceId(
      "github_issue_comment",
      "IC_notification_unrelated",
    );
    const unrelatedComment = Object.freeze({
      sourceId: unrelatedCommentSourceId,
      nodeId: createGitHubNodeId("IC_notification_unrelated"),
      sequence: 0,
      author: Object.freeze({
        status: "unavailable",
        reason: "github_did_not_return_actor",
      }),
      body: "通知とは無関係な新しい根拠です",
      createdAt: unrelatedEvidenceAt,
      lastEditedAt: unrelatedEvidenceAt,
      updatedAt: unrelatedEvidenceAt,
      url: "https://github.com/VOICEVOX/codex-notification/issues/1#issuecomment-unrelated",
      userContentEdits: Object.freeze({
        availability: "unavailable",
        reason: "connection_null",
      }),
    } satisfies GitHubIssueComment);
    const recommendedItem = Object.freeze({
      ...createIssueItem({
        repository: publicRepository,
        number: 1,
        fingerprint: "notification-recommended",
        updatedAt: observedAt,
        observedAt,
        state: Object.freeze({ state: "open" }),
      }),
      bodyFingerprint: createGitHubBodyFingerprint(notificationBody),
    });
    const commentRecommendedItem = Object.freeze({
      ...createIssueItem({
        repository: publicRepository,
        number: 2,
        fingerprint: "notification-comment-recommended",
        updatedAt: observedAt,
        observedAt,
        state: Object.freeze({ state: "open" }),
      }),
      bodyFingerprint: createGitHubBodyFingerprint(notificationBody),
    });
    const commentSourceId = buildSourceId("github_issue_comment", "IC_notification_edited");
    const items = [recommendedItem, commentRecommendedItem];
    fixture.openItems = items;
    for (const item of items) {
      const detail = createIssueDetail({
        item,
        body: notificationBody,
        observedAt,
        nativeDependencies: Object.freeze([]),
        duplicateComments: false,
      });
      fixture.details.set(
        item.nodeId,
        item.nodeId === recommendedItem.nodeId
          ? Object.freeze({
              ...detail,
              lastEditedAt: notificationEvidenceAt,
              comments: Object.freeze([unrelatedComment]),
            })
          : Object.freeze({
              ...detail,
              comments: Object.freeze([
                Object.freeze({
                  sourceId: commentSourceId,
                  nodeId: createGitHubNodeId("IC_notification_edited"),
                  sequence: 0,
                  author: Object.freeze({
                    status: "identified",
                    account: Object.freeze({
                      sourceId: buildSourceId("github_account", "U_notification_commenter"),
                      nodeId: createGitHubNodeId("U_notification_commenter"),
                      login: "notification-commenter",
                      apiType: "User",
                    }),
                  }),
                  body: "編集済みの通知根拠です",
                  createdAt: createUtcIsoDateTime("2026-07-30T00:00:00.000Z"),
                  lastEditedAt: notificationEvidenceAt,
                  updatedAt: notificationEvidenceAt,
                  url: `${item.url}#issuecomment-notification-edited`,
                  userContentEdits: Object.freeze({
                    availability: "unavailable",
                    reason: "connection_null",
                  }),
                } satisfies GitHubIssueComment),
              ]),
            }),
      );
    }
    const config = await createTestConfig({
      explicitIncludes: [],
      retentionDays: 180,
      aiEnabled: true,
    });
    const harness = createCollectionHarness({
      repositories: [fixture],
      config,
      scheduledRun: true,
      executeCodexAnalysis: (input) => {
        const expectedSourceKind =
          input.item.nodeId === recommendedItem.nodeId ? "body" : "comment";
        const source = input.sources.find((candidate) => candidate.kind === expectedSourceKind);
        if (source == null) {
          throw new TypeError("通知提案fixtureの編集済みsourceがありません");
        }
        const evidence = [
          {
            sourceId: source.id,
            supports: "notification",
            summary: "通知提案のexact根拠です",
          },
        ];
        if (input.item.nodeId === recommendedItem.nodeId) {
          evidence.push({
            sourceId: unrelatedCommentSourceId,
            supports: "status",
            summary: "通知とは無関係な新しい根拠です",
          });
        }
        return Promise.resolve({
          ...createCodexOutput(input, {
            status: "in_progress",
            waitingOn: {
              candidateId: "requested-user",
              kind: "user",
              role: "assignee",
              sourceId: source.id,
            },
            latestMeaningfulSourceId: null,
            confidence: 0.7,
            relationVerdict: "related",
            notification: {
              recommended: true,
              reasonCode: "review_overdue",
              reasonSummary: "レビュー状況の確認が必要です",
            },
          }),
          evidence,
        });
      },
    });

    const result = await harness.runCollectAnalyze(FIRST_RUN_AT);
    if (result.exitCode !== 0) {
      throw new TypeError(`通知提案cold fixtureに失敗しました。${JSON.stringify(result)}`);
    }
    const artifact = requireCollectAnalyzeArtifact(harness.artifacts);
    const coldSources = Object.freeze(
      harness.codexInputs.map((input) => {
        const expectedSourceKind =
          input.item.nodeId === recommendedItem.nodeId ? "body" : "comment";
        const source = input.sources.find((candidate) => candidate.kind === expectedSourceKind);
        if (source == null) {
          throw new TypeError("cold通知提案fixtureの編集済みsourceがありません");
        }
        return Object.freeze({ nodeId: input.item.nodeId, createdAt: source.createdAt });
      }),
    );
    const warmHarness = createCollectionHarness({
      repositories: [fixture],
      config,
      scheduledRun: true,
      executeCodexAnalysis: () =>
        Promise.reject(new TypeError("warm通知提案fixtureはCodexを再実行しません")),
    });
    const session = await CacheOnlyPersistenceSession.open(
      warmHarness.stateAdapter,
      config.state,
      createPublicRepositoryAllowlist([repository]),
    );
    await session.persist({
      ...artifact.cacheOnlyPayload,
      evaluatedAt: createUtcIsoDateTime(FIRST_RUN_AT),
      knownSecrets: Object.freeze([]),
    });

    const warmResult = await warmHarness.runCollectAnalyze(FIRST_RUN_AT);
    if (warmResult.exitCode !== 0) {
      throw new TypeError(`通知提案warm fixtureに失敗しました。${JSON.stringify(warmResult)}`);
    }
    const warmArtifact = requireCollectAnalyzeArtifact(warmHarness.artifacts);

    expect(result.exitCode).toBe(0);
    expect(warmResult.exitCode).toBe(0);
    expect(harness.codexInputs).toHaveLength(2);
    expect(warmHarness.codexInputs).toEqual([]);
    expect(coldSources).toEqual([
      { nodeId: recommendedItem.nodeId, createdAt: notificationEvidenceAt },
      { nodeId: commentRecommendedItem.nodeId, createdAt: notificationEvidenceAt },
    ]);
    if (warmHarness.detailCalls.length !== 0) {
      throw new TypeError(
        `warm通知提案fixtureがdetailを再取得しました。${JSON.stringify(warmResult)}`,
      );
    }
    expect(warmHarness.detailCalls).toEqual([]);
    expect(warmArtifact.notificationSelection.candidates).toEqual(
      artifact.notificationSelection.candidates,
    );
    expect(
      artifact.notificationSelection.candidates.filter((candidate) =>
        candidate.reasons.some((reason) => reason.reasonCode === "review_overdue"),
      ),
    ).toHaveLength(2);
  });

  it("Codexのuser候補とauthor待ちにGitHub loginを使う", async () => {
    const repository = createRepository("R_codex_pr", "codex-pr", FIRST_RUN_AT);
    const publicRepository = requirePublicRepository(repository);
    const fixture = createRepositoryFixture(repository);
    const observedAt = createUtcIsoDateTime(FIRST_RUN_AT);
    const codeFailure = createPullRequestItem({
      repository: publicRepository,
      number: 1,
      fingerprint: "code-failure",
      updatedAt: observedAt,
      observedAt,
    });
    const infrastructureFailure = createPullRequestItem({
      repository: publicRepository,
      number: 2,
      fingerprint: "infrastructure-failure",
      updatedAt: observedAt,
      observedAt,
    });
    fixture.openItems = [codeFailure, infrastructureFailure];
    fixture.details.set(
      codeFailure.nodeId,
      createFailedCheckPullRequestDetail(codeFailure, observedAt),
    );
    fixture.details.set(
      infrastructureFailure.nodeId,
      createFailedCheckPullRequestDetail(infrastructureFailure, observedAt),
    );
    const config = await createTestConfig({
      explicitIncludes: [],
      retentionDays: 180,
      aiEnabled: true,
    });
    const harness = createCollectionHarness({
      repositories: [fixture],
      config,
      executeCodexAnalysis: (input) => {
        const checkSource = input.sources.find((source) => source.kind === "check_run");
        if (checkSource == null) {
          throw new TypeError("Codex入力にrequired check sourceがありません");
        }
        const codeCaused = input.item.nodeId === codeFailure.nodeId;
        return Promise.resolve(
          createCodexOutput(input, {
            status: codeCaused ? "waiting_for_revision" : "unknown",
            waitingOn: {
              candidateId: requireCodexAuthorCandidateId(input),
              kind: "user",
              role: codeCaused ? "author" : "unknown",
              sourceId: checkSource.id,
            },
            latestMeaningfulSourceId: null,
            confidence: 0.95,
            relationVerdict: "related",
            notification: {
              recommended: false,
              reasonCode: "none",
              reasonSummary: "通知しません",
            },
          }),
        );
      },
    });

    const result = await harness.runDry(FIRST_RUN_AT);
    const snapshot = requireDryRunSnapshot(harness.artifacts);
    const codeItem = snapshot.items.find((candidate) => candidate.nodeId === codeFailure.nodeId);
    const infrastructureItem = snapshot.items.find(
      (candidate) => candidate.nodeId === infrastructureFailure.nodeId,
    );

    expect(result.exitCode).toBe(0);
    expect(harness.codexInputs).toHaveLength(2);
    const authorByItemNodeId = new Map(
      [codeFailure, infrastructureFailure].map((candidate) => {
        if (candidate.author.kind !== "account") {
          throw new TypeError("Codex作者候補fixtureの作者アカウントがありません");
        }
        const pair: readonly [GitHubNodeId, GitHubItemAccount] = [
          candidate.nodeId,
          candidate.author.account,
        ];
        return pair;
      }),
    );
    for (const input of harness.codexInputs) {
      const author = authorByItemNodeId.get(createGitHubNodeId(input.item.nodeId));
      if (author == null) {
        throw new TypeError("Codex作者候補fixtureの入力項目がありません");
      }
      expect(input.item.authorCandidateId).toBe(author.login);
      expect(input.candidates.waitingOn).toContainEqual(
        expect.objectContaining({
          id: author.login,
          kind: "user",
        }),
      );
      expect(input.candidates.waitingOn.map((candidate) => candidate.id)).not.toContain(
        author.nodeId,
      );
      expect(input.deterministicSignals["requiredCheckFailure"]).toMatchObject({
        status: "configured",
        combinedState: "failure",
      });
      expect(input.sources.map((source) => source.kind)).toEqual(
        expect.arrayContaining(["required_check_rollup", "check_run"]),
      );
    }
    expect(codeItem).toMatchObject({
      status: "waiting_for_revision",
      waitingOn: [
        expect.objectContaining({
          kind: "role",
          candidateId: "author",
          role: "author",
        }),
      ],
      aiAnalysis: {
        status: "used",
      },
    });
    expect(infrastructureItem?.status).not.toBe("waiting_for_revision");
  });

  it("作者のGitHub loginを解決できなくても作者候補なしでCodex分析を実行する", async () => {
    const repository = createRepository(
      "R_codex_deleted_author",
      "codex-deleted-author",
      FIRST_RUN_AT,
    );
    const fixture = createRepositoryFixture(repository);
    const observedAt = createUtcIsoDateTime(FIRST_RUN_AT);
    const item = Object.freeze({
      ...createIssueItem({
        repository: requirePublicRepository(repository),
        number: 1,
        fingerprint: "codex-deleted-author",
        updatedAt: observedAt,
        observedAt,
        state: Object.freeze({ state: "open" }),
      }),
      author: Object.freeze({
        kind: "deleted_account",
      }),
    } satisfies EnumeratedGitHubItem);
    fixture.openItems = [item];
    fixture.details.set(
      item.nodeId,
      createIssueDetail({
        item,
        body: "本文",
        observedAt,
        nativeDependencies: Object.freeze([]),
        duplicateComments: false,
      }),
    );
    const config = await createTestConfig({
      explicitIncludes: [],
      retentionDays: 180,
      aiEnabled: true,
    });
    const attemptedAuthorCandidateId = `deleted-account:${item.nodeId}`;
    const harness = createCollectionHarness({
      repositories: [fixture],
      config,
      executeCodexAnalysis: (input) => {
        const source = input.sources[0];
        if (source == null) {
          throw new TypeError("削除済み作者fixtureのsourceがありません");
        }
        return Promise.resolve(
          createCodexOutput(input, {
            status: "unknown",
            waitingOn: {
              candidateId: attemptedAuthorCandidateId,
              kind: "user",
              role: "author",
              sourceId: source.id,
            },
            latestMeaningfulSourceId: null,
            confidence: 0.8,
            relationVerdict: "related",
            notification: {
              recommended: false,
              reasonCode: "none",
              reasonSummary: "通知しません",
            },
          }),
        );
      },
    });

    const result = await harness.runDry(FIRST_RUN_AT);
    if (result.command !== "dry-run") {
      throw new TypeError("削除済み作者fixtureがdry-run結果を返しませんでした");
    }
    const input = harness.codexInputs[0];
    if (input == null) {
      throw new TypeError("削除済み作者fixtureのCodex入力がありません");
    }
    const snapshot = requireDryRunSnapshot(harness.artifacts);

    expect(result.exitCode).toBe(0);
    expect(harness.codexExecutionCount()).toBe(2);
    expect(harness.codexInputs).toHaveLength(2);
    expect(input.item).not.toHaveProperty("authorCandidateId");
    expect(input.candidates.waitingOn).toEqual([
      expect.objectContaining({
        id: "production-test-maintainer",
        kind: "user",
      }),
    ]);
    expect(input.candidates.waitingOn.map((candidate) => candidate.id)).not.toContain(
      attemptedAuthorCandidateId,
    );
    expect(snapshot.items[0]?.aiAnalysis).toEqual({
      status: "failed",
    });
    expect(result.result.report.diagnostics).toContain(
      `codex_fallback item=${item.nodeId} reason=semantic_validation_failed errorType=CodexOutputSemanticValidationError validationIssueCount=1 validationIssue0Path=/waitingOn/0/candidateId validationIssue0Code=unknown_waiting_on_candidate`,
    );
  });

  it("同じGitHubデータなら前回stateなしの走査時刻が数ヶ月違っても全項目の停滞起点が一致する", async () => {
    const githubSignalAt = createUtcIsoDateTime("2026-07-20T12:00:00.000Z");
    const runAt = async (
      startedAt: string,
    ): Promise<
      readonly Readonly<{
        nodeId: GitHubNodeId;
        type: "issue" | "pull_request";
        status: StateSnapshot["items"][number]["status"];
        statusSince: UtcIsoDateTime;
        ownerSince: UtcIsoDateTime;
        stallSince: UtcIsoDateTime;
      }>[]
    > => {
      const observedAt = createUtcIsoDateTime(startedAt);
      const repository = createRepository(
        "R_deterministic_stall_since",
        "deterministic-stall-since",
        startedAt,
      );
      const publicRepository = requirePublicRepository(repository);
      const fixture = createRepositoryFixture(repository);
      const unassignedIssue = createIssueItem({
        repository: publicRepository,
        number: 1,
        fingerprint: "deterministic-unassigned",
        updatedAt: githubSignalAt,
        observedAt,
        state: Object.freeze({ state: "open" }),
      });
      const blockedIssue = createIssueItem({
        repository: publicRepository,
        number: 2,
        fingerprint: "deterministic-blocked",
        updatedAt: githubSignalAt,
        observedAt,
        state: Object.freeze({ state: "open" }),
      });
      const draftPullRequestBase = createPullRequestItem({
        repository: publicRepository,
        number: 3,
        fingerprint: "deterministic-draft",
        updatedAt: githubSignalAt,
        observedAt,
      });
      if (draftPullRequestBase.type !== "pull_request") {
        throw new TypeError("決定論性fixtureのdraftがPull Requestではありません");
      }
      const draftPullRequest = Object.freeze({
        ...draftPullRequestBase,
        draft: true,
      });
      const failedCheckPullRequest = createPullRequestItem({
        repository: publicRepository,
        number: 4,
        fingerprint: "deterministic-failed-check",
        updatedAt: githubSignalAt,
        observedAt,
      });
      const conflictingPullRequest = createPullRequestItem({
        repository: publicRepository,
        number: 5,
        fingerprint: "deterministic-conflict",
        updatedAt: githubSignalAt,
        observedAt,
      });
      const reviewWaitingPullRequest = createPullRequestItem({
        repository: publicRepository,
        number: 6,
        fingerprint: "deterministic-review-waiting",
        updatedAt: githubSignalAt,
        observedAt,
      });
      const pendingCheckPullRequest = createPullRequestItem({
        repository: publicRepository,
        number: 7,
        fingerprint: "deterministic-pending-check",
        updatedAt: githubSignalAt,
        observedAt,
      });
      const items = [
        unassignedIssue,
        blockedIssue,
        draftPullRequest,
        failedCheckPullRequest,
        conflictingPullRequest,
        reviewWaitingPullRequest,
        pendingCheckPullRequest,
      ];
      fixture.openItems = items;
      fixture.details.set(
        unassignedIssue.nodeId,
        createIssueDetail({
          item: unassignedIssue,
          body: "未アサインのIssueです",
          observedAt,
          nativeDependencies: Object.freeze([]),
          duplicateComments: false,
        }),
      );
      fixture.details.set(
        blockedIssue.nodeId,
        createIssueDetail({
          item: blockedIssue,
          body: "draft Pull Requestの完了を待ちます",
          observedAt,
          nativeDependencies: Object.freeze([createNativeBlocker(blockedIssue, draftPullRequest)]),
          duplicateComments: false,
        }),
      );
      const createDetailWithoutChecks = (
        item: EnumeratedGitHubItem,
        mergeability: Extract<
          GitHubItemDetail,
          Readonly<{ type: "pull_request" }>
        >["mergeState"]["mergeability"],
        mergeState: Extract<
          GitHubItemDetail,
          Readonly<{ type: "pull_request" }>
        >["mergeState"]["mergeState"],
      ): Extract<GitHubItemDetail, Readonly<{ type: "pull_request" }>> => {
        const detail = createFailedCheckPullRequestDetail(item, githubSignalAt);
        return Object.freeze({
          ...detail,
          mergeState: Object.freeze({
            ...detail.mergeState,
            mergeability,
            mergeState,
            checks: Object.freeze({
              status: "not_configured",
            }),
          }),
          observedAt,
        });
      };
      fixture.details.set(
        draftPullRequest.nodeId,
        createDetailWithoutChecks(draftPullRequest, "unknown", "draft"),
      );
      fixture.details.set(
        failedCheckPullRequest.nodeId,
        Object.freeze({
          ...createFailedCheckPullRequestDetail(failedCheckPullRequest, githubSignalAt),
          observedAt,
        }),
      );
      fixture.details.set(
        conflictingPullRequest.nodeId,
        createDetailWithoutChecks(conflictingPullRequest, "conflicting", "dirty"),
      );
      const reviewRequestSourceId = buildSourceId(
        "github_review_request",
        reviewWaitingPullRequest.nodeId,
      );
      const reviewRequestNodeId = createGitHubNodeId(`RR_${reviewWaitingPullRequest.nodeId}`);
      const reviewerNodeId = createGitHubNodeId("U_deterministic_reviewer");
      const reviewWaitingDetail = createDetailWithoutChecks(
        reviewWaitingPullRequest,
        "mergeable",
        "blocked",
      );
      fixture.details.set(
        reviewWaitingPullRequest.nodeId,
        Object.freeze({
          ...reviewWaitingDetail,
          reviewRequests: Object.freeze({
            current: Object.freeze([
              Object.freeze({
                sourceId: reviewRequestSourceId,
                nodeId: reviewRequestNodeId,
                target: Object.freeze({
                  type: "user",
                  sourceId: buildSourceId("github_user", reviewerNodeId),
                  nodeId: reviewerNodeId,
                  login: "deterministic-reviewer",
                  apiType: "User",
                }),
                requestedAt: Object.freeze({
                  status: "unavailable",
                  reason: "timeline_event_not_found",
                }),
              }),
            ]),
            history: Object.freeze([]),
          }),
        }),
      );
      const pendingCheckDetail = createFailedCheckPullRequestDetail(
        pendingCheckPullRequest,
        githubSignalAt,
      );
      if (pendingCheckDetail.mergeState.checks.status !== "configured") {
        throw new TypeError("決定論性fixtureのrequired checksがありません");
      }
      fixture.details.set(
        pendingCheckPullRequest.nodeId,
        Object.freeze({
          ...pendingCheckDetail,
          mergeState: Object.freeze({
            ...pendingCheckDetail.mergeState,
            mergeState: "unstable",
            checks: Object.freeze({
              ...pendingCheckDetail.mergeState.checks,
              combinedState: "pending",
              contexts: Object.freeze(
                pendingCheckDetail.mergeState.checks.contexts.map((context) => {
                  if (context.type !== "check_run") {
                    throw new TypeError("決定論性fixtureのcheck runを取得できません");
                  }
                  return Object.freeze({
                    ...context,
                    status: "in_progress",
                    conclusion: "not_completed",
                    completedAt: null,
                  });
                }),
              ),
            }),
          }),
          observedAt,
        }),
      );
      const config = await createTestConfig({
        explicitIncludes: [],
        retentionDays: 180,
        aiEnabled: true,
      });
      const harness = createCollectionHarness({
        repositories: [fixture],
        config,
        executeCodexAnalysis: (input) => {
          const failedCheck = input.item.nodeId === failedCheckPullRequest.nodeId;
          const basisSource = input.sources.find((source) =>
            failedCheck ? source.kind === "check_run" : source.kind === "body",
          );
          if (basisSource == null) {
            throw new TypeError("決定論性fixtureのCodex根拠sourceがありません");
          }
          return Promise.resolve(
            createCodexOutput(input, {
              status: "waiting_for_revision",
              waitingOn: {
                candidateId: requireCodexAuthorCandidateId(input),
                kind: "user",
                role: "author",
                sourceId: basisSource.id,
              },
              latestMeaningfulSourceId: null,
              confidence: failedCheck ? 0.95 : 0.1,
              relationVerdict: "related",
              notification: {
                recommended: false,
                reasonCode: "none",
                reasonSummary: "通知しません",
              },
            }),
          );
        },
      });

      const result = await harness.runCollectAnalyze(startedAt);
      const snapshot = requireCollectAnalyzeArtifact(harness.artifacts).snapshot;

      expect(result.exitCode).toBe(0);
      expect(harness.codexInputs.map((input) => input.item.nodeId)).toEqual([
        unassignedIssue.nodeId,
        failedCheckPullRequest.nodeId,
      ]);
      expect(snapshot.items).toHaveLength(items.length);
      expect(snapshot.items).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            nodeId: unassignedIssue.nodeId,
            status: "waiting_for_assessment",
          }),
          expect.objectContaining({ nodeId: blockedIssue.nodeId, status: "waiting_for_unblock" }),
          expect.objectContaining({ nodeId: draftPullRequest.nodeId, status: "in_progress" }),
          expect.objectContaining({
            nodeId: failedCheckPullRequest.nodeId,
            status: "waiting_for_revision",
          }),
          expect.objectContaining({
            nodeId: conflictingPullRequest.nodeId,
            status: "waiting_for_revision",
          }),
          expect.objectContaining({
            nodeId: reviewWaitingPullRequest.nodeId,
            status: "waiting_for_review",
          }),
          expect.objectContaining({
            nodeId: pendingCheckPullRequest.nodeId,
            status: "waiting_for_automation",
          }),
        ]),
      );
      return Object.freeze(
        snapshot.items
          .map((item) =>
            Object.freeze({
              nodeId: item.nodeId,
              type: item.type,
              status: item.status,
              statusSince: item.statusSince,
              ownerSince: item.ownerSince,
              stallSince: item.stallSince,
            }),
          )
          .toSorted((left, right) => left.nodeId.localeCompare(right.nodeId)),
      );
    };

    const first = await runAt(FIRST_RUN_AT);
    const second = await runAt("2027-02-01T00:00:00.000Z");

    expect(
      second,
      "同じGitHubデータを前回stateなしで走査したのに、run開始時刻の違いでstatusSince、ownerSince、stallSinceが変わりました。観測時刻が停滞起点へ混入しています。",
    ).toEqual(first);
  });

  it("check source時刻とCodex由来basisをrun開始時刻に依存させない", async () => {
    const headPushedAt = createUtcIsoDateTime("2026-07-30T12:00:00.000Z");
    const checkCompletedAt = createUtcIsoDateTime("2026-07-31T18:00:00.000Z");
    const runAt = async (
      startedAt: string,
    ): Promise<
      Readonly<{
        input: CodexAnalysisInput;
        item: StateSnapshot["items"][number];
      }>
    > => {
      const repository = createRepository(
        "R_deterministic_codex",
        "deterministic-codex",
        startedAt,
      );
      const publicRepository = requirePublicRepository(repository);
      const fixture = createRepositoryFixture(repository);
      const item = createPullRequestItem({
        repository: publicRepository,
        number: 1,
        fingerprint: "deterministic-codex",
        updatedAt: checkCompletedAt,
        observedAt: checkCompletedAt,
      });
      const detail = createFailedCheckPullRequestDetail(item, headPushedAt);
      if (detail.mergeState.checks.status !== "configured") {
        throw new TypeError("決定論的Codex fixtureのcheckがありません");
      }
      const completedContexts = detail.mergeState.checks.contexts.map((context) => {
        if (context.type !== "check_run" || context.status !== "completed") {
          throw new TypeError("決定論的Codex fixtureに完了済みcheck run以外があります");
        }
        return Object.freeze({
          ...context,
          completedAt: checkCompletedAt,
        });
      });
      const pendingContext = Object.freeze({
        type: "check_run",
        sourceId: buildSourceId("github_check_run", `${item.nodeId}:pending`),
        nodeId: createGitHubNodeId(`CHECK_${item.nodeId}_pending`),
        name: "pending-test",
        status: "in_progress",
        conclusion: "not_completed",
        completedAt: null,
      });
      fixture.openItems = [item];
      fixture.details.set(
        item.nodeId,
        Object.freeze({
          ...detail,
          mergeState: Object.freeze({
            ...detail.mergeState,
            checks: Object.freeze({
              ...detail.mergeState.checks,
              contexts: Object.freeze([...completedContexts, pendingContext]),
            }),
          }),
          observedAt: checkCompletedAt,
        }),
      );
      const config = await createTestConfig({
        explicitIncludes: [],
        retentionDays: 180,
        aiEnabled: true,
      });
      const harness = createCollectionHarness({
        repositories: [fixture],
        config,
        executeCodexAnalysis: (input) => {
          const checkSource = input.sources.find((source) => source.kind === "check_run");
          if (checkSource == null) {
            throw new TypeError("決定論的Codex fixtureのcheck sourceがありません");
          }
          return Promise.resolve(
            createCodexOutput(input, {
              status: "waiting_for_revision",
              waitingOn: {
                candidateId: requireCodexAuthorCandidateId(input),
                kind: "user",
                role: "author",
                sourceId: checkSource.id,
              },
              latestMeaningfulSourceId: null,
              confidence: 0.95,
              relationVerdict: "related",
              notification: {
                recommended: false,
                reasonCode: "none",
                reasonSummary: "通知しません",
              },
            }),
          );
        },
      });

      const result = await harness.runDry(startedAt);
      const input = harness.codexInputs[0];
      const trackedItem = requireDryRunSnapshot(harness.artifacts).items.find(
        (candidate) => candidate.nodeId === item.nodeId,
      );
      if (input == null || trackedItem == null) {
        throw new TypeError("決定論的Codex fixtureの結果がありません");
      }
      expect(result.exitCode).toBe(0);
      return Object.freeze({ input, item: trackedItem });
    };

    const first = await runAt(SECOND_RUN_AT);
    const second = await runAt(THIRD_RUN_AT);
    const sourceTimes = (input: CodexAnalysisInput): Readonly<Record<string, string>> =>
      Object.freeze(
        Object.fromEntries(
          input.sources
            .filter(
              (source) => source.kind === "required_check_rollup" || source.kind === "check_run",
            )
            .map((source) => {
              if (source.kind !== "check_run") {
                return [source.kind, source.createdAt];
              }
              const status = source["status"];
              if (typeof status !== "string") {
                throw new TypeError("check run sourceのstatusが文字列ではありません");
              }
              return [`check_run_${status}`, source.createdAt];
            }),
        ),
      );
    const transitionTimes = (item: StateSnapshot["items"][number]) =>
      Object.freeze({
        statusSince: item.statusSince,
        ownerSince: item.ownerSince,
        stallSince: item.stallSince,
      });
    const pendingCheckTime = (input: CodexAnalysisInput): string | undefined =>
      input.sources.find(
        (source) => source.kind === "check_run" && source["status"] === "in_progress",
      )?.createdAt;

    expect(first.input.now).toBe(SECOND_RUN_AT);
    expect(second.input.now).toBe(THIRD_RUN_AT);
    expect(sourceTimes(first.input)).toEqual({
      required_check_rollup: checkCompletedAt,
      check_run_completed: checkCompletedAt,
      check_run_in_progress: headPushedAt,
    });
    expect(sourceTimes(second.input)).toEqual(sourceTimes(first.input));
    expect(pendingCheckTime(first.input)).toBe(headPushedAt);
    expect(pendingCheckTime(second.input)).toBe(headPushedAt);
    expect(transitionTimes(first.item)).toEqual({
      statusSince: checkCompletedAt,
      ownerSince: checkCompletedAt,
      stallSince: checkCompletedAt,
    });
    expect(transitionTimes(second.item)).toEqual(transitionTimes(first.item));
  });

  it("Pull Request作成前のcheck contextをhead時刻へ正規化してcache検証を通す", async () => {
    const observedAt = createUtcIsoDateTime("2026-08-12T12:00:00.000Z");
    const prePullRequestCheckAt = createUtcIsoDateTime("2026-08-12T10:24:06.000Z");
    const pullRequestCreatedAt = createUtcIsoDateTime("2026-08-12T10:38:14.000Z");
    const repository = createRepository("R_check_context_range", "check-context-range", observedAt);
    const publicRepository = requirePublicRepository(repository);
    const fixture = createRepositoryFixture(repository);
    const item = replaceCreatedAt(
      createPullRequestItem({
        repository: publicRepository,
        number: 1,
        fingerprint: "check-context-range",
        updatedAt: observedAt,
        observedAt,
      }),
      pullRequestCreatedAt,
    );
    const baseDetail = createFailedCheckPullRequestDetail(item, observedAt);
    if (baseDetail.mergeState.checks.status !== "configured") {
      throw new TypeError("check contextのfixtureがconfiguredではありません");
    }
    const checkRunContext: Extract<GitHubCheckContext, { type: "check_run" }> = Object.freeze({
      type: "check_run",
      sourceId: buildSourceId("github_check_run", `${item.nodeId}:before-pull-request`),
      nodeId: createGitHubNodeId(`${item.nodeId}:before-pull-request`),
      name: "pre-pull-request-check",
      status: "completed",
      conclusion: "failure",
      completedAt: prePullRequestCheckAt,
    });
    const commitStatusContext: Extract<GitHubCheckContext, { type: "commit_status" }> =
      Object.freeze({
        type: "commit_status",
        sourceId: buildSourceId("github_commit_status", `${item.nodeId}:before-pull-request`),
        nodeId: createGitHubNodeId(`${item.nodeId}:before-pull-request-status`),
        context: "pre-pull-request-status",
        state: "failure",
        createdAt: prePullRequestCheckAt,
      });
    const detail = Object.freeze({
      ...baseDetail,
      headCommit: Object.freeze({
        ...baseDetail.headCommit,
        committedAt: prePullRequestCheckAt,
        pushedAt: Object.freeze({
          status: "available",
          value: prePullRequestCheckAt,
        }),
      }),
      mergeState: Object.freeze({
        ...baseDetail.mergeState,
        checks: Object.freeze({
          ...baseDetail.mergeState.checks,
          contexts: Object.freeze([checkRunContext, commitStatusContext]),
        }),
      }),
    });
    fixture.openItems = [item];
    fixture.details.set(item.nodeId, detail);
    const config = await createTestConfig({
      explicitIncludes: [],
      retentionDays: 180,
      aiEnabled: true,
    });
    const harness = createCollectionHarness({
      repositories: [fixture],
      config,
      executeCodexAnalysis: executeSuccessfulCodexAnalysis,
    });

    const result = await harness.runCollectAnalyze(observedAt);
    expect(result.exitCode).toBe(0);
    const input = harness.codexInputs[0];
    assertNonNullable(input, "check contextのCodex入力がありません");
    const artifact = requireCollectAnalyzeArtifact(harness.artifacts);
    const itemCache = artifact.cacheOnlyPayload.itemCaches.find(
      (candidate) => candidate.nodeId === item.nodeId,
    );
    if (itemCache == null) {
      throw new TypeError("check contextのitem cacheがありません");
    }
    const sourceOccurredAt = (
      sources: readonly Readonly<{ kind: string; createdAt: string }>[],
      kind: string,
    ): string => {
      const source = sources.find((candidate) => candidate.kind === kind);
      assertNonNullable(source, `check context sourceがありません。種別: ${kind}`);
      return source.createdAt;
    };

    for (const kind of ["check_run", "commit_status", "required_check_rollup"]) {
      expect(sourceOccurredAt(input.sources, kind)).toBe(pullRequestCreatedAt);
      expect(sourceOccurredAt(itemCache.analysisFacts.codexValidationContext.sources, kind)).toBe(
        pullRequestCreatedAt,
      );
    }
  });

  it("current external public参照を許可しcached mutationを再検証する", async () => {
    const repository = createRepository(
      "R_external_relation_allowed",
      "external-relation-allowed",
      FIRST_RUN_AT,
    );
    const publicRepository = requirePublicRepository(repository);
    const fixture = createRepositoryFixture(repository);
    const observedAt = createUtcIsoDateTime(FIRST_RUN_AT);
    const source = createIssueItem({
      repository: publicRepository,
      number: 1,
      fingerprint: "external-relation-allowed-source",
      updatedAt: observedAt,
      observedAt,
      state: Object.freeze({ state: "open" }),
    });
    const externalUrl = "https://github.com/external-owner/external-relation-proof/issues/2";
    const bodySourceId = buildSourceId("github_item_body", source.nodeId);
    fixture.openItems = [source];
    fixture.details.set(
      source.nodeId,
      Object.freeze({
        ...createIssueDetail({
          item: source,
          body: `- [ ] ${externalUrl}`,
          observedAt,
          nativeDependencies: Object.freeze([]),
          duplicateComments: false,
        }),
        bodyUserContentEdits: Object.freeze({
          availability: "unavailable",
          reason: "connection_null",
        }),
      }),
    );
    const baseConfig = await createTestConfig({
      explicitIncludes: [],
      retentionDays: 180,
      aiEnabled: true,
    });
    const config = configWithBudget(baseConfig, 50, baseConfig.ai.budget.maxEstimatedCostUsdPerRun);
    let visibility: ExternalRelationGraphqlItemOptions["visibility"] = "PUBLIC";
    const harness = createCollectionHarness({
      repositories: [fixture],
      config,
      executeCodexAnalysis: executeSuccessfulCodexAnalysis,
      externalRelationResponse: (request) =>
        createExternalRelationGraphqlResponse(request, {
          itemType: "issue",
          visibility,
          archived: false,
          disabled: false,
        }),
    });

    const result = await harness.runCollectAnalyze(FIRST_RUN_AT);

    if (result.command !== "collect-analyze") {
      throw new TypeError("external relation proof fixtureがcollect-analyze結果ではありません");
    }
    expect(result.exitCode).toBe(0);
    expect(result.result.report).toMatchObject({ status: "success", complete: true });
    expect(result.result.report.diagnostics).not.toContainEqual(
      expect.stringContaining("publicBoundaryViolation"),
    );
    expect(harness.codexExecutionCount()).toBeGreaterThan(0);
    expect(harness.externalRelationGraphqlCalls).toHaveLength(1);
    expect(harness.externalRelationGraphqlCalls[0]).toMatchObject({
      owner: "external-owner",
      name: "external-relation-proof",
      number: 2,
      itemType: "issue",
    });
    const artifact = requireCollectAnalyzeArtifact(harness.artifacts);
    const itemCache = artifact.cacheOnlyPayload.itemCaches.find(
      (candidate) => candidate.nodeId === source.nodeId,
    );
    if (itemCache == null) {
      throw new TypeError("external relation proofのitem cacheがありません");
    }
    expect(
      itemCache.relationCandidates.some(
        (candidate) =>
          candidate.provenance === "checklist" && candidate.sourceIds.includes(bodySourceId),
      ),
    ).toBe(true);
    expect(itemCache.relationMutations).toContainEqual(
      expect.objectContaining({
        contentSourceId: bodySourceId,
        status: "unknown",
        reason: "connection_unavailable",
      }),
    );

    const firstHead = await harness.stateAdapter.resolveHead("tracker-state-v3");
    const firstCodexExecutionCount = harness.codexExecutionCount();
    visibility = "PRIVATE";
    const secondResult = await harness.runCollectAnalyze(SECOND_RUN_AT);
    if (secondResult.command !== "collect-analyze") {
      throw new TypeError("cached current external fixtureがcollect-analyze結果ではありません");
    }
    expect(secondResult.exitCode).toBe(1);
    expect(secondResult.result.report).toMatchObject({
      status: "failure",
      failedStage: "incremental_collection",
      complete: false,
    });
    expect(secondResult.result.report.diagnostics).toContainEqual(
      expect.stringContaining(
        `publicBoundaryViolationKind=cache_relation_mutation publicBoundaryViolationCount=1 sourceItemNodeId=${source.nodeId}`,
      ),
    );
    expect(harness.externalRelationGraphqlCalls).toHaveLength(2);
    expect(harness.codexExecutionCount()).toBe(firstCodexExecutionCount);
    expect(await harness.stateAdapter.resolveHead("tracker-state-v3")).toEqual(firstHead);
    expect(JSON.stringify(secondResult.result.report)).not.toContain(externalUrl);
    expect(JSON.stringify(secondResult.result.report)).not.toContain("external-owner");
  });

  it("stale cacheのunknown sourceにある複数external current参照を全て再検証する", async () => {
    const repository = createRepository(
      "R_external_relation_multiple_cached",
      "external-relation-multiple-cached",
      FIRST_RUN_AT,
    );
    const publicRepository = requirePublicRepository(repository);
    const fixture = createRepositoryFixture(repository);
    const observedAt = createUtcIsoDateTime(FIRST_RUN_AT);
    const source = createIssueItem({
      repository: publicRepository,
      number: 1,
      fingerprint: "external-relation-multiple-cached-source",
      updatedAt: observedAt,
      observedAt,
      state: Object.freeze({ state: "open" }),
    });
    const firstUrl = "https://github.com/external-owner/external-relation-multiple-first/issues/2";
    const secondUrl =
      "https://github.com/external-owner/external-relation-multiple-second/issues/3";
    const bodySourceId = buildSourceId("github_item_body", source.nodeId);
    fixture.openItems = [source];
    fixture.details.set(
      source.nodeId,
      Object.freeze({
        ...createIssueDetail({
          item: source,
          body: `- [ ] ${firstUrl}\n- [ ] ${secondUrl}`,
          observedAt,
          nativeDependencies: Object.freeze([]),
          duplicateComments: false,
        }),
        bodyUserContentEdits: Object.freeze({
          availability: "unavailable",
          reason: "connection_null",
        }),
      }),
    );
    const baseConfig = await createTestConfig({
      explicitIncludes: [],
      retentionDays: 180,
      aiEnabled: true,
    });
    const config = configWithBudget(baseConfig, 50, baseConfig.ai.budget.maxEstimatedCostUsdPerRun);
    const harness = createCollectionHarness({
      repositories: [fixture],
      config,
      executeCodexAnalysis: executeSuccessfulCodexAnalysis,
      externalRelationResponse: (request) =>
        createExternalRelationGraphqlResponse(request, {
          itemType: "issue",
          visibility: "PUBLIC",
          archived: false,
          disabled: false,
        }),
    });

    const firstResult = await harness.runDaily(FIRST_RUN_AT);
    expect(firstResult.exitCode, JSON.stringify(firstResult)).toBe(0);
    const firstCodexExecutionCount = harness.codexExecutionCount();
    fixture.enumerationFailsWith503 = true;
    harness.detailCalls.length = 0;
    harness.artifacts.length = 0;
    const secondResult = await harness.runCollectAnalyze(SECOND_RUN_AT);
    expect(secondResult.exitCode, JSON.stringify(secondResult)).toBe(0);
    expect(harness.externalRelationGraphqlCalls).toHaveLength(4);
    expect(
      harness.externalRelationGraphqlCalls.filter(
        (request) => request.name === "external-relation-multiple-first" && request.number === 2,
      ),
    ).toHaveLength(2);
    expect(
      harness.externalRelationGraphqlCalls.filter(
        (request) => request.name === "external-relation-multiple-second" && request.number === 3,
      ),
    ).toHaveLength(2);
    expect(harness.detailCalls).toEqual([]);
    expect(harness.codexExecutionCount()).toBe(firstCodexExecutionCount);
    const secondArtifact = requireCollectAnalyzeArtifact(harness.artifacts);
    const secondCache = secondArtifact.cacheOnlyPayload.itemCaches.find(
      (candidate) => candidate.nodeId === source.nodeId,
    );
    if (secondCache == null) {
      throw new TypeError("複数external参照のcached item cacheがありません");
    }
    expect(secondCache.relationMutations).toContainEqual({
      status: "unknown",
      contentSourceId: bodySourceId,
      reason: "connection_unavailable",
    });
    const externalCandidateCount = secondCache.relationCandidates.filter((candidate) =>
      candidate.sourceIds.includes(bodySourceId),
    ).length;
    expect(externalCandidateCount).toBeGreaterThanOrEqual(2);
  });

  it("本文とcommentの同一external参照を一回のqueryで両sourceへ証明する", async () => {
    const repository = createRepository(
      "R_external_relation_duplicate",
      "external-relation-duplicate",
      FIRST_RUN_AT,
    );
    const publicRepository = requirePublicRepository(repository);
    const fixture = createRepositoryFixture(repository);
    const observedAt = createUtcIsoDateTime(FIRST_RUN_AT);
    const source = createIssueItem({
      repository: publicRepository,
      number: 1,
      fingerprint: "external-relation-duplicate-source",
      updatedAt: observedAt,
      observedAt,
      state: Object.freeze({ state: "open" }),
    });
    const externalUrl = "https://github.com/external-owner/external-relation-proof/issues/2";
    const bodySourceId = buildSourceId("github_item_body", source.nodeId);
    const comment = createDuplicateComments(source, observedAt)[0];
    assertNonNullable(comment, "external relation comment fixtureがありません");
    const detail = createIssueDetail({
      item: source,
      body: `- [ ] ${externalUrl}`,
      observedAt,
      nativeDependencies: Object.freeze([]),
      duplicateComments: false,
    });
    fixture.openItems = [source];
    fixture.details.set(
      source.nodeId,
      Object.freeze({
        ...detail,
        bodyUserContentEdits: Object.freeze({
          availability: "available",
          edits: Object.freeze([]),
        }),
        comments: Object.freeze([
          Object.freeze({
            ...comment,
            body: externalUrl,
            userContentEdits: Object.freeze({
              availability: "available",
              edits: Object.freeze([]),
            }),
          }),
        ]),
      }),
    );
    const baseConfig = await createTestConfig({
      explicitIncludes: [],
      retentionDays: 180,
      aiEnabled: true,
    });
    const config = configWithBudget(baseConfig, 50, baseConfig.ai.budget.maxEstimatedCostUsdPerRun);
    const harness = createCollectionHarness({
      repositories: [fixture],
      config,
      executeCodexAnalysis: executeSuccessfulCodexAnalysis,
      externalRelationResponse: (request) =>
        createExternalRelationGraphqlResponse(request, {
          itemType: "issue",
          visibility: "PUBLIC",
          archived: false,
          disabled: false,
          nodeId: "I_external_blocker",
        }),
    });

    const result = await harness.runCollectAnalyze(FIRST_RUN_AT);

    expect(result.exitCode).toBe(0);
    expect(harness.externalRelationGraphqlCalls).toHaveLength(1);
    expect(harness.codexExecutionCount()).toBeGreaterThan(0);
    const artifact = requireCollectAnalyzeArtifact(harness.artifacts);
    const itemCache = artifact.cacheOnlyPayload.itemCaches.find(
      (candidate) => candidate.nodeId === source.nodeId,
    );
    if (itemCache == null) {
      throw new TypeError("duplicate external relationのitem cacheがありません");
    }
    const mutationSourceIds = new Set(
      itemCache.relationMutations
        .filter((mutation) => mutation.status === "available")
        .map((mutation) => mutation.contentSourceId),
    );
    expect(mutationSourceIds).toEqual(new Set([bodySourceId, comment.sourceId]));
    expect(
      itemCache.relationCandidates.some((candidate) => candidate.sourceIds.includes(bodySourceId)),
    ).toBe(true);
    expect(
      itemCache.relationCandidates.some((candidate) =>
        candidate.sourceIds.includes(comment.sourceId),
      ),
    ).toBe(true);
  });

  it("external current参照がunverifiedならAI実行前に停止する", async () => {
    const repository = createRepository(
      "R_external_relation_other_item",
      "external-relation-other-item",
      FIRST_RUN_AT,
    );
    const publicRepository = requirePublicRepository(repository);
    const fixture = createRepositoryFixture(repository);
    const observedAt = createUtcIsoDateTime(FIRST_RUN_AT);
    const source = createIssueItem({
      repository: publicRepository,
      number: 1,
      fingerprint: "external-relation-other-item-source",
      updatedAt: observedAt,
      observedAt,
      state: Object.freeze({ state: "open" }),
    });
    const externalUrl = "https://github.com/external-owner/external-relation-proof/issues/2";
    fixture.openItems = [source];
    fixture.details.set(
      source.nodeId,
      Object.freeze({
        ...createIssueDetail({
          item: source,
          body: `- [ ] ${externalUrl}`,
          observedAt,
          nativeDependencies: Object.freeze([]),
          duplicateComments: false,
        }),
        bodyUserContentEdits: Object.freeze({
          availability: "available",
          edits: Object.freeze([]),
        }),
      }),
    );
    const baseConfig = await createTestConfig({
      explicitIncludes: [],
      retentionDays: 180,
      aiEnabled: true,
    });
    const config = configWithBudget(baseConfig, 50, baseConfig.ai.budget.maxEstimatedCostUsdPerRun);
    const harness = createCollectionHarness({
      repositories: [fixture],
      config,
      externalRelationResponse: (request) =>
        createExternalRelationGraphqlResponse(request, {
          itemType: "issue",
          visibility: "PRIVATE",
          archived: false,
          disabled: false,
        }),
    });

    const result = await harness.runCollectAnalyze(FIRST_RUN_AT);

    if (result.command !== "collect-analyze") {
      throw new TypeError("別item external relation fixtureがcollect-analyze結果ではありません");
    }
    expect(result.exitCode).toBe(1);
    expect(result.result.report).toMatchObject({
      status: "failure",
      failedStage: "incremental_collection",
      complete: false,
    });
    expect(result.result.report.diagnostics).toContainEqual(
      expect.stringContaining(
        `publicBoundaryViolationKind=cache_relation_mutation publicBoundaryViolationCount=1 sourceItemNodeId=${source.nodeId}`,
      ),
    );
    expect(harness.codexExecutionCount()).toBe(0);
    expect(harness.individualCalls).toHaveLength(0);
    expect(harness.artifacts).toEqual([]);
    expect(harness.publicData).toEqual([]);
    expect(await harness.stateAdapter.resolveHead("tracker-state-v3")).toEqual({
      status: "missing",
    });
    const serializedFailure = JSON.stringify({
      report: result.result.report,
      artifacts: harness.artifacts,
      publicData: harness.publicData,
    });
    expect(serializedFailure).not.toContain(externalUrl);
    expect(serializedFailure).not.toContain("external-owner");
  });

  it("cached current external参照を毎run再検証してAI前に停止する", async () => {
    const repository = createRepository(
      "R_external_relation_cached",
      "external-relation-cached",
      FIRST_RUN_AT,
    );
    const publicRepository = requirePublicRepository(repository);
    const fixture = createRepositoryFixture(repository);
    const observedAt = createUtcIsoDateTime(FIRST_RUN_AT);
    const externalUrl = "https://github.com/external-owner/external-relation-proof/issues/2";
    const source = createIssueItem({
      repository: publicRepository,
      number: 1,
      fingerprint: externalUrl,
      updatedAt: observedAt,
      observedAt,
      state: Object.freeze({ state: "open" }),
    });
    fixture.openItems = [source];
    fixture.details.set(
      source.nodeId,
      Object.freeze({
        ...createIssueDetail({
          item: source,
          body: `body-${externalUrl}`,
          observedAt,
          nativeDependencies: Object.freeze([]),
          duplicateComments: false,
        }),
        bodyUserContentEdits: Object.freeze({
          availability: "available",
          edits: Object.freeze([]),
        }),
      }),
    );
    const baseConfig = await createTestConfig({
      explicitIncludes: [],
      retentionDays: 180,
      aiEnabled: true,
    });
    const config = configWithBudget(baseConfig, 50, baseConfig.ai.budget.maxEstimatedCostUsdPerRun);
    let visibility: ExternalRelationGraphqlItemOptions["visibility"] = "PUBLIC";
    const harness = createCollectionHarness({
      repositories: [fixture],
      config,
      executeCodexAnalysis: executeSuccessfulCodexAnalysis,
      externalRelationResponse: (request) =>
        createExternalRelationGraphqlResponse(request, {
          itemType: "issue",
          visibility,
          archived: false,
          disabled: false,
        }),
    });

    const firstResult = await harness.runDaily(FIRST_RUN_AT);
    expect(firstResult.exitCode).toBe(0);
    const firstHead = await harness.stateAdapter.resolveHead("tracker-state-v3");
    const firstDetailCallCount = harness.detailCalls.length;
    const firstPublicDataCount = harness.publicData.length;
    const firstCodexExecutionCount = harness.codexExecutionCount();
    visibility = "PRIVATE";

    const secondResult = await harness.runDaily(SECOND_RUN_AT);

    if (secondResult.command !== "daily") {
      throw new TypeError("cached external relation fixtureがdaily結果ではありません");
    }
    expect(secondResult.exitCode).toBe(1);
    expect(secondResult.result.report).toMatchObject({
      status: "failure",
      failedStage: "incremental_collection",
      complete: false,
    });
    expect(harness.externalRelationGraphqlCalls).toHaveLength(2);
    expect(harness.detailCalls).toHaveLength(firstDetailCallCount);
    expect(harness.codexExecutionCount()).toBe(firstCodexExecutionCount);
    expect(harness.publicData).toHaveLength(firstPublicDataCount);
    expect(await harness.stateAdapter.resolveHead("tracker-state-v3")).toEqual(firstHead);
    expect(JSON.stringify(secondResult.result.report)).not.toContain(externalUrl);
  });

  it.each([
    {
      description: "current reference不一致",
      corruption: "current_reference_mismatch",
      expectedQueryCount: 1,
      expectedFailedStage: "incremental_collection",
    },
    {
      description: "外部候補node ID別名",
      corruption: "node_alias",
      expectedQueryCount: 1,
      expectedFailedStage: "cache_loading",
    },
  ] satisfies readonly {
    description: string;
    corruption: CacheCandidateCorruption;
    expectedQueryCount: number;
    expectedFailedStage: "incremental_collection" | "cache_loading";
  }[])(
    "cached relationの$descriptionを握りつぶさず停止する",
    async ({ corruption, expectedQueryCount, expectedFailedStage }) => {
      const repository = createRepository(
        `R_cached_relation_corrupt_${corruption}`,
        `cached-relation-corrupt-${corruption}`,
        FIRST_RUN_AT,
      );
      const publicRepository = requirePublicRepository(repository);
      const fixture = createRepositoryFixture(repository);
      const observedAt = createUtcIsoDateTime(FIRST_RUN_AT);
      const sourceBase = createIssueItem({
        repository: publicRepository,
        number: 1,
        fingerprint: `cached-relation-corrupt-${corruption}`,
        updatedAt: observedAt,
        observedAt,
        state: Object.freeze({ state: "open" }),
      });
      const externalUrl = "https://github.com/external-owner/external-repository/issues/42";
      const source = Object.freeze({
        ...sourceBase,
        bodyFingerprint: createGitHubBodyFingerprint(`- [ ] ${externalUrl}`),
      });
      fixture.openItems = [source];
      fixture.details.set(
        source.nodeId,
        Object.freeze({
          ...createIssueDetail({
            item: source,
            body: `- [ ] ${externalUrl}`,
            observedAt,
            nativeDependencies: Object.freeze([
              createExternalNativeBlocker(source, {
                state: "open",
                repositoryArchived: false,
                repositoryDisabled: false,
              }),
            ]),
            duplicateComments: false,
          }),
          bodyUserContentEdits: Object.freeze({
            availability: "available",
            edits: Object.freeze([]),
          }),
        }),
      );
      const config = await createTestConfig({
        explicitIncludes: [],
        retentionDays: 180,
        aiEnabled: true,
      });
      const harness = createCollectionHarness({
        repositories: [fixture],
        config,
        executeCodexAnalysis: executeSuccessfulCodexAnalysis,
        externalRelationResponse: (request) =>
          createExternalRelationGraphqlResponse(request, {
            itemType: "issue",
            visibility: "PUBLIC",
            archived: false,
            disabled: false,
            nodeId: "I_external_blocker",
          }),
      });

      const firstResult = await harness.runDaily(FIRST_RUN_AT);
      expect(firstResult.exitCode, JSON.stringify(firstResult)).toBe(0);
      const head = await harness.stateAdapter.resolveHead("tracker-state-v3");
      const files = await harness.stateAdapter.readBranchFiles("tracker-state-v3");
      const itemPath = [...files.keys()].find((path) => path.startsWith("state/github-items/"));
      assertNonNullable(itemPath, "cache破損fixtureのitem cache pathがありません");
      const itemBytes = files.get(itemPath);
      assertNonNullable(itemBytes, "cache破損fixtureのitem cache bytesがありません");
      const itemDocument = createCacheDocument(JSON.parse(new TextDecoder().decode(itemBytes)));
      if (itemDocument.kind !== "github_item") {
        throw new TypeError("cache破損fixtureがitem cacheではありません");
      }
      const externalCandidate = itemDocument.relationCandidates.find(cacheCandidateHasExternalNode);
      assertNonNullable(externalCandidate, "cache破損fixtureの外部候補がありません");
      const corruptedDocument = {
        ...itemDocument,
        relationCandidates: itemDocument.relationCandidates.map((candidate) =>
          candidate.id === externalCandidate.id
            ? corruptExternalCacheCandidate(candidate, corruption)
            : candidate,
        ),
      };
      await harness.stateAdapter.commit({
        branch: "tracker-state-v3",
        expectedHead: head,
        updates: [
          {
            path: itemPath,
            bytes: new TextEncoder().encode(`${serializeCanonicalJson(corruptedDocument)}\n`),
          },
        ],
        deletions: [],
        message: "cached relation破損fixture",
        committedAt: FIRST_RUN_AT,
      });
      const corruptedHead = await harness.stateAdapter.resolveHead("tracker-state-v3");
      harness.artifacts.length = 0;
      harness.publicData.length = 0;

      const result = await harness.runCollectAnalyze(SECOND_RUN_AT);

      if (result.command !== "collect-analyze") {
        throw new TypeError("cache破損fixtureがcollect-analyze結果ではありません");
      }
      expect(
        result.exitCode,
        JSON.stringify({
          result,
          externalRelationGraphqlCalls: harness.externalRelationGraphqlCalls,
        }),
      ).toBe(1);
      expect(result.result.report).toMatchObject({
        status: "failure",
        failedStage: expectedFailedStage,
        complete: false,
      });
      expect(harness.externalRelationGraphqlCalls).toHaveLength(expectedQueryCount);
      expect(harness.artifacts).toEqual([]);
      expect(harness.publicData).toEqual([]);
      expect(await harness.stateAdapter.resolveHead("tracker-state-v3")).toEqual(corruptedHead);
      const serializedReport = JSON.stringify(result.result.report);
      expect(serializedReport).not.toContain(externalUrl);
      expect(serializedReport).not.toContain("external-owner");
      expect(serializedReport).not.toContain("malformed-cache");
    },
  );

  const cachedExternalRelationKinds = [
    { kind: "native" },
    { kind: "cross_reference" },
  ] satisfies readonly { kind: "native" | "cross_reference" }[];

  it.each(cachedExternalRelationKinds)(
    "cached $kind external候補を再検証してstateを更新する",
    async ({ kind }) => {
      const repository = createRepository(
        `R_external_cached_${kind}`,
        `external-cached-${kind}`,
        FIRST_RUN_AT,
      );
      const publicRepository = requirePublicRepository(repository);
      const fixture = createRepositoryFixture(repository);
      const observedAt = createUtcIsoDateTime(FIRST_RUN_AT);
      const source = createIssueItem({
        repository: publicRepository,
        number: 1,
        fingerprint: `external-cached-${kind}-source`,
        updatedAt: observedAt,
        observedAt,
        state: Object.freeze({ state: "open" }),
      });
      const externalRepository = requirePublicRepository(
        Object.freeze({
          id: createGitHubRepositoryId(`R_external_cached_${kind}`),
          owner: "external-owner",
          name: `external-cached-${kind}`,
          visibility: "public",
          archived: false,
          disabled: false,
          observedAt,
        }),
      );
      const externalSource = createIssueItem({
        repository: externalRepository,
        number: 42,
        fingerprint: `external-cached-${kind}-target`,
        updatedAt: observedAt,
        observedAt,
        state: Object.freeze({ state: "open" }),
      });
      const baseDetail = createIssueDetail({
        item: source,
        body: "本文",
        observedAt,
        nativeDependencies:
          kind === "native"
            ? Object.freeze([
                createExternalNativeBlocker(source, {
                  state: "open",
                  repositoryArchived: false,
                  repositoryDisabled: false,
                }),
              ])
            : Object.freeze([]),
        duplicateComments: false,
      });
      const detail =
        kind === "native"
          ? baseDetail
          : (() => {
              const crossReference = createInboundCrossReference(
                source,
                externalSource,
                observedAt,
                true,
              );
              return Object.freeze({
                ...baseDetail,
                timeline: Object.freeze([crossReference.event]),
                inboundCrossReferences: Object.freeze([crossReference.candidate]),
              });
            })();
      fixture.openItems = [source];
      fixture.details.set(source.nodeId, detail);
      const baseConfig = await createTestConfig({
        explicitIncludes: [],
        retentionDays: 180,
        aiEnabled: true,
      });
      let visibility: ExternalRelationGraphqlItemOptions["visibility"] = "PUBLIC";
      let externalState: "OPEN" | "CLOSED" = "OPEN";
      const externalNodeId = kind === "native" ? "I_external_blocker" : externalSource.nodeId;
      const harness = createCollectionHarness({
        repositories: [fixture],
        config: baseConfig,
        executeCodexAnalysis: executeSuccessfulCodexAnalysis,
        externalRelationResponse: (request) =>
          createExternalRelationGraphqlResponse(request, {
            itemType: "issue",
            visibility,
            archived: false,
            disabled: false,
            nodeId: externalNodeId,
            state: externalState,
          }),
      });

      const firstResult = await harness.runDaily(FIRST_RUN_AT);
      expect(firstResult.exitCode).toBe(0);
      const firstHead = await harness.stateAdapter.resolveHead("tracker-state-v3");
      externalState = "CLOSED";
      const secondResult = await harness.runCollectAnalyze(SECOND_RUN_AT);
      expect(secondResult.exitCode, JSON.stringify(secondResult)).toBe(0);
      expect(harness.externalRelationGraphqlCalls).toHaveLength(2);
      const secondHead = await harness.stateAdapter.resolveHead("tracker-state-v3");
      expect(secondHead.status).toBe("present");
      expect(firstHead.status).toBe("present");
      const secondArtifact = requireCollectAnalyzeArtifact(harness.artifacts);
      const secondCache = secondArtifact.cacheOnlyPayload.itemCaches.find(
        (candidate) => candidate.nodeId === source.nodeId,
      );
      if (secondCache == null) {
        throw new TypeError("cached external候補のitem cacheがありません");
      }
      const secondCandidateNode = secondCache.relationCandidates
        .flatMap((candidate) => {
          switch (candidate.relation.type) {
            case "blocks":
              return [candidate.relation.blocker, candidate.relation.blocked];
            case "parent_of":
              return [candidate.relation.parent, candidate.relation.subtask];
            case "implements":
              return [candidate.relation.implementation, candidate.relation.target];
            case "unclassified":
              return [candidate.relation.referencing, candidate.relation.referenced];
          }
        })
        .find((node) => node.scope === "external_public");
      if (secondCandidateNode == null) {
        throw new TypeError("cached external候補のnodeがありません");
      }
      expect(secondCandidateNode.state).toBe("closed");
      if (kind === "cross_reference") {
        const externalReferenceNodeId = createExternalReferenceNodeId(
          `external:github:${externalNodeId}`,
        );
        expect(secondArtifact.snapshot.externalReferences).toContainEqual(
          expect.objectContaining({
            nodeId: externalReferenceNodeId,
            state: "closed",
          }),
        );
        expect(secondArtifact.pages.details.graph.nodes).toContainEqual(
          expect.objectContaining({
            nodeId: externalReferenceNodeId,
            kind: "external_reference",
            state: "closed",
          }),
        );
      }

      visibility = "PRIVATE";
      const thirdResult = await harness.runCollectAnalyze(THIRD_RUN_AT);
      if (thirdResult.command !== "collect-analyze") {
        throw new TypeError("cached external候補の結果がcollect-analyzeではありません");
      }
      expect(thirdResult.exitCode).toBe(1);
      expect(thirdResult.result.report.diagnostics).toContainEqual(
        expect.stringContaining(
          `publicBoundaryViolationKind=cache_relation_candidate publicBoundaryViolationCount=1 sourceItemNodeId=${source.nodeId}`,
        ),
      );
      expect(await harness.stateAdapter.resolveHead("tracker-state-v3")).toEqual(secondHead);
      expect(JSON.stringify(thirdResult.result.report)).not.toContain("external-owner");
    },
  );

  it("異なるexternal参照が同じGitHub node IDを返したら停止する", async () => {
    const repository = createRepository(
      "R_external_relation_collision",
      "external-relation-collision",
      FIRST_RUN_AT,
    );
    const publicRepository = requirePublicRepository(repository);
    const fixture = createRepositoryFixture(repository);
    const observedAt = createUtcIsoDateTime(FIRST_RUN_AT);
    const source = createIssueItem({
      repository: publicRepository,
      number: 1,
      fingerprint: "external-relation-collision-source",
      updatedAt: observedAt,
      observedAt,
      state: Object.freeze({ state: "open" }),
    });
    const firstUrl = "https://github.com/external-a/repository-a/issues/1";
    const secondUrl = "https://github.com/external-b/repository-b/issues/2";
    fixture.openItems = [source];
    fixture.details.set(
      source.nodeId,
      Object.freeze({
        ...createIssueDetail({
          item: source,
          body: `- [ ] ${firstUrl}\n- [ ] ${secondUrl}`,
          observedAt,
          nativeDependencies: Object.freeze([]),
          duplicateComments: false,
        }),
        bodyUserContentEdits: Object.freeze({
          availability: "unavailable",
          reason: "connection_null",
        }),
      }),
    );
    const config = await createTestConfig({
      explicitIncludes: [],
      retentionDays: 180,
      aiEnabled: true,
    });
    const harness = createCollectionHarness({
      repositories: [fixture],
      config,
      executeCodexAnalysis: executeSuccessfulCodexAnalysis,
      externalRelationResponse: (request) =>
        createExternalRelationGraphqlResponse(request, {
          itemType: "issue",
          visibility: "PUBLIC",
          archived: false,
          disabled: false,
          nodeId: "I_external_relation_collision",
        }),
    });

    const result = await harness.runCollectAnalyze(FIRST_RUN_AT);
    if (result.command !== "collect-analyze") {
      throw new TypeError("external node ID衝突fixtureがcollect-analyze結果ではありません");
    }
    expect(result.exitCode).toBe(1);
    if (result.result.report.status !== "failure") {
      throw new TypeError("external node ID衝突fixtureが失敗reportではありません");
    }
    expect(result.result.report.failedStage).toBe("incremental_collection");
    expect(harness.codexExecutionCount()).toBe(0);
    expect(harness.artifacts).toEqual([]);
    expect(harness.publicData).toEqual([]);
    const serializedFailure = JSON.stringify(result.result.report);
    expect(serializedFailure).not.toContain(firstUrl);
    expect(serializedFailure).not.toContain(secondUrl);
    expect(serializedFailure).not.toContain("external-a");
    expect(serializedFailure).not.toContain("external-b");
  });

  it("history-only external参照はresolverを呼ばずcontent source全体をunknownにする", async () => {
    const repository = createRepository(
      "R_external_relation_history",
      "external-relation-history",
      FIRST_RUN_AT,
    );
    const publicRepository = requirePublicRepository(repository);
    const fixture = createRepositoryFixture(repository);
    const observedAt = createUtcIsoDateTime(FIRST_RUN_AT);
    const source = createIssueItem({
      repository: publicRepository,
      number: 1,
      fingerprint: "external-relation-history-source",
      updatedAt: observedAt,
      observedAt,
      state: Object.freeze({ state: "open" }),
    });
    const externalUrl = "https://github.com/external-owner/external-relation-proof/issues/2";
    const createEdit = (
      id: string,
      sequence: number,
      editedAt: UtcIsoDateTime,
      diff: string,
    ): GitHubUserContentEdit =>
      Object.freeze({
        sourceId: buildSourceId("github_user_content_edit", id),
        sequence,
        createdAt: source.createdAt,
        deletedAt: null,
        diff,
        editedAt,
        editor: Object.freeze({
          status: "unavailable",
          reason: "github_did_not_return_actor",
        }),
        updatedAt: editedAt,
      });
    const addedAt = createUtcIsoDateTime("2026-07-01T01:00:00.000Z");
    const removedAt = createUtcIsoDateTime("2026-07-01T02:00:00.000Z");
    fixture.openItems = [source];
    fixture.details.set(
      source.nodeId,
      Object.freeze({
        ...createIssueDetail({
          item: source,
          body: "本文",
          observedAt,
          nativeDependencies: Object.freeze([]),
          duplicateComments: false,
        }),
        bodyUserContentEdits: Object.freeze({
          availability: "available",
          edits: Object.freeze([
            createEdit(`${source.nodeId}:empty`, 0, source.createdAt, ""),
            createEdit(`${source.nodeId}:added`, 1, addedAt, externalUrl),
            createEdit(`${source.nodeId}:removed`, 2, removedAt, "本文"),
          ]),
        }),
      }),
    );
    const baseConfig = await createTestConfig({
      explicitIncludes: [],
      retentionDays: 180,
      aiEnabled: true,
    });
    const config = configWithBudget(baseConfig, 50, baseConfig.ai.budget.maxEstimatedCostUsdPerRun);
    const harness = createCollectionHarness({
      repositories: [fixture],
      config,
      executeCodexAnalysis: executeSuccessfulCodexAnalysis,
    });

    const result = await harness.runCollectAnalyze(FIRST_RUN_AT);

    expect(result.exitCode).toBe(0);
    expect(harness.externalRelationGraphqlCalls).toHaveLength(0);
    expect(harness.individualCalls).toHaveLength(0);
    expect(harness.codexExecutionCount()).toBeGreaterThan(0);
    const artifact = requireCollectAnalyzeArtifact(harness.artifacts);
    const itemCache = artifact.cacheOnlyPayload.itemCaches.find(
      (candidate) => candidate.nodeId === source.nodeId,
    );
    if (itemCache == null) {
      throw new TypeError("external historyのitem cacheがありません");
    }
    expect(itemCache.relationMutations).toContainEqual({
      status: "unknown",
      contentSourceId: buildSourceId("github_item_body", source.nodeId),
      reason: "repository_public_boundary_unverified",
    });
    const serializedArtifact = JSON.stringify(artifact);
    expect(serializedArtifact).not.toContain(externalUrl);
    expect(serializedArtifact).not.toContain("external-owner");
  });

  it("allowlist内current参照先を重複なく個別取得して再抽出する", async () => {
    const repository = createRepository(
      "R_internal_relation_expansion",
      "internal-relation-expansion",
      FIRST_RUN_AT,
    );
    const publicRepository = requirePublicRepository(repository);
    const fixture = createRepositoryFixture(repository);
    const observedAt = createUtcIsoDateTime(FIRST_RUN_AT);
    const source = createIssueItem({
      repository: publicRepository,
      number: 1,
      fingerprint: "internal-relation-expansion-source",
      updatedAt: observedAt,
      observedAt,
      state: Object.freeze({ state: "open" }),
    });
    const target = createIssueItem({
      repository: publicRepository,
      number: 2,
      fingerprint: "internal-relation-expansion-target",
      updatedAt: observedAt,
      observedAt,
      state: Object.freeze({
        state: "closed",
        closedAt: observedAt,
      }),
    });
    const comment = createDuplicateComments(source, observedAt)[0];
    assertNonNullable(comment, "internal relationのcomment fixtureがありません");
    const bodySourceId = buildSourceId("github_item_body", source.nodeId);
    const detail = createIssueDetail({
      item: source,
      body: `- [ ] ${target.url}`,
      observedAt,
      nativeDependencies: Object.freeze([]),
      duplicateComments: false,
    });
    fixture.openItems = [source];
    fixture.individualItems.set(target.url, target);
    fixture.details.set(
      source.nodeId,
      Object.freeze({
        ...detail,
        bodyUserContentEdits: Object.freeze({
          availability: "available",
          edits: Object.freeze([]),
        }),
        comments: Object.freeze([
          Object.freeze({
            ...comment,
            body: target.url,
            userContentEdits: Object.freeze({
              availability: "available",
              edits: Object.freeze([]),
            }),
          }),
        ]),
      }),
    );
    fixture.details.set(
      target.nodeId,
      createIssueDetail({
        item: target,
        body: "対象項目の本文です",
        observedAt,
        nativeDependencies: Object.freeze([]),
        duplicateComments: false,
      }),
    );
    const baseConfig = await createTestConfig({
      explicitIncludes: [],
      retentionDays: 180,
      aiEnabled: true,
    });
    const config = configWithBudget(baseConfig, 50, baseConfig.ai.budget.maxEstimatedCostUsdPerRun);
    const harness = createCollectionHarness({
      repositories: [fixture],
      config,
      executeCodexAnalysis: executeSuccessfulCodexAnalysis,
    });

    const result = await harness.runCollectAnalyze(FIRST_RUN_AT);

    expect(result.exitCode).toBe(0);
    expect(harness.individualCalls).toEqual([[target.url]]);
    expect(
      harness.detailCalls.flatMap((call) => call.targets.map((item) => item.nodeId)),
    ).toContain(target.nodeId);
    expect(harness.codexExecutionCount()).toBeGreaterThan(0);
    const artifact = requireCollectAnalyzeArtifact(harness.artifacts);
    const itemCache = artifact.cacheOnlyPayload.itemCaches.find(
      (item) => item.nodeId === source.nodeId,
    );
    if (itemCache == null) {
      throw new TypeError("internal relationのitem cacheがありません");
    }
    expect(
      itemCache.relationCandidates.some((candidate) => {
        switch (candidate.relation.type) {
          case "blocks":
            return [candidate.relation.blocker, candidate.relation.blocked].some(
              (node) => node.nodeId === target.nodeId,
            );
          case "parent_of":
            return [candidate.relation.parent, candidate.relation.subtask].some(
              (node) => node.nodeId === target.nodeId,
            );
          case "implements":
            return [candidate.relation.implementation, candidate.relation.target].some(
              (node) => node.nodeId === target.nodeId,
            );
          case "unclassified":
            return [candidate.relation.referencing, candidate.relation.referenced].some(
              (node) => node.nodeId === target.nodeId,
            );
        }
      }),
    ).toBe(true);
    expect(
      itemCache.relationCandidates.some((candidate) => candidate.sourceIds.includes(bodySourceId)),
    ).toBe(true);
    expect(
      itemCache.relationCandidates.some((candidate) =>
        candidate.sourceIds.includes(comment.sourceId),
      ),
    ).toBe(true);
    expect(requireCollectionItem(artifact.snapshot, target.nodeId)).toMatchObject({
      nodeId: target.nodeId,
    });
  });

  it("allowlist内current関係参照の個別列挙503をstale repositoryへ移す", async () => {
    const repository = createRepository(
      "R_internal_relation_stale",
      "internal-relation-stale",
      FIRST_RUN_AT,
    );
    const publicRepository = requirePublicRepository(repository);
    const fixture = createRepositoryFixture(repository);
    const firstObservedAt = createUtcIsoDateTime(FIRST_RUN_AT);
    const firstSource = createIssueItem({
      repository: publicRepository,
      number: 1,
      fingerprint: "internal-relation-stale-source-v1",
      updatedAt: firstObservedAt,
      observedAt: firstObservedAt,
      state: Object.freeze({ state: "open" }),
    });
    const target = createIssueItem({
      repository: publicRepository,
      number: 2,
      fingerprint: "internal-relation-stale-target",
      updatedAt: firstObservedAt,
      observedAt: firstObservedAt,
      state: Object.freeze({
        state: "closed",
        closedAt: firstObservedAt,
      }),
    });
    fixture.openItems = [firstSource];
    fixture.individualItems.set(target.url, target);
    fixture.details.set(
      firstSource.nodeId,
      createIssueDetail({
        item: firstSource,
        body: "本文",
        observedAt: firstObservedAt,
        nativeDependencies: Object.freeze([]),
        duplicateComments: false,
      }),
    );
    fixture.details.set(
      target.nodeId,
      createIssueDetail({
        item: target,
        body: "対象項目の本文です",
        observedAt: firstObservedAt,
        nativeDependencies: Object.freeze([]),
        duplicateComments: false,
      }),
    );
    let failIndividualEnumeration = false;
    const baseConfig = await createTestConfig({
      explicitIncludes: [],
      retentionDays: 180,
      aiEnabled: true,
    });
    const config = configWithBudget(baseConfig, 50, baseConfig.ai.budget.maxEstimatedCostUsdPerRun);
    const harness = createCollectionHarness({
      repositories: [fixture],
      config,
      executeCodexAnalysis: executeSuccessfulCodexAnalysis,
      enumerateGitHubItemsByIdentifiers: () => {
        if (failIndividualEnumeration) {
          throw new GitHubRetryExhaustedError(503, 4, {
            cause: new Error("current relation個別列挙fixture 503"),
          });
        }
        return Promise.resolve(Object.freeze([target]));
      },
    });

    expect((await harness.runDaily(FIRST_RUN_AT)).exitCode).toBe(0);
    const firstHead = await harness.stateAdapter.resolveHead("tracker-state-v3");
    const firstFiles = await harness.stateAdapter.readBranchFiles("tracker-state-v3");
    const cacheSession = await CacheOnlyPersistenceSession.open(
      harness.stateAdapter,
      config.state,
      createPublicRepositoryAllowlist([repository]),
    );
    const loaded = await cacheSession.load({
      evaluatedAt: firstObservedAt,
      knownSecrets: [],
    });
    if (loaded.status !== "available") {
      throw new TypeError("current relation stale fixtureのcacheがありません");
    }

    const secondObservedAt = createUtcIsoDateTime(SECOND_RUN_AT);
    const secondSource = createIssueItem({
      repository: publicRepository,
      number: 1,
      fingerprint: "internal-relation-stale-source-v2",
      updatedAt: secondObservedAt,
      observedAt: secondObservedAt,
      state: Object.freeze({ state: "open" }),
    });
    fixture.openItems = [secondSource];
    fixture.details.set(
      secondSource.nodeId,
      Object.freeze({
        ...createIssueDetail({
          item: secondSource,
          body: target.url,
          observedAt: secondObservedAt,
          nativeDependencies: Object.freeze([]),
          duplicateComments: false,
        }),
        bodyUserContentEdits: Object.freeze({
          availability: "available",
          edits: Object.freeze([]),
        }),
      }),
    );
    failIndividualEnumeration = true;
    harness.detailCalls.length = 0;
    harness.individualCalls.length = 0;
    harness.artifacts.length = 0;
    harness.publicData.length = 0;
    const firstCodexExecutionCount = harness.codexExecutionCount();

    const result = await harness.runCollectAnalyze(SECOND_RUN_AT);
    const artifact = requireCollectAnalyzeArtifact(harness.artifacts);
    const secondFiles = await harness.stateAdapter.readBranchFiles("tracker-state-v3");

    expect(result.exitCode).toBe(0);
    expect(harness.individualCalls).toEqual([[target.url]]);
    expect(
      harness.detailCalls.flatMap((call) => call.targets.map((item) => item.nodeId)),
    ).not.toContain(target.nodeId);
    expect(harness.codexExecutionCount()).toBe(firstCodexExecutionCount);
    expect(artifact.cacheOnlyPayload.repositoryCaches).toEqual(loaded.repositoryCaches);
    expect(artifact.cacheOnlyPayload.itemCaches).toEqual(loaded.itemCaches);
    expect(artifact.cacheOnlyPayload.latestImportanceCaches).toEqual(loaded.latestImportanceCaches);
    expect(artifact.cacheOnlyPayload.aiCacheEntries).toEqual(loaded.aiCacheEntries);
    expect([...secondFiles].map(([path, bytes]) => [path, [...bytes]])).toEqual(
      [...firstFiles].map(([path, bytes]) => [path, [...bytes]]),
    );
    expect(await harness.stateAdapter.resolveHead("tracker-state-v3")).toEqual(firstHead);
    expect(artifact.snapshot.items.map((item) => item.nodeId)).not.toContain(target.nodeId);
    expect(artifact.snapshot.relations).not.toContainEqual(
      expect.objectContaining({
        toNodeId: target.nodeId,
      }),
    );
  });

  it("allowlist内current関係参照の個別列挙503はcacheなしで失敗する", async () => {
    const repository = createRepository(
      "R_internal_relation_cacheless",
      "internal-relation-cacheless",
      FIRST_RUN_AT,
    );
    const publicRepository = requirePublicRepository(repository);
    const fixture = createRepositoryFixture(repository);
    const observedAt = createUtcIsoDateTime(FIRST_RUN_AT);
    const source = createIssueItem({
      repository: publicRepository,
      number: 1,
      fingerprint: "internal-relation-cacheless-source",
      updatedAt: observedAt,
      observedAt,
      state: Object.freeze({ state: "open" }),
    });
    const targetUrl = `https://github.com/${publicRepository.owner}/${publicRepository.name}/issues/2`;
    fixture.openItems = [source];
    fixture.details.set(
      source.nodeId,
      Object.freeze({
        ...createIssueDetail({
          item: source,
          body: targetUrl,
          observedAt,
          nativeDependencies: Object.freeze([]),
          duplicateComments: false,
        }),
        bodyUserContentEdits: Object.freeze({
          availability: "available",
          edits: Object.freeze([]),
        }),
      }),
    );
    const config = await createTestConfig({
      explicitIncludes: [],
      retentionDays: 180,
      aiEnabled: true,
    });
    const harness = createCollectionHarness({
      repositories: [fixture],
      config,
      enumerateGitHubItemsByIdentifiers: () => {
        return Promise.reject(
          new GitHubRetryExhaustedError(503, 4, {
            cause: new Error("cacheless current relation個別列挙fixture 503"),
          }),
        );
      },
    });

    const result = await harness.runCollectAnalyze(FIRST_RUN_AT);

    expect(result.exitCode).toBe(1);
    expect(harness.individualCalls).toEqual([[targetUrl]]);
    expect(harness.externalRelationGraphqlCalls).toHaveLength(0);
    expect(harness.artifacts).toEqual([]);
    expect(harness.publicData).toEqual([]);
    expect(await harness.stateAdapter.resolveHead("tracker-state-v3")).toEqual({
      status: "missing",
    });
  });

  it.each([
    { description: "open列挙済み", targetIsOpen: true },
    { description: "個別列挙", targetIsOpen: false },
  ] satisfies readonly { description: string; targetIsOpen: boolean }[])(
    "current参照の$description IssueとPull Request種別不一致を停止する",
    async ({ targetIsOpen }) => {
      const repository = createRepository(
        "R_internal_relation_type",
        "internal-relation-type",
        FIRST_RUN_AT,
      );
      const publicRepository = requirePublicRepository(repository);
      const fixture = createRepositoryFixture(repository);
      const observedAt = createUtcIsoDateTime(FIRST_RUN_AT);
      const source = createIssueItem({
        repository: publicRepository,
        number: 1,
        fingerprint: "internal-relation-type-source",
        updatedAt: observedAt,
        observedAt,
        state: Object.freeze({ state: "open" }),
      });
      const target = createIssueItem({
        repository: publicRepository,
        number: 2,
        fingerprint: "internal-relation-type-target",
        updatedAt: observedAt,
        observedAt,
        state: Object.freeze({ state: "open" }),
      });
      fixture.openItems = targetIsOpen ? [source, target] : [source];
      if (!targetIsOpen) {
        fixture.individualItems.set(target.url, target);
      }
      fixture.details.set(
        source.nodeId,
        Object.freeze({
          ...createIssueDetail({
            item: source,
            body: `https://github.com/${publicRepository.owner}/${publicRepository.name}/pull/2`,
            observedAt,
            nativeDependencies: Object.freeze([]),
            duplicateComments: false,
          }),
          bodyUserContentEdits: Object.freeze({
            availability: "available",
            edits: Object.freeze([]),
          }),
        }),
      );
      fixture.details.set(
        target.nodeId,
        createIssueDetail({
          item: target,
          body: "対象項目の本文です",
          observedAt,
          nativeDependencies: Object.freeze([]),
          duplicateComments: false,
        }),
      );
      const baseConfig = await createTestConfig({
        explicitIncludes: [],
        retentionDays: 180,
        aiEnabled: true,
      });
      const config = configWithBudget(
        baseConfig,
        50,
        baseConfig.ai.budget.maxEstimatedCostUsdPerRun,
      );
      const harness = createCollectionHarness({
        repositories: [fixture],
        config,
        executeCodexAnalysis: executeSuccessfulCodexAnalysis,
      });

      const result = await harness.runCollectAnalyze(FIRST_RUN_AT);

      if (result.command !== "collect-analyze") {
        throw new TypeError("relation種別不一致fixtureがcollect-analyze結果ではありません");
      }
      expect(result.exitCode).toBe(1);
      expect(result.result.report).toMatchObject({
        status: "failure",
        failedStage: "incremental_collection",
        complete: false,
      });
      expect(harness.individualCalls).toEqual(
        targetIsOpen
          ? []
          : [[`https://github.com/${publicRepository.owner}/${publicRepository.name}/issues/2`]],
      );
      expect(harness.externalRelationGraphqlCalls).toHaveLength(0);
      expect(harness.codexExecutionCount()).toBe(0);
      expect(harness.artifacts).toEqual([]);
      expect(harness.publicData).toEqual([]);
    },
  );

  it("fresh itemのrelation mutation公開境界違反をAI実行前に停止する", async () => {
    const repository = createRepository(
      "R_fresh_relation_boundary",
      "fresh-relation-boundary",
      FIRST_RUN_AT,
    );
    const publicRepository = requirePublicRepository(repository);
    const fixture = createRepositoryFixture(repository);
    const observedAt = createUtcIsoDateTime(FIRST_RUN_AT);
    const source = createIssueItem({
      repository: publicRepository,
      number: 1,
      fingerprint: "fresh-relation-boundary-source",
      updatedAt: observedAt,
      observedAt,
      state: Object.freeze({ state: "open" }),
    });
    const mutationTargetRepositoryName = "not-allowlisted-text";
    fixture.openItems = [source];
    fixture.details.set(
      source.nodeId,
      Object.freeze({
        ...createIssueDetail({
          item: source,
          body: `https://github.com/VOICEVOX/${mutationTargetRepositoryName}/issues/2`,
          observedAt,
          nativeDependencies: Object.freeze([]),
          duplicateComments: false,
        }),
        bodyUserContentEdits: Object.freeze({
          availability: "available",
          edits: Object.freeze([]),
        }),
      }),
    );
    const baseConfig = await createTestConfig({
      explicitIncludes: [],
      retentionDays: 180,
      aiEnabled: true,
    });
    const config = configWithBudget(baseConfig, 50, baseConfig.ai.budget.maxEstimatedCostUsdPerRun);
    const harness = createCollectionHarness({ repositories: [fixture], config });

    const result = await harness.runCollectAnalyze(FIRST_RUN_AT);

    if (result.command !== "collect-analyze") {
      throw new TypeError("fresh relation公開境界fixtureがcollect-analyze結果ではありません");
    }
    expect(result.exitCode).toBe(1);
    expect(result.result.report).toMatchObject({
      status: "failure",
      failedStage: "incremental_collection",
      complete: false,
    });
    expect(result.result.report.diagnostics).toContainEqual(
      expect.stringContaining(
        `publicBoundaryViolationKind=cache_relation_mutation publicBoundaryViolationCount=1 sourceItemNodeId=${source.nodeId}`,
      ),
    );
    expect(harness.codexExecutionCount()).toBe(0);
    expect(harness.individualCalls).toHaveLength(0);
    expect(harness.externalRelationGraphqlCalls).toHaveLength(0);
    expect(harness.artifacts).toEqual([]);
    expect(harness.publicData).toEqual([]);
    expect(await harness.stateAdapter.resolveHead("tracker-state-v3")).toEqual({
      status: "missing",
    });
  });

  it("current候補を残して過去の未allowlist参照だけをunknownにする", async () => {
    const repository = createRepository(
      "R_relation_history_boundary",
      "relation-history-boundary",
      FIRST_RUN_AT,
    );
    const publicRepository = requirePublicRepository(repository);
    const fixture = createRepositoryFixture(repository);
    const observedAt = createUtcIsoDateTime(FIRST_RUN_AT);
    const source = createIssueItem({
      repository: publicRepository,
      number: 1,
      fingerprint: "relation-history-boundary-source",
      updatedAt: observedAt,
      observedAt,
      state: Object.freeze({ state: "open" }),
    });
    const target = createIssueItem({
      repository: publicRepository,
      number: 2,
      fingerprint: "relation-history-boundary-target",
      updatedAt: observedAt,
      observedAt,
      state: Object.freeze({ state: "open" }),
    });
    const currentBody = `対応先は ${target.url} です`;
    const historicalTypo = "https://github.com/VOICEVOX/relation-history-boundary-typo/issues/99";
    const createEdit = (
      id: string,
      sequence: number,
      editedAt: UtcIsoDateTime,
      diff: string,
    ): GitHubUserContentEdit =>
      Object.freeze({
        sourceId: buildSourceId("github_user_content_edit", id),
        sequence,
        createdAt: source.createdAt,
        deletedAt: null,
        diff,
        editedAt,
        editor: Object.freeze({
          status: "unavailable",
          reason: "github_did_not_return_actor",
        }),
        updatedAt: editedAt,
      } satisfies GitHubUserContentEdit);
    const historicalAddedAt = createUtcIsoDateTime("2026-07-01T01:00:00.000Z");
    const historicalRemovedAt = createUtcIsoDateTime("2026-07-01T02:00:00.000Z");
    fixture.openItems = [source, target];
    fixture.details.set(
      source.nodeId,
      Object.freeze({
        ...createIssueDetail({
          item: source,
          body: currentBody,
          observedAt,
          nativeDependencies: Object.freeze([]),
          duplicateComments: false,
        }),
        bodyUserContentEdits: Object.freeze({
          availability: "available",
          edits: Object.freeze([
            createEdit(`${source.nodeId}:empty`, 0, source.createdAt, ""),
            createEdit(`${source.nodeId}:historical-typo`, 1, historicalAddedAt, historicalTypo),
            createEdit(`${source.nodeId}:current`, 2, historicalRemovedAt, currentBody),
          ]),
        }),
      }),
    );
    fixture.details.set(
      target.nodeId,
      createIssueDetail({
        item: target,
        body: "対象項目の本文です",
        observedAt,
        nativeDependencies: Object.freeze([]),
        duplicateComments: false,
      }),
    );
    const baseConfig = await createTestConfig({
      explicitIncludes: [],
      retentionDays: 180,
      aiEnabled: true,
    });
    const config = configWithBudget(baseConfig, 50, baseConfig.ai.budget.maxEstimatedCostUsdPerRun);
    const harness = createCollectionHarness({
      repositories: [fixture],
      config,
      executeCodexAnalysis: executeSuccessfulCodexAnalysis,
    });

    const result = await harness.runCollectAnalyze(FIRST_RUN_AT);
    const artifact = requireCollectAnalyzeArtifact(harness.artifacts);
    const itemCache = artifact.cacheOnlyPayload.itemCaches.find(
      (candidate) => candidate.nodeId === source.nodeId,
    );
    if (itemCache == null) {
      throw new TypeError("relation historyのitem cacheがありません");
    }
    const bodyMutation = itemCache.relationMutations.find(
      (candidate) => candidate.contentSourceId === buildSourceId("github_item_body", source.nodeId),
    );
    if (bodyMutation == null) {
      throw new TypeError("relation historyの本文mutationがありません");
    }

    expect(result.exitCode).toBe(0);
    expect(harness.codexExecutionCount()).toBeGreaterThan(0);
    expect(bodyMutation).toEqual({
      status: "unknown",
      contentSourceId: buildSourceId("github_item_body", source.nodeId),
      reason: "repository_public_boundary_unverified",
    });
    expect(
      itemCache.relationCandidates.some((candidate) =>
        candidate.sourceIds.includes(buildSourceId("github_item_body", source.nodeId)),
      ),
    ).toBe(true);
    const serializedArtifact = JSON.stringify(artifact);
    expect(serializedArtifact).toContain(
      `relationMutationUnknown sourceItemNodeId=${source.nodeId} reason=repository_public_boundary_unverified count=1`,
    );
    expect(serializedArtifact).not.toContain("relation-history-boundary-typo");
    expect(serializedArtifact).not.toContain("historical-typo");
  });

  it("外部ghostをtemporal graphとblocker判定から除外する", async () => {
    const repository = createRepository("R_blockers", "blockers", FIRST_RUN_AT);
    const publicRepository = requirePublicRepository(repository);
    const fixture = createRepositoryFixture(repository);
    const observedAt = createUtcIsoDateTime(FIRST_RUN_AT);
    const items = [1, 2, 3].map((number) =>
      createIssueItem({
        repository: publicRepository,
        number,
        fingerprint: `blocker-${number.toString()}`,
        updatedAt: observedAt,
        observedAt,
        state: Object.freeze({ state: "open" }),
      }),
    );
    const blocked = items[0];
    const firstBlocker = items[1];
    const secondBlocker = items[2];
    if (blocked == null || firstBlocker == null || secondBlocker == null) {
      throw new TypeError("複数blocker fixtureがありません");
    }
    fixture.openItems = [...items];
    setIssueDetails(fixture, items, observedAt);
    fixture.details.set(
      blocked.nodeId,
      createIssueDetail({
        item: blocked,
        body: "複数の依存項目があります",
        observedAt,
        nativeDependencies: Object.freeze([
          createNativeBlocker(blocked, firstBlocker),
          createNativeBlocker(blocked, secondBlocker),
          createExternalNativeBlocker(blocked, {
            state: "open",
            repositoryArchived: false,
            repositoryDisabled: false,
          }),
        ]),
        duplicateComments: false,
      }),
    );
    const config = await createTestConfig({
      explicitIncludes: [],
      retentionDays: 180,
      aiEnabled: false,
    });
    const harness = createCollectionHarness({
      repositories: [fixture],
      config,
      externalRelationResponse: (request) =>
        createExternalRelationGraphqlResponse(request, {
          itemType: "issue",
          visibility: "PUBLIC",
          archived: false,
          disabled: false,
          nodeId: "I_external_blocker",
        }),
    });

    const result = await harness.runCollectAnalyze(FIRST_RUN_AT);
    const artifact = requireCollectAnalyzeArtifact(harness.artifacts);
    const snapshot = artifact.snapshot;
    const trackedItem = snapshot.items.find((item) => item.nodeId === blocked.nodeId);
    const publicItem = artifact.pages.summary.items.find((item) => item.nodeId === blocked.nodeId);

    expect(result.exitCode).toBe(0);
    expect(trackedItem?.waitingOn).toHaveLength(2);
    expect(trackedItem?.primaryWaitingOn.index).toBe(0);
    expect(trackedItem?.primaryWaitingOn.selectionReason).not.toBe("");
    expect(snapshot.externalReferences).toEqual([]);
    expect(publicItem?.primaryWaitingOn).toEqual(trackedItem?.primaryWaitingOn);
    expect(new Set(publicItem?.blockerNodeIds)).toEqual(
      new Set([firstBlocker.nodeId, secondBlocker.nodeId]),
    );
    expect(artifact.pages.details.graph.nodes).not.toContainEqual(
      expect.objectContaining({ kind: "external_reference" }),
    );
  });

  it.each([
    {
      description: "archive済み",
      fixtureName: "archived",
      repositoryArchived: true,
      repositoryDisabled: false,
    },
    {
      description: "disabled",
      fixtureName: "disabled",
      repositoryArchived: false,
      repositoryDisabled: true,
    },
  ])(
    "Organization外の$description repositoryをstateと公開DTOへ残さない",
    async ({ fixtureName, repositoryArchived, repositoryDisabled }) => {
      const repository = createRepository(
        `R_excluded_external_${fixtureName}`,
        `excluded-external-${fixtureName}`,
        FIRST_RUN_AT,
      );
      const publicRepository = requirePublicRepository(repository);
      const fixture = createRepositoryFixture(repository);
      const observedAt = createUtcIsoDateTime(FIRST_RUN_AT);
      const blocked = createIssueItem({
        repository: publicRepository,
        number: 1,
        fingerprint: `excluded-external-${fixtureName}`,
        updatedAt: observedAt,
        observedAt,
        state: Object.freeze({ state: "open" }),
      });
      fixture.openItems = [blocked];
      fixture.details.set(
        blocked.nodeId,
        createIssueDetail({
          item: blocked,
          body: "除外対象の外部依存があります",
          observedAt,
          nativeDependencies: Object.freeze([
            createExternalNativeBlocker(blocked, {
              state: "open",
              repositoryArchived,
              repositoryDisabled,
            }),
          ]),
          duplicateComments: false,
        }),
      );
      const config = await createTestConfig({
        explicitIncludes: [],
        retentionDays: 180,
        aiEnabled: false,
      });
      const harness = createCollectionHarness({ repositories: [fixture], config });

      const result = await harness.runCollectAnalyze(FIRST_RUN_AT);
      const artifact = requireCollectAnalyzeArtifact(harness.artifacts);
      const snapshot = artifact.snapshot;

      expect(result.exitCode).toBe(0);
      expect(snapshot.externalReferences).toEqual([]);
      expect(snapshot.relations).toEqual([]);
      expect(artifact.pages.details.graph.nodes).not.toContainEqual(
        expect.objectContaining({
          nodeId: "external:github:I_external_blocker",
        }),
      );
      expect(artifact.pages.details.graph.edges).toEqual([]);
    },
  );

  it("複数blockerのcloseとmergeとedge消失による依存解消時刻をrun開始時刻に依存させない", async () => {
    const issueClosedAt = createUtcIsoDateTime("2026-08-02T08:00:00.000Z");
    const pullRequestMergedAt = createUtcIsoDateTime("2026-08-02T16:00:00.000Z");
    const resolutionObservedAt = createUtcIsoDateTime("2026-08-03T00:00:00.000Z");
    const withAvailableEmptyBodyHistory = (detail: GitHubItemDetail): GitHubItemDetail =>
      Object.freeze({
        ...detail,
        bodyUserContentEdits: Object.freeze({
          availability: "available",
          edits: Object.freeze([]),
        }),
      });
    const runResolutionAt = async (
      startedAt: string,
    ): Promise<
      Readonly<{
        lastProgressAt: UtcIsoDateTime;
        stallSince: UtcIsoDateTime;
      }>
    > => {
      const repository = createRepository(
        "R_deterministic_dependency",
        "deterministic-dependency",
        FIRST_RUN_AT,
      );
      const publicRepository = requirePublicRepository(repository);
      const fixture = createRepositoryFixture(repository);
      const firstObservedAt = createUtcIsoDateTime(FIRST_RUN_AT);
      const blocked = createIssueItem({
        repository: publicRepository,
        number: 1,
        fingerprint: "deterministic-blocked",
        updatedAt: firstObservedAt,
        observedAt: firstObservedAt,
        state: Object.freeze({ state: "open" }),
      });
      const issueBlocker = createIssueItem({
        repository: publicRepository,
        number: 2,
        fingerprint: "deterministic-issue-blocker-open",
        updatedAt: firstObservedAt,
        observedAt: firstObservedAt,
        state: Object.freeze({ state: "open" }),
      });
      const pullRequestBlocker = createPullRequestItem({
        repository: publicRepository,
        number: 3,
        fingerprint: "deterministic-pr-blocker-open",
        updatedAt: firstObservedAt,
        observedAt: firstObservedAt,
      });
      const edgeBlocker = createIssueItem({
        repository: publicRepository,
        number: 4,
        fingerprint: "deterministic-edge-blocker",
        updatedAt: firstObservedAt,
        observedAt: firstObservedAt,
        state: Object.freeze({ state: "open" }),
      });
      fixture.openItems = [blocked, issueBlocker, pullRequestBlocker, edgeBlocker];
      fixture.details.set(
        issueBlocker.nodeId,
        withAvailableEmptyBodyHistory(
          createIssueDetail({
            item: issueBlocker,
            body: "本文",
            observedAt: firstObservedAt,
            nativeDependencies: Object.freeze([]),
            duplicateComments: false,
          }),
        ),
      );
      fixture.details.set(
        edgeBlocker.nodeId,
        withAvailableEmptyBodyHistory(
          createIssueDetail({
            item: edgeBlocker,
            body: "本文",
            observedAt: firstObservedAt,
            nativeDependencies: Object.freeze([]),
            duplicateComments: false,
          }),
        ),
      );
      fixture.details.set(
        pullRequestBlocker.nodeId,
        withAvailableEmptyBodyHistory(
          createFailedCheckPullRequestDetail(pullRequestBlocker, firstObservedAt),
        ),
      );
      const initialBlockedDetail = createIssueDetail({
        item: blocked,
        body: "IssueとPull Requestの完了を待ちます",
        observedAt: firstObservedAt,
        nativeDependencies: Object.freeze([
          createNativeBlocker(blocked, issueBlocker),
          createNativeBlocker(blocked, pullRequestBlocker),
          createNativeBlocker(blocked, edgeBlocker),
        ]),
        duplicateComments: false,
      });
      fixture.details.set(
        blocked.nodeId,
        withAvailableEmptyBodyHistory(
          Object.freeze({
            ...initialBlockedDetail,
            timeline: Object.freeze([
              createNativeDependencyTimelineEvent(
                blocked,
                issueBlocker,
                "added",
                blocked.createdAt,
                0,
              ),
              createNativeDependencyTimelineEvent(
                blocked,
                pullRequestBlocker,
                "added",
                blocked.createdAt,
                1,
              ),
              createNativeDependencyTimelineEvent(
                blocked,
                edgeBlocker,
                "added",
                blocked.createdAt,
                2,
              ),
            ]),
          }),
        ),
      );
      const config = await createTestConfig({
        explicitIncludes: [],
        retentionDays: 180,
        aiEnabled: false,
      });
      const harness = createCollectionHarness({ repositories: [fixture], config });
      expect((await harness.runDaily(FIRST_RUN_AT)).exitCode).toBe(0);

      const currentBlocked = createIssueItem({
        repository: publicRepository,
        number: 1,
        fingerprint: "deterministic-blocked",
        updatedAt: firstObservedAt,
        observedAt: resolutionObservedAt,
        state: Object.freeze({ state: "open" }),
      });
      const closedIssueBlocker = createIssueItem({
        repository: publicRepository,
        number: 2,
        fingerprint: "deterministic-issue-blocker-closed",
        updatedAt: issueClosedAt,
        observedAt: resolutionObservedAt,
        state: Object.freeze({
          state: "closed",
          closedAt: issueClosedAt,
        }),
      });
      const mergedPullRequestBlocker = createMergedPullRequestItem({
        repository: publicRepository,
        number: 3,
        fingerprint: "deterministic-pr-blocker-merged",
        closedAt: pullRequestMergedAt,
        mergedAt: pullRequestMergedAt,
        observedAt: resolutionObservedAt,
      });
      const currentEdgeBlocker = createIssueItem({
        repository: publicRepository,
        number: 4,
        fingerprint: "deterministic-edge-blocker",
        updatedAt: firstObservedAt,
        observedAt: resolutionObservedAt,
        state: Object.freeze({ state: "open" }),
      });
      fixture.openItems = [currentBlocked, currentEdgeBlocker];
      fixture.individualItems.set(closedIssueBlocker.nodeId, closedIssueBlocker);
      fixture.individualItems.set(mergedPullRequestBlocker.nodeId, mergedPullRequestBlocker);
      fixture.details.set(
        closedIssueBlocker.nodeId,
        withAvailableEmptyBodyHistory(
          createIssueDetail({
            item: closedIssueBlocker,
            body: "本文",
            observedAt: resolutionObservedAt,
            nativeDependencies: Object.freeze([]),
            duplicateComments: false,
          }),
        ),
      );
      fixture.details.set(
        currentEdgeBlocker.nodeId,
        withAvailableEmptyBodyHistory(
          createIssueDetail({
            item: currentEdgeBlocker,
            body: "本文",
            observedAt: resolutionObservedAt,
            nativeDependencies: Object.freeze([]),
            duplicateComments: false,
          }),
        ),
      );
      fixture.details.set(
        mergedPullRequestBlocker.nodeId,
        withAvailableEmptyBodyHistory(
          createFailedCheckPullRequestDetail(mergedPullRequestBlocker, resolutionObservedAt),
        ),
      );
      const currentBlockedDetail = createIssueDetail({
        item: currentBlocked,
        body: "IssueとPull Requestの完了を待ちます",
        observedAt: resolutionObservedAt,
        nativeDependencies: Object.freeze([
          createNativeBlocker(currentBlocked, closedIssueBlocker),
          createNativeBlocker(currentBlocked, mergedPullRequestBlocker),
        ]),
        duplicateComments: false,
      });
      fixture.details.set(
        currentBlocked.nodeId,
        withAvailableEmptyBodyHistory(
          Object.freeze({
            ...currentBlockedDetail,
            timeline: Object.freeze([
              createNativeDependencyTimelineEvent(
                currentBlocked,
                closedIssueBlocker,
                "added",
                currentBlocked.createdAt,
                0,
              ),
              createNativeDependencyTimelineEvent(
                currentBlocked,
                mergedPullRequestBlocker,
                "added",
                currentBlocked.createdAt,
                1,
              ),
              createNativeDependencyTimelineEvent(
                currentBlocked,
                currentEdgeBlocker,
                "added",
                currentBlocked.createdAt,
                2,
              ),
              createNativeDependencyTimelineEvent(
                currentBlocked,
                currentEdgeBlocker,
                "removed",
                issueClosedAt,
                3,
              ),
            ]),
          }),
        ),
      );
      harness.artifacts.length = 0;

      const result = await harness.runDry(startedAt);
      const resolvedItem = requireDryRunSnapshot(harness.artifacts).items.find(
        (item) => item.nodeId === blocked.nodeId,
      );
      if (resolvedItem == null) {
        throw new TypeError("決定論的依存解消fixtureの追跡項目がありません");
      }
      expect(result.exitCode).toBe(0);
      return Object.freeze({
        lastProgressAt: resolvedItem.lastProgressAt,
        stallSince: resolvedItem.stallSince,
      });
    };

    const first = await runResolutionAt(THIRD_RUN_AT);
    const second = await runResolutionAt(FOURTH_RUN_AT);

    expect(first).toEqual({
      lastProgressAt: pullRequestMergedAt,
      stallSince: pullRequestMergedAt,
    });
    expect(second).toEqual(first);
  });

  it("実入力の費用見積で上限を適用する", async () => {
    const repository = createRepository("R_cost", "cost", FIRST_RUN_AT);
    const fixture = createRepositoryFixture(repository);
    const observedAt = createUtcIsoDateTime(FIRST_RUN_AT);
    const item = createIssueItem({
      repository: requirePublicRepository(repository),
      number: 1,
      fingerprint: "cost-limit",
      updatedAt: observedAt,
      observedAt,
      state: Object.freeze({ state: "open" }),
    });
    fixture.openItems = [item];
    fixture.details.set(
      item.nodeId,
      createIssueDetail({
        item,
        body: "費用見積を行う項目です",
        observedAt,
        nativeDependencies: Object.freeze([]),
        duplicateComments: false,
      }),
    );
    const baseConfig = await createTestConfig({
      explicitIncludes: [],
      retentionDays: 180,
      aiEnabled: true,
    });
    const config = configWithBudget(baseConfig, 10, 0);
    const harness = createCollectionHarness({
      repositories: [fixture],
      config,
      executeCodexAnalysis: () => Promise.reject(new TypeError("費用上限を超えて実行されました")),
    });

    const result = await harness.runDry(FIRST_RUN_AT);
    const snapshot = requireDryRunSnapshot(harness.artifacts);

    expect(result.exitCode).toBe(0);
    expect(harness.codexExecutionCount()).toBe(0);
    expect(snapshot.ai).toEqual({
      enabled: true,
      available: false,
      degraded: true,
    });
    expect(harness.artifacts.at(-1)).toMatchObject({
      diagnostics: [expect.stringContaining("estimated_cost_limit")],
      metrics: {
        aiCallCount: 0,
      },
    });
  });

  it("blocker変化をdownstream impactより優先し、同条件ではimpact順に予算配分する", async () => {
    const repository = createRepository("R_priority", "priority", FIRST_RUN_AT);
    const publicRepository = requirePublicRepository(repository);
    const fixture = createRepositoryFixture(repository);
    const firstObservedAt = createUtcIsoDateTime(FIRST_RUN_AT);
    const items = [1, 2, 3, 4, 5].map((number) =>
      createIssueItem({
        repository: publicRepository,
        number,
        fingerprint: `priority-${number.toString()}`,
        updatedAt: firstObservedAt,
        observedAt: firstObservedAt,
        state: Object.freeze({ state: "open" }),
      }),
    );
    const highImpact = items[0];
    const changedBlockerTarget = items[1];
    const downstream = items[2];
    const downstreamLeaf = items[3];
    const newBlocker = items[4];
    if (
      highImpact == null ||
      changedBlockerTarget == null ||
      downstream == null ||
      downstreamLeaf == null ||
      newBlocker == null
    ) {
      throw new TypeError("AI優先順位fixtureがありません");
    }
    fixture.openItems = [...items];
    setIssueDetails(fixture, items, firstObservedAt);
    for (const item of [highImpact, changedBlockerTarget]) {
      fixture.details.set(
        item.nodeId,
        createIssueDetail({
          item,
          body: "自然言語判定を必要とします",
          observedAt: firstObservedAt,
          nativeDependencies: Object.freeze([]),
          duplicateComments: false,
        }),
      );
    }
    fixture.details.set(
      downstream.nodeId,
      createIssueDetail({
        item: downstream,
        body: "downstream項目です",
        observedAt: firstObservedAt,
        nativeDependencies: Object.freeze([createNativeBlocker(downstream, highImpact)]),
        duplicateComments: false,
      }),
    );
    fixture.details.set(
      downstreamLeaf.nodeId,
      createIssueDetail({
        item: downstreamLeaf,
        body: "downstream末端です",
        observedAt: firstObservedAt,
        nativeDependencies: Object.freeze([createNativeBlocker(downstreamLeaf, downstream)]),
        duplicateComments: false,
      }),
    );
    const baseConfig = await createTestConfig({
      explicitIncludes: [],
      retentionDays: 180,
      aiEnabled: true,
    });
    const executedNodeIds: string[] = [];
    let externalState: "OPEN" | "CLOSED" = "OPEN";
    const harness = createCollectionHarness({
      repositories: [fixture],
      config: configWithBudget(baseConfig, 10, 10),
      externalRelationResponse: (request) =>
        createExternalRelationGraphqlResponse(request, {
          itemType: "issue",
          visibility: "PUBLIC",
          archived: false,
          disabled: false,
          nodeId: "I_external_blocker",
          state: externalState,
        }),
      executeCodexAnalysis: (input) => {
        executedNodeIds.push(input.item.nodeId);
        const source = input.sources[0];
        if (source == null) {
          throw new TypeError("AI優先順位fixtureのsourceがありません");
        }
        return Promise.resolve(
          createCodexOutput(input, {
            status: "in_progress",
            waitingOn: {
              candidateId: requireCodexAuthorCandidateId(input),
              kind: "user",
              role: "assignee",
              sourceId: source.id,
            },
            latestMeaningfulSourceId: null,
            confidence: 0.95,
            relationVerdict: "related",
            notification: {
              recommended: false,
              reasonCode: "none",
              reasonSummary: "通知しません",
            },
          }),
        );
      },
    });
    expect((await harness.runDaily(FIRST_RUN_AT)).exitCode).toBe(0);

    executedNodeIds.length = 0;
    const secondObservedAt = createUtcIsoDateTime(SECOND_RUN_AT);
    const secondItems = items.map((item) =>
      createIssueItem({
        repository: publicRepository,
        number: item.number,
        fingerprint:
          item.number <= 2
            ? `priority-${item.number.toString()}-second`
            : `priority-${item.number.toString()}`,
        updatedAt: item.number <= 2 ? secondObservedAt : firstObservedAt,
        observedAt: secondObservedAt,
        state: Object.freeze({ state: "open" }),
      }),
    );
    fixture.openItems = [...secondItems];
    setIssueDetails(fixture, secondItems, secondObservedAt);
    const secondByNumber = new Map(secondItems.map((item) => [item.number, item]));
    const secondHighImpact = secondByNumber.get(1);
    const secondChangedTarget = secondByNumber.get(2);
    const secondDownstream = secondByNumber.get(3);
    const secondLeaf = secondByNumber.get(4);
    if (
      secondHighImpact == null ||
      secondChangedTarget == null ||
      secondDownstream == null ||
      secondLeaf == null
    ) {
      throw new TypeError("2回目のAI優先順位fixtureがありません");
    }
    for (const item of [secondHighImpact, secondChangedTarget]) {
      fixture.details.set(
        item.nodeId,
        createIssueDetail({
          item,
          body: "自然言語判定を必要とします。入力を更新しました",
          observedAt: secondObservedAt,
          nativeDependencies: Object.freeze([]),
          duplicateComments: false,
        }),
      );
    }
    fixture.details.set(
      secondDownstream.nodeId,
      createIssueDetail({
        item: secondDownstream,
        body: "downstream項目です",
        observedAt: secondObservedAt,
        nativeDependencies: Object.freeze([
          createNativeBlocker(secondDownstream, secondHighImpact),
        ]),
        duplicateComments: false,
      }),
    );
    fixture.details.set(
      secondLeaf.nodeId,
      createIssueDetail({
        item: secondLeaf,
        body: "downstream末端です",
        observedAt: secondObservedAt,
        nativeDependencies: Object.freeze([createNativeBlocker(secondLeaf, secondDownstream)]),
        duplicateComments: false,
      }),
    );
    harness.setConfig(configWithBudget(baseConfig, 1, 10));
    expect((await harness.runDaily(SECOND_RUN_AT)).exitCode).toBe(0);
    expect(executedNodeIds).toEqual([highImpact.nodeId]);

    const thirdObservedAt = createUtcIsoDateTime(THIRD_RUN_AT);
    const thirdItems = items.map((item) =>
      createIssueItem({
        repository: publicRepository,
        number: item.number,
        fingerprint:
          item.number === 2 ? "priority-2-blocker-change" : `priority-${item.number.toString()}`,
        updatedAt: item.number === 2 ? thirdObservedAt : firstObservedAt,
        observedAt: thirdObservedAt,
        state: Object.freeze({ state: "open" }),
      }),
    );
    fixture.openItems = [...thirdItems];
    setIssueDetails(fixture, thirdItems, thirdObservedAt);
    const currentByNumber = new Map(thirdItems.map((item) => [item.number, item]));
    const currentHighImpact = currentByNumber.get(1);
    const currentChangedTarget = currentByNumber.get(2);
    const currentDownstream = currentByNumber.get(3);
    const currentLeaf = currentByNumber.get(4);
    const currentNewBlocker = currentByNumber.get(5);
    if (
      currentHighImpact == null ||
      currentChangedTarget == null ||
      currentDownstream == null ||
      currentLeaf == null ||
      currentNewBlocker == null
    ) {
      throw new TypeError("更新後のAI優先順位fixtureがありません");
    }
    for (const item of [currentHighImpact, currentChangedTarget]) {
      fixture.details.set(
        item.nodeId,
        createIssueDetail({
          item,
          body: "自然言語判定を必要とします",
          observedAt: thirdObservedAt,
          nativeDependencies:
            item.nodeId === currentChangedTarget.nodeId
              ? Object.freeze([
                  createExternalNativeBlocker(currentChangedTarget, {
                    state: "closed",
                    repositoryArchived: false,
                    repositoryDisabled: false,
                  }),
                ])
              : Object.freeze([]),
          duplicateComments: false,
        }),
      );
    }
    fixture.details.set(
      currentDownstream.nodeId,
      createIssueDetail({
        item: currentDownstream,
        body: "downstream項目です",
        observedAt: thirdObservedAt,
        nativeDependencies: Object.freeze([
          createNativeBlocker(currentDownstream, currentHighImpact),
        ]),
        duplicateComments: false,
      }),
    );
    fixture.details.set(
      currentLeaf.nodeId,
      createIssueDetail({
        item: currentLeaf,
        body: "downstream末端です",
        observedAt: thirdObservedAt,
        nativeDependencies: Object.freeze([createNativeBlocker(currentLeaf, currentDownstream)]),
        duplicateComments: false,
      }),
    );
    executedNodeIds.length = 0;
    externalState = "CLOSED";

    const fourthRun = await harness.runDaily(FOURTH_RUN_AT);
    if (fourthRun.exitCode !== 0) {
      throw new TypeError(`4回目のAI優先順位runに失敗しました。${JSON.stringify(fourthRun)}`);
    }
    expect(fourthRun.exitCode).toBe(0);
    expect(executedNodeIds).toEqual([changedBlockerTarget.nodeId]);
  });
});
