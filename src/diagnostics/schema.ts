import { createHash } from "node:crypto";

import { z } from "zod";

import { DiagnosticsFormatError, DiagnosticsValidationError } from "./errors.js";

export const DIAGNOSTICS_FORMAT_VERSION = 1;
export const DIAGNOSTICS_BUNDLE_SCHEMA_VERSION = 1;
export const DIAGNOSTICS_ALGORITHM = "aes-256-gcm";
export const DIAGNOSTICS_KEY_ENVIRONMENT_VARIABLE =
  "VOICEVOX_TASK_TRACKER_DIAGNOSTICS_AES256_KEY_V1_B64";
export const DIAGNOSTICS_NONCE_BYTES = 12;
export const DIAGNOSTICS_AUTH_TAG_BYTES = 16;
export const DIAGNOSTICS_HEADER_LENGTH_BYTES = 4;
export const DIAGNOSTICS_MAX_BYTES = 64 * 1024 * 1024;
export const DIAGNOSTICS_MAGIC = Buffer.from("VVTDIAG1", "ascii");
export const DIAGNOSTICS_MAX_HEADER_BYTES = 64 * 1024;
export const DIAGNOSTICS_MAX_ERROR_DEPTH = 32;

const nonEmptyStringSchema = z.string().min(1).max(1000);
const positiveIntegerSchema = z.number().int().positive();
const bundleSchemaVersionSchema = z.literal(DIAGNOSTICS_BUNDLE_SCHEMA_VERSION);

export const diagnosticsBundleMetadataSchema = z.strictObject({
  bundleSchemaVersion: bundleSchemaVersionSchema,
  runId: nonEmptyStringSchema,
  runAttempt: positiveIntegerSchema,
  job: nonEmptyStringSchema,
  invocationId: nonEmptyStringSchema,
});

export const diagnosticsBundleHeaderSchema = z.strictObject({
  formatVersion: z.literal(DIAGNOSTICS_FORMAT_VERSION),
  bundleSchemaVersion: bundleSchemaVersionSchema,
  algorithm: z.literal(DIAGNOSTICS_ALGORITHM),
  nonce: z.string().min(1),
  keyId: z.string().regex(/^[0-9a-f]{64}$/u),
  runId: nonEmptyStringSchema,
  runAttempt: positiveIntegerSchema,
  job: nonEmptyStringSchema,
  invocationId: nonEmptyStringSchema,
});

export type DiagnosticsBundleMetadata = z.output<typeof diagnosticsBundleMetadataSchema>;
export type DiagnosticsBundleHeader = z.output<typeof diagnosticsBundleHeaderSchema>;

const base64KeySchema = z
  .string()
  .length(44)
  .regex(/^[A-Za-z0-9+/]*={0,2}$/u);
const base64NonceSchema = z
  .string()
  .length(16)
  .regex(/^[A-Za-z0-9+/]*={0,2}$/u);

/** base64表現のAES-256鍵を32byteのBufferへ変換する。 */
export function decodeDiagnosticsKey(keyBase64: string): Buffer {
  const result = base64KeySchema.safeParse(keyBase64);
  if (!result.success) {
    throw new DiagnosticsValidationError("AES-256鍵はbase64で指定してください", {
      cause: result.error,
    });
  }
  const key = Buffer.from(result.data, "base64");
  if (key.byteLength !== 32) {
    throw new DiagnosticsValidationError("AES-256鍵はbase64で32byteにしてください", {});
  }
  return key;
}

/** AES-256鍵から識別用のSHA-256 hexを生成する。 */
export function createDiagnosticsKeyId(key: Uint8Array): string {
  if (key.byteLength !== 32) {
    throw new DiagnosticsValidationError("AES-256鍵は32byteにしてください", {});
  }
  return createHash("sha256").update(key).digest("hex");
}

/** ヘッダーnonceのbase64表現を12byteへ変換する。 */
export function decodeDiagnosticsNonce(nonceBase64: string): Buffer {
  const result = base64NonceSchema.safeParse(nonceBase64);
  if (!result.success) {
    throw new DiagnosticsFormatError("nonceのbase64表現が不正です", { cause: result.error });
  }
  const nonce = Buffer.from(result.data, "base64");
  if (nonce.byteLength !== DIAGNOSTICS_NONCE_BYTES) {
    throw new DiagnosticsFormatError("nonceは12byteにしてください", {});
  }
  return nonce;
}

/** 未検証のバンドルメタデータを検証済みの値へ変換する。 */
export function parseDiagnosticsBundleMetadata(value: unknown): DiagnosticsBundleMetadata {
  const result = diagnosticsBundleMetadataSchema.safeParse(value);
  if (!result.success) {
    throw new DiagnosticsValidationError("run metadataが不正です", { cause: result.error });
  }
  return result.data;
}

/** 未検証のヘッダーを検証済みの値へ変換する。 */
export function parseDiagnosticsBundleHeader(value: unknown): DiagnosticsBundleHeader {
  const result = diagnosticsBundleHeaderSchema.safeParse(value);
  if (!result.success) {
    throw new DiagnosticsFormatError("header schemaの検証に失敗しました", {
      cause: result.error,
    });
  }
  decodeDiagnosticsNonce(result.data.nonce);
  return result.data;
}
