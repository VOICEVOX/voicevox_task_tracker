import { createHash, generateKeyPairSync } from "node:crypto";

import { z } from "zod";
import { describe, expect, it } from "vitest";

import {
  GITHUB_APP_READ_PERMISSIONS,
  GitHubApiBudgetExceededError,
  GitHubGraphQLReadOnlyViolationError,
  GitHubGraphQLResponseError,
  GitHubReadOnlyViolationError,
  GitHubRequestError,
  createGitHubClient,
  type CreateGitHubClientOptions,
  type GitHubAppCredentials,
  type GitHubRetryRuntime,
} from "../src/github/index.js";

type RecordedRequest = Readonly<{
  url: string;
  method: string;
  headers: Headers;
  body: string | undefined;
}>;

type ResponseFactory = (request: RecordedRequest) => Response;

function createJsonResponse(
  data: unknown,
  status: number,
  headers: Readonly<Record<string, string>>,
): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json",
      ...headers,
    },
  });
}

function createFetchMock(responseFactories: readonly ResponseFactory[]): Readonly<{
  fetch: typeof globalThis.fetch;
  requests: RecordedRequest[];
}> {
  const requests: RecordedRequest[] = [];
  const fetchImplementation: typeof globalThis.fetch = (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    const headers = new Headers(input instanceof Request ? input.headers : undefined);
    const initHeaders = new Headers(init?.headers);
    for (const [name, value] of initHeaders.entries()) {
      headers.set(name, value);
    }
    const body = typeof init?.body === "string" ? init.body : undefined;
    const request = {
      url,
      method,
      headers,
      body,
    } satisfies RecordedRequest;
    requests.push(request);

    const responseFactory = responseFactories.at(requests.length - 1);
    if (responseFactory == null) {
      throw new Error(`HTTP mock responseが不足しています。request: ${method} ${url}`);
    }
    return Promise.resolve(responseFactory(request));
  };
  return {
    fetch: fetchImplementation,
    requests,
  };
}

const keyPair = generateKeyPairSync("rsa", {
  modulusLength: 2048,
});
const privateKey = keyPair.privateKey
  .export({
    type: "pkcs8",
    format: "pem",
  })
  .toString();

const operations = {
  githubApiBudgetRatio: 0.7,
  retry: {
    maxAttempts: 4,
    initialDelaySeconds: 2,
    maxDelaySeconds: 30,
  },
} satisfies CreateGitHubClientOptions["operations"];

function createRuntime(now: () => Date, delays: number[]): GitHubRetryRuntime {
  return {
    sleep: (delayMilliseconds: number): Promise<void> => {
      delays.push(delayMilliseconds);
      return Promise.resolve();
    },
    random: () => 0,
    now,
  };
}

function createTokenResponse(token: string, expiresAt: string): Response {
  return createJsonResponse(
    {
      token,
      expires_at: expiresAt,
      permissions: GITHUB_APP_READ_PERMISSIONS,
      repository_selection: "all",
    },
    201,
    {},
  );
}

function createRateLimitHeaders(remaining: number): Readonly<Record<string, string>> {
  return {
    "x-ratelimit-limit": "5000",
    "x-ratelimit-remaining": remaining.toString(),
    "x-ratelimit-reset": "1785553200",
    "x-ratelimit-resource": "core",
  };
}

function createClientOptions(
  credentials: GitHubAppCredentials,
  fetchImplementation: typeof globalThis.fetch,
  runtime: GitHubRetryRuntime,
): CreateGitHubClientOptions {
  return {
    organization: "VOICEVOX",
    credentials,
    operations,
    baseUrl: "https://api.github.test",
    fetch: fetchImplementation,
    runtime,
  };
}

