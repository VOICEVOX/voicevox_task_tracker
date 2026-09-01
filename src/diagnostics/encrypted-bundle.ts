import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from "node:crypto";
import { createReadStream, createWriteStream, type WriteStream } from "node:fs";
import { link, mkdir, open, stat, unlink, type FileHandle } from "node:fs/promises";
import { dirname } from "node:path";
import { Readable, Transform, type TransformCallback } from "node:stream";
import { pipeline } from "node:stream/promises";

import { z } from "zod";

import {
  DiagnosticsFormatError,
  DiagnosticsOutputExistsError,
  DiagnosticsValidationError,
} from "./errors.js";
import {
  DIAGNOSTICS_ALGORITHM,
  DIAGNOSTICS_AUTH_TAG_BYTES,
  DIAGNOSTICS_BUNDLE_SCHEMA_VERSION,
  DIAGNOSTICS_FORMAT_VERSION,
  DIAGNOSTICS_HEADER_LENGTH_BYTES,
  DIAGNOSTICS_MAGIC,
  DIAGNOSTICS_MAX_BYTES,
  DIAGNOSTICS_MAX_HEADER_BYTES,
  DIAGNOSTICS_NONCE_BYTES,
  createDiagnosticsKeyId,
  decodeDiagnosticsKey,
  decodeDiagnosticsNonce,
  parseDiagnosticsBundleHeader,
  parseDiagnosticsBundleMetadata,
  type DiagnosticsBundleHeader,
  type DiagnosticsBundleMetadata,
} from "./schema.js";
import { writeDiagnosticsBufferFully } from "./io.js";

const pathSchema = z.string().min(1).max(4096);

const encryptionInputSchema = z.strictObject({
  inputPath: pathSchema,
  outputPath: pathSchema,
  keyBase64: z.string().min(1),
  runId: z.string().min(1).max(1000),
  runAttempt: z.number().int().positive(),
  job: z.string().min(1).max(1000),
  invocationId: z.string().min(1).max(1000),
});

const decryptionInputSchema = z.strictObject({
  inputPath: pathSchema,
  outputPath: pathSchema,
  keyBase64: z.string().min(1),
});

export type EncryptDiagnosticsBundleInput = z.input<typeof encryptionInputSchema>;
export type DecryptDiagnosticsBundleInput = z.input<typeof decryptionInputSchema>;

type ParsedBundle = Readonly<{
  header: DiagnosticsBundleHeader;
  aad: Buffer;
  ciphertextStart: number;
  ciphertextLength: number;
  authTag: Buffer;
}>;

function nodeErrorCode(error: unknown): string | undefined {
  const result = z.object({ code: z.string() }).safeParse(error);
  return result.success ? result.data.code : undefined;
}

function validatePath(path: string, label: string): string {
  const result = pathSchema.safeParse(path);
  if (!result.success) {
    throw new DiagnosticsValidationError(`${label}が不正です`, { cause: result.error });
  }
  return result.data;
}

function createHeader(
  key: Buffer,
  metadata: DiagnosticsBundleMetadata,
): Readonly<{ header: DiagnosticsBundleHeader; aad: Buffer }> {
  const nonce = randomBytes(DIAGNOSTICS_NONCE_BYTES);
  const header = parseDiagnosticsBundleHeader({
    formatVersion: DIAGNOSTICS_FORMAT_VERSION,
    bundleSchemaVersion: metadata.bundleSchemaVersion,
    algorithm: DIAGNOSTICS_ALGORITHM,
    nonce: nonce.toString("base64"),
    keyId: createDiagnosticsKeyId(key),
    runId: metadata.runId,
    runAttempt: metadata.runAttempt,
    job: metadata.job,
    invocationId: metadata.invocationId,
  });
  const rawHeader = Buffer.from(JSON.stringify(header), "utf8");
  if (rawHeader.byteLength === 0 || rawHeader.byteLength > DIAGNOSTICS_MAX_HEADER_BYTES) {
    throw new DiagnosticsValidationError("headerが大きすぎます", {});
  }
  const headerLength = Buffer.allocUnsafe(DIAGNOSTICS_HEADER_LENGTH_BYTES);
  headerLength.writeUInt32BE(rawHeader.byteLength, 0);
  const aad = Buffer.concat([Buffer.from(DIAGNOSTICS_MAGIC), headerLength, rawHeader]);
  return Object.freeze({ header, aad });
}

