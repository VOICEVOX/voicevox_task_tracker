import {
  type ExternalReferenceNodeId,
  type GitHubItemUrl,
  type GitHubNodeId,
  type SourceId,
  type TrackedItemState,
} from "../domain/index.js";

/** 関係抽出で参照できる公開IssueまたはPull Request。 */
export type PublicGitHubRelationItem = Readonly<{
  nodeId: GitHubNodeId;
  repositoryOwner: string;
  repositoryName: string;
  repositoryArchived: boolean;
  repositoryDisabled: boolean;
  type: "issue" | "pull_request";
  number: number;
  url: GitHubItemUrl;
  state: TrackedItemState;
}>;

/** 関係候補の抽出対象となるMarkdown本文。 */
export type RelationTextSource = Readonly<{
  sourceId: SourceId;
  markdown: string;
}>;

/** GitHub native issue dependencyの抽出入力。 */
export type NativeDependencySource = Readonly<{
  sourceId: SourceId;
  direction: "blocked_by" | "blocking";
  relatedItem: PublicGitHubRelationItem;
}>;

/** GitHub native sub-issue階層の抽出入力。 */
export type NativeHierarchySource = Readonly<{
  sourceId: SourceId;
  relationship: "parent" | "sub_issue";
  relatedItem: PublicGitHubRelationItem;
}>;

/** GitHubがPull Requestのclosing対象として認識したIssueの抽出入力。 */
export type NativeClosingIssueSource = Readonly<{
  sourceId: SourceId;
  relatedItem: PublicGitHubRelationItem;
}>;

/** timelineのinbound cross-reference抽出入力。 */
export type CrossReferenceSource = Readonly<{
  sourceId: SourceId;
  sourceItem: PublicGitHubRelationItem;
  willCloseTarget: boolean;
}>;

/** 本文、コメント、timeline、native関係を持つ抽出対象項目。 */
export type RelationExtractionItem = PublicGitHubRelationItem &
  Readonly<{
    body: RelationTextSource;
    comments: readonly RelationTextSource[];
    crossReferences: readonly CrossReferenceSource[];
    nativeDependencies: readonly NativeDependencySource[];
    nativeHierarchy: readonly NativeHierarchySource[];
    nativeClosingIssues: readonly NativeClosingIssueSource[];
  }>;

/** 関係候補抽出に必要な現在項目と解決済み公開項目。 */
export type ExtractRelationCandidatesInput = Readonly<{
  organization: string;
  item: RelationExtractionItem;
  knownItems: readonly PublicGitHubRelationItem[];
  relationReferenceAliases: ReadonlyMap<string, PublicGitHubRelationItem>;
}>;

type RelationCandidateNodeFields = Readonly<{
  repositoryOwner: string;
  repositoryName: string;
  number: number;
  url: GitHubItemUrl;
  state: TrackedItemState;
}>;

/** 対象Organization内のIssueまたはPull Request node。 */
export type OrganizationRelationCandidateNode = RelationCandidateNodeFields &
  Readonly<{
    scope: "organization";
    kind: "issue" | "pull_request";
    nodeId: GitHubNodeId;
  }>;

/** Organization外の公開IssueまたはPull Requestを表す外部参照node。 */
export type ExternalRelationCandidateNode = RelationCandidateNodeFields &
  Readonly<{
    scope: "external_public";
    kind: "external_reference";
    nodeId: ExternalReferenceNodeId;
    githubNodeId: GitHubNodeId;
    githubItemType: "issue" | "pull_request";
  }>;

/** 関係候補が接続するOrganization内項目または外部参照。 */
export type RelationCandidateNode =
  OrganizationRelationCandidateNode | ExternalRelationCandidateNode;

/** blockerからblocked itemへ向く依存関係候補。 */
export type CandidateBlocksRelation = Readonly<{
  type: "blocks";
  blocker: RelationCandidateNode;
  blocked: RelationCandidateNode;
}>;

/** parentからsubtaskへ向く階層関係候補。 */
export type CandidateParentRelation = Readonly<{
  type: "parent_of";
  parent: RelationCandidateNode;
  subtask: RelationCandidateNode;
}>;

/** 実装項目から実装対象へ向くclosing関係候補。 */
export type CandidateImplementsRelation = Readonly<{
  type: "implements";
  implementation: RelationCandidateNode;
  target: RelationCandidateNode;
}>;

/** 意味を確定せず参照方向だけを保持する関係候補。 */
export type CandidateUnclassifiedRelation = Readonly<{
  type: "unclassified";
  referencing: RelationCandidateNode;
  referenced: RelationCandidateNode;
}>;

/** 抽出段階で表現できる関係候補の内容。 */
export type CandidateRelation =
  | CandidateBlocksRelation
  | CandidateParentRelation
  | CandidateImplementsRelation
  | CandidateUnclassifiedRelation;

/** Codexへ渡す関係候補の決定論的な識別子。 */
export type RelationCandidateId = `rel:${string}`;

type RelationCandidateFields = Readonly<{
  id: RelationCandidateId;
  sourceIds: readonly [SourceId, ...SourceId[]];
}>;

/** GitHub native情報から確定する上書き不可の関係候補。 */
export type NativeRelationCandidate = RelationCandidateFields &
  Readonly<{
    authority: "authoritative";
    provenance: "native";
    relation: CandidateBlocksRelation | CandidateParentRelation | CandidateImplementsRelation;
  }>;

/** 本文またはコメント中の参照から得る意味未確定の候補。 */
export type ExplicitTextRelationCandidate = RelationCandidateFields &
  Readonly<{
    authority: "inferred";
    provenance: "explicit_text";
    relation: CandidateUnclassifiedRelation;
  }>;

/** closing keywordから得るimplements候補。 */
export type ClosingKeywordRelationCandidate = RelationCandidateFields &
  Readonly<{
    authority: "inferred";
    provenance: "closing_keyword";
    relation: CandidateImplementsRelation;
  }>;

/** Issue本文のMarkdown checklist階層から得るparent候補。 */
export type ChecklistRelationCandidate = RelationCandidateFields &
  Readonly<{
    authority: "inferred";
    provenance: "checklist";
    relation: CandidateParentRelation;
  }>;

/** timeline cross-referenceから得る意味未確定またはimplements候補。 */
export type CrossReferenceRelationCandidate = RelationCandidateFields &
  Readonly<{
    authority: "inferred";
    provenance: "cross_reference";
    relation: CandidateUnclassifiedRelation | CandidateImplementsRelation;
  }>;

/** authoritative relationと後段で判定する推定候補を区別した抽出結果。 */
export type RelationCandidate =
  | NativeRelationCandidate
  | ExplicitTextRelationCandidate
  | ClosingKeywordRelationCandidate
  | ChecklistRelationCandidate
  | CrossReferenceRelationCandidate;
