import { readFile } from "node:fs/promises";

import { describe, expect, it, vi } from "vitest";

import {
  CodexNonZeroExitError,
  CodexOutputSchemaValidationError,
  CodexOutputSemanticValidationError,
  CodexRateLimitError,
  CodexTimeoutError,
  classifyCodexConfidence,
  createCodexAnalysisInput,
  executeValidatedCodexAnalysis,
  reduceCodexAnalysis,
  runCodexAnalysisWithFallback,
  validateCodexAnalysisOutput,
  validateCodexAnalysisSchema,
  type CodexAnalysisAttempt,
  type CodexAnalysisInput,
  type CodexUnavailableReason,
  type DeterministicCodexDecision,
} from "../src/codex/index.js";
import {
  buildSourceId,
  createGitHubNodeId,
  createUtcIsoDateTime,
  type GitHubItemUrl,
  type SourceId,
} from "../src/domain/index.js";
import {
  buildRelationCandidateId,
  reconcileGraph,
  type CandidateBlocksRelation,
  type NativeRelationCandidate,
  type OrganizationRelationCandidateNode,
} from "../src/graph/index.js";

const defaultConfidenceThresholds = Object.freeze({
  high: 0.85,
  medium: 0.65,
});

class HttpFixtureError extends Error {
  public readonly status: number;

  public constructor(status: number) {
    super(`HTTP fixture error ${status.toString()}`);
    this.name = "HttpFixtureError";
    this.status = status;
  }
}

function parseJson(source: string): unknown {
  const parser: (value: string) => unknown = JSON.parse;
  return parser(source);
}

function createSourceIds(sourceId: SourceId): readonly [SourceId, ...SourceId[]] {
  return Object.freeze([sourceId]);
}

function createInput(): CodexAnalysisInput {
  return createCodexAnalysisInput({
    schemaVersion: "1",
    now: "2026-07-30T23:00:00Z",
    item: {
      nodeId: "I_example",
      url: "https://github.com/VOICEVOX/example/issues/1",
      type: "issue",
      title: "方針を決める",
      authorCandidateId: "user:author",
    },
    candidates: {
      waitingOn: [
        {
          id: "role:maintainer",
        },
        {
          id: "item:blocker",
        },
      ],
      relations: [
        {
          id: "rel:dependency",
          targetUrl: "https://github.com/VOICEVOX/dependency/issues/2",
        },
      ],
    },
    sources: [
      {
        id: "body:current",
        kind: "body",
        actorType: "human",
        createdAt: "2026-07-20T00:00:00Z",
        text: "方針を決める必要がある",
      },
      {
        id: "native:dependency",
        kind: "native_dependency",
        actorType: "system",
        createdAt: "2026-07-21T00:00:00Z",
        targetState: "open",
      },
    ],
    deterministicSignals: {},
    priorAnalysis: null,
  });
}

function createOutput(confidence: number) {
  return {
    schemaVersion: "2",
    item: {
      nodeId: "I_example",
      url: "https://github.com/VOICEVOX/example/issues/1",
    },
    status: "waiting_for_decision",
    waitingOn: [
      {
        kind: "role",
        candidateId: "role:maintainer",
        role: "maintainer",
        reasonSummary: "maintainerの判断待ちです",
        sourceIds: ["body:current"],
        confidence: 1,
      },
    ],
    nextAction: "maintainerが方針を決める",
    relations: [
      {
        candidateId: "rel:dependency",
        verdict: "related",
        reasonSummary: "関連するIssueです",
        sourceIds: ["body:current"],
        confidence: 0.9,
      },
    ],
    progress: {
      latestMeaningfulSourceId: "body:current",
      reasonSummary: "本文作成が最新の進捗です",
      confidence: 0.9,
    },
    importance: {
      significantFeature: true,
      explicitDeadline: false,
      futureRisk: false,
      rationale: "主要機能に関わる変更です",
    },
    evidence: [
      {
        sourceId: "body:current",
        supports: "status",
        summary: "方針判断が必要です",
      },
    ],
    confidence,
    uncertainties: [],
    notification: {
      recommended: true,
      reasonCode: "assessment_overdue",
      reasonSummary: "内容確認が必要です",
    },
  };
}

