import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  buildSourceId,
  createGitHubNodeId,
  createGitHubRepositoryId,
  createUtcIsoDateTime,
  type GitHubItemUrl,
  type Repository,
  type Severity,
  type SourceId,
  type StalenessWaitClass,
  type Status,
  type WaitingOnKind,
  type WaitingOnRole,
} from "../src/domain/index.js";
import {
  createStateHistoryRecord,
  createStateSnapshot,
  type SnapshotAiState,
  type StateHistoryRecord,
  type StateSnapshot,
} from "../src/persistence/index.js";
import {
  PRODUCTION_SOURCE_ID_KINDS,
  createPublicRepositoryAllowlist,
  type ProductionSourceIdKind,
} from "../src/github/index.js";
import {
  DEFAULT_INITIAL_GRAPH_NODE_LIMIT,
  PUBLIC_DETAILS_FILE_NAME,
  PUBLIC_SUMMARY_FILE_NAME,
  PUBLIC_SUMMARY_GZIP_LIMIT_BYTES,
  PagesPublicSafetyError,
  PublicSummarySizeError,
  createEvidenceSourceUrlMap,
  generatePublicData,
  resolveEvidenceSourceUrl,
  writePublicDataFiles,
  type GeneratedPublicData,
  type PublicDtoGenerationOptions,
} from "../src/pages/index.js";
import { assertNonNullable } from "../src/util/index.js";

const TRACKING_START_AT = "2026-07-01T00:00:00.000Z";
const CREATED_AT = "2026-07-02T00:00:00.000Z";
const FRESH_OBSERVED_AT = "2026-07-31T23:55:00.000Z";
const GENERATED_AT = "2026-08-01T00:00:00.000Z";
const STALE_OBSERVED_AT = "2026-07-30T23:55:00.000Z";
const PUBLIC_REPOSITORY_ID = "R_PUBLIC";
const STALE_REPOSITORY_ID = "R_STALE";
const PRIVATE_REPOSITORY_ID = "R_PRIVATE_SENTINEL";
const defaultGenerationOptions = Object.freeze({
  confidenceThresholds: {
    high: 0.85,
    medium: 0.65,
  },
  labelRules: [
    {
      repository: "VOICEVOX/*",
      namePattern: "^優先度[：:]高$",
      effects: {
        priorityWeight: 25,
      },
    },
  ],
  maxInitialGraphNodes: DEFAULT_INITIAL_GRAPH_NODE_LIMIT,
  maxSummaryGzipBytes: PUBLIC_SUMMARY_GZIP_LIMIT_BYTES,
  timezone: "Asia/Tokyo",
}) satisfies PublicDtoGenerationOptions;

type RepositoryFixture =
  | Readonly<{
      id: string;
      name: string;
      observedAt: string;
      freshness: "fresh";
    }>
  | Readonly<{
      id: string;
      name: string;
      observedAt: string;
      freshness: "stale";
      failedAt: string;
    }>;

type InventoryRepositoryFixture = Readonly<{
  id: string;
  name: string;
  visibility: "public" | "private" | "internal";
}>;

type GraphEvidenceSourceFixture = Readonly<{
  nodeId: string;
  url: GitHubItemUrl;
}>;

type ItemFixtureOptions = Readonly<{
  nodeId: string;
  repositoryId: string;
  repositoryName: string;
  number: number;
  status: Status;
  severity: Severity;
  waitingOnKind: WaitingOnKind;
  waitingOnRole: WaitingOnRole;
  observedAt: string;
  title: string;
}>;

type SnapshotFixtureOptions = Readonly<{
  runId: string;
  runStatus: "success" | "fallback";
  ai: SnapshotAiState;
  generatedAt: string;
  repositories: readonly RepositoryFixture[];
  items: readonly unknown[];
  relations: readonly unknown[];
}>;

function severityWaitClass(status: Status): StalenessWaitClass {
  switch (status) {
    case "waiting_for_assessment":
      return "assessment";
    case "waiting_for_owner":
      return "owner";
    case "waiting_for_decision":
      return "decision";
    case "waiting_for_review":
      return "review";
    case "waiting_for_revision":
      return "revision";
    case "waiting_for_reply":
      return "reply";
    case "waiting_for_work":
    case "in_progress":
      return "work";
    case "waiting_for_unblock":
      return "blockedParent";
    case "waiting_for_automation":
      return "automation";
    case "waiting_for_merge":
      return "merge";
    case "unknown":
      return "owner";
    case "terminal_merged":
    case "terminal_completed":
    case "terminal_not_planned":
      return "notApplicable";
  }
}

function createInventory(
  repositories: readonly InventoryRepositoryFixture[],
): readonly Repository[] {
  return Object.freeze(
    repositories.map((repository) => ({
      id: createGitHubRepositoryId(repository.id),
      owner: "VOICEVOX",
      name: repository.name,
      visibility: repository.visibility,
      archived: false,
      disabled: false,
      observedAt: createUtcIsoDateTime(FRESH_OBSERVED_AT),
    })),
  );
}

