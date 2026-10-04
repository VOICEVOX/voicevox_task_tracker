import { resolve } from "node:path";

import { z } from "zod";

import type {
  NotificationSettlementReceipt,
  RunFinalizationReceipt,
} from "../../application/tracking-run/receipt-schema.js";
import { hashCanonicalJson } from "../../canonical-json/index.js";
import { serializeCanonicalJson } from "../../canonical-json/value.js";
import type { Config } from "../../config/index.js";
import { readPagesContentManifest } from "../../pages/build-web-output.js";
import type {
  StateBranchAdapter,
  StatePersistenceConfiguration,
} from "../../persistence/branch-adapter.js";
import { assertExistingStatePublicSafety } from "../../persistence/public-safety.js";
import {
  MAX_INTERVENING_COMMITS,
  authorizeAdvanceAfterOrthogonalCommits,
} from "../../persistence/state-orthogonal-advance.js";
import type { NotificationHistoryPagesBuildArtifact } from "./notification-history-pages-build-artifact.js";
import { parseNotificationHistoryPagesBuildArtifact } from "./notification-history-pages-build-artifact.js";
import {
  parseNotificationHistoryPagesDeploymentOutcome,
  type NotificationHistoryPagesDeploymentOutcome,
} from "./notification-history-pages-deployment-outcome.js";
import { readNotificationHistoryPagesSource } from "./notification-history-pages-source.js";
import { readNotificationMessageState } from "./notification-message-state.js";

const sha256Schema = z.string().regex(/^sha256:[0-9a-f]{64}$/u);
const revisionSchema = z.string().regex(/^[0-9a-f]{40}$/u);
const preflightSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    schemaVersion: z.literal(1),
    kind: z.literal("ready"),
    sourceStateRevision: revisionSchema,
    observedHeadRevision: revisionSchema,
    deploymentIntentDigest: sha256Schema,
    replay: z.boolean(),
  }),
  z.strictObject({
    schemaVersion: z.literal(1),
    kind: z.literal("observed"),
    sourceStateRevision: revisionSchema,
    observedHeadRevision: revisionSchema,
    deploymentIntentDigest: sha256Schema,
    outcome: z.unknown(),
  }),
  z.strictObject({
    schemaVersion: z.literal(1),
    kind: z.literal("not_required"),
    sourceStateRevision: revisionSchema,
    observedHeadRevision: revisionSchema,
    reason: z.enum([
      "notification_action_held",
      "notification_action_acknowledged",
      "no_sent_history",
    ]),
  }),
  z.strictObject({
    schemaVersion: z.literal(1),
    kind: z.literal("superseded"),
    sourceStateRevision: revisionSchema,
    observedHeadRevision: revisionSchema,
    deploymentIntentDigest: sha256Schema.optional(),
  }),
]);

/** 通知履歴Pagesのdeploy直前判定。 */
export type NotificationHistoryPagesDeploymentPreflight = z.output<typeof preflightSchema>;

/** canonical preflightの形式と既存結果の結合を検証する。 */
export function parseNotificationHistoryPagesDeploymentPreflight(
  value: unknown,
  artifact: NotificationHistoryPagesBuildArtifact,
): NotificationHistoryPagesDeploymentPreflight {
  const preflight = preflightSchema.parse(value);
  if (preflight.sourceStateRevision !== artifact.sourceStateRevision) {
    throw new TypeError("通知履歴Pages preflightとbuild artifactが一致しません");
  }
  if (artifact.status === "not_required") {
    if (
      (preflight.kind !== "not_required" && preflight.kind !== "superseded") ||
      (preflight.kind === "not_required" && preflight.reason !== artifact.reason) ||
      (preflight.kind === "superseded" && preflight.deploymentIntentDigest != null)
    ) {
      throw new TypeError("通知履歴Pages不要判定とpreflightが一致しません");
    }
  } else if (
    preflight.kind === "not_required" ||
    preflight.deploymentIntentDigest !== artifact.intent.deploymentIntentDigest
  ) {
    throw new TypeError("通知履歴Pages intentとpreflightが一致しません");
  }
  if (preflight.kind === "observed") {
    const outcome = parseNotificationHistoryPagesDeploymentOutcome(preflight.outcome, artifact);
    if (outcome.kind !== "deployed") {
      throw new TypeError("通知履歴Pagesの保存済み成功証拠がありません");
    }
    return { ...preflight, outcome };
  }
  return preflight;
}

