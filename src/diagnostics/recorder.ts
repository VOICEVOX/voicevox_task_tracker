import { mkdir, open, type FileHandle } from "node:fs/promises";
import { dirname } from "node:path";

import { z } from "zod";

import { serializeCanonicalJsonLine } from "../persistence/index.js";
import { DiagnosticsError, DiagnosticsValidationError } from "./errors.js";
import { DIAGNOSTICS_MAX_BYTES } from "./schema.js";
import {
  diagnosticsJsonObjectSchema,
  serializeDiagnosticError,
  serializedDiagnosticErrorValueSchema,
  validateStructuredDetails,
  type DiagnosticsJsonObject,
  type DiagnosticsJsonValue,
  type SerializedDiagnosticErrorValue,
} from "./error-serializer.js";
import { writeDiagnosticsBufferFully } from "./io.js";

const diagnosticEventSchema = z.strictObject({
  event: z.string().min(1).max(200),
  details: diagnosticsJsonObjectSchema.optional(),
  error: z.unknown().optional(),
  recordedAt: z.iso.datetime({ offset: true }).optional(),
});

const diagnosticsRecordSchema = z.strictObject({
  sequence: z.number().int().nonnegative(),
  recordedAt: z.iso.datetime({ offset: true }),
  event: z.string().min(1).max(200),
  details: diagnosticsJsonObjectSchema.optional(),
  error: serializedDiagnosticErrorValueSchema.optional(),
});

export type DiagnosticsRecordInput = Readonly<{
  event: string;
  details?: Readonly<Record<string, unknown>>;
  error?: unknown;
  recordedAt?: string;
}>;

export type DiagnosticsRecord = Readonly<{
  sequence: number;
  recordedAt: string;
  event: string;
  details?: Readonly<Record<string, unknown>>;
  error?: SerializedDiagnosticErrorValue;
}>;

export type DiagnosticsRecorderOptions = Readonly<{
  path: string;
}>;

export interface DiagnosticsJsonlRecorder {
  readonly path: string;
  append(input: DiagnosticsRecordInput): Promise<void>;
  record(input: DiagnosticsRecordInput): Promise<void>;
  close(): Promise<void>;
}

/** diagnostics JSONL recorderの作成に失敗したことを表す。 */
export class DiagnosticsRecorderError extends DiagnosticsError {
  public readonly path: string;

  public constructor(path: string, message: string, options: ErrorOptions) {
    super(`diagnostics recorderを扱えません。対象: ${path}。${message}`, options);
    this.path = path;
  }
}

function cloneDetails(details: Readonly<Record<string, unknown>>): DiagnosticsJsonObject {
  const validated = validateStructuredDetails(details);
  const clone: Record<string, DiagnosticsJsonValue> = {};
  for (const [key, item] of Object.entries(validated)) {
    Object.defineProperty(clone, key, {
      configurable: true,
      enumerable: true,
      value: cloneJsonValue(item),
      writable: true,
    });
  }
  return Object.freeze(clone);
}

function isDiagnosticsJsonArray(
  value: DiagnosticsJsonValue,
): value is readonly DiagnosticsJsonValue[] {
  return Array.isArray(value);
}

function cloneJsonValue(value: DiagnosticsJsonValue): DiagnosticsJsonValue {
  if (isDiagnosticsJsonArray(value)) {
    return Object.freeze(value.map((item) => cloneJsonValue(item)));
  }
  if (value != null && typeof value === "object") {
    const clone: Record<string, DiagnosticsJsonValue> = {};
    for (const [key, item] of Object.entries(value)) {
      Object.defineProperty(clone, key, {
        configurable: true,
        enumerable: true,
        value: cloneJsonValue(item),
        writable: true,
      });
    }
    return Object.freeze(clone);
  }
  return value;
}

function createRecordedAt(value: string | undefined): string {
  if (value != null) {
    const result = z.iso.datetime({ offset: true }).safeParse(value);
    if (!result.success) {
      throw new DiagnosticsValidationError("recordedAtはISO 8601日時にしてください", {
        cause: result.error,
      });
    }
    return new Date(value).toISOString();
  }
  return new Date().toISOString();
}

