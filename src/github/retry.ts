import { z } from "zod";

import { GitHubClientError, GitHubRequestError, GitHubRetryExhaustedError } from "./errors.js";
import { SecretRedactor } from "./redaction.js";

export type GitHubRetrySettings = Readonly<{
  maxAttempts: number;
  initialDelaySeconds: number;
  maxDelaySeconds: number;
}>;

export type GitHubRetryRuntime = Readonly<{
  sleep: (delayMilliseconds: number) => Promise<void>;
  random: () => number;
  now: () => Date;
}>;

type RetryDecision =
  | Readonly<{
      retry: false;
      status: number | undefined;
    }>
  | Readonly<{
      retry: true;
      status: 403 | 429 | 502 | 503 | 504;
      retryAfterMilliseconds: number | undefined;
    }>;

const githubRequestFailureSchema = z
  .object({
    status: z.number().int(),
    response: z
      .object({
        headers: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
        data: z.unknown().optional(),
      })
      .optional(),
  })
  .loose();

const secondaryRateLimitResponseSchema = z
  .object({
    documentation_url: z.url(),
  })
  .loose();

function getHeader(
  headers: Readonly<Record<string, string | number>> | undefined,
  name: string,
): string | undefined {
  if (headers == null) {
    return undefined;
  }
  const expectedName = name.toLowerCase();
  for (const [headerName, value] of Object.entries(headers)) {
    if (headerName.toLowerCase() === expectedName) {
      return String(value);
    }
  }
  return undefined;
}

function parseRetryAfter(value: string | undefined, now: Date): number | undefined {
  if (value == null) {
    return undefined;
  }
  if (/^\d+(?:\.\d+)?$/.test(value)) {
    return Math.ceil(Number(value) * 1000);
  }

  const retryAt = new Date(value);
  if (Number.isNaN(retryAt.getTime())) {
    return undefined;
  }
  return Math.max(0, retryAt.getTime() - now.getTime());
}

function isSecondaryRateLimit(data: unknown): boolean {
  const result = secondaryRateLimitResponseSchema.safeParse(data);
  if (!result.success) {
    return false;
  }
  const documentationUrl = new URL(result.data.documentation_url);
  return documentationUrl.hash === "#about-secondary-rate-limits";
}

function decideRetry(error: unknown, now: Date): RetryDecision {
  const result = githubRequestFailureSchema.safeParse(error);
  if (!result.success) {
    return {
      retry: false,
      status: undefined,
    };
  }

  const status = result.data.status;
  const retryAfter = parseRetryAfter(getHeader(result.data.response?.headers, "retry-after"), now);
  if (status === 429 || status === 502 || status === 503 || status === 504) {
    return {
      retry: true,
      status,
      retryAfterMilliseconds: retryAfter,
    };
  }
  if (status === 403 && (retryAfter != null || isSecondaryRateLimit(result.data.response?.data))) {
    return {
      retry: true,
      status,
      retryAfterMilliseconds: retryAfter,
    };
  }
  return {
    retry: false,
    status,
  };
}

function validateSettings(settings: GitHubRetrySettings): void {
  if (!Number.isSafeInteger(settings.maxAttempts) || settings.maxAttempts <= 0) {
    throw new TypeError("maxAttemptsには正の安全な整数を指定してください");
  }
  if (!Number.isFinite(settings.initialDelaySeconds) || settings.initialDelaySeconds < 0) {
    throw new TypeError("initialDelaySecondsには0以上の数値を指定してください");
  }
  if (!Number.isFinite(settings.maxDelaySeconds) || settings.maxDelaySeconds < 0) {
    throw new TypeError("maxDelaySecondsには0以上の数値を指定してください");
  }
  if (settings.initialDelaySeconds > settings.maxDelaySeconds) {
    throw new TypeError("initialDelaySecondsはmaxDelaySeconds以下にしてください");
  }
}

function calculateBackoffMilliseconds(
  retryNumber: number,
  settings: GitHubRetrySettings,
  random: () => number,
): number {
  const randomValue = random();
  if (!Number.isFinite(randomValue) || randomValue < 0 || randomValue >= 1) {
    throw new TypeError("randomは0以上1未満の数値を返す必要があります");
  }

  const initialMilliseconds = settings.initialDelaySeconds * 1000;
  const maxMilliseconds = settings.maxDelaySeconds * 1000;
  const exponentialMilliseconds = Math.min(
    maxMilliseconds,
    initialMilliseconds * 2 ** (retryNumber - 1),
  );
  const jitterMultiplier = 0.5 + randomValue * 0.5;
  return Math.ceil(exponentialMilliseconds * jitterMultiplier);
}

/** GitHub API呼び出しを設定された指数backoffとjitterで再試行する。 */
export async function executeWithGitHubRetry<T>(
  operation: () => Promise<T>,
  settings: GitHubRetrySettings,
  runtime: GitHubRetryRuntime,
  redactor: SecretRedactor,
): Promise<T> {
  validateSettings(settings);

  for (let attempt = 1; attempt <= settings.maxAttempts; attempt += 1) {
    try {
      return await operation();
    } catch (error: unknown) {
      if (error instanceof GitHubClientError) {
        throw error;
      }

      const decision = decideRetry(error, runtime.now());
      if (!decision.retry) {
        throw new GitHubRequestError(decision.status, attempt, {
          cause: redactor.createSafeCause(error),
        });
      }
      if (attempt === settings.maxAttempts) {
        throw new GitHubRetryExhaustedError(decision.status, attempt, {
          cause: redactor.createSafeCause(error),
        });
      }

      const retryNumber = attempt;
      const backoffMilliseconds = calculateBackoffMilliseconds(
        retryNumber,
        settings,
        runtime.random,
      );
      const delayMilliseconds =
        decision.retryAfterMilliseconds == null
          ? backoffMilliseconds
          : Math.max(backoffMilliseconds, decision.retryAfterMilliseconds);
      await runtime.sleep(delayMilliseconds);
    }
  }

  throw new TypeError("GitHub API retryの到達不能な分岐へ到達しました");
}
