import { sha256Hex } from "../canonical-json/sha256-hex.js";
import { parseSha256Hash } from "../canonical-json/sha256.js";
import { serializeCanonicalJson } from "../canonical-json/value.js";
import {
  aiAnalysisElementReuseProofSchema,
  createAiAnalysisMigrationElementResultSchema,
  type AiAnalysisElement,
  type AiAnalysisElementInputFingerprint,
  type AiAnalysisElementMigrationResult,
  type AiAnalysisElementReuseProof,
} from "../domain/ai-analysis-elements.js";
import { type AiAnalysisElementSourceGeneration } from "../domain/ai-analysis-source-generations.js";
import { type AnalysisElementReuseRecord } from "./analysis-elements.js";
import {
  AI_ANALYSIS_ELEMENT_INPUT_PROJECTION_VERSIONS,
  AI_ANALYSIS_ELEMENT_REVISIONS,
} from "./generic-ai-definition.js";
import {
  assessAnalysisImpact,
  type AnalysisImpactAssessment,
  type AnalysisImpactCurrentInputProjection,
  type AnalysisImpactDeclaration,
  type AnalysisImpactRecord,
  type AnalysisImpactValue,
  type AnalysisImpactVersion,
} from "./analysis-impact.js";
import { GENERIC_AI_ELEMENT_DEFINITIONS } from "./generic-ai-definition.js";
import { type CodexAnalysisInput } from "./input.js";

function hashCanonicalJson(value: unknown): AiAnalysisElementInputFingerprint {
  return parseSha256Hash(`sha256:${sha256Hex(serializeCanonicalJson(value))}`);
}

/** 要素ごとの意味入力fingerprint。 */
export type AnalysisElementInputFingerprintMap = Readonly<
  Record<AiAnalysisElement, AiAnalysisElementInputFingerprint>
>;

/** 要素ごとの厳密な意味入力。 */
export type AnalysisElementExactInputMap = Readonly<
  Record<
    AiAnalysisElement,
    Readonly<{ exactInput: object; fingerprint: AiAnalysisElementInputFingerprint }>
  >
>;

/** 要素ごとの意味依存fingerprint。 */
export type AnalysisElementDependencyFingerprintMap = Readonly<
  Record<AiAnalysisElement, AiAnalysisElementInputFingerprint>
>;

/** 版間影響の診断情報。 */
export type AnalysisImpactDecisionForDiagnostics = Readonly<{
  impact: "unaffected" | "deterministic" | "interpretation_required" | "unknown";
  sourceVersion: AnalysisImpactVersion;
  targetVersion: AnalysisImpactVersion;
  compatibilityPath: readonly string[];
  reason?: string;
}>;

const WAITING_ON_ANALYSIS_IMPACT_DECLARATIONS: readonly AnalysisImpactDeclaration<
  AiAnalysisElementMigrationResult,
  CodexAnalysisInput
>[] = Object.freeze([
  Object.freeze({
    element: "waitingOn",
    changeId: "waitingOn-revision-2-to-3",
    from: Object.freeze({ revision: 2, inputProjectionVersion: 1 }),
    to: Object.freeze({ revision: 3, inputProjectionVersion: 1 }),
    assess: (): AnalysisImpactAssessment<AiAnalysisElementMigrationResult> =>
      Object.freeze({ impact: "unaffected" }),
  }),
]);

const NO_ANALYSIS_IMPACT_DECLARATIONS: readonly AnalysisImpactDeclaration<
  AiAnalysisElementMigrationResult,
  CodexAnalysisInput
>[] = Object.freeze([]);

const ANALYSIS_IMPACT_DECLARATIONS: Readonly<
  Record<
    AiAnalysisElement,
    readonly AnalysisImpactDeclaration<AiAnalysisElementMigrationResult, CodexAnalysisInput>[]
  >
