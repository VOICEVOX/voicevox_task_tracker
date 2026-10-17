import {
  type AiAnalysisElement,
  type AiAnalysisElementMigrationResult,
  type AiAnalysisElementReuseProof,
} from "../domain/ai-analysis-elements.js";

export {
  AI_ANALYSIS_ELEMENT_SCHEMA_VERSION,
  AI_ANALYSIS_ELEMENTS,
  AI_ANALYSIS_REUSE_PROOF_SCHEMA_VERSION,
  aiAnalysisDeadlineSchema,
  aiAnalysisElementEvidenceSchema,
  aiAnalysisElementFingerprintSchema,
  aiAnalysisElementGenerationSchema,
  aiAnalysisElementMetadataSchema,
  aiAnalysisElementNecessitySchema,
  aiAnalysisElementResultSchema,
  aiAnalysisElementReuseProofSchema,
  aiAnalysisElementRevisionSchema,
  aiAnalysisElementSchema,
  aiAnalysisImportanceSchema,
  aiAnalysisMigrationWaitingOnSchema,
  aiAnalysisNextActionSchema,
  aiAnalysisNotificationReasonCodeSchema,
  aiAnalysisNotificationSchema,
  aiAnalysisProgressSchema,
  aiAnalysisReasoningEffortSchema,
  aiAnalysisRelationsSchema,
  aiAnalysisRelationVerdictSchema,
  aiAnalysisSelfCommitmentSchema,
  aiAnalysisStatusSchema,
  aiAnalysisWaitingOnKindSchema,
  aiAnalysisWaitingOnRoleSchema,
  aiAnalysisWaitingOnSchema,
  aiAnalysisElementFingerprintSchema as analysisElementFingerprintSchema,
  aiAnalysisElementNecessitySchema as analysisElementNecessitySchema,
  createAiAnalysisElementGeneration,
  createAiAnalysisElementGenerationSchema,
  createAiAnalysisElementResultSchema,
  createAiAnalysisElementValueSchema,
  createAiAnalysisMigrationElementResultSchema,
  type AiAnalysisElement as AnalysisElement,
  type AiAnalysisElementEvidence as AnalysisElementEvidence,
  type AiAnalysisElementExecutionFingerprint as AnalysisElementExecutionFingerprint,
  type AiAnalysisElementInputFingerprint as AnalysisElementInputFingerprint,
  type AiAnalysisElementNecessity as AnalysisElementNecessity,
  type AiAnalysisElementResult as AnalysisElementResult,
  type AiAnalysisElementValue as AnalysisElementValue,
} from "../domain/ai-analysis-elements.js";
export type {
  AiAnalysisDeadline,
  AiAnalysisElement,
  AiAnalysisElementEvidence,
  AiAnalysisElementExecutionFingerprint,
  AiAnalysisElementGeneration,
  AiAnalysisElementInputFingerprint,
  AiAnalysisElementMetadata,
  AiAnalysisElementMigrationResult,
  AiAnalysisElementNecessity,
  AiAnalysisElementResult,
  AiAnalysisElementReuseProof,
  AiAnalysisElementValue,
  AiAnalysisImportance,
  AiAnalysisMigrationWaitingOnValue,
  AiAnalysisNextAction,
  AiAnalysisNotification,
  AiAnalysisNotificationReasonCode,
  AiAnalysisProgress,
  AiAnalysisReasoningEffort,
  AiAnalysisRelation,
  AiAnalysisRelations,
  AiAnalysisRelationVerdict,
  AiAnalysisSelfCommitment,
  AiAnalysisSelfCommitmentValue,
  AiAnalysisStatus,
  AiAnalysisWaitingOn,
  AiAnalysisWaitingOnKind,
  AiAnalysisWaitingOnRole,
  AiAnalysisWaitingOnValue,
} from "../domain/ai-analysis-elements.js";
export type {
  AiAnalysisElementSourceGeneration,
  AiAnalysisElementSourceGeneration as AnalysisElementSourceGeneration,
} from "../domain/ai-analysis-source-generations.js";

/** 要素別に保存したresultと、そのresultを再利用できる証明。 */
export type AnalysisElementReuseRecord<Element extends AiAnalysisElement = AiAnalysisElement> =
  Readonly<{
    result: AiAnalysisElementMigrationResult<Element>;
    proof: AiAnalysisElementReuseProof;
  }>;

/** 保存済みの要素別full result。 */
export type CodexPreservedElements = Readonly<
  Partial<Record<AiAnalysisElement, AiAnalysisElementMigrationResult>>
>;
