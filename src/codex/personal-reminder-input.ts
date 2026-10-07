import { nodeContentDigestPort } from "../infrastructure/tracking-run/content-digest.js";
import type { PersonalReminderCauseSemanticInput } from "./personal-reminder-input-contracts.js";
import {
  createPersonalReminderCauseInputFingerprint as createFingerprintWithDigest,
  planPersonalReminderCauseEvaluation as planEvaluationWithDigest,
} from "./personal-reminder-input-assessment.js";
import { preparePersonalReminderAiBatch as prepareBatchWithDigest } from "./personal-reminder-input-transport.js";

export * from "./personal-reminder-input-contracts.js";
export { createPersonalReminderCauseSemanticInput } from "./personal-reminder-input-core.js";
export {
  createPersonalReminderAiInput,
  serializePersonalReminderAiInput,
} from "./personal-reminder-input-transport-validation.js";

/** 個人催促原因の意味入力fingerprintを作成する。 */
export function createPersonalReminderCauseInputFingerprint(
  input: PersonalReminderCauseSemanticInput,
): ReturnType<typeof createFingerprintWithDigest> {
  return createFingerprintWithDigest(input, nodeContentDigestPort);
}

/** 採用済みassessmentの再利用または評価を決める。 */
export function planPersonalReminderCauseEvaluation(
  input: Parameters<typeof planEvaluationWithDigest>[0],
): ReturnType<typeof planEvaluationWithDigest> {
  return planEvaluationWithDigest(input, nodeContentDigestPort);
}

/** 同じitemの原因入力を専用AI batchへまとめる。 */
export function preparePersonalReminderAiBatch(
  inputs: Parameters<typeof prepareBatchWithDigest>[0],
): ReturnType<typeof prepareBatchWithDigest> {
  return prepareBatchWithDigest(inputs, nodeContentDigestPort);
}
