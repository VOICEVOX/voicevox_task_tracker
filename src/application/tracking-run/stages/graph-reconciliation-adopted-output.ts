import { z } from "zod";
import {
  createAiAnalysisMigrationElementResultSchema,
  type AiAnalysisElementMigrationResult,
} from "../../../domain/ai-analysis-elements.js";
import type {
  GenericAiElementAdoption,
  GenericAiItemAdoption,
} from "./generic-ai-adoption-contracts.js";

/** 項目再判定へ渡す採用済み要素の値。 */
export type GraphAdoptedOutput = Readonly<{
  status: AiAnalysisElementMigrationResult<"status"> | undefined;
  waitingOn: AiAnalysisElementMigrationResult<"waitingOn"> | undefined;
  nextAction: AiAnalysisElementMigrationResult<"nextAction"> | undefined;
  relations: AiAnalysisElementMigrationResult<"relations"> | undefined;
  progress: AiAnalysisElementMigrationResult<"progress"> | undefined;
  importance: AiAnalysisElementMigrationResult<"importance"> | undefined;
  deadline: AiAnalysisElementMigrationResult<"deadline"> | undefined;
  notification: AiAnalysisElementMigrationResult<"notification"> | undefined;
  selfCommitment: AiAnalysisElementMigrationResult<"selfCommitment"> | undefined;
}>;

function adoptedResult<Result>(
  record: GenericAiElementAdoption,
  schema: z.ZodType<Result>,
): Result | undefined {
  return record.adopted.status === "ai" ? schema.parse(record.adopted.result) : undefined;
}

/** 汎用AIの採用済み要素だけを再判定用に投影する。 */
export function adoptedOutput(item: GenericAiItemAdoption): GraphAdoptedOutput {
  const records = item.elements;
  return Object.freeze({
    status: adoptedResult(records.status, createAiAnalysisMigrationElementResultSchema("status")),
    waitingOn: adoptedResult(
      records.waitingOn,
      createAiAnalysisMigrationElementResultSchema("waitingOn"),
    ),
    nextAction: adoptedResult(
      records.nextAction,
      createAiAnalysisMigrationElementResultSchema("nextAction"),
    ),
    relations: adoptedResult(
      records.relations,
      createAiAnalysisMigrationElementResultSchema("relations"),
    ),
    progress: adoptedResult(
      records.progress,
      createAiAnalysisMigrationElementResultSchema("progress"),
    ),
    importance: adoptedResult(
      records.importance,
      createAiAnalysisMigrationElementResultSchema("importance"),
    ),
    deadline: adoptedResult(
      records.deadline,
      createAiAnalysisMigrationElementResultSchema("deadline"),
    ),
    notification: adoptedResult(
      records.notification,
      createAiAnalysisMigrationElementResultSchema("notification"),
    ),
    selfCommitment: adoptedResult(
      records.selfCommitment,
      createAiAnalysisMigrationElementResultSchema("selfCommitment"),
    ),
  });
}
