import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import {
  createAiCacheEntry,
  createAiCacheKey,
  hashCanonicalJson,
  type AiCacheEntry,
} from "../src/codex/index.js";
import {
  buildSourceId,
  createGitHubRepositoryId,
  createUtcIsoDateTime,
  type Repository,
  type StalenessWaitClass,
  type Status,
  type WaitingOnKind,
  type WaitingOnRole,
} from "../src/domain/index.js";
import {
  GitStateBranchAdapter,
  MemoryStateBranchAdapter,
  StateBranchCommitError,
  StateFormatError,
  StatePersistenceSession,
  StatePublicSafetyError,
  StateSnapshotSchemaError,
  StateZodValidationError,
  createEmptyStateNotificationLedger,
  createStateHistoryInputEvents,
  createStateHistoryRecord,
  createStateNotificationLedger,
  createStateRunReport,
  createStateSnapshot,
  parseStateHistoryRecords,
  parseStateSnapshot,
  serializeCanonicalJson,
  serializeStateHistoryRecords,
  serializeStateNotificationLedger,
  serializeStateSnapshot,
  type StateNotificationLedger,
  type StatePersistenceConfiguration,
  type StateRunReport,
  type StateSnapshot,
  type StateHistoryInputEvent,
} from "../src/persistence/index.js";
import { assertNonNullable } from "../src/util/index.js";

const execFileAsync = promisify(execFile);
const gitTestTimeoutMilliseconds = 15_000;
const fixedTrackingStartAt = "2026-07-30T23:00:00.000Z";
const fixedItemAt = "2026-07-30T23:30:00.000Z";
const publicRepositoryId = "R_PUBLIC";
const privateRepositoryId = "R_PRIVATE_SENTINEL";
const itemNodeId = "I_TRACKED";
const stateConfiguration = Object.freeze({
  branch: "tracker-state",
  snapshotPath: "state/snapshot.json",
  historyDirectory: "state/history",
  aiCacheDirectory: "state/ai-cache",
  notificationLedgerPath: "state/notification-ledger.json",
  runReportsDirectory: "state/run-reports",
  canonicalJson: true,
}) satisfies StatePersistenceConfiguration;

type ResponsibilityFixture = Readonly<{
  status: Status;
  kind: WaitingOnKind;
  candidateId: string;
  role: WaitingOnRole;
}>;

type EdgeFixture =
  | Readonly<{
      status: "absent";
    }>
  | Readonly<{
      status: "active";
    }>
  | Readonly<{
      status: "inactive";
    }>;

type SnapshotFixtureOptions = Readonly<{
  runId: string;
  generatedAt: string;
  repositoryIds: readonly string[];
  responsibility: ResponsibilityFixture;
  severity: "none" | "watch" | "urgent" | "critical";
  edge: EdgeFixture;
}>;

function severityWaitClass(status: Status): StalenessWaitClass {
  switch (status) {
    case "new_untriaged":
    case "needs_maintainer_decision":
      return "maintainerTriage";
    case "waiting_for_review":
      return "reviewer";
    case "waiting_for_author":
      return "authorAfterChangesRequested";
    case "waiting_for_assignee":
    case "in_progress":
      return "assigneeOrInProgress";
    case "blocked":
      return "blockedParent";
    case "waiting_for_automation":
      return "automation";
    case "ready_to_merge":
      return "readyToMerge";
    case "unknown":
      return "ownerUnknown";
    case "terminal_merged":
    case "terminal_completed":
    case "terminal_not_planned":
      return "notApplicable";
  }
}

function createRepository(id: string, visibility: "public" | "private" | "internal"): Repository {
  return Object.freeze({
    id: createGitHubRepositoryId(id),
    owner: "VOICEVOX",
    name: id.toLowerCase(),
    visibility,
    archived: false,
    disabled: false,
    observedAt: createUtcIsoDateTime(fixedItemAt),
  });
}

function createRepositoryInventory(includePrivate: boolean): readonly Repository[] {
  const repositories = [createRepository(publicRepositoryId, "public")];
  if (includePrivate) {
    repositories.push(createRepository(privateRepositoryId, "private"));
  }
  return Object.freeze(repositories);
}

function createRelations(edge: EdgeFixture): readonly unknown[] {
  if (edge.status === "absent") {
    return [];
  }
  const common = {
    id: "relation:blocker",
    fromNodeId: "I_BLOCKER",
    toNodeId: itemNodeId,
    type: "blocks",
    provenance: "native",
    confidence: 1,
    evidence: [
      {
        sourceId: "fixture:relation",
        supports: "relation",
        summary: "native dependency",
      },
    ],
    contradictions: [],
    firstSeenAt: fixedItemAt,
    lastConfirmedAt: fixedItemAt,
  };
  if (edge.status === "active") {
    return [
      {
        ...common,
        active: true,
      },
    ];
  }
  return [
    {
      ...common,
      active: false,
      removedAt: fixedItemAt,
    },
  ];
}

function createSnapshot(options: SnapshotFixtureOptions): StateSnapshot {
  return createStateSnapshot({
    schemaVersion: "5",
    generatedAt: options.generatedAt,
    trackingStartAt: {
      status: "fixed",
      value: fixedTrackingStartAt,
      source: "first_complete_run",
    },
    ai: {
      enabled: false,
      available: false,
      degraded: false,
    },
    collection: {
      repositories: [],
    },
    repositories: options.repositoryIds.map((repositoryId) => ({
      id: repositoryId,
      owner: "VOICEVOX",
      name: repositoryId.toLowerCase(),
      visibility: "public",
      archived: false,
      disabled: false,
      observedAt: fixedItemAt,
      freshness: "fresh",
    })),
    items: [
      {
        nodeId: itemNodeId,
        type: "issue",
        repositoryId: publicRepositoryId,
        displayReference: "VOICEVOX/example#1",
        number: 1,
        url: "https://github.com/VOICEVOX/example/issues/1",
        title: "追跡対象",
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
        author: {
          status: "identified",
          actor: {
            type: "human",
            nodeId: "U_AUTHOR",
            login: "author",
          },
        },
        latestEventActor: {
          status: "absent",
        },
        state: "open",
        notificationClass: "standard",
        status: options.responsibility.status,
        waitingOn: [
          {
            kind: options.responsibility.kind,
            candidateId: options.responsibility.candidateId,
            role: options.responsibility.role,
            reasonSummary: "次の対応待ちです",
            sourceIds: ["fixture:owner"],
            confidence: 1,
          },
        ],
        primaryWaitingOn: {
          index: 0,
          selectionReason: "fixtureの先頭候補をprimaryとして選びました",
        },
        nextAction: "次の担当が対応する",
        createdAt: fixedItemAt,
        githubUpdatedAt: fixedItemAt,
        lastHumanActivityAt: fixedItemAt,
        lastProgressAt: fixedItemAt,
        statusSince: fixedItemAt,
        ownerSince: fixedItemAt,
        stallSince: fixedItemAt,
        observedAt: fixedItemAt,
        labels: ["優先度：高"],
        assignees: [],
        reviewState: "not_applicable",
        checkState: "not_applicable",
        aiAnalysis: {
          status: "not_used",
        },
        inputEvents: [],
        confidence: 1,
        evidence: [
          {
            sourceId: "fixture:owner",
            supports: "waiting_on",
            summary: "fixtureの責務です",
          },
        ],
        uncertainties: [],
        severity: options.severity,
        severityContext: {
          waitClass: severityWaitClass(options.responsibility.status),
          decisionBasis: "deterministic",
        },
      },
    ],
    externalReferences: [
      {
        kind: "external_reference",
        nodeId: "I_BLOCKER",
        repositoryFullName: "external/example",
        number: 2,
        url: "https://github.com/external/example/issues/2",
        title: "外部blocker",
        state: "open",
        recursiveTracking: "not_allowed",
        directNotification: "not_eligible",
      },
    ],
    relations: createRelations(options.edge),
    run: {
      id: options.runId,
      status: "success",
      complete: true,
    },
  });
}

