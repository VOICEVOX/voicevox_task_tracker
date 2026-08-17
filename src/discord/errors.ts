import { TaskTrackerError } from "../util/index.js";

/** Discord通知で発生するエラーの基底クラス。 */
export abstract class DiscordError extends TaskTrackerError {}

/** Discord payloadの入力または制限値に違反したことを表す。 */
export class DiscordPayloadError extends DiscordError {
  public constructor(message: string) {
    super(`Discord payloadを生成できません。${message}`, {});
  }
}

/** Discord webhookのActions secretが見つからないことを表す。 */
export class DiscordWebhookSecretMissingError extends DiscordError {
  public readonly secretName: string;

  public constructor(secretName: string) {
    super(`Discord webhookのActions secretがありません。secret名: ${secretName}`, {});
    this.secretName = secretName;
  }
}

/** Discord webhookのActions secretがURL契約を満たさないことを表す。 */
export class DiscordWebhookSecretInvalidError extends DiscordError {
  public readonly secretName: string;

  public constructor(secretName: string) {
    super(`Discord webhookのActions secretが不正です。secret名: ${secretName}`, {});
    this.secretName = secretName;
  }
}

/** Discord webhook secretの読み取り処理が失敗したことを表す。 */
export class DiscordWebhookSecretReadError extends DiscordError {
  public readonly secretName: string;

  public constructor(secretName: string, options: ErrorOptions) {
    super(`Discord webhookのActions secretを読み取れません。secret名: ${secretName}`, options);
    this.secretName = secretName;
  }
}

/** Discord webhookへの送信が失敗したことを表す。 */
export class DiscordWebhookRequestError extends DiscordError {
  public readonly attempts: number;
  public readonly status: number | undefined;

  public constructor(status: number | undefined, attempts: number, options: ErrorOptions) {
    const statusText = status == null ? "不明" : status.toString();
    super(
      `Discord webhookへの送信に失敗しました。status: ${statusText} attempts: ${attempts.toString()}`,
      options,
    );
    this.status = status;
    this.attempts = attempts;
  }
}

/** Discord webhookのretry上限へ到達したことを表す。 */
export class DiscordWebhookRetryExhaustedError extends DiscordWebhookRequestError {
  public constructor(status: 429 | 503 | undefined, attempts: number, options: ErrorOptions) {
    super(status, attempts, options);
  }
}

/** Discord webhookの成功応答がMessage契約を満たさないことを表す。 */
export class DiscordWebhookResponseError extends DiscordError {
  public readonly attempts: number;
  public readonly status: number;

  public constructor(status: number, attempts: number, options: ErrorOptions) {
    super(
      `Discord webhookの成功応答からmessage IDを取得できません。status: ${status.toString()} attempts: ${attempts.toString()}`,
      options,
    );
    this.status = status;
    this.attempts = attempts;
  }
}

/** Discord通知ledgerの読み書きが失敗したことを表す。 */
export class DiscordLedgerError extends DiscordError {
  public constructor(action: "read" | "write", options: ErrorOptions) {
    const actionText = action === "read" ? "読み取り" : "記録";
    super(`Discord通知ledgerの${actionText}に失敗しました`, options);
  }
}

/** 通常digestの送信失敗と運用障害通知の結果をまとめて表す。 */
export class DiscordDigestDeliveryError extends DiscordError {
  public readonly digestId: string;
  public readonly operationsAlertStatus: "sent" | "already_recorded" | "failed";

  public constructor(
    digestId: string,
    operationsAlertStatus: "sent" | "already_recorded" | "failed",
    options: ErrorOptions,
  ) {
    super(
      `Discord digestを完送できません。digest ID: ${digestId} 運用障害通知: ${operationsAlertStatus}`,
      options,
    );
    this.digestId = digestId;
    this.operationsAlertStatus = operationsAlertStatus;
  }
}
