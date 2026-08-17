import { type ZodError } from "zod";

import { TaskTrackerError } from "../util/index.js";
import {
  createZodErrorDiagnostics,
  type ZodErrorDiagnostics,
  type ZodValidationIssue,
} from "../util/zod-error-diagnostic.js";

/** state永続化で発生するエラーの基底クラス。 */
export abstract class StatePersistenceError extends TaskTrackerError {}

/** state設定または保存パスが不正であることを表す。 */
export class StateConfigurationError extends StatePersistenceError {
  public constructor(message: string) {
    super(`state設定が不正です。${message}`, {});
  }
}

/** snapshotがrepositoryのJSON Schemaへ適合しないことを表す。 */
export class StateSnapshotSchemaError extends StatePersistenceError {
  public readonly issueCount: number;

  public constructor(issueCount: number) {
    super(`snapshotがschemaへ適合しません。問題件数: ${issueCount.toString()}`, {});
    this.issueCount = issueCount;
  }
}

/** snapshot内の参照関係または完了条件が不正であることを表す。 */
export class StateSnapshotSemanticError extends StatePersistenceError {
  public constructor(message: string) {
    super(`snapshotの意味検証に失敗しました。${message}`, {});
  }
}

/** stateへ公開できないデータが含まれることを表す。 */
export class StatePublicSafetyError extends StatePersistenceError {
  public readonly violationCodes: readonly string[];

  public constructor(violationCodes: readonly string[]) {
    const uniqueCodes = [...new Set(violationCodes)].sort();
    super(
      `公開安全性の違反を検出しました。分類: ${uniqueCodes.join(", ")}。state更新を中止しました`,
      {},
    );
    this.violationCodes = Object.freeze(uniqueCodes);
  }
}

/** stateのJSONまたはJSON Linesを安全に解釈できないことを表す。 */
export class StateFormatError extends StatePersistenceError {
  public constructor(kind: string, options: ErrorOptions) {
    super(`${kind}の保存形式が不正です`, options);
  }

  /** Zod schema検証失敗から安全なStateFormatErrorを生成する。 */
  public static fromZodError(kind: string, error: ZodError): StateZodValidationError {
    return new StateZodValidationError(kind, error);
  }
}

/** Zod schema検証に由来するstate保存形式エラー。 */
export class StateZodValidationError extends StateFormatError implements ZodErrorDiagnostics {
  public readonly issueCount: number;
  public readonly issues: readonly ZodValidationIssue[];
  public readonly omittedIssueCount: number;

  public constructor(kind: string, error: ZodError) {
    const diagnostics = createZodErrorDiagnostics(error);
    super(kind, {
      cause: new TypeError(
        `${kind}のschema検証に失敗しました。問題件数: ${diagnostics.issueCount.toString()}`,
      ),
    });
    this.issueCount = diagnostics.issueCount;
    this.issues = diagnostics.issues;
    this.omittedIssueCount = diagnostics.omittedIssueCount;
  }
}

/** state履歴を一意に生成または再生できないことを表す。 */
export class StateHistoryError extends StatePersistenceError {
  public constructor(message: string) {
    super(`state履歴を処理できません。${message}`, {});
  }
}

/** state branchの読み取りに失敗したことを表す。 */
export class StateBranchReadError extends StatePersistenceError {
  public constructor(options: ErrorOptions) {
    super("state branchを読み取れません", options);
  }
}

/** state branchのcommit生成またはref更新に失敗したことを表す。 */
export class StateBranchCommitError extends StatePersistenceError {
  public constructor(options: ErrorOptions) {
    super("state branchへatomic commitできません", options);
  }
}

/** state branchがsession開始後に別のcommitへ進んだことを表す。 */
export class StateBranchConflictError extends StatePersistenceError {
  public constructor() {
    super("state branchが別の処理によって更新されました", {});
  }
}
