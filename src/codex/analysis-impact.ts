import { z } from "zod";

import {
  aiAnalysisElementFingerprintSchema,
  aiAnalysisElementReuseProofSchema,
  aiAnalysisElementSchema,
  type AiAnalysisElement,
  type AiAnalysisElementReuseProof,
} from "../domain/ai-analysis-elements.js";
import { UnreachableError } from "../util/index.js";

const analysisImpactVersionSchema = z.strictObject({
  revision: z.number().int().positive("revisionは正の整数にしてください"),
  inputProjectionVersion: z
    .number()
    .int()
    .positive("input projection versionは正の整数にしてください"),
});

const analysisImpactIdentifierSchema = z
  .string()
  .min(1, "識別子は空にできません")
  .regex(/^\S+$/u, "識別子に空白は使えません");

const analysisImpactReasonSchema = z.string().min(1);

const analysisImpactCurrentInputProjectionSchema = z.strictObject({
  inputProjectionVersion: z
    .number()
    .int()
    .positive("input projection versionは正の整数にしてください"),
  fingerprint: aiAnalysisElementFingerprintSchema,
  dependencyFingerprint: aiAnalysisElementFingerprintSchema,
});

/** 要素の意味変更が与える影響。 */
export const analysisImpactSchema = z.enum([
  "unaffected",
  "deterministic",
  "interpretation_required",
  "unknown",
]);

/** 要素の意味変更が与える影響。 */
export type AnalysisImpact = z.output<typeof analysisImpactSchema>;

/** 要素の意味契約のversion。 */
export type AnalysisImpactVersion = z.output<typeof analysisImpactVersionSchema>;

/** 採用済みまたは正常評価済みの要素値。 */
export type AnalysisImpactValue<Result> =
  | Readonly<{
      status: "present";
      result: Result;
    }>
  | Readonly<{
      status: "absent";
      reason: "not_adopted" | "not_evaluated" | "not_available";
    }>;

/** 現在の関連入力から再計算した要素入力projection。 */
export type AnalysisImpactCurrentInputProjection = z.output<
  typeof analysisImpactCurrentInputProjectionSchema
>;

/** 変更経路を評価する一つの要素記録。 */
export type AnalysisImpactRecord<Result, RelatedInput> = Readonly<{
  element: AiAnalysisElement;
  role: "adopted" | "evaluated";
  sourceVersion: AnalysisImpactVersion;
  targetVersion: AnalysisImpactVersion;
  adoptedResult: AnalysisImpactValue<Result>;
  evaluatedResult: AnalysisImpactValue<Result>;
  currentSourceInputProjection: AnalysisImpactCurrentInputProjection;
  currentTargetInputProjection: AnalysisImpactCurrentInputProjection;
  reuseProof: AiAnalysisElementReuseProof;
  relatedInput: RelatedInput;
}>;

/** 宣言のassessへ渡す現在の要素記録。 */
export type AnalysisImpactAssessContext<Result, RelatedInput> = Readonly<
  AnalysisImpactRecord<Result, RelatedInput> & {
    currentVersion: AnalysisImpactVersion;
    currentResult: AnalysisImpactValue<Result>;
  }
>;

/** 宣言の意味影響評価。deterministicのresultは呼び出し側が要素別schemaで検証する。 */
export type AnalysisImpactAssessment<Result> =
  | Readonly<{
      impact: "unaffected";
    }>
  | Readonly<{
      impact: "deterministic";
      result: Result;
    }>
  | Readonly<{
      impact: "interpretation_required";
    }>
  | Readonly<{
      impact: "unknown";
      reason: string;
    }>;

/** 要素の意味変更を現在の契約へつなぐ宣言。 */
export type AnalysisImpactDeclaration<Result, RelatedInput> = Readonly<{
  element: AiAnalysisElement;
  changeId: string;
  from: AnalysisImpactVersion;
  to: AnalysisImpactVersion;
  assess: (
    context: AnalysisImpactAssessContext<Result, RelatedInput>,
  ) => AnalysisImpactAssessment<Result>;
}>;

