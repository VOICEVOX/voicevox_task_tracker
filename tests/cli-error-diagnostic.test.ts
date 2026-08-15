import { z } from "zod";
import { describe, expect, it } from "vitest";

import { CodexNonZeroExitError } from "../src/codex/index.js";
import { safeCodexFallbackDiagnostic, safeErrorDiagnostic } from "../src/cli/error-diagnostic.js";
import {
  CliCodexAuthenticationError,
  CliCredentialsError,
  CliExecutableError,
  CliRelationExpansionLimitError,
  ResponsibilityReplayRetryExhaustedError,
  StalenessReductionError,
} from "../src/cli/errors.js";
import {
  ResponsibilityReplayMismatchError,
  StalenessTimestampRangeError,
  createGitHubNodeId,
  createUtcIsoDateTime,
} from "../src/domain/index.js";
import {
  GitHubGraphQLResponseError,
  GitHubItemDetailCollectionError,
  GitHubRequestError,
  GitHubResponseSchemaValidationError,
} from "../src/github/index.js";
import {
  RelationReferenceConflictError,
  type PublicGitHubRelationItem,
} from "../src/graph/index.js";
import { StateFormatError } from "../src/persistence/index.js";

function createGraphQLResponseError(options: ErrorOptions): GitHubGraphQLResponseError {
  return new GitHubGraphQLResponseError(
    {
      operationName: "GitHubItemDetail",
      queryHash: "3f2a1c9d8e7b6a54",
      errorCount: 1,
      errors: [
        {
          locations: [{ line: 634, column: 13 }],
          path: ["node", "autoMergeRequest", "id"],
          type: "INVALID",
          code: "undefinedField",
          fieldName: "id",
          typeName: "AutoMergeRequest",
        },
      ],
      requestId: "ABCD:1234:5678",
    },
    options,
  );
}

