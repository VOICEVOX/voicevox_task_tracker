import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  isSourceLineExcluded,
  SOURCE_LINE_CHECKER_VERSION,
  SOURCE_LINE_EXTENSIONS,
  SOURCE_LINE_PERMANENT_EXCLUSIONS,
  SOURCE_LINE_ROOTS,
} from "../config/source-line-policy.mjs";

const CACHE_PATH = "node_modules/.cache/voicevox-task-tracker/source-lines.json";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function sourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = `${directory}/${entry.name}`;
    if (isSourceLineExcluded(path)) {
      return [];
    }
    if (entry.isDirectory()) {
      return sourceFiles(path);
    }
    if (entry.isFile() && SOURCE_LINE_EXTENSIONS.some((extension) => path.endsWith(extension))) {
      return [path];
    }
    return [];
  });
}

function readCache(key) {
  if (!existsSync(CACHE_PATH)) {
    return {};
  }
  const cache = JSON.parse(readFileSync(CACHE_PATH, "utf8"));
  if (cache.key !== key) {
    return {};
  }
  if (typeof cache.entries !== "object" || cache.entries == null || Array.isArray(cache.entries)) {
    throw new TypeError("source line cacheの形式が不正です");
  }
  return cache.entries;
}

function lineCount(bytes) {
  const source = bytes.toString("utf8");
  return source.split("\n").length - Number(source.endsWith("\n"));
}

function main() {
  const cacheKey = sha256(
    JSON.stringify({
      checkerVersion: SOURCE_LINE_CHECKER_VERSION,
      roots: SOURCE_LINE_ROOTS,
      extensions: SOURCE_LINE_EXTENSIONS,
      exclusions: SOURCE_LINE_PERMANENT_EXCLUSIONS,
    }),
  );
  const previousCache = readCache(cacheKey);
  const nextCache = {};
  const failures = [];
  const files = SOURCE_LINE_ROOTS.flatMap((root) => sourceFiles(root));

  for (const path of files) {
    const bytes = readFileSync(path);
    const digest = sha256(bytes);
    const cached = previousCache[path];
    const lines = cached?.sha256 === digest ? cached.lineCount : lineCount(bytes);
    nextCache[path] = { sha256: digest, lineCount: lines };
    if (lines > 1000) {
      failures.push(`${path}: ${lines}行です。上限は1000行です`);
    }
  }
  if (failures.length > 0) {
    throw new TypeError(failures.join("\n"));
  }
  mkdirSync(join("node_modules", ".cache", "voicevox-task-tracker"), { recursive: true });
  writeFileSync(CACHE_PATH, `${JSON.stringify({ key: cacheKey, entries: nextCache })}\n`);
}

main();
