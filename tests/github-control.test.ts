import { describe, expect, it } from "vitest";

import {
  GitHubApiBudgetExceededError,
  GitHubGraphQLReadOnlyViolationError,
  GitHubGraphQLResponseError,
  GitHubGraphQLRetryExhaustedError,
  GitHubRateLimitController,
  GitHubRequestError,
  GitHubResponseSchemaValidationError,
  GitHubRetryExhaustedError,
  SecretRedactor,
  assertReadOnlyGraphQL,
  executeWithGitHubRetry,
  extractGraphQLRateLimit,
  isGitHubApiBudgetExceeded,
  type GitHubRetryRuntime,
  type GitHubRetrySettings,
} from "../src/github/index.js";
import { safeErrorDiagnostic } from "../src/cli/error-diagnostic.js";

function createApiError(
  status: number,
  headers: Readonly<Record<string, string>>,
  data: unknown,
  message: string,
): Error {
  return Object.assign(new Error(message), {
    status,
    response: {
      headers,
      data,
    },
  });
}

function createRetryRuntime(delays: number[], now: Date, randomValue: number): GitHubRetryRuntime {
  return {
    sleep: (delayMilliseconds: number): Promise<void> => {
      delays.push(delayMilliseconds);
      return Promise.resolve();
    },
    random: () => randomValue,
    now: () => now,
  };
}

function createGraphQLResponseError(
  errorCount: number,
  errors: GitHubGraphQLResponseError["errors"],
): GitHubGraphQLResponseError {
  return new GitHubGraphQLResponseError(
    {
      operationName: "RetryFixture",
      queryHash: "0123456789abcdef",
      errorCount,
      errors,
      requestId: "REQUEST_FIXTURE",
    },
    { cause: new Error("GraphQL response details") },
  );
}

const retrySettings = {
  maxAttempts: 4,
  initialDelaySeconds: 2,
  maxDelaySeconds: 30,
} satisfies GitHubRetrySettings;

