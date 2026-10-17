import type { ContentDigestPort } from "../application/tracking-run/contracts/content-digest-port.js";
import { serializeCanonicalJson } from "../canonical-json/value.js";
import type { AiAnalysisElementInputFingerprint } from "../domain/ai-analysis-elements.js";
import type {
  PersonalReminderCause,
  PersonalReminderCauseAssessment,
  PersonalReminderInputCompleteness,
} from "../domain/personal-reminder-causes.js";
import { PERSONAL_REMINDER_ASSESSMENT_RULES_VERSION } from "../domain/personal-reminder-causes.js";
import type { PersonalReminderCauseSemanticInput } from "./personal-reminder-input-contracts.js";
import {
  canonicalSemanticInput,
  createPersonalReminderCauseSemanticInput,
} from "./personal-reminder-input-core.js";

/** 個人催促原因の意味入力fingerprintを作成する。 */
export function createPersonalReminderCauseInputFingerprint(
  input: PersonalReminderCauseSemanticInput,
  digest: ContentDigestPort,
): AiAnalysisElementInputFingerprint {
  const parsed = createPersonalReminderCauseSemanticInput(input);
  return digest.sha256Utf8(serializeCanonicalJson(canonicalSemanticInput(parsed)));
}

/** 採用済みassessmentを再利用するか、causeをAI評価へ送るか決める。 */
export function planPersonalReminderCauseEvaluation(
  input: Readonly<{
    cause: PersonalReminderCause;
    currentInput: Readonly<{
      fingerprint: AiAnalysisElementInputFingerprint;
      rulesVersion: typeof PERSONAL_REMINDER_ASSESSMENT_RULES_VERSION;
      completeness: PersonalReminderInputCompleteness;
    }>;
    semanticInput: PersonalReminderCauseSemanticInput;
  }>,
  digest: ContentDigestPort,
):
  | Readonly<{ status: "reuse"; assessment: PersonalReminderCauseAssessment }>
  | Readonly<{ status: "evaluate"; input: PersonalReminderCauseSemanticInput }> {
  const semanticInput = createPersonalReminderCauseSemanticInput(input.semanticInput);
  const fingerprint = createPersonalReminderCauseInputFingerprint(semanticInput, digest);
  const adopted = input.cause.adoptedAssessment;
  if (
    input.currentInput.fingerprint === fingerprint &&
    adopted.status === "available" &&
    adopted.inputFingerprint === fingerprint &&
    adopted.rulesVersion === input.currentInput.rulesVersion
  ) {
    return Object.freeze({
      status: "reuse",
      assessment: adopted.result,
    });
  }
  return Object.freeze({
    status: "evaluate",
    input: semanticInput,
  });
}
