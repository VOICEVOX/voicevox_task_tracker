import { z } from "zod";

import {
  DiscordWebhookDeliveryUnknownError,
  DiscordWebhookRequestError,
  DiscordWebhookRetryExhaustedError,
  DiscordWebhookSecretInvalidError,
  DiscordWebhookSecretMissingError,
  DiscordWebhookSecretReadError,
} from "./errors.js";
import { assertDiscordWebhookPayloadWithinLimits, type DiscordWebhookPayload } from "./payload.js";

const DISCORD_WEBHOOK_HOSTS = new Set([
  "discord.com",
  "canary.discord.com",
  "ptb.discord.com",
  "discordapp.com",
  "canary.discordapp.com",
  "ptb.discordapp.com",
]);
const DISCORD_WEBHOOK_PATH_PATTERN = /^\/api(?:\/v\d+)?\/webhooks\/\d{17,20}\/[A-Za-z0-9._-]+\/?$/u;
const ACTIONS_SECRET_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const DISCORD_WEBHOOK_TEXT_PATTERN =
  /https:\/\/(?:canary\.|ptb\.)?discord(?:app)?\.com\/api(?:\/v\d+)?\/webhooks\/\d+\/[A-Za-z0-9._-]+/giu;
const discordMessageResponseSchema = z
  .object({
    id: z.string().regex(/^\d{17,20}$/u),
  })
  .loose();
const rateLimitBodySchema = z
  .object({
    retry_after: z.number().nonnegative(),
  })
  .loose();

export type DiscordSecretProvider = Readonly<{
  read: (secretName: string) => string | undefined;
}>;

export type DiscordWebhookHttpRequest = Readonly<{
  url: string;
  payload: DiscordWebhookPayload;
}>;

export type DiscordWebhookHttpResponse = Readonly<{
  status: number;
  retryAfter: string | undefined;
  body: unknown;
}>;

export type DiscordWebhookHttpClient = Readonly<{
  execute: (request: DiscordWebhookHttpRequest) => Promise<DiscordWebhookHttpResponse>;
}>;

export type DiscordWebhookRetrySettings = Readonly<{
  maxAttempts: number;
  initialDelaySeconds: number;
  maxDelaySeconds: number;
}>;

export type DiscordWebhookRuntime = Readonly<{
  sleep: (delayMilliseconds: number) => Promise<void>;
  random: () => number;
  now: () => Date;
}>;

export type ExecuteDiscordWebhookInput = Readonly<{
  secretName: string;
  payload: DiscordWebhookPayload;
  retry: DiscordWebhookRetrySettings;
  secretProvider: DiscordSecretProvider;
  httpClient: DiscordWebhookHttpClient;
  runtime: DiscordWebhookRuntime;
  beforeFirstAttempt: () => Promise<void>;
}>;

export type DiscordWebhookExecution = Readonly<{
  discordMessageId: string;
  attempts: number;
}>;

async function parseResponseBody(response: Response): Promise<unknown> {
  const source = await response.text();
  if (source.length === 0) {
    return undefined;
  }
  const parseJson: (text: string) => unknown = JSON.parse;
  return parseJson(source);
}

function validateRetrySettings(settings: DiscordWebhookRetrySettings): void {
  if (!Number.isSafeInteger(settings.maxAttempts) || settings.maxAttempts <= 0) {
    throw new TypeError("Discord retryのmaxAttemptsは正の安全な整数にしてください");
  }
  if (!Number.isFinite(settings.initialDelaySeconds) || settings.initialDelaySeconds < 0) {
    throw new TypeError("Discord retryのinitialDelaySecondsは0以上にしてください");
  }
  if (!Number.isFinite(settings.maxDelaySeconds) || settings.maxDelaySeconds < 0) {
    throw new TypeError("Discord retryのmaxDelaySecondsは0以上にしてください");
  }
  if (settings.initialDelaySeconds > settings.maxDelaySeconds) {
    throw new TypeError("Discord retryのinitialDelaySecondsはmaxDelaySeconds以下にしてください");
  }
}

function readWebhookSecret(secretName: string, secretProvider: DiscordSecretProvider): string {
  if (!ACTIONS_SECRET_NAME_PATTERN.test(secretName)) {
    throw new DiscordWebhookSecretInvalidError("設定値");
  }
  let value: string | undefined;
  try {
    value = secretProvider.read(secretName);
  } catch (error: unknown) {
    throw new DiscordWebhookSecretReadError(secretName, {
      cause: new Error("secret providerの読み取り処理が失敗しました", {
        cause: error,
      }),
    });
  }
  if (value == null || value.trim().length === 0) {
    throw new DiscordWebhookSecretMissingError(secretName);
  }
  return value;
}

function validateWebhookUrl(secretName: string, value: string): URL {
  if (!URL.canParse(value)) {
    throw new DiscordWebhookSecretInvalidError(secretName);
  }
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    !DISCORD_WEBHOOK_HOSTS.has(url.hostname) ||
    !DISCORD_WEBHOOK_PATH_PATTERN.test(url.pathname) ||
    url.username.length !== 0 ||
    url.password.length !== 0 ||
    url.hash.length !== 0
  ) {
    throw new DiscordWebhookSecretInvalidError(secretName);
  }
  url.searchParams.set("wait", "true");
  return url;
}

function createSafeCause(error: unknown, webhookSecret: string): Error {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "詳細を安全に取得できないエラーです";
  const url = new URL(webhookSecret);
  const token = url.pathname
    .split("/")
    .filter((segment) => segment.length > 0)
    .at(-1);
  let redacted = message.split(webhookSecret).join("[REDACTED]");
  if (token != null) {
    redacted = redacted.split(token).join("[REDACTED]");
  }
  return new Error(redacted.replace(DISCORD_WEBHOOK_TEXT_PATTERN, "[REDACTED]"));
}

