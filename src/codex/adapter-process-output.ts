import { readFile } from "node:fs/promises";

import { z } from "zod";

import type { DiagnosticsJsonValue } from "../diagnostics/error-serializer.js";
import { CodexInvalidJsonError } from "./errors.js";
import type { CodexApiErrorDiagnostic, CodexProcessRequest } from "./process-runner.js";

function createSafeJsonParseCause(error: unknown): Error {
  const errorName = error instanceof Error ? error.name : typeof error;
  return new Error(`Codex最終メッセージのJSON解析に失敗しました。エラー種別: ${errorName}`, {
    cause: error,
  });
}

export type LastMessageReadResult =
  | Readonly<{
      status: "read";
      source: string;
      value: unknown;
    }>
  | Readonly<{
      status: "read_failed" | "json_parse_failed";
      source: string;
      error: Error;
    }>;

export async function readLastMessage(
  request: CodexProcessRequest,
  attempts: number,
): Promise<LastMessageReadResult> {
  const outputPathIndex = request.arguments.indexOf("--output-last-message");
  const outputPath = request.arguments.at(outputPathIndex + 1);
  if (outputPathIndex < 0 || outputPath == null) {
    throw new TypeError("Codex CLI引数に最終メッセージの出力先がありません");
  }

  let source: string;
  try {
    source = await readFile(outputPath, "utf8");
  } catch (error: unknown) {
    return {
      status: "read_failed",
      source: "",
      error: new CodexInvalidJsonError(attempts, { cause: error }),
    };
  }

  const parseJson: (value: string) => unknown = JSON.parse;
  try {
    return {
      status: "read",
      source,
      value: parseJson(source),
    };
  } catch (error: unknown) {
    return {
      status: "json_parse_failed",
      source,
      error: new CodexInvalidJsonError(attempts, {
        cause: createSafeJsonParseCause(error),
      }),
    };
  }
}

const CODEX_API_ERROR_VALUE_PATTERN = /^[A-Za-z0-9._:-]+$/u;
const codexJsonObjectSchema = z.record(z.string(), z.unknown());
const CODEX_API_ERROR_EVENT_TYPES = new Set(["error", "turn.failed"]);
export const PERMANENT_CODEX_API_ERROR_TYPES = new Set([
  "invalid_request_error",
  "authentication_error",
  "permission_error",
  "insufficient_quota",
  "context_length_exceeded",
  "model_not_found",
  "invalid_api_key",
]);

export type CodexStdoutInspection = Readonly<{
  apiError: CodexApiErrorDiagnostic | undefined;
  apiEvents: readonly ("turn.failed" | "error")[];
  parseErrors: readonly Error[];
}>;

function safeApiErrorValue(value: unknown): string | undefined {
  if (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 300 &&
    CODEX_API_ERROR_VALUE_PATTERN.test(value)
  ) {
    return value;
  }
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return value.toString();
  }
  return undefined;
}

function apiErrorValue(
  source: Readonly<Record<string, unknown>>,
  field: string,
): string | undefined {
  return safeApiErrorValue(source[field]);
}

export function mergeCodexApiErrors(
  primary: CodexApiErrorDiagnostic | undefined,
  secondary: CodexApiErrorDiagnostic | undefined,
): CodexApiErrorDiagnostic | undefined {
  if (primary == null) {
    return secondary;
  }
  if (secondary == null) {
    return primary;
  }
  const primaryTypeIsGeneric =
    primary.type != null && CODEX_API_ERROR_EVENT_TYPES.has(primary.type);
  const type = primaryTypeIsGeneric ? (secondary.type ?? primary.type) : primary.type;
  const code = primary.code ?? secondary.code;
  const status = primary.status ?? secondary.status;
  return Object.freeze({
    ...(type == null ? {} : { type }),
    ...(code == null ? {} : { code }),
    ...(status == null ? {} : { status }),
  });
}

export function inspectCodexStdout(source: string): CodexStdoutInspection {
  const apiEvents: ("turn.failed" | "error")[] = [];
  const parseErrors: Error[] = [];
  let apiError: CodexApiErrorDiagnostic | undefined;
  for (const [index, line] of source.split(/\r?\n/u).entries()) {
    if (line.trim().length === 0) {
      continue;
    }
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch (error: unknown) {
      parseErrors.push(
        new Error(`Codex --json stdoutのJSONL解析に失敗しました。行: ${(index + 1).toString()}`, {
          cause: error,
        }),
      );
      continue;
    }
    const objectResult = codexJsonObjectSchema.safeParse(value);
    if (!objectResult.success) {
      continue;
    }
    const eventType = objectResult.data["type"] ?? objectResult.data["event"];
    if (eventType !== "turn.failed" && eventType !== "error") {
      continue;
    }
    apiEvents.push(eventType);
    const nested = codexJsonObjectSchema.safeParse(objectResult.data["error"]);
    const errorObject = nested.success ? nested.data : objectResult.data;
    const type = apiErrorValue(errorObject, "type");
    const code = apiErrorValue(errorObject, "code");
    const status = apiErrorValue(errorObject, "status");
    apiError = mergeCodexApiErrors(
      apiError,
      Object.freeze({
        type: type ?? eventType,
        ...(code == null ? {} : { code }),
        ...(status == null ? {} : { status }),
      }),
    );
  }
  return Object.freeze({
    apiError,
    apiEvents: Object.freeze(apiEvents),
    parseErrors: Object.freeze(parseErrors),
  });
}

export function normalizedProcessOutput(value: string | undefined, name: string): string {
  if (value == null) {
    return "";
  }
  if (typeof value !== "string") {
    throw new TypeError(`Codex process resultの${name}は文字列にしてください`);
  }
  return value;
}

export function safeApiErrorDetails(
  apiError: CodexApiErrorDiagnostic | undefined,
): Readonly<Record<string, DiagnosticsJsonValue>> | undefined {
  if (apiError == null) {
    return undefined;
  }
  const details: Record<string, DiagnosticsJsonValue> = {};
  if (apiError.type != null) {
    details["type"] = apiError.type;
  }
  if (apiError.code != null) {
    details["code"] = apiError.code;
  }
  if (apiError.status != null) {
    details["status"] = apiError.status;
  }
  return Object.freeze(details);
}
