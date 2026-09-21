import { hashCanonicalJson } from "../canonical-json/index.js";
import {
  aiAnalysisElementReuseProofSchema,
  createAiAnalysisMigrationElementResultSchema,
  type AiAnalysisElement,
  type AiAnalysisElementInputFingerprint,
  type AiAnalysisElementMigrationResult,
  type AiAnalysisElementReuseProof,
} from "../domain/ai-analysis-elements.js";
import { type AiAnalysisElementSourceGeneration } from "../domain/ai-analysis-source-generations.js";
import { assertNonNullable, UnreachableError } from "../util/index.js";
import {
  AI_ANALYSIS_ELEMENT_INPUT_PROJECTION_VERSIONS,
  AI_ANALYSIS_ELEMENT_REVISIONS,
  type AnalysisElementReuseRecord,
} from "./analysis-elements.js";
import {
  assessAnalysisImpact,
  type AnalysisImpactAssessment,
  type AnalysisImpactCurrentInputProjection,
  type AnalysisImpactDeclaration,
  type AnalysisImpactRecord,
  type AnalysisImpactValue,
  type AnalysisImpactVersion,
} from "./analysis-impact.js";
import { type CodexAnalysisInput } from "./input.js";

/** 要素ごとの意味入力fingerprint。 */
export type AnalysisElementInputFingerprintMap = Readonly<
  Record<AiAnalysisElement, AiAnalysisElementInputFingerprint>
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