function createDeterministicDecision(
  determination: DeterministicCodexDecision["determination"],
): DeterministicCodexDecision {
  const sourceId = buildSourceId("body", "current");
  return Object.freeze({
    determination,
    status: "waiting_for_decision",
    waitingOn: Object.freeze([
      Object.freeze({
        kind: "role",
        candidateId: "role:maintainer",
        role: "maintainer",
        reasonSummary: "決定論的にはmaintainerの判断待ちです",
        sourceIds: createSourceIds(sourceId),
        confidence: 0.8,
      }),
    ]),
    nextAction: "maintainerが確認する",
    confidence: 0.8,
    evidence: Object.freeze([
      Object.freeze({
        sourceId,
        supports: "status",
        summary: "未アサインIssueです",
      }),
    ]),
    uncertainties: Object.freeze(["自然言語の意図を確定できません"]),
  });
}

function createValidatedAttempt(
  input: CodexAnalysisInput,
  confidence: number,
): CodexAnalysisAttempt {
  return Object.freeze({
    status: "validated",
    output: validateCodexAnalysisOutput(createOutput(confidence), input),
  });
}

describe("Codex出力のJSON Schema検証", () => {
  it("非object、余分なプロパティ、enum外の値をschema段階で拒否する", () => {
    expect(() => validateCodexAnalysisSchema("JSON objectではない")).toThrow(
      CodexOutputSchemaValidationError,
    );
    expect(() =>
      validateCodexAnalysisSchema({
        ...createOutput(0.9),
        githubWrite: {
          operation: "close_issue",
        },
      }),
    ).toThrow(CodexOutputSchemaValidationError);
    expect(() =>
      validateCodexAnalysisSchema({
        ...createOutput(0.9),
        status: "schemaを無視した値",
      }),
    ).toThrow(CodexOutputSchemaValidationError);
  });

  it("importanceのrationaleを120文字以内に制限する", () => {
    expect(() =>
      validateCodexAnalysisSchema({
        ...createOutput(0.9),
        importance: {
          ...createOutput(0.9).importance,
          rationale: "あ".repeat(120),
        },
      }),
    ).not.toThrow();
    expect(() =>
      validateCodexAnalysisSchema({
        ...createOutput(0.9),
        importance: {
          ...createOutput(0.9).importance,
          rationale: "あ".repeat(121),
        },
      }),
    ).toThrow(CodexOutputSchemaValidationError);
  });

  it("要件定義のCodex出力例と同じfixtureを二段階検証できる", async () => {
    const inputSource = await readFile(
      new URL("./fixtures/codex-input.example.json", import.meta.url),
      "utf8",
    );
    const outputSource = await readFile(
      new URL("./fixtures/codex-output.example.json", import.meta.url),
      "utf8",
    );
    const input = createCodexAnalysisInput(parseJson(inputSource));

    const output = validateCodexAnalysisOutput(parseJson(outputSource), input);

    expect(output.item.nodeId).toBe("PR_example");
    expect(output.relations).toHaveLength(1);
    expect(output.relations[0]?.verdict).toBe("current_is_blocked_by_target");
    expect(output.importance.significantFeature).toBe(true);
  });
});