function createItem(options: ItemFixtureOptions): unknown {
  const terminal =
    options.status === "terminal_merged" ||
    options.status === "terminal_completed" ||
    options.status === "terminal_not_planned";
  const itemUrl = `https://github.com/VOICEVOX/${options.repositoryName}/issues/${options.number.toString()}`;
  const evidenceSourceId = `github_item_detail:${options.nodeId}`;
  return {
    nodeId: options.nodeId,
    type: options.number % 2 === 0 ? "pull_request" : "issue",
    repositoryId: options.repositoryId,
    displayReference: `VOICEVOX/${options.repositoryName}#${options.number.toString()}`,
    number: options.number,
    url: itemUrl,
    title: options.title,
    milestone: null,
    importance: {
      score: 25,
      level: "medium",
      factors: [
        {
          kind: "priorityLabel",
          points: 25,
          detail: "優先度ラベルの重みで25点を加算します",
        },
      ],
    },
    importanceAssessment: {
      status: "not_available",
    },
    author: {
      status: "identified",
      actor: {
        type: "human",
        nodeId: `U_author_${options.nodeId}`,
        login: `author-${options.nodeId}`,
      },
    },
    latestEventActor: {
      status: "present",
      actor: {
        type: "human",
        nodeId: `U_event_actor_${options.nodeId}`,
        login: `event-actor-${options.nodeId}`,
      },
    },
    state: terminal ? "closed" : "open",
    notificationClass: "standard",
    status: options.status,
    waitingOn: terminal
      ? []
      : [
          {
            kind: options.waitingOnKind,
            candidateId: `candidate:${options.nodeId}`,
            role: options.waitingOnRole,
            reasonSummary: "次の担当による対応待ちです",
            sourceIds: [evidenceSourceId],
            confidence: 0.9,
          },
        ],
    primaryWaitingOn: terminal
      ? {
          index: "not_applicable",
          selectionReason: "terminal項目にwaitingOnはありません",
        }
      : {
          index: 0,
          selectionReason: "fixtureの先頭候補をprimaryとして選びました",
        },
    nextAction: terminal ? "対応は完了しています" : "次の担当が確認する",
    createdAt: CREATED_AT,
    githubUpdatedAt: options.observedAt,
    lastHumanActivityAt: options.observedAt,
    lastProgressAt: options.observedAt,
    statusSince: options.observedAt,
    ownerSince: options.observedAt,
    stallSince: options.observedAt,
    observedAt: options.observedAt,
    labels: ["優先度：高"],
    assignees: [
      {
        type: "human",
        nodeId: `U_assignee_${options.nodeId}`,
        login: `assignee-${options.nodeId}`,
      },
    ],
    reviewState: options.number % 2 === 0 ? "requested" : "not_applicable",
    checkState: options.number % 2 === 0 ? "pending" : "not_applicable",
    aiAnalysis: {
      status: "not_required",
    },
    inputEvents: [
      {
        sourceId: `github_timeline_event:${options.nodeId}`,
        url: itemUrl,
      },
    ],
    confidence: 0.9,
    evidence: [
      {
        sourceId: evidenceSourceId,
        supports: "status",
        summary: "公開用の短い判定根拠です",
      },
    ],
    uncertainties: [],
    severity: options.severity,
    severityContext: {
      waitClass: severityWaitClass(options.status),
      decisionBasis: "deterministic",
    },
  };
}

function createRelation(
  id: string,
  fromNodeId: string,
  toNodeId: string,
  type: "blocks" | "related_to",
): unknown {
  return {
    id,
    fromNodeId,
    toNodeId,
    type,
    provenance: "native",
    confidence: 1,
    evidence: [
      {
        sourceId: `github_native_dependency:${id}`,
        supports: "relation",
        summary: "公開用の短い関係根拠です",
      },
    ],
    contradictions: [],
    active: true,
    firstSeenAt: FRESH_OBSERVED_AT,
    lastConfirmedAt: FRESH_OBSERVED_AT,
  };
}

function createSnapshot(options: SnapshotFixtureOptions): StateSnapshot {
  return createStateSnapshot({
    schemaVersion: "7",
    generatedAt: options.generatedAt,
    trackingStartAt: {
      status: "fixed",
      value: TRACKING_START_AT,
      source: "first_complete_run",
    },
    ai: options.ai,
    collection: {
      repositories: [],
    },
    repositories: options.repositories.map((repository) => ({
      id: repository.id,
      owner: "VOICEVOX",
      name: repository.name,
      visibility: "public",
      archived: false,
      disabled: false,
      observedAt: repository.observedAt,
      freshness: repository.freshness,
      ...(repository.freshness === "stale"
        ? {
            failedAt: repository.failedAt,
          }
        : {}),
    })),
    items: options.items,
    externalReferences: [],
    relations: options.relations,
    run: {
      id: options.runId,
      status: options.runStatus,
      complete: true,
    },
  });
}

function createSingleItemSnapshot(title: string): StateSnapshot {
  return createSnapshot({
    runId: "run-single",
    runStatus: "success",
    ai: {
      enabled: true,
      available: true,
      degraded: false,
    },
    generatedAt: GENERATED_AT,
    repositories: [
      {
        id: PUBLIC_REPOSITORY_ID,
        name: "public",
        observedAt: FRESH_OBSERVED_AT,
        freshness: "fresh",
      },
    ],
    items: [
      createItem({
        nodeId: "I_SINGLE",
        repositoryId: PUBLIC_REPOSITORY_ID,
        repositoryName: "public",
        number: 1,
        status: "waiting_for_assessment",
        severity: "watch",
        waitingOnKind: "role",
        waitingOnRole: "maintainer",
        observedAt: FRESH_OBSERVED_AT,
        title,
      }),
    ],
    relations: [],
  });
}

function createGraphEvidenceSnapshot(
  sourceId: SourceId,
  inputSources: readonly GraphEvidenceSourceFixture[],
): StateSnapshot {
  const source = createSnapshot({
    runId: "run-graph-evidence",
    runStatus: "success",
    ai: {
      enabled: false,
      available: false,
      degraded: false,
    },
    generatedAt: GENERATED_AT,
    repositories: [
      {
        id: PUBLIC_REPOSITORY_ID,
        name: "public",
        observedAt: FRESH_OBSERVED_AT,
        freshness: "fresh",
      },
    ],
    items: [
      createItem({
        nodeId: "I_EDGE_FROM",
        repositoryId: PUBLIC_REPOSITORY_ID,
        repositoryName: "public",
        number: 1,
        status: "waiting_for_assessment",
        severity: "watch",
        waitingOnKind: "role",
        waitingOnRole: "maintainer",
        observedAt: FRESH_OBSERVED_AT,
        title: "根拠を持つ可能性があるfrom項目",
      }),
      createItem({
        nodeId: "I_EDGE_TO",
        repositoryId: PUBLIC_REPOSITORY_ID,
        repositoryName: "public",
        number: 2,
        status: "waiting_for_assessment",
        severity: "watch",
        waitingOnKind: "role",
        waitingOnRole: "maintainer",
        observedAt: FRESH_OBSERVED_AT,
        title: "根拠を持つ可能性があるto項目",
      }),
    ],
    relations: [createRelation("rel:edge-evidence", "I_EDGE_FROM", "I_EDGE_TO", "blocks")],
  });
  const relation = source.relations[0];
  assertNonNullable(relation, "graph edge evidenceのrelation fixtureがありません");
  return createStateSnapshot({
    ...source,
    items: source.items.map((item) => {
      const inputSource = inputSources.find((candidate) => candidate.nodeId === item.nodeId);
      if (inputSource == null) {
        return item;
      }
      return {
        ...item,
        inputEvents: [
          ...item.inputEvents,
          {
            sourceId,
            url: inputSource.url,
          },
        ],
      };
    }),
    relations: [
      {
        ...relation,
        evidence: [
          {
            sourceId,
            supports: "relation",
            summary: "graph edgeの公開用根拠です",
          },
        ],
      },
    ],
  });
}

