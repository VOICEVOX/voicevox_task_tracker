import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { digestPagesContentManifest } from "../application/tracking-run/pages-build-contracts.js";
import { nodeContentDigestPort } from "../infrastructure/tracking-run/content-digest.js";

const execFileAsync = promisify(execFile);

/** source rootの設定と現在の公開DTOからWeb出力をビルドする。 */
export async function buildWebOutput(repositoryPath: string): Promise<void> {
  await execFileAsync("pnpm", ["build:web"], {
    cwd: repositoryPath,
    maxBuffer: 8 * 1024 * 1024,
  });
}

/** Web出力全fileの実byteをcanonical manifestへ固定する。 */
export async function readPagesContentManifest(
  directory: string,
): Promise<ReturnType<typeof digestPagesContentManifest>> {
  const root = resolve(directory);
  const files: { path: string; byteLength: number; sha256: string }[] = [];
  const pending = [""];
  while (pending.length > 0) {
    const relativeDirectory = pending.pop();
    if (relativeDirectory == null) {
      throw new TypeError("Pages出力directoryの走査位置がありません");
    }
    const entries = await readdir(join(root, relativeDirectory), { withFileTypes: true });
    for (const entry of entries) {
      const path = relativeDirectory === "" ? entry.name : `${relativeDirectory}/${entry.name}`;
      if (entry.isDirectory()) {
        pending.push(path);
      } else if (entry.isFile()) {
        const bytes = await readFile(join(root, path));
        files.push({
          path,
          byteLength: bytes.byteLength,
          sha256: nodeContentDigestPort.sha256Bytes(bytes),
        });
      } else {
        throw new TypeError("Pages出力に通常file以外が含まれています");
      }
    }
  }
  files.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  return digestPagesContentManifest({ schemaVersion: 1, files }, nodeContentDigestPort);
}
