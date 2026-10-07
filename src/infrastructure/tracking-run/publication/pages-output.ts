import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { serializeCanonicalJson } from "../../../canonical-json/value.js";
import type { Config } from "../../../config/index.js";
import { loadWebConfig } from "../../../config/index.js";
import { createGitHubRepositoryId } from "../../../domain/index.js";
import { generatePublicData, readPagesContentManifest } from "../../../pages/index.js";
import type { StateHistoryRecord, StateSnapshot } from "../../../persistence/index.js";
import type { DurablePublicationRecord } from "../../../publication/durable-record-schema.js";
import { nodeContentDigestPort as digest } from "../content-digest.js";
import type { InitialPagesPreparedRun, RunPublicationAdapters } from "./contracts.js";

/** 両Pages phaseに共通のexact state投影とWeb出力。 */
export type BuildPagesOutputInput = Readonly<{
  phase: "initial" | "notification_history";
  config: Config;
  record: DurablePublicationRecord;
  snapshot: StateSnapshot;
  historyRecords: readonly StateHistoryRecord[];
  repositoryPath: string;
  outputDirectory: string;
  knownSecrets: readonly string[];
  writePublicData: RunPublicationAdapters["writePublicData"];
  buildWebOutput: RunPublicationAdapters["buildWebOutput"];
}>;

/** 共通DTOを投影し、全file manifestを実byteから作る。 */
export async function buildPagesOutput(input: BuildPagesOutputInput): Promise<
  Pick<InitialPagesPreparedRun, "data" | "output" | "manifest"> &
    Readonly<{
      outputManifestDigest: string;
      pagesContentDigest: string;
    }>
> {
  const dataDirectory = resolve(input.repositoryPath, "web/public/data");
  if (resolve(input.outputDirectory) !== dataDirectory) {
    throw new TypeError("Pages公開DTOの出力先がWeb buildの入力directoryと一致しません");
  }
  const webConfig = await loadWebConfig(resolve(input.repositoryPath, "config.yml"));
  if (serializeCanonicalJson(webConfig) !== serializeCanonicalJson(input.config.web)) {
    throw new TypeError("Pages buildのWeb設定が保存済み設定と一致しません");
  }
  const projection = input.record.initialPagesProjection;
  const data = generatePublicData({
    snapshot: input.snapshot,
    historyRecords: input.historyRecords,
    repositoryAllowlist: projection.repositoryAllowlist.map((repository) => ({
      ...repository,
      id: createGitHubRepositoryId(repository.id),
    })),
    repositoryInventory: input.snapshot.repositories,
    knownSecrets: input.knownSecrets,
    options: {
      confidenceThresholds: projection.settings.confidenceThresholds,
      labelRules: projection.settings.labelRules,
      maxInitialGraphNodes: projection.settings.maxInitialGraphNodes,
      maxSummaryGzipBytes: projection.settings.maxSummaryGzipBytes,
      timezone: projection.settings.timezone,
    },
  });
  if (
    data.summary.runId !== input.record.runIdentity.runId ||
    (input.phase === "initial" && data.summary.generatedAt !== projection.generatedAt)
  ) {
    throw new TypeError("Pages公開DTOのrunと生成時刻がrecordと一致しません");
  }
  const output = await input.writePublicData(dataDirectory, data);
  await input.buildWebOutput(input.repositoryPath);
  const outputManifest = await readPagesContentManifest(resolve(input.repositoryPath, "dist/web"));
  const dataFiles: readonly (readonly [string, string])[] = [
    ["summary.json", output.summaryPath],
    ["details.json", output.detailsPath],
    ["notification-history.json", output.notificationHistoryPath],
  ];
  for (const [name, path] of dataFiles) {
    const entry = outputManifest.manifest.files.find((file) => file.path === `data/${name}`);
    const bytes = await readFile(path);
    if (entry?.byteLength !== bytes.byteLength || entry.sha256 !== digest.sha256Bytes(bytes)) {
      throw new TypeError("Pages buildの公開DTOとWeb出力manifestが一致しません");
    }
  }
  return Object.freeze({
    data,
    output,
    manifest: outputManifest.manifest,
    outputManifestDigest: outputManifest.outputManifestDigest,
    pagesContentDigest: outputManifest.pagesContentDigest,
  });
}