function createRecord(sequence: number, input: DiagnosticsRecordInput): DiagnosticsRecord {
  const inputResult = diagnosticEventSchema.safeParse(input);
  if (!inputResult.success) {
    throw new DiagnosticsValidationError("diagnostic eventが不正です", {
      cause: inputResult.error,
    });
  }
  const details =
    inputResult.data.details == null ? undefined : cloneDetails(inputResult.data.details);
  const hasError = Object.prototype.hasOwnProperty.call(inputResult.data, "error");
  const baseRecord = {
    sequence,
    recordedAt: createRecordedAt(inputResult.data.recordedAt),
    event: inputResult.data.event,
    ...(details == null ? {} : { details }),
  };
  const record = hasError
    ? Object.freeze({
        ...baseRecord,
        error: serializeDiagnosticError(inputResult.data.error),
      })
    : Object.freeze(baseRecord);
  const result = diagnosticsRecordSchema.safeParse(record);
  if (!result.success) {
    throw new DiagnosticsValidationError("diagnostic recordが不正です", { cause: result.error });
  }
  return record;
}

function isRecordTooLarge(size: number): boolean {
  return size > DIAGNOSTICS_MAX_BYTES;
}

async function closeRecorderHandleAfterFailure(
  path: string,
  handle: FileHandle,
  error: unknown,
): Promise<never> {
  try {
    await handle.close();
  } catch (closeError: unknown) {
    throw new DiagnosticsRecorderError(path, "ファイルを閉じられません", {
      cause: new AggregateError([error, closeError], "recorderの主処理とcloseに失敗しました", {
        cause: error,
      }),
    });
  }
  throw error;
}

type PreparedRecord =
  | Readonly<{
      kind: "ready";
      line: Buffer;
      lineBytes: number;
    }>
  | Readonly<{
      kind: "failure";
      error: Error;
    }>;

function prepareRecord(
  path: string,
  sequence: number,
  input: DiagnosticsRecordInput,
): PreparedRecord {
  try {
    const record = createRecord(sequence, input);
    const line = Buffer.from(serializeCanonicalJsonLine(record), "utf8");
    return Object.freeze({ kind: "ready", line, lineBytes: line.byteLength });
  } catch (error: unknown) {
    const failure =
      error instanceof Error
        ? error
        : new DiagnosticsRecorderError(path, "diagnostic recordを作成できません", {
            cause: error,
          });
    return Object.freeze({ kind: "failure", error: failure });
  }
}

async function readNextSequence(handle: FileHandle, path: string): Promise<number> {
  const source = await handle.readFile({ encoding: "utf8" });
  if (source.length === 0) {
    return 0;
  }
  const lines = source.split("\n");
  if (lines.at(-1) !== "") {
    throw new DiagnosticsRecorderError(path, "JSONLの末尾に改行がありません", {});
  }
  lines.pop();
  let nextSequence = 0;
  for (const line of lines) {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch (error: unknown) {
      throw new DiagnosticsRecorderError(path, "既存JSONLを解析できません", {
        cause: error,
      });
    }
    const result = diagnosticsRecordSchema.safeParse(value);
    if (!result.success || result.data.sequence !== nextSequence) {
      throw new DiagnosticsRecorderError(path, "既存JSONLのsequenceが不連続です", {
        cause: result.success ? undefined : result.error,
      });
    }
    nextSequence += 1;
  }
  return nextSequence;
}

