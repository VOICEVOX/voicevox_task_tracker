import { z } from "zod";

import {
  AI_ANALYSIS_ELEMENTS,
  aiAnalysisElementSchema,
  createAiAnalysisElementResultSchema,
  type AiAnalysisElement,
} from "../domain/ai-analysis-elements.js";
import type { CodexAnalysisInput } from "./input.js";

type StateNecessityInput = Readonly<{
  deterministic: boolean;
  unresolvedRequest: boolean;
  unresolvedCi: boolean;
  effectiveAssigneeCandidate: boolean;
}>;

/** 要素の必要性を確定するための決定論的な事実。 */
export type AnalysisElementNecessityInput = Readonly<{
  state: Readonly<{
    status: StateNecessityInput;
    waitingOn: StateNecessityInput;
    nextAction: StateNecessityInput;
  }>;
  hasUnresolvedRelationCandidate: boolean;
  hasHumanProgressCandidate: boolean;
  importance: Readonly<{ normalAiAnalysisScope: boolean; currentlyAdopted: boolean }>;
  deadline: Readonly<{ normalAiAnalysisScope: boolean; currentlyAdopted: boolean }>;
  notification: Readonly<{ aiIsConsumed: boolean }>;
  selfCommitment: Readonly<{ hasEligibleCandidate: boolean }>;
}>;

type GenericAiElementDefinition = Readonly<{
  revision: number;
  inputProjectionVersion: 4;
  useSites: readonly string[];
  promptDescription: string;
  resultSchema: z.ZodType;
  required: (input: AnalysisElementNecessityInput) => boolean;
  exactInput: (input: CodexAnalysisInput) => object;
}>;

function stateElementRequired(input: StateNecessityInput): boolean {
  return (
    !input.deterministic ||
    input.unresolvedRequest ||
    input.unresolvedCi ||
    input.effectiveAssigneeCandidate
  );
}

function naturalLanguageSources(input: CodexAnalysisInput): readonly object[] {
  return input.sources.filter(
    (source) => source.kind === "body" || source.kind === "comment" || source.kind === "review",
  );
}

function textItem(input: CodexAnalysisInput): object {
  return Object.freeze({
    nodeId: input.item.nodeId,
    url: input.item.url,
    type: input.item.type,
    title: input.item.title,
    ...(input.item.authorCandidateId == null
      ? {}
      : { authorCandidateId: input.item.authorCandidateId }),
  });
}

function signalProjection(
  signals: Readonly<Record<string, unknown>>,
  keys: readonly string[],
): object {
  const projection: Record<string, unknown> = {};
  for (const key of keys) {
    if (Object.hasOwn(signals, key)) {
      projection[key] = signals[key];
    }
  }
  return Object.freeze(projection);
}

function exactInputContext(input: CodexAnalysisInput, element: AiAnalysisElement): object {
  const selectedElements =
    element === "status" || element === "waitingOn"
      ? AI_ANALYSIS_ELEMENTS.filter(
          (selected) =>
            selected === element ||
            ((selected === "status" || selected === "waitingOn") &&
              input.selectedElements.includes(selected)),
        )
      : [element];
  const lockedElements = Object.fromEntries(
    AI_ANALYSIS_ELEMENTS.filter(
      (locked) => locked !== element && input.lockedElements[locked] != null,
    ).map((locked) => [locked, input.lockedElements[locked]]),
  );
  return Object.freeze({
    inputProjectionVersion: GENERIC_AI_ELEMENT_DEFINITIONS[element].inputProjectionVersion,
    publicRepositoryAllowlist: input.deterministicSignals["publicRepositoryAllowlist"],
    verifiedExternalReferences: input.deterministicSignals["verifiedExternalReferences"],
    selectedElements: Object.freeze(selectedElements),
    lockedElements: Object.freeze(lockedElements),
  });
}

const STATE_SIGNAL_KEYS = Object.freeze([
  "status",
  "waitingOn",
  "requiredCheckFailure",
  "effectiveAssigneeCandidates",
  "effectiveAssigneeImplementations",
  "mentionedWaitingOnCandidates",
  "uncertainties",
]);

function stateExactInput(input: CodexAnalysisInput, element: AiAnalysisElement): object {
  return Object.freeze({
    ...exactInputContext(input, element),
    item: input.item,
    candidates: input.candidates.waitingOn,
    sources: naturalLanguageSources(input),
    deterministicSignals: signalProjection(input.deterministicSignals, STATE_SIGNAL_KEYS),
  });
}

function relationExactInput(input: CodexAnalysisInput): object {
  return Object.freeze({
    ...exactInputContext(input, "relations"),
    item: textItem(input),
    candidates: input.candidates.relations,
    sources: [
      ...input.sources.filter((source) => source.kind === "relation"),
      ...naturalLanguageSources(input),
    ],
    deterministicSignals: signalProjection(input.deterministicSignals, [
      "relationCandidateIds",
      "nativeBlockedBy",
      "nativeBlocking",
      "nativeParent",
      "nativeSubIssues",
      "nativeImplements",
    ]),
  });
}

function textExactInput(input: CodexAnalysisInput, element: AiAnalysisElement): object {
  return Object.freeze({
    ...exactInputContext(input, element),
    item: textItem(input),
    sources: naturalLanguageSources(input),
  });
}

function progressExactInput(input: CodexAnalysisInput): object {
  return Object.freeze({
    ...textExactInput(input, "progress"),
    humanProgressSourceIds: input.deterministicSignals["humanProgressSourceIds"],
  });
}

function notificationExactInput(input: CodexAnalysisInput): object {
  return Object.freeze({
    ...exactInputContext(input, "notification"),
    item: textItem(input),
    candidates: input.candidates,
    sources: naturalLanguageSources(input),
    deterministicSignals: signalProjection(input.deterministicSignals, STATE_SIGNAL_KEYS),
  });
}

