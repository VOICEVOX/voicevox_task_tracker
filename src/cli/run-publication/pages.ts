import type { Config } from "../../config/index.js";
import type { Repository } from "../../domain/index.js";
import { generatePublicData, PUBLIC_SUMMARY_GZIP_LIMIT_BYTES } from "../../pages/index.js";
import type { PagesPublicSafetyInput } from "../../pages/index.js";
import type { StateHistoryRecord } from "../../persistence/index.js";
import type {
  PagesResult,
  ResolveLabelRules,
  RunPublicationAdapters,
  ValidatedRun,
} from "./contracts.js";
import { pagesUrl } from "./settings.js";

/** Pages成果物の生成と書込みに必要な値。 */
export type BuildPublicPagesInput = Readonly<{
  writePublicData: RunPublicationAdapters["writePublicData"];
  config: Config;
  inventory: readonly Repository[];
  repositoryAllowlist: PagesPublicSafetyInput["repositoryAllowlist"];
  validated: ValidatedRun;
  historyRecords: readonly StateHistoryRecord[];
  outputDirectory: string;
  knownSecrets: readonly string[];
  resolveLabelRules: ResolveLabelRules;
}>;

/** 検証済みsnapshotと保存後履歴からPages成果物を生成して書き込む。 */
export async function buildPublicPages(input: BuildPublicPagesInput): Promise<PagesResult> {
  const data = generatePublicData({
    snapshot: input.validated.snapshot,
    historyRecords: input.historyRecords,
    repositoryAllowlist: input.repositoryAllowlist,
    repositoryInventory: input.inventory,
    knownSecrets: input.knownSecrets,
    options: {
      confidenceThresholds: input.config.ai.confidence,
      labelRules: input.resolveLabelRules(),
      maxInitialGraphNodes: input.config.web.graph.maxInitialNodes,
      maxSummaryGzipBytes: PUBLIC_SUMMARY_GZIP_LIMIT_BYTES,
      timezone: input.config.staleness.timezone,
    },
  });
  const output = await input.writePublicData(input.outputDirectory, data);
  return Object.freeze({
    data,
    output,
    pagesUrl: pagesUrl(input.config),
  });
}
