import { z } from "zod";

import { createUtcIsoDateTime, type UtcIsoDateTime } from "../../../domain/types.js";

const runEvaluatedAtSchema = z.string().transform(createUtcIsoDateTime).brand<"RunEvaluatedAt">();

/** 収集完了後に一度だけ固定するrun評価時刻。 */
export type RunEvaluatedAt = z.output<typeof runEvaluatedAtSchema>;

/** 収集完了後の時計値をrun評価時刻へ固定する。 */
export function createRunEvaluatedAt(value: UtcIsoDateTime): RunEvaluatedAt {
  return runEvaluatedAtSchema.parse(value);
}
