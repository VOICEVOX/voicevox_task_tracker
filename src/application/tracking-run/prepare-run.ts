import type { Config } from "../../config/schema.js";
import { parseSha256Hash, type Sha256Hash } from "../../canonical-json/sha256.js";
import { createPreparedStageProof } from "./contracts/proofs.js";
import type { PreparedBaseState, StageState } from "./contracts/run-core.js";
import { createInitialAiBudgetLedger } from "./contracts/ai-budget-ledger.js";
import {
  runIdentitySchema,
  runRequestSchema,
  type RunIdentity,
  type RunRequest,
} from "./request.js";

/** 前処理が確定した後段共通のrun状態。 */
export type PreparedRun = StageState<"prepared", { request: RunRequest }>;

/** 検証済み設定と同一revisionの前回stateからrunを準備する。 */
export function prepareRun(
  input: Readonly<{
    request: RunRequest;
    identity: RunIdentity;
    config: Config;
    configDigest: Sha256Hash;
    baseState: PreparedBaseState;
  }>,
): PreparedRun {
  const request = runRequestSchema.parse(input.request);
  const identity = runIdentitySchema.parse(input.identity);
  parseSha256Hash(input.configDigest);
  if (
    request.invocationId !== identity.invocationId ||
    request.scheduledFor !== identity.scheduledFor ||
    request.startedAt !== identity.startedAt
  ) {
    throw new TypeError("run要求と識別情報が一致しません");
  }
  if (
    input.baseState.revision.status === "missing" &&
    (input.baseState.snapshot.status !== "missing_branch" ||
      input.baseState.history.length !== 0 ||
      input.baseState.aiCache.length !== 0 ||
      input.baseState.personalReminderAiCache.length !== 0)
  ) {
    throw new TypeError("未作成state branchの前回stateが空ではありません");
  }
  return Object.freeze({
    stage: "prepared",
    core: Object.freeze({
      identity,
      executionPolicy: request.executionPolicy,
      config: input.config,
      configDigest: input.configDigest,
      baseState: input.baseState,
      aiBudget: createInitialAiBudgetLedger(identity.runId, input.config.ai.budget),
    }),
    data: Object.freeze({ request }),
    proof: createPreparedStageProof(),
  });
}