describe("Codex出力のsemantic検証", () => {
  it("候補集合の外にあるwaitingOnとrelationをsemantic段階で拒否する", () => {
    const input = createInput();
    const output = createOutput(0.9);
    const errorAction = () =>
      validateCodexAnalysisOutput(
        {
          ...output,
          waitingOn: [
            {
              ...output.waitingOn[0],
              candidateId: "user:unknown",
              kind: "user",
            },
          ],
          relations: [
            {
              ...output.relations[0],
              candidateId: "rel:unknown",
            },
          ],
        },
        input,
      );

    expect(errorAction).toThrow(CodexOutputSemanticValidationError);
    try {
      errorAction();
    } catch (error: unknown) {
      if (!(error instanceof CodexOutputSemanticValidationError)) {
        throw error;
      }
      expect(error.stage).toBe("semantic");
      expect(error.issues.map((issue) => issue.code)).toEqual(
        expect.arrayContaining([
          "unknown_waiting_on_candidate",
          "unknown_relation_candidate",
          "missing_relation_verdict",
        ]),
      );
    }
  });

  it("存在しないsource IDを全ての根拠参照箇所で拒否する", () => {
    const input = createInput();
    const output = createOutput(0.9);
    const errorAction = () =>
      validateCodexAnalysisOutput(
        {
          ...output,
          evidence: [
            {
              ...output.evidence[0],
              sourceId: "comment:not-found",
            },
          ],
        },
        input,
      );

    expect(errorAction).toThrow(CodexOutputSemanticValidationError);
    try {
      errorAction();
    } catch (error: unknown) {
      if (!(error instanceof CodexOutputSemanticValidationError)) {
        throw error;
      }
      expect(error.issues).toContainEqual({
        path: "/evidence/0/sourceId",
        code: "unknown_source_id",
        message: "入力に存在しないsource IDを参照しています",
      });
    }
  });

  it("waitingOnとrelationのsource ID重複をsemantic段階で拒否する", () => {
    const input = createInput();
    const output = createOutput(0.9);
    const errorAction = () =>
      validateCodexAnalysisOutput(
        {
          ...output,
          waitingOn: [
            {
              ...output.waitingOn[0],
              sourceIds: ["body:current", "body:current"],
            },
          ],
          relations: [
            {
              ...output.relations[0],
              sourceIds: ["body:current", "body:current"],
            },
          ],
        },
        input,
      );

    expect(errorAction).toThrow(CodexOutputSemanticValidationError);
    try {
      errorAction();
    } catch (error: unknown) {
      if (!(error instanceof CodexOutputSemanticValidationError)) {
        throw error;
      }
      expect(error.issues).toEqual(
        expect.arrayContaining([
          {
            path: "/waitingOn/0/sourceIds/1",
            code: "duplicate_source_id",
            message: "source IDが重複しています",
          },
          {
            path: "/relations/0/sourceIds/1",
            code: "duplicate_source_id",
            message: "source IDが重複しています",
          },
        ]),
      );
    }
  });

  it("参照sourceの未来時刻と対象外URLを拒否する", () => {
    const originalInput = createInput();
    const input = createCodexAnalysisInput({
      ...originalInput,
      now: "2026-07-19T23:00:00Z",
    });
    const output = createOutput(0.9);

    expect(() =>
      validateCodexAnalysisOutput(
        {
          ...output,
          nextAction: "https://example.com/write へ送信する",
        },
        input,
      ),
    ).toThrow(CodexOutputSemanticValidationError);
  });

  it("全relation候補にverdictがちょうど1件ずつあることを要求する", () => {
    const input = createInput();
    const output = createOutput(0.9);

    expect(() =>
      validateCodexAnalysisOutput(
        {
          ...output,
          relations: [],
        },
        input,
      ),
    ).toThrow(CodexOutputSemanticValidationError);
    expect(() =>
      validateCodexAnalysisOutput(
        {
          ...output,
          relations: [output.relations[0], output.relations[0]],
        },
        input,
      ),
    ).toThrow(CodexOutputSemanticValidationError);
  });
});