> = Object.freeze({
  status: NO_ANALYSIS_IMPACT_DECLARATIONS,
  waitingOn: WAITING_ON_ANALYSIS_IMPACT_DECLARATIONS,
  nextAction: NO_ANALYSIS_IMPACT_DECLARATIONS,
  relations: NO_ANALYSIS_IMPACT_DECLARATIONS,
  progress: NO_ANALYSIS_IMPACT_DECLARATIONS,
  importance: NO_ANALYSIS_IMPACT_DECLARATIONS,
  deadline: NO_ANALYSIS_IMPACT_DECLARATIONS,
  notification: NO_ANALYSIS_IMPACT_DECLARATIONS,
  selfCommitment: NO_ANALYSIS_IMPACT_DECLARATIONS,
});

function analysisImpactVersionsEqual(
  left: AnalysisImpactVersion,
  right: AnalysisImpactVersion,
): boolean {
  return (
    left.revision === right.revision && left.inputProjectionVersion === right.inputProjectionVersion
  );
}

function impactDeclarationsForElement(
  element: AiAnalysisElement,
  sourceVersion: AnalysisImpactVersion,
  targetVersion: AnalysisImpactVersion,
): readonly AnalysisImpactDeclaration<AiAnalysisElementMigrationResult, CodexAnalysisInput>[] {
  const declarations = ANALYSIS_IMPACT_DECLARATIONS[element];
  const path: AnalysisImpactDeclaration<AiAnalysisElementMigrationResult, CodexAnalysisInput>[] =
    [];
  const visited = new Set<string>();
  let currentVersion = sourceVersion;
  while (!analysisImpactVersionsEqual(currentVersion, targetVersion)) {
    const versionKey = `${currentVersion.revision.toString()}:${currentVersion.inputProjectionVersion.toString()}`;
    if (visited.has(versionKey)) {
      return Object.freeze([]);
    }
    visited.add(versionKey);
    const declaration = declarations.find((candidate) =>
      analysisImpactVersionsEqual(candidate.from, currentVersion),
    );
    if (declaration == null) {
      return Object.freeze([]);
    }
    path.push(declaration);
    currentVersion = declaration.to;
  }
  return Object.freeze(path);
}

function analysisImpactTargetVersion(element: AiAnalysisElement): AnalysisImpactVersion {
  return Object.freeze({
    revision: AI_ANALYSIS_ELEMENT_REVISIONS[element],
    inputProjectionVersion: AI_ANALYSIS_ELEMENT_INPUT_PROJECTION_VERSIONS[element],
  });
}

function analysisImpactSourceVersion(
  element: AiAnalysisElement,
  generation: AiAnalysisElementSourceGeneration | undefined,
  reuseProof: AiAnalysisElementReuseProof,
): AnalysisImpactVersion | undefined {
  if (reuseProof.status === "verified") {
    return Object.freeze({
      revision: reuseProof.revision,
      inputProjectionVersion: reuseProof.inputProjectionVersion,
    });
  }
  if (generation == null) {
    return undefined;
  }
  return Object.freeze({
    revision: generation.metadata.revision,
    inputProjectionVersion: AI_ANALYSIS_ELEMENT_INPUT_PROJECTION_VERSIONS[element],
  });
}

function analysisImpactInputProjection(
  element: AiAnalysisElement,
  version: AnalysisImpactVersion,
  input: CodexAnalysisInput,
  dependencyFingerprints: AnalysisElementDependencyFingerprintMap,
): AnalysisImpactCurrentInputProjection | undefined {
  if (
    version.inputProjectionVersion !==
    GENERIC_AI_ELEMENT_DEFINITIONS[element].inputProjectionVersion
  ) {
    return undefined;
  }
  return Object.freeze({
    inputProjectionVersion: version.inputProjectionVersion,
    fingerprint: createAnalysisElementExactInput(input, element).fingerprint,
    dependencyFingerprint: dependencyFingerprints[element],
  });
}