describe("GitHub API retry", () => {
  it("429を指数backoffとjitterでretryする", async () => {
    const delays: number[] = [];
    const runtime = createRetryRuntime(delays, new Date("2026-08-01T00:00:00Z"), 0);
    let attempts = 0;

    const result = await executeWithGitHubRetry(
      async () => {
        await Promise.resolve();
        attempts += 1;
        if (attempts < 3) {
          throw createApiError(429, {}, {}, "一時的な失敗");
        }
        return "成功";
      },
      retrySettings,
      runtime,
      new SecretRedactor(["canary"]),
    );

    expect(result).toBe("成功");
    expect(attempts).toBe(3);
    expect(delays).toEqual([1000, 2000]);
  });

  it("retry-afterをbackoffより優先する", async () => {
    const delays: number[] = [];
    const runtime = createRetryRuntime(delays, new Date("2026-08-01T00:00:00Z"), 0);
    let attempts = 0;

    await executeWithGitHubRetry(
      async () => {
        await Promise.resolve();
        attempts += 1;
        if (attempts === 1) {
          throw createApiError(429, { "retry-after": "5" }, {}, "一時的な失敗");
        }
        return "成功";
      },
      retrySettings,
      runtime,
      new SecretRedactor(["canary"]),
    );

    expect(delays).toEqual([5000]);
  });

  it("secondary rate limitの403をretryする", async () => {
    const delays: number[] = [];
    const runtime = createRetryRuntime(delays, new Date("2026-08-01T00:00:00Z"), 0);
    let attempts = 0;

    await executeWithGitHubRetry(
      async () => {
        await Promise.resolve();
        attempts += 1;
        if (attempts === 1) {
          throw createApiError(403, { "retry-after": "3" }, {}, "rate limit");
        }
        return "成功";
      },
      retrySettings,
      runtime,
      new SecretRedactor(["canary"]),
    );

    expect(attempts).toBe(2);
    expect(delays).toEqual([3000]);
  });

  it.each([502, 504])("%iを指数backoffとjitterでretryする", async (status) => {
    const delays: number[] = [];
    const runtime = createRetryRuntime(delays, new Date("2026-08-01T00:00:00Z"), 0);
    let attempts = 0;

    const result = await executeWithGitHubRetry(
      async () => {
        await Promise.resolve();
        attempts += 1;
        if (attempts === 1) {
          throw createApiError(status, {}, {}, "一時的な失敗");
        }
        return "成功";
      },
      retrySettings,
      runtime,
      new SecretRedactor(["canary"]),
    );

    expect(result).toBe("成功");
    expect(attempts).toBe(2);
    expect(delays).toEqual([1000]);
  });

  it.each([502, 503, 504])("%iが上限まで失敗したら停止する", async (status) => {
    const delays: number[] = [];
    const runtime = createRetryRuntime(delays, new Date("2026-08-01T00:00:00Z"), 0);
    let attempts = 0;

    await expect(
      executeWithGitHubRetry(
        async () => {
          await Promise.resolve();
          attempts += 1;
          throw createApiError(status, {}, {}, "一時的な失敗");
        },
        retrySettings,
        runtime,
        new SecretRedactor(["canary"]),
      ),
    ).rejects.toBeInstanceOf(GitHubRetryExhaustedError);

    expect(attempts).toBe(4);
    expect(delays).toEqual([1000, 2000, 4000]);
  });

  it.each([401, 404, 500])("%iはretryせず即座に停止する", async (status) => {
    const delays: number[] = [];
    const runtime = createRetryRuntime(delays, new Date("2026-08-01T00:00:00Z"), 0);
    let attempts = 0;

    await expect(
      executeWithGitHubRetry(
        async () => {
          await Promise.resolve();
          attempts += 1;
          throw createApiError(status, {}, {}, "恒久的な失敗");
        },
        retrySettings,
        runtime,
        new SecretRedactor(["canary"]),
      ),
    ).rejects.toBeInstanceOf(GitHubRequestError);

    expect(attempts).toBe(1);
    expect(delays).toEqual([]);
  });

  it("例外causeからtokenをredactする", async () => {
    const token = "canary-installation-token";
    const runtime = createRetryRuntime([], new Date("2026-08-01T00:00:00Z"), 0);

    try {
      await executeWithGitHubRetry(
        async () => {
          await Promise.resolve();
          throw createApiError(401, {}, {}, `authorization: Bearer ${token}`);
        },
        retrySettings,
        runtime,
        new SecretRedactor([token]),
      );
    } catch (error: unknown) {
      if (!(error instanceof Error) || !(error.cause instanceof Error)) {
        throw error;
      }
      expect(error.message).not.toContain(token);
      expect(error.cause.message).not.toContain(token);
    }
  });

  it("診断情報のないGraphQL response errorを設定回数までretryする", async () => {
    const delays: number[] = [];
    const runtime = createRetryRuntime(delays, new Date("2026-08-01T00:00:00Z"), 0);
    let attempts = 0;

    const result = await executeWithGitHubRetry(
      async () => {
        await Promise.resolve();
        attempts += 1;
        if (attempts < 3) {
          throw createGraphQLResponseError(1, []);
        }
        return "成功";
      },
      retrySettings,
      runtime,
      new SecretRedactor(["canary"]),
    );

    expect(result).toBe("成功");
    expect(attempts).toBe(3);
    expect(delays).toEqual([1000, 2000]);
  });

  it("診断情報のあるGraphQL response errorはretryしない", async () => {
    const delays: number[] = [];
    const runtime = createRetryRuntime(delays, new Date("2026-08-01T00:00:00Z"), 0);
    const error = createGraphQLResponseError(1, [{ code: "FORBIDDEN" }]);
    let attempts = 0;

    await expect(
      executeWithGitHubRetry(
        async () => {
          await Promise.resolve();
          attempts += 1;
          throw error;
        },
        retrySettings,
        runtime,
        new SecretRedactor(["canary"]),
      ),
    ).rejects.toBe(error);

    expect(attempts).toBe(1);
    expect(delays).toEqual([]);
  });

  it("診断情報のないGraphQL response errorが上限に達したら専用エラーにする", async () => {
    const delays: number[] = [];
    const runtime = createRetryRuntime(delays, new Date("2026-08-01T00:00:00Z"), 0);
    let attempts = 0;
    let lastError: GitHubGraphQLResponseError | undefined;
    const rawMessage = "graphql raw message canary";
    const secret = "ghs_graphql_secret_canary";

    try {
      await executeWithGitHubRetry(
        async () => {
          await Promise.resolve();
          attempts += 1;
          lastError = new GitHubGraphQLResponseError(
            {
              operationName: "RetryFixture",
              queryHash: "0123456789abcdef",
              errorCount: 1,
              errors: [],
              requestId: "REQUEST_FIXTURE",
            },
            { cause: new Error(`${rawMessage} ${secret}`) },
          );
          throw lastError;
        },
        retrySettings,
        runtime,
        new SecretRedactor(["canary"]),
      );
      throw new Error("GitHubGraphQLRetryExhaustedErrorが発生しませんでした");
    } catch (error: unknown) {
      if (!(error instanceof GitHubGraphQLRetryExhaustedError)) {
        throw error;
      }
      expect(error.attempts).toBe(4);
      expect(error.cause).toBe(lastError);
      const diagnostic = safeErrorDiagnostic("incremental_collection", error);
      expect(diagnostic).toContain("attempts=4");
      expect(diagnostic).toContain("operation=RetryFixture");
      expect(diagnostic).toContain("queryHash=0123456789abcdef");
      expect(diagnostic).toContain("gqlErrorCount=1");
      expect(diagnostic).toContain("requestId=REQUEST_FIXTURE");
      expect(diagnostic).not.toContain(rawMessage);
      expect(diagnostic).not.toContain(secret);
    }

    expect(attempts).toBe(4);
    expect(delays).toEqual([1000, 2000, 4000]);
  });
});

