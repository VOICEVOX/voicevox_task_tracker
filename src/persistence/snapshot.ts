import { z } from "zod";

import { serializeCanonicalJsonLine } from "../canonical-json/index.js";
import {
  StateFormatError,
  StateSnapshotSchemaError,
  StateSnapshotSemanticError,
} from "./errors.js";
import type {
  StateSnapshot,
  StateSnapshotVersion11,
  StateSnapshotVersion12,
  StateSnapshotVersion13,
  StateSnapshotVersion14,
  StateSnapshotVersion15,
  StateSnapshotVersion16,
  StateSnapshotVersion17,
  StateSnapshotVersion18,
} from "./snapshot-contracts.js";
import { SNAPSHOT_SCHEMA_VERSION_19 } from "./snapshot-contracts.js";
import { normalizeSnapshot } from "./snapshot-normalization.js";
import {
  snapshotSchemaVersion11Schema,
  snapshotSchemaVersion12Schema,
  snapshotSchemaVersion13Schema,
  snapshotSchemaVersion14Schema,
  snapshotSchemaVersion15Schema,
  snapshotSchemaVersion16Schema,
  snapshotSchemaVersion17Schema,
  snapshotSchemaVersion18Schema,
  snapshotSchemaVersion19Schema,
  validateSnapshotVersion11Schema,
  validateSnapshotVersion12Schema,
  validateSnapshotVersion13Schema,
  validateSnapshotVersion14Schema,
  validateSnapshotVersion15Schema,
  validateSnapshotVersion16Schema,
  validateSnapshotVersion17Schema,
  validateSnapshotVersion18Schema,
  validateSnapshotVersion19Schema,
} from "./snapshot-schema.js";
import { assertSnapshotSemantics } from "./snapshot-semantics.js";

function parseStateSnapshotVersion11Value(value: unknown): StateSnapshotVersion11 {
  snapshotSchemaVersion11Schema.parse(value);
  if (!validateSnapshotVersion11Schema(value)) {
    const issueCount = validateSnapshotVersion11Schema.errors?.length ?? 1;
    throw new StateSnapshotSchemaError(issueCount);
  }
  assertSnapshotSemantics(value, "5", "legacy", false, false);
  return value;
}

function parseStateSnapshotVersion12Value(value: unknown): StateSnapshotVersion12 {
  snapshotSchemaVersion12Schema.parse(value);
  if (!validateSnapshotVersion12Schema(value)) {
    const issueCount = validateSnapshotVersion12Schema.errors?.length ?? 1;
    throw new StateSnapshotSchemaError(issueCount);
  }
  assertSnapshotSemantics(value, "5", "legacy", false, false);
  return value;
}

function parseStateSnapshotVersion13Value(value: unknown): StateSnapshotVersion13 {
  snapshotSchemaVersion13Schema.parse(value);
  if (!validateSnapshotVersion13Schema(value)) {
    const issueCount = validateSnapshotVersion13Schema.errors?.length ?? 1;
    throw new StateSnapshotSchemaError(issueCount);
  }
  assertSnapshotSemantics(value, "6", "legacy", false, false);
  return value;
}

function parseStateSnapshotVersion14Value(value: unknown): StateSnapshotVersion14 {
  snapshotSchemaVersion14Schema.parse(value);
  if (!validateSnapshotVersion14Schema(value)) {
    const issueCount = validateSnapshotVersion14Schema.errors?.length ?? 1;
    throw new StateSnapshotSchemaError(issueCount);
  }
  assertSnapshotSemantics(value, "source", "current", false, false);
  return value;
}

function parseStateSnapshotVersion15Value(value: unknown): StateSnapshotVersion15 {
  snapshotSchemaVersion15Schema.parse(value);
  if (!validateSnapshotVersion15Schema(value)) {
    const issueCount = validateSnapshotVersion15Schema.errors?.length ?? 1;
    throw new StateSnapshotSchemaError(issueCount);
  }
  assertSnapshotSemantics(value, "source", "current", false, false);
  return value;
}

function parseStateSnapshotVersion16Value(value: unknown): StateSnapshotVersion16 {
  snapshotSchemaVersion16Schema.parse(value);
  if (!validateSnapshotVersion16Schema(value)) {
    const issueCount = validateSnapshotVersion16Schema.errors?.length ?? 1;
    throw new StateSnapshotSchemaError(issueCount);
  }
  assertSnapshotSemantics(value, "source", "current", false, false);
  return value;
}

function parseStateSnapshotVersion17Value(value: unknown): StateSnapshotVersion17 {
  snapshotSchemaVersion17Schema.parse(value);
  if (!validateSnapshotVersion17Schema(value)) {
    const issueCount = validateSnapshotVersion17Schema.errors?.length ?? 1;
    throw new StateSnapshotSchemaError(issueCount);
  }
  assertSnapshotSemantics(value, "source", "current", true, false);
  return value;
}

