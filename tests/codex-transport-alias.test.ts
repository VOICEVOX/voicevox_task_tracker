import { describe, expect, it, vi } from "vitest";

import {
  CodexTransportAliasError,
  CodexOutputSemanticValidationError,
  MemoryAiCacheStore,
  createCodexAnalysisInput,
  executeCodexAnalysisWithTransportAliases,
  executeValidatedCodexAnalysis,
  prepareAiAnalysisCandidate,
  runAiAnalyses,
  validateCodexAnalysisOutput,
  type AiAnalysisCandidate,
  type AiAnalysisRunIdentity,
  type CodexAnalysisInput,
  type PreviousAiAnalysisFingerprint,
} from "../src/codex/index.js";
import { assertNonNullable } from "../src/util/index.js";

const fixedExecutedAt = "2026-07-31T00:00:00.000Z";
const runIdentity = Object.freeze({
  deterministicRulesVersion: "rules-v1",
  model: "codex-model",
  reasoningEffort: "medium",
  backendVersion: "codex-cli-v1",
  promptVersion: "prompt-v1",
  schemaVersion: "schema-v1",
}) satisfies AiAnalysisRunIdentity;

function createInput(): CodexAnalysisInput {
  return createCodexAnalysisInput({
    schemaVersion: "1",
    now: "2026-07-30T23:00:00Z",
    item: {
      nodeId: "I_transport",
      url: "https://github.com/VOICEVOX/example/issues/1",
      type: "issue",
      title: "body:current と rel:alpha を含むタイトル",
      authorCandidateId: "author",
    },
    candidates: {
      waitingOn: [
        {
          id: "role:maintainer",
          sourceIds: ["body:current"],
        },
        {
          id: "author",
        },
      ],
      relations: [
        {
          id: "rel:alpha",
          targetUrl: "https://github.com/VOICEVOX/alpha/issues/2",
        },
        {
          id: "rel:beta",
          targetUrl: "https://github.com/VOICEVOX/beta/issues/3",
        },
      ],
    },
    sources: [
      {
        id: "body:current",
        kind: "body",
        actorType: "human",
        createdAt: "2026-07-20T00:00:00Z",
        text: "body:current と rel:alpha は自由文として残す",
      },
      {
        id: "comment:review",
        kind: "comment",
        actorType: "human",
        createdAt: "2026-07-21T00:00:00Z",
        body: "comment:review と rel:beta は本文です",
      },
    ],
    deterministicSignals: {
      waitingOn: [
        {
          candidateId: "role:maintainer",
          sourceIds: ["body:current"],
        },
      ],
      mentionedWaitingOnCandidates: [
        {
          candidateId: "author",
          sourceIds: ["comment:review"],
        },
      ],
      requiredCheckFailure: {
        sourceId: "comment:review",
        summary: "rel:alpha は自由文です",
      },
      relationCandidateIds: ["rel:alpha", "rel:beta"],
      nativeBlockedBy: ["rel:alpha"],
      nativeBlocking: ["rel:beta"],
      nativeParent: [],
      nativeSubIssues: [],
      freeText: "body:current rel:alpha rel:beta を置換しない",
    },
    priorAnalysis: null,
  });
}

function createMinimalInput(sourceId: string, relationId: string | undefined): CodexAnalysisInput {
  return createCodexAnalysisInput({
    schemaVersion: "1",
    now: "2026-07-30T23:00:00Z",
    item: {
      nodeId: "I_minimal",
      url: "https://github.com/VOICEVOX/example/issues/1",
      type: "issue",
      title: "最小入力",
    },
    candidates: {
      waitingOn: [{ id: "role:maintainer" }],
      relations:
        relationId == null
          ? []
          : [{ id: relationId, targetUrl: "https://github.com/VOICEVOX/target/issues/2" }],
    },
    sources: [
      {
        id: sourceId,
        kind: "body",
        actorType: "human",
        createdAt: "2026-07-20T00:00:00Z",
      },
    ],
    deterministicSignals: {},
    priorAnalysis: null,
  });
}