describe("GitHub API rate limit管理", () => {
  it("設定した利用予算から安全余裕を計算する", () => {
    expect(isGitHubApiBudgetExceeded(31, 100, 0.7)).toBe(false);
    expect(isGitHubApiBudgetExceeded(30, 100, 0.7)).toBe(true);
  });

  it("REST残量が安全余裕へ到達したら停止する", () => {
    const controller = new GitHubRateLimitController(0.7);

    expect(() => {
      controller.observeRestHeaders(
        {
          "x-ratelimit-limit": "100",
          "x-ratelimit-remaining": "30",
          "x-ratelimit-reset": "1785546000",
          "x-ratelimit-resource": "core",
        },
        new Date("2026-08-01T00:00:00Z"),
      );
    }).toThrow(GitHubApiBudgetExceededError);
  });

  it("GraphQL costと残量を記録する", () => {
    const controller = new GitHubRateLimitController(0.7);

    controller.observeGraphQL(
      {
        cost: 12,
        limit: 5000,
        remaining: 4000,
        resetAt: "2026-08-01T01:00:00Z",
      },
      new Date("2026-08-01T00:00:00Z"),
    );

    expect(controller.getSnapshot()).toEqual({
      source: "graphql",
      cost: 12,
      limit: 5000,
      remaining: 4000,
      resetAt: "2026-08-01T01:00:00.000Z",
      observedAt: "2026-08-01T00:00:00.000Z",
    });
  });

  it("reset時刻を過ぎたら次の呼び出しを許可する", () => {
    const controller = new GitHubRateLimitController(0.7);

    try {
      controller.observeGraphQL(
        {
          cost: 1,
          limit: 100,
          remaining: 30,
          resetAt: "2026-08-01T01:00:00Z",
        },
        new Date("2026-08-01T00:00:00Z"),
      );
    } catch (error: unknown) {
      if (!(error instanceof GitHubApiBudgetExceededError)) {
        throw error;
      }
    }

    expect(() => {
      controller.assertCanContinue(new Date("2026-08-01T01:00:00Z"));
    }).not.toThrow();
  });
});

describe("GraphQL rate limit監視", () => {
  it("レスポンスからrateLimitを分離する", () => {
    const extracted = extractGraphQLRateLimit({
      viewer: {
        login: "octocat",
      },
      voicevoxTaskTrackerRateLimit: {
        cost: 1,
        limit: 5000,
        remaining: 4999,
        resetAt: "2026-08-01T01:00:00Z",
      },
    });

    expect(extracted.data).toEqual({
      viewer: {
        login: "octocat",
      },
    });
    expect(extracted.rateLimit.cost).toBe(1);
  });

  it("Zod検証失敗からpathとcodeと期待型だけを保持する", () => {
    const actualValueCanary = "actual-value-canary";

    try {
      extractGraphQLRateLimit({
        voicevoxTaskTrackerRateLimit: {
          cost: actualValueCanary,
          limit: 5000,
          remaining: 4999,
          resetAt: "2026-08-01T01:00:00Z",
        },
      });
      throw new Error("GitHubResponseSchemaValidationErrorが発生しませんでした");
    } catch (error: unknown) {
      if (!(error instanceof GitHubResponseSchemaValidationError)) {
        throw error;
      }
      expect(error.issueCount).toBe(1);
      expect(error.omittedIssueCount).toBe(0);
      expect(error.issues).toEqual([
        {
          path: ["cost"],
          code: "invalid_type",
          expected: "number",
        },
      ]);
      const diagnosticText = JSON.stringify({
        message: error.message,
        cause: error.cause instanceof Error ? error.cause.message : error.cause,
        issueCount: error.issueCount,
        issues: error.issues,
        omittedIssueCount: error.omittedIssueCount,
      });
      expect(diagnosticText).not.toContain(actualValueCanary);
      expect(diagnosticText).not.toContain("input");
      expect(diagnosticText).not.toContain("received");
    }
  });

  it("mutationをASTで拒否する", () => {
    expect(() => {
      assertReadOnlyGraphQL(`
        # mutationという語を含むcomment
        mutation AddComment {
          addComment(input: {}) {
            clientMutationId
          }
        }
      `);
    }).toThrow(GitHubGraphQLReadOnlyViolationError);
  });
});