function createHistoryInputEvent(itemNodeId: string, sourceId: string): StateHistoryInputEvent {
  return Object.freeze({
    sourceId,
    itemNodeId,
    kind: "push",
    actor: Object.freeze({
      type: "system",
      name: "GitHub",
    }),
    occurredAt: fixedItemAt,
  });
}

function createHistoryInputSnapshot(
  runId: string,
  generatedAt: string,
  itemNodeIds: readonly string[],
  sourceId: string,
): StateSnapshot {
  const snapshot = createSnapshot({
    runId,
    generatedAt,
    repositoryIds: [publicRepositoryId],
    responsibility: {
      status: "new_untriaged",
      kind: "role",
      candidateId: "role:maintainer",
      role: "maintainer",
    },
    severity: "watch",
    edge: {
      status: "absent",
    },
  });
  const template = snapshot.items[0];
  assertNonNullable(template, "履歴入力イベント用の項目fixtureがありません");
  return createStateSnapshot({
    ...snapshot,
    items: itemNodeIds.map((nodeId, index) => {
      const number = index + 1;
      const url = `https://github.com/VOICEVOX/example/issues/${number.toString()}`;
      return {
        ...template,
        nodeId,
        displayReference: `VOICEVOX/example#${number.toString()}`,
        number,
        url,
        inputEvents: [
          {
            sourceId,
            url,
          },
        ],
      };
    }),
  });
}

function subtractMinutes(value: string, minutes: number): string {
  return new Date(Date.parse(value) - minutes * 60_000).toISOString();
}

function createRunReport(
  snapshot: StateSnapshot,
  date: string,
  diagnostics: readonly string[],
): StateRunReport {
  return createStateRunReport({
    schemaVersion: "1",
    runId: snapshot.run.id,
    date,
    status: snapshot.run.status,
    complete: true,
    scheduledFor: subtractMinutes(snapshot.generatedAt, 10),
    startedAt: snapshot.generatedAt,
    finishedAt: subtractMinutes(snapshot.generatedAt, -5),
    metrics: {
      repositoryCount: snapshot.repositories.length,
      itemCount: snapshot.items.length,
      changedItemCount: 1,
      activeEdgeCount: snapshot.relations.filter((relation) => relation.active).length,
      aiCallCount: 0,
      aiCacheHitCount: 0,
      estimatedInputTokens: 0,
      githubApiRemaining: 5000,
      staleRepositoryCount: 0,
      notificationCount: 0,
      scheduleDelayMilliseconds: 600_000,
      durationMilliseconds: 300_000,
    },
    diagnostics,
  });
}

function createSentLedger(cooldownUntil: string): StateNotificationLedger {
  return createStateNotificationLedger({
    schemaVersion: "1",
    entries: [
      {
        notificationKey: "notification:tracked:overdue",
        itemNodeId,
        reasonCode: "triage_overdue",
        severity: "urgent",
        reservedAt: fixedItemAt,
        cooldownUntil,
        status: "sent",
        sentAt: fixedItemAt,
        discordMessageId: "discord-message-1",
      },
    ],
    operationsAlerts: [
      {
        alertKey: "discord-operations-alert:v1:pages",
        incidentId: "pages-run-1",
        kind: "pages",
        occurredAt: fixedItemAt,
        sentAt: fixedItemAt,
        discordMessageId: "discord-operations-message-1",
      },
    ],
  });
}

function createCacheEntry(): AiCacheEntry {
  const inputHash = hashCanonicalJson({
    input: "fixture",
  });
  const cacheKey = createAiCacheKey({
    deterministicRulesVersion: "rules-v1",
    model: "codex-model",
    reasoningEffort: "medium",
    backendVersion: "codex-cli-1",
    promptVersion: "prompt-v1",
    schemaVersion: "schema-v1",
    inputHash,
  });
  const output = {
    result: "cached",
  };
  return createAiCacheEntry({
    cacheKey,
    sourceHash: hashCanonicalJson({
      source: "fixture",
    }),
    metadata: {
      deterministicRulesVersion: "rules-v1",
      model: "codex-model",
      reasoningEffort: "medium",
      backendVersion: "codex-cli-1",
      promptVersion: "prompt-v1",
      schemaVersion: "schema-v1",
      inputHash,
      outputHash: hashCanonicalJson(output),
      executedAt: fixedItemAt,
    },
    output,
  });
}

function snapshotWithoutVolatileFields(snapshot: StateSnapshot): unknown {
  return {
    schemaVersion: snapshot.schemaVersion,
    trackingStartAt: snapshot.trackingStartAt,
    collection: snapshot.collection,
    repositories: snapshot.repositories,
    items: snapshot.items,
    relations: snapshot.relations,
  };
}

async function captureError(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error: unknown) {
    if (error instanceof Error) {
      return error;
    }
    throw error;
  }
  throw new Error("期待したエラーが発生しませんでした");
}

function captureSynchronousError(operation: () => unknown): Error {
  try {
    operation();
  } catch (error: unknown) {
    if (error instanceof Error) {
      return error;
    }
    throw error;
  }
  throw new Error("期待したエラーが発生しませんでした");
}

async function readGitOutput(
  repositoryPath: string,
  arguments_: readonly string[],
): Promise<string> {
  const result = await execFileAsync("git", ["-C", repositoryPath, ...arguments_], {
    encoding: "utf8",
  });
  return result.stdout.trim();
}