function selfCommitmentExactInput(input: CodexAnalysisInput): object {
  return Object.freeze({
    ...exactInputContext(input, "selfCommitment"),
    item: input.item,
    candidates: input.selfCommitmentCandidates,
    sources: naturalLanguageSources(input),
  });
}

/** 汎用AIの9要素の意味契約と出力schemaの正本。 */
export const GENERIC_AI_ELEMENT_DEFINITIONS = Object.freeze({
  status: Object.freeze({
    revision: 1,
    inputProjectionVersion: 4,
    useSites: Object.freeze(["状態", "停滞"]),
    promptDescription: "現在のワークフローの状態",
    resultSchema: createAiAnalysisElementResultSchema("status"),
    required: (input: AnalysisElementNecessityInput) => stateElementRequired(input.state.status),
    exactInput: (input: CodexAnalysisInput) => stateExactInput(input, "status"),
  }),
  waitingOn: Object.freeze({
    revision: 3,
    inputProjectionVersion: 4,
    useSites: Object.freeze(["待ち相手", "実質担当", "停滞"]),
    promptDescription: "次に行動することが期待される人または対象",
    resultSchema: createAiAnalysisElementResultSchema("waitingOn"),
    required: (input: AnalysisElementNecessityInput) => stateElementRequired(input.state.waitingOn),
    exactInput: (input: CodexAnalysisInput) => stateExactInput(input, "waitingOn"),
  }),
  nextAction: Object.freeze({
    revision: 1,
    inputProjectionVersion: 4,
    useSites: Object.freeze(["次の行動"]),
    promptDescription: "次に行う具体的な行動",
    resultSchema: createAiAnalysisElementResultSchema("nextAction"),
    required: (input: AnalysisElementNecessityInput) =>
      stateElementRequired(input.state.nextAction),
    exactInput: (input: CodexAnalysisInput) => stateExactInput(input, "nextAction"),
  }),
  relations: Object.freeze({
    revision: 3,
    inputProjectionVersion: 4,
    useSites: Object.freeze(["関係採否", "graph"]),
    promptDescription: "入力された関係候補の意味",
    resultSchema: createAiAnalysisElementResultSchema("relations"),
    required: (input: AnalysisElementNecessityInput) => input.hasUnresolvedRelationCandidate,
    exactInput: relationExactInput,
  }),
  progress: Object.freeze({
    revision: 2,
    inputProjectionVersion: 4,
    useSites: Object.freeze(["進捗", "停滞起点"]),
    promptDescription: "最新の意味のある進捗イベント",
    resultSchema: createAiAnalysisElementResultSchema("progress"),
    required: (input: AnalysisElementNecessityInput) => input.hasHumanProgressCandidate,
    exactInput: progressExactInput,
  }),
  importance: Object.freeze({
    revision: 1,
    inputProjectionVersion: 4,
    useSites: Object.freeze(["重要度", "要対応度"]),
    promptDescription: "対象項目の重要度",
    resultSchema: createAiAnalysisElementResultSchema("importance"),
    required: (input: AnalysisElementNecessityInput) =>
      input.importance.normalAiAnalysisScope || input.importance.currentlyAdopted,
    exactInput: (input: CodexAnalysisInput) => textExactInput(input, "importance"),
  }),
  deadline: Object.freeze({
    revision: 1,
    inputProjectionVersion: 4,
    useSites: Object.freeze(["期限", "要対応度"]),
    promptDescription: "対象項目自体の期限日",
    resultSchema: createAiAnalysisElementResultSchema("deadline"),
    required: (input: AnalysisElementNecessityInput) =>
      input.deadline.normalAiAnalysisScope || input.deadline.currentlyAdopted,
    exactInput: (input: CodexAnalysisInput) => textExactInput(input, "deadline"),
  }),
  notification: Object.freeze({
    revision: 1,
    inputProjectionVersion: 4,
    useSites: Object.freeze(["通知推奨"]),
    promptDescription: "通知推奨の要否",
    resultSchema: createAiAnalysisElementResultSchema("notification"),
    required: (input: AnalysisElementNecessityInput) => input.notification.aiIsConsumed,
    exactInput: notificationExactInput,
  }),
  selfCommitment: Object.freeze({
    revision: 1,
    inputProjectionVersion: 4,
    useSites: Object.freeze(["本人起因通知抑制"]),
    promptDescription: "本人が対象項目の次の対応を引き受けた根拠",
    resultSchema: createAiAnalysisElementResultSchema("selfCommitment"),
    required: (input: AnalysisElementNecessityInput) => input.selfCommitment.hasEligibleCandidate,
    exactInput: selfCommitmentExactInput,
  }),
} satisfies Readonly<Record<AiAnalysisElement, GenericAiElementDefinition>>);

function definitionNumbers(
  field: "revision" | "inputProjectionVersion",
): Readonly<Record<AiAnalysisElement, number>> {
  const values: Partial<Record<AiAnalysisElement, number>> = {};
  for (const element of AI_ANALYSIS_ELEMENTS) {
    values[element] = GENERIC_AI_ELEMENT_DEFINITIONS[element][field];
  }
  return Object.freeze(
    z.record(aiAnalysisElementSchema, z.number().int().positive()).parse(values),
  );
}

/** AI判定要素の現在の意味revision。 */
export const AI_ANALYSIS_ELEMENT_REVISIONS = definitionNumbers("revision");

/** AI判定要素の意味入力投影version。 */
export const AI_ANALYSIS_ELEMENT_INPUT_PROJECTION_VERSIONS =
  definitionNumbers("inputProjectionVersion");
