import { PublicDtoValidationError } from "./errors.js";
import type {
  PublicDetailsDto,
  PublicNotificationHistoryDto,
  PublicSummaryDto,
} from "./public-dto-contracts.js";
import {
  assertPublicCurrentImplementations,
  assertPublicNativeGraphEdgeCurrentness,
  assertPublicUnverifiedBlockerSemantics,
  assertPublicUnverifiedRelationSemantics,
} from "./public-graph-dto-validation.js";
import { publicNotificationHistoryDtoSchema } from "./public-history-dto-schema.js";
import { assertPublicNotificationHistoryEntryItem } from "./public-history-dto-validation.js";
import { publicDetailsDtoSchema, publicSummaryDtoSchema } from "./public-item-dto-schema.js";
import {
  assertPublicCurrentResponseIds,
  assertPublicCurrentResponsesRequireCompletedPlanning,
  assertPublicDetailsCurrentResponseReferences,
  assertPublicDetailsWaitingOnReferences,
  assertPublicSummaryWaitingOnReferences,
} from "./public-reference-dto-validation.js";
import { assertPublicItemSummarySemantics } from "./public-reminder-dto-validation.js";

/** 未検証の値を共有公開summary DTOへ変換する。 */
export function createPublicSummaryDto(value: unknown): PublicSummaryDto {
  const result = publicSummaryDtoSchema.safeParse(value);
  if (!result.success) {
    throw new PublicDtoValidationError("summary", {
      cause: result.error,
    });
  }
  for (const item of result.data.items) {
    assertPublicItemSummarySemantics(item);
  }
  assertPublicCurrentResponseIds(result.data.items);
  assertPublicCurrentResponsesRequireCompletedPlanning(result.data.items);
  assertPublicSummaryWaitingOnReferences(result.data);
  assertPublicCurrentImplementations(result.data.items);
  return result.data;
}

/** 未検証の値を共有公開details DTOへ変換する。 */
export function createPublicDetailsDto(value: unknown): PublicDetailsDto {
  const result = publicDetailsDtoSchema.safeParse(value);
  if (!result.success) {
    throw new PublicDtoValidationError("details", {
      cause: result.error,
    });
  }
  assertPublicNativeGraphEdgeCurrentness(result.data.graph.edges);
  assertPublicUnverifiedRelationSemantics(result.data);
  assertPublicUnverifiedBlockerSemantics(result.data);
  assertPublicCurrentResponseIds(result.data.items.map((item) => item.summary));
  assertPublicCurrentResponsesRequireCompletedPlanning(
    result.data.items.map((item) => item.summary),
  );
  assertPublicDetailsWaitingOnReferences(result.data);
  assertPublicDetailsCurrentResponseReferences(result.data);
  assertPublicCurrentImplementations(result.data.items.map((item) => item.summary));
  return result.data;
}

/** 未検証の値を共有公開notification history DTOへ変換する。 */
export function createPublicNotificationHistoryDto(value: unknown): PublicNotificationHistoryDto {
  const result = publicNotificationHistoryDtoSchema.safeParse(value);
  if (!result.success) {
    throw new PublicDtoValidationError("notification-history", {
      cause: result.error,
    });
  }
  for (const notification of result.data.notifications) {
    assertPublicNotificationHistoryEntryItem(notification);
  }
  return result.data;
}