describe("GitHub App認証とOctokitクライアント", () => {
  it("Organizationからinstallationを発見してread-only tokenを発行する", async () => {
    const now = new Date("2026-08-01T00:00:00Z");
    const delays: number[] = [];
    const mock = createFetchMock([
      (request) => {
        expect(new URL(request.url).pathname).toBe("/orgs/VOICEVOX/installation");
        expect(request.method).toBe("GET");
        expect(request.headers.get("authorization")).toMatch(/^Bearer [^.]+\.[^.]+\.[^.]+$/u);
        expect(request.headers.get("user-agent")).toContain("voicevox-task-tracker/0.0.0");
        return createJsonResponse({ id: 456 }, 200, createRateLimitHeaders(4999));
      },
      (request) => {
        expect(new URL(request.url).pathname).toBe("/app/installations/456/access_tokens");
        expect(request.method).toBe("POST");
        expect(request.headers.get("authorization")).toMatch(/^Bearer [^.]+\.[^.]+\.[^.]+$/u);
        expect(request.body).toContain('"permissions"');
        expect(request.body).toContain('"issues":"read"');
        expect(request.body).not.toContain('"members":"read"');
        expect(request.body).not.toContain('"write"');
        return createTokenResponse("ghs_installation_canary_1", "2026-08-01T01:00:00Z");
      },
      (request) => {
        expect(new URL(request.url).pathname).toBe("/orgs/VOICEVOX/repos");
        expect(request.method).toBe("GET");
        expect(request.headers.get("authorization")).toBe("Bearer ghs_installation_canary_1");
        return createJsonResponse([{ id: 1, name: "voicevox" }], 200, createRateLimitHeaders(4998));
      },
    ]);

    const client = await createGitHubClient(
      createClientOptions(
        {
          appId: 123,
          privateKey,
        },
        mock.fetch,
        createRuntime(() => now, delays),
      ),
    );
    const response = await client.request("GET /orgs/{org}/repos", {
      org: "VOICEVOX",
    });

    expect(client.installationId).toBe(456);
    expect(response.data).toEqual([{ id: 1, name: "voicevox" }]);
    expect(mock.requests).toHaveLength(3);
    expect(delays).toEqual([]);
  });

  it("指定されたinstallation IDでは自動発見を行わない", async () => {
    const now = new Date("2026-08-01T00:00:00Z");
    const mock = createFetchMock([
      (request) => {
        expect(new URL(request.url).pathname).toBe("/app/installations/789/access_tokens");
        return createTokenResponse("ghs_installation_canary_2", "2026-08-01T01:00:00Z");
      },
    ]);

    const client = await createGitHubClient(
      createClientOptions(
        {
          appId: 123,
          privateKey,
          installationId: 789,
        },
        mock.fetch,
        createRuntime(() => now, []),
      ),
    );

    expect(client.installationId).toBe(789);
    expect(mock.requests).toHaveLength(1);
  });

  it("REST writeとGraphQL mutationをHTTP送信前に拒否する", async () => {
    const now = new Date("2026-08-01T00:00:00Z");
    const mock = createFetchMock([
      () => createTokenResponse("ghs_installation_canary_3", "2026-08-01T01:00:00Z"),
    ]);
    const client = await createGitHubClient(
      createClientOptions(
        {
          appId: 123,
          privateKey,
          installationId: 456,
        },
        mock.fetch,
        createRuntime(() => now, []),
      ),
    );

    await expect(
      client.request("POST /repos/{owner}/{repo}/issues", {
        owner: "VOICEVOX",
        repo: "voicevox",
        title: "拒否されるIssue",
      }),
    ).rejects.toBeInstanceOf(GitHubReadOnlyViolationError);
    await expect(
      client.graphql("mutation { addComment(input: {}) { clientMutationId } }", {}),
    ).rejects.toBeInstanceOf(GitHubGraphQLReadOnlyViolationError);
    await expect(
      client.request("GET /repos/{owner}/{repo}", {
        owner: "VOICEVOX",
        repo: "voicevox",
        request: {
          fetch: mock.fetch,
        },
      }),
    ).rejects.toBeInstanceOf(GitHubReadOnlyViolationError);
    await expect(
      client.graphql("query { viewer { login } }", {
        baseUrl: "https://example.com",
      }),
    ).rejects.toBeInstanceOf(GitHubReadOnlyViolationError);

    expect(mock.requests).toHaveLength(1);
    expect(
      mock.requests.filter(
        (request) =>
          request.method !== "GET" &&
          request.method !== "HEAD" &&
          !new URL(request.url).pathname.endsWith("/access_tokens"),
      ),
    ).toEqual([]);
  });

  it("GraphQL queryへrateLimitを追加してcostを監視する", async () => {
    const now = new Date("2026-08-01T00:00:00Z");
    const mock = createFetchMock([
      () => createTokenResponse("ghs_installation_canary_4", "2026-08-01T01:00:00Z"),
      (request) => {
        expect(new URL(request.url).pathname).toBe("/graphql");
        expect(request.method).toBe("POST");
        expect(request.body).toContain("voicevoxTaskTrackerRateLimit");
        expect(request.body).toContain("rateLimit");
        return createJsonResponse(
          {
            data: {
              viewer: {
                login: "octocat",
              },
              voicevoxTaskTrackerRateLimit: {
                cost: 7,
                limit: 5000,
                remaining: 4500,
                resetAt: "2026-08-01T01:00:00Z",
              },
            },
          },
          200,
          {},
        );
      },
    ]);
    const client = await createGitHubClient(
      createClientOptions(
        {
          appId: 123,
          privateKey,
          installationId: 456,
        },
        mock.fetch,
        createRuntime(() => now, []),
      ),
    );

    const response = await client.graphql("query { viewer { login } }", {});

    expect(response).toEqual({
      viewer: {
        login: "octocat",
      },
    });
    expect(client.getRateLimitSnapshot()).toMatchObject({
      source: "graphql",
      cost: 7,
      remaining: 4500,
      limit: 5000,
    });
  });

  it("GraphQL本文の診断情報なしエラーをretryして成功する", async () => {
    const now = new Date("2026-08-01T00:00:00Z");
    const delays: number[] = [];
    const rawMessage = "graphql response message canary";
    const mock = createFetchMock([
      () => createTokenResponse("ghs_graphql_retry", "2026-08-01T01:00:00Z"),
      () =>
        createJsonResponse(
          {
            data: {
              viewer: {
                login: "partial-response-canary",
              },
            },
            errors: [{ message: rawMessage }],
          },
          200,
          {},
        ),
      () =>
        createJsonResponse(
          {
            data: {
              viewer: {
                login: "octocat",
              },
              voicevoxTaskTrackerRateLimit: {
                cost: 1,
                limit: 5000,
                remaining: 4999,
                resetAt: "2026-08-01T01:00:00Z",
              },
            },
          },
          200,
          {},
        ),
    ]);
    const client = await createGitHubClient(
      createClientOptions(
        {
          appId: 123,
          privateKey,
          installationId: 456,
        },
        mock.fetch,
        createRuntime(() => now, delays),
      ),
    );

    const response = await client.graphql("query { viewer { login } }", {});

    expect(response).toEqual({
      viewer: {
        login: "octocat",
      },
    });
    expect(mock.requests).toHaveLength(3);
    expect(delays).toEqual([1000]);
  });

  it("GraphQL errorsから安全な診断情報と秘匿処理済みcauseを保持する", async () => {
    const now = new Date("2026-08-01T00:00:00Z");
    const variableCanary = "variable-value-canary";
    const partialResponseCanary = "partial-response-canary";
    const rawMessage = "Field 'id' doesn't exist on type 'AutoMergeRequest'";
    const invalidRawMessage = "Field 'invalid-field' doesn't exist on type 'SecretType'";
    const mock = createFetchMock([
      () => createTokenResponse("ghs_graphql_error", "2026-08-01T01:00:00Z"),
      () =>
        createJsonResponse(
          {
            data: {
              node: {
                secret: partialResponseCanary,
              },
            },
            errors: [
              {
                message: rawMessage,
                locations: [
                  {
                    line: 4,
                    column: 7,
                  },
                ],
                path: ["node", "autoMergeRequest", "id"],
                type: "INVALID",
                extensions: {
                  code: "undefinedField",
                },
              },
              {
                message: invalidRawMessage,
                locations: [
                  {
                    line: "5",
                    column: 9,
                  },
                ],
                path: ["node", { secret: "path-value-canary" }],
                type: 42,
                extensions: {
                  code: { secret: "code-value-canary" },
                },
              },
            ],
          },
          200,
          {
            "x-github-request-id": "REQUEST_CANARY_123",
          },
        ),
    ]);
    const client = await createGitHubClient(
      createClientOptions(
        {
          appId: 123,
          privateKey,
          installationId: 456,
        },
        mock.fetch,
        createRuntime(() => now, []),
      ),
    );

    try {
      await client.graphql(
        `
          query DiagnoseAutoMerge($nodeId: ID!) {
            node(id: $nodeId) {
              id
            }
          }
        `,
        { nodeId: variableCanary },
      );
      throw new Error("GitHubGraphQLResponseErrorが発生しませんでした");
    } catch (error: unknown) {
      if (!(error instanceof GitHubGraphQLResponseError)) {
        throw error;
      }
      const graphqlRequest = mock.requests[1];
      if (graphqlRequest?.body == null) {
        throw new Error("GraphQL request bodyがありません");
      }
      const payload = z
        .object({
          query: z.string(),
        })
        .parse(JSON.parse(graphqlRequest.body));
      const expectedQueryHash = createHash("sha256")
        .update(payload.query, "utf8")
        .digest("hex")
        .slice(0, 16);

      expect(error.operationName).toBe("DiagnoseAutoMerge");
      expect(error.queryHash).toBe(expectedQueryHash);
      expect(error.errorCount).toBe(2);
      expect(error.errors).toEqual([
        {
          locations: [{ line: 4, column: 7 }],
          path: ["node", "autoMergeRequest", "id"],
          type: "INVALID",
          code: "undefinedField",
          fieldName: "id",
          typeName: "AutoMergeRequest",
        },
      ]);
      expect(error.requestId).toBe("REQUEST_CANARY_123");
      expect(error).not.toHaveProperty("status");
      expect(error).not.toHaveProperty("request");
      expect(error).not.toHaveProperty("response");
      expect(error).not.toHaveProperty("data");
      expect(error).not.toHaveProperty("variables");
      if (!(error.cause instanceof Error)) {
        throw new Error("GraphQL response errorのcauseがありません");
      }
      expect(error.cause.message).toContain(rawMessage);
      expect(error.cause.message).toContain(invalidRawMessage);
      const diagnosticText = JSON.stringify({
        message: error.message,
        stack: error.stack,
        operationName: error.operationName,
        queryHash: error.queryHash,
        errorCount: error.errorCount,
        errors: error.errors,
        requestId: error.requestId,
      });
      expect(diagnosticText).not.toContain(rawMessage);
      expect(diagnosticText).not.toContain(invalidRawMessage);
      expect(diagnosticText).not.toContain(variableCanary);
      expect(diagnosticText).not.toContain(partialResponseCanary);
      expect(diagnosticText).not.toContain(payload.query);
      expect(diagnosticText).not.toContain("path-value-canary");
      expect(diagnosticText).not.toContain("code-value-canary");
    }
  });

  it("期限まで5分未満になったinstallation tokenを再発行する", async () => {
    let now = new Date("2026-08-01T00:00:00Z");
    const mock = createFetchMock([
      () => createTokenResponse("ghs_installation_before_refresh", "2026-08-01T01:00:00Z"),
      (request) => {
        expect(request.headers.get("authorization")).toBe("Bearer ghs_installation_before_refresh");
        return createJsonResponse({ ok: true }, 200, createRateLimitHeaders(4999));
      },
      () => createTokenResponse("ghs_installation_after_refresh", "2026-08-01T02:00:00Z"),
      (request) => {
        expect(request.headers.get("authorization")).toBe("Bearer ghs_installation_after_refresh");
        return createJsonResponse({ ok: true }, 200, createRateLimitHeaders(4998));
      },
    ]);
    const client = await createGitHubClient(
      createClientOptions(
        {
          appId: 123,
          privateKey,
          installationId: 456,
        },
        mock.fetch,
        createRuntime(() => now, []),
      ),
    );

    await client.request("GET /rate_limit");
    now = new Date("2026-08-01T00:56:00Z");
    await client.request("GET /rate_limit");

    expect(
      mock.requests.filter((request) => new URL(request.url).pathname.endsWith("/access_tokens")),
    ).toHaveLength(2);
  });

  it("HTTP 503を共通制御でretryする", async () => {
    const now = new Date("2026-08-01T00:00:00Z");
    const delays: number[] = [];
    const mock = createFetchMock([
      () => createTokenResponse("ghs_installation_retry", "2026-08-01T01:00:00Z"),
      () =>
        createJsonResponse(
          {
            message: "Service unavailable",
          },
          503,
          {},
        ),
      () => createJsonResponse({ ok: true }, 200, createRateLimitHeaders(4999)),
    ]);
    const client = await createGitHubClient(
      createClientOptions(
        {
          appId: 123,
          privateKey,
          installationId: 456,
        },
        mock.fetch,
        createRuntime(() => now, delays),
      ),
    );

    const response = await client.request("GET /rate_limit");

    expect(z.object({ ok: z.literal(true) }).parse(response.data)).toEqual({ ok: true });
    expect(delays).toEqual([1000]);
    expect(mock.requests).toHaveLength(3);
  });

  it("rate limit残量が安全余裕へ到達したら以後の収集を止める", async () => {
    const now = new Date("2026-08-01T00:00:00Z");
    const mock = createFetchMock([
      () => createTokenResponse("ghs_installation_budget", "2026-08-01T01:00:00Z"),
      () => createJsonResponse({ ok: true }, 200, createRateLimitHeaders(1500)),
    ]);
    const client = await createGitHubClient(
      createClientOptions(
        {
          appId: 123,
          privateKey,
          installationId: 456,
        },
        mock.fetch,
        createRuntime(() => now, []),
      ),
    );

    await expect(client.request("GET /rate_limit")).rejects.toBeInstanceOf(
      GitHubApiBudgetExceededError,
    );
    await expect(client.request("GET /rate_limit")).rejects.toBeInstanceOf(
      GitHubApiBudgetExceededError,
    );

    expect(mock.requests).toHaveLength(2);
  });

  it("HTTPエラーからtokenとprivate keyを除去する", async () => {
    const now = new Date("2026-08-01T00:00:00Z");
    const token = "ghs_installation_error_canary";
    const mock = createFetchMock([
      () => createTokenResponse(token, "2026-08-01T01:00:00Z"),
      () =>
        createJsonResponse(
          {
            message: `authorization: Bearer ${token}\n${privateKey}`,
          },
          401,
          {},
        ),
    ]);
    const client = await createGitHubClient(
      createClientOptions(
        {
          appId: 123,
          privateKey,
          installationId: 456,
        },
        mock.fetch,
        createRuntime(() => now, []),
      ),
    );

    try {
      await client.request("GET /rate_limit");
      throw new Error("GitHubRequestErrorが発生しませんでした");
    } catch (error: unknown) {
      if (!(error instanceof GitHubRequestError) || !(error.cause instanceof Error)) {
        throw error;
      }
      expect(error.message).not.toContain(token);
      expect(error.message).not.toContain(privateKey);
      expect(error.cause.message).not.toContain(token);
      expect(error.cause.message).not.toContain(privateKey);
    }
  });
});
