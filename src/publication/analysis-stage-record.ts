import { z } from "zod";

import {
  analysisRunStageNames,
  analysisRunStageSchema,
} from "../application/tracking-run/contracts/closed-values.js";
import { baseStateRevisionSchema } from "../application/tracking-run/contracts/run-core.js";

const digestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/u);

export const analysisStageRecordSchema = z
  .strictObject({
    schemaVersion: z.literal(2),
    runId: z.string().regex(/^tracker-run:[0-9a-f]{64}$/u),
    invocationId: z.uuid(),
    checkpointDigest: digestSchema,
    checkpointFileDigest: digestSchema,
    baseStateRevision: baseStateRevisionSchema,
    completedStages: z.array(analysisRunStageSchema).length(analysisRunStageNames.length),
    plannedLogicalCandidateCount: z.number().int().nonnegative(),
  })
  .refine(
    (record) =>
      record.completedStages.every((stage, index) => stage === analysisRunStageNames[index]),
    { message: "解析段階の実行記録がcanonical順序と一致しません" },
  );

/** 完了した解析段階だけをcheckpointへ結び付けた記録にする。 */
export function createAnalysisStageRecord(
  input: z.input<typeof analysisStageRecordSchema>,
): z.output<typeof analysisStageRecordSchema> {
  return analysisStageRecordSchema.parse(input);
}
