import {
  reconcileRetainedAiAnalysisDependency,
  type AiAnalysisDependencyReconciliationContext,
} from "../../../domain/ai-analysis-dependencies.js";
import {
  personalReminderCauseSchema,
  type PersonalReminderCause,
} from "../../../domain/personal-reminder-causes.js";

/** 保持原因の値を変えずにAI依存を最終適用元へ照合する。 */
export function reconcileRetainedPersonalReminderCause(
  cause: PersonalReminderCause,
  context: AiAnalysisDependencyReconciliationContext,
): PersonalReminderCause {
  return personalReminderCauseSchema.parse({
    ...cause,
    aiDependencies: {
      presence: reconcileRetainedAiAnalysisDependency(cause.aiDependencies.presence, context),
      responseMembership: reconcileRetainedAiAnalysisDependency(
        cause.aiDependencies.responseMembership,
        context,
      ),
      responsible: reconcileRetainedAiAnalysisDependency(cause.aiDependencies.responsible, context),
      action: reconcileRetainedAiAnalysisDependency(cause.aiDependencies.action, context),
      evidence: reconcileRetainedAiAnalysisDependency(cause.aiDependencies.evidence, context),
    },
    currentInput: {
      ...cause.currentInput,
      aiDependency: reconcileRetainedAiAnalysisDependency(cause.currentInput.aiDependency, context),
    },
  });
}