function generateFixture(
  snapshot: StateSnapshot,
  historyRecords: readonly StateHistoryRecord[],
  repositoryInventory: readonly Repository[],
  knownSecrets: readonly string[],
  options: PublicDtoGenerationOptions,
): GeneratedPublicData {
  return generatePublicData({
    snapshot,
    historyRecords,
    repositoryAllowlist: createPublicRepositoryAllowlist(repositoryInventory).repositories,
    repositoryInventory,
    knownSecrets,
    options,
  });
}

describe("公開evidence URL", () => {
  const individualSourceCases = [
    {
      kind: "github_issue_comment",
      sourceUrl: "https://github.com/VOICEVOX/public/issues/1#issuecomment-101",
    },
    {
      kind: "github_pull_request_review",
      sourceUrl: "https://github.com/VOICEVOX/public/issues/1#pullrequestreview-202",
    },
    {
      kind: "github_pull_request_review_comment",
      sourceUrl: "https://github.com/VOICEVOX/public/issues/1#discussion_r303",
    },
  ] satisfies readonly Readonly<{
    kind: ProductionSourceIdKind;
    sourceUrl: GitHubItemUrl;
  }>[];

  it.each(individualSourceCases)("$kindは個別anchorへ解決する", ({ kind, sourceUrl }) => {
    const itemUrl = "https://github.com/VOICEVOX/public/issues/1";
    const itemNodeId = createGitHubNodeId("I_EVIDENCE_ANCHOR");
    const sourceId = buildSourceId(kind, "source");

    expect(
      resolveEvidenceSourceUrl(
        sourceId,
        [{ nodeId: itemNodeId, url: itemUrl }],
        createEvidenceSourceUrlMap([
          {
            itemNodeId,
            itemUrl,
            sourceId,
            url: sourceUrl,
          },
        ]),
      ),
    ).toBe(sourceUrl);
  });

  it("github_native_closing_issueはanchorのないPull Request URLを項目URLへ解決する", () => {
    const itemUrl: GitHubItemUrl = "https://github.com/VOICEVOX/public/pull/1";
    const itemNodeId = createGitHubNodeId("PR_EVIDENCE_CLOSING_ISSUE");
    const sourceId = buildSourceId("github_native_closing_issue", "PR_source:I_target");

    expect(
      resolveEvidenceSourceUrl(
        sourceId,
        [{ nodeId: itemNodeId, url: itemUrl }],
        createEvidenceSourceUrlMap([
          {
            itemNodeId,
            itemUrl,
            sourceId,
            url: itemUrl,
          },
        ]),
      ),
    ).toBe(itemUrl);
  });

  it.each(PRODUCTION_SOURCE_ID_KINDS)("%sに公開evidence URLの解決方式がある", (kind) => {
    const itemUrl: GitHubItemUrl = "https://github.com/VOICEVOX/public/issues/1";
    const itemNodeId = createGitHubNodeId("I_EVIDENCE_PRODUCTION_KIND");
    const sourceId = buildSourceId(kind, "source");
    const individualSource = individualSourceCases.find((candidate) => candidate.kind === kind);
    const sourceOwnersById =
      individualSource == null
        ? createEvidenceSourceUrlMap([])
        : createEvidenceSourceUrlMap([
            {
              itemNodeId,
              itemUrl,
              sourceId,
              url: individualSource.sourceUrl,
            },
          ]);

    expect(
      resolveEvidenceSourceUrl(sourceId, [{ nodeId: itemNodeId, url: itemUrl }], sourceOwnersById),
    ).toBe(individualSource?.sourceUrl ?? itemUrl);
  });

  it("項目単位のsourceは項目URLへ解決し未知の種別を拒否する", () => {
    const itemUrl: GitHubItemUrl = "https://github.com/VOICEVOX/public/issues/1";
    const itemNodeId = createGitHubNodeId("I_EVIDENCE_ITEM");
    const sourceItems = [{ nodeId: itemNodeId, url: itemUrl }];

    expect(
      resolveEvidenceSourceUrl(
        buildSourceId("github_item_body", "item"),
        sourceItems,
        createEvidenceSourceUrlMap([]),
      ),
    ).toBe(itemUrl);
    expect(() =>
      resolveEvidenceSourceUrl(
        buildSourceId("unexpected_source", "event"),
        sourceItems,
        createEvidenceSourceUrlMap([]),
      ),
    ).toThrow("公開evidence URLへ解決できないsource ID種別です");
  });

  it("項目とsource ID別URL Mapは同じ組のURL衝突と入力イベント重複を拒否する", () => {
    const itemNodeId = createGitHubNodeId("I_EVIDENCE_DUPLICATE");
    const sourceId = buildSourceId("github_issue_comment", "comment");
    const itemUrl = "https://github.com/VOICEVOX/public/issues/1";
    const firstUrl = "https://github.com/VOICEVOX/public/issues/1#issuecomment-101";
    const secondUrl = "https://github.com/VOICEVOX/public/issues/1#issuecomment-102";

    expect(() =>
      createEvidenceSourceUrlMap([
        { itemNodeId, itemUrl, sourceId, url: firstUrl },
        { itemNodeId, itemUrl, sourceId, url: secondUrl },
      ]),
    ).toThrow("同じ項目とsource IDの組に異なるURLがあります");
    expect(() =>
      createEvidenceSourceUrlMap([
        { itemNodeId, itemUrl, sourceId, url: firstUrl },
        { itemNodeId, itemUrl, sourceId, url: firstUrl },
      ]),
    ).toThrow("同じ項目とsource IDの入力イベントが複数あります");
    expect(() =>
      resolveEvidenceSourceUrl(
        sourceId,
        [{ nodeId: itemNodeId, url: itemUrl }],
        createEvidenceSourceUrlMap([]),
      ),
    ).toThrow("個別sourceを所有する項目がありません");
  });

  it("graph edgeの監査用フィールドを公開せず根拠URLを解決しない", () => {
    const sourceId = buildSourceId("github_issue_comment", "shared-comment");
    const snapshot = createGraphEvidenceSnapshot(sourceId, [
      {
        nodeId: "I_EDGE_FROM",
        url: "https://github.com/VOICEVOX/public/issues/1#issuecomment-303",
      },
      {
        nodeId: "I_EDGE_TO",
        url: "https://github.com/VOICEVOX/public/issues/2#issuecomment-404",
      },
    ]);

    const generated = generateFixture(
      snapshot,
      [],
      publicInventory(),
      [],
      defaultGenerationOptions,
    );

    expect(generated.details.graph.edges[0]).toEqual({
      id: "rel:edge-evidence",
      fromNodeId: "I_EDGE_FROM",
      toNodeId: "I_EDGE_TO",
      type: "blocks",
      provenance: "native",
      confidence: 1,
      active: true,
    });
  });

  it("項目のevidenceは別項目が所有するcommentのURLへ解決する", () => {
    const sourceId = buildSourceId("github_issue_comment", "comment");
    const sourceUrl = "https://github.com/VOICEVOX/public/issues/2#issuecomment-101";
    const source = createGraphEvidenceSnapshot(sourceId, [
      {
        nodeId: "I_EDGE_TO",
        url: sourceUrl,
      },
    ]);
    const snapshot = createStateSnapshot({
      ...source,
      items: source.items.map((item) => {
        if (item.nodeId !== "I_EDGE_FROM") {
          return item;
        }
        return {
          ...item,
          evidence: [
            {
              sourceId,
              supports: "status",
              summary: "個別commentが判定根拠です",
            },
          ],
        };
      }),
    });

    const generated = generateFixture(
      snapshot,
      [],
      publicInventory(),
      [],
      defaultGenerationOptions,
    );

    const targetItem = generated.details.items.find(
      (item) => item.summary.nodeId === "I_EDGE_FROM",
    );
    expect(targetItem?.evidence[0]?.sourceUrl).toBe(sourceUrl);
  });

  it("別項目で共有するsource IDを含む公開データを生成する", () => {
    const sourceId = buildSourceId("github_commit", "C_PUBLIC_SHARED");
    const source = createSnapshot({
      runId: "run-shared-public-source",
      runStatus: "success",
      ai: {
        enabled: false,
        available: false,
        degraded: false,
      },
      generatedAt: GENERATED_AT,
      repositories: [
        {
          id: PUBLIC_REPOSITORY_ID,
          name: "public",
          observedAt: FRESH_OBSERVED_AT,
          freshness: "fresh",
        },
      ],
      items: [
        createItem({
          nodeId: "I_PUBLIC_SHARED_FIRST",
          repositoryId: PUBLIC_REPOSITORY_ID,
          repositoryName: "public",
          number: 2,
          status: "waiting_for_assessment",
          severity: "watch",
          waitingOnKind: "role",
          waitingOnRole: "maintainer",
          observedAt: FRESH_OBSERVED_AT,
          title: "共有commitを持つ項目A",
        }),
        createItem({
          nodeId: "I_PUBLIC_SHARED_SECOND",
          repositoryId: PUBLIC_REPOSITORY_ID,
          repositoryName: "public",
          number: 4,
          status: "waiting_for_assessment",
          severity: "watch",
          waitingOnKind: "role",
          waitingOnRole: "maintainer",
          observedAt: FRESH_OBSERVED_AT,
          title: "共有commitを持つ項目B",
        }),
      ],
      relations: [],
    });
    const snapshot = createStateSnapshot({
      ...source,
      items: source.items.map((item) => ({
        ...item,
        inputEvents: [
          {
            sourceId,
            url: item.url,
          },
        ],
        evidence: [
          {
            sourceId,
            supports: "status",
            summary: "共有commitが判定根拠です",
          },
        ],
      })),
    });

    const generated = generateFixture(
      snapshot,
      [],
      publicInventory(),
      [],
      defaultGenerationOptions,
    );

    expect(
      generated.details.items.map((item) => ({
        nodeId: item.summary.nodeId,
        sourceUrl: item.evidence[0]?.sourceUrl,
      })),
    ).toEqual(
      snapshot.items.map((item) => ({
        nodeId: item.nodeId,
        sourceUrl: item.url,
      })),
    );
  });
});

