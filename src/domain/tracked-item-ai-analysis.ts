import type {
  AiAnalysisElement,
  AiAnalysisElementApplications,
  AiAnalysisElementMetadata,
  AiAnalysisElementMigrationResult,
  AiAnalysisElementReuseProof,
} from "./ai-analysis-elements.js";
import type { AiAnalysisElementSourceGeneration } from "./ai-analysis-source-generations.js";

/** 追跡項目へ保存する要素別AI分析結果。 */
export type TrackedItemAiAnalysisCurrentElement<
  Element extends AiAnalysisElement = AiAnalysisElement,
> = Readonly<{
  generation: AiAnalysisElementSourceGeneration<Element>;
  result: AiAnalysisElementMigrationResult<Element>;
  evaluationProof: AiAnalysisElementReuseProof;
}>;

/** 追跡項目へ保存する要素別AI分析結果。 */
export type TrackedItemAiAnalysisCurrentElements = Readonly<{
  [Element in AiAnalysisElement]?: TrackedItemAiAnalysisCurrentElement<Element>;
}>;

/** 採用済みの現在形式AI判定要素。 */
export type TrackedItemAiAnalysisCurrentAdoptedElement<
  Element extends AiAnalysisElement = AiAnalysisElement,
> = Readonly<{
  origin: "current";
  result: AiAnalysisElementMigrationResult<Element>;
  generation: AiAnalysisElementSourceGeneration<Element>;
  reuseProof: AiAnalysisElementReuseProof;
}>;

/** 採用済みの現在形式AI判定要素一覧。 */
export type TrackedItemAiAnalysisCurrentAdoptedElements = Readonly<{
  [Element in AiAnalysisElement]?: TrackedItemAiAnalysisCurrentAdoptedElement<Element>;
}>;

export type TrackedItemAiAnalysisMigrationElements = Readonly<{
  [Element in AiAnalysisElement]?: AiAnalysisElementMigrationResult<Element>;
}>;

export type TrackedItemAiAnalysisMigrationAdoptedElement<
  Element extends AiAnalysisElement = AiAnalysisElement,
> =
  | Readonly<{
      origin: "current";
      generation: AiAnalysisElementSourceGeneration<Element>;
      result: AiAnalysisElementMigrationResult<Element>;
      reuseProof: AiAnalysisElementReuseProof;
    }>
  | Readonly<{
      origin: "migration";
      result: AiAnalysisElementMigrationResult<Element>;
      reuseProof: AiAnalysisElementReuseProof;
    }>;

export type TrackedItemAiAnalysisMigrationAdoptedElements = Readonly<{
  [Element in AiAnalysisElement]?: TrackedItemAiAnalysisMigrationAdoptedElement<Element>;
}>;

type TrackedItemAiAnalysisStatus =
  "used" | "failed" | "deferred" | "not_required" | "disabled" | "not_recorded";

/** 追跡項目へ保存するAI判定要素ごとの最終適用元。 */
export type TrackedItemAiAnalysisApplications = AiAnalysisElementApplications;

/** 追跡項目へ保存する要素別AI分析結果と生成元。 */
export type TrackedItemAiAnalysis =
  | Readonly<{
      origin: "current";
      status: TrackedItemAiAnalysisStatus;
      elements: TrackedItemAiAnalysisCurrentElements;
      adoptedElements: TrackedItemAiAnalysisCurrentAdoptedElements;
      retainedElements: TrackedItemAiAnalysisMigrationAdoptedElements;
      applications: TrackedItemAiAnalysisApplications;
    }>
  | Readonly<{
      origin: "migration";
      status: TrackedItemAiAnalysisStatus;
      elements: TrackedItemAiAnalysisCurrentElements;
      adoptedElements: TrackedItemAiAnalysisCurrentAdoptedElements;
      retainedElements: TrackedItemAiAnalysisMigrationAdoptedElements;
      applications: TrackedItemAiAnalysisApplications;
    }>;

/** Codex分析要素を再現するための実行設定、hash、生成時刻。 */
export type AnalysisMetadata = AiAnalysisElementMetadata;
