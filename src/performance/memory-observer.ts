import { writeSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { getHeapStatistics } from "node:v8";
import { z } from "zod";

import { performanceDetailEventSchema } from "../application/tracking-run/contracts/performance-detail-observation.js";
import { runFailureStageSchema } from "../application/tracking-run/failure-artifact.js";
import { initialStateCommitStepSchema } from "../infrastructure/tracking-run/initial-state-commit-progress.js";

const phaseSchema = z.enum(["baseline", "second"]);
const observationEventSchema = z.discriminatedUnion("boundary", [
  z.strictObject({
    phase: phaseSchema,
    boundary: z.literal("initial_state_commit"),
    step: initialStateCommitStepSchema,
  }),
  performanceDetailEventSchema.extend({ phase: phaseSchema, boundary: z.literal("detail") }),
  z.strictObject({ phase: phaseSchema, boundary: z.enum(["begin", "success"]) }),
  z.strictObject({
    phase: phaseSchema,
    boundary: z.literal("stage"),
    stage: runFailureStageSchema,
  }),
]);

/** 性能計測のrun境界またはcanonical stage開始を表す。 */
export type PerformanceMemoryEvent = z.input<typeof observationEventSchema>;

/** 固定した分類とメモリ数値だけを同期stderrへ記録する。 */
export function createPerformanceMemoryObserver(): (event: PerformanceMemoryEvent) => void {
  const startedAt = performance.now();
  return (event) => {
    const checkedEvent = observationEventSchema.parse(event);
    const memory = process.memoryUsage();
    writeSync(
      process.stderr.fd,
      `${JSON.stringify({
        ...checkedEvent,
        elapsedMilliseconds: performance.now() - startedAt,
        heapUsedBytes: memory.heapUsed,
        heapTotalBytes: memory.heapTotal,
        externalBytes: memory.external,
        arrayBuffersBytes: memory.arrayBuffers,
        rssBytes: memory.rss,
        heapSizeLimitBytes: getHeapStatistics().heap_size_limit,
      })}\n`,
    );
  };
}
