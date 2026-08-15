import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import { hashCanonicalJson } from "../src/codex/index.js";
import {
  type StalenessWaitClass,
  type Status,
  type WaitingOnKind,
  type WaitingOnRole,
} from "../src/domain/index.js";
import {
  GitStateBranchAdapter,
  StateFormatError,
  StateSnapshotSchemaError,
  StateZodValidationError,
  createStateSnapshot,
  parseStateSnapshot,
  serializeCanonicalJson,
  serializeStateSnapshot,
  type StateSnapshot,
} from "../src/persistence/index.js";
import { assertNonNullable } from "../src/util/index.js";

const execFileAsync = promisify(execFile);
const gitTestTimeoutMilliseconds = 15_000;
const fixedTrackingStartAt = "2026-07-30T23:00:00.000Z";
const fixedItemAt = "2026-07-30T23:30:00.000Z";
const publicRepositoryId = "R_PUBLIC";
const itemNodeId = "I_TRACKED";

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
    schemaVersion: "8",
    generatedAt: options.generatedAt,
    trackingStartAt: {
      status: "fixed",
      value: fixedTrackingStartAt,
      source: "configuration",
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
        attention: {
          score: 25,
          level: "medium",
        },
        importanceAssessment: {
          status: "not_available",
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
          status: "disabled",
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
  it("返答待ちの回答者をsnapshotへ保存して読み戻す", () => {
    const snapshot = createSnapshot({
      runId: "run-waiting-for-reply",
      generatedAt: "2026-08-01T00:00:00.000Z",
      repositoryIds: [publicRepositoryId],
      responsibility: {
        status: "waiting_for_reply",
        kind: "user",
        candidateId: "requested-user",
        role: "respondent",
      },
      severity: "watch",
      edge: {
        status: "absent",
      },
    });

    const parsed = parseStateSnapshot(serializeStateSnapshot(snapshot));

    expect(parsed.items[0]).toMatchObject({
      status: "waiting_for_reply",
      waitingOn: [
        {
          kind: "user",
          candidateId: "requested-user",
          role: "respondent",
        },
      ],
      severityContext: {
        waitClass: "reply",
      },
      attention: {
        score: 25,
        level: "medium",
      },
    });
  });

  it("version 1のsnapshotを登録済みparserで読み取り現行形式へmigrationする", () => {
    const snapshot = createSnapshot({
      runId: "run-schema-version-1",
      generatedAt: "2026-08-01T00:00:00.000Z",
      repositoryIds: [publicRepositoryId, "R_SECOND"],
      responsibility: {
        status: "waiting_for_assessment",
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
      items: snapshot.items.map((item) => ({
        ...item,
        status: "new_untriaged",
        severityContext: {
          ...item.severityContext,
          waitClass: "maintainerTriage",
        },
        aiAnalysis: {
          status: "not_used",
        },
      })),
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

    expect(migrated.schemaVersion).toBe("8");
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
    expect(migrated.items[0]?.attention).toEqual({
      score: 0,
      level: "low",
    });
    expect(migrated.items[0]?.aiAnalysis).toEqual({
      status: "not_recorded",
    });
    expect(migrated.items[0]).toMatchObject({
      status: "waiting_for_assessment",
      severityContext: {
        waitClass: "assessment",
      },
    });
  });

  it("version 2のsnapshotへ決定規則version未取得を設定して現行形式へmigrationする", () => {
    const snapshot = createSnapshot({
      runId: "run-schema-version-2",
      generatedAt: "2026-08-01T00:00:00.000Z",
      repositoryIds: [publicRepositoryId],
      responsibility: {
        status: "waiting_for_assessment",
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
      items: snapshot.items.map((item) => ({
        ...item,
        status: "new_untriaged",
        severityContext: {
          ...item.severityContext,
          waitClass: "maintainerTriage",
        },
        aiAnalysis: {
          status: "not_used",
        },
      })),
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

    expect(migrated.schemaVersion).toBe("8");
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
        status: "waiting_for_assessment",
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
      items: [
        {
          ...version3Item,
          status: "new_untriaged",
          severityContext: {
            ...version3Item.severityContext,
            waitClass: "maintainerTriage",
          },
          aiAnalysis: {
            status: "not_used",
          },
        },
      ],
    });

    const migrated = parseStateSnapshot(source);

    expect(migrated.schemaVersion).toBe("8");
    expect(migrated.items[0]?.milestone).toBeNull();
    expect(migrated.items[0]?.importance).toEqual({
      score: 0,
      level: "low",
      factors: [],
    });
  });

  it("version 4のsnapshotへimportance未計算値と重要度判定なしを追加して現行形式へmigrationする", () => {
    const snapshot = createSnapshot({
      runId: "run-schema-version-4",
      generatedAt: "2026-08-01T00:00:00.000Z",
      repositoryIds: [publicRepositoryId],
      responsibility: {
        status: "waiting_for_assessment",
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
    const { importance, importanceAssessment, ...version4Item } = item;
    expect(importance.score).toBe(25);
    expect(importanceAssessment).toEqual({
      status: "not_available",
    });
    const source = serializeCanonicalJson({
      ...snapshot,
      schemaVersion: "4",
      items: [
        {
          ...version4Item,
          status: "new_untriaged",
          severityContext: {
            ...version4Item.severityContext,
            waitClass: "maintainerTriage",
          },
          aiAnalysis: {
            status: "not_used",
          },
        },
      ],
    });

    const migrated = parseStateSnapshot(source);

    expect(migrated.schemaVersion).toBe("8");
    expect(migrated.items[0]?.importance).toEqual({
      score: 0,
      level: "low",
      factors: [],
    });
    expect(migrated.items[0]?.importanceAssessment).toEqual({
      status: "not_available",
    });
  });

  it("version 5のAI利用状況を記録有無が分かる現行形式へmigrationする", () => {
    const snapshot = createSnapshot({
      runId: "run-schema-version-5",
      generatedAt: "2026-08-01T00:00:00.000Z",
      repositoryIds: [publicRepositoryId],
      responsibility: {
        status: "waiting_for_assessment",
        kind: "role",
        candidateId: "role:maintainer",
        role: "maintainer",
      },
      severity: "watch",
      edge: {
        status: "absent",
      },
    });
    const cacheKey = hashCanonicalJson({ cache: itemNodeId });
    const notUsedSource = serializeCanonicalJson({
      ...snapshot,
      schemaVersion: "5",
      items: snapshot.items.map((item) => ({
        ...item,
        status: "new_untriaged",
        severityContext: {
          ...item.severityContext,
          waitClass: "maintainerTriage",
        },
        aiAnalysis: {
          status: "not_used",
        },
      })),
    });
    const usedSource = serializeCanonicalJson({
      ...snapshot,
      schemaVersion: "5",
      items: snapshot.items.map((item) => ({
        ...item,
        status: "new_untriaged",
        severityContext: {
          ...item.severityContext,
          waitClass: "maintainerTriage",
        },
        aiAnalysis: {
          status: "used",
          cacheKey,
        },
      })),
    });

    const migratedNotUsed = parseStateSnapshot(notUsedSource);
    const migratedUsed = parseStateSnapshot(usedSource);

    expect(migratedNotUsed.schemaVersion).toBe("8");
    expect(migratedNotUsed.items[0]?.aiAnalysis).toEqual({
      status: "not_recorded",
    });
    expect(migratedUsed.items[0]?.aiAnalysis).toEqual({
      status: "used",
      cacheKey,
    });
  });

  it("version 7のsnapshotへattention未計算値を追加して現行形式へmigrationする", () => {
    const snapshot = createSnapshot({
      runId: "run-schema-version-7",
      generatedAt: "2026-08-01T00:00:00.000Z",
      repositoryIds: [publicRepositoryId],
      responsibility: {
        status: "waiting_for_assessment",
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
    assertNonNullable(item, "version 7のitem fixtureがありません");
    const { attention, ...version7Item } = item;
    expect(attention).toEqual({
      score: 25,
      level: "medium",
    });
    const source = serializeCanonicalJson({
      ...snapshot,
      schemaVersion: "7",
      items: [version7Item],
    });

    const migrated = parseStateSnapshot(source);

    expect(migrated.schemaVersion).toBe("8");
    expect(migrated.items[0]?.attention).toEqual({
      score: 0,
      level: "low",
    });
  });

  it("version 6の旧列挙値をversion 7経由で現行形式へmigrationする", () => {
    const snapshot = createSnapshot({
      runId: "run-schema-version-6",
      generatedAt: "2026-08-01T00:00:00.000Z",
      repositoryIds: [publicRepositoryId],
      responsibility: {
        status: "waiting_for_assessment",
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
    assertNonNullable(item, "version 6のitem fixtureがありません");
    const { attention, ...version6Item } = item;
    expect(attention).toEqual({
      score: 25,
      level: "medium",
    });
    const fixtures = [
      {
        legacyStatus: "new_untriaged",
        legacyWaitClass: "maintainerTriage",
        status: "waiting_for_assessment",
        waitClass: "assessment",
      },
      {
        legacyStatus: "needs_maintainer_decision",
        legacyWaitClass: "decision",
        status: "waiting_for_decision",
        waitClass: "decision",
      },
      {
        legacyStatus: "waiting_for_author",
        legacyWaitClass: "authorAfterChangesRequested",
        status: "waiting_for_revision",
        waitClass: "revision",
      },
      {
        legacyStatus: "waiting_for_assignee",
        legacyWaitClass: "assigneeOrInProgress",
        status: "waiting_for_work",
        waitClass: "work",
      },
      {
        legacyStatus: "blocked",
        legacyWaitClass: "blockedParent",
        status: "waiting_for_unblock",
        waitClass: "blockedParent",
      },
      {
        legacyStatus: "ready_to_merge",
        legacyWaitClass: "readyToMerge",
        status: "waiting_for_merge",
        waitClass: "merge",
      },
      {
        legacyStatus: "waiting_for_owner",
        legacyWaitClass: "ownerUnknown",
        status: "waiting_for_owner",
        waitClass: "owner",
      },
      {
        legacyStatus: "waiting_for_review",
        legacyWaitClass: "reviewer",
        status: "waiting_for_review",
        waitClass: "review",
      },
    ] satisfies readonly Readonly<{
      legacyStatus: string;
      legacyWaitClass: string;
      status: Status;
      waitClass: StalenessWaitClass;
    }>[];

    for (const fixture of fixtures) {
      const source = serializeCanonicalJson({
        ...snapshot,
        schemaVersion: "6",
        items: [
          {
            ...version6Item,
            status: fixture.legacyStatus,
            severityContext: {
              ...version6Item.severityContext,
              waitClass: fixture.legacyWaitClass,
            },
          },
        ],
      });

      const migrated = parseStateSnapshot(source);

      expect(migrated.schemaVersion).toBe("8");
      expect(migrated.items[0]).toMatchObject({
        attention: {
          score: 0,
          level: "low",
        },
        status: fixture.status,
        severityContext: {
          waitClass: fixture.waitClass,
        },
      });
    }
  });

  it("version 6の未知の旧列挙値を拒否する", () => {
    const snapshot = createSnapshot({
      runId: "run-schema-version-6-unknown-enum",
      generatedAt: "2026-08-01T00:00:00.000Z",
      repositoryIds: [publicRepositoryId],
      responsibility: {
        status: "waiting_for_assessment",
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
    assertNonNullable(item, "version 6のitem fixtureがありません");
    const legacyItem = {
      ...item,
      status: "new_untriaged",
      severityContext: {
        ...item.severityContext,
        waitClass: "maintainerTriage",
      },
    };

    expect(() =>
      parseStateSnapshot(
        serializeCanonicalJson({
          ...snapshot,
          schemaVersion: "6",
          items: [
            {
              ...legacyItem,
              status: "unexpected_status",
            },
          ],
        }),
      ),
    ).toThrow(StateSnapshotSchemaError);
    expect(() =>
      parseStateSnapshot(
        serializeCanonicalJson({
          ...snapshot,
          schemaVersion: "6",
          items: [
            {
              ...legacyItem,
              severityContext: {
                ...legacyItem.severityContext,
                waitClass: "unexpected_wait_class",
              },
            },
          ],
        }),
      ),
    ).toThrow(StateSnapshotSchemaError);
  });

  it("未知のsnapshot schema versionを拒否する", () => {
    const snapshot = createSnapshot({
      runId: "run-unknown-schema-version",
      generatedAt: "2026-08-01T00:00:00.000Z",
      repositoryIds: [publicRepositoryId],
      responsibility: {
        status: "waiting_for_assessment",
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
});

describe("state canonical JSON", () => {
  it("キーと集合配列の入力順に依存せず同じbyte列を生成する", () => {
    const left = createSnapshot({
      runId: "run-canonical",
      generatedAt: "2026-07-31T00:00:00.000Z",
      repositoryIds: ["R_SECOND", publicRepositoryId],
      responsibility: {
        status: "waiting_for_assessment",
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
        status: "waiting_for_assessment",
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
        status: "waiting_for_assessment",
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
        status: "waiting_for_assessment",
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
        status: "waiting_for_assessment",
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

describe("Git state branch adapter", { timeout: gitTestTimeoutMilliseconds }, () => {
  it("明示的なdeletionsで既存stateファイルをGit indexから削除する", async () => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), "voicevox-state-git-delete-test-"));
    try {
      await execFileAsync("git", ["init", "--quiet", "--initial-branch=main", temporaryDirectory]);
      const adapter = new GitStateBranchAdapter({
        repositoryPath: temporaryDirectory,
        gitExecutable: "git",
        authorName: "VOICEVOX Task Tracker",
        authorEmail: "voicevox-task-tracker@example.com",
      });
      const first = await adapter.commit({
        branch: "tracker-state-v3",
        expectedHead: {
          status: "missing",
        },
        updates: [
          {
            path: "state/remove.json",
            bytes: new TextEncoder().encode("remove\n"),
          },
          {
            path: "state/keep.json",
            bytes: new TextEncoder().encode("keep\n"),
          },
        ],
        deletions: [],
        message: "create deletion fixture",
        committedAt: "2026-08-01T00:00:00.000Z",
      });
      const second = await adapter.commit({
        branch: "tracker-state-v3",
        expectedHead: {
          status: "present",
          revision: first.revision,
        },
        updates: [
          {
            path: "state/keep.json",
            bytes: new TextEncoder().encode("keep-next\n"),
          },
        ],
        deletions: ["state/remove.json"],
        message: "delete state fixture",
        committedAt: "2026-08-02T00:00:00.000Z",
      });

      const removed = await adapter.readFile(second.revision, "state/remove.json");
      const kept = await adapter.readFile(second.revision, "state/keep.json");
      const paths = await adapter.listFiles(second.revision, "state");

      expect(removed).toEqual({ status: "missing" });
      expect(kept.status).toBe("present");
      expect(paths).toEqual(["state/keep.json"]);
    } finally {
      await rm(temporaryDirectory, {
        recursive: true,
        force: true,
      });
    }
  });

  it("mainを変えず、初回orphan tracker-state-v3と後続commitを作成する", async () => {
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
          status: "waiting_for_assessment",
          kind: "role",
          candidateId: "role:maintainer",
          role: "maintainer",
        },
        severity: "watch",
        edge: {
          status: "absent",
        },
      });
      const first = await adapter.commit({
        branch: "tracker-state-v3",
        expectedHead: { status: "missing" },
        updates: [
          {
            path: "state/snapshot.json",
            bytes: new TextEncoder().encode(serializeStateSnapshot(firstSnapshot)),
          },
        ],
        deletions: [],
        message: "create tracker state",
        committedAt: firstSnapshot.generatedAt,
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
      const second = await adapter.commit({
        branch: "tracker-state-v3",
        expectedHead: { status: "present", revision: first.revision },
        updates: [
          {
            path: "state/snapshot.json",
            bytes: new TextEncoder().encode(serializeStateSnapshot(secondSnapshot)),
          },
        ],
        deletions: [],
        message: "update tracker state",
        committedAt: secondSnapshot.generatedAt,
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
        "tracker-state-v3:state/snapshot.json",
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
