import { readdir, readFile } from "node:fs/promises";
import { join, posix } from "node:path";

import { describe, expect, it } from "vitest";

import { hashCanonicalJson, type Sha256Hash } from "../src/persistence/canonical-json.js";

const REPOSITORY_ROOT = join(import.meta.dirname, "..");
const HASH_RECORD_PATH = "tests/rules-version-hash.test.ts";
const DETERMINISTIC_RULES_HASH =
  "sha256:9d28cab4a8558bfe1aa3a513ee78af642a9d203f55006ce8d827623fb9a7de79";
const PROMPT_FILES_HASH = "sha256:9b016a72806902f0bf45f5193766b99c4d457dd8a8bff9e12f07d3e3133d7020";

async function listRelativeFiles(
  relativeDirectory: string,
  includeFile: (relativePath: string) => boolean,
): Promise<readonly string[]> {
  const entries = await readdir(join(REPOSITORY_ROOT, relativeDirectory), {
    withFileTypes: true,
  });
  const relativePaths: string[] = [];
  for (const entry of entries) {
    const relativePath = posix.join(relativeDirectory, entry.name);
    if (entry.isDirectory()) {
      relativePaths.push(...(await listRelativeFiles(relativePath, includeFile)));
    } else if (entry.isFile()) {
      if (includeFile(relativePath)) {
        relativePaths.push(relativePath);
      }
    } else {
      throw new TypeError(`hash対象に未対応のfilesystem entryがあります: ${relativePath}`);
    }
  }
  return relativePaths;
}

async function hashRelativeFiles(relativePaths: readonly string[]): Promise<Sha256Hash> {
  const files = await Promise.all(
    [...relativePaths].sort().map(async (relativePath) => ({
      content: await readFile(join(REPOSITORY_ROOT, relativePath), "utf8"),
      relativePath,
    })),
  );
  return hashCanonicalJson(files);
}

describe("判定規則versionの更新", () => {
  it("決定論的判定の内容を記録hashと一致させる", async () => {
    const domainFiles = await listRelativeFiles("src/domain", (relativePath) =>
      relativePath.endsWith(".ts"),
    );
    const actualHash = await hashRelativeFiles([...domainFiles, "src/codex/reducer.ts"]);

    expect(
      actualHash,
      [
        "決定論的判定のhashが記録値と異なります。",
        "判定結果が変わるなら、影響する項目に対応した ISSUE_DETERMINISTIC_RULES_VERSION または PULL_REQUEST_DETERMINISTIC_RULES_VERSION を上げたうえで記録hashを更新してください。",
        "判定結果が変わらないなら記録hashだけを更新してください。",
        `記録hashの更新場所: ${HASH_RECORD_PATH} の DETERMINISTIC_RULES_HASH`,
      ].join("\n"),
    ).toBe(DETERMINISTIC_RULES_HASH);
  });

  it("プロンプトの内容を記録hashと一致させる", async () => {
    const promptFiles = await listRelativeFiles("prompts", () => true);
    const actualHash = await hashRelativeFiles(promptFiles);

    expect(
      actualHash,
      [
        "プロンプトのhashが記録値と異なります。",
        "判定結果が変わるなら config.yml の ai.promptVersion を上げたうえで記録hashを更新してください。",
        "判定結果が変わらないなら記録hashだけを更新してください。",
        `記録hashの更新場所: ${HASH_RECORD_PATH} の PROMPT_FILES_HASH`,
      ].join("\n"),
    ).toBe(PROMPT_FILES_HASH);
  });
});