describe("state schema version", () => {
  it("version 1のsnapshotを登録済みparserで読み取り現行形式へmigrationする", () => {
    const snapshot = createSnapshot({
      runId: "run-schema-version-1",
      generatedAt: "2026-08-01T00:00:00.000Z",
      repositoryIds: [publicRepositoryId, "R_SECOND"],
      responsibility: {
        status: "new_untriaged",
        kind: "role",
        candidateId: "role:maintainer",
        role: "maintainer",
      },
      severity: "watch",
      edge: {
        status: "absent",
      },
    });
    const source = serializeCanonicalJson({
      ...snapshot,
      schemaVersion: "1",
      collection: {
        repositories: [
          {
            repositoryId: publicRepositoryId,
            successfulAt: fixedItemAt,
            items: [
              {
                freshness: "fresh",
                nodeId: itemNodeId,
                repositoryId: publicRepositoryId,
                itemFingerprint: hashCanonicalJson({ item: itemNodeId }),
                aiAnalysisFingerprint: {
                  status: "available",
                  fingerprint: {
                    sourceHash: hashCanonicalJson({ source: itemNodeId }),
                    inputHash: hashCanonicalJson({ input: itemNodeId }),
                    graphNeighborhoodHash: hashCanonicalJson({ graph: itemNodeId }),
                  },
                },
                observedAt: fixedItemAt,
                state: "open",
                terminalAt: null,
              },
            ],
          },
        ],
      },
      repositories: [...snapshot.repositories].reverse(),
    });

    const migrated = parseStateSnapshot(source);

    expect(migrated.schemaVersion).toBe("5");
    expect(migrated.repositories.map((repository) => repository.id)).toEqual([
      publicRepositoryId,
      "R_SECOND",
    ]);
    expect(migrated.collection.repositories[0]?.items[0]?.aiAnalysisFingerprint).toEqual({
      status: "unavailable",
    });
    expect(migrated.collection.repositories[0]?.items[0]?.analysisRulesFingerprint).toEqual({
      status: "unavailable",
    });
    expect(migrated.collection.repositories[0]?.items[0]?.deterministicRulesVersion).toEqual({
      status: "unavailable",
    });
    expect(migrated.items[0]?.milestone).toBeNull();
    expect(migrated.items[0]?.importance).toEqual({
      score: 0,
      level: "low",
      factors: [],
    });
  });

  it("version 2のsnapshotへ決定規則version未取得を設定して現行形式へmigrationする", () => {
    const snapshot = createSnapshot({
      runId: "run-schema-version-2",
      generatedAt: "2026-08-01T00:00:00.000Z",
      repositoryIds: [publicRepositoryId],
      responsibility: {
        status: "new_untriaged",
        kind: "role",
        candidateId: "role:maintainer",
        role: "maintainer",
      },
      severity: "watch",
      edge: {
        status: "absent",
      },
    });
    const source = serializeCanonicalJson({
      ...snapshot,
      schemaVersion: "2",
      collection: {
        repositories: [
          {
            repositoryId: publicRepositoryId,
            successfulAt: fixedItemAt,
            items: [
              {
                freshness: "fresh",
                nodeId: itemNodeId,
                repositoryId: publicRepositoryId,
                itemFingerprint: hashCanonicalJson({ item: itemNodeId }),
                aiAnalysisFingerprint: {
                  status: "unavailable",
                },
                analysisRulesFingerprint: {
                  status: "available",
                  fingerprint: hashCanonicalJson({ analysisRules: itemNodeId }),
                },
                observedAt: fixedItemAt,
                state: "open",
                terminalAt: null,
              },
            ],
          },
        ],
      },
    });

    const migrated = parseStateSnapshot(source);

    expect(migrated.schemaVersion).toBe("5");
    expect(migrated.collection.repositories[0]?.items[0]?.analysisRulesFingerprint).toEqual({
      status: "unavailable",
    });
    expect(migrated.collection.repositories[0]?.items[0]?.deterministicRulesVersion).toEqual({
      status: "unavailable",
    });
    expect(migrated.items[0]?.milestone).toBeNull();
    expect(migrated.items[0]?.importance).toEqual({
      score: 0,
      level: "low",
      factors: [],
    });
  });

  it("version 3のsnapshotへmilestone未設定を追加して現行形式へmigrationする", () => {
    const snapshot = createSnapshot({
      runId: "run-schema-version-3",
      generatedAt: "2026-08-01T00:00:00.000Z",
      repositoryIds: [publicRepositoryId],
      responsibility: {
        status: "new_untriaged",
        kind: "role",
        candidateId: "role:maintainer",
        role: "maintainer",
      },
      severity: "watch",
      edge: {
        status: "absent",
      },
    });
    const item = snapshot.items[0];
    assertNonNullable(item, "version 3のitem fixtureがありません");
    const { milestone, ...version3Item } = item;
    expect(milestone).toBeNull();
    const source = serializeCanonicalJson({
      ...snapshot,
      schemaVersion: "3",
      items: [version3Item],
    });

    const migrated = parseStateSnapshot(source);

    expect(migrated.schemaVersion).toBe("5");
    expect(migrated.items[0]?.milestone).toBeNull();
    expect(migrated.items[0]?.importance).toEqual({
      score: 0,
      level: "low",
      factors: [],
    });
  });

  it("version 4のsnapshotへimportance未計算値を追加して現行形式へmigrationする", () => {
    const snapshot = createSnapshot({
      runId: "run-schema-version-4",
      generatedAt: "2026-08-01T00:00:00.000Z",
      repositoryIds: [publicRepositoryId],
      responsibility: {
        status: "new_untriaged",
        kind: "role",
        candidateId: "role:maintainer",
        role: "maintainer",
      },
      severity: "watch",
      edge: {
        status: "absent",
      },
    });
    const item = snapshot.items[0];
    assertNonNullable(item, "version 4のitem fixtureがありません");
    const { importance, ...version4Item } = item;
    expect(importance.score).toBe(25);
    const source = serializeCanonicalJson({
      ...snapshot,
      schemaVersion: "4",
      items: [version4Item],
    });

    const migrated = parseStateSnapshot(source);

    expect(migrated.schemaVersion).toBe("5");
    expect(migrated.items[0]?.importance).toEqual({
      score: 0,
      level: "low",
      factors: [],
    });
  });

  it("version 1のhistoryを登録済みparserで読み取り現行形式へmigrationする", () => {
    const source = `${serializeCanonicalJson({
      schemaVersion: "1",
      date: "2026-08-01",
      runId: "run-history-schema-version-1",
      recordedAt: "2026-08-01T09:00:00+09:00",
      inputEvents: [],
      events: [],
    })}\n`;

    const records = parseStateHistoryRecords(source);
    const record = records[0];
    assertNonNullable(record, "version 1のhistory recordを取得できませんでした");

    expect(record).toEqual({
      schemaVersion: "1",
      date: "2026-08-01",
      runId: "run-history-schema-version-1",
      recordedAt: "2026-08-01T00:00:00.000Z",
      inputEvents: [],
      events: [],
    });
    expect(Object.isFrozen(record)).toBe(true);
  });

  it("未知のsnapshot schema versionを拒否する", () => {
    const snapshot = createSnapshot({
      runId: "run-unknown-schema-version",
      generatedAt: "2026-08-01T00:00:00.000Z",
      repositoryIds: [publicRepositoryId],
      responsibility: {
        status: "new_untriaged",
        kind: "role",
        candidateId: "role:maintainer",
        role: "maintainer",
      },
      severity: "watch",
      edge: {
        status: "absent",
      },
    });
    const error = captureSynchronousError(() =>
      parseStateSnapshot(
        serializeCanonicalJson({
          ...snapshot,
          schemaVersion: "999",
        }),
      ),
    );

    expect(error).toBeInstanceOf(StateFormatError);
    expect(error).not.toBeInstanceOf(StateZodValidationError);
    expect(error.cause).toMatchObject({
      message: "snapshotのschemaVersionは未対応です",
    });
  });

  it("未知のhistory schema versionを拒否する", () => {
    const source = `${serializeCanonicalJson({
      schemaVersion: "999",
      date: "2026-08-01",
      runId: "run-history-unknown-schema-version",
      recordedAt: "2026-08-01T00:00:00.000Z",
      inputEvents: [],
      events: [],
    })}\n`;
    const error = captureSynchronousError(() => parseStateHistoryRecords(source));

    expect(error).toBeInstanceOf(StateFormatError);
    expect(error.cause).toMatchObject({
      message: "state historyのschemaVersionは未対応です",
    });
  });
});

