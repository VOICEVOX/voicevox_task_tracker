import { type FileHandle } from "node:fs/promises";

import { DiagnosticsError } from "./errors.js";

/** FileHandleへ指定したBufferを完全に書き込む。 */
export async function writeDiagnosticsBufferFully(
  handle: FileHandle,
  data: Uint8Array,
  message: string,
): Promise<void> {
  let offset = 0;
  while (offset < data.byteLength) {
    const result = await handle.write(data, offset, data.byteLength - offset);
    if (result.bytesWritten === 0) {
      throw new DiagnosticsError(message, {});
    }
    if (
      !Number.isSafeInteger(result.bytesWritten) ||
      result.bytesWritten < 0 ||
      result.bytesWritten > data.byteLength - offset
    ) {
      throw new DiagnosticsError("FileHandle.writeの書き込み量が不正です", {});
    }
    offset += result.bytesWritten;
  }
}