/** 保存値の版差による影響と再利用証明を判定する。 */
export function analysisImpactResolutionForRole(
  element: AiAnalysisElement,
  role: "adopted" | "evaluated",
  generation: AiAnalysisElementSourceGeneration | undefined,
  roleRecord: AnalysisElementReuseRecord,
  adoptedResult: AnalysisImpactValue<AiAnalysisElementMigrationResult>,
  evaluatedResult: AnalysisImpactValue<AiAnalysisElementMigrationResult>,
  relatedInput: CodexAnalysisInput,
  dependencyFingerprints: AnalysisElementDependencyFingerprintMap,
): Readonly<{
  resolution: AnalysisElementReuseRecord | undefined;
  decision: AnalysisImpactDecisionForDiagnostics | undefined;
}> {
  const sourceVersion = analysisImpactSourceVersion(element, generation, roleRecord.proof);
  if (sourceVersion == null) {
    return Object.freeze({ resolution: undefined, decision: undefined });
  }
  const targetVersion = analysisImpactTargetVersion(element);
  if (
    sourceVersion.revision === targetVersion.revision &&
    sourceVersion.inputProjectionVersion === targetVersion.inputProjectionVersion
  ) {
    return Object.freeze({ resolution: undefined, decision: undefined });
  }
  const currentSourceInputProjection = analysisImpactInputProjection(
    element,
    sourceVersion,
    relatedInput,
    dependencyFingerprints,
  );
  const currentTargetInputProjection = analysisImpactInputProjection(
    element,
    targetVersion,
    relatedInput,
    dependencyFingerprints,
  );
  if (currentSourceInputProjection == null || currentTargetInputProjection == null) {
    return Object.freeze({
      resolution: undefined,
      decision: Object.freeze({
        impact: "unknown",
        sourceVersion,
        targetVersion,
        compatibilityPath: Object.freeze([]),
        reason: "input_projection_unavailable",
      }),
    });
  }
  const record: AnalysisImpactRecord<AiAnalysisElementMigrationResult, CodexAnalysisInput> =
    Object.freeze({
      element,
      role,
      sourceVersion,
      targetVersion,
      adoptedResult,
      evaluatedResult,
      currentSourceInputProjection,
      currentTargetInputProjection,
      reuseProof: roleRecord.proof,
      relatedInput,
    });
  const decision = assessAnalysisImpact(
    record,
    impactDeclarationsForElement(element, sourceVersion, targetVersion),
  );
  const diagnostic: AnalysisImpactDecisionForDiagnostics = Object.freeze({
    impact: decision.impact,
    sourceVersion: decision.sourceVersion,
    targetVersion: decision.targetVersion,
    compatibilityPath: decision.compatibilityPath,
    ...(decision.impact === "unknown" ? { reason: decision.reason } : {}),
  });
  if (decision.result.status !== "present") {
    return Object.freeze({ resolution: undefined, decision: diagnostic });
  }
  if (
    decision.impact === "deterministic" &&
    isStateAnalysisElement(element) &&
    hashCanonicalJson(decision.result.result) !== hashCanonicalJson(roleRecord.result)
  ) {
    return Object.freeze({
      resolution: undefined,
      decision: Object.freeze({
        ...diagnostic,
        impact: "interpretation_required",
      }),
    });
  }
  const result = createAiAnalysisMigrationElementResultSchema(element).parse(
    decision.result.result,
  );
  return Object.freeze({
    resolution: Object.freeze({
      result,
      proof: verifiedReuseProof(
        element,
        currentTargetInputProjection.fingerprint,
        currentTargetInputProjection.dependencyFingerprint,
        "deterministic_update",
        decision.compatibilityPath,
      ),
    }),
    decision: diagnostic,
  });
}

/** 要素別の厳密な意味入力とそのfingerprintを同時に確定する。 */
export function createAnalysisElementExactInput(
  input: CodexAnalysisInput,
  element: AiAnalysisElement,
): Readonly<{ exactInput: object; fingerprint: AiAnalysisElementInputFingerprint }> {
  const exactInput = GENERIC_AI_ELEMENT_DEFINITIONS[element].exactInput(input);
  return Object.freeze({ exactInput, fingerprint: hashCanonicalJson(exactInput) });
}