describe("state履歴の入力イベント", () => {
  it("Zod検証失敗から安全化済みissueだけを保持する", () => {
    const actualValueCanary = "STATE_HISTORY_ACTUAL_VALUE_CANARY";
    const error = captureSynchronousError(() => createStateHistoryInputEvents([actualValueCanary]));

    expect(error).toBeInstanceOf(StateFormatError);
    if (!(error instanceof StateZodValidationError)) {
      throw error;
    }
    expect(error.issueCount).toBe(1);
    expect(error.omittedIssueCount).toBe(0);
    expect(error.issues).toEqual([
      {
        path: [0],
        code: "invalid_type",
        expected: "object",
      },
    ]);
    expect(Object.isFrozen(error.issues)).toBe(true);
    expect(Object.isFrozen(error.issues[0]?.path)).toBe(true);
    expect(error.cause).toMatchObject({
      name: "TypeError",
      message: "state履歴の入力イベントのschema検証に失敗しました。問題件数: 1",
    });
    expect(
      JSON.stringify({
        cause: error.cause instanceof Error ? error.cause.message : error.cause,
        issues: error.issues,
      }),
    ).not.toContain(actualValueCanary);
  });

  it("別項目で共有するsource IDを受理し入力順に依存せず整列する", () => {
    const sourceId = buildSourceId("github_commit", "C_SHARED");
    const first = createHistoryInputEvent("I_FIRST", sourceId);
    const second = createHistoryInputEvent("I_SECOND", sourceId);

    const forward = createStateHistoryInputEvents([first, second]);
    const reverse = createStateHistoryInputEvents([second, first]);

    expect(forward).toEqual([first, second]);
    expect(reverse).toEqual(forward);
  });

  it("Pull Request固有イベントの6種を受理する", () => {
    const kinds = Object.freeze([
      "ready_for_review",
      "converted_to_draft",
      "added_to_merge_queue",
      "removed_from_merge_queue",
      "auto_merge_enabled",
      "auto_merge_disabled",
    ] satisfies readonly StateHistoryInputEvent["kind"][]);
    const events = kinds.map((kind) =>
      Object.freeze({
        ...createHistoryInputEvent("I_PULL_REQUEST", `github_timeline_event:${kind}`),
        kind,
      } satisfies StateHistoryInputEvent),
    );

    const normalized = createStateHistoryInputEvents(events);

    expect(normalized).toHaveLength(6);
    expect(new Set(normalized.map((event) => event.kind))).toEqual(new Set(kinds));
  });

  it("同じ項目のsource ID重複を拒否する", () => {
    const event = createHistoryInputEvent(
      "I_DUPLICATE",
      buildSourceId("github_commit", "C_DUPLICATE"),
    );

    expect(() => createStateHistoryInputEvents([event, event])).toThrow(StateFormatError);
  });

  it("前回snapshotとの新規判定に項目とsource IDの組を使う", () => {
    const sourceId = buildSourceId("github_commit", "C_HISTORY_SHARED");
    const first = createHistoryInputEvent("I_HISTORY_FIRST", sourceId);
    const second = createHistoryInputEvent("I_HISTORY_SECOND", sourceId);
    const previous = createHistoryInputSnapshot(
      "run-history-input-previous",
      "2026-07-31T00:00:00.000Z",
      [first.itemNodeId],
      sourceId,
    );
    const current = createHistoryInputSnapshot(
      "run-history-input-current",
      "2026-08-01T00:00:00.000Z",
      [first.itemNodeId, second.itemNodeId],
      sourceId,
    );

    const initialRecord = createStateHistoryRecord(
      undefined,
      current,
      "2026-08-01",
      current.repositories,
      [second, first],
    );
    const nextRecord = createStateHistoryRecord(
      previous,
      current,
      "2026-08-01",
      current.repositories,
      [second, first],
    );
    const movedCurrent = createHistoryInputSnapshot(
      "run-history-input-moved",
      "2026-08-01T00:00:00.000Z",
      [second.itemNodeId],
      sourceId,
    );
    const movedRecord = createStateHistoryRecord(
      previous,
      movedCurrent,
      "2026-08-01",
      movedCurrent.repositories,
      [second],
    );
    const parsedRecord = parseStateHistoryRecords(serializeStateHistoryRecords([initialRecord]))[0];

    expect(parsedRecord?.inputEvents).toEqual([first, second]);
    expect(nextRecord.inputEvents).toEqual([second]);
    expect(movedRecord.inputEvents).toEqual([second]);
  });
});

