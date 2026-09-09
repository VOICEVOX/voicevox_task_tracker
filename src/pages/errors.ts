import { TaskTrackerError } from "../util/index.js";

/** Pages公開データ処理で発生するエラーの基底クラス。 */
export abstract class PagesError extends TaskTrackerError {}

/** Pages公開データへ含められない情報を検出したことを表す。 */
export class PagesPublicSafetyError extends PagesError {
  public readonly violationCodes: readonly string[];

  public constructor(violationCodes: readonly string[]) {
    const uniqueCodes = [...new Set(violationCodes)].sort();
    super(`公開安全性の違反を検出しました。分類: ${uniqueCodes.join(", ")}`, {});
    this.violationCodes = Object.freeze(uniqueCodes);
  }
}

/** Pages公開データ生成の入力または導出結果が矛盾していることを表す。 */
export class PublicDtoSemanticError extends PagesError {
  public constructor(message: string) {
    super(`公開DTOの意味検証に失敗しました。${message}`, {});
  }
}

/** Pages公開DTOが共有schemaへ適合しないことを表す。 */
export class PublicDtoValidationError extends PagesError {
  public constructor(kind: "summary" | "details" | "notification-history", options: ErrorOptions) {
    super(`公開${kind} DTOがschemaへ適合しません`, options);
  }
}

/** 初期表示summaryのgzipサイズが公開上限を超えたことを表す。 */
export class PublicSummarySizeError extends PagesError {
  public readonly actualBytes: number;
  public readonly maximumBytes: number;

  public constructor(actualBytes: number, maximumBytes: number) {
    super(
      `公開summaryのgzipサイズが上限を超えました。実測: ${actualBytes.toString()} bytes 上限: ${maximumBytes.toString()} bytes`,
      {},
    );
    this.actualBytes = actualBytes;
    this.maximumBytes = maximumBytes;
  }
}

/** Pages公開DTOファイルを書き出せなかったことを表す。 */
export class PublicDataWriteError extends PagesError {
  public constructor(fileName: string, options: ErrorOptions) {
    super(`公開DTOファイルを書き出せません。対象: ${fileName}`, options);
  }
}
