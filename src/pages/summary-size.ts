import { gzipSync } from "node:zlib";

import { serializeCanonicalJsonLine } from "../canonical-json/index.js";
import { PublicDtoSemanticError, PublicSummarySizeError } from "./errors.js";
import { createPublicSummaryDto, type PublicSummaryDto } from "./public-dto.js";

/** 公開summaryに許可するgzip後の最大byte数。 */
export const PUBLIC_SUMMARY_GZIP_LIMIT_BYTES = 1024 * 1024;

/** 公開summaryを直列化して得た実測サイズ。 */
export type PublicSummarySizeMeasurement = Readonly<{
  uncompressedBytes: number;
  gzipBytes: number;
  maximumBytes: number;
}>;

function validateMaximumBytes(maximumBytes: number): void {
  if (
    !Number.isInteger(maximumBytes) ||
    maximumBytes <= 0 ||
    maximumBytes > PUBLIC_SUMMARY_GZIP_LIMIT_BYTES
  ) {
    throw new PublicDtoSemanticError(
      `summary gzip上限は1以上${PUBLIC_SUMMARY_GZIP_LIMIT_BYTES.toString()}以下の整数にしてください`,
    );
  }
}

/** 公開summaryのcanonical JSONをgzip圧縮してサイズを実測する。 */
export function measurePublicSummarySize(
  summary: PublicSummaryDto,
  maximumBytes: number,
): PublicSummarySizeMeasurement {
  validateMaximumBytes(maximumBytes);
  const validatedSummary = createPublicSummaryDto(summary);
  const source = serializeCanonicalJsonLine(validatedSummary);
  return Object.freeze({
    uncompressedBytes: Buffer.byteLength(source, "utf8"),
    gzipBytes: gzipSync(source, {
      level: 9,
    }).byteLength,
    maximumBytes,
  });
}

/** 公開summaryのgzipサイズを実測し、上限内でなければ失敗させる。 */
export function assertPublicSummarySize(
  summary: PublicSummaryDto,
  maximumBytes: number,
): PublicSummarySizeMeasurement {
  const measurement = measurePublicSummarySize(summary, maximumBytes);
  if (measurement.gzipBytes > measurement.maximumBytes) {
    throw new PublicSummarySizeError(measurement.gzipBytes, measurement.maximumBytes);
  }
  return measurement;
}
