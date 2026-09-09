import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { serializeCanonicalJsonLine } from "../persistence/index.js";
import { PublicDataWriteError, PublicDtoSemanticError } from "./errors.js";
import { type GeneratedPublicData } from "./generate-public-data.js";
import {
  createPublicDetailsDto,
  createPublicNotificationHistoryDto,
  createPublicSummaryDto,
} from "./public-dto.js";
import { assertPublicSummarySize } from "./summary-size.js";

/** 初期表示用公開DTOの固定ファイル名。 */
export const PUBLIC_SUMMARY_FILE_NAME = "summary.json";

/** 詳細表示用公開DTOの固定ファイル名。 */
export const PUBLIC_DETAILS_FILE_NAME = "details.json";

/** 通知履歴公開DTOの固定ファイル名。 */
export const PUBLIC_NOTIFICATION_HISTORY_FILE_NAME = "notification-history.json";

/** 公開DTOを書き出したパスとbyte数。 */
export type PublicDataWriteResult = Readonly<{
  summaryPath: string;
  detailsPath: string;
  notificationHistoryPath: string;
  summaryBytes: number;
  detailsBytes: number;
  notificationHistoryBytes: number;
}>;

async function writePublicFile(path: string, fileName: string, source: string): Promise<void> {
  try {
    await writeFile(path, source, {
      encoding: "utf8",
      flag: "w",
    });
  } catch (error: unknown) {
    throw new PublicDataWriteError(fileName, {
      cause: error,
    });
  }
}

/** 検証済み公開DTOをsummaryとdetailsのcanonical JSONへ書き出す。 */
export async function writePublicDataFiles(
  outputDirectory: string,
  data: GeneratedPublicData,
): Promise<PublicDataWriteResult> {
  if (outputDirectory.length === 0) {
    throw new PublicDtoSemanticError("公開DTOの出力directoryは空にできません");
  }
  const summary = createPublicSummaryDto(data.summary);
  const details = createPublicDetailsDto(data.details);
  const notificationHistory = createPublicNotificationHistoryDto(data.notificationHistory);
  if (
    summary.runId !== details.runId ||
    summary.generatedAt !== details.generatedAt ||
    summary.runId !== notificationHistory.runId ||
    summary.generatedAt !== notificationHistory.generatedAt
  ) {
    throw new PublicDtoSemanticError(
      "summary、details、notification historyのrun情報が一致しません",
    );
  }
  const measurement = assertPublicSummarySize(summary, data.summarySize.maximumBytes);
  if (
    measurement.uncompressedBytes !== data.summarySize.uncompressedBytes ||
    measurement.gzipBytes !== data.summarySize.gzipBytes
  ) {
    throw new PublicDtoSemanticError("summaryの実測サイズが生成時の値と一致しません");
  }

  try {
    await mkdir(outputDirectory, {
      recursive: true,
    });
  } catch (error: unknown) {
    throw new PublicDataWriteError("出力directory", {
      cause: error,
    });
  }

  const summarySource = serializeCanonicalJsonLine(summary);
  const detailsSource = serializeCanonicalJsonLine(details);
  const notificationHistorySource = serializeCanonicalJsonLine(notificationHistory);
  const summaryPath = join(outputDirectory, PUBLIC_SUMMARY_FILE_NAME);
  const detailsPath = join(outputDirectory, PUBLIC_DETAILS_FILE_NAME);
  const notificationHistoryPath = join(outputDirectory, PUBLIC_NOTIFICATION_HISTORY_FILE_NAME);
  await Promise.all([
    writePublicFile(summaryPath, PUBLIC_SUMMARY_FILE_NAME, summarySource),
    writePublicFile(detailsPath, PUBLIC_DETAILS_FILE_NAME, detailsSource),
    writePublicFile(
      notificationHistoryPath,
      PUBLIC_NOTIFICATION_HISTORY_FILE_NAME,
      notificationHistorySource,
    ),
  ]);

  return Object.freeze({
    summaryPath,
    detailsPath,
    notificationHistoryPath,
    summaryBytes: Buffer.byteLength(summarySource, "utf8"),
    detailsBytes: Buffer.byteLength(detailsSource, "utf8"),
    notificationHistoryBytes: Buffer.byteLength(notificationHistorySource, "utf8"),
  });
}