/** JSONL recorderを開く。既存の内容は追記し、ファイル権限を600へ揃える。 */
export async function createDiagnosticsRecorder(
  options: DiagnosticsRecorderOptions,
): Promise<DiagnosticsJsonlRecorder> {
  const optionsResult = z.strictObject({ path: z.string().min(1) }).safeParse(options);
  if (!optionsResult.success) {
    throw new DiagnosticsValidationError("recorderのpathが不正です", {
      cause: optionsResult.error,
    });
  }
  const path = optionsResult.data.path;
  try {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const handle = await open(path, "a+", 0o600);
    try {
      await handle.chmod(0o600);
      const statistics = await handle.stat();
      if (isRecordTooLarge(statistics.size)) {
        throw new DiagnosticsRecorderError(path, "64MiBを超えています", {});
      }
      const nextSequence = await readNextSequence(handle, path);
      return new DiagnosticsJsonlRecorderImpl(path, handle, statistics.size, nextSequence);
    } catch (error: unknown) {
      return await closeRecorderHandleAfterFailure(path, handle, error);
    }
  } catch (error: unknown) {
    if (error instanceof DiagnosticsRecorderError) {
      throw error;
    }
    throw new DiagnosticsRecorderError(path, "ファイルを開けません", { cause: error });
  }
}

/** sequence付きJSONLをFIFOで追記するrecorder。 */
class DiagnosticsJsonlRecorderImpl implements DiagnosticsJsonlRecorder {
  readonly #path: string;
  readonly #handle: FileHandle;
  #nextSequence = 0;
  #tail: Promise<void> = Promise.resolve();
  #failure: Error | undefined;
  #closed = false;
  #size: number;

  public constructor(
    path: string,
    handle: FileHandle,
    initialSize: number,
    initialSequence: number,
  ) {
    this.#path = path;
    this.#handle = handle;
    this.#nextSequence = initialSequence;
    this.#size = initialSize;
  }

  /** 診断イベントを受付順にJSONLへ追記する。 */
  public append(input: DiagnosticsRecordInput): Promise<void> {
    if (this.#closed) {
      return Promise.reject(new DiagnosticsRecorderError(this.#path, "既に閉じています", {}));
    }
    if (this.#failure != null) {
      return Promise.reject(this.#failure);
    }
    const sequence = this.#nextSequence;
    this.#nextSequence += 1;
    const prepared = prepareRecord(this.#path, sequence, input);
    const operation = this.#tail.then(async () => {
      if (this.#failure != null) {
        throw this.#failure;
      }
      if (prepared.kind === "failure") {
        throw prepared.error;
      }
      if (this.#size + prepared.lineBytes > DIAGNOSTICS_MAX_BYTES) {
        throw new DiagnosticsRecorderError(this.#path, "64MiBを超えるため追記できません", {});
      }
      await writeDiagnosticsBufferFully(
        this.#handle,
        prepared.line,
        "diagnostics JSONLを書き込めません",
      );
      this.#size += prepared.lineBytes;
    });
    this.#tail = operation.then(
      () => undefined,
      (error: unknown) => {
        this.#failure =
          error instanceof Error
            ? error
            : new DiagnosticsRecorderError(this.#path, "追記に失敗しました", {
                cause: error,
              });
      },
    );
    return operation;
  }

  /** 診断イベントをrecordという名前で追記する。 */
  public record(input: DiagnosticsRecordInput): Promise<void> {
    return this.append(input);
  }

  /** recorderの追記を待ち、ファイルをfsyncして閉じる。 */
  public async close(): Promise<void> {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    await this.#tail;
    const closeErrors: unknown[] = [];
    try {
      await this.#handle.sync();
    } catch (error: unknown) {
      closeErrors.push(error);
    }
    try {
      await this.#handle.close();
    } catch (error: unknown) {
      closeErrors.push(error);
    }
    if (this.#failure != null) {
      if (closeErrors.length === 0) {
        throw this.#failure;
      }
      throw new AggregateError(
        [this.#failure, ...closeErrors],
        "追記とファイルの同期またはクローズに失敗しました",
        { cause: this.#failure },
      );
    }
    if (closeErrors.length > 0) {
      const cause =
        closeErrors.length === 1
          ? closeErrors[0]
          : new AggregateError(closeErrors, "ファイルの同期またはクローズに失敗しました");
      throw new DiagnosticsRecorderError(this.#path, "ファイルを閉じられません", {
        cause,
      });
    }
  }

  /** recorderが保持するファイルパスを返す。 */
  public get path(): string {
    return this.#path;
  }
}
