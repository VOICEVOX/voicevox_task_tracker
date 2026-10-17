import { gzipSync, gunzipSync } from "node:zlib";

import type { CheckpointCompressionPort } from "./publication-checkpoint-frames.js";

/** Node.jsのgzipで単一frameを圧縮し、余剰byteを拒否する。 */
export const nodeCheckpointCompressionPort: CheckpointCompressionPort = {
  compress(value: Uint8Array): Uint8Array {
    return gzipSync(value, { level: 6 });
  },
  decompress(value: Uint8Array, maxOutputLength: number): Uint8Array {
    const output = gunzipSync(value, { maxOutputLength });
    const canonical = gzipSync(output, { level: 6 });
    if (
      canonical.length !== value.length ||
      !canonical.every((byte, index) => byte === value[index])
    ) {
      throw new TypeError("checkpoint gzip frameに余剰または非canonical byteがあります");
    }
    return output;
  },
};