async function assertNewerRunDescendsFromFinalState(
  adapter: StateBranchAdapter,
  finalRevision: string,
  headRevision: string,
): Promise<void> {
  let revision = headRevision;
  for (let count = 0; count < MAX_INTERVENING_COMMITS; count += 1) {
    if (revision === finalRevision) {
      return;
    }
    const commit = await adapter.readCommit(revision);
    if (commit.parent.status === "missing") {
      break;
    }
    revision = commit.parent.revision;
  }
  throw new TypeError("新しいrunのheadが通知履歴Pagesのfinal revisionに続いていません");
}

/** final stateと全file manifestを外部action直前に再検証する。 */
export async function preflightNotificationHistoryPagesDeployment(
  input: Readonly<{
    adapter: StateBranchAdapter;
    config: Config;
    configuration: StatePersistenceConfiguration;
    repositoryPath: string;
    artifact: NotificationHistoryPagesBuildArtifact;
    settlementReceipt: NotificationSettlementReceipt;
    finalizationReceipt: RunFinalizationReceipt;
    previousOutcome?: NotificationHistoryPagesDeploymentOutcome;
    replay: boolean;
    observedAt: string;
    effectTarget: "production" | "sandbox" | "recording";
    adapterIdentityDigest?: string;
  }>,
): Promise<NotificationHistoryPagesDeploymentPreflight> {
  const artifact = parseNotificationHistoryPagesBuildArtifact(input.artifact);
  const source = await readNotificationHistoryPagesSource(
    input.adapter,
    input.config,
    input.configuration,
    input.settlementReceipt,
    input.finalizationReceipt,
    [],
    () => new Date(input.observedAt),
  );
  if (
    artifact.sourceStateRevision !== source.revision ||
    artifact.receipt.previousReceiptDigest !== source.finalizationReceipt.receiptDigest ||
    artifact.receipt.phaseSequence !== source.finalizationReceipt.phaseSequence + 1 ||
    serializeCanonicalJson(artifact.receipt.binding) !==
      serializeCanonicalJson(source.finalizationReceipt.binding) ||
    (artifact.status === "built") !== (source.requirement.kind === "required") ||
    (artifact.status === "not_required" &&
      source.requirement.kind === "not_required" &&
      artifact.reason !== source.requirement.reason)
  ) {
    throw new TypeError("通知履歴Pages buildとfinal stateの連鎖が一致しません");
  }
  const record = source.record;
  if (
    record.executionPolicy.effectTarget !== input.effectTarget ||
    (input.adapterIdentityDigest != null &&
      (record.runtimeRecoveryPlan.kind !== "workflow_bundle" ||
        record.runtimeRecoveryPlan.recoveryProtocol.workflowEffectAdapterIdentityDigest !==
          input.adapterIdentityDigest))
  ) {
    throw new TypeError("通知履歴Pages adapterがrecordの実行契約と一致しません");
  }
  if (artifact.status === "built") {
    const intent = artifact.intent;
    if (
      intent.recordDigest !== record.recordDigest ||
      intent.snapshotDigest !== hashCanonicalJson(source.snapshot) ||
      intent.repositoryAllowlistDigest !==
        record.initialPagesProjection.repositoryAllowlistDigest ||
      intent.expectedPageUrl !== record.initialPagesProjection.settings.url
    ) {
      throw new TypeError("通知履歴Pages intentとfinal stateが一致しません");
    }
  }
  const head = await input.adapter.resolveHead(input.configuration.branch);
  if (head.status !== "present") {
    throw new TypeError("通知履歴Pages deploy直前のstate branchがありません");
  }
  const current = await readNotificationMessageState(
    input.adapter,
    input.configuration,
    head.revision,
  );
  if (current.transaction.marker.runId !== record.runIdentity.runId) {
    await assertNewerRunDescendsFromFinalState(input.adapter, source.revision, head.revision);
    return parseNotificationHistoryPagesDeploymentPreflight(
      {
        schemaVersion: 1,
        kind: "superseded",
        sourceStateRevision: source.revision,
        observedHeadRevision: head.revision,
        ...(artifact.status === "built"
          ? { deploymentIntentDigest: artifact.intent.deploymentIntentDigest }
          : {}),
      },
      artifact,
    );
  }
  if (
    current.transaction.marker.phase !== "run_finalized" ||
    current.transaction.marker.checkpointDigest !== record.checkpointDigest ||
    current.transaction.record.recordDigest !== record.recordDigest ||
    current.transaction.snapshotDigest !== hashCanonicalJson(source.snapshot)
  ) {
    throw new TypeError("通知履歴Pages deploy直前のstateがfinal intentと一致しません");
  }
  assertExistingStatePublicSafety(
    current.snapshot,
    source.historyRecords,
    current.ledger,
    [
      current.transaction.marker,
      current.transaction.record,
      current.transaction.initialPagesEvidence,
    ],
    [],
  );
  await authorizeAdvanceAfterOrthogonalCommits(
    input.adapter,
    input.configuration,
    source.revision,
    head.revision,
  );
  if (artifact.status === "built") {
    const output = await readPagesContentManifest(
      resolve(input.repositoryPath, artifact.intent.outputDirectory),
    );
    if (
      output.outputManifestDigest !== artifact.intent.outputManifestDigest ||
      output.pagesContentDigest !== artifact.intent.pagesContentDigest ||
      serializeCanonicalJson(output.manifest) !== serializeCanonicalJson(artifact.manifest)
    ) {
      throw new TypeError("通知履歴Pagesの全file manifestが一致しません");
    }
  }
  if (artifact.status === "not_required") {
    return parseNotificationHistoryPagesDeploymentPreflight(
      {
        schemaVersion: 1,
        kind: "not_required",
        sourceStateRevision: source.revision,
        observedHeadRevision: head.revision,
        reason: artifact.reason,
      },
      artifact,
    );
  }
  if (input.previousOutcome != null) {
    const previous = parseNotificationHistoryPagesDeploymentOutcome(
      input.previousOutcome,
      artifact,
    );
    if (previous.kind === "deployed") {
      const reference = previous.receipt.result?.externalReference;
      if (
        (input.adapterIdentityDigest != null &&
          (reference?.kind !== "github_pages_actions" ||
            reference.adapterIdentityDigest !== input.adapterIdentityDigest)) ||
        (input.adapterIdentityDigest == null &&
          input.effectTarget === "production" &&
          reference?.kind !== "github_pages_actions") ||
        (input.effectTarget !== "production" && reference?.kind !== "recording")
      ) {
        throw new TypeError("通知履歴Pages保存証拠とadapterが一致しません");
      }
      return parseNotificationHistoryPagesDeploymentPreflight(
        {
          schemaVersion: 1,
          kind: "observed",
          sourceStateRevision: source.revision,
          observedHeadRevision: head.revision,
          deploymentIntentDigest: artifact.intent.deploymentIntentDigest,
          outcome: previous,
        },
        artifact,
      );
    }
    if (previous.kind !== "failure" || previous.failedOperationEffectCertainty !== "no_effect") {
      throw new TypeError("通知履歴Pagesの先行公開結果を自動再試行できません");
    }
  }
  return parseNotificationHistoryPagesDeploymentPreflight(
    {
      schemaVersion: 1,
      kind: "ready",
      sourceStateRevision: source.revision,
      observedHeadRevision: head.revision,
      deploymentIntentDigest: artifact.intent.deploymentIntentDigest,
      replay: input.replay || input.previousOutcome != null,
    },
    artifact,
  );
}
