import { z } from "zod";

import { TaskTrackerError } from "../util/task-tracker-error.js";
import {
  createZodErrorDiagnostics,
  type ZodErrorDiagnostics,
  type ZodValidationIssue,
} from "../util/zod-error-diagnostic.js";

const graphQLIdentifierSchema = z.string().regex(/^[_A-Za-z][_0-9A-Za-z]*$/u);
const diagnosticPathSchema = z.array(z.union([z.string(), z.number()]));
const graphQLErrorLocationSchema = z.object({
  line: z.number().int().positive(),
  column: z.number().int().positive(),
});
const graphQLErrorDiagnosticSchema = z.object({
  locations: z.array(graphQLErrorLocationSchema).optional(),
  path: diagnosticPathSchema.optional(),
  type: z.string().min(1).optional(),
  code: z.string().min(1).optional(),
  fieldName: graphQLIdentifierSchema.optional(),
  typeName: graphQLIdentifierSchema.optional(),
});
const graphQLResponseDiagnosticsSchema = z.object({
  operationName: graphQLIdentifierSchema.optional(),
  queryHash: z.string().regex(/^[0-9a-f]{16}$/u),
  errorCount: z.number().int().nonnegative(),
  errors: z.array(graphQLErrorDiagnosticSchema),
  requestId: z.string().min(1).optional(),
});

export type GitHubResponseValidationIssue = ZodValidationIssue;

export type GitHubGraphQLErrorDiagnostic = Readonly<{
  locations?: readonly Readonly<{
    line: number;
    column: number;
  }>[];
  path?: readonly (string | number)[];
  type?: string;
  code?: string;
  fieldName?: string;
  typeName?: string;
}>;

export type GitHubGraphQLResponseDiagnostics = Readonly<{
  operationName?: string;
  queryHash: string;
  errorCount: number;
  errors: readonly GitHubGraphQLErrorDiagnostic[];
  requestId?: string;
}>;

function normalizeGraphQLErrorDiagnostic(
  diagnostic: z.output<typeof graphQLErrorDiagnosticSchema>,
): GitHubGraphQLErrorDiagnostic {
  return Object.freeze({
    ...(diagnostic.locations == null
      ? {}
      : {
          locations: Object.freeze(
            diagnostic.locations.map((location) => Object.freeze({ ...location })),
          ),
        }),
    ...(diagnostic.path == null ? {} : { path: Object.freeze([...diagnostic.path]) }),
    ...(diagnostic.type == null ? {} : { type: diagnostic.type }),
    ...(diagnostic.code == null ? {} : { code: diagnostic.code }),
    ...(diagnostic.fieldName == null ? {} : { fieldName: diagnostic.fieldName }),
    ...(diagnostic.typeName == null ? {} : { typeName: diagnostic.typeName }),
  });
}

export type GitHubRateLimitSnapshot =
  | Readonly<{
      source: "rest";
      limit: number;
      remaining: number;
      resetAt: string;
      observedAt: string;
      resource: string;
    }>
  | Readonly<{
      source: "graphql";
      limit: number;
      remaining: number;
      resetAt: string;
      observedAt: string;
      cost: number;
    }>;

/** GitHubクライアントで発生するエラーの基底クラス。 */
export abstract class GitHubClientError extends TaskTrackerError {}

/** GitHub項目詳細の収集が失敗したことを表す。 */
export class GitHubItemDetailCollectionError extends GitHubClientError {
  public readonly repositoryOwner: string;
  public readonly repositoryName: string;
  public readonly number: number;

  public constructor(
    repositoryOwner: string,
    repositoryName: string,
    number: number,
    options: ErrorOptions,
  ) {
    super(
      `GitHub項目詳細の収集に失敗しました。対象: ${repositoryOwner}/${repositoryName}#${number.toString()}`,
      options,
    );
    this.repositoryOwner = repositoryOwner;
    this.repositoryName = repositoryName;
    this.number = number;
  }
}

/** GitHub App認証情報が不足または不正であることを表す。 */
export class GitHubCredentialsError extends GitHubClientError {
  public readonly variableNames: readonly string[];

  public constructor(variableNames: readonly string[]) {
    super(`GitHub App認証情報が不正です。対象: ${variableNames.join(", ")}`, {});
    this.variableNames = [...variableNames];
  }
}

/** GitHubの読み取り専用制約に反するリクエストを表す。 */
export class GitHubReadOnlyViolationError extends GitHubClientError {
  public readonly method: string;

  public constructor(method: string) {
    super(`GitHubへの書き込みリクエストを拒否しました。HTTP method: ${method}`, {});
    this.method = method;
  }
}

/** GitHub GraphQLの読み取り専用制約に反する操作を表す。 */
export class GitHubGraphQLReadOnlyViolationError extends GitHubClientError {
  public constructor() {
    super("GitHub GraphQLのmutationまたはsubscriptionを拒否しました", {});
  }
}

