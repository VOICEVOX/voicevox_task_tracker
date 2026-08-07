import { TaskTrackerError } from "../util/task-tracker-error.js";
import { type CodexApiErrorDiagnostic } from "./process-runner.js";

/** Codex adapterで発生するエラーの基底クラス。 */
export abstract class CodexAdapterError extends TaskTrackerError {}

/** Codex CLIの実行試行で発生するエラーの基底クラス。 */
export abstract class CodexAttemptError extends CodexAdapterError {
  public readonly attempts: number;

  protected constructor(message: string, attempts: number, options: ErrorOptions) {
    super(message, options);
    this.attempts = attempts;
  }
}

/** Codex CLIが制限時間内に終了しなかったことを表す。 */
export class CodexTimeoutError extends CodexAttemptError {
  public readonly timeoutMilliseconds: number;

  public constructor(attempts: number, timeoutMilliseconds: number) {
    super(
      `Codex CLIが制限時間内に終了しませんでした。試行回数: ${attempts.toString()} 制限時間ミリ秒: ${timeoutMilliseconds.toString()}`,
      attempts,
      {},
    );
    this.timeoutMilliseconds = timeoutMilliseconds;
  }
}

/** Codex CLIが正常終了しなかったことを表す。 */
export class CodexNonZeroExitError extends CodexAttemptError {
  public readonly exitCode: number | null;
  public readonly signal: NodeJS.Signals | null;
  public readonly apiError: CodexApiErrorDiagnostic | undefined;

  public constructor(
    attempts: number,
    exitCode: number | null,
    signal: NodeJS.Signals | null,
    apiError: CodexApiErrorDiagnostic | undefined,
  ) {
    const exitCodeText = exitCode == null ? "なし" : exitCode.toString();
    const signalText = signal ?? "なし";
    super(
      `Codex CLIが正常終了しませんでした。試行回数: ${attempts.toString()} 終了コード: ${exitCodeText} signal: ${signalText}`,
      attempts,
      {},
    );
    this.exitCode = exitCode;
    this.signal = signal;
    this.apiError = apiError;
  }
}

/** Codex CLIの非ゼロ終了から外部診断へ渡せる情報。 */
export type CodexNonZeroExitDiagnostic = Readonly<{
  exitCode: number | null;
  apiError: CodexApiErrorDiagnostic | undefined;
}>;

/** Codex CLIの最終メッセージをJSONとして読み込めなかったことを表す。 */
export class CodexInvalidJsonError extends CodexAttemptError {
  public constructor(attempts: number, options: ErrorOptions) {
    super(
      `Codex CLIの最終メッセージをJSONとして読み込めません。試行回数: ${attempts.toString()}`,
      attempts,
      options,
    );
  }
}

/** Codexがrate limitに達したことを表す。 */
export class CodexRateLimitError extends CodexAttemptError {
  public constructor(attempts: number, options: ErrorOptions) {
    super(`Codexがrate limitに達しました。試行回数: ${attempts.toString()}`, attempts, options);
  }
}

/** Codex CLIの起動または標準入力の送信に失敗したことを表す。 */
export class CodexProcessStartError extends CodexAttemptError {
  public constructor(attempts: number, options: ErrorOptions) {
    super(`Codex CLIを起動できません。試行回数: ${attempts.toString()}`, attempts, options);
  }
}

/** Codex adapterが固定資材を読み込めなかったことを表す。 */
export class CodexResourceError extends CodexAdapterError {
  public constructor(resource: string, options: ErrorOptions) {
    super(`Codex adapterの固定資材を読み込めません。対象: ${resource}`, options);
  }
}

/** Codex adapterの一時作業ディレクトリを安全に管理できなかったことを表す。 */
export class CodexTemporaryWorkspaceError extends CodexAdapterError {
  public constructor(action: "create" | "cleanup", options: ErrorOptions) {
    const actionText = action === "create" ? "作成" : "削除";
    super(`Codex用の一時作業ディレクトリを${actionText}できません`, options);
  }
}

/** Codex出力の検証で見つけた問題。 */
export type CodexOutputValidationIssue = Readonly<{
  path: string;
  code: string;
  message: string;
}>;

/** Codex出力の検証失敗から外部診断へ渡せる安全な要約。 */
export type CodexOutputValidationDiagnostic = Readonly<{
  issueCount: number;
  issues: readonly Readonly<{
    path: string;
    code: string;
  }>[];
}>;

/** Codex出力の検証失敗を表す基底クラス。 */
export abstract class CodexOutputValidationError extends TaskTrackerError {
  public abstract readonly stage: "schema" | "semantic";
  public readonly issues: readonly CodexOutputValidationIssue[];

  protected constructor(message: string, issues: readonly CodexOutputValidationIssue[]) {
    super(`${message} 問題数: ${issues.length.toString()}`, {});
    this.issues = Object.freeze(
      issues.map((issue) =>
        Object.freeze({
          path: issue.path,
          code: issue.code,
          message: issue.message,
        }),
      ),
    );
  }
}

/** JSON Schema検証でCodex出力を拒否したことを表す。 */
export class CodexOutputSchemaValidationError extends CodexOutputValidationError {
  public readonly stage = "schema";

  public constructor(issues: readonly CodexOutputValidationIssue[]) {
    super("Codex出力がJSON Schemaに適合しません。", issues);
  }
}

/** semantic検証でCodex出力を拒否したことを表す。 */
export class CodexOutputSemanticValidationError extends CodexOutputValidationError {
  public readonly stage = "semantic";

  public constructor(issues: readonly CodexOutputValidationIssue[]) {
    super("Codex出力がsemantic制約に適合しません。", issues);
  }
}

/** AI cacheで発生するエラーの基底クラス。 */
export abstract class AiCacheError extends TaskTrackerError {}

/** AI cacheファイルを読み込めなかったことを表す。 */
export class AiCacheReadError extends AiCacheError {
  public constructor(cacheKey: string, options: ErrorOptions) {
    super(`AI cacheを読み込めません。cache key: ${cacheKey}`, options);
  }
}

/** AI cacheファイルを書き込めなかったことを表す。 */
export class AiCacheWriteError extends AiCacheError {
  public constructor(cacheKey: string, options: ErrorOptions) {
    super(`AI cacheを書き込めません。cache key: ${cacheKey}`, options);
  }
}

/** AI cacheの内容が保存契約を満たさないことを表す。 */
export class AiCacheFormatError extends AiCacheError {
  public constructor(cacheKey: string, options: ErrorOptions) {
    super(`AI cacheの内容が不正です。cache key: ${cacheKey}`, options);
  }
}