describe("Codex出力検証失敗の診断要約", () => {
  it("schema検証とsemantic検証の違反件数と先頭のpathとcodeを返す", async () => {
    const input = createInput();
    const output = createOutput(0.9);

    const schemaAttempt = await executeValidatedCodexAnalysis(input, () =>
      Promise.resolve({
        ...output,
        extra: true,
      }),
    );
    const semanticAttempt = await executeValidatedCodexAnalysis(input, () =>
      Promise.resolve({
        ...output,
        item: {
          ...output.item,
          nodeId: "I_other",
        },
        evidence: [
          {
            ...output.evidence[0],
            sourceId: "comment:not-found",
          },
        ],
      }),
    );

    expect(schemaAttempt).toEqual({
      status: "unavailable",
      reason: "schema_validation_failed",
      errorType: "CodexOutputSchemaValidationError",
      validationDiagnostic: {
        issueCount: 1,
        issues: [
          {
            path: "$",
            code: "additionalProperties",
          },
        ],
      },
    });
    expect(semanticAttempt).toEqual({
      status: "unavailable",
      reason: "semantic_validation_failed",
      errorType: "CodexOutputSemanticValidationError",
      validationDiagnostic: {
        issueCount: 2,
        issues: [
          {
            path: "/item/nodeId",
            code: "item_node_id_mismatch",
          },
          {
            path: "/evidence/0/sourceId",
            code: "unknown_source_id",
          },
        ],
      },
    });
  });

  it("先頭5件に制限しpathとcodeだけを要約へ含める", async () => {
    const pathCanary = "/futureSchemaField";
    const messageCanary = "INPUT_DERIVED_MESSAGE_CANARY";
    const attempt = await executeValidatedCodexAnalysis(createInput(), () =>
      Promise.reject(
        new CodexOutputSemanticValidationError([
          {
            path: pathCanary,
            code: "future_schema_field_rule",
            message: messageCanary,
          },
          ...Array.from({ length: 5 }, (_, index) => ({
            path: `/evidence/${index.toString()}/sourceId`,
            code: `fixture_rule_${index.toString()}`,
            message: messageCanary,
          })),
        ]),
      ),
    );

    expect(attempt).toMatchObject({
      status: "unavailable",
      validationDiagnostic: {
        issueCount: 6,
        issues: [
          {
            path: pathCanary,
            code: "future_schema_field_rule",
          },
          {
            path: "/evidence/0/sourceId",
            code: "fixture_rule_0",
          },
          {
            path: "/evidence/1/sourceId",
            code: "fixture_rule_1",
          },
          {
            path: "/evidence/2/sourceId",
            code: "fixture_rule_2",
          },
          {
            path: "/evidence/3/sourceId",
            code: "fixture_rule_3",
          },
        ],
      },
    });
    if (attempt.status !== "unavailable") {
      throw new TypeError("検証失敗がfallback結果になりませんでした");
    }
    expect(attempt.validationDiagnostic?.issues).toHaveLength(5);
    const serializedAttempt = JSON.stringify(attempt);
    expect(serializedAttempt).toContain(pathCanary);
    expect(serializedAttempt).not.toContain(messageCanary);
  });
});

