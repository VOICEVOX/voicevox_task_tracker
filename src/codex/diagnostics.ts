import type { DiagnosticsJsonlRecorder } from "../diagnostics/recorder.js";
import type {
  DiagnosticsJsonObject,
  DiagnosticsJsonValue,
} from "../diagnostics/error-serializer.js";

/** Codex診断へ付与するrunと候補の識別情報。 */
export type CodexDiagnosticsContext = Readonly<{
  recorder: DiagnosticsJsonlRecorder;
  runId?: string;
  invocationId?: string;
  candidateId?: string;
}>;

function identifierDetails(context: CodexDiagnosticsContext): DiagnosticsJsonObject {
  const details: Record<string, DiagnosticsJsonValue> = {};
  if (context.runId != null) {
    details["runId"] = context.runId;
  }
  if (context.invocationId != null) {
    details["invocationId"] = context.invocationId;
  }
  if (context.candidateId != null) {
    details["candidateId"] = context.candidateId;
  }
  return details;
}

/** Codex診断イベントを注入されたrecorderへ追記する。 */
export async function recordCodexDiagnostic(
  context: CodexDiagnosticsContext | undefined,
  event: string,
  details: Readonly<Record<string, DiagnosticsJsonValue>>,
  error?: unknown,
): Promise<void> {
  if (context == null) {
    return;
  }
  const mergedDetails = {
    ...identifierDetails(context),
    ...details,
  } satisfies DiagnosticsJsonObject;
  const hasError = arguments.length >= 4;
  try {
    await context.recorder.append({
      event,
      details: mergedDetails,
      ...(hasError ? { error } : {}),
    });
  } catch (recordingError: unknown) {
    if (!hasError) {
      throw recordingError;
    }
    throw new AggregateError([error, recordingError], "Codex診断の記録に失敗しました", {
      cause: error,
    });
  }
}