function createDiagnosticsInputLimitTransform(): Transform {
  let bytes = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
      if (bytes + chunk.byteLength > DIAGNOSTICS_MAX_BYTES) {
        callback(new DiagnosticsValidationError("暗号化入力が64MiBを超えています", {}));
        return;
      }
      bytes += chunk.byteLength;
      callback(null, chunk);
    },
  });
}

async function readExact(
  handle: FileHandle,
  length: number,
  position: number,
  message: string,
): Promise<Buffer> {
  const buffer = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const result = await handle.read(buffer, offset, length - offset, position + offset);
    if (result.bytesRead === 0) {
      throw new DiagnosticsFormatError(message, {});
    }
    offset += result.bytesRead;
  }
  return buffer;
}

async function withFileHandle<Result>(
  handle: FileHandle,
  operation: (handle: FileHandle) => Promise<Result>,
): Promise<Result> {
  let result: Result;
  try {
    result = await operation(handle);
  } catch (error: unknown) {
    try {
      await handle.close();
    } catch (closeError: unknown) {
      throwWithCleanup(error, [closeError]);
    }
    throw error;
  }
  await handle.close();
  return result;
}

async function readBundle(inputPath: string): Promise<ParsedBundle> {
  const handle = await open(inputPath, "r");
  return withFileHandle(handle, async (handle) => {
    const statistics = await handle.stat();
    const minimumLength =
      DIAGNOSTICS_MAGIC.byteLength + DIAGNOSTICS_HEADER_LENGTH_BYTES + DIAGNOSTICS_AUTH_TAG_BYTES;
    if (statistics.size < minimumLength) {
      throw new DiagnosticsFormatError("バンドルが短すぎます", {});
    }
    const magicAndLength = await readExact(
      handle,
      DIAGNOSTICS_MAGIC.byteLength + DIAGNOSTICS_HEADER_LENGTH_BYTES,
      0,
      "バンドルヘッダーを読み取れません",
    );
    const magic = magicAndLength.subarray(0, DIAGNOSTICS_MAGIC.byteLength);
    if (!timingSafeEqual(magic, DIAGNOSTICS_MAGIC)) {
      throw new DiagnosticsFormatError("magicが一致しません", {});
    }
    const headerLength = magicAndLength.readUInt32BE(DIAGNOSTICS_MAGIC.byteLength);
    if (headerLength === 0 || headerLength > DIAGNOSTICS_MAX_HEADER_BYTES) {
      throw new DiagnosticsFormatError("header長が不正です", {});
    }
    const rawHeader = await readExact(
      handle,
      headerLength,
      DIAGNOSTICS_MAGIC.byteLength + DIAGNOSTICS_HEADER_LENGTH_BYTES,
      "バンドルheaderを読み取れません",
    );
    let parsedHeader: unknown;
    try {
      parsedHeader = JSON.parse(rawHeader.toString("utf8"));
    } catch (error: unknown) {
      throw new DiagnosticsFormatError("header JSONを解析できません", { cause: error });
    }
    const header = parseDiagnosticsBundleHeader(parsedHeader);
    const aad = Buffer.concat([magicAndLength, rawHeader]);
    const ciphertextStart = aad.byteLength;
    const ciphertextLength = statistics.size - ciphertextStart - DIAGNOSTICS_AUTH_TAG_BYTES;
    if (ciphertextLength < 0) {
      throw new DiagnosticsFormatError("暗号文と認証タグの長さが不正です", {});
    }
    const authTag = await readExact(
      handle,
      DIAGNOSTICS_AUTH_TAG_BYTES,
      statistics.size - DIAGNOSTICS_AUTH_TAG_BYTES,
      "認証タグを読み取れません",
    );
    return Object.freeze({
      header,
      aad,
      ciphertextStart,
      ciphertextLength,
      authTag,
    });
  });
}

async function assertOutputAbsent(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  try {
    await stat(path);
    throw new DiagnosticsOutputExistsError(path, {});
  } catch (error: unknown) {
    if (error instanceof DiagnosticsOutputExistsError) {
      throw error;
    }
    if (nodeErrorCode(error) === "ENOENT") {
      return;
    }
    if (nodeErrorCode(error) === "EEXIST") {
      throw new DiagnosticsOutputExistsError(path, { cause: error });
    }
    throw error;
  }
}

