import { spawn } from "node:child_process";

import { z } from "zod";

const CODEX_API_ERROR_PREFIX = "ERROR: ";
const CODEX_STANDARD_ERROR_TAIL_BYTE_LIMIT = 64 * 1024;
const codexApiErrorJsonSchema = z.record(z.string(), z.unknown());
const codexApiErrorValueSchema = z
  .string()
  .min(1)
  .max(300)
  .regex(/^[A-Za-z0-9._:-]+$/u);
const codexApiErrorStatusSchema = z.union([
  codexApiErrorValueSchema,
  z
    .number()
    .int()
    .nonnegative()
    .transform((value) => value.toString()),
]);

/** Codex APIが生成したエラーから診断へ出せる固定語彙。 */
export type CodexApiErrorDiagnostic = Readonly<{
  type?: string;
  code?: string;
  status?: string;
}>;

/** Codex CLI subprocessへ渡す隔離済みの実行情報。 */
export type CodexProcessRequest = Readonly<{
  command: string;
  arguments: readonly string[];
  workingDirectory: string;
  environment: Readonly<Record<string, string>>;
  standardInput: string;
  timeoutMilliseconds: number;
}>;

/** Codex CLI subprocessの終了状態。 */
export type CodexProcessResult = Readonly<{
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  standardInputError?: Error;
  apiError?: CodexApiErrorDiagnostic;
  stdout?: string;
  stderr?: string;
}>;

/** 差し替え可能なCodex CLI subprocess起動関数。 */
export type CodexProcessRunner = (request: CodexProcessRequest) => Promise<CodexProcessResult>;

function parseJson(source: string): unknown {
  const parser: (value: string) => unknown = JSON.parse;
  return parser(source);
}

function parseCodexApiError(source: string): CodexApiErrorDiagnostic | undefined {
  let value: unknown;
  try {
    value = parseJson(source);
  } catch {
    return undefined;
  }
  const json = codexApiErrorJsonSchema.safeParse(value);
  if (!json.success) {
    return undefined;
  }
  const type = codexApiErrorValueSchema.safeParse(json.data["type"]);
  const code = codexApiErrorValueSchema.safeParse(json.data["code"]);
  const status = codexApiErrorStatusSchema.safeParse(json.data["status"]);
  if (!type.success && !code.success && !status.success) {
    return undefined;
  }
  return Object.freeze({
    ...(type.success ? { type: type.data } : {}),
    ...(code.success ? { code: code.data } : {}),
    ...(status.success ? { status: status.data } : {}),
  });
}

function extractCodexApiError(standardError: string): CodexApiErrorDiagnostic | undefined {
  let diagnostic: CodexApiErrorDiagnostic | undefined;
  for (const line of standardError.split(/\r?\n/u)) {
    if (!line.startsWith(CODEX_API_ERROR_PREFIX)) {
      continue;
    }
    const parsed = parseCodexApiError(line.slice(CODEX_API_ERROR_PREFIX.length));
    if (parsed != null) {
      diagnostic = parsed;
    }
  }
  return diagnostic;
}

function appendStandardErrorTail(current: Buffer, chunk: Buffer): Buffer {
  if (chunk.length >= CODEX_STANDARD_ERROR_TAIL_BYTE_LIMIT) {
    return Buffer.from(chunk.subarray(chunk.length - CODEX_STANDARD_ERROR_TAIL_BYTE_LIMIT));
  }
  const currentByteLimit = CODEX_STANDARD_ERROR_TAIL_BYTE_LIMIT - chunk.length;
  const retainedCurrent = current.subarray(Math.max(0, current.length - currentByteLimit));
  return Buffer.concat([retainedCurrent, chunk], retainedCurrent.length + chunk.length);
}

/** shellを介さずCodex CLI subprocessを起動する。 */
export async function runCodexProcess(request: CodexProcessRequest): Promise<CodexProcessResult> {
  if (!Number.isSafeInteger(request.timeoutMilliseconds) || request.timeoutMilliseconds <= 0) {
    throw new TypeError("timeoutMillisecondsには正の安全な整数を指定してください");
  }

  const child = spawn(request.command, request.arguments, {
    cwd: request.workingDirectory,
    env: request.environment,
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });

  return await new Promise<CodexProcessResult>((resolve, reject) => {
    let timedOut = false;
    const standardOutputChunks: Buffer[] = [];
    const standardErrorChunks: Buffer[] = [];
    let standardErrorTail: Buffer = Buffer.alloc(0);
    let standardInputError:
      | Readonly<{
          status: "none";
        }>
      | Readonly<{
          status: "failed";
          error: Error;
        }> = {
      status: "none",
    };

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, request.timeoutMilliseconds);

    let processError: Error | undefined;
    child.once("error", (error) => {
      processError = error;
    });
    child.once("close", (exitCode, signal) => {
      clearTimeout(timeout);
      if (processError != null) {
        reject(processError);
        return;
      }
      const stdout = Buffer.concat(standardOutputChunks).toString("utf8");
      const stderr = Buffer.concat(standardErrorChunks).toString("utf8");
      const apiError = extractCodexApiError(standardErrorTail.toString("utf8"));
      resolve({
        exitCode,
        signal,
        timedOut,
        ...(standardInputError.status === "failed"
          ? { standardInputError: standardInputError.error }
          : {}),
        ...(apiError == null ? {} : { apiError }),
        stdout,
        stderr,
      });
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      standardErrorChunks.push(buffer);
      standardErrorTail = appendStandardErrorTail(standardErrorTail, buffer);
    });
    child.stdout.on("data", (chunk: Buffer) => {
      standardOutputChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    child.stdin.once("error", (error) => {
      standardInputError = {
        status: "failed",
        error,
      };
    });
    child.stdin.end(request.standardInput);
  });
}