/** 変更経路を評価した要素値。resultがabsentなら評価完了とみなさず、target projectionは次のproofへ渡す。 */
export type AnalysisImpactDecision<Result> =
  | Readonly<{
      impact: "unaffected";
      role: "adopted" | "evaluated";
      sourceVersion: AnalysisImpactVersion;
      targetVersion: AnalysisImpactVersion;
      result: AnalysisImpactValue<Result>;
      currentTargetInputProjection: AnalysisImpactCurrentInputProjection;
      compatibilityPath: readonly string[];
    }>
  | Readonly<{
      impact: "deterministic";
      role: "adopted" | "evaluated";
      sourceVersion: AnalysisImpactVersion;
      targetVersion: AnalysisImpactVersion;
      result: Readonly<{
        status: "present";
        result: Result;
      }>;
      currentTargetInputProjection: AnalysisImpactCurrentInputProjection;
      compatibilityPath: readonly string[];
    }>
  | Readonly<{
      impact: "interpretation_required";
      role: "adopted" | "evaluated";
      sourceVersion: AnalysisImpactVersion;
      targetVersion: AnalysisImpactVersion;
      result: Readonly<{
        status: "absent";
        reason: "not_available";
      }>;
      currentTargetInputProjection: AnalysisImpactCurrentInputProjection;
      compatibilityPath: readonly string[];
    }>
  | Readonly<{
      impact: "unknown";
      role: "adopted" | "evaluated";
      sourceVersion: AnalysisImpactVersion;
      targetVersion: AnalysisImpactVersion;
      result: Readonly<{
        status: "absent";
        reason: "not_available";
      }>;
      currentTargetInputProjection: AnalysisImpactCurrentInputProjection;
      reason: string;
      compatibilityPath: readonly string[];
    }>;

function parseVersion(value: AnalysisImpactVersion): AnalysisImpactVersion {
  return analysisImpactVersionSchema.parse(value);
}

function parseIdentifier(value: string): string {
  return analysisImpactIdentifierSchema.parse(value);
}

function parseReason(value: string): string {
  return analysisImpactReasonSchema.parse(value);
}

function parseElement(value: AiAnalysisElement): AiAnalysisElement {
  return aiAnalysisElementSchema.parse(value);
}

function validateInputProjection(value: AnalysisImpactCurrentInputProjection): void {
  analysisImpactCurrentInputProjectionSchema.parse(value);
}

function validateReuseProof(value: AiAnalysisElementReuseProof): void {
  aiAnalysisElementReuseProofSchema.parse(value);
}

function versionsEqual(left: AnalysisImpactVersion, right: AnalysisImpactVersion): boolean {
  return (
    left.revision === right.revision && left.inputProjectionVersion === right.inputProjectionVersion
  );
}

function currentInputProjectionVersionsMatchRecord<Result, RelatedInput>(
  record: AnalysisImpactRecord<Result, RelatedInput>,
): boolean {
  return (
    record.currentSourceInputProjection.inputProjectionVersion ===
      record.sourceVersion.inputProjectionVersion &&
    record.currentTargetInputProjection.inputProjectionVersion ===
      record.targetVersion.inputProjectionVersion
  );
}

function reuseProofMatchesCurrentSourceProjection<Result, RelatedInput>(
  record: AnalysisImpactRecord<Result, RelatedInput>,
): boolean {
  return (
    record.reuseProof.status === "verified" &&
    record.reuseProof.revision === record.sourceVersion.revision &&
    record.reuseProof.inputProjectionVersion ===
      record.currentSourceInputProjection.inputProjectionVersion &&
    record.reuseProof.inputFingerprint === record.currentSourceInputProjection.fingerprint &&
    record.reuseProof.dependencyFingerprint ===
      record.currentSourceInputProjection.dependencyFingerprint
  );
}

function validateDeclaration<Result, RelatedInput>(
  declaration: AnalysisImpactDeclaration<Result, RelatedInput>,
  element: AiAnalysisElement,
): void {
  if (parseElement(declaration.element) !== element) {
    throw new TypeError("変更宣言の要素が評価対象と一致しません");
  }
  parseIdentifier(declaration.changeId);
  parseVersion(declaration.from);
  parseVersion(declaration.to);
}

function unknownDecision<Result, RelatedInput>(
  record: AnalysisImpactRecord<Result, RelatedInput>,
  reason: string,
  compatibilityPath: readonly string[],
): AnalysisImpactDecision<Result> {
  return Object.freeze({
    impact: "unknown",
    role: record.role,
    sourceVersion: record.sourceVersion,
    targetVersion: record.targetVersion,
    result: Object.freeze({ status: "absent", reason: "not_available" }),
    currentTargetInputProjection: record.currentTargetInputProjection,
    reason,
    compatibilityPath: Object.freeze([...compatibilityPath]),
  });
}

function currentResultForRole<Result, RelatedInput>(
  record: AnalysisImpactRecord<Result, RelatedInput>,
): AnalysisImpactValue<Result> {
  switch (record.role) {
    case "adopted":
      return record.adoptedResult;
    case "evaluated":
      return record.evaluatedResult;
    default:
      throw new UnreachableError(record.role);
  }
}

