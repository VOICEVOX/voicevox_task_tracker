import { createAppAuth } from "@octokit/auth-app";
import { Octokit, type OctokitOptions } from "@octokit/core";
import { z } from "zod";

import { type Config } from "../config/index.js";
import { type GitHubAppCredentials } from "./credentials.js";
import {
  GitHubAuthenticationError,
  GitHubClientError,
  GitHubReadOnlyViolationError,
  GitHubResponseValidationError,
  type GitHubRateLimitSnapshot,
} from "./errors.js";
import { executeReadOnlyGraphQL, extractGraphQLRateLimit } from "./graphql.js";
import { GitHubRateLimitController } from "./rate-limit.js";
import { assertReadOnlyGitHubRequest, isGitHubGraphQLRequest } from "./read-only.js";
import { SecretRedactor } from "./redaction.js";
import {
  executeWithGitHubRetry,
  type GitHubRetryRuntime,
  type GitHubRetrySettings,
} from "./retry.js";
import { InstallationTokenManager, type GITHUB_APP_READ_PERMISSIONS } from "./token-manager.js";

const DEFAULT_GITHUB_API_BASE_URL = "https://api.github.com";
const GITHUB_USER_AGENT = "voicevox-task-tracker/0.0.0";

const installationSchema = z
  .object({
    id: z.number().int().positive(),
  })
  .loose();

type GitHubOperations = Readonly<{
  githubApiBudgetRatio: Config["operations"]["githubApiBudgetRatio"];
  retry: Config["operations"]["retry"];
}>;

export type CreateGitHubClientOptions = Readonly<{
  organization: string;
  credentials: GitHubAppCredentials;
  operations: GitHubOperations;
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
  runtime?: GitHubRetryRuntime;
}>;

export type GitHubRestResponse = Readonly<{
  data: unknown;
  headers: Readonly<Record<string, string | number | undefined>>;
  status: number;
  url: string;
}>;

export type GitHubRestRequest = (
  route: string,
  parameters?: Readonly<Record<string, unknown>>,
) => Promise<GitHubRestResponse>;

export type GitHubClient = Readonly<{
  installationId: number;
  request: GitHubRestRequest;
  graphql: (
    query: string,
    variables: Readonly<Record<string, unknown>>,
  ) => Promise<Readonly<Record<string, unknown>>>;
  getRateLimitSnapshot: () => GitHubRateLimitSnapshot | undefined;
}>;

type AuthorizationProvider = () => Promise<string>;

const defaultRetryRuntime = {
  sleep: async (delayMilliseconds: number): Promise<void> => {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, delayMilliseconds);
    });
  },
  random: Math.random,
  now: () => new Date(),
} satisfies GitHubRetryRuntime;

const quietLogger = {
  debug: (): undefined => undefined,
  info: (): undefined => undefined,
  warn: (): undefined => undefined,
  error: (): undefined => undefined,
};

function createOctokitOptions(
  baseUrl: string,
  fetchImplementation: typeof globalThis.fetch | undefined,
): OctokitOptions {
  return {
    baseUrl,
    userAgent: GITHUB_USER_AGENT,
    log: quietLogger,
    ...(fetchImplementation == null
      ? {}
      : {
          request: {
            fetch: fetchImplementation,
          },
        }),
  };
}

function installRequestControls(
  octokit: Octokit,
  trustedBaseUrl: string,
  allowedInstallationId: number | undefined,
  authorizationProvider: AuthorizationProvider,
  rateLimitController: GitHubRateLimitController,
  retrySettings: GitHubRetrySettings,
  runtime: GitHubRetryRuntime,
  redactor: SecretRedactor,
): void {
  octokit.hook.wrap("request", async (request, requestOptions) => {
    assertReadOnlyGitHubRequest(
      {
        method: requestOptions.method,
        url: requestOptions.url,
        baseUrl: requestOptions.baseUrl,
        query: requestOptions.query,
        installation_id: requestOptions["installation_id"],
      },
      trustedBaseUrl,
      allowedInstallationId,
    );
    rateLimitController.assertCanContinue(runtime.now());
    requestOptions.headers.authorization = await authorizationProvider();
    requestOptions.headers["user-agent"] = GITHUB_USER_AGENT;

    const response = await executeWithGitHubRetry(
      async () => request(requestOptions),
      retrySettings,
      runtime,
      redactor,
    );
    if (!isGitHubGraphQLRequest(requestOptions.url, trustedBaseUrl)) {
      rateLimitController.observeRestHeaders(response.headers, runtime.now());
    }
    return response;
  });
}

function createAppAuthorizationProvider(
  credentials: GitHubAppCredentials,
  redactor: SecretRedactor,
): AuthorizationProvider {
  const authenticate = createAppAuth({
    appId: credentials.appId,
    privateKey: credentials.privateKey,
  });

  return async (): Promise<string> => {
    try {
      const authentication = await authenticate({ type: "app" });
      redactor.addSecret(authentication.token);
      return `Bearer ${authentication.token}`;
    } catch (error: unknown) {
      throw new GitHubAuthenticationError("App JWT発行", {
        cause: redactor.createSafeCause(error),
      });
    }
  };
}

