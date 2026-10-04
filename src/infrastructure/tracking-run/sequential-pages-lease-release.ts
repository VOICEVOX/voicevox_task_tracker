import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { receiptChainEnvelopeSchema } from "../../application/tracking-run/receipt-chain-schema.js";
import { verifyReceiptChain } from "../../application/tracking-run/receipt-chain.js";
import { serializeCanonicalJsonLine } from "../../canonical-json/value.js";
import { loadConfig } from "../../config/index.js";
import { GitStateBranchAdapter } from "../../persistence/git-state-branch-adapter.js";
import {
  readActiveProductionPagesEffectLease,
  releaseProductionPagesEffectLease,
} from "../../persistence/production-pages-effect-lease.js";
import { createRunReport } from "../../publication/run-report.js";
import { nodeContentDigestPort } from "./content-digest.js";
import { readNotificationMessageState } from "./notification-message-state.js";
import { requireSequentialPagesActionsContext } from "./sequential-pages-actions-port.js";
import { sequentialReceiptPath } from "./sequential-receipt-path.js";
import { authorizeAdvanceAfterOrthogonalCommits } from "../../persistence/state-orthogonal-advance.js";

/** 親processの完了とartifact保存後にproduction Pages leaseを解放する。 */
export async function releaseCompletedSequentialPagesLease(
  repositoryPath: string,
  reportPath: string,
  environment: Readonly<NodeJS.ProcessEnv>,
): Promise<void> {
  requireSequentialPagesActionsContext(environment);
  const reportSource = await readFile(resolve(repositoryPath, reportPath), "utf8");
  const reportRaw: unknown = JSON.parse(reportSource);
  if (reportSource !== serializeCanonicalJsonLine(reportRaw)) {
    throw new TypeError("production sequential reportがcanonical JSONではありません");
  }
  const report = createRunReport(reportRaw);
  if (report.status === "failure") {
    throw new TypeError("未完了runのproduction Pages leaseを解放できません");
  }
  const receiptSource = await readFile(sequentialReceiptPath(repositoryPath, report.runId), "utf8");
  const receiptRaw: unknown = JSON.parse(receiptSource);
  if (receiptSource !== serializeCanonicalJsonLine(receiptRaw)) {
    throw new TypeError("production sequential receipt chainがcanonical JSONではありません");
  }
  const entries = receiptChainEnvelopeSchema.parse(receiptRaw).entries;
  const verified = verifyReceiptChain(entries, nodeContentDigestPort);
  const finalization = verified.receipts.findLast(
    (receipt) => receipt.receiptType === "run_finalization",
  );
  const last = verified.receipts.at(-1);
  if (
    finalization?.receiptType !== "run_finalization" ||
    last?.receiptType !== "pages_deployment" ||
    last.phase !== "notification_history" ||
    (last.status !== "deployed" &&
      last.status !== "replayed_same_content" &&
      last.status !== "not_required") ||
    finalization.binding.bindingKind !== "checkpoint" ||
    finalization.binding.runId !== report.runId
  ) {
    throw new TypeError("production Pages lease解放に完了receiptがありません");
  }
  const adapter = new GitStateBranchAdapter({
    repositoryPath,
    gitExecutable: "git",
    authorName: "VOICEVOX Task Tracker",
    authorEmail: "voicevox-task-tracker@users.noreply.github.com",
  });
  const lease = await readActiveProductionPagesEffectLease(adapter);
  if (lease.runId !== report.runId || !("child" in lease.attempt) || lease.attempt.child == null) {
    throw new TypeError("production Pages leaseと完了した親runが一致しません");
  }
  const config = await loadConfig(resolve(repositoryPath, "config.yml"));
  const head = await adapter.resolveHead(config.state.branch);
  if (head.status !== "present") {
    throw new TypeError("production stateのheadがありません");
  }
  await authorizeAdvanceAfterOrthogonalCommits(
    adapter,
    config.state,
    finalization.result.resultingStateRevision,
    head.revision,
  );
  const state = await readNotificationMessageState(adapter, config.state, head.revision);
  const plan = state.transaction.record.runtimeRecoveryPlan;
  const deployment = verified.receipts.findLast(
    (receipt) => receipt.receiptType === "pages_deployment" && receipt.phase === lease.effect.phase,
  );
  if (
    state.transaction.marker.phase !== "run_finalized" ||
    state.transaction.marker.runId !== report.runId ||
    state.transaction.record.checkpointDigest !== lease.checkpointDigest ||
    plan.kind === "not_reproducible" ||
    lease.codeRevision !== plan.codeRevision ||
    deployment?.receiptType !== "pages_deployment" ||
    (deployment.status !== "deployed" && deployment.status !== "replayed_same_content") ||
    deployment.effectCertainty !== "committed" ||
    deployment.logicalTarget !== lease.effect.deploymentIntentDigest ||
    deployment.result?.sourceStateRevision !== lease.effect.sourceStateRevision ||
    deployment.result.deploymentIntentDigest !== lease.effect.deploymentIntentDigest
  ) {
    throw new TypeError("production final stateと完了receiptが一致しません");
  }
  await releaseProductionPagesEffectLease(adapter, lease, new Date());
}