function publicInventory(): readonly Repository[] {
  return createInventory([
    {
      id: PUBLIC_REPOSITORY_ID,
      name: "public",
      visibility: "public",
    },
  ]);
}

describe("Pages公開安全性", () => {
  it("収集時の公開allowlistにない未知repositoryを拒否する", () => {
    const snapshot = createSnapshot({
      runId: "run-unknown-repository",
      runStatus: "success",
      ai: {
        enabled: true,
        available: true,
        degraded: false,
      },
      generatedAt: GENERATED_AT,
      repositories: [
        {
          id: PUBLIC_REPOSITORY_ID,
          name: "public",
          observedAt: FRESH_OBSERVED_AT,
          freshness: "fresh",
        },
        {
          id: "R_UNKNOWN",
          name: "unknown",
          observedAt: FRESH_OBSERVED_AT,
          freshness: "fresh",
        },
      ],
      items: [],
      relations: [],
    });
    const snapshotDerivedInventory = createInventory([
      {
        id: PUBLIC_REPOSITORY_ID,
        name: "public",
        visibility: "public",
      },
      {
        id: "R_UNKNOWN",
        name: "unknown",
        visibility: "public",
      },
    ]);

    expect(() =>
      generatePublicData({
        snapshot,
        historyRecords: [],
        repositoryAllowlist: createPublicRepositoryAllowlist(publicInventory()).repositories,
        repositoryInventory: snapshotDerivedInventory,
        knownSecrets: [],
        options: defaultGenerationOptions,
      }),
    ).toThrow(PagesPublicSafetyError);
  });

  it("private sentinelを含むsnapshotではDTO生成を中止する", () => {
    const snapshot = createSnapshot({
      runId: "run-private",
      runStatus: "success",
      ai: {
        enabled: true,
        available: true,
        degraded: false,
      },
      generatedAt: GENERATED_AT,
      repositories: [
        {
          id: PUBLIC_REPOSITORY_ID,
          name: "public",
          observedAt: FRESH_OBSERVED_AT,
          freshness: "fresh",
        },
        {
          id: PRIVATE_REPOSITORY_ID,
          name: "private-sentinel",
          observedAt: FRESH_OBSERVED_AT,
          freshness: "fresh",
        },
      ],
      items: [
        createItem({
          nodeId: "I_PUBLIC",
          repositoryId: PUBLIC_REPOSITORY_ID,
          repositoryName: "public",
          number: 1,
          status: "waiting_for_assessment",
          severity: "watch",
          waitingOnKind: "role",
          waitingOnRole: "maintainer",
          observedAt: FRESH_OBSERVED_AT,
          title: "公開項目",
        }),
      ],
      relations: [],
    });
    const inventory = createInventory([
      {
        id: PUBLIC_REPOSITORY_ID,
        name: "public",
        visibility: "public",
      },
      {
        id: PRIVATE_REPOSITORY_ID,
        name: "private-sentinel",
        visibility: "private",
      },
    ]);

    expect(() => generateFixture(snapshot, [], inventory, [], defaultGenerationOptions)).toThrow(
      PagesPublicSafetyError,
    );
  });

  it("milestoneタイトルにprivate sentinelを含むsnapshotではDTO生成を中止する", () => {
    const source = createSingleItemSnapshot("公開項目");
    const snapshot = createStateSnapshot({
      ...source,
      items: source.items.map((item) => ({
        ...item,
        milestone: {
          nodeId: "M_PRIVATE_SENTINEL",
          number: 1,
          title: "VOICEVOX/private-sentinel",
          state: "open",
          dueOn: null,
        },
      })),
    });
    const inventory = createInventory([
      {
        id: PUBLIC_REPOSITORY_ID,
        name: "public",
        visibility: "public",
      },
      {
        id: PRIVATE_REPOSITORY_ID,
        name: "private-sentinel",
        visibility: "private",
      },
    ]);

    expect(() => generateFixture(snapshot, [], inventory, [], defaultGenerationOptions)).toThrow(
      PagesPublicSafetyError,
    );
  });

  it("本文全文フィールドを拒否し、有効なDTOへ本文フィールドを作らない", () => {
    const fullBody = "転載してはいけないIssue本文全文";
    const snapshot = createSingleItemSnapshot("短い公開タイトル");
    const snapshotWithBody = {
      ...snapshot,
      body: fullBody,
    };

    expect(() =>
      generateFixture(snapshotWithBody, [], publicInventory(), [], defaultGenerationOptions),
    ).toThrow(PagesPublicSafetyError);

    const generated = generateFixture(
      snapshot,
      [],
      publicInventory(),
      [],
      defaultGenerationOptions,
    );
    const serialized = JSON.stringify(generated);
    expect(serialized).not.toContain(fullBody);
    expect(serialized).not.toContain('"body"');
    expect(generated.details.items[0]?.evidence[0]).toMatchObject({
      sourceUrl: "https://github.com/VOICEVOX/public/issues/1",
      summary: "公開用の短い判定根拠です",
    });
  });

  it("secret patternを含む公開候補を値を露出せず拒否する", () => {
    const secret = "github_pat_abcdefghijklmnopqrstuvwxyz0123456789";
    const snapshot = createSingleItemSnapshot(`漏えい候補 ${secret}`);

    let caught: unknown;
    try {
      generateFixture(snapshot, [], publicInventory(), [secret], defaultGenerationOptions);
    } catch (error: unknown) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(PagesPublicSafetyError);
    if (!(caught instanceof Error)) {
      throw new Error("公開安全性エラーを取得できません");
    }
    expect(caught.message).not.toContain(secret);
  });
});

