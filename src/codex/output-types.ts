import {
  type Evidence,
  type EvidenceSupport,
  type GitHubItemUrl,
  type GitHubNodeId,
  type NotificationReasonCode,
  type SourceId,
  type Status,
  type WaitingOn,
  type WaitingOnKind,
  type WaitingOnRole,
} from "../domain/index.js";
import { type RelationAssessmentVerdict, type RelationCandidateId } from "../graph/index.js";

/** JSON Schema検証を通ったCodexのwaitingOn候補。 */
export type SchemaValidCodexWaitingOn = Readonly<{
  kind: WaitingOnKind;
  candidateId: string;
  role: WaitingOnRole;
  reasonSummary: string;
  sourceIds: readonly string[];
  confidence: number;
}>;

/** JSON Schema検証を通ったCodexの関係候補判定。 */
export type SchemaValidCodexRelation = Readonly<{
  candidateId: string;
  verdict: RelationAssessmentVerdict;
  reasonSummary: string;
  sourceIds: readonly string[];
  confidence: number;
}>;

/** JSON Schema検証を通ったCodexの根拠。 */
export type SchemaValidCodexEvidence = Readonly<{
  sourceId: string;
  supports: EvidenceSupport;
  summary: string;
}>;

/** JSON Schema検証を通ったCodexの重要度判定。 */
export type SchemaValidCodexImportance = Readonly<{
  significantFeature: boolean;
  futureRisk: boolean;
  rationale: string;
}>;

/** JSON Schema検証を通ったCodexの期限日と根拠。切迫度は決定論的に算出する。 */
export type SchemaValidCodexDeadline = Readonly<{
  date: string | null;
  rationale: string;
}>;

/** repositoryのJSON Schemaに適合したCodex出力。 */
export type SchemaValidCodexAnalysisOutput = Readonly<{
  schemaVersion: "4";
  item: Readonly<{
    nodeId: string;
    url: string;
  }>;
  status: Status;
  waitingOn: readonly SchemaValidCodexWaitingOn[];
  nextAction: string;
  relations: readonly SchemaValidCodexRelation[];
  progress: Readonly<{
    latestMeaningfulSourceId: string | null;
    reasonSummary: string;
    confidence: number;
  }>;
  importance: SchemaValidCodexImportance;
  deadline: SchemaValidCodexDeadline;
  evidence: readonly SchemaValidCodexEvidence[];
  confidence: number;
  uncertainties: readonly string[];
  notification: Readonly<{
    recommended: boolean;
    reasonCode: NotificationReasonCode;
    reasonSummary: string;
  }>;
}>;

/** semantic検証を通ったCodexの重要度判定。 */
export type ValidatedCodexImportance = Readonly<{
  significantFeature: boolean;
  futureRisk: boolean;
  rationale: string;
}>;

/** semantic検証を通ったCodexの期限日と根拠。切迫度は決定論的に算出する。 */
export type ValidatedCodexDeadline = Readonly<{
  date: string | null;
  rationale: string;
}>;

/** semantic検証を通ったCodexの関係候補判定。 */
export type ValidatedCodexRelation = Readonly<{
  candidateId: RelationCandidateId;
  verdict: RelationAssessmentVerdict;
  reasonSummary: string;
  sourceIds: readonly [SourceId, ...SourceId[]];
  confidence: number;
}>;

/** reducerへ渡せる二段階検証済みのCodex出力。 */
export type ValidatedCodexAnalysisOutput = Readonly<{
  schemaVersion: "4";
  item: Readonly<{
    nodeId: GitHubNodeId;
    url: GitHubItemUrl;
  }>;
  status: Status;
  waitingOn: readonly WaitingOn[];
  nextAction: string;
  relations: readonly ValidatedCodexRelation[];
  progress: Readonly<{
    latestMeaningfulSourceId: SourceId | null;
    reasonSummary: string;
    confidence: number;
  }>;
  importance: ValidatedCodexImportance;
  deadline: ValidatedCodexDeadline;
  evidence: readonly Evidence[];
  confidence: number;
  uncertainties: readonly string[];
  notification: Readonly<{
    recommended: boolean;
    reasonCode: NotificationReasonCode;
    reasonSummary: string;
  }>;
}>;
