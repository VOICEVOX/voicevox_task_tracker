import { z } from "zod";

import {
  GitHubAuthenticationError,
  GitHubClientError,
  GitHubResponseValidationError,
} from "./errors.js";
import { SecretRedactor } from "./redaction.js";

export const GITHUB_APP_READ_PERMISSIONS = Object.freeze({
  metadata: "read",
  issues: "read",
  pull_requests: "read",
  checks: "read",
  statuses: "read",
} satisfies Readonly<Record<string, "read">>);

const TOKEN_REFRESH_WINDOW_MILLISECONDS = 5 * 60 * 1000;
const expectedPermissionNames = Object.keys(GITHUB_APP_READ_PERMISSIONS);

const installationTokenSchema = z
  .object({
    token: z.string().min(1),
    expires_at: z.iso.datetime({ offset: true }),
    permissions: z.record(z.string(), z.literal("read")),
    repository_selection: z.enum(["all", "selected"]),
  })
  .loose()
  .superRefine((token, context) => {
    const actualPermissionNames = Object.keys(token.permissions);
    for (const expectedName of expectedPermissionNames) {
      if (!(expectedName in token.permissions)) {
        context.addIssue({
          code: "custom",
          path: ["permissions", expectedName],
          message: "必要なread権限がありません",
        });
      }
    }
    for (const actualName of actualPermissionNames) {
      if (!(actualName in GITHUB_APP_READ_PERMISSIONS)) {
        context.addIssue({
          code: "custom",
          path: ["permissions", actualName],
          message: "不要な権限が含まれています",
        });
      }
    }
  });

type InstallationToken = Readonly<{
  token: string;
  expiresAt: Date;
}>;

type TokenState =
  | Readonly<{
      status: "empty";
    }>
  | Readonly<{
      status: "ready";
      token: InstallationToken;
    }>
  | Readonly<{
      status: "refreshing";
      promise: Promise<InstallationToken>;
    }>;

type InstallationTokenRequest = (
  installationId: number,
  permissions: typeof GITHUB_APP_READ_PERMISSIONS,
) => Promise<unknown>;

/** installation access tokenを期限前に再発行する。 */
export class InstallationTokenManager {
  readonly #installationId: number;
  readonly #now: () => Date;
  readonly #redactor: SecretRedactor;
  readonly #requestToken: InstallationTokenRequest;
  #state: TokenState = { status: "empty" };

  public constructor(
    installationId: number,
    requestToken: InstallationTokenRequest,
    now: () => Date,
    redactor: SecretRedactor,
  ) {
    if (!Number.isSafeInteger(installationId) || installationId <= 0) {
      throw new TypeError("installationIdには正の安全な整数を指定してください");
    }
    this.#installationId = installationId;
    this.#requestToken = requestToken;
    this.#now = now;
    this.#redactor = redactor;
  }

  /** 有効期限に十分な余裕があるinstallation access tokenを返す。 */
  public async getToken(): Promise<string> {
    switch (this.#state.status) {
      case "empty":
        return (await this.refresh()).token;
      case "refreshing":
        return (await this.#state.promise).token;
      case "ready":
        if (
          this.#state.token.expiresAt.getTime() - this.#now().getTime() >
          TOKEN_REFRESH_WINDOW_MILLISECONDS
        ) {
          return this.#state.token.token;
        }
        return (await this.refresh()).token;
    }
  }

  private async refresh(): Promise<InstallationToken> {
    const promise = this.issueToken();
    this.#state = {
      status: "refreshing",
      promise,
    };
    try {
      const token = await promise;
      this.#state = {
        status: "ready",
        token,
      };
      return token;
    } catch (error: unknown) {
      this.#state = { status: "empty" };
      throw error;
    }
  }

  private async issueToken(): Promise<InstallationToken> {
    let response: unknown;
    try {
      response = await this.#requestToken(this.#installationId, GITHUB_APP_READ_PERMISSIONS);
    } catch (error: unknown) {
      if (error instanceof GitHubClientError) {
        throw error;
      }
      throw new GitHubAuthenticationError("installation access token発行", {
        cause: this.#redactor.createSafeCause(error),
      });
    }

    const result = installationTokenSchema.safeParse(response);
    if (!result.success) {
      throw new GitHubResponseValidationError("installation access token", {
        cause: new TypeError("token、期限、またはread-only権限が不正です"),
      });
    }

    this.#redactor.addSecret(result.data.token);
    const expiresAt = new Date(result.data.expires_at);
    if (expiresAt.getTime() - this.#now().getTime() <= TOKEN_REFRESH_WINDOW_MILLISECONDS) {
      throw new GitHubResponseValidationError("installation access token有効期限", {
        cause: new TypeError("発行されたtokenの有効期限に十分な余裕がありません"),
      });
    }
    return {
      token: result.data.token,
      expiresAt,
    };
  }
}