/** GitHub GraphQL文書が安全に解釈できないことを表す。 */
export class GitHubGraphQLDocumentError extends GitHubClientError {
  public constructor(options: ErrorOptions) {
    super("GitHub GraphQL文書を解釈できません", options);
  }
}

/** GitHub GraphQLがerrorsを含むレスポンスを返したことを表す。 */
export class GitHubGraphQLResponseError extends GitHubClientError {
  public readonly operationName: string | undefined;
  public readonly queryHash: string;
  public readonly errorCount: number;
  public readonly errors: readonly GitHubGraphQLErrorDiagnostic[];
  public readonly requestId: string | undefined;

  public constructor(diagnostics: GitHubGraphQLResponseDiagnostics, options: ErrorOptions) {
    const result = graphQLResponseDiagnosticsSchema.parse(diagnostics);
    const operationName = result.operationName ?? "不明";
    super(
      `GitHub GraphQLレスポンスにエラーが含まれています。operation: ${operationName} queryHash: ${result.queryHash} errorCount: ${result.errorCount.toString()}`,
      options,
    );
    this.operationName = result.operationName;
    this.queryHash = result.queryHash;
    this.errorCount = result.errorCount;
    this.errors = Object.freeze(result.errors.map(normalizeGraphQLErrorDiagnostic));
    this.requestId = result.requestId;
  }
}

/** GitHub API予算の安全余裕へ到達したことを表す。 */
export class GitHubApiBudgetExceededError extends GitHubClientError {
  public readonly snapshot: GitHubRateLimitSnapshot;

  public constructor(snapshot: GitHubRateLimitSnapshot) {
    super(
      `GitHub API予算の安全余裕へ到達しました。残量: ${snapshot.remaining.toString()}/${snapshot.limit.toString()}`,
      {},
    );
    this.snapshot = snapshot;
  }
}

/** GitHub APIレスポンスが期待する契約を満たさないことを表す。 */
export class GitHubResponseValidationError extends GitHubClientError {
  public constructor(context: string, options: ErrorOptions) {
    super(`GitHub APIレスポンスが不正です。対象: ${context}`, options);
  }
}

/** GitHub APIレスポンスがZod schemaへ適合しないことを表す。 */
export class GitHubResponseSchemaValidationError
  extends GitHubResponseValidationError
  implements ZodErrorDiagnostics
{
  public readonly issueCount: number;
  public readonly issues: readonly GitHubResponseValidationIssue[];
  public readonly omittedIssueCount: number;

  public constructor(context: string, error: z.ZodError) {
    const diagnostics = createZodErrorDiagnostics(error);
    super(context, {
      cause: new TypeError(
        `GitHub APIレスポンスのschema検証に失敗しました。問題件数: ${diagnostics.issueCount.toString()}`,
      ),
    });
    this.issueCount = diagnostics.issueCount;
    this.issues = diagnostics.issues;
    this.omittedIssueCount = diagnostics.omittedIssueCount;
  }
}

/** リポジトリインベントリの完全性を確認できないことを表す。 */
export class GitHubRepositoryInventoryError extends GitHubClientError {
  public constructor(options: ErrorOptions) {
    super("GitHubリポジトリインベントリの完全性を確認できません", options);
  }
}

/** 公開allowlist外のリポジトリ参照を表す。 */
export class GitHubPublicBoundaryViolationError extends GitHubClientError {
  public readonly violationCount: number;

  public constructor(violationCount: number) {
    super(`公開allowlist外のリポジトリ参照を検出しました。件数: ${violationCount.toString()}`, {});
    this.violationCount = violationCount;
  }
}

/** 一時取得失敗時に利用できる前回値がないことを表す。 */
export class GitHubRepositoryStaleFallbackUnavailableError extends GitHubClientError {
  public constructor(repository: string, options: ErrorOptions) {
    super(`リポジトリの前回取得値がありません。対象: ${repository}`, options);
  }
}

/** GitHub API呼び出しが失敗したことを表す。 */
export class GitHubRequestError extends GitHubClientError {
  public readonly attempts: number;
  public readonly status: number | undefined;

  public constructor(status: number | undefined, attempts: number, options: ErrorOptions) {
    const statusText = status == null ? "不明" : status.toString();
    super(
      `GitHub API呼び出しに失敗しました。status: ${statusText} attempts: ${attempts.toString()}`,
      options,
    );
    this.status = status;
    this.attempts = attempts;
  }
}

/** GitHub APIのretry上限へ到達したことを表す。 */
export class GitHubRetryExhaustedError extends GitHubClientError {
  public readonly attempts: number;
  public readonly status: number;

  public constructor(status: number, attempts: number, options: ErrorOptions) {
    super(
      `GitHub APIのretry上限へ到達しました。status: ${status.toString()} attempts: ${attempts.toString()}`,
      options,
    );
    this.status = status;
    this.attempts = attempts;
  }
}

/** GitHub App認証処理が失敗したことを表す。 */
export class GitHubAuthenticationError extends GitHubClientError {
  public constructor(context: string, options: ErrorOptions) {
    super(`GitHub App認証に失敗しました。対象: ${context}`, options);
  }
}
