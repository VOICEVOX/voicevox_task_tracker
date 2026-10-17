import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync } from "node:fs";
import process from "node:process";

import { isSourceLineExcluded } from "../config/source-line-policy.mjs";

const SOURCE_EXTENSIONS = [".cjs", ".cts", ".js", ".jsx", ".mjs", ".mts", ".ts", ".tsx"];
const CACHE_DIRECTORY = "node_modules/.cache/voicevox-task-tracker/eslint-cache";

function inputFiles(directory) {
  return readdirSync(directory === "" ? "." : directory, { withFileTypes: true }).flatMap(
    (entry) => {
      const path = directory === "" ? entry.name : `${directory}/${entry.name}`;
      if (isSourceLineExcluded(path) || (entry.isDirectory() && entry.name.startsWith("hiho"))) {
        return [];
      }
      if (entry.isDirectory()) {
        return inputFiles(path);
      }
      if (
        entry.isFile() &&
        (SOURCE_EXTENSIONS.some((extension) => path.endsWith(extension)) || path.endsWith(".json"))
      ) {
        return [path];
      }
      return [];
    },
  );
}

function cacheKey() {
  const digest = createHash("sha256");
  digest.update(process.version);
  digest.update("\0");
  const files = [...inputFiles(""), ".node-version", "pnpm-lock.yaml"].sort();
  for (const path of files) {
    const bytes = readFileSync(path);
    digest.update(path);
    digest.update("\0");
    digest.update(bytes);
    digest.update("\0");
  }
  return digest.digest("hex");
}

if (process.argv[2] !== "key") {
  throw new TypeError("eslint-cacheの実行モードはkeyを指定してください");
}
mkdirSync(CACHE_DIRECTORY, { recursive: true });
process.stdout.write(`${cacheKey()}\n`);
