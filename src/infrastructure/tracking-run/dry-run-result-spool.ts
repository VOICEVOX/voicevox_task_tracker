import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import { canonicalJsonPieces } from "../../canonical-json/value.js";
import type { PublicationPlannedRun } from "../../publication/publication-plan-contracts.js";
import { CliOutputError } from "./errors.js";
import type { DryRunArtifactMetadata } from "./sequential-report.js";

/** 完了まで非公開の一時領域に置くdry-run結果。 */
export type DryRunResultSpool = Readonly<{
  writeArtifact: (path: string, metadata: DryRunArtifactMetadata) => Promise<void>;
  dispose: () => Promise<void>;
}>;

type ArtifactField =
  | Readonly<{ kind: "value"; key: string; value: unknown }>
  | Readonly<{ kind: "spooled_result"; key: "result" }>;

async function* artifactPieces(
  metadata: DryRunArtifactMetadata,
  resultPath: string,
): AsyncIterable<string | Buffer> {
  const fields: ArtifactField[] = [
    ...Object.entries(metadata).map(
      ([key, value]) => ({ kind: "value", key, value }) satisfies ArtifactField,
    ),
    { kind: "spooled_result", key: "result" },
  ];
  fields.sort((left, right) => {
    if (left.key < right.key) return -1;
    if (left.key > right.key) return 1;
    return 0;
  });
  yield "{";
  for (const [index, field] of fields.entries()) {
    if (index > 0) yield ",";
    yield* canonicalJsonPieces(field.key);
    yield ":";
    if (field.kind === "spooled_result") {
      for await (const piece of createReadStream(resultPath)) {
        yield piece;
      }
    } else {
      yield* canonicalJsonPieces(field.value);
    }
  }
  yield "}\n";
}

/** 検証済み公開計画を一時ファイルへ逐次退避する。 */
export async function createDryRunResultSpool(
  planned: PublicationPlannedRun,
): Promise<DryRunResultSpool> {
  const directory = await mkdtemp(join(tmpdir(), "voicevox-dry-run-result-"));
  const resultPath = join(directory, "result.json");
  try {
    await pipeline(
      Readable.from(canonicalJsonPieces(planned)),
      createWriteStream(resultPath, { flags: "wx", mode: 0o600 }),
    );
  } catch (error: unknown) {
    try {
      await rm(directory, { recursive: true });
    } catch (cleanupError: unknown) {
      throw new AggregateError(
        [error, cleanupError],
        "dry-run一時結果の書込みと削除に失敗しました",
        { cause: error },
      );
    }
    throw error;
  }
  return Object.freeze({
    writeArtifact: async (path: string, metadata: DryRunArtifactMetadata): Promise<void> => {
      if (path.length === 0) {
        throw new CliOutputError(path, { cause: new TypeError("出力パスは空にできません") });
      }
      try {
        await mkdir(dirname(path), { recursive: true });
        await pipeline(
          Readable.from(artifactPieces(metadata, resultPath)),
          createWriteStream(path, { flags: "w" }),
        );
      } catch (error: unknown) {
        throw new CliOutputError(path, { cause: error });
      }
    },
    dispose: () => rm(directory, { recursive: true }),
  });
}