function parseStateSnapshotVersion18Value(value: unknown): StateSnapshotVersion18 {
  snapshotSchemaVersion18Schema.parse(value);
  if (!validateSnapshotVersion18Schema(value)) {
    const issueCount = validateSnapshotVersion18Schema.errors?.length ?? 1;
    throw new StateSnapshotSchemaError(issueCount);
  }
  return value;
}

/** schema version 18のsnapshotを構造検証して読み取る。 */
export function parseStateSnapshotVersion18(source: string): StateSnapshotVersion18 {
  let value: unknown;
  try {
    const parseJson: (text: string) => unknown = JSON.parse;
    value = parseJson(source);
  } catch (error: unknown) {
    throw new StateFormatError("snapshot", {
      cause: new SyntaxError("JSON構文が不正です", {
        cause: error,
      }),
    });
  }
  try {
    return parseStateSnapshotVersion18Value(value);
  } catch (error: unknown) {
    if (error instanceof StateSnapshotSchemaError) {
      throw error;
    }
    throw new StateFormatError("snapshot", {
      cause: new TypeError("snapshot検証中に予期しないエラーが発生しました", {
        cause: error,
      }),
    });
  }
}

function parseStateSnapshotVersion19Value(value: unknown): StateSnapshot {
  snapshotSchemaVersion19Schema.parse(value);
  if (!validateSnapshotVersion19Schema(value)) {
    const issueCount = validateSnapshotVersion19Schema.errors?.length ?? 1;
    throw new StateSnapshotSchemaError(issueCount);
  }
  assertSnapshotSemantics(value, "source", "current", true, true);
  return value;
}

function parseVersionedStateSnapshot(value: unknown): StateSnapshot {
  const version = z.object({ schemaVersion: z.string() }).parse(value).schemaVersion;
  if (version === SNAPSHOT_SCHEMA_VERSION_19) {
    return normalizeSnapshot(parseStateSnapshotVersion19Value(value));
  }
  throw new StateSnapshotSchemaError(1);
}

/** 未検証の値をschema検証済みかつ決定論的順序のsnapshotへ変換する。 */
export function createStateSnapshot(value: unknown): StateSnapshot {
  return normalizeSnapshot(parseStateSnapshotVersion19Value(value));
}

/** snapshotを末尾改行付きcanonical JSONへ変換する。 */
export function serializeStateSnapshot(snapshot: StateSnapshot): string {
  return serializeCanonicalJsonLine(createStateSnapshot(snapshot));
}

/** canonical JSONからsnapshotを検証して読み取る。 */
export function parseStateSnapshot(source: string): StateSnapshot {
  let value: unknown;
  try {
    const parseJson: (text: string) => unknown = JSON.parse;
    value = parseJson(source);
  } catch (error: unknown) {
    throw new StateFormatError("snapshot", {
      cause: new SyntaxError("JSON構文が不正です", {
        cause: error,
      }),
    });
  }

  try {
    return parseVersionedStateSnapshot(value);
  } catch (error: unknown) {
    if (
      error instanceof StateFormatError ||
      error instanceof StateSnapshotSchemaError ||
      error instanceof StateSnapshotSemanticError
    ) {
      throw error;
    }
    throw new StateFormatError("snapshot", {
      cause: new TypeError("snapshot検証中に予期しないエラーが発生しました", {
        cause: error,
      }),
    });
  }
}

/** schema version 11のsnapshotを検証して読み取る。 */
export function parseStateSnapshotVersion11(source: string): StateSnapshotVersion11 {
  let value: unknown;
  try {
    const parseJson: (text: string) => unknown = JSON.parse;
    value = parseJson(source);
  } catch (error: unknown) {
    throw new StateFormatError("snapshot", {
      cause: new SyntaxError("JSON構文が不正です", {
        cause: error,
      }),
    });
  }

  try {
    return parseStateSnapshotVersion11Value(value);
  } catch (error: unknown) {
    if (
      error instanceof StateFormatError ||
      error instanceof StateSnapshotSchemaError ||
      error instanceof StateSnapshotSemanticError
    ) {
      throw error;
    }
    throw new StateFormatError("snapshot", {
      cause: new TypeError("snapshot検証中に予期しないエラーが発生しました", {
        cause: error,
      }),
    });
  }
}

/** schema version 12のsnapshotを検証して読み取る。 */
export function parseStateSnapshotVersion12(source: string): StateSnapshotVersion12 {
  let value: unknown;
  try {
    const parseJson: (text: string) => unknown = JSON.parse;
    value = parseJson(source);
  } catch (error: unknown) {
    throw new StateFormatError("snapshot", {
      cause: new SyntaxError("JSON構文が不正です", {
        cause: error,
      }),
    });
  }

  try {
    return parseStateSnapshotVersion12Value(value);
  } catch (error: unknown) {
    if (
      error instanceof StateFormatError ||
      error instanceof StateSnapshotSchemaError ||
      error instanceof StateSnapshotSemanticError
    ) {
      throw error;
    }
    throw new StateFormatError("snapshot", {
      cause: new TypeError("snapshot検証中に予期しないエラーが発生しました", {
        cause: error,
      }),
    });
  }
}

