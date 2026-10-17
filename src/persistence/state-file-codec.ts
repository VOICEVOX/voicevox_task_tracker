import type { StateFileReadResult } from "./branch-adapter.js";
import { StateFormatError } from "./errors.js";

/** stateファイルをUTF-8として読み取る。 */
export function decodeStateFile(result: StateFileReadResult, kind: string): string | undefined {
  if (result.status === "missing") {
    return undefined;
  }
  try {
    return new TextDecoder("utf-8", {
      fatal: true,
    }).decode(result.bytes);
  } catch (error: unknown) {
    throw new StateFormatError(kind, {
      cause: new TypeError("stateファイルがUTF-8ではありません", {
        cause: error,
      }),
    });
  }
}

/** stateファイルをUTF-8として書き出す。 */
export function encodeStateFile(source: string): Uint8Array {
  return new TextEncoder().encode(source);
}
