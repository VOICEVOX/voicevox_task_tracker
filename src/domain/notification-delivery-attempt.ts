import { z } from "zod";

const timestampSchema = z.iso
  .datetime({ offset: true })
  .transform((value) => new Date(value).toISOString());

/** 通知messageの永続送達試行を検証する共通schema。 */
export const notificationDeliveryAttemptSchema = z.strictObject({
  operationId: z.string().regex(/^operation:v1:[0-9a-f]{64}$/u),
  attemptId: z.string().regex(/^attempt:v1:[0-9a-f]{64}$/u),
  durableAttemptSequence: z.number().int().positive(),
  notificationKeys: z.array(z.string().min(1).max(1000)).min(1),
  startedAt: timestampSchema,
  result: z.enum(["started", "sent", "clear_rejection"]),
  completedAt: timestampSchema.optional(),
  discordMessageId: z.string().min(1).max(1000).optional(),
});

/** 開始済み送達試行へ結び付けた手動判断。 */
export const notificationManualResolutionSchema = z.strictObject({
  deliveryId: z.string().regex(/^discord-digest:v1:[0-9a-f]{24}:message:[1-9][0-9]*$/u),
  attemptId: z.string().regex(/^attempt:v1:[0-9a-f]{64}$/u),
  operationId: z.string().regex(/^operation:v1:[0-9a-f]{64}$/u),
  decision: z.enum(["retry", "acknowledge"]),
  resolvedAt: timestampSchema,
});

/** 通知messageに含まれる全keyが共有する送達試行。 */
export type NotificationDeliveryAttempt = Readonly<
  Omit<z.output<typeof notificationDeliveryAttemptSchema>, "notificationKeys"> &
    Readonly<{ notificationKeys: readonly string[] }>
>;

/** ledger上で保持する開始試行の手動判断。 */
export type NotificationManualResolution = Readonly<
  z.output<typeof notificationManualResolutionSchema>
>;
