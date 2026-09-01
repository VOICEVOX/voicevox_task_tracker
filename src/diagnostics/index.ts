export {
  decryptDiagnosticsBundle,
  encryptDiagnosticsBundle,
  readDiagnosticsBundleHeader,
  type DecryptDiagnosticsBundleInput,
  type EncryptDiagnosticsBundleInput,
} from "./encrypted-bundle.js";
export {
  DiagnosticsCliUsageError,
  DiagnosticsError,
  DiagnosticsFormatError,
  DiagnosticsOutputExistsError,
  DiagnosticsValidationError,
} from "./errors.js";
export {
  serializeDiagnosticError,
  validateStructuredDetails,
  type SerializedDiagnosticError,
  type SerializedDiagnosticErrorValue,
} from "./error-serializer.js";
export {
  createDiagnosticsRecorder,
  DiagnosticsRecorderError,
  type DiagnosticsJsonlRecorder,
  type DiagnosticsRecord,
  type DiagnosticsRecordInput,
  type DiagnosticsRecorderOptions,
} from "./recorder.js";
export {
  DIAGNOSTICS_ALGORITHM,
  DIAGNOSTICS_AUTH_TAG_BYTES,
  DIAGNOSTICS_BUNDLE_SCHEMA_VERSION,
  DIAGNOSTICS_FORMAT_VERSION,
  DIAGNOSTICS_HEADER_LENGTH_BYTES,
  DIAGNOSTICS_KEY_ENVIRONMENT_VARIABLE,
  DIAGNOSTICS_MAGIC,
  DIAGNOSTICS_MAX_BYTES,
  DIAGNOSTICS_MAX_ERROR_DEPTH,
  DIAGNOSTICS_MAX_HEADER_BYTES,
  DIAGNOSTICS_NONCE_BYTES,
  createDiagnosticsKeyId,
  decodeDiagnosticsKey,
  decodeDiagnosticsNonce,
  diagnosticsBundleMetadataSchema,
  diagnosticsBundleHeaderSchema,
  parseDiagnosticsBundleHeader,
  parseDiagnosticsBundleMetadata,
  type DiagnosticsBundleHeader,
  type DiagnosticsBundleMetadata,
} from "./schema.js";
export { runDiagnosticsCli } from "./cli.js";
