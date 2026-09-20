import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { serializeCanonicalJsonLine } from "../canonical-json/index.js";
import { CliOutputError } from "./errors.js";

function validateOutputPath(path: string): void {
  if (path.length === 0) {
    throw new CliOutputError(path, {
      cause: new TypeError("出力パスは空にできません"),
    });
  }
}

/** 親directoryを作成してUTF-8テキストを上書きする。 */
export async function writeCliTextFile(path: string, source: string): Promise<void> {
  validateOutputPath(path);
  try {
    await mkdir(dirname(path), {
      recursive: true,
    });
    await writeFile(path, source, {
      encoding: "utf8",
      flag: "w",
    });
  } catch (error: unknown) {
    throw new CliOutputError(path, {
      cause: error,
    });
  }
}

/** JSON互換のCLI artifactをcanonical JSONで書き出す。 */
export async function writeCliJsonArtifact(path: string, value: unknown): Promise<void> {
  await writeCliTextFile(path, serializeCanonicalJsonLine(value));
}