function createControlledOctokit(
  options: Readonly<{
    baseUrl: string;
    fetchImplementation: typeof globalThis.fetch | undefined;
    allowedInstallationId: number | undefined;
    authorizationProvider: AuthorizationProvider;
    rateLimitController: GitHubRateLimitController;
    retrySettings: GitHubRetrySettings;
    runtime: GitHubRetryRuntime;
    redactor: SecretRedactor;
  }>,
): Octokit {
  const octokit = new Octokit(createOctokitOptions(options.baseUrl, options.fetchImplementation));
  installRequestControls(
    octokit,
    options.baseUrl,
    options.allowedInstallationId,
    options.authorizationProvider,
    options.rateLimitController,
    options.retrySettings,
    options.runtime,
    options.redactor,
  );
  return octokit;
}

async function discoverInstallationId(organization: string, appOctokit: Octokit): Promise<number> {
  let response: Awaited<ReturnType<Octokit["request"]>>;
  try {
    response = await appOctokit.request("GET /orgs/{org}/installation", {
      org: organization,
    });
  } catch (error: unknown) {
    if (error instanceof GitHubClientError) {
      throw error;
    }
    throw new GitHubAuthenticationError("Organization installation自動発見", {
      cause: new Error("installation取得に失敗しました"),
    });
  }

  const result = installationSchema.safeParse(response.data);
  if (!result.success) {
    throw new GitHubResponseValidationError("Organization installation", {
      cause: new TypeError("installation IDが不足または不正です"),
    });
  }
  return result.data.id;
}

function validateOrganization(organization: string): void {
  if (organization.trim().length === 0) {
    throw new TypeError("organizationに空文字は指定できません");
  }
}

function assertNoTransportOverrides(
  parameters: Readonly<Record<string, unknown>> | undefined,
): void {
  if (parameters == null) {
    return;
  }
  if ("request" in parameters || "baseUrl" in parameters) {
    throw new GitHubReadOnlyViolationError("OVERRIDE");
  }
}

/** GitHub Appで認証された読み取り専用RESTとGraphQLクライアントを生成する。 */
export async function createGitHubClient(
  options: CreateGitHubClientOptions,
): Promise<GitHubClient> {
  validateOrganization(options.organization);
  const baseUrl = options.baseUrl ?? DEFAULT_GITHUB_API_BASE_URL;
  const runtime = options.runtime ?? defaultRetryRuntime;
  const redactor = new SecretRedactor([options.credentials.privateKey]);
  const rateLimitController = new GitHubRateLimitController(
    options.operations.githubApiBudgetRatio,
  );
  const appAuthorizationProvider = createAppAuthorizationProvider(options.credentials, redactor);

  let installationId = options.credentials.installationId;
  if (installationId == null) {
    const discoveryOctokit = createControlledOctokit({
      baseUrl,
      fetchImplementation: options.fetch,
      allowedInstallationId: undefined,
      authorizationProvider: appAuthorizationProvider,
      rateLimitController,
      retrySettings: options.operations.retry,
      runtime,
      redactor,
    });
    installationId = await discoverInstallationId(options.organization, discoveryOctokit);
  }

  const tokenIssuerOctokit = createControlledOctokit({
    baseUrl,
    fetchImplementation: options.fetch,
    allowedInstallationId: installationId,
    authorizationProvider: appAuthorizationProvider,
    rateLimitController,
    retrySettings: options.operations.retry,
    runtime,
    redactor,
  });
  const tokenManager = new InstallationTokenManager(
    installationId,
    async (
      requestedInstallationId: number,
      permissions: typeof GITHUB_APP_READ_PERMISSIONS,
    ): Promise<unknown> => {
      const response = await tokenIssuerOctokit.request(
        "POST /app/installations/{installation_id}/access_tokens",
        {
          installation_id: requestedInstallationId,
          permissions,
        },
      );
      return response.data;
    },
    runtime.now,
    redactor,
  );
  await tokenManager.getToken();

  const installationAuthorizationProvider = async (): Promise<string> => {
    const token = await tokenManager.getToken();
    return `Bearer ${token}`;
  };
  const octokit = createControlledOctokit({
    baseUrl,
    fetchImplementation: options.fetch,
    allowedInstallationId: undefined,
    authorizationProvider: installationAuthorizationProvider,
    rateLimitController,
    retrySettings: options.operations.retry,
    runtime,
    redactor,
  });

  const request: GitHubRestRequest = async (route, parameters) => {
    assertNoTransportOverrides(parameters);
    if (parameters == null) {
      return octokit.request(route);
    }
    return octokit.request(route, parameters);
  };
  const graphql = async (
    query: string,
    variables: Readonly<Record<string, unknown>>,
  ): Promise<Readonly<Record<string, unknown>>> => {
    assertNoTransportOverrides(variables);
    const response = await executeReadOnlyGraphQL(
      query,
      variables,
      (instrumentedQuery, instrumentedVariables) =>
        octokit.graphql<unknown>(instrumentedQuery, instrumentedVariables),
      redactor,
    );
    const extracted = extractGraphQLRateLimit(response);
    rateLimitController.observeGraphQL(extracted.rateLimit, runtime.now());
    return extracted.data;
  };

  return Object.freeze({
    installationId,
    request,
    graphql,
    getRateLimitSnapshot: () => rateLimitController.getSnapshot(),
  });
}
