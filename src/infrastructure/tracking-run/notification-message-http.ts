import { z } from "zod";
import {
  DiscordWebhookRequestError,
  DiscordWebhookSecretInvalidError,
  DiscordWebhookSecretMissingError,
  DiscordWebhookSecretReadError,
} from "../../discord/errors.js";
import type { DiscordWebhookPayload } from "../../discord/payload-contracts.js";
import {
  executeDiscordWebhook,
  type DiscordSecretProvider,
  type DiscordWebhookHttpClient,
  type DiscordWebhookRetrySettings,
} from "../../discord/webhook.js";

export const notificationMessageSendOutcomeSchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("sent"),
    source: z.enum(["production", "recording"]),
    discordMessageId: z.string().min(1).max(1000),
    observedAt: z.iso.datetime({ offset: true }),
  }),
  z.strictObject({
    status: z.enum(["clear_rejection", "ambiguous"]),
    source: z.enum(["production", "recording"]),
    observedAt: z.iso.datetime({ offset: true }),
    cause: z.unknown(),
  }),
]);

/** 一つの実HTTP試行またはsandbox記録の判別可能な結果。 */
export type NotificationMessageSendOutcome = z.output<typeof notificationMessageSendOutcomeSchema>;

/** CAS予約成功後に一度だけ呼ぶDiscord effect境界。 */
export type NotificationMessageSendPort = Readonly<{
  send: (
    payload: DiscordWebhookPayload,
    webhookSecretName: string,
    retry: DiscordWebhookRetrySettings,
  ) => Promise<NotificationMessageSendOutcome>;
}>;

/** 保存済みretry設定でDiscordへ送るproduction送信境界を作る。 */
export function createProductionNotificationMessageSendPort(
  input: Readonly<{
    secretProvider: DiscordSecretProvider;
    httpClient: DiscordWebhookHttpClient;
    now: () => Date;
    sleep: (delayMilliseconds: number) => Promise<void>;
    random: () => number;
  }>,
): NotificationMessageSendPort {
  return Object.freeze({
    send: async (payload, webhookSecretName, retry) => {
      try {
        const result = await executeDiscordWebhook({
          secretName: webhookSecretName,
          payload,
          retry,
          secretProvider: input.secretProvider,
          httpClient: input.httpClient,
          runtime: { now: input.now, sleep: input.sleep, random: input.random },
          beforeFirstAttempt: () => Promise.resolve(),
        });
        return Object.freeze({
          status: "sent",
          source: "production",
          discordMessageId: result.discordMessageId,
          observedAt: input.now().toISOString(),
        });
      } catch (cause: unknown) {
        const status =
          cause instanceof DiscordWebhookRequestError ||
          cause instanceof DiscordWebhookSecretInvalidError ||
          cause instanceof DiscordWebhookSecretMissingError ||
          cause instanceof DiscordWebhookSecretReadError
            ? "clear_rejection"
            : "ambiguous";
        return Object.freeze({
          status,
          source: "production",
          observedAt: input.now().toISOString(),
          cause,
        });
      }
    },
  });
}
