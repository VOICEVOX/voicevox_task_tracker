import { readFile, stat } from "node:fs/promises";

import { z } from "zod";

const statusSchema = z.enum(["no_previous", "downloaded"]);

/** Actions一覧で確定した取得状態と前回結果のfileを照合する。 */
export async function readPreviousNotificationHistoryOutcome(
  path: string,
  status: unknown,
): Promise<Uint8Array | undefined> {
  const parsed = statusSchema.parse(status);
  if (parsed === "downloaded") {
    return readFile(path);
  }
  try {
    await stat(path);
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
  throw new TypeError("前回結果が不在と確認されたのにfileが存在します");
}