/** schema version 13のsnapshotを検証して読み取る。 */
export function parseStateSnapshotVersion13(source: string): StateSnapshotVersion13 {
  let value: unknown;
  try {
    const parseJson: (text: string) => unknown = JSON.parse;
    value = parseJson(source);
  } catch (error: unknown) {
    throw new StateFormatError("snapshot", {
      cause: new SyntaxError("JSON構文が不正です", {
        cause: error,
      }),
    });
  }

  try {
    return parseStateSnapshotVersion13Value(value);
  } catch (error: unknown) {
    if (
      error instanceof StateFormatError ||
      error instanceof StateSnapshotSchemaError ||
      error instanceof StateSnapshotSemanticError
    ) {
      throw error;
    }
    throw new StateFormatError("snapshot", {
      cause: new TypeError("snapshot検証中に予期しないエラーが発生しました", {
        cause: error,
      }),
    });
  }
}

/** schema version 14のsnapshotを検証して読み取る。 */
export function parseStateSnapshotVersion14(source: string): StateSnapshotVersion14 {
  let value: unknown;
  try {
    const parseJson: (text: string) => unknown = JSON.parse;
    value = parseJson(source);
  } catch (error: unknown) {
    throw new StateFormatError("snapshot", {
      cause: new SyntaxError("JSON構文が不正です", {
        cause: error,
      }),
    });
  }

  try {
    return parseStateSnapshotVersion14Value(value);
  } catch (error: unknown) {
    if (
      error instanceof StateFormatError ||
      error instanceof StateSnapshotSchemaError ||
      error instanceof StateSnapshotSemanticError
    ) {
      throw error;
    }
    throw new StateFormatError("snapshot", {
      cause: new TypeError("snapshot検証中に予期しないエラーが発生しました", {
        cause: error,
      }),
    });
  }
}

/** schema version 15のsnapshotを検証して読み取る。 */
export function parseStateSnapshotVersion15(source: string): StateSnapshotVersion15 {
  let value: unknown;
  try {
    const parseJson: (text: string) => unknown = JSON.parse;
    value = parseJson(source);
  } catch (error: unknown) {
    throw new StateFormatError("snapshot", {
      cause: new SyntaxError("JSON構文が不正です", {
        cause: error,
      }),
    });
  }

  try {
    return parseStateSnapshotVersion15Value(value);
  } catch (error: unknown) {
    if (
      error instanceof StateFormatError ||
      error instanceof StateSnapshotSchemaError ||
      error instanceof StateSnapshotSemanticError
    ) {
      throw error;
    }
    throw new StateFormatError("snapshot", {
      cause: new TypeError("snapshot検証中に予期しないエラーが発生しました", {
        cause: error,
      }),
    });
  }
}

/** schema version 16のsnapshotを検証して読み取る。 */
export function parseStateSnapshotVersion16(source: string): StateSnapshotVersion16 {
  let value: unknown;
  try {
    const parseJson: (text: string) => unknown = JSON.parse;
    value = parseJson(source);
  } catch (error: unknown) {
    throw new StateFormatError("snapshot", {
      cause: new SyntaxError("JSON構文が不正です", {
        cause: error,
      }),
    });
  }

  try {
    return parseStateSnapshotVersion16Value(value);
  } catch (error: unknown) {
    if (
      error instanceof StateFormatError ||
      error instanceof StateSnapshotSchemaError ||
      error instanceof StateSnapshotSemanticError
    ) {
      throw error;
    }
    throw new StateFormatError("snapshot", {
      cause: new TypeError("snapshot検証中に予期しないエラーが発生しました", {
        cause: error,
      }),
    });
  }
}

/** schema version 17のsnapshotを検証して読み取る。 */
export function parseStateSnapshotVersion17(source: string): StateSnapshotVersion17 {
  let value: unknown;
  try {
    const parseJson: (text: string) => unknown = JSON.parse;
    value = parseJson(source);
  } catch (error: unknown) {
    throw new StateFormatError("snapshot", {
      cause: new SyntaxError("JSON構文が不正です", {
        cause: error,
      }),
    });
  }

  try {
    return parseStateSnapshotVersion17Value(value);
  } catch (error: unknown) {
    if (
      error instanceof StateFormatError ||
      error instanceof StateSnapshotSchemaError ||
      error instanceof StateSnapshotSemanticError
    ) {
      throw error;
    }
    throw new StateFormatError("snapshot", {
      cause: new TypeError("snapshot検証中に予期しないエラーが発生しました", {
        cause: error,
      }),
    });
  }
}
