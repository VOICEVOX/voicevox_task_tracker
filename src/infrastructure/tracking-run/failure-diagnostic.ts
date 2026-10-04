import { z } from "zod";

import type { FailureDiagnosticState } from "../../application/tracking-run/failure-artifact.js";
import type { DiagnosticsJsonlRecorder } from "../../diagnostics/recorder.js";

const recordIdSchema = z.string().regex(/^[A-Za-z0-9._:-]{1,200}$/u);

/** 既存の暗号化対象診断へ記録済みの失敗を示す。 */
export class RecordedFailureError extends Error {
  public readonly diagnosticRecordIds: readonly [string, ...string[]];

  public constructor(state: Extract<FailureDiagnosticState, { kind: "recorded" }>) {
    super("追跡runの失敗は診断へ記録済みです", { cause: state.error });
    this.diagnosticRecordIds = state.recordIds;
  }
}

/** 未記録の元エラーだけを既存診断recorderへ一度記録する。 */
export async function recordFailureDiagnostic(
  recorder: DiagnosticsJsonlRecorder,
  state: FailureDiagnosticState,
  recordId: string,
): Promise<Extract<FailureDiagnosticState, { kind: "recorded" }>> {
  if (state.kind === "recorded") {
    return state;
  }
  const checkedId = recordIdSchema.parse(recordId);
  await recorder.append({
    event: "tracking_run.failed",
    details: { recordId: checkedId },
    error: state.error,
  });
  return Object.freeze({ kind: "recorded", error: state.error, recordIds: [checkedId] });
}