function validateHttpResponse(response: DiscordWebhookHttpResponse): void {
  if (!Number.isInteger(response.status) || response.status < 100 || response.status > 599) {
    throw new TypeError("Discord HTTP clientは100以上599以下のstatusを返してください");
  }
}

function validHttpStatus(response: DiscordWebhookHttpResponse | undefined): number | undefined {
  const status = response?.status;
  if (typeof status !== "number" || !Number.isInteger(status) || status < 100 || status > 599) {
    return undefined;
  }
  return status;
}

function retryAfterMilliseconds(response: DiscordWebhookHttpResponse): number | undefined {
  const values: number[] = [];
  if (response.retryAfter != null && /^\d+(?:\.\d+)?$/u.test(response.retryAfter)) {
    values.push(Number(response.retryAfter) * 1000);
  }
  const bodyResult = rateLimitBodySchema.safeParse(response.body);
  if (bodyResult.success) {
    values.push(bodyResult.data.retry_after * 1000);
  }
  const finiteValues = values.filter((value) => Number.isFinite(value) && value >= 0);
  if (finiteValues.length === 0) {
    return undefined;
  }
  return Math.ceil(Math.max(...finiteValues));
}

function calculateBackoffMilliseconds(
  retryNumber: number,
  settings: DiscordWebhookRetrySettings,
  random: () => number,
): number {
  const randomValue = random();
  if (!Number.isFinite(randomValue) || randomValue < 0 || randomValue >= 1) {
    throw new TypeError("Discord retryのrandomは0以上1未満を返してください");
  }
  const initialMilliseconds = settings.initialDelaySeconds * 1000;
  const maximumMilliseconds = settings.maxDelaySeconds * 1000;
  const exponentialMilliseconds = Math.min(
    maximumMilliseconds,
    initialMilliseconds * 2 ** (retryNumber - 1),
  );
  return Math.ceil(exponentialMilliseconds * (0.5 + randomValue * 0.5));
}

async function waitBeforeRetry(
  attempt: number,
  response: DiscordWebhookHttpResponse,
  settings: DiscordWebhookRetrySettings,
  runtime: DiscordWebhookRuntime,
  webhookSecret: string,
): Promise<void> {
  try {
    const backoffMilliseconds = calculateBackoffMilliseconds(attempt, settings, runtime.random);
    const requestedDelay = retryAfterMilliseconds(response);
    const delayMilliseconds =
      requestedDelay == null ? backoffMilliseconds : Math.max(backoffMilliseconds, requestedDelay);
    await runtime.sleep(delayMilliseconds);
  } catch (error: unknown) {
    throw new DiscordWebhookRequestError(response.status, attempt, {
      cause: createSafeCause(error, webhookSecret),
    });
  }
}

/** Node.jsのfetchを利用するDiscord webhook HTTP clientを生成する。 */
export function createFetchDiscordWebhookHttpClient(): DiscordWebhookHttpClient {
  return Object.freeze({
    execute: async (request) => {
      const response = await fetch(request.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify(request.payload),
      });
      return Object.freeze({
        status: response.status,
        retryAfter: response.headers.get("retry-after") ?? undefined,
        body: await parseResponseBody(response),
      });
    },
  });
}

/** Discord Incoming Webhookをwait=trueで実行し、message IDを検証して返す。 */
export async function executeDiscordWebhook(
  input: ExecuteDiscordWebhookInput,
): Promise<DiscordWebhookExecution> {
  assertDiscordWebhookPayloadWithinLimits(input.payload);
  validateRetrySettings(input.retry);
  const webhookSecret = readWebhookSecret(input.secretName, input.secretProvider);
  const webhookUrl = validateWebhookUrl(input.secretName, webhookSecret);
  await input.beforeFirstAttempt();

  for (let attempt = 1; attempt <= input.retry.maxAttempts; attempt += 1) {
    let response: DiscordWebhookHttpResponse | undefined;
    try {
      response = await input.httpClient.execute({
        url: webhookUrl.toString(),
        payload: input.payload,
      });
      validateHttpResponse(response);
    } catch (error: unknown) {
      throw new DiscordWebhookDeliveryUnknownError(validHttpStatus(response), attempt, {
        cause: createSafeCause(error, webhookSecret),
      });
    }
    if (response.status >= 200 && response.status < 300) {
      try {
        const messageResult = discordMessageResponseSchema.safeParse(response.body);
        if (!messageResult.success) {
          throw new TypeError("Discord Message応答のschema検証に失敗しました");
        }
        return Object.freeze({
          discordMessageId: messageResult.data.id,
          attempts: attempt,
        });
      } catch (error: unknown) {
        throw new DiscordWebhookDeliveryUnknownError(response.status, attempt, {
          cause: createSafeCause(error, webhookSecret),
        });
      }
    }
    if (response.status >= 500) {
      throw new DiscordWebhookDeliveryUnknownError(response.status, attempt, {
        cause: new Error("Discord APIのserver errorで送信結果を確認できません"),
      });
    }
    if (response.status !== 429) {
      throw new DiscordWebhookRequestError(response.status, attempt, {
        cause: new Error("Discord APIが成功以外のstatusを返しました"),
      });
    }
    if (attempt === input.retry.maxAttempts) {
      throw new DiscordWebhookRetryExhaustedError(429, attempt, {
        cause: new Error("Discord APIへの一時的な失敗がretry上限まで続きました"),
      });
    }
    await waitBeforeRetry(attempt, response, input.retry, input.runtime, webhookSecret);
  }

  throw new TypeError("Discord webhook retryの到達不能な分岐へ到達しました");
}