/** 9要素の厳密入力とfingerprintを一度ずつ作る。 */
export function createAnalysisElementExactInputs(
  input: CodexAnalysisInput,
): AnalysisElementExactInputMap {
  return Object.freeze({
    status: createAnalysisElementExactInput(input, "status"),
    waitingOn: createAnalysisElementExactInput(input, "waitingOn"),
    nextAction: createAnalysisElementExactInput(input, "nextAction"),
    relations: createAnalysisElementExactInput(input, "relations"),
    progress: createAnalysisElementExactInput(input, "progress"),
    importance: createAnalysisElementExactInput(input, "importance"),
    deadline: createAnalysisElementExactInput(input, "deadline"),
    notification: createAnalysisElementExactInput(input, "notification"),
    selfCommitment: createAnalysisElementExactInput(input, "selfCommitment"),
  });
}

/** 実行要素だけ実輸送入力の意味文脈へ差し替える。 */
export function withExecutedAnalysisElementExactInputs(
  candidateInputs: AnalysisElementExactInputMap,
  executionInput: CodexAnalysisInput,
): AnalysisElementExactInputMap {
  const selected = new Set(executionInput.selectedElements);
  return Object.freeze({
    status: selected.has("status")
      ? createAnalysisElementExactInput(executionInput, "status")
      : candidateInputs.status,
    waitingOn: selected.has("waitingOn")
      ? createAnalysisElementExactInput(executionInput, "waitingOn")
      : candidateInputs.waitingOn,
    nextAction: selected.has("nextAction")
      ? createAnalysisElementExactInput(executionInput, "nextAction")
      : candidateInputs.nextAction,
    relations: selected.has("relations")
      ? createAnalysisElementExactInput(executionInput, "relations")
      : candidateInputs.relations,
    progress: selected.has("progress")
      ? createAnalysisElementExactInput(executionInput, "progress")
      : candidateInputs.progress,
    importance: selected.has("importance")
      ? createAnalysisElementExactInput(executionInput, "importance")
      : candidateInputs.importance,
    deadline: selected.has("deadline")
      ? createAnalysisElementExactInput(executionInput, "deadline")
      : candidateInputs.deadline,
    notification: selected.has("notification")
      ? createAnalysisElementExactInput(executionInput, "notification")
      : candidateInputs.notification,
    selfCommitment: selected.has("selfCommitment")
      ? createAnalysisElementExactInput(executionInput, "selfCommitment")
      : candidateInputs.selfCommitment,
  });
}

/** 現在の要素別意味入力fingerprintを求める。 */
export function elementInputFingerprints(
  exactInputs: AnalysisElementExactInputMap,
): AnalysisElementInputFingerprintMap {
  return Object.freeze({
    status: exactInputs.status.fingerprint,
    waitingOn: exactInputs.waitingOn.fingerprint,
    nextAction: exactInputs.nextAction.fingerprint,
    relations: exactInputs.relations.fingerprint,
    progress: exactInputs.progress.fingerprint,
    importance: exactInputs.importance.fingerprint,
    deadline: exactInputs.deadline.fingerprint,
    notification: exactInputs.notification.fingerprint,
    selfCommitment: exactInputs.selfCommitment.fingerprint,
  });
}

/** 状態判定に属する要素かを返す。 */
export function isStateAnalysisElement(element: AiAnalysisElement): boolean {
  return element === "status" || element === "waitingOn" || element === "nextAction";
}

/** 現在の意味契約に対応する再利用証明を作る。 */
export function verifiedReuseProof(
  element: AiAnalysisElement,
  inputFingerprint: AiAnalysisElementInputFingerprint,
  dependencyFingerprint: AiAnalysisElementInputFingerprint,
  source: "current_generation" | "structural_migration" | "deterministic_update",
  compatibilityPath: readonly string[],
): AiAnalysisElementReuseProof {
  return aiAnalysisElementReuseProofSchema.parse({
    status: "verified",
    reuseSchemaVersion: "1",
    source,
    revision: AI_ANALYSIS_ELEMENT_REVISIONS[element],
    inputProjectionVersion: AI_ANALYSIS_ELEMENT_INPUT_PROJECTION_VERSIONS[element],
    inputFingerprint,
    dependencyFingerprint,
    compatibilityPath,
  });
}
