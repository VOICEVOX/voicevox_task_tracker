import { createHash } from "node:crypto";

import {
  createUtcIsoDateTime,
  type OperationsAlertLedgerEntry,
  type UtcIsoDateTime,
} from "../domain/index.js";
import type {
  DiscordDeliveryDependencies,
  DiscordDeliverySettings,
  DiscordOperationsAlertDelivery,
} from "./delivery.js";
import {
  DiscordLedgerError,
  DiscordOperationsPostSendError,
  DiscordPayloadError,
} from "./errors.js";
import type { DiscordWebhookPayload } from "./payload-contracts.js";
import { assertDiscordWebhookPayloadWithinLimits } from "./payload-packing.js";
import { executeDiscordWebhook } from "./webhook.js";

const INCIDENT_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/u;

export type WorkflowInfrastructureIncident = Readonly<{
  incidentId: string;
  kind: "workflow_infrastructure_failure";
  occurredAt: UtcIsoDateTime;
  retryAttempts: number;
  context?: Readonly<{
    failureKind: string;
    failedStage: string;
    finalStateRevision?: string;
    lastReceiptDigest?: string;
  }>;
}>;

function infrastructureAlertPayload(
  incident: WorkflowInfrastructureIncident,
  alertKey: string,
): DiscordWebhookPayload {
  const payload = Object.freeze({
    content: ["VOICEVOX Task Tracker 運用障害", `alert ID: ${alertKey}`].join("\n"),
    embeds: Object.freeze([
      Object.freeze({
        title: "運用障害",
        fields: Object.freeze([
          Object.freeze({ name: "処理", value: "workflow基盤障害", inline: false }),
          Object.freeze({ name: "発生時刻", value: incident.occurredAt, inline: false }),
          Object.freeze({
            name: "概要",
            value: "CLIの公開失敗artifactを取得できませんでした",
            inline: false,
          }),
          Object.freeze({ name: "incident ID", value: incident.incidentId, inline: false }),
          Object.freeze({
            name: "試行回数",
            value: incident.retryAttempts.toString(),
            inline: false,
          }),
          ...(incident.context == null
            ? []
            : [
                Object.freeze({
                  name: "失敗段階",
                  value: incident.context.failedStage,
                  inline: false,
                }),
              ]),
        ]),
      }),
    ]),
    allowed_mentions: Object.freeze({
      parse: Object.freeze([]),
      roles: Object.freeze([]),
      users: Object.freeze([]),
      replied_user: false,
    }),
  } satisfies DiscordWebhookPayload);
  assertDiscordWebhookPayloadWithinLimits(payload);
  return payload;
}

/** workflow基盤障害の送信識別子とpayloadを確定する。 */
export function buildDiscordInfrastructureAlertPlan(
  incident: WorkflowInfrastructureIncident,
): Readonly<{ alertKey: string; payload: DiscordWebhookPayload }> {
  if (!INCIDENT_ID_PATTERN.test(incident.incidentId)) {
    throw new DiscordPayloadError("運用障害のincident IDが不正です");
  }
  if (!Number.isSafeInteger(incident.retryAttempts) || incident.retryAttempts <= 0) {
    throw new DiscordPayloadError("運用障害のretry回数は正の安全な整数にしてください");
  }
  const alertHash = createHash("sha256")
    .update(JSON.stringify([incident.kind, incident.incidentId]))
    .digest("hex")
    .slice(0, 24);
  const alertKey = `discord-operations-alert:v1:${alertHash}`;
  const payload = infrastructureAlertPayload(incident, alertKey);
  return Object.freeze({ alertKey, payload });
}

/** workflow基盤障害を専用kindのmessageとledger entryで送る。 */
export async function sendDiscordInfrastructureAlert(
  incident: WorkflowInfrastructureIncident,
  settings: DiscordDeliverySettings,
  dependencies: DiscordDeliveryDependencies,
): Promise<DiscordOperationsAlertDelivery> {
  if (!settings.enabled) {
    return Object.freeze({ status: "disabled" });
  }
  const { alertKey, payload } = buildDiscordInfrastructureAlertPlan(incident);
  if (await dependencies.ledger.hasOperationsAlert(alertKey)) {
    return Object.freeze({ status: "already_recorded", alertKey });
  }
  const execution = await executeDiscordWebhook({
    secretName: settings.operationsWebhookSecretName,
    payload,
    retry: settings.retry,
    secretProvider: dependencies.secretProvider,
    httpClient: dependencies.httpClient,
    runtime: dependencies.runtime,
    beforeFirstAttempt: () => Promise.resolve(),
  });
  try {
    const sentAt = createUtcIsoDateTime(dependencies.runtime.now().toISOString());
    if (sentAt < incident.occurredAt) {
      throw new DiscordLedgerError("write", {
        cause: new RangeError("運用障害通知の送信時刻が障害発生時刻より前です"),
      });
    }
    const ledgerEntry = Object.freeze({
      alertKey,
      incidentId: incident.incidentId,
      kind: incident.kind,
      occurredAt: incident.occurredAt,
      sentAt,
      discordMessageId: execution.discordMessageId,
    } satisfies OperationsAlertLedgerEntry);
    await dependencies.ledger.recordOperationsAlert(ledgerEntry);
    return Object.freeze({
      status: "sent",
      alertKey,
      discordMessageId: execution.discordMessageId,
      ledgerEntry,
    });
  } catch (error: unknown) {
    throw new DiscordOperationsPostSendError(execution.discordMessageId, error);
  }
}
