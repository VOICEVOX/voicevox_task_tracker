import {
  type AiAnalysisDependency,
  type ExternalReferenceNodeId,
  type GitHubNodeId,
  type GitHubRepositoryId,
  type GraphNodeId,
  type TrackedItemState,
} from "../domain/index.js";
import {
  type ReconciledGraphEdge,
  type RelationCandidateDecisionProof,
} from "./reconcile-graph-types.js";

/** 追跡対象のIssueまたはPull Requestをグラフ解析へ渡すためのnode。 */
export type TrackedGraphAnalysisNode = Readonly<{
  kind: "issue" | "pull_request";
  nodeId: GitHubNodeId;
  repositoryId: GitHubRepositoryId;
  state: TrackedItemState;
  directNotification: "eligible";
}>;

/** 関係候補のendpointだけをグラフ解析へ渡すOrganization内node。 */
export type CandidateOnlyGraphAnalysisNode = Readonly<{
  kind: "issue" | "pull_request";
  nodeId: GitHubNodeId;
  repositoryId: GitHubRepositoryId;
  state: TrackedItemState;
  directNotification: "not_eligible";
}>;

/** Organization外の依存先をグラフ解析へ渡すための通知非対象node。 */
export type ExternalGraphAnalysisNode = Readonly<{
  kind: "external_reference";
  nodeId: ExternalReferenceNodeId;
  repositoryFullName: string;
  state: TrackedItemState;
  directNotification: "not_eligible";
}>;

/** グラフ解析で扱う追跡対象、候補endpoint、または外部参照node。 */
export type GraphAnalysisNode =
  TrackedGraphAnalysisNode | CandidateOnlyGraphAnalysisNode | ExternalGraphAnalysisNode;

/** 1回分の確定graphとnode state。 */
export type GraphAnalysisSnapshot = Readonly<{
  nodes: readonly GraphAnalysisNode[];
  edges: readonly ReconciledGraphEdge[];
}>;

/** 初回解析で比較元が存在しないことを表す値。 */
export type UnavailablePreviousGraphAnalysisSnapshot = Readonly<{
  availability: "unavailable";
}>;

/** 隣接変化を検出するための比較元snapshot。 */
export type AvailablePreviousGraphAnalysisSnapshot = Readonly<{
  availability: "available";
  snapshot: GraphAnalysisSnapshot;
}>;

/** グラフ解析へ渡す現在値と比較元。 */
export type AnalyzeGraphInput = Readonly<{
  current: GraphAnalysisSnapshot;
  previous: UnavailablePreviousGraphAnalysisSnapshot | AvailablePreviousGraphAnalysisSnapshot;
}>;

/** 関係候補の不在proofを含む現在値と比較元。 */
export type AnalyzeGraphAiDependenciesInput = AnalyzeGraphInput &
  Readonly<{
    candidateProofSnapshot: GraphAnalysisSnapshot;
    candidateDecisionProofs: readonly RelationCandidateDecisionProof[];
  }>;

/** cycle node集合から決定論的に作るID。 */
export type DependencyCycleId = `dependency-cycle:${string}`;

/** connected componentのnode集合から決定論的に作るID。 */
export type ConnectedComponentId = `connected-component:${string}`;

/** Organization内外のリポジトリを衝突なく識別する表示用キー。 */
export type GraphRepositoryKey = `organization:${string}` | `external-public:${string}`;

/** 通知理由dependency_cycleとなるblocks graphの循環成分。 */
export type DependencyCycle = Readonly<{
  id: DependencyCycleId;
  kind: "dependency_cycle";
  nodeIds: readonly [GraphNodeId, ...GraphNodeId[]];
  edges: readonly (ReconciledGraphEdge & Readonly<{ active: true }>)[];
}>;

/** nodeが直接または推移的に止めているopen nodeとリポジトリの規模。 */
export type DownstreamImpact = Readonly<{
  nodeId: GraphNodeId;
  openNodeCount: number;
  repositoryCount: number;
}>;

/** 項目のblocker集合へ寄与するAI依存。 */
export type BlockerSetAiDependency = Readonly<{
  nodeId: GraphNodeId;
  dependency: AiAnalysisDependency;
}>;

/** 実在するblocker nodeへ寄与するAI依存。 */
export type BlockerNodeAiDependency = Readonly<{
  blockedNodeId: GraphNodeId;
  blockerNodeId: GraphNodeId;
  presence: AiAnalysisDependency;
  confidence: AiAnalysisDependency;
  sourceIds: AiAnalysisDependency;
  becameBlockingAt: AiAnalysisDependency;
}>;

/** 存在しないblocker候補へ寄与するAI依存。 */
export type NegativeBlockerAiDependency = Readonly<{
  nodeId: GraphNodeId;
  dependency: AiAnalysisDependency;
}>;

/** 項目へ接続する関係集合へ寄与するAI依存。 */
export type RelationSetAiDependency = Readonly<{
  nodeId: GraphNodeId;
  dependency: AiAnalysisDependency;
}>;

/** active edgeを無向化して得る表示単位。 */
export type ConnectedComponent = Readonly<{
  id: ConnectedComponentId;
  nodeIds: readonly [GraphNodeId, ...GraphNodeId[]];
  repositoryKeys: readonly [GraphRepositoryKey, ...GraphRepositoryKey[]];
  edges: readonly (ReconciledGraphEdge & Readonly<{ active: true }>)[];
}>;

/** 隣接nodeを再分類する根拠。 */
export type ReclassificationReason = "dependency_state_changed" | "dependency_edge_changed";

/** 本文変更の有無にかかわらず状態機械へ戻す追跡対象node。 */
export type ReclassificationTarget = Readonly<{
  nodeId: GitHubNodeId;
  reasons: readonly [ReclassificationReason, ...ReclassificationReason[]];
  newlyUnblocked: boolean;
}>;

/** 通知と表示に必要な決定論的グラフ指標。 */
export type AnalyzeGraphResult = Readonly<{
  dependencyCycles: readonly DependencyCycle[];
  actionableFrontier: readonly GitHubNodeId[];
  downstreamImpacts: readonly DownstreamImpact[];
  downstreamImpactAiDependencies: readonly Readonly<{
    nodeId: GraphNodeId;
    dependency: AiAnalysisDependency;
  }>[];
  connectedComponents: readonly ConnectedComponent[];
  reclassificationTargets: readonly ReclassificationTarget[];
  newlyUnblockedNodeIds: readonly GitHubNodeId[];
}>;

/** 関係候補の不在proofを含めてAI依存を解析した結果。 */
export type AnalyzeGraphAiDependenciesResult = AnalyzeGraphResult &
  Readonly<{
    blockerSetAiDependencies: readonly BlockerSetAiDependency[];
    blockerNodeAiDependencies: readonly BlockerNodeAiDependency[];
    negativeBlockerAiDependencies: readonly NegativeBlockerAiDependency[];
    relationSetAiDependencies: readonly RelationSetAiDependency[];
  }>;