describe("safeErrorDiagnostic", () => {
  it("Codex非ゼロ終了の診断へ終了コードと許可されたAPIエラー項目だけを出す", () => {
    const standardErrorCanary = "STANDARD_ERROR_BODY_CANARY";
    const messageCanary = "MESSAGE_FIELD_CANARY";
    const promptCanary = "PROMPT_CANARY";
    const standardInputCanary = "STANDARD_INPUT_CANARY";
    const error = new CodexNonZeroExitError(1, 17, null, {
      type: "invalid_request_error",
      code: "invalid_json_schema",
      status: "400",
    });
    delete error.stack;
    Object.defineProperties(error, {
      standardError: { value: standardErrorCanary },
      apiMessage: { value: messageCanary },
      prompt: { value: promptCanary },
      standardInput: { value: standardInputCanary },
    });

    const diagnostic = safeErrorDiagnostic("codex_analysis", error);
    const fallbackDiagnostic = safeCodexFallbackDiagnostic(
      "I_fixture",
      "execution_failed",
      error.name,
      {
        exitCode: error.exitCode,
        apiError: error.apiError,
      },
      undefined,
    );

    expect(diagnostic).toBe(
      "stage=codex_analysis errorType=CodexNonZeroExitError exitCode=17 codexErrorType=invalid_request_error codexErrorCode=invalid_json_schema codexErrorStatus=400",
    );
    expect(fallbackDiagnostic).toBe(
      "codex_fallback item=I_fixture reason=execution_failed errorType=CodexNonZeroExitError exitCode=17 codexErrorType=invalid_request_error codexErrorCode=invalid_json_schema codexErrorStatus=400",
    );
    for (const canary of [standardErrorCanary, messageCanary, promptCanary, standardInputCanary]) {
      expect(diagnostic).not.toContain(canary);
      expect(fallbackDiagnostic).not.toContain(canary);
    }
  });

  it("Codex APIエラー詳細がなくても終了コードだけを診断へ出す", () => {
    expect(
      safeCodexFallbackDiagnostic(
        "I_fixture",
        "execution_failed",
        "CodexNonZeroExitError",
        {
          exitCode: 19,
          apiError: undefined,
        },
        undefined,
      ),
    ).toBe(
      "codex_fallback item=I_fixture reason=execution_failed errorType=CodexNonZeroExitError exitCode=19",
    );
  });

  it("Codex出力検証の診断へ件数とpathとcodeだけを出す", () => {
    const diagnostic = safeCodexFallbackDiagnostic(
      "I_fixture",
      "semantic_validation_failed",
      "CodexOutputSemanticValidationError",
      undefined,
      {
        issueCount: 2,
        issues: [
          {
            path: "/item/nodeId",
            code: "item_node_id_mismatch",
          },
          {
            path: "/evidence/0/sourceId",
            code: "unknown_source_id_present_in_input",
          },
        ],
      },
    );

    expect(diagnostic).toBe(
      "codex_fallback item=I_fixture reason=semantic_validation_failed errorType=CodexOutputSemanticValidationError validationIssueCount=2 validationIssue0Path=/item/nodeId validationIssue0Code=item_node_id_mismatch validationIssue1Path=/evidence/0/sourceId validationIssue1Code=unknown_source_id_present_in_input",
    );
    expect(diagnostic.length).toBeLessThanOrEqual(1000);
  });

  it("causeを持たないエラーから発生位置を出す", () => {
    const error = new TypeError("GitHub由来メッセージ");
    error.stack = [
      "TypeError: GitHub由来メッセージ",
      "    at detectProgress (file:///srv/voicevox_task_tracker/dist/domain/meaningful-progress.js:182:23)",
    ].join("\n");

    expect(safeErrorDiagnostic("incremental_collection", error)).toBe(
      "stage=incremental_collection errorType=TypeError errorSite0=meaningful-progress.js:182",
    );
  });

  it("自リポジトリの発生位置を上から3件まで連結して出す", () => {
    const error = new TypeError("fixture");
    error.stack = [
      "TypeError: fixture",
      "    at assertNonNullable (file:///srv/voicevox_task_tracker/dist/util/assert-non-nullable.js:4:11)",
      "    at collectIncremental (file:///srv/voicevox_task_tracker/dist/cli/production-runtime.js:4180:17)",
      "    at runIncremental (file:///srv/voicevox_task_tracker/dist/cli/production-runtime.js:4310:9)",
      "    at runTracker (file:///srv/voicevox_task_tracker/dist/cli/tracker-run.js:82:5)",
    ].join("\n");

    expect(safeErrorDiagnostic("incremental_collection", error)).toBe(
      "stage=incremental_collection errorType=TypeError errorSite0=assert-non-nullable.js:4<-production-runtime.js:4180<-production-runtime.js:4310",
    );
  });

  it("自リポジトリの発生位置が1件なら連結記号を付けない", () => {
    const error = new TypeError("fixture");
    error.stack = [
      "TypeError: fixture",
      "    at collectIncremental (file:///srv/voicevox_task_tracker/src/cli/production-runtime.ts:4180:17)",
    ].join("\n");

    const diagnostic = safeErrorDiagnostic("incremental_collection", error);

    expect(diagnostic).toBe(
      "stage=incremental_collection errorType=TypeError errorSite0=production-runtime.ts:4180",
    );
    expect(diagnostic).not.toContain("<-");
  });

  it("node_modulesとnode:internalを除き自リポジトリの発生位置だけを連結して出す", () => {
    const error = new TypeError("fixture");
    error.stack = [
      "TypeError: fixture",
      "    at collectIncremental (file:///srv/voicevox_task_tracker/dist/cli/production-runtime.js:4180:17)",
      "    at dependency (file:///srv/voicevox_task_tracker/node_modules/example/dist/index.js:12:4)",
      "    at processTicksAndRejections (node:internal/process/task_queues:105:5)",
      "    at buildGraph (file:///srv/voicevox_task_tracker/src/graph/task-graph.ts:41:9)",
      "    at otherDependency (file:///srv/voicevox_task_tracker/node_modules/other/src/index.js:27:6)",
      "    at detectProgress (file:///srv/voicevox_task_tracker/src/domain/meaningful-progress.ts:182:23)",
    ].join("\n");

    expect(safeErrorDiagnostic("incremental_collection", error)).toBe(
      "stage=incremental_collection errorType=TypeError errorSite0=production-runtime.js:4180<-task-graph.ts:41<-meaningful-progress.ts:182",
    );
  });

  it("連結した発生位置へディレクトリパスやユーザー名を出さない", () => {
    const userName = "private-user-canary";
    const directoryName = "secret-directory-canary";
    const error = new Error("fixture");
    error.stack = [
      "Error: fixture",
      `    at collect (file:///home/${userName}/${directoryName}/src/cli/collector.ts:73:9)`,
      `    at run (file:///home/${userName}/${directoryName}/dist/cli/production-runtime.js:4180:17)`,
      `    at build (file:///home/${userName}/${directoryName}/src/graph/task-graph.ts:41:9)`,
    ].join("\n");

    const diagnostic = safeErrorDiagnostic("incremental_collection", error);

    expect(diagnostic).toBe(
      "stage=incremental_collection errorType=Error errorSite0=collector.ts:73<-production-runtime.js:4180<-task-graph.ts:41",
    );
    expect(diagnostic).not.toContain(userName);
    expect(diagnostic).not.toContain(directoryName);
  });

  it("cause連鎖の順に各エラーの発生位置を出す", () => {
    const cause = new RangeError("cause");
    cause.stack = [
      "RangeError: cause",
      "    at buildGraph (file:///srv/voicevox_task_tracker/src/graph/task-graph.ts:41:9)",
    ].join("\n");
    const error = new TypeError("error", { cause });
    error.stack = [
      "TypeError: error",
      "    at runTracker (file:///srv/voicevox_task_tracker/dist/cli/tracker-run.js:230:15)",
    ].join("\n");

    expect(safeErrorDiagnostic("incremental_collection", error)).toBe(
      "stage=incremental_collection errorType=TypeError<-RangeError errorSite0=tracker-run.js:230 errorSite1=task-graph.ts:41",
    );
  });

  it("node_modulesやnode:internalだけのstackから発生位置を出さない", () => {
    const error = new TypeError("fixture");
    error.stack = [
      "TypeError: fixture",
      "    at dependency (file:///srv/voicevox_task_tracker/node_modules/example/dist/index.js:12:4)",
      "    at processTicksAndRejections (node:internal/process/task_queues:105:5)",
    ].join("\n");

    expect(safeErrorDiagnostic("incremental_collection", error)).toBe(
      "stage=incremental_collection errorType=TypeError",
    );
  });

  it("診断文字列へディレクトリパスやユーザー名を出さない", () => {
    const userName = "private-user-canary";
    const directoryName = "secret-directory-canary";
    const githubMessage = "github-message-canary";
    const error = new Error(githubMessage);
    error.stack = [
      `Error: ${githubMessage}`,
      `    at ${userName} (file:///home/${userName}/${directoryName}/src/cli/tracker-run.ts:73:9)`,
    ].join("\n");

    const diagnostic = safeErrorDiagnostic("incremental_collection", error);

    expect(diagnostic).toBe(
      "stage=incremental_collection errorType=Error errorSite0=tracker-run.ts:73",
    );
    expect(diagnostic).not.toContain(userName);
    expect(diagnostic).not.toContain(directoryName);
    expect(diagnostic).not.toContain(githubMessage);
  });

  it("causeで包まれたGraphQLレスポンスエラーの型と安全な詳細を出す", () => {
    const rawMessage = "Field 'id' doesn't exist on type 'AutoMergeRequest'";
    const variables = "variables-canary";
    const responseBody = "response-body-canary";
    const query = "query-body-canary";
    const graphQLError = createGraphQLResponseError({
      cause: new Error([rawMessage, variables, responseBody, query].join("|")),
    });
    const error = new GitHubItemDetailCollectionError("VOICEVOX", "voicevox", 42, {
      cause: graphQLError,
    });

    const diagnostic = safeErrorDiagnostic("incremental_collection", error);

    expect(diagnostic).toBe(
      "stage=incremental_collection errorType=GitHubItemDetailCollectionError<-GitHubGraphQLResponseError<-Error item=VOICEVOX/voicevox#42 operation=GitHubItemDetail queryHash=3f2a1c9d8e7b6a54 gqlErrorCount=1 gqlError0Locations=line:634,column:13 gqlError0Path=node.autoMergeRequest.id gqlError0Type=INVALID gqlError0Code=undefinedField gqlError0Field=id gqlError0ParentType=AutoMergeRequest requestId=ABCD:1234:5678",
    );
    expect(diagnostic).not.toContain("httpStatus=");
    expect(diagnostic).not.toContain(rawMessage);
    expect(diagnostic).not.toContain(variables);
    expect(diagnostic).not.toContain(responseBody);
    expect(diagnostic).not.toContain(query);
  });

  it("項目詳細収集エラーから公開項目参照だけを出し汎用エラーメッセージを出さない", () => {
    const messageCanary = "GENERIC_ERROR_MESSAGE_CANARY";
    const cause = new Error(messageCanary);
    const error = new GitHubItemDetailCollectionError("VOICEVOX", "voicevox_engine", 123, {
      cause,
    });
    delete error.stack;
    delete cause.stack;

    const diagnostic = safeErrorDiagnostic("incremental_collection", error);

    expect(diagnostic).toBe(
      "stage=incremental_collection errorType=GitHubItemDetailCollectionError<-Error item=VOICEVOX/voicevox_engine#123",
    );
    expect(diagnostic).not.toContain(messageCanary);
  });

  it("空白や改行を含む診断値を出さない", () => {
    const error = new GitHubGraphQLResponseError(
      {
        queryHash: "0123456789abcdef",
        errorCount: 1,
        errors: [
          {
            locations: [{ line: 1, column: 2 }],
            path: ["unsafe path"],
            type: "unsafe type",
            code: "unsafe\ncode",
            fieldName: "safeField",
            typeName: "SafeType",
          },
        ],
        requestId: "unsafe request\nid",
      },
      {},
    );

    const diagnostic = safeErrorDiagnostic("incremental_collection", error);

    expect(diagnostic).not.toContain("gqlError0Path=");
    expect(diagnostic).not.toContain("gqlError0Type=");
    expect(diagnostic).not.toContain("gqlError0Code=");
    expect(diagnostic).not.toContain("requestId=");
    expect(diagnostic).not.toMatch(/[\n\r\t]/u);
    for (const field of diagnostic.split(" ")) {
      const separatorIndex = field.indexOf("=");
      expect(separatorIndex).toBeGreaterThan(0);
      expect(field.slice(separatorIndex + 1)).not.toMatch(/[\s\p{Cc}]/u);
    }
  });

  it("空白や改行を含むエラー型名を出さない", () => {
    const error = new Error("fixture");
    error.name = "Unsafe Error\nType";

    expect(safeErrorDiagnostic("configuration", error)).toBe("stage=configuration");
  });

  it("causeが循環していても各エラーを1回だけ出す", () => {
    const first = new Error("first");
    const second = new TypeError("second", { cause: first });
    Object.defineProperty(first, "cause", { value: second });

    expect(safeErrorDiagnostic("configuration", first)).toBe(
      "stage=configuration errorType=Error<-TypeError",
    );
  });

  it("causeチェーンを先頭5件まで出す", () => {
    let error = new Error("sixth");
    for (let index = 5; index >= 1; index -= 1) {
      error = new Error(index.toString(), { cause: error });
    }

    expect(safeErrorDiagnostic("configuration", error)).toBe(
      "stage=configuration errorType=Error<-Error<-Error<-Error<-Error",
    );
  });

  it("GraphQLエラー詳細を先頭3件に制限して超過件数を出す", () => {
    const error = new GitHubGraphQLResponseError(
      {
        queryHash: "0123456789abcdef",
        errorCount: 4,
        errors: [
          { fieldName: "field0" },
          { fieldName: "field1" },
          { fieldName: "field2" },
          { fieldName: "field3" },
        ],
      },
      {},
    );

    const diagnostic = safeErrorDiagnostic("incremental_collection", error);

    expect(diagnostic).toContain("gqlError2Field=field2");
    expect(diagnostic).not.toContain("gqlError3Field=field3");
    expect(diagnostic).toContain("gqlErrorOmittedCount=1");
  });

  it("診断文字列の長さ上限で打ち切り、後続フィールドを省略する", () => {
    const error = new GitHubGraphQLResponseError(
      {
        operationName: `Operation${"A".repeat(291)}`,
        queryHash: "0123456789abcdef",
        errorCount: 1,
        errors: [
          {
            path: ["p".repeat(300)],
            type: "T".repeat(300),
            code: "must-not-appear",
          },
        ],
        requestId: "must-not-appear",
      },
      {},
    );

    const diagnostic = safeErrorDiagnostic("incremental_collection", error);

    expect(diagnostic.length).toBeLessThanOrEqual(1000);
    expect(diagnostic).toMatch(/ truncated=true$/u);
    expect(diagnostic).not.toContain("gqlError0Code=");
    expect(diagnostic).not.toContain("requestId=");
  });

  it("Zod issueを先頭5件に制限してpath、code、期待型と超過件数を出す", () => {
    const result = z.array(z.string()).safeParse([0, 1, 2, 3, 4, 5]);
    if (result.success) {
      throw new TypeError("Zod検証が成功しました");
    }
    const error = new GitHubResponseSchemaValidationError("fixture", result.error);

    const diagnostic = safeErrorDiagnostic("incremental_collection", error);

    expect(diagnostic).toContain("errorType=GitHubResponseSchemaValidationError<-TypeError");
    expect(diagnostic).toContain("zodIssueCount=6");
    expect(diagnostic).toContain("zodIssue0Path=0");
    expect(diagnostic).toContain("zodIssue0Code=invalid_type");
    expect(diagnostic).toContain("zodIssue0Expected=string");
    expect(diagnostic).toContain("zodIssue4Path=4");
    expect(diagnostic).not.toContain("zodIssue5Path=5");
    expect(diagnostic).toContain("zodIssueOmittedCount=1");
  });

  it("Zod由来のStateFormatErrorから安全なissueだけを先頭5件まで出す", () => {
    const messageCanary = "STATE_ZOD_MESSAGE_CANARY";
    const schema = z.array(z.string().refine(() => false, messageCanary));
    const result = schema.safeParse(["0", "1", "2", "3", "4", "5"]);
    if (result.success) {
      throw new TypeError("Zod検証が成功しました");
    }
    const error = StateFormatError.fromZodError("state history", result.error);

    const diagnostic = safeErrorDiagnostic("completeness_validation", error);

    expect(diagnostic).toContain("errorType=StateZodValidationError<-TypeError");
    expect(diagnostic).toContain("zodIssueCount=6");
    expect(diagnostic).toContain("zodIssue0Path=0");
    expect(diagnostic).toContain("zodIssue0Code=custom");
    expect(diagnostic).toContain("zodIssue4Path=4");
    expect(diagnostic).not.toContain("zodIssue5Path=5");
    expect(diagnostic).toContain("zodIssueOmittedCount=1");
    expect(diagnostic).not.toContain(messageCanary);
  });

  it("関係先展開上限から件数だけを診断へ出す", () => {
    const nodeId = "I_identifier_canary";
    const url = "https://github.com/VOICEVOX/private/issues/42";
    const title = "title-canary";
    const body = "body-canary";
    const error = new CliRelationExpansionLimitError(500, 500, 12, {});
    delete error.stack;
    Object.defineProperties(error, {
      nodeId: { value: nodeId },
      url: { value: url },
      title: { value: title },
      body: { value: body },
    });

    const diagnostic = safeErrorDiagnostic("incremental_collection", error);

    expect(diagnostic).toBe(
      "stage=incremental_collection errorType=CliRelationExpansionLimitError relationExpansionLimit=500 relationExpansionFetchedCount=500 relationExpansionUnfetchedCount=12",
    );
    expect(diagnostic).not.toContain(nodeId);
    expect(diagnostic).not.toContain(url);
    expect(diagnostic).not.toContain(title);
    expect(diagnostic).not.toContain(body);
  });

  it("責務再生retry枯渇エラーからcause連鎖と安全な項目識別情報を診断へ出す", () => {
    const itemNodeId = createGitHubNodeId("I_public_repository_42");
    const cause = new ResponsibilityReplayMismatchError(itemNodeId);
    const error = new ResponsibilityReplayRetryExhaustedError(itemNodeId, 4, { cause });
    delete error.stack;
    delete cause.stack;

    expect(safeErrorDiagnostic("incremental_collection", error)).toBe(
      "stage=incremental_collection errorType=ResponsibilityReplayRetryExhaustedError<-ResponsibilityReplayMismatchError itemNodeId=I_public_repository_42 attempts=4",
    );
  });

  it("停滞時間計算の時刻範囲違反から固定項目だけを診断へ出す", () => {
    const itemNodeId = createGitHubNodeId("I_staleness_item");
    const cause = new StalenessTimestampRangeError(
      "responsibility",
      createUtcIsoDateTime("2026-07-30T08:00:00Z"),
      createUtcIsoDateTime("2026-07-30T07:00:00Z"),
      createUtcIsoDateTime("2026-07-31T09:00:00Z"),
    );
    const error = new StalenessReductionError(itemNodeId, { cause });
    delete error.stack;
    delete cause.stack;

    expect(safeErrorDiagnostic("incremental_collection", error)).toBe(
      "stage=incremental_collection errorType=StalenessReductionError<-StalenessTimestampRangeError itemNodeId=I_staleness_item basisKind=responsibility createdAt=2026-07-30T08:00:00.000Z occurredAt=2026-07-30T07:00:00.000Z evaluatedAt=2026-07-31T09:00:00.000Z",
    );
  });

  it("関係参照の複数の食い違いから固定語彙だけを診断へ出す", () => {
    const nodeId = "I_node-id-canary";
    const url = "https://github.com/owner-canary/repository-canary/issues/42";
    const owner = "owner-canary";
    const repository = "repository-canary";
    const existing = {
      nodeId: createGitHubNodeId(nodeId),
      repositoryOwner: owner,
      repositoryName: repository,
      repositoryArchived: false,
      repositoryDisabled: true,
      type: "issue",
      number: 42,
      url,
      state: "open",
    } satisfies PublicGitHubRelationItem;
    const incoming = {
      ...existing,
      repositoryArchived: true,
      repositoryDisabled: false,
      type: "pull_request",
      url: "https://github.com/owner-canary/repository-canary/pull/42",
      state: "merged",
    } satisfies PublicGitHubRelationItem;
    const error = new RelationReferenceConflictError("node_id", existing, incoming, [
      { field: "nodeId" },
      { field: "repositoryOwner" },
      { field: "repositoryName" },
      {
        field: "repositoryArchived",
        existingValue: false,
        incomingValue: true,
      },
      {
        field: "repositoryDisabled",
        existingValue: true,
        incomingValue: false,
      },
      {
        field: "type",
        existingValue: "issue",
        incomingValue: "pull_request",
      },
      { field: "number" },
      { field: "url" },
      {
        field: "state",
        existingValue: "open",
        incomingValue: "merged",
      },
    ]);
    delete error.stack;
    Object.defineProperties(error, {
      nodeId: { value: nodeId },
      url: { value: url },
      repositoryOwner: { value: owner },
      repositoryName: { value: repository },
    });

    const diagnostic = safeErrorDiagnostic("incremental_collection", error);

    expect(diagnostic).toBe(
      "stage=incremental_collection errorType=RelationReferenceConflictError relationReferenceConflictKind=node_id relationReferenceConflictFields=nodeId,repositoryOwner,repositoryName,repositoryArchived,repositoryDisabled,type,number,url,state relationReferenceConflictRepositoryArchivedExisting=false relationReferenceConflictRepositoryArchivedIncoming=true relationReferenceConflictRepositoryDisabledExisting=true relationReferenceConflictRepositoryDisabledIncoming=false relationReferenceConflictTypeExisting=issue relationReferenceConflictTypeIncoming=pull_request relationReferenceConflictStateExisting=open relationReferenceConflictStateIncoming=merged",
    );
    expect(diagnostic).not.toContain(nodeId);
    expect(diagnostic).not.toContain(url);
    expect(diagnostic).not.toContain(owner);
    expect(diagnostic).not.toContain(repository);
  });

  it("許可済みCLIエラー3種でmessageを最後に出す", () => {
    const errors = [
      new CliCodexAuthenticationError({}),
      new CliCredentialsError(["GH_APP_ID", "GH_APP_PRIVATE_KEY"], {}),
      new CliExecutableError("codex", {}),
    ];

    for (const error of errors) {
      const diagnostic = safeErrorDiagnostic("configuration", error);
      expect(diagnostic).toContain(`errorType=${error.name}`);
      expect(diagnostic.indexOf(" message=")).toBeGreaterThan(diagnostic.indexOf(" errorType="));
      expect(diagnostic.slice(diagnostic.indexOf(" message=") + 1)).toBe(
        `message=${error.message}`,
      );
    }
  });

  it("許可済みmessageの空白を保ち、改行と制御文字だけをエスケープする", () => {
    const error = new CliExecutableError("co dex\n\t\u0000", {});

    expect(safeErrorDiagnostic("configuration", error)).toBe(
      "stage=configuration errorType=CliExecutableError message=必要な実行可能ファイルが見つからないか起動できません。対象: co dex%u000a%u0009%u0000",
    );
  });

  it("既知のcause詳細より後にmessageを出す", () => {
    const cause = new GitHubRequestError(503, 2, {});
    const error = new CliExecutableError("codex", { cause });

    expect(safeErrorDiagnostic("configuration", error)).toBe(
      "stage=configuration errorType=CliExecutableError<-GitHubRequestError attempts=2 httpStatus=503 message=必要な実行可能ファイルが見つからないか起動できません。対象: codex",
    );
  });
});
