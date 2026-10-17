import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";

import { parsePagesDeploymentIntent } from "../../application/tracking-run/pages-build-contracts.js";
import { hashCanonicalJson } from "../../canonical-json/index.js";
import { serializeCanonicalJson } from "../../canonical-json/value.js";
import { loadConfig } from "../../config/index.js";
import { readPagesHistoryRecords } from "./initial-pages-source.js";
import { readNotificationMessageState } from "./notification-message-state.js";
import { buildPagesOutput } from "./publication/pages-output.js";
import { projectPublicationSettings } from "./publication/settings.js";
import { nodeContentDigestPort } from "./content-digest.js";
import {
  parseSequentialPagesActionsPayload,
  type SequentialPagesActionsPayload,
} from "./sequential-pages-actions-contract.js";
import { writePublicDataFiles, buildWebOutput } from "../../pages/index.js";
import { GitStateBranchAdapter } from "../../persistence/git-state-branch-adapter.js";
import { assertExistingStatePublicSafety } from "../../persistence/public-safety.js";
import {
  advanceProductionPagesEffectAttempt,
  claimProductionPagesEffectLease,
  readActiveProductionPagesEffectLease,
} from "../../persistence/production-pages-effect-lease.js";
import { assertStateCommitChain } from "../../persistence/state-commit-chain-verification.js";
import { authorizeAdvanceAfterOrthogonalCommits } from "../../persistence/state-orthogonal-advance.js";

const execFileAsync = promisify(execFile);

/** childのcheckout、state、lease、Pages出力を同じintentへ照合する。 */
export async function prepareSequentialPagesEffectChild(
  repositoryPath: string,
  value: unknown,
  environment: Readonly<NodeJS.ProcessEnv>,
): Promise<SequentialPagesActionsPayload> {
  const payload = parseSequentialPagesActionsPayload(value);
  const intent = parsePagesDeploymentIntent(payload.intent, nodeContentDigestPort);
  if (
    environment["GITHUB_ACTIONS"] !== "true" ||
    environment["PAGES_WORKFLOW_SHA"] == null ||
    !/^[0-9a-f]{40}$/u.test(environment["PAGES_WORKFLOW_SHA"]) ||
    environment["GITHUB_RUN_ID"] == null ||
    !/^[1-9][0-9]*$/u.test(environment["GITHUB_RUN_ID"]) ||
    environment["GITHUB_RUN_ATTEMPT"] == null ||
    !/^[1-9][0-9]*$/u.test(environment["GITHUB_RUN_ATTEMPT"])
  ) {
    throw new TypeError("Pages childのActions実行情報がありません");
  }
  const adapter = new GitStateBranchAdapter({
    repositoryPath,
    gitExecutable: "git",
    authorName: "VOICEVOX Task Tracker",
    authorEmail: "voicevox-task-tracker@users.noreply.github.com",
  });
  if ((await adapter.resolveRepositoryRevision()) !== payload.owner.codeRevision) {
    throw new TypeError("Pages childのcheckoutが親の固定sourceと一致しません");
  }
  const workflowPath = ".github/workflows/sequential_pages_effect.yml";
  const workflowRevision = environment["PAGES_WORKFLOW_SHA"];
  const [currentWorkflow, exactWorkflow] = await Promise.all([
    execFileAsync("git", ["rev-parse", `${workflowRevision}:${workflowPath}`], {
      cwd: repositoryPath,
    }),
    execFileAsync("git", ["rev-parse", `HEAD:${workflowPath}`], { cwd: repositoryPath }),
  ]);
  if (currentWorkflow.stdout.trim() !== exactWorkflow.stdout.trim()) {
    throw new TypeError("Pages childのworkflowが固定sourceと一致しません");
  }
  const lease = await readActiveProductionPagesEffectLease(adapter);
  if (
    lease.runId !== intent.runId ||
    lease.checkpointDigest !== intent.checkpointDigest ||
    lease.parentRunId !== payload.owner.parentRunId ||
    lease.parentRunAttempt !== payload.owner.parentRunAttempt ||
    lease.codeRevision !== payload.owner.codeRevision ||
    lease.effect.phase !== intent.phase ||
    lease.effect.sourceStateRevision !== intent.sourceStateRevision ||
    lease.effect.deploymentIntentDigest !== intent.deploymentIntentDigest ||
    lease.effect.idempotencyKey !== payload.idempotencyKey ||
    lease.attempt.key !== payload.attemptKey ||
    lease.attempt.sequence !== payload.attemptSequence ||
    lease.attempt.status !== "dispatch_started"
  ) {
    throw new TypeError("Pages childの入力とproduction leaseが一致しません");
  }
  const config = await loadConfig(resolve(repositoryPath, "config.yml"));
  if (config.state.branch !== "tracker-state") {
    throw new TypeError("Pages childの設定がproduction stateではありません");
  }
  const head = await adapter.resolveHead(config.state.branch);
  if (head.status !== "present") {
    throw new TypeError("Pages childのremote stateがありません");
  }
  await authorizeAdvanceAfterOrthogonalCommits(
    adapter,
    config.state,
    intent.sourceStateRevision,
    head.revision,
  );
  const state = await readNotificationMessageState(
    adapter,
    config.state,
    intent.sourceStateRevision,
  );
  const { marker, record } = state.transaction;
  const initialRevision =
    marker.phase === "initial_state_committed"
      ? intent.sourceStateRevision
      : marker.initialStateRevision;
  if (
    record.executionPolicy.effectTarget !== "production" ||
    record.executionPolicy.executionShape !== "sequential" ||
    marker.runId !== intent.runId ||
    marker.checkpointDigest !== intent.checkpointDigest ||
    record.recordDigest !== intent.recordDigest ||
    (intent.phase === "initial" && marker.phase !== "initial_state_committed") ||
    (intent.phase === "notification_history" && marker.phase !== "run_finalized") ||
    hashCanonicalJson(state.snapshot) !== intent.snapshotDigest ||
    record.initialPagesProjection.repositoryAllowlistDigest !== intent.repositoryAllowlistDigest ||
    record.initialPagesProjection.settings.url !== intent.expectedPageUrl ||
    serializeCanonicalJson(projectPublicationSettings(config).pages) !==
      serializeCanonicalJson(record.initialPagesProjection.settings)
  ) {
    throw new TypeError("Pages childのstateと公開intentが一致しません");
  }
  await assertStateCommitChain(
    adapter,
    config.state,
    intent.sourceStateRevision,
    state.transaction,
    initialRevision,
  );
  const historyRecords = readPagesHistoryRecords(state.files, config.state.historyDirectory);
  assertExistingStatePublicSafety(
    state.snapshot,
    historyRecords,
    state.ledger,
    [marker, record, state.transaction.initialPagesEvidence],
    [],
  );
  const output = await buildPagesOutput({
    phase: intent.phase,
    config,
    record,
    snapshot: state.snapshot,
    historyRecords,
    repositoryPath,
    outputDirectory: resolve(repositoryPath, "web/public/data"),
    knownSecrets: [],
    writePublicData: writePublicDataFiles,
    buildWebOutput,
  });
  const currentHead = await adapter.resolveHead(config.state.branch);
  if (
    output.outputManifestDigest !== intent.outputManifestDigest ||
    output.pagesContentDigest !== intent.pagesContentDigest ||
    currentHead.status !== "present" ||
    currentHead.revision !== head.revision
  ) {
    throw new TypeError("Pages childの出力またはremote stateが固定intentから変わりました");
  }
  await claimProductionPagesEffectLease(
    adapter,
    lease,
    environment["GITHUB_RUN_ID"],
    Number(environment["GITHUB_RUN_ATTEMPT"]),
    new Date(),
  );
  return payload;
}

