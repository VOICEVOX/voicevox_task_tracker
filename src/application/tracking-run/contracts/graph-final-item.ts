import type { Attention } from "../../../domain/attention.js";
import type {
  DeadlineLevel,
  NaturalLanguageDeadlineAssessmentState,
} from "../../../domain/deadline.js";
import type { NaturalLanguageImportanceAssessmentState } from "../../../domain/importance.js";
import type { StalenessSeverityContext } from "../../../domain/staleness.js";
import type { Severity } from "../../../domain/types.js";
import type { TrackedItem } from "../../../domain/tracked-item.js";

/** 最終グラフを反映した個人催促前の項目値。 */
export type GraphFinalItem = TrackedItem &
  Readonly<{
    importanceAssessment: NaturalLanguageImportanceAssessmentState;
    deadlineAssessment: NaturalLanguageDeadlineAssessmentState;
    deadlineLevel: DeadlineLevel;
    attention: Attention;
    severity: Severity;
    severityContext: StalenessSeverityContext;
  }>;