type AnalysisImpactInputProjectionContext = Readonly<{
  input: CodexAnalysisInput;
  dependencyFingerprints: AnalysisElementDependencyFingerprintMap;
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

type AnalysisImpactInputProjectionProjector = (
  context: AnalysisImpactInputProjectionContext,
) => AnalysisImpactCurrentInputProjection;

function createAnalysisImpactInputProjectionProjector(
  element: AiAnalysisElement,
  inputProjectionVersion: number,
): AnalysisImpactInputProjectionProjector {
  return ({ input, dependencyFingerprints }) =>
    Object.freeze({
      inputProjectionVersion,
      fingerprint: analysisImpactInputFingerprintV1(input, element),
      dependencyFingerprint: dependencyFingerprints[element],
    });
}

const ANALYSIS_IMPACT_INPUT_PROJECTORS: Readonly<
  Record<AiAnalysisElement, Readonly<Record<number, AnalysisImpactInputProjectionProjector>>>
> = Object.freeze({
  status: Object.freeze({
    1: createAnalysisImpactInputProjectionProjector("status", 1),
  }),
  waitingOn: Object.freeze({
    1: createAnalysisImpactInputProjectionProjector("waitingOn", 1),
  }),
  nextAction: Object.freeze({
    1: createAnalysisImpactInputProjectionProjector("nextAction", 1),
  }),
  relations: Object.freeze({
    1: createAnalysisImpactInputProjectionProjector("relations", 1),
  }),
  progress: Object.freeze({
    1: createAnalysisImpactInputProjectionProjector("progress", 1),
  }),
  importance: Object.freeze({
    1: createAnalysisImpactInputProjectionProjector("importance", 1),
  }),
  deadline: Object.freeze({
    1: createAnalysisImpactInputProjectionProjector("deadline", 1),
  }),
  notification: Object.freeze({
    1: createAnalysisImpactInputProjectionProjector("notification", 1),
  }),
  selfCommitment: Object.freeze({
    1: createAnalysisImpactInputProjectionProjector("selfCommitment", 1),
  }),
});

function analysisImpactInputProjection(
  element: AiAnalysisElement,
  version: AnalysisImpactVersion,
  input: CodexAnalysisInput,
  dependencyFingerprints: AnalysisElementDependencyFingerprintMap,
): AnalysisImpactCurrentInputProjection | undefined {
  return ANALYSIS_IMPACT_INPUT_PROJECTORS[element][version.inputProjectionVersion]?.(
    Object.freeze({ input, dependencyFingerprints }),
  );
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

function codexNaturalLanguageSources(input: CodexAnalysisInput): readonly object[] {
  return input.sources.filter(
    (source) => source.kind === "body" || source.kind === "comment" || source.kind === "review",
  );
}

function codexRelationSources(input: CodexAnalysisInput): readonly object[] {
  return input.sources.filter((source) => source.kind === "relation");
}

function codexTextItem(input: CodexAnalysisInput): Readonly<Record<string, unknown>> {
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

function deterministicSignalProjection(
  signals: Readonly<Record<string, unknown>>,
  keys: readonly string[],
): Readonly<Record<string, unknown>> {
  const projection: Record<string, unknown> = {};
  for (const key of keys) {
    if (Object.hasOwn(signals, key)) {
      projection[key] = signals[key];
    }
  }
  return Object.freeze(projection);
}

function analysisImpactInputFingerprintV1(
  input: CodexAnalysisInput,
  element: AiAnalysisElement,
): AiAnalysisElementInputFingerprint {
  const naturalLanguageSources = codexNaturalLanguageSources(input);
  const relationSources = [...codexRelationSources(input), ...naturalLanguageSources];
  const stateInput = {
    item: input.item,
    candidates: input.candidates.waitingOn,
    sources: naturalLanguageSources,
    deterministicSignals: deterministicSignalProjection(input.deterministicSignals, [
      "status",
      "waitingOn",
      "requiredCheckFailure",
      "effectiveAssigneeCandidates",
      "effectiveAssigneeImplementations",
      "mentionedWaitingOnCandidates",
      "uncertainties",
    ]),
  };
  const relationInput = {
    item: codexTextItem(input),
    candidates: input.candidates.relations,
    sources: relationSources,
    deterministicSignals: deterministicSignalProjection(input.deterministicSignals, [
      "relationCandidateIds",
      "nativeBlockedBy",
      "nativeBlocking",
      "nativeParent",
      "nativeSubIssues",
    ]),
  };
  const textInput = {
    item: codexTextItem(input),
    sources: naturalLanguageSources,
  };
  const notificationInput = {
    item: codexTextItem(input),
    candidates: input.candidates,
    sources: naturalLanguageSources,
    deterministicSignals: deterministicSignalProjection(input.deterministicSignals, [
      "status",
      "waitingOn",
      "requiredCheckFailure",
      "effectiveAssigneeCandidates",
      "effectiveAssigneeImplementations",
      "mentionedWaitingOnCandidates",
      "uncertainties",
    ]),
  };
  switch (element) {
    case "status":
    case "waitingOn":
    case "nextAction":
      return hashCanonicalJson(stateInput);
    case "relations":
      return hashCanonicalJson(relationInput);
    case "progress":
    case "importance":
    case "deadline":
      return hashCanonicalJson(textInput);
    case "notification":
      return hashCanonicalJson(notificationInput);
    case "selfCommitment":
      return hashCanonicalJson({
        item: input.item,
        candidates: input.selfCommitmentCandidates,
        sources: naturalLanguageSources,
      });
    default:
      throw new UnreachableError(element);
  }
}

/** 現在の要素別意味入力fingerprintを求める。 */
export function elementInputFingerprints(
  input: CodexAnalysisInput,
  dependencyFingerprints: AnalysisElementDependencyFingerprintMap,
): AnalysisElementInputFingerprintMap {
  const fingerprintFor = (element: AiAnalysisElement): AiAnalysisElementInputFingerprint => {
    const projection = analysisImpactInputProjection(
      element,
      analysisImpactTargetVersion(element),
      input,
      dependencyFingerprints,
    );
    assertNonNullable(projection, `AI判定要素の入力投影がありません。対象: ${element}`);
    return projection.fingerprint;
  };
  return Object.freeze({
    status: fingerprintFor("status"),
    waitingOn: fingerprintFor("waitingOn"),
    nextAction: fingerprintFor("nextAction"),
    relations: fingerprintFor("relations"),
    progress: fingerprintFor("progress"),
    importance: fingerprintFor("importance"),
    deadline: fingerprintFor("deadline"),
    notification: fingerprintFor("notification"),
    selfCommitment: fingerprintFor("selfCommitment"),
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