describe("state canonical JSON", () => {
  it("キーと集合配列の入力順に依存せず同じbyte列を生成する", () => {
    const left = createSnapshot({
      runId: "run-canonical",
      generatedAt: "2026-07-31T00:00:00.000Z",
      repositoryIds: ["R_SECOND", publicRepositoryId],
      responsibility: {
        status: "new_untriaged",
        kind: "role",
        candidateId: "role:maintainer",
        role: "maintainer",
      },
      severity: "watch",
      edge: {
        status: "active",
      },
    });
    const right = createSnapshot({
      runId: "run-canonical",
      generatedAt: "2026-07-31T00:00:00.000Z",
      repositoryIds: [publicRepositoryId, "R_SECOND"],
      responsibility: {
        status: "new_untriaged",
        kind: "role",
        candidateId: "role:maintainer",
        role: "maintainer",
      },
      severity: "watch",
      edge: {
        status: "active",
      },
    });

    expect(serializeStateSnapshot(left)).toBe(serializeStateSnapshot(right));
    expect(
      serializeCanonicalJson({
        outer: {
          z: 1,
          a: 2,
        },
      }),
    ).toBe('{"outer":{"a":2,"z":1}}');
  });

  it("runごとのvolatile fieldを除けば同じ入力のbyte列が一致する", () => {
    const first = createSnapshot({
      runId: "run-volatile-1",
      generatedAt: "2026-07-31T00:00:00.000Z",
      repositoryIds: [publicRepositoryId],
      responsibility: {
        status: "new_untriaged",
        kind: "role",
        candidateId: "role:maintainer",
        role: "maintainer",
      },
      severity: "watch",
      edge: {
        status: "absent",
      },
    });
    const second = createSnapshot({
      runId: "run-volatile-2",
      generatedAt: "2026-08-01T00:00:00.000Z",
      repositoryIds: [publicRepositoryId],
      responsibility: {
        status: "new_untriaged",
        kind: "role",
        candidateId: "role:maintainer",
        role: "maintainer",
      },
      severity: "watch",
      edge: {
        status: "absent",
      },
    });

    expect(serializeCanonicalJson(snapshotWithoutVolatileFields(first))).toBe(
      serializeCanonicalJson(snapshotWithoutVolatileFields(second)),
    );
  });

  it("AI分析と判定規則のfingerprintと決定規則versionを収集項目へ保存し、欠落した形式を拒否する", () => {
    const base = createSnapshot({
      runId: "run-ai-fingerprint",
      generatedAt: "2026-07-31T00:00:00.000Z",
      repositoryIds: [publicRepositoryId],
      responsibility: {
        status: "new_untriaged",
        kind: "role",
        candidateId: "role:maintainer",
        role: "maintainer",
      },
      severity: "watch",
      edge: {
        status: "absent",
      },
    });
    const itemFingerprint = hashCanonicalJson({
      item: itemNodeId,
    });
    const fingerprint = {
      sourceHash: hashCanonicalJson({ source: itemNodeId }),
      inputHash: hashCanonicalJson({ input: itemNodeId }),
      graphNeighborhoodHash: hashCanonicalJson({ graph: itemNodeId }),
      identityHash: hashCanonicalJson({ identity: itemNodeId }),
    };
    const collectionRepository = {
      repositoryId: publicRepositoryId,
      successfulAt: fixedItemAt,
      items: [
        {
          freshness: "fresh",
          nodeId: itemNodeId,
          repositoryId: publicRepositoryId,
          itemFingerprint,
          aiAnalysisFingerprint: {
            status: "available",
            fingerprint,
          },
          analysisRulesFingerprint: {
            status: "available",
            fingerprint: hashCanonicalJson({ analysisRules: itemNodeId }),
          },
          deterministicRulesVersion: {
            status: "available",
            version: "issue-v2",
          },
          observedAt: fixedItemAt,
          state: "open",
          terminalAt: null,
        },
      ],
    };
    const snapshot = createStateSnapshot({
      ...base,
      collection: {
        repositories: [collectionRepository],
      },
    });

    expect(
      parseStateSnapshot(serializeStateSnapshot(snapshot)).collection.repositories[0]?.items,
    ).toEqual(collectionRepository.items);
    expect(() =>
      createStateSnapshot({
        ...base,
        collection: {
          repositories: [
            {
              repositoryId: publicRepositoryId,
              successfulAt: fixedItemAt,
              items: [
                {
                  freshness: "fresh",
                  nodeId: itemNodeId,
                  repositoryId: publicRepositoryId,
                  itemFingerprint,
                  aiAnalysisFingerprint: {
                    status: "available",
                    fingerprint,
                  },
                  observedAt: fixedItemAt,
                  state: "open",
                  terminalAt: null,
                },
              ],
            },
          ],
        },
      }),
    ).toThrow(StateSnapshotSchemaError);
  });
});