describe("公開DTO生成", () => {
  it("milestoneを期限込みでsummaryとdetails内のsummaryへ公開する", () => {
    const source = createSingleItemSnapshot("milestone公開fixture");
    const snapshot = createStateSnapshot({
      ...source,
      items: source.items.map((item) => ({
        ...item,
        milestone: {
          nodeId: "M_PUBLIC",
          number: 2,
          title: "公開リリース",
          state: "closed",
          dueOn: "2026-09-01T00:00:00.000Z",
        },
      })),
    });

    const generated = generateFixture(
      snapshot,
      [],
      publicInventory(),
      [],
      defaultGenerationOptions,
    );
    const expectedMilestone = {
      nodeId: "M_PUBLIC",
      number: 2,
      title: "公開リリース",
      state: "closed",
      dueOn: "2026-09-01T00:00:00.000Z",
    };

    expect(generated.summary.schemaVersion).toBe("5");
    expect(generated.summary.items[0]?.milestone).toEqual(expectedMilestone);
    expect(generated.details.schemaVersion).toBe("5");
    expect(generated.details.items[0]?.summary.milestone).toEqual(expectedMilestone);
  });

  it("項目単位のAI利用状況をcache keyなしでsummaryとdetailsへ公開する", () => {
    const source = createSingleItemSnapshot("AI利用状況公開fixture");
    const snapshot = createStateSnapshot({
      ...source,
      items: source.items.map((item) => ({
        ...item,
        aiAnalysis: {
          status: "used",
          cacheKey: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
        },
      })),
    });

    const generated = generateFixture(
      snapshot,
      [],
      publicInventory(),
      [],
      defaultGenerationOptions,
    );

    expect(generated.summary.items[0]?.aiAnalysis).toEqual({
      status: "used",
    });
    expect(generated.details.items[0]?.summary.aiAnalysis).toEqual({
      status: "used",
    });
    expect(generated.summary.items[0]?.aiAnalysis).not.toHaveProperty("cacheKey");
  });

  it("run成功時もsnapshotのAI無効状態をそのまま公開する", () => {
    const source = createSingleItemSnapshot("AI無効状態の項目");
    const snapshot = createStateSnapshot({
      ...source,
      ai: {
        enabled: false,
        available: false,
        degraded: false,
      },
    });

    const generated = generateFixture(
      snapshot,
      [],
      publicInventory(),
      [],
      defaultGenerationOptions,
    );

    expect(snapshot.run.status).toBe("success");
    expect(generated.summary.ai).toEqual({
      enabled: false,
      available: false,
      degraded: false,
    });
  });

  it("外部参照が非active relationからしか参照されなくても公開データを生成する", () => {
    const itemNodeId = "I_INACTIVE_EXTERNAL_REFERENCE";
    const externalNodeId = "I_EXTERNAL_INACTIVE_ONLY";
    const source = createSnapshot({
      runId: "run-inactive-external-reference",
      runStatus: "success",
      ai: {
        enabled: false,
        available: false,
        degraded: false,
      },
      generatedAt: GENERATED_AT,
      repositories: [
        {
          id: PUBLIC_REPOSITORY_ID,
          name: "public",
          observedAt: FRESH_OBSERVED_AT,
          freshness: "fresh",
        },
      ],
      items: [
        createItem({
          nodeId: itemNodeId,
          repositoryId: PUBLIC_REPOSITORY_ID,
          repositoryName: "public",
          number: 1,
          status: "waiting_for_assessment",
          severity: "watch",
          waitingOnKind: "role",
          waitingOnRole: "maintainer",
          observedAt: FRESH_OBSERVED_AT,
          title: "削除済み外部関係を持つ項目",
        }),
      ],
      relations: [],
    });
    const snapshot = createStateSnapshot({
      ...source,
      externalReferences: [
        {
          kind: "external_reference",
          nodeId: externalNodeId,
          repositoryFullName: "external/example",
          number: 2,
          url: "https://github.com/external/example/issues/2",
          title: "削除済み関係の外部参照",
          state: "open",
          recursiveTracking: "not_allowed",
          directNotification: "not_eligible",
        },
      ],
      relations: [
        {
          id: "rel:inactive-external-reference",
          fromNodeId: externalNodeId,
          toNodeId: itemNodeId,
          type: "blocks",
          provenance: "native",
          confidence: 1,
          evidence: [
            {
              sourceId: "github_native_dependency:inactive-external-reference",
              supports: "relation",
              summary: "削除済み外部関係の根拠です",
            },
          ],
          contradictions: [],
          active: false,
          firstSeenAt: FRESH_OBSERVED_AT,
          lastConfirmedAt: FRESH_OBSERVED_AT,
          removedAt: GENERATED_AT,
        },
      ],
    });

    const generated = generateFixture(
      snapshot,
      [],
      publicInventory(),
      [],
      defaultGenerationOptions,
    );

    expect(generated.summary.graph.nodes).toContainEqual({
      nodeId: externalNodeId,
      kind: "external_reference",
      displayReference: "external/example#2",
    });
    expect(generated.details.graph.nodes).toContainEqual(
      expect.objectContaining({
        nodeId: externalNodeId,
        kind: "external_reference",
      }),
    );
    expect(generated.details.graph.edges).toMatchObject([
      {
        id: "rel:inactive-external-reference",
        active: false,
        fromNodeId: externalNodeId,
        toNodeId: itemNodeId,
      },
    ]);
    expect(generated.details.graph.edges[0]).not.toHaveProperty("removedAt");
  });

  it("fixtureのgraph、根拠、履歴を公開DTOへ反映する", () => {
    const repository = {
      id: PUBLIC_REPOSITORY_ID,
      name: "public",
      observedAt: FRESH_OBSERVED_AT,
      freshness: "fresh",
    } satisfies RepositoryFixture;
    const previous = createSnapshot({
      runId: "run-previous",
      runStatus: "success",
      ai: {
        enabled: true,
        available: true,
        degraded: false,
      },
      generatedAt: "2026-07-31T00:00:00.000Z",
      repositories: [
        {
          ...repository,
          observedAt: "2026-07-30T23:55:00.000Z",
        },
      ],
      items: [
        createItem({
          nodeId: "I_A",
          repositoryId: PUBLIC_REPOSITORY_ID,
          repositoryName: "public",
          number: 1,
          status: "waiting_for_assessment",
          severity: "watch",
          waitingOnKind: "role",
          waitingOnRole: "maintainer",
          observedAt: "2026-07-30T23:55:00.000Z",
          title: "項目A",
        }),
        createItem({
          nodeId: "I_B",
          repositoryId: PUBLIC_REPOSITORY_ID,
          repositoryName: "public",
          number: 2,
          status: "waiting_for_assessment",
          severity: "none",
          waitingOnKind: "role",
          waitingOnRole: "maintainer",
          observedAt: "2026-07-30T23:55:00.000Z",
          title: "項目B",
        }),
        createItem({
          nodeId: "I_C",
          repositoryId: PUBLIC_REPOSITORY_ID,
          repositoryName: "public",
          number: 3,
          status: "unknown",
          severity: "none",
          waitingOnKind: "unknown",
          waitingOnRole: "unknown",
          observedAt: "2026-07-30T23:55:00.000Z",
          title: "項目C",
        }),
      ],
      relations: [],
    });
    const current = createSnapshot({
      runId: "run-current",
      runStatus: "success",
      ai: {
        enabled: true,
        available: true,
        degraded: false,
      },
      generatedAt: GENERATED_AT,
      repositories: [repository],
      items: [
        createItem({
          nodeId: "I_A",
          repositoryId: PUBLIC_REPOSITORY_ID,
          repositoryName: "public",
          number: 1,
          status: "waiting_for_unblock",
          severity: "urgent",
          waitingOnKind: "item",
          waitingOnRole: "dependency",
          observedAt: FRESH_OBSERVED_AT,
          title: "項目A",
        }),
        createItem({
          nodeId: "I_B",
          repositoryId: PUBLIC_REPOSITORY_ID,
          repositoryName: "public",
          number: 2,
          status: "waiting_for_unblock",
          severity: "watch",
          waitingOnKind: "item",
          waitingOnRole: "dependency",
          observedAt: FRESH_OBSERVED_AT,
          title: "項目B",
        }),
        createItem({
          nodeId: "I_C",
          repositoryId: PUBLIC_REPOSITORY_ID,
          repositoryName: "public",
          number: 3,
          status: "unknown",
          severity: "none",
          waitingOnKind: "unknown",
          waitingOnRole: "unknown",
          observedAt: FRESH_OBSERVED_AT,
          title: "項目C",
        }),
      ],
      relations: [
        createRelation("rel:A-B", "I_A", "I_B", "blocks"),
        createRelation("rel:B-A", "I_B", "I_A", "blocks"),
      ],
    });
    const historyRecords = [
      createStateHistoryRecord(undefined, previous, "2026-07-31", previous.repositories, []),
      createStateHistoryRecord(previous, current, "2026-08-01", current.repositories, []),
    ];

    const generated = generateFixture(
      current,
      historyRecords,
      publicInventory(),
      [],
      defaultGenerationOptions,
    );

    expect(generated.summary.confidenceThresholds).toEqual(
      defaultGenerationOptions.confidenceThresholds,
    );
    expect(generated.summary.timezone).toBe(defaultGenerationOptions.timezone);
    expect(generated.summary).not.toHaveProperty("aggregates");
    expect(generated.summary).not.toHaveProperty("trackingStartAt");
    expect(generated.summary.repositories[0]).not.toHaveProperty("owner");
    expect(generated.summary.repositories[0]).not.toHaveProperty("observedAt");
    expect(generated.summary.graph.maxNodes).toBe(DEFAULT_INITIAL_GRAPH_NODE_LIMIT);
    expect(generated.summary.graph.nodes[0]).not.toHaveProperty("repositoryId");
    expect(generated.summary.graph.nodes[0]).not.toHaveProperty("state");
    expect(generated.summary.graph.nodes[0]).not.toHaveProperty("status");
    expect(generated.summary.graph.nodes[0]).not.toHaveProperty("severity");
    expect(generated.details.graph.frontierNodeIds).toEqual(["I_C"]);
    const itemA = generated.details.items.find((item) => item.summary.nodeId === "I_A");
    expect(itemA?.summary.blockerNodeIds).toEqual(["I_B"]);
    expect(itemA?.summary.waitingOn[0]).not.toHaveProperty("sourceIds");
    expect(itemA?.summary.priorityWeight).toBe(25);
    expect(itemA?.summary.importance).toEqual({
      score: 25,
      level: "medium",
    });
    expect(itemA?.importanceFactors).toEqual([
      {
        kind: "priorityLabel",
        points: 25,
        detail: "優先度ラベルの重みで25点を加算します",
      },
    ]);
    expect(itemA?.summary.author).toMatchObject({
      status: "identified",
      actor: {
        login: "author-I_A",
      },
    });
    expect(itemA?.summary.assignees).toMatchObject([
      {
        login: "assignee-I_A",
      },
    ]);
    expect(itemA?.latestEventActor).toMatchObject({
      status: "present",
      actor: {
        login: "event-actor-I_A",
      },
    });
    expect(itemA?.latestEventActor).not.toHaveProperty("actor.nodeId");
    expect(itemA?.summary.aiAnalysis).toEqual({
      status: "not_required",
    });
    expect(itemA).not.toHaveProperty("inputEvents");
    expect(itemA?.timestamps).toEqual({
      createdAt: CREATED_AT,
      githubUpdatedAt: FRESH_OBSERVED_AT,
      stallSince: FRESH_OBSERVED_AT,
    });
    expect(itemA?.evidence[0]).not.toHaveProperty("sourceId");
    expect(itemA?.evidence[0]).not.toHaveProperty("supports");
    expect(itemA?.history).toHaveLength(2);
    expect(itemA?.history.at(-1)).not.toHaveProperty("runId");
    expect(itemA?.history.at(-1)).toMatchObject({
      kind: "responsibility_changed",
      before: {
        state: "present",
        value: {
          status: "waiting_for_assessment",
        },
      },
      after: {
        state: "present",
        value: {
          status: "waiting_for_unblock",
        },
      },
    });
    const serializedHistory = JSON.stringify(itemA?.history.at(-1));
    expect(serializedHistory).not.toContain('"sourceIds"');
    expect(serializedHistory).not.toContain('"reasonSummary"');
    expect(serializedHistory).not.toContain('"confidence"');
  });

  it("stale repositoryとAI unavailableを項目まで明示する", () => {
    const snapshot = createSnapshot({
      runId: "run-stale",
      runStatus: "fallback",
      ai: {
        enabled: true,
        available: false,
        degraded: true,
      },
      generatedAt: GENERATED_AT,
      repositories: [
        {
          id: PUBLIC_REPOSITORY_ID,
          name: "public",
          observedAt: FRESH_OBSERVED_AT,
          freshness: "fresh",
        },
        {
          id: STALE_REPOSITORY_ID,
          name: "stale",
          observedAt: STALE_OBSERVED_AT,
          freshness: "stale",
          failedAt: FRESH_OBSERVED_AT,
        },
      ],
      items: [
        createItem({
          nodeId: "I_FRESH",
          repositoryId: PUBLIC_REPOSITORY_ID,
          repositoryName: "public",
          number: 1,
          status: "waiting_for_assessment",
          severity: "watch",
          waitingOnKind: "role",
          waitingOnRole: "maintainer",
          observedAt: FRESH_OBSERVED_AT,
          title: "最新項目",
        }),
        createItem({
          nodeId: "I_STALE",
          repositoryId: STALE_REPOSITORY_ID,
          repositoryName: "stale",
          number: 2,
          status: "waiting_for_review",
          severity: "urgent",
          waitingOnKind: "team",
          waitingOnRole: "reviewer",
          observedAt: STALE_OBSERVED_AT,
          title: "前回値の項目",
        }),
      ],
      relations: [],
    });
    const inventory = createInventory([
      {
        id: PUBLIC_REPOSITORY_ID,
        name: "public",
        visibility: "public",
      },
      {
        id: STALE_REPOSITORY_ID,
        name: "stale",
        visibility: "public",
      },
    ]);

    const generated = generateFixture(snapshot, [], inventory, [], defaultGenerationOptions);
    const staleRepository = generated.summary.repositories.find(
      (repository) => repository.id === STALE_REPOSITORY_ID,
    );
    const staleItem = generated.summary.items.find((item) => item.nodeId === "I_STALE");

    expect(generated.summary.ai).toEqual({
      enabled: true,
      available: false,
      degraded: true,
    });
    expect(generated.summary.observedAt).toBe(FRESH_OBSERVED_AT);
    expect(staleRepository).toMatchObject({
      freshness: {
        status: "stale",
      },
    });
    expect(staleRepository).not.toHaveProperty("owner");
    expect(staleRepository).not.toHaveProperty("observedAt");
    expect(staleRepository).not.toHaveProperty("freshness.failedAt");
    expect(staleItem).toMatchObject({
      observedAt: STALE_OBSERVED_AT,
      repositoryFreshness: "stale",
    });
  });
});