describe("confidence境界とreducer統合", () => {
  it("0.85をhigh、0.65をmedium、その未満をlowとして表示と通知を変える", () => {
    const input = createInput();
    const deterministic = createDeterministicDecision("codex_candidate");
    const high = reduceCodexAnalysis(
      input,
      deterministic,
      createValidatedAttempt(input, 0.85),
      defaultConfidenceThresholds,
    );
    const medium = reduceCodexAnalysis(
      input,
      deterministic,
      createValidatedAttempt(input, 0.65),
      defaultConfidenceThresholds,
    );
    const low = reduceCodexAnalysis(
      input,
      deterministic,
      createValidatedAttempt(input, 0.649_999),
      defaultConfidenceThresholds,
    );

    expect(high).toMatchObject({
      displayMode: "confirmed",
      decision: {
        origin: "codex",
      },
      ai: {
        confidenceLevel: "high",
        application: "applied",
      },
      notification: {
        recommended: true,
        policy: "eligible",
        highPriorityEligible: true,
      },
    });
    expect(medium).toMatchObject({
      displayMode: "estimated",
      decision: {
        origin: "codex",
      },
      ai: {
        confidenceLevel: "medium",
        application: "applied",
      },
      notification: {
        recommended: true,
        policy: "normal_priority_only",
        highPriorityEligible: false,
      },
    });
    expect(low).toMatchObject({
      displayMode: "fallback",
      decision: {
        origin: "deterministic",
      },
      ai: {
        confidenceLevel: "low",
        application: "low_confidence_fallback",
      },
      notification: {
        recommended: false,
        policy: "suppressed",
        highPriorityEligible: false,
      },
    });
    expect(low.relationAssessments[0]?.confidence).toBe(0.649_999);
    expect(high.importanceAssessment).toMatchObject({
      status: "available",
      value: {
        significantFeature: true,
      },
    });
    expect(medium.importanceAssessment.status).toBe("available");
    expect(low.importanceAssessment).toEqual({
      status: "not_available",
    });
  });

  it("既定値ではなく渡したconfidence設定値を使う", () => {
    expect(
      classifyCodexConfidence(0.85, {
        high: 0.9,
        medium: 0.7,
      }),
    ).toMatchObject({
      level: "medium",
      displayMode: "estimated",
    });
  });

  it("決定論的に確定した状態をCodex出力で上書きしない", () => {
    const input = createInput();
    const result = reduceCodexAnalysis(
      input,
      createDeterministicDecision("determined"),
      createValidatedAttempt(input, 0.99),
      defaultConfidenceThresholds,
    );

    expect(result.decision.origin).toBe("deterministic");
    expect(result.ai).toMatchObject({
      application: "deterministic_preserved",
    });
    expect(result.relationCoverage).toEqual({
      status: "complete",
    });
    expect(result.relationAssessments).toHaveLength(input.candidates.relations.length);
  });

  it("native relationに反するCodex判定を変更として適用しない", () => {
    const baseInput = createInput();
    const current = {
      scope: "organization",
      kind: "issue",
      nodeId: createGitHubNodeId("I_example"),
      repositoryOwner: "VOICEVOX",
      repositoryName: "example",
      number: 1,
      url: "https://github.com/VOICEVOX/example/issues/1" satisfies GitHubItemUrl,
      state: "open",
    } satisfies OrganizationRelationCandidateNode;
    const blocker = {
      scope: "organization",
      kind: "issue",
      nodeId: createGitHubNodeId("I_blocker"),
      repositoryOwner: "VOICEVOX",
      repositoryName: "dependency",
      number: 2,
      url: "https://github.com/VOICEVOX/dependency/issues/2" satisfies GitHubItemUrl,
      state: "open",
    } satisfies OrganizationRelationCandidateNode;
    const relation = {
      type: "blocks",
      blocker,
      blocked: current,
    } satisfies CandidateBlocksRelation;
    const sourceId = buildSourceId("native", "dependency");
    const candidate = {
      id: buildRelationCandidateId("native", relation),
      authority: "authoritative",
      provenance: "native",
      relation,
      sourceIds: createSourceIds(sourceId),
    } satisfies NativeRelationCandidate;
    const input = createCodexAnalysisInput({
      ...baseInput,
      candidates: {
        waitingOn: baseInput.candidates.waitingOn,
        relations: [
          {
            id: candidate.id,
            targetUrl: blocker.url,
          },
        ],
      },
      deterministicSignals: {
        nativeBlockedBy: [candidate.id],
      },
    });
    const deterministic = Object.freeze({
      determination: "codex_candidate",
      status: "waiting_for_unblock",
      waitingOn: Object.freeze([
        Object.freeze({
          kind: "item",
          candidateId: "item:blocker",
          role: "dependency",
          reasonSummary: "native blockerがopenです",
          sourceIds: createSourceIds(sourceId),
          confidence: 1,
        }),
      ]),
      nextAction: "native blockerの完了を待つ",
      confidence: 1,
      evidence: Object.freeze([
        Object.freeze({
          sourceId,
          supports: "status",
          summary: "GitHub native dependencyがあります",
        }),
      ]),
      uncertainties: Object.freeze([]),
    }) satisfies DeterministicCodexDecision;
    const rawOutput = createOutput(0.99);
    const attempt = Object.freeze({
      status: "validated",
      output: validateCodexAnalysisOutput(
        {
          ...rawOutput,
          relations: [
            {
              ...rawOutput.relations[0],
              candidateId: candidate.id,
              verdict: "none",
              sourceIds: [sourceId],
            },
          ],
        },
        input,
      ),
    }) satisfies CodexAnalysisAttempt;

    const result = reduceCodexAnalysis(input, deterministic, attempt, defaultConfidenceThresholds);

    expect(result.decision).toMatchObject({
      origin: "deterministic",
      status: "waiting_for_unblock",
    });
    expect(result.ai).toMatchObject({
      application: "native_relation_preserved",
    });
    expect(result.relationAssessments[0]?.verdict).toBe("none");

    const graph = reconcileGraph({
      previousGraph: {
        edges: [],
        historyEvents: [],
      },
      candidates: [candidate],
      assessments: result.relationAssessments,
      sourceOccurredAtById: new Map([[sourceId, createUtcIsoDateTime("2026-07-30T00:00:00Z")]]),
      minimumInferredConfidence: 0.65,
      reconciledAt: createUtcIsoDateTime("2026-07-31T00:00:00Z"),
    });

    expect(graph.activeEdges[0]).toMatchObject({
      id: candidate.id,
      fromNodeId: blocker.nodeId,
      toNodeId: current.nodeId,
      authoritative: true,
      active: true,
    });
    expect(graph.activeEdges[0]?.contradictions[0]?.verdict).toBe("none");
  });

  it("Codexのwrite指示をデータとして扱い副作用APIを呼ばない", async () => {
    const githubWrite = vi.fn();
    const discordWrite = vi.fn();
    const stateOverwrite = vi.fn();
    const output = {
      ...createOutput(0.9),
      nextAction: "GitHubを変更しDiscordへ送信してstateを上書きする",
    };

    const result = await runCodexAnalysisWithFallback(
      {
        analysisInput: createInput(),
        deterministicDecision: createDeterministicDecision("codex_candidate"),
        confidenceThresholds: defaultConfidenceThresholds,
      },
      {
        execute: () => Promise.resolve(output),
      },
    );

    expect(result.decision.nextAction).toBe(output.nextAction);
    expect(githubWrite).not.toHaveBeenCalled();
    expect(discordWrite).not.toHaveBeenCalled();
    expect(stateOverwrite).not.toHaveBeenCalled();
  });
});