async function removeCreatedPath(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error: unknown) {
    if (nodeErrorCode(error) === "ENOENT") {
      return;
    }
    throw error;
  }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  await withFileHandle(handle, async (handle) => {
    await handle.sync();
  });
}

async function cleanupCreatedPaths(paths: readonly string[]): Promise<readonly unknown[]> {
  const errors: unknown[] = [];
  for (const path of paths) {
    try {
      await removeCreatedPath(path);
    } catch (error: unknown) {
      errors.push(error);
    }
  }
  return errors;
}

function throwWithCleanup(error: unknown, cleanupErrors: readonly unknown[]): never {
  if (cleanupErrors.length === 0) {
    if (error instanceof Error) {
      throw error;
    }
    throw new Error("diagnosticsバンドルの処理に失敗しました", { cause: error });
  }
  const causes = [error, ...cleanupErrors];
  throw new AggregateError(causes, "diagnosticsバンドルの後処理に失敗しました", {
    cause: error,
  });
}

async function finalizePartialNoClobber(partialPath: string, outputPath: string): Promise<void> {
  try {
    await link(partialPath, outputPath);
  } catch (error: unknown) {
    const failure =
      nodeErrorCode(error) === "EEXIST"
        ? new DiagnosticsOutputExistsError(outputPath, { cause: error })
        : error;
    throwWithCleanup(failure, await cleanupCreatedPaths([partialPath]));
  }
  try {
    await removeCreatedPath(partialPath);
    await syncDirectory(dirname(outputPath));
  } catch (error: unknown) {
    throwWithCleanup(error, await cleanupCreatedPaths([partialPath, outputPath]));
  }
}

function metadataFromEncryptionInput(input: EncryptDiagnosticsBundleInput): Readonly<{
  inputPath: string;
  outputPath: string;
  keyBase64: string;
  metadata: DiagnosticsBundleMetadata;
}> {
  const result = encryptionInputSchema.safeParse(input);
  if (!result.success) {
    throw new DiagnosticsValidationError("暗号化入力が不正です", { cause: result.error });
  }
  const inputPath = validatePath(result.data.inputPath, "入力パス");
  const outputPath = validatePath(result.data.outputPath, "出力パス");
  const metadata = parseDiagnosticsBundleMetadata({
    bundleSchemaVersion: DIAGNOSTICS_BUNDLE_SCHEMA_VERSION,
    runId: result.data.runId,
    runAttempt: result.data.runAttempt,
    job: result.data.job,
    invocationId: result.data.invocationId,
  });
  return Object.freeze({ inputPath, outputPath, keyBase64: result.data.keyBase64, metadata });
}

async function closeHandle(
  handle: FileHandle | undefined,
  errors: unknown[],
  stream: WriteStream | undefined,
): Promise<void> {
  if (handle == null) {
    return;
  }
  const streamDestroyed = stream?.destroyed === true;
  try {
    await handle.close();
  } catch (error: unknown) {
    if (streamDestroyed && nodeErrorCode(error) === "EBADF") {
      return;
    }
    errors.push(error);
  }
}

/** JSONL diagnosticsをAES-256-GCMバンドルへ暗号化する。 */
export async function encryptDiagnosticsBundle(
  input: EncryptDiagnosticsBundleInput,
): Promise<DiagnosticsBundleHeader> {
  const normalized = metadataFromEncryptionInput(input);
  const key = decodeDiagnosticsKey(normalized.keyBase64);
  const { header, aad } = createHeader(key, normalized.metadata);
  const partialPath = `${normalized.outputPath}.partial`;
  let partialHandle: FileHandle | undefined;
  let outputStream: WriteStream | undefined;
  let partialCreated = false;
  let finalizeStarted = false;
  try {
    await assertOutputAbsent(normalized.outputPath);
    partialHandle = await open(partialPath, "wx", 0o600);
    partialCreated = true;
    await writeDiagnosticsBufferFully(partialHandle, aad, "バンドルheaderを書き込めません");
    const cipher = createCipheriv("aes-256-gcm", key, decodeDiagnosticsNonce(header.nonce), {
      authTagLength: DIAGNOSTICS_AUTH_TAG_BYTES,
    });
    cipher.setAAD(aad);
    outputStream = createWriteStream(partialPath, {
      fd: partialHandle.fd,
      autoClose: false,
    });
    await pipeline(
      createReadStream(normalized.inputPath),
      createDiagnosticsInputLimitTransform(),
      cipher,
      outputStream,
    );
    const authTag = cipher.getAuthTag();
    if (authTag.byteLength !== DIAGNOSTICS_AUTH_TAG_BYTES) {
      throw new DiagnosticsFormatError("認証タグの長さが不正です", {});
    }
    await writeDiagnosticsBufferFully(partialHandle, authTag, "認証タグを書き込めません");
    await partialHandle.sync();
    await partialHandle.close();
    partialHandle = undefined;
    finalizeStarted = true;
    await finalizePartialNoClobber(partialPath, normalized.outputPath);
    partialCreated = false;
    return header;
  } catch (error: unknown) {
    const cleanupErrors: unknown[] = [];
    await closeHandle(partialHandle, cleanupErrors, outputStream);
    if (partialCreated && !finalizeStarted) {
      try {
        await removeCreatedPath(partialPath);
      } catch (cleanupError: unknown) {
        cleanupErrors.push(cleanupError);
      }
    }
    throwWithCleanup(error, cleanupErrors);
  }
}

