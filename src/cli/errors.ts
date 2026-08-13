import { type GitHubNodeId } from "../domain/index.js";
import { TaskTrackerError } from "../util/index.js";

/** CLIの引数が利用規約へ適合しないことを表す。 */
export class CliUsageError extends TaskTrackerError {
  public constructor(message: string, options: ErrorOptions) {
    super(`CLI引数が不正です。${message}`, options);
  }
}

/** CLIのartifactまたはrun reportを書き出せないことを表す。 */
export class CliOutputError extends TaskTrackerError {
  public constructor(path: string, options: ErrorOptions) {
    super(`CLI出力を書き出せません。対象: ${path}`, options);
  }
}

/** replayまたはevalの入力fixtureを読み取れないことを表す。 */
export class CliFixtureError extends TaskTrackerError {
  public constructor(path: string, options: ErrorOptions) {
    super(`CLI fixtureを読み取れません。対象: ${path}`, options);
  }
}

/** 指定した永続stateファイルを読み取れないか検証できないことを表す。 */
export class CliStateVerificationError extends TaskTrackerError {
  public constructor(path: string, options: ErrorOptions) {
    super(`永続stateを検証できません。対象: ${path}`, options);
  }
}

/** CLIへ安全に表示できる環境変数名だけを保持する認証情報エラー。 */
export class CliCredentialsError extends TaskTrackerError {
  public readonly variableNames: readonly string[];

  public constructor(variableNames: readonly string[], options: ErrorOptions) {
    const uniqueVariableNames = [...new Set(variableNames)].sort();
    super(`必要な認証情報が不足または不正です。環境変数: ${uniqueVariableNames.join(", ")}`, {
      cause: options.cause,
    });
    this.variableNames = Object.freeze(uniqueVariableNames);
  }
}

/** Codexのauth.jsonが認証に利用できないことを表す。 */
export class CliCodexAuthenticationError extends TaskTrackerError {
  public constructor(options: ErrorOptions) {
    super(
      "Codex認証ファイルを確認できません。CODEX_HOME直下にauth.jsonが存在することを確認してください",
      options,
    );
  }
}

/** workflowの前段成果物が存在しないか検証できないことを表す。 */
export class CliWorkflowArtifactError extends TaskTrackerError {
  public constructor(path: string, reason: "missing" | "invalid", options: ErrorOptions) {
    const description =
      reason === "missing" ? "前stageの成果物がありません" : "前stageの成果物が不正です";
    super(`${description}。対象: ${path}`, options);
  }
}

/** 有効な機能が必要とする実行可能ファイルを起動できないことを表す。 */
export class CliExecutableError extends TaskTrackerError {
  public constructor(executable: string, options: ErrorOptions) {
    super(`必要な実行可能ファイルが見つからないか起動できません。対象: ${executable}`, options);
  }
}

/** 1 runの関係先展開上限に到達したことを表す。 */
export class CliRelationExpansionLimitError extends TaskTrackerError {
  public readonly limit: number;
  public readonly fetchedCount: number;
  public readonly unfetchedCount: number;

  public constructor(
    limit: number,
    fetchedCount: number,
    unfetchedCount: number,
    options: ErrorOptions,
  ) {
    super(
      `1 runの関係先展開上限に到達しました。上限: ${limit.toString()}、取得済み: ${fetchedCount.toString()}、未取得: ${unfetchedCount.toString()}`,
      options,
    );
    this.limit = limit;
    this.fetchedCount = fetchedCount;
    this.unfetchedCount = unfetchedCount;
  }
}

/** 責務イベントの再生整合性retry上限へ到達したことを表す。 */
export class ResponsibilityReplayRetryExhaustedError extends TaskTrackerError {
  public readonly itemNodeId: GitHubNodeId;
  public readonly attempts: number;

  public constructor(itemNodeId: GitHubNodeId, attempts: number, options: ErrorOptions) {
    super(
      `責務イベントの再生整合性retry上限へ到達しました。対象: ${itemNodeId} attempts: ${attempts.toString()}`,
      options,
    );
    this.itemNodeId = itemNodeId;
    this.attempts = attempts;
  }
}
