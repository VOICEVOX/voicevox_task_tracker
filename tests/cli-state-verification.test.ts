import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { StateVerificationRunner, verifyPersistentStateDirectory } from "../src/cli/index.js";
import {
  hashCanonicalJson,
  serializeCanonicalJsonLine,
} from "../src/persistence/canonical-json.js";

const GENERATED_AT = "2020-08-01T00:00:00.000Z";
const REPOSITORY_ID = "R_VERIFY_STATE";
const REPOSITORY_PATH = `state/github-repositories/${hashCanonicalJson({
  identifier: REPOSITORY_ID,
  kind: "github_repository",
}).slice("sha256:".length)}.json`;

const repositoryCache = {
  schemaVersion: "4",
  kind: "github_repository",
  repository: {
    repositoryId: REPOSITORY_ID,
    owner: "VOICEVOX",
    name: "verify-state",
  },
  successfulAt: GENERATED_AT,
  items: [],
};

const cacheDirectories: readonly [
  "github-repositories",
  "github-items",
  "ai-latest-importance",
  "ai-results",
] = ["github-repositories", "github-items", "ai-latest-importance", "ai-results"];

async function createStateDirectory(): Promise<string> {
  const stateDirectory = await mkdtemp(join(tmpdir(), "voicevox-verify-state-test-"));
  await Promise.all(cacheDirectories.map((directory) => mkdir(join(stateDirectory, directory))));
  return stateDirectory;
}

async function writeRepositoryCache(stateDirectory: string, value: unknown): Promise<void> {
  await writeFile(
    join(stateDirectory, REPOSITORY_PATH.replace("state/", "")),
    serializeCanonicalJsonLine(value),
    "utf8",
  );
}

describe("cache-only state検証", () => {
  it("4種類のcacheをschemaと文書間整合性まで検証して件数を返す", async () => {
    const stateDirectory = await createStateDirectory();
    try {
      await writeRepositoryCache(stateDirectory, repositoryCache);

      await expect(verifyPersistentStateDirectory(stateDirectory)).resolves.toEqual({
        repositoryCaches: {
          verifiedCount: 1,
          schemaVersions: ["4"],
        },
        itemCaches: {
          verifiedCount: 0,
          schemaVersions: [],
        },
        latestImportanceCaches: {
          verifiedCount: 0,
          schemaVersions: [],
        },
        aiCacheEntries: {
          verifiedCount: 0,
          schemaVersions: [],
        },
      });
    } finally {
      await rm(stateDirectory, {
        recursive: true,
        force: true,
      });
    }
  });

  it("cacheごとの件数とschema versionを標準出力へ書く", async () => {
    const stateDirectory = await createStateDirectory();
    const outputs: string[] = [];
    const runner = new StateVerificationRunner({
      verifyStateDirectory: verifyPersistentStateDirectory,
      writeStandardOutput: (source) => {
        outputs.push(source);
        return Promise.resolve();
      },
    });
    try {
      await writeRepositoryCache(stateDirectory, repositoryCache);
      await runner.run({
        kind: "verify-state",
        stateDirectory,
      });

      expect(outputs).toEqual([
        [
          "github-repositories: 1件、schema version 4",
          "github-items: 0件、schema version なし",
          "ai-latest-importance: 0件、schema version なし",
          "ai-results: 0件、schema version なし",
          "",
        ].join("\n"),
      ]);
    } finally {
      await rm(stateDirectory, {
        recursive: true,
        force: true,
      });
    }
  });

  it("schema version 2のcacheを現行形式として読み込まない", async () => {
    const stateDirectory = await createStateDirectory();
    try {
      await writeRepositoryCache(stateDirectory, {
        ...repositoryCache,
        schemaVersion: "2",
      });
      await expect(verifyPersistentStateDirectory(stateDirectory)).rejects.toThrow(
        "永続stateを検証できません",
      );
    } finally {
      await rm(stateDirectory, {
        recursive: true,
        force: true,
      });
    }
  });

  it("4種類のdirectoryが空でもcache-only stateとして許可する", async () => {
    const stateDirectory = await createStateDirectory();
    try {
      await expect(verifyPersistentStateDirectory(stateDirectory)).resolves.toMatchObject({
        repositoryCaches: { verifiedCount: 0 },
        itemCaches: { verifiedCount: 0 },
        latestImportanceCaches: { verifiedCount: 0 },
        aiCacheEntries: { verifiedCount: 0 },
      });
    } finally {
      await rm(stateDirectory, {
        recursive: true,
        force: true,
      });
    }
  });

  it("snapshot、history、ledger、run reportや未知pathを拒否する", async () => {
    const stateDirectory = await createStateDirectory();
    try {
      await writeFile(join(stateDirectory, "snapshot.json"), "{}", "utf8");
      await expect(verifyPersistentStateDirectory(stateDirectory)).rejects.toThrow(
        "永続stateを検証できません",
      );
    } finally {
      await rm(stateDirectory, {
        recursive: true,
        force: true,
      });
    }
  });

  it("cache文書のstrict schemaと公開安全性違反を拒否する", async () => {
    const stateDirectory = await createStateDirectory();
    try {
      await writeRepositoryCache(stateDirectory, {
        ...repositoryCache,
        body: "本文を保存してはいけません",
      });
      await expect(verifyPersistentStateDirectory(stateDirectory)).rejects.toThrow(
        "永続stateを検証できません",
      );
    } finally {
      await rm(stateDirectory, {
        recursive: true,
        force: true,
      });
    }
  });

  it("state directoryがなければ失敗する", async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "voicevox-verify-state-missing-test-"));
    await rm(stateDirectory, {
      recursive: true,
      force: true,
    });
    await expect(verifyPersistentStateDirectory(stateDirectory)).rejects.toThrow(
      "永続stateを検証できません",
    );
  });
});
