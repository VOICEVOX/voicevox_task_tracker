import { z } from "zod";

import {
  aiAnalysisElementRevisionSchema,
  type AiAnalysisElement,
  type AiAnalysisElementMigrationResult,
} from "../domain/ai-analysis-elements.js";

export {
  AI_ANALYSIS_ELEMENT_SCHEMA_VERSION,
  AI_ANALYSIS_ELEMENTS,
  aiAnalysisElementEvidenceSchema,
  aiAnalysisElementFingerprintSchema,
  aiAnalysisElementGenerationSchema,
  aiAnalysisElementMetadataSchema,
  aiAnalysisElementNecessitySchema,
  aiAnalysisElementRevisionSchema,
  aiAnalysisElementResultSchema,
  aiAnalysisElementSchema,
  aiAnalysisMigrationWaitingOnSchema,
  aiAnalysisDeadlineSchema,
  aiAnalysisImportanceSchema,
  aiAnalysisNextActionSchema,
  aiAnalysisNotificationReasonCodeSchema,
  aiAnalysisNotificationSchema,
  aiAnalysisProgressSchema,
  aiAnalysisRelationVerdictSchema,
  aiAnalysisRelationsSchema,
  aiAnalysisReasoningEffortSchema,
  aiAnalysisStatusSchema,
  aiAnalysisWaitingOnKindSchema,
  aiAnalysisWaitingOnRoleSchema,
  aiAnalysisWaitingOnSchema,
  createAiAnalysisElementGeneration,
  createAiAnalysisElementGenerationSchema,
  createAiAnalysisElementResultSchema,
  createAiAnalysisElementValueSchema,
  createAiAnalysisMigrationElementResultSchema,
} from "../domain/ai-analysis-elements.js";
export type {
  AiAnalysisElement,
  AiAnalysisElementEvidence,
  AiAnalysisElementExecutionFingerprint,
  AiAnalysisElementGeneration,
  AiAnalysisElementInputFingerprint,
  AiAnalysisElementMetadata,
  AiAnalysisElementMigrationResult,
  AiAnalysisElementNecessity,
  AiAnalysisElementResult,
  AiAnalysisElementValue,
  AiAnalysisDeadline,
  AiAnalysisImportance,
  AiAnalysisNextAction,
  AiAnalysisNotification,
  AiAnalysisNotificationReasonCode,
  AiAnalysisProgress,
  AiAnalysisRelation,
  AiAnalysisRelations,
  AiAnalysisRelationVerdict,
  AiAnalysisReasoningEffort,
  AiAnalysisStatus,
  AiAnalysisWaitingOn,
  AiAnalysisWaitingOnKind,
  AiAnalysisWaitingOnRole,
  AiAnalysisWaitingOnValue,
  AiAnalysisMigrationWaitingOnValue,
} from "../domain/ai-analysis-elements.js";

/** 保存済みの要素別full result。 */
export type CodexPreservedElements = Readonly<
  Partial<Record<AiAnalysisElement, AiAnalysisElementMigrationResult>>
>;
export {
  aiAnalysisElementFingerprintSchema as analysisElementFingerprintSchema,
  aiAnalysisElementNecessitySchema as analysisElementNecessitySchema,
  type AiAnalysisElement as AnalysisElement,
  type AiAnalysisElementEvidence as AnalysisElementEvidence,
  type AiAnalysisElementExecutionFingerprint as AnalysisElementExecutionFingerprint,
  type AiAnalysisElementGeneration as AnalysisElementGeneration,
  type AiAnalysisElementInputFingerprint as AnalysisElementInputFingerprint,
  type AiAnalysisElementNecessity as AnalysisElementNecessity,
  type AiAnalysisElementResult as AnalysisElementResult,
  type AiAnalysisElementValue as AnalysisElementValue,
} from "../domain/ai-analysis-elements.js";

/** AI判定要素の現在の規則revision。 */
export const AI_ANALYSIS_ELEMENT_REVISIONS = Object.freeze({
  status: 1,
  waitingOn: 2,
  nextAction: 1,
  relations: 1,
  progress: 1,
  importance: 1,
  deadline: 1,
  notification: 1,
} satisfies Readonly<Record<AiAnalysisElement, number>>);

/** AI判定要素の規則revisionを表す型。 */
export type AnalysisElementRevision = z.output<typeof aiAnalysisElementRevisionSchema>;
