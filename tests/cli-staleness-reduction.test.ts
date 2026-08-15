import { describe, expect, it } from "vitest";

import { calculateStalenessForItem } from "../src/cli/staleness-reduction.js";
import {
  buildSourceId,
  createGitHubNodeId,
  createLabelEffectsResolver,
  createUtcIsoDateTime,
  StalenessTimestampRangeError,
  type CalculateStalenessInput,
  type StateDecisionForStaleness,
} from "../src/domain/index.js";
import { StalenessReductionError as StalenessReductionErrorClass } from "../src/cli/errors.js";

const createdAt = createUtcIsoDateTime("2026-08-01T00:00:00Z");
const evaluatedAt = createUtcIsoDateTime("2026-08-02T00:00:00Z");
const sourceId = buildSourceId("test_staleness_reduction", "basis");

function createInput(): CalculateStalenessInput {
  return Object.freeze({
    createdAt,
    evaluatedAt,
    currentDecision: {
      status: "waiting_for_assessment",
      waitingOn: [
        {
          kind: "role",
          candidateId: "maintainer",
          role: "maintainer",
          reasonSummary: "テスト用の待機根拠です",
          sourceIds: [sourceId],
          confidence: 1,
        },
      ],
      confidence: 1,
      statusBasis: { sourceIds: [sourceId], occurredAt: createdAt, precision: "event" },
      responsibilityBasis: { sourceIds: [sourceId], occurredAt: createdAt, precision: "event" },
    } satisfies StateDecisionForStaleness,
    decisionBasis: "deterministic",
    events: [],
    responsibleAccountIdentifiers: new Set<string>(),
    dependencyResolutions: [],
    naturalLanguageAssessments: [],
    minimumAiConfidence: 0.65,
    repositoryFullName: "VOICEVOX/example",
    currentLabels: [],
    resolveLabelEffects: createLabelEffectsResolver([]),
    thresholdsHours: {
      assessment: { watch: 48, urgent: 96, critical: 168 },
      owner: { watch: 48, urgent: 96, critical: 168 },
      decision: { watch: 48, urgent: 96, critical: 168 },
      review: { watch: 48, urgent: 120, critical: 240 },
      revision: { watch: 72, urgent: 168, critical: 336 },
      reply: { watch: 48, urgent: 120, critical: 240 },
      work: { watch: 168, urgent: 336, critical: 720 },
      merge: { watch: 24, urgent: 72, critical: 168 },
      automation: { watch: 6, urgent: 24, critical: 72 },
    },
    blockedParentContext: { status: "not_applicable" },
  } satisfies CalculateStalenessInput);
}

describe("項目単位の停滞時間計算診断", () => {
  it("時刻範囲違反だけをnode ID付き専用エラーへ包む", () => {
    const input = createInput();
    const occurredAt = createUtcIsoDateTime("2026-07-31T23:00:00Z");
    const invalidInput = Object.freeze({
      ...input,
      currentDecision: {
        ...input.currentDecision,
        statusBasis: { ...input.currentDecision.statusBasis, occurredAt },
      },
    });
    let captured: unknown;
    try {
      calculateStalenessForItem(createGitHubNodeId("I_staleness_diagnostic"), invalidInput);
    } catch (error: unknown) {
      captured = error;
    }

    expect(captured).toBeInstanceOf(StalenessReductionErrorClass);
    if (!(captured instanceof StalenessReductionErrorClass)) {
      throw new TypeError("停滞時間計算の専用包装エラーを取得できませんでした");
    }
    expect(captured.itemNodeId).toBe("I_staleness_diagnostic");
    expect(captured.cause).toBeInstanceOf(StalenessTimestampRangeError);
  });

  it("一般エラーは同一インスタンスのまま伝播する", () => {
    const cause = new Error("一般エラー");
    const input = Object.freeze({
      ...createInput(),
      resolveLabelEffects: () => {
        throw cause;
      },
    });
    let captured: unknown;
    try {
      calculateStalenessForItem(createGitHubNodeId("I_staleness_generic"), input);
    } catch (error: unknown) {
      captured = error;
    }

    expect(captured).toBe(cause);
  });
});