/** AES-256-GCMバンドルを検証して平文ファイルへ復号する。 */
export async function decryptDiagnosticsBundle(
  input: DecryptDiagnosticsBundleInput,
): Promise<DiagnosticsBundleHeader> {
  const result = decryptionInputSchema.safeParse(input);
  if (!result.success) {
    throw new DiagnosticsValidationError("復号入力が不正です", { cause: result.error });
  }
  const inputPath = validatePath(result.data.inputPath, "入力パス");
  const outputPath = validatePath(result.data.outputPath, "出力パス");
  const key = decodeDiagnosticsKey(result.data.keyBase64);
  const bundle = await readBundle(inputPath);
  const expectedKeyId = Buffer.from(createDiagnosticsKeyId(key), "hex");
  const actualKeyId = Buffer.from(bundle.header.keyId, "hex");
  if (!timingSafeEqual(expectedKeyId, actualKeyId)) {
    throw new DiagnosticsFormatError("鍵識別子が一致しません", {});
  }
  if (bundle.ciphertextLength > DIAGNOSTICS_MAX_BYTES) {
    throw new DiagnosticsFormatError("暗号文が64MiBを超えています", {});
  }
  const partialPath = `${outputPath}.partial`;
  let partialHandle: FileHandle | undefined;
  let outputStream: WriteStream | undefined;
  let partialCreated = false;
  let finalizeStarted = false;
  try {
    await assertOutputAbsent(outputPath);
    partialHandle = await open(partialPath, "wx", 0o600);
    partialCreated = true;
    const decipher = createDecipheriv(
      "aes-256-gcm",
      key,
      decodeDiagnosticsNonce(bundle.header.nonce),
      { authTagLength: DIAGNOSTICS_AUTH_TAG_BYTES },
    );
    decipher.setAAD(bundle.aad);
    decipher.setAuthTag(bundle.authTag);
    outputStream = createWriteStream(partialPath, {
      fd: partialHandle.fd,
      autoClose: false,
    });
    const inputStream =
      bundle.ciphertextLength === 0
        ? Readable.from([])
        : createReadStream(inputPath, {
            start: bundle.ciphertextStart,
            end: bundle.ciphertextStart + bundle.ciphertextLength - 1,
          });
    await pipeline(inputStream, decipher, outputStream);
    await partialHandle.sync();
    await partialHandle.close();
    partialHandle = undefined;
    finalizeStarted = true;
    await finalizePartialNoClobber(partialPath, outputPath);
    partialCreated = false;
    return bundle.header;
  } catch (error: unknown) {
    const cleanupErrors: unknown[] = [];
    await closeHandle(partialHandle, cleanupErrors, outputStream);
    if (partialCreated && !finalizeStarted) {
      try {
        await removeCreatedPath(partialPath);
      } catch (cleanupError: unknown) {
        cleanupErrors.push(cleanupError);
      }
    }
    const failure =
      error instanceof DiagnosticsOutputExistsError || error instanceof DiagnosticsValidationError
        ? error
        : new DiagnosticsFormatError("バンドルを復号できません", { cause: error });
    throwWithCleanup(failure, cleanupErrors);
  }
}

/** 暗号化バンドルのheaderだけを検証して返す。 */
export async function readDiagnosticsBundleHeader(
  inputPath: string,
): Promise<DiagnosticsBundleHeader> {
  const path = validatePath(inputPath, "入力パス");
  const bundle = await readBundle(path);
  return bundle.header;
}