describe("メモリstate branch transaction", () => {
  it("初回はorphan branchを作成し、以後は同じbranchへcommitする", async () => {
    const adapter = new MemoryStateBranchAdapter();
    const firstSnapshot = createSnapshot({
      runId: "run-bootstrap",
      generatedAt: "2026-07-31T00:00:00.000Z",
      repositoryIds: [publicRepositoryId],
      responsibility: {
        status: "new_untriaged",
        kind: "role",
        candidateId: "role:maintainer",
        role: "maintainer",
      },
      severity: "watch",
      edge: {
        status: "absent",
      },
    });
    const firstSession = await StatePersistenceSession.open(adapter, stateConfiguration);
    const first = await firstSession.persist({
      snapshot: firstSnapshot,
      historyInputEvents: [],
      notificationLedger: createEmptyStateNotificationLedger(),
      repositoryInventory: createRepositoryInventory(false),
      knownSecrets: [],
    });

    expect(first.branchCreated).toBe(true);
    expect(adapter.readParent(first.revision)).toEqual({
      status: "missing",
    });

    const secondSnapshot = createSnapshot({
      runId: "run-next-day",
      generatedAt: "2026-08-01T00:00:00.000Z",
      repositoryIds: [publicRepositoryId],
      responsibility: {
        status: "waiting_for_review",
        kind: "team",
        candidateId: "team:reviewers",
        role: "reviewer",
      },
      severity: "urgent",
      edge: {
        status: "active",
      },
    });
    const secondSession = await StatePersistenceSession.open(adapter, stateConfiguration);
    const second = await secondSession.persist({
      snapshot: secondSnapshot,
      historyInputEvents: [],
      notificationLedger: createEmptyStateNotificationLedger(),
      repositoryInventory: createRepositoryInventory(false),
      knownSecrets: [],
    });

    expect(second.branchCreated).toBe(false);
    expect(adapter.readParent(second.revision)).toEqual({
      status: "present",
      revision: first.revision,
    });
    expect(second.updatedPaths).toEqual(
      expect.arrayContaining([
        "state/snapshot.json",
        "state/history/2026-08-01.jsonl",
        "state/notification-ledger.json",
      ]),
    );
  });

  it("run完了時に実測時刻と通知件数を含むreportを保存する", async () => {
    const adapter = new MemoryStateBranchAdapter();
    const snapshot = createSnapshot({
      runId: "run-completion-report",
      generatedAt: "2026-07-31T00:00:00.000Z",
      repositoryIds: [publicRepositoryId],
      responsibility: {
        status: "new_untriaged",
        kind: "role",
        candidateId: "role:maintainer",
        role: "maintainer",
      },
      severity: "watch",
      edge: {
        status: "absent",
      },
    });
    const session = await StatePersistenceSession.open(adapter, stateConfiguration);
    await session.persist({
      snapshot,
      historyInputEvents: [],
      notificationLedger: createEmptyStateNotificationLedger(),
      repositoryInventory: createRepositoryInventory(false),
      knownSecrets: [],
    });
    expect(
      (await adapter.readBranchFiles("tracker-state")).has("state/run-reports/2026-07-31.json"),
    ).toBe(false);

    const baseReport = createRunReport(snapshot, "2026-07-31", []);
    const report = createStateRunReport({
      ...baseReport,
      metrics: {
        ...baseReport.metrics,
        notificationCount: 2,
      },
    });
    const result = await session.persistRunCompletion({
      snapshot,
      notificationLedger: createEmptyStateNotificationLedger(),
      runReport: report,
      repositoryInventory: createRepositoryInventory(false),
      knownSecrets: [],
    });
    const source = (await adapter.readBranchFiles("tracker-state")).get(
      "state/run-reports/2026-07-31.json",
    );
    assertNonNullable(source, "run完了reportがありません");
    const persisted: unknown = JSON.parse(new TextDecoder().decode(source));

    expect(result.updatedPaths).toContain("state/run-reports/2026-07-31.json");
    expect(createStateRunReport(persisted)).toMatchObject({
      startedAt: "2026-07-31T00:00:00.000Z",
      finishedAt: "2026-07-31T00:05:00.000Z",
      metrics: {
        notificationCount: 2,
        scheduleDelayMilliseconds: 600_000,
        durationMilliseconds: 300_000,
      },
    });
  });

  it("snapshotを欠く既存stateを初回運用障害stateと誤認しない", async () => {
    const adapter = new MemoryStateBranchAdapter();
    const notificationLedger = createStateNotificationLedger({
      schemaVersion: "1",
      entries: [],
      operationsAlerts: [
        {
          alertKey: "discord-operations-alert:v1:initial-collection",
          incidentId: "workflow-run-initial:collection",
          kind: "collection",
          occurredAt: fixedItemAt,
          sentAt: fixedItemAt,
          discordMessageId: "discord-operations-message-initial",
        },
      ],
    });
    await adapter.commit({
      branch: "tracker-state",
      expectedHead: {
        status: "missing",
      },
      updates: [
        {
          path: stateConfiguration.notificationLedgerPath,
          bytes: new TextEncoder().encode(serializeStateNotificationLedger(notificationLedger)),
        },
        {
          path: "state/run-reports/2026-07-31.json",
          bytes: new TextEncoder().encode("不完全なstate fixture\n"),
        },
      ],
      message: "incomplete state fixture",
      committedAt: fixedItemAt,
    });
    const session = await StatePersistenceSession.open(adapter, stateConfiguration);
    const error = await captureError(session.loadSnapshot());

    expect(error).toBeInstanceOf(StateFormatError);
    expect(error.cause).toMatchObject({
      message: "既存state branchにsnapshotがありません",
    });
  });

  it("ref更新前の失敗でlast good commitとsnapshotを変えない", async () => {
    const adapter = new MemoryStateBranchAdapter();
    const firstSnapshot = createSnapshot({
      runId: "run-last-good",
      generatedAt: "2026-07-31T00:00:00.000Z",
      repositoryIds: [publicRepositoryId],
      responsibility: {
        status: "new_untriaged",
        kind: "role",
        candidateId: "role:maintainer",
        role: "maintainer",
      },
      severity: "watch",
      edge: {
        status: "absent",
      },
    });
    const firstSession = await StatePersistenceSession.open(adapter, stateConfiguration);
    await firstSession.persist({
      snapshot: firstSnapshot,
      historyInputEvents: [],
      notificationLedger: createEmptyStateNotificationLedger(),
      repositoryInventory: createRepositoryInventory(false),
      knownSecrets: [],
    });
    const headBefore = await adapter.resolveHead("tracker-state");
    const filesBefore = await adapter.readBranchFiles("tracker-state");
    const snapshotBefore = filesBefore.get(stateConfiguration.snapshotPath);
    assertNonNullable(snapshotBefore, "last good snapshotがありません");

    const failedSnapshot = createSnapshot({
      runId: "run-failed",
      generatedAt: "2026-08-01T00:00:00.000Z",
      repositoryIds: [publicRepositoryId],
      responsibility: {
        status: "waiting_for_review",
        kind: "team",
        candidateId: "team:reviewers",
        role: "reviewer",
      },
      severity: "urgent",
      edge: {
        status: "active",
      },
    });
    const failedSession = await StatePersistenceSession.open(adapter, stateConfiguration);
    adapter.failNextCommit(new Error("fixture failure"));
    await expect(
      failedSession.persist({
        snapshot: failedSnapshot,
        historyInputEvents: [],
        notificationLedger: createEmptyStateNotificationLedger(),
        repositoryInventory: createRepositoryInventory(false),
        knownSecrets: [],
      }),
    ).rejects.toThrow(StateBranchCommitError);

    const headAfter = await adapter.resolveHead("tracker-state");
    const filesAfter = await adapter.readBranchFiles("tracker-state");
    const snapshotAfter = filesAfter.get(stateConfiguration.snapshotPath);
    assertNonNullable(snapshotAfter, "失敗後のlast good snapshotがありません");
    expect(headAfter).toEqual(headBefore);
    expect(snapshotAfter).toEqual(snapshotBefore);
  });

  it("private sentinelを独立allowlist検証で拒否してlast goodを維持する", async () => {
    const adapter = new MemoryStateBranchAdapter();
    const goodSnapshot = createSnapshot({
      runId: "run-public",
      generatedAt: "2026-07-31T00:00:00.000Z",
      repositoryIds: [publicRepositoryId],
      responsibility: {
        status: "new_untriaged",
        kind: "role",
        candidateId: "role:maintainer",
        role: "maintainer",
      },
      severity: "watch",
      edge: {
        status: "absent",
      },
    });
    const goodSession = await StatePersistenceSession.open(adapter, stateConfiguration);
    await goodSession.persist({
      snapshot: goodSnapshot,
      historyInputEvents: [],
      notificationLedger: createEmptyStateNotificationLedger(),
      repositoryInventory: createRepositoryInventory(true),
      knownSecrets: [],
    });
    const lastGoodHead = await adapter.resolveHead("tracker-state");

    const privateSnapshot = createSnapshot({
      runId: "run-private",
      generatedAt: "2026-08-01T00:00:00.000Z",
      repositoryIds: [publicRepositoryId, privateRepositoryId],
      responsibility: {
        status: "new_untriaged",
        kind: "role",
        candidateId: "role:maintainer",
        role: "maintainer",
      },
      severity: "urgent",
      edge: {
        status: "absent",
      },
    });
    const privateSession = await StatePersistenceSession.open(adapter, stateConfiguration);
    await expect(
      privateSession.persist({
        snapshot: privateSnapshot,
        historyInputEvents: [],
        notificationLedger: createEmptyStateNotificationLedger(),
        repositoryInventory: createRepositoryInventory(true),
        knownSecrets: [],
      }),
    ).rejects.toThrow(StatePublicSafetyError);

    expect(await adapter.resolveHead("tracker-state")).toEqual(lastGoodHead);
  });

  it.each([
    {
      kind: "owner/name",
      value: "VOICEVOX/r_private_sentinel",
    },
    {
      kind: "repository URL",
      value: "https://github.com/VOICEVOX/r_private_sentinel",
    },
  ])("private repositoryの$kindだけが付随データへ混入しても拒否する", async ({ value }) => {
    const adapter = new MemoryStateBranchAdapter();
    const snapshot = createSnapshot({
      runId: "run-private-metadata",
      generatedAt: "2026-07-31T00:00:00.000Z",
      repositoryIds: [publicRepositoryId],
      responsibility: {
        status: "new_untriaged",
        kind: "role",
        candidateId: "role:maintainer",
        role: "maintainer",
      },
      severity: "watch",
      edge: {
        status: "absent",
      },
    });
    const session = await StatePersistenceSession.open(adapter, stateConfiguration);
    await session.persist({
      snapshot,
      historyInputEvents: [],
      notificationLedger: createEmptyStateNotificationLedger(),
      repositoryInventory: createRepositoryInventory(true),
      knownSecrets: [],
    });
    const headBefore = await adapter.resolveHead("tracker-state");

    await expect(
      session.persistRunCompletion({
        snapshot,
        notificationLedger: createEmptyStateNotificationLedger(),
        runReport: createRunReport(snapshot, "2026-07-31", [value]),
        repositoryInventory: createRepositoryInventory(true),
        knownSecrets: [],
      }),
    ).rejects.toThrow(StatePublicSafetyError);
    expect(await adapter.resolveHead("tracker-state")).toEqual(headBefore);
  });

  it("secret patternを拒否し、エラーにもsecret値を含めない", async () => {
    const adapter = new MemoryStateBranchAdapter();
    const snapshot = createSnapshot({
      runId: "run-secret",
      generatedAt: "2026-07-31T00:00:00.000Z",
      repositoryIds: [publicRepositoryId],
      responsibility: {
        status: "new_untriaged",
        kind: "role",
        candidateId: "role:maintainer",
        role: "maintainer",
      },
      severity: "watch",
      edge: {
        status: "absent",
      },
    });
    const token = "github_pat_abcdefghijklmnopqrstuvwxyz0123456789";
    const session = await StatePersistenceSession.open(adapter, stateConfiguration);
    await session.persist({
      snapshot,
      historyInputEvents: [],
      notificationLedger: createEmptyStateNotificationLedger(),
      repositoryInventory: createRepositoryInventory(false),
      knownSecrets: [token],
    });
    const headBefore = await adapter.resolveHead("tracker-state");
    const error = await captureError(
      session.persistRunCompletion({
        snapshot,
        notificationLedger: createEmptyStateNotificationLedger(),
        runReport: createRunReport(snapshot, "2026-07-31", [`token=${token}`]),
        repositoryInventory: createRepositoryInventory(false),
        knownSecrets: [token],
      }),
    );

    expect(error).toBeInstanceOf(StatePublicSafetyError);
    expect(error.message).not.toContain(token);
    expect(await adapter.resolveHead("tracker-state")).toEqual(headBefore);
  });

  it("AI cache内の不要な本文全文フィールドを拒否する", async () => {
    const adapter = new MemoryStateBranchAdapter();
    const snapshot = createSnapshot({
      runId: "run-full-content",
      generatedAt: "2026-07-31T00:00:00.000Z",
      repositoryIds: [publicRepositoryId],
      responsibility: {
        status: "new_untriaged",
        kind: "role",
        candidateId: "role:maintainer",
        role: "maintainer",
      },
      severity: "watch",
      edge: {
        status: "absent",
      },
    });
    const session = await StatePersistenceSession.open(adapter, stateConfiguration);
    const inputHash = hashCanonicalJson({
      input: "full-content",
    });
    const cacheKey = createAiCacheKey({
      deterministicRulesVersion: "rules-v1",
      model: "codex-model",
      reasoningEffort: "medium",
      backendVersion: "codex-cli-1",
      promptVersion: "prompt-v1",
      schemaVersion: "schema-v1",
      inputHash,
    });
    const output = {
      body: "保存してはいけない本文です",
    };
    await session.aiCache.write(
      createAiCacheEntry({
        cacheKey,
        sourceHash: hashCanonicalJson({
          source: "fixture",
        }),
        metadata: {
          deterministicRulesVersion: "rules-v1",
          model: "codex-model",
          reasoningEffort: "medium",
          backendVersion: "codex-cli-1",
          promptVersion: "prompt-v1",
          schemaVersion: "schema-v1",
          inputHash,
          outputHash: hashCanonicalJson(output),
          executedAt: fixedItemAt,
        },
        output,
      }),
    );

    await expect(
      session.persist({
        snapshot,
        historyInputEvents: [],
        notificationLedger: createEmptyStateNotificationLedger(),
        repositoryInventory: createRepositoryInventory(false),
        knownSecrets: [],
      }),
    ).rejects.toThrow(StatePublicSafetyError);
    expect(await adapter.resolveHead("tracker-state")).toEqual({
      status: "missing",
    });
  });

  it("runnerを破棄してもAI cache hitと通知cooldownを読み戻す", async () => {
    const adapter = new MemoryStateBranchAdapter();
    const snapshot = createSnapshot({
      runId: "run-cache-ledger",
      generatedAt: "2026-07-31T00:00:00.000Z",
      repositoryIds: [publicRepositoryId],
      responsibility: {
        status: "new_untriaged",
        kind: "role",
        candidateId: "role:maintainer",
        role: "maintainer",
      },
      severity: "urgent",
      edge: {
        status: "absent",
      },
    });
    const cacheEntry = createCacheEntry();
    const cooldownUntil = "2026-08-03T00:00:00.000Z";
    const firstSession = await StatePersistenceSession.open(adapter, stateConfiguration);
    await firstSession.aiCache.write(cacheEntry);
    await firstSession.persist({
      snapshot,
      historyInputEvents: [],
      notificationLedger: createSentLedger(cooldownUntil),
      repositoryInventory: createRepositoryInventory(false),
      knownSecrets: [],
    });

    const restartedSession = await StatePersistenceSession.open(adapter, stateConfiguration);
    const cacheResult = await restartedSession.aiCache.read(cacheEntry.cacheKey);
    const ledger = await restartedSession.loadNotificationLedger();

    expect(cacheResult).toMatchObject({
      status: "hit",
      entry: {
        cacheKey: cacheEntry.cacheKey,
      },
    });
    expect(ledger.entries[0]?.cooldownUntil).toBe(cooldownUntil);
    expect(ledger.operationsAlerts).toEqual([
      {
        alertKey: "discord-operations-alert:v1:pages",
        incidentId: "pages-run-1",
        kind: "pages",
        occurredAt: fixedItemAt,
        sentAt: fixedItemAt,
        discordMessageId: "discord-operations-message-1",
      },
    ]);
  });

  it("任意の二日間について責務・edge・severity差分を再生する", async () => {
    const adapter = new MemoryStateBranchAdapter();
    const snapshots = [
      {
        date: "2026-07-31",
        snapshot: createSnapshot({
          runId: "run-history-1",
          generatedAt: "2026-07-31T00:00:00.000Z",
          repositoryIds: [publicRepositoryId],
          responsibility: {
            status: "new_untriaged",
            kind: "role",
            candidateId: "role:maintainer",
            role: "maintainer",
          },
          severity: "watch",
          edge: {
            status: "absent",
          },
        }),
      },
      {
        date: "2026-08-01",
        snapshot: createSnapshot({
          runId: "run-history-2",
          generatedAt: "2026-08-01T00:00:00.000Z",
          repositoryIds: [publicRepositoryId],
          responsibility: {
            status: "waiting_for_review",
            kind: "team",
            candidateId: "team:reviewers",
            role: "reviewer",
          },
          severity: "urgent",
          edge: {
            status: "active",
          },
        }),
      },
      {
        date: "2026-08-02",
        snapshot: createSnapshot({
          runId: "run-history-3",
          generatedAt: "2026-08-02T00:00:00.000Z",
          repositoryIds: [publicRepositoryId],
          responsibility: {
            status: "waiting_for_author",
            kind: "role",
            candidateId: "role:author",
            role: "author",
          },
          severity: "critical",
          edge: {
            status: "inactive",
          },
        }),
      },
    ] as const;
    for (const fixture of snapshots) {
      const session = await StatePersistenceSession.open(adapter, stateConfiguration);
      await session.persist({
        snapshot: fixture.snapshot,
        historyInputEvents: [],
        notificationLedger: createEmptyStateNotificationLedger(),
        repositoryInventory: createRepositoryInventory(false),
        knownSecrets: [],
      });
    }

    const replaySession = await StatePersistenceSession.open(adapter, stateConfiguration);
    const diff = await replaySession.diffHistory("2026-07-31", "2026-08-02");

    expect(diff.responsibilities).toHaveLength(1);
    expect(diff.responsibilities[0]).toMatchObject({
      id: itemNodeId,
      before: {
        status: "present",
        value: {
          waitingOn: [
            {
              candidateId: "role:maintainer",
            },
          ],
        },
      },
      after: {
        status: "present",
        value: {
          waitingOn: [
            {
              candidateId: "role:author",
            },
          ],
        },
      },
    });
    expect(diff.edges).toEqual([
      {
        id: "relation:blocker",
        before: {
          status: "absent",
        },
        after: {
          status: "present",
          value: {
            fromNodeId: "I_BLOCKER",
            toNodeId: itemNodeId,
            type: "blocks",
            provenance: "native",
            confidence: 1,
            evidence: [
              {
                sourceId: "fixture:relation",
                supports: "relation",
                summary: "native dependency",
              },
            ],
            contradictions: [],
            firstSeenAt: "2026-07-30T23:30:00.000Z",
            lastConfirmedAt: "2026-07-30T23:30:00.000Z",
            active: false,
            removedAt: "2026-07-30T23:30:00.000Z",
          },
        },
      },
    ]);
    expect(diff.severities).toEqual([
      {
        id: itemNodeId,
        before: {
          status: "present",
          value: "watch",
        },
        after: {
          status: "present",
          value: "critical",
        },
      },
    ]);
  });
});