describe("公開summaryサイズと書き出し", () => {
  it("大きなfixtureを詳細DTOへ分割してsummaryをgzip 1 MiB以内に保つ", () => {
    const itemCount = 5000;
    const edgeCount = 10_000;
    const snapshot = createSnapshot({
      runId: "run-large",
      runStatus: "success",
      ai: {
        enabled: true,
        available: true,
        degraded: false,
      },
      generatedAt: GENERATED_AT,
      repositories: [
        {
          id: PUBLIC_REPOSITORY_ID,
          name: "public",
          observedAt: FRESH_OBSERVED_AT,
          freshness: "fresh",
        },
      ],
      items: Array.from({ length: itemCount }, (_, index) =>
        createItem({
          nodeId: `I_LARGE_${index.toString().padStart(4, "0")}`,
          repositoryId: PUBLIC_REPOSITORY_ID,
          repositoryName: "public",
          number: index + 1,
          status: index % 10 === 0 ? "waiting_for_review" : "in_progress",
          severity: index % 10 === 0 ? "urgent" : "none",
          waitingOnKind: index % 10 === 0 ? "team" : "user",
          waitingOnRole: index % 10 === 0 ? "reviewer" : "assignee",
          observedAt: FRESH_OBSERVED_AT,
          title: `大規模fixture項目 ${index.toString().padStart(4, "0")}`,
        }),
      ),
      relations: Array.from({ length: edgeCount }, (_, index) => {
        const fromIndex = index % itemCount;
        const distance = index < itemCount ? 1 : 2;
        const toIndex = (fromIndex + distance) % itemCount;
        return createRelation(
          `rel:LARGE_${index.toString().padStart(5, "0")}`,
          `I_LARGE_${fromIndex.toString().padStart(4, "0")}`,
          `I_LARGE_${toIndex.toString().padStart(4, "0")}`,
          "blocks",
        );
      }),
    });
    const options = {
      confidenceThresholds: defaultGenerationOptions.confidenceThresholds,
      labelRules: defaultGenerationOptions.labelRules,
      maxInitialGraphNodes: 100,
      maxSummaryGzipBytes: PUBLIC_SUMMARY_GZIP_LIMIT_BYTES,
      timezone: defaultGenerationOptions.timezone,
    } satisfies PublicDtoGenerationOptions;

    const generated = generateFixture(snapshot, [], publicInventory(), [], options);

    expect(generated.summary.items).toHaveLength(itemCount);
    expect(generated.summary.graph.nodes).toHaveLength(100);
    expect(generated.summary.graph.maxNodes).toBe(100);
    expect(generated.summarySize.gzipBytes).toBeLessThanOrEqual(PUBLIC_SUMMARY_GZIP_LIMIT_BYTES);
  }, 30_000);

  it("設定した上限を超えるfixtureではDTO生成を失敗させる", () => {
    const snapshot = createSingleItemSnapshot("gzip上限超過fixture");
    const options = {
      confidenceThresholds: defaultGenerationOptions.confidenceThresholds,
      labelRules: defaultGenerationOptions.labelRules,
      maxInitialGraphNodes: 1,
      maxSummaryGzipBytes: 64,
      timezone: defaultGenerationOptions.timezone,
    } satisfies PublicDtoGenerationOptions;

    expect(() => generateFixture(snapshot, [], publicInventory(), [], options)).toThrow(
      PublicSummarySizeError,
    );
  });

  it("薄いadapterがsummaryとdetailsを別ファイルへ書き出す", async () => {
    const generated = generateFixture(
      createSingleItemSnapshot("書き出しfixture"),
      [],
      publicInventory(),
      [],
      defaultGenerationOptions,
    );
    const outputDirectory = await mkdtemp(join(tmpdir(), "voicevox-pages-public-data-"));
    try {
      const result = await writePublicDataFiles(outputDirectory, generated);
      const summarySource = await readFile(join(outputDirectory, PUBLIC_SUMMARY_FILE_NAME), "utf8");
      const detailsSource = await readFile(join(outputDirectory, PUBLIC_DETAILS_FILE_NAME), "utf8");

      expect(result.summaryBytes).toBe(Buffer.byteLength(summarySource, "utf8"));
      expect(result.detailsBytes).toBe(Buffer.byteLength(detailsSource, "utf8"));
      expect(JSON.parse(summarySource)).toMatchObject({
        schemaVersion: "5",
        runId: "run-single",
      });
      expect(JSON.parse(detailsSource)).toMatchObject({
        schemaVersion: "5",
        runId: "run-single",
      });
    } finally {
      await rm(outputDirectory, {
        recursive: true,
      });
    }
  });
});