/** deploy actionの直前に同じchildの効果開始をCASで記録する。 */
export async function beginSequentialPagesEffectChild(
  repositoryPath: string,
  value: unknown,
  environment: Readonly<NodeJS.ProcessEnv>,
): Promise<void> {
  const payload = parseSequentialPagesActionsPayload(value);
  const adapter = new GitStateBranchAdapter({
    repositoryPath,
    gitExecutable: "git",
    authorName: "VOICEVOX Task Tracker",
    authorEmail: "voicevox-task-tracker@users.noreply.github.com",
  });
  const lease = await readActiveProductionPagesEffectLease(adapter);
  if (
    environment["GITHUB_ACTIONS"] !== "true" ||
    lease.attempt.status !== "child_bound" ||
    lease.attempt.child.childRunId !== environment["GITHUB_RUN_ID"] ||
    lease.attempt.child.childRunAttempt.toString() !== environment["GITHUB_RUN_ATTEMPT"] ||
    lease.attempt.key !== payload.attemptKey ||
    lease.effect.idempotencyKey !== payload.idempotencyKey ||
    lease.parentRunId !== payload.owner.parentRunId ||
    lease.parentRunAttempt !== payload.owner.parentRunAttempt ||
    lease.codeRevision !== payload.owner.codeRevision ||
    (await adapter.resolveRepositoryRevision()) !== lease.codeRevision
  ) {
    throw new TypeError("Pages deploy直前のchild claimが一致しません");
  }
  await advanceProductionPagesEffectAttempt(
    adapter,
    lease,
    { ...lease.attempt, status: "effect_started" },
    new Date(),
  );
}