function createOutput(input: CodexAnalysisInput) {
  const firstSource = input.sources.at(0);
  assertNonNullable(firstSource, "Codex transport testのsourceがありません");
  const secondSource = input.sources.at(1) ?? firstSource;
  return {
    schemaVersion: "2",
    item: {
      nodeId: input.item.nodeId,
      url: input.item.url,
    },
    status: "waiting_for_decision",
    waitingOn: [
      {
        kind: "role",
        candidateId: "role:maintainer",
        role: "maintainer",
        reasonSummary: "body:current と rel:alpha を根拠に判断を待ちます",
        sourceIds: [firstSource.id],
        confidence: 0.9,
      },
    ],
    nextAction: "maintainerの判断を待つ",
    relations: input.candidates.relations.map((candidate, index) => ({
      candidateId: candidate.id,
      verdict: index === 0 ? "current_is_blocked_by_target" : "current_blocks_target",
      reasonSummary: "relation候補の根拠を確認しました",
      sourceIds: [secondSource.id],
      confidence: 0.9,
    })),
    progress: {
      latestMeaningfulSourceId: secondSource.id,
      reasonSummary: "最新の根拠を確認しました",
      confidence: 0.8,
    },
    importance: {
      significantFeature: false,
      explicitDeadline: false,
      futureRisk: false,
      rationale: "重要度の自然言語要因はありません",
    },
    evidence: [
      {
        sourceId: firstSource.id,
        supports: "status",
        summary: "body:current を根拠として使います",
      },
    ],
    confidence: 0.9,
    uncertainties: ["rel:alpha の本文は自由文です"],
    notification: {
      recommended: false,
      reasonCode: "none",
      reasonSummary: "通知は不要です",
    },
  };
}

function createCandidate(
  input: CodexAnalysisInput,
  previousFingerprint: PreviousAiAnalysisFingerprint,
): AiAnalysisCandidate {
  return {
    id: "I_cache",
    deterministicResolution: "ambiguous",
    input,
    graphNeighborhood: {
      version: 1,
    },
    previousFingerprint,
    priority: {
      previouslyDeferred: false,
      severityCandidate: false,
      ownerUnknown: false,
      changedBlocker: false,
      downstreamImpact: {
        openNodeCount: 0,
        repositoryCount: 0,
      },
    },
    estimatedCostUsd: 0.1,
  };
}

async function expectTransportAliasFailure(
  operation: Promise<unknown>,
  causeMessage: string,
): Promise<void> {
  try {
    await operation;
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(CodexTransportAliasError);
    if (!(error instanceof CodexTransportAliasError)) {
      throw error;
    }
    expect(error.cause).toBeInstanceOf(Error);
    if (!(error.cause instanceof Error)) {
      throw new Error("Codex transport aliasエラーのcauseがありません");
    }
    expect(error.cause.message).toContain(causeMessage);
    return;
  }
  throw new Error("Codex transport aliasエラーが発生しませんでした");
}

async function expectSemanticValidationIssue(
  operation: Promise<unknown>,
  issueCode: string,
): Promise<void> {
  try {
    await operation;
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(CodexOutputSemanticValidationError);
    if (!(error instanceof CodexOutputSemanticValidationError)) {
      throw error;
    }
    expect(error.issues.some((issue) => issue.code === issueCode)).toBe(true);
    return;
  }
  throw new Error("Codex semantic検証エラーが発生しませんでした");
}

