import { z } from "zod";

import type {
  publicNotificationHistoryDtoSchema,
  publicNotificationHistoryEntrySchema,
  publicNotificationHistoryPersonalReminderSchema,
} from "./public-history-dto-schema.js";
import type {
  publicDetailsDtoSchema,
  publicGraphEdgeSchema,
  publicGraphNodeSchema,
  publicItemDetailsSchema,
  publicItemHistoryEventSchema,
  publicItemSummarySchema,
  publicSummaryDtoSchema,
} from "./public-item-dto-schema.js";
import type {
  publicCurrentResponseSubjectChangesSchema,
  publicCurrentResponseSubjectSchema,
  publicPersonalReminderResponseSchema,
  publicPersonalReminderUnknownReasonSchema,
} from "./public-reminder-dto-schema.js";

/** Web初期表示で共有するschema version 10の公開summary DTO。 */
export type PublicSummaryDto = z.output<typeof publicSummaryDtoSchema>;

/** Web詳細表示で共有するschema version 10の公開details DTO。 */
export type PublicDetailsDto = z.output<typeof publicDetailsDtoSchema>;

/** 公開summary DTO内の項目。 */
export type PublicItemSummaryDto = z.output<typeof publicItemSummarySchema>;

/** 公開details DTO内の項目。 */
export type PublicItemDetailsDto = z.output<typeof publicItemDetailsSchema>;

/** 個人催促の現在対応を表す公開DTO。 */
export type PublicPersonalReminderResponseDto = z.output<
  typeof publicPersonalReminderResponseSchema
>;

/** 個人催促の現在対応がunknownである理由。 */
export type PublicPersonalReminderUnknownReason = z.output<
  typeof publicPersonalReminderUnknownReasonSchema
>;

/** 現在対応の人物集計へ影響し得る主体。 */
export type PublicCurrentResponseSubjectDto = z.output<typeof publicCurrentResponseSubjectSchema>;

/** 現在対応の人物集計へ影響し得る主体の変化。 */
export type PublicCurrentResponseSubjectChangesDto = z.output<
  typeof publicCurrentResponseSubjectChangesSchema
>;

/** 公開DTO内のグラフnode。 */
export type PublicGraphNodeDto = z.output<typeof publicGraphNodeSchema>;

/** 公開DTO内のグラフedge。 */
export type PublicGraphEdgeDto = z.output<typeof publicGraphEdgeSchema>;

/** 公開DTO内の項目履歴差分。 */
export type PublicItemHistoryEventDto = z.output<typeof publicItemHistoryEventSchema>;

/** 通知履歴の公開DTO。 */
export type PublicNotificationHistoryDto = z.output<typeof publicNotificationHistoryDtoSchema>;

/** 通知履歴の公開entry。 */
export type PublicNotificationHistoryEntryDto = z.output<
  typeof publicNotificationHistoryEntrySchema
>;

/** 公開通知履歴へ保存する個人催促context。 */
export type PublicNotificationHistoryPersonalReminderDto = z.output<
  typeof publicNotificationHistoryPersonalReminderSchema
>;