function validateAssessment<Result>(value: AnalysisImpactAssessment<Result>): void {
  switch (value.impact) {
    case "unaffected":
    case "deterministic":
    case "interpretation_required":
      return;
    case "unknown":
      parseReason(value.reason);
      return;
    default:
      throw new UnreachableError(value);
  }
}

/** 既知の変更経路を順に評価し、一つの要素記録の影響を返す。 */
export function assessAnalysisImpact<Result, RelatedInput>(
  record: AnalysisImpactRecord<Result, RelatedInput>,
  declarations: readonly AnalysisImpactDeclaration<Result, RelatedInput>[],
): AnalysisImpactDecision<Result> {
  const sourceVersion = parseVersion(record.sourceVersion);
  const targetVersion = parseVersion(record.targetVersion);
  validateInputProjection(record.currentSourceInputProjection);
  validateInputProjection(record.currentTargetInputProjection);
  validateReuseProof(record.reuseProof);
  if (!currentInputProjectionVersionsMatchRecord(record)) {
    return unknownDecision(
      record,
      "input projectionのversionが要素記録のversionと一致しません",
      [],
    );
  }
  if (declarations.length === 0) {
    return unknownDecision(record, "現在の意味契約へつながる変更経路がありません", []);
  }

  let currentVersion = sourceVersion;
  let currentResult = currentResultForRole(record);
  let impact: "unaffected" | "deterministic" = "unaffected";
  let interpretationRequired = false;
  const compatibilityPath: string[] = [];

  for (const declaration of declarations) {
    validateDeclaration(declaration, record.element);
    compatibilityPath.push(declaration.changeId);
    if (!versionsEqual(declaration.from, currentVersion)) {
      return unknownDecision(
        record,
        `変更経路のfrom versionが直前のversionと一致しません。対象: ${declaration.changeId}`,
        compatibilityPath,
      );
    }

    const assessment = declaration.assess({
      ...record,
      currentVersion,
      currentResult,
    });
    validateAssessment(assessment);
    switch (assessment.impact) {
      case "unaffected":
        if (
          !interpretationRequired &&
          currentResult.status === "present" &&
          !reuseProofMatchesCurrentSourceProjection(record)
        ) {
          return unknownDecision(
            record,
            "元のinput projectionに対応するreuse proofがありません",
            compatibilityPath,
          );
        }
        currentVersion = declaration.to;
        break;
      case "deterministic":
        impact = "deterministic";
        if (currentResult.status !== "present") {
          if (!interpretationRequired) {
            return unknownDecision(
              record,
              "採用済みまたは正常評価済みresultがないため決定論的変換を適用できません",
              compatibilityPath,
            );
          }
          currentVersion = declaration.to;
          break;
        }
        if (!interpretationRequired && !reuseProofMatchesCurrentSourceProjection(record)) {
          return unknownDecision(
            record,
            "元のinput projectionに対応するreuse proofがありません",
            compatibilityPath,
          );
        }
        currentResult = Object.freeze({ status: "present", result: assessment.result });
        currentVersion = declaration.to;
        break;
      case "interpretation_required":
        interpretationRequired = true;
        currentResult = Object.freeze({ status: "absent", reason: "not_available" });
        currentVersion = declaration.to;
        break;
      case "unknown":
        return unknownDecision(record, assessment.reason, compatibilityPath);
      default:
        throw new UnreachableError(assessment);
    }
  }

  if (!versionsEqual(currentVersion, targetVersion)) {
    return unknownDecision(record, "変更経路がtarget versionへ到達していません", compatibilityPath);
  }
  if (interpretationRequired) {
    return Object.freeze({
      impact: "interpretation_required",
      role: record.role,
      sourceVersion,
      targetVersion,
      result: Object.freeze({ status: "absent", reason: "not_available" }),
      currentTargetInputProjection: record.currentTargetInputProjection,
      compatibilityPath: Object.freeze([...compatibilityPath]),
    });
  }
  if (impact === "unaffected") {
    return Object.freeze({
      impact,
      role: record.role,
      sourceVersion,
      targetVersion,
      result: currentResult,
      currentTargetInputProjection: record.currentTargetInputProjection,
      compatibilityPath: Object.freeze([...compatibilityPath]),
    });
  }
  if (currentResult.status === "absent") {
    return unknownDecision(record, "決定論的変換後のresultがありません", compatibilityPath);
  }
  return Object.freeze({
    impact: "deterministic",
    role: record.role,
    sourceVersion,
    targetVersion,
    result: currentResult,
    currentTargetInputProjection: record.currentTargetInputProjection,
    compatibilityPath: Object.freeze([...compatibilityPath]),
  });
}
