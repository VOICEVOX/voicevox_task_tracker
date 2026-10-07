import type {
  NotificationCasOutcome,
  NotificationHttpOutcome,
} from "./notification-recovery-contracts.js";

/** 通知stateの構造違反と失敗した操作の副作用確度。 */
export class NotificationStructureError extends TypeError {
  public readonly effectCertainty: "no_effect" | "committed";
  public readonly casOutcome: NotificationCasOutcome;
  public readonly httpOutcome: NotificationHttpOutcome;

  public constructor(
    message: string,
    effectCertainty: "no_effect" | "committed",
    options?: ErrorOptions &
      Readonly<{
        casOutcome?: NotificationCasOutcome;
        httpOutcome?: NotificationHttpOutcome;
      }>,
  ) {
    super(message, options);
    this.name = "NotificationStructureError";
    this.effectCertainty = effectCertainty;
    this.casOutcome = options?.casOutcome ?? "not_attempted";
    this.httpOutcome =
      options?.httpOutcome ?? (effectCertainty === "committed" ? "committed" : "not_started");
  }
}