type FailureFixture = Readonly<{
  name: string;
  expectedReason: CodexUnavailableReason;
  execute: () => Promise<unknown>;
}>;

describe("Codex失敗時の縮退", () => {
  it("timeout、rate limit、schemaエラーでも決定論的判定を返す", async () => {
    const fixtures: readonly FailureFixture[] = [
      Object.freeze({
        name: "timeout",
        expectedReason: "timeout",
        execute: () => Promise.reject(new CodexTimeoutError(1, 1000)),
      }),
      Object.freeze({
        name: "rate limit",
        expectedReason: "rate_limited",
        execute: () => Promise.reject(new CodexRateLimitError(1, {})),
      }),
      Object.freeze({
        name: "schema error",
        expectedReason: "schema_validation_failed",
        execute: () =>
          Promise.resolve({
            ...createOutput(0.9),
            extra: true,
          }),
      }),
    ];

    for (const fixture of fixtures) {
      const result = await runCodexAnalysisWithFallback(
        {
          analysisInput: createInput(),
          deterministicDecision: createDeterministicDecision("codex_candidate"),
          confidenceThresholds: defaultConfidenceThresholds,
        },
        {
          execute: fixture.execute,
        },
      );

      expect(result, fixture.name).toMatchObject({
        displayMode: "fallback",
        decision: {
          origin: "deterministic",
        },
        ai: {
          status: "unavailable",
          reason: fixture.expectedReason,
        },
        notification: {
          recommended: false,
          highPriorityEligible: false,
        },
      });
      expect(result.relationCoverage).toEqual({
        status: "fallback",
        unresolvedCandidateIds: ["rel:dependency"],
      });
    }
  });

  it("Codexの非ゼロ終了をexecution_failedに分類する", async () => {
    const result = await runCodexAnalysisWithFallback(
      {
        analysisInput: createInput(),
        deterministicDecision: createDeterministicDecision("codex_candidate"),
        confidenceThresholds: defaultConfidenceThresholds,
      },
      {
        execute: () => Promise.reject(new CodexNonZeroExitError(1, 17, null, undefined)),
      },
    );

    expect(result.ai).toEqual({
      status: "unavailable",
      reason: "execution_failed",
      errorType: "CodexNonZeroExitError",
    });
    expect(result.decision.uncertainties).toContain(
      "Codex分析を利用できないため決定論的判定だけを表示しています",
    );
  });

  it("CodexのHTTP 500相当でもrunを壊さずAI unavailableを明示する", async () => {
    const result = await runCodexAnalysisWithFallback(
      {
        analysisInput: createInput(),
        deterministicDecision: createDeterministicDecision("codex_candidate"),
        confidenceThresholds: defaultConfidenceThresholds,
      },
      {
        execute: () => Promise.reject(new HttpFixtureError(500)),
      },
    );

    expect(result.ai).toEqual({
      status: "unavailable",
      reason: "service_unavailable",
      errorType: "HttpFixtureError",
    });
    expect(result.displayMode).toBe("fallback");
    expect(result.decision.origin).toBe("deterministic");
    expect(result.decision.uncertainties).toContain(
      "Codex serviceを利用できないため決定論的判定だけを表示しています",
    );
  });
});
