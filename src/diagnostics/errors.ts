/** diagnostics機能の基底エラー。 */
export class DiagnosticsError extends Error {
  public constructor(message: string, options: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** diagnostics入力または保存形式の検証に失敗したことを表す。 */
export class DiagnosticsValidationError extends DiagnosticsError {
  public constructor(message: string, options: ErrorOptions) {
    super(`diagnosticsの検証に失敗しました。${message}`, options);
  }
}

/** diagnosticsバンドルの保存先が既に存在することを表す。 */
export class DiagnosticsOutputExistsError extends DiagnosticsError {
  public readonly path: string;

  public constructor(path: string, options: ErrorOptions) {
    super(`diagnosticsの出力先が既に存在します。対象: ${path}`, options);
    this.path = path;
  }
}

/** diagnosticsバンドルの形式が不正であることを表す。 */
export class DiagnosticsFormatError extends DiagnosticsError {
  public constructor(message: string, options: ErrorOptions) {
    super(`diagnosticsバンドルの形式が不正です。${message}`, options);
  }
}

/** diagnostics CLIの引数が不正であることを表す。 */
export class DiagnosticsCliUsageError extends DiagnosticsError {
  public constructor(message: string, options: ErrorOptions) {
    super(`diagnostics CLI引数が不正です。${message}`, options);
  }
}