describe("Git state branch adapter", { timeout: gitTestTimeoutMilliseconds }, () => {
  it("mainを変えず、初回orphan tracker-stateと後続commitを作成する", async () => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), "voicevox-state-git-test-"));
    try {
      await execFileAsync("git", ["init", "--quiet", "--initial-branch=main", temporaryDirectory]);
      await execFileAsync("git", ["-C", temporaryDirectory, "config", "user.name", "fixture"]);
      await execFileAsync("git", [
        "-C",
        temporaryDirectory,
        "config",
        "user.email",
        "fixture@example.com",
      ]);
      await execFileAsync("git", ["-C", temporaryDirectory, "config", "commit.gpgsign", "false"]);
      await writeFile(join(temporaryDirectory, "README.md"), "main branch\n", "utf8");
      await execFileAsync("git", ["-C", temporaryDirectory, "add", "README.md"]);
      await execFileAsync("git", ["-C", temporaryDirectory, "commit", "--quiet", "-m", "initial"]);
      const mainBefore = await readGitOutput(temporaryDirectory, ["rev-parse", "refs/heads/main"]);
      const adapter = new GitStateBranchAdapter({
        repositoryPath: temporaryDirectory,
        gitExecutable: "git",
        authorName: "VOICEVOX Task Tracker",
        authorEmail: "voicevox-task-tracker@example.com",
      });
      const firstSnapshot = createSnapshot({
        runId: "run-git-bootstrap",
        generatedAt: "2026-07-31T00:00:00.000Z",
        repositoryIds: [publicRepositoryId],
        responsibility: {
          status: "new_untriaged",
          kind: "role",
          candidateId: "role:maintainer",
          role: "maintainer",
        },
        severity: "watch",
        edge: {
          status: "absent",
        },
      });
      const firstSession = await StatePersistenceSession.open(adapter, stateConfiguration);
      const first = await firstSession.persist({
        snapshot: firstSnapshot,
        historyInputEvents: [],
        notificationLedger: createEmptyStateNotificationLedger(),
        repositoryInventory: createRepositoryInventory(false),
        knownSecrets: [],
      });
      const firstParents = await readGitOutput(temporaryDirectory, [
        "rev-list",
        "--parents",
        "-n",
        "1",
        first.revision,
      ]);

      const secondSnapshot = createSnapshot({
        runId: "run-git-next",
        generatedAt: "2026-08-01T00:00:00.000Z",
        repositoryIds: [publicRepositoryId],
        responsibility: {
          status: "waiting_for_review",
          kind: "team",
          candidateId: "team:reviewers",
          role: "reviewer",
        },
        severity: "urgent",
        edge: {
          status: "active",
        },
      });
      const secondSession = await StatePersistenceSession.open(adapter, stateConfiguration);
      const second = await secondSession.persist({
        snapshot: secondSnapshot,
        historyInputEvents: [],
        notificationLedger: createEmptyStateNotificationLedger(),
        repositoryInventory: createRepositoryInventory(false),
        knownSecrets: [],
      });
      const mainAfter = await readGitOutput(temporaryDirectory, ["rev-parse", "refs/heads/main"]);
      const mainSnapshotExists = await execFileAsync(
        "git",
        ["-C", temporaryDirectory, "cat-file", "-e", "main:state/snapshot.json"],
        {
          encoding: "utf8",
        },
      ).then(
        () => true,
        () => false,
      );
      const trackerSnapshot = await readGitOutput(temporaryDirectory, [
        "show",
        "tracker-state:state/snapshot.json",
      ]);

      expect(first.branchCreated).toBe(true);
      expect(firstParents.split(" ")).toEqual([first.revision]);
      expect(second.branchCreated).toBe(false);
      expect(mainAfter).toBe(mainBefore);
      expect(mainSnapshotExists).toBe(false);
      expect(JSON.parse(trackerSnapshot)).toMatchObject({
        run: {
          id: "run-git-next",
        },
      });
    } finally {
      await rm(temporaryDirectory, {
        recursive: true,
        force: true,
      });
    }
  });
});