describe("Codex transport alias", () => {
  it("全structured参照をalias化し、自由文を変えずcanonical outputへ復元する", async () => {
    const input = createInput();
    let transportInput: CodexAnalysisInput | undefined;
    const execute = vi.fn((value: CodexAnalysisInput) => {
      transportInput = value;
      return Promise.resolve(createOutput(value));
    });

    const result = await executeCodexAnalysisWithTransportAliases(input, execute);

    assertNonNullable(transportInput, "Codex transport inputがありません");
    expect(transportInput.sources.map((source) => source.id)).toEqual([
      "codex_source:0",
      "codex_source:1",
    ]);
    expect(transportInput.candidates.relations.map((candidate) => candidate.id)).toEqual([
      "rel:codex-0",
      "rel:codex-1",
    ]);
    expect(transportInput.candidates.waitingOn[0]).toMatchObject({
      sourceIds: ["codex_source:0"],
    });
    expect(transportInput.deterministicSignals).toMatchObject({
      waitingOn: [{ sourceIds: ["codex_source:0"] }],
      mentionedWaitingOnCandidates: [{ sourceIds: ["codex_source:1"] }],
      requiredCheckFailure: { sourceId: "codex_source:1" },
      relationCandidateIds: ["rel:codex-0", "rel:codex-1"],
      nativeBlockedBy: ["rel:codex-0"],
      nativeBlocking: ["rel:codex-1"],
    });
    expect(transportInput.item.title).toContain("body:current");
    expect(transportInput.sources[0]).toMatchObject({
      text: "body:current と rel:alpha は自由文として残す",
    });
    expect(transportInput.deterministicSignals).toMatchObject({
      freeText: "body:current rel:alpha rel:beta を置換しない",
    });

    const restored = validateCodexAnalysisOutput(result, input);
    expect(restored.waitingOn[0]?.sourceIds).toEqual(["body:current"]);
    expect(restored.relations.map((relation) => relation.candidateId)).toEqual([
      "rel:alpha",
      "rel:beta",
    ]);
    expect(restored.relations[0]?.sourceIds).toEqual(["comment:review"]);
    expect(restored.progress.latestMeaningfulSourceId).toBe("comment:review");
    expect(restored.evidence[0]?.sourceId).toBe("body:current");
    expect(restored.evidence[0]?.summary).toBe("body:current を根拠として使います");
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("aliasがcanonical IDや別aliasと衝突する入力を拒否する", async () => {
    const sourceCollision = createMinimalInput("codex_source:0", undefined);
    const relationCollision = createMinimalInput("body:current", "rel:codex-0");

    await expectTransportAliasFailure(
      executeCodexAnalysisWithTransportAliases(sourceCollision, () => Promise.resolve({})),
      "Codex transport aliasが既存のIDと衝突しています",
    );
    await expectTransportAliasFailure(
      executeCodexAnalysisWithTransportAliases(relationCollision, () => Promise.resolve({})),
      "Codex transport aliasが既存のIDと衝突しています",
    );
    await expect(
      executeValidatedCodexAnalysis(sourceCollision, (value) =>
        executeCodexAnalysisWithTransportAliases(value, () => Promise.resolve({})),
      ),
    ).rejects.toBeInstanceOf(CodexTransportAliasError);
  });

  it("priorAnalysisの非null入力をschemaで拒否する", () => {
    expect(() =>
      createCodexAnalysisInput({
        ...createInput(),
        priorAnalysis: {
          sourceId: "body:current",
        },
      }),
    ).toThrow();
  });

  it("候補外relation IDを含むdeterministicSignalsをtransport内部エラーとして伝播する", async () => {
    const baseInput = createInput();
    const input = createCodexAnalysisInput({
      ...baseInput,
      deterministicSignals: {
        ...baseInput.deterministicSignals,
        relationCandidateIds: ["rel:not-a-candidate"],
      },
    });

    await expectTransportAliasFailure(
      executeValidatedCodexAnalysis(input, (value) =>
        executeCodexAnalysisWithTransportAliases(value, () => Promise.resolve({})),
      ),
      "Codex transport aliasに対応するIDがありません",
    );
  });

  it("復元対象外のaliasが生じた場合はtransport内部エラーとして伝播する", async () => {
    const input = createInput();
    const attempt = executeValidatedCodexAnalysis(input, (value) =>
      executeCodexAnalysisWithTransportAliases(value, (transportInput) => {
        const source = transportInput.sources.at(0);
        assertNonNullable(source, "Codex transport testのsourceがありません");
        source.id = "codex_source:mutated";
        return Promise.resolve(createOutput(transportInput));
      }),
    );

    await expectTransportAliasFailure(
      attempt,
      "Codex transport aliasに対応するcanonical IDがありません",
    );
  });

  it("未知alias、欠落、重複のrelation判定をsemantic検証で拒否する", async () => {
    const input = createInput();
    const unknownAliasExecutor = (transportInput: CodexAnalysisInput) => {
      const output = createOutput(transportInput);
      const evidence = output.evidence.at(0);
      assertNonNullable(evidence, "Codex transport testのevidenceがありません");
      return Promise.resolve({
        ...output,
        evidence: [{ ...evidence, sourceId: "codex_source:missing" }],
      });
    };
    const unknownRelationAliasExecutor = (transportInput: CodexAnalysisInput) => {
      const output = createOutput(transportInput);
      const relation = output.relations.at(0);
      assertNonNullable(relation, "Codex transport testのrelationがありません");
      return Promise.resolve({
        ...output,
        relations: [
          { ...relation, candidateId: "rel:codex-missing" },
          ...output.relations.slice(1),
        ],
      });
    };
    const missingVerdictExecutor = (transportInput: CodexAnalysisInput) => {
      const output = createOutput(transportInput);
      const relation = output.relations.at(0);
      assertNonNullable(relation, "Codex transport testのrelationがありません");
      return Promise.resolve({
        ...output,
        relations: [relation],
      });
    };
    const duplicateVerdictExecutor = (transportInput: CodexAnalysisInput) => {
      const output = createOutput(transportInput);
      const firstRelation = output.relations.at(0);
      assertNonNullable(firstRelation, "Codex transport testのrelationがありません");
      return Promise.resolve({
        ...output,
        relations: [firstRelation, firstRelation],
      });
    };

    await expect(
      executeCodexAnalysisWithTransportAliases(input, unknownAliasExecutor),
    ).rejects.toBeInstanceOf(CodexOutputSemanticValidationError);
    const semanticAttempt = await executeValidatedCodexAnalysis(input, (value) =>
      executeCodexAnalysisWithTransportAliases(value, unknownAliasExecutor),
    );
    expect(semanticAttempt).toMatchObject({
      status: "unavailable",
      reason: "semantic_validation_failed",
    });
    await expectSemanticValidationIssue(
      executeCodexAnalysisWithTransportAliases(input, unknownRelationAliasExecutor),
      "unknown_relation_candidate",
    );
    await expectSemanticValidationIssue(
      executeCodexAnalysisWithTransportAliases(input, missingVerdictExecutor),
      "missing_relation_verdict",
    );
    await expectSemanticValidationIssue(
      executeCodexAnalysisWithTransportAliases(input, duplicateVerdictExecutor),
      "duplicate_relation_verdict",
    );
  });

  it("raw executorのエラーをtransport内部エラーへ変換しない", async () => {
    const input = createInput();
    const executorError = new Error("raw executor failure");

    await expect(
      executeCodexAnalysisWithTransportAliases(input, () => Promise.reject(executorError)),
    ).rejects.toBe(executorError);
  });

  it("canonical output cache hitではtransport executorを呼ばない", async () => {
    const input = createMinimalInput("body:current", undefined);
    const unavailable: PreviousAiAnalysisFingerprint = { status: "unavailable" };
    const firstCandidate = createCandidate(input, unavailable);
    const preparedFirst = prepareAiAnalysisCandidate(firstCandidate, runIdentity);
    const unchangedCandidate = createCandidate(input, {
      status: "available",
      fingerprint: preparedFirst.fingerprint,
    });
    const preparedUnchanged = prepareAiAnalysisCandidate(unchangedCandidate, runIdentity);
    const execute = vi.fn((value: CodexAnalysisInput) =>
      executeCodexAnalysisWithTransportAliases(value, (transportInput) =>
        Promise.resolve(createOutput(transportInput)),
      ),
    );
    const dependencies = {
      cache: new MemoryAiCacheStore(),
      execute,
      executedAt: () => fixedExecutedAt,
    };
    const configuration = {
      identity: runIdentity,
      budget: {
        maxCallsPerRun: 1,
        maxInputCharactersPerItem: 100_000,
        maxTotalInputCharactersPerRun: 1_000_000,
        maxEstimatedCostUsdPerRun: 1,
      },
      maxConcurrentCalls: 1,
    };

    await runAiAnalyses([preparedFirst], configuration, dependencies);
    execute.mockClear();
    const result = await runAiAnalyses([preparedUnchanged], configuration, dependencies);

    expect(result.results).toHaveLength(1);
    expect(result.results[0]?.origin).toBe("cache");
    expect(result.results[0]?.output.waitingOn[0]?.sourceIds).toEqual(["body:current"]);
    expect(execute).not.toHaveBeenCalled();
  });
});
