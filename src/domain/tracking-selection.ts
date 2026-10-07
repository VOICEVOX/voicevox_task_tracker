import { assertNonNullable, UnreachableError } from "../util/index.js";
import { type SourceId } from "./source-id.js";
import { type RetentionItemState } from "./tracking-lifecycle.js";
import {
  type ExternalReferenceNodeId,
  type GitHubItemUrl,
  type GitHubNodeId,
  type GraphNodeId,
  type RelationType,
  type TrackedItemState,
  type TrackingNotificationClass,
  type UtcIsoDateTime,
} from "./types.js";

/** T12が算出した活動時刻のうち追跡開始判定に使う値。 */
export type TrackingActivity = Readonly<{
  lastHumanActivityAt: UtcIsoDateTime;
  lastProgressAt: UtcIsoDateTime;
}>;

type TrackingItemReferenceFields = Readonly<{
  repositoryFullName: string;
  number: number;
  url: GitHubItemUrl;
  title: string;
}>;

/** Organization内で追跡候補となる公開IssueまたはPull Request。 */
export type OrganizationTrackingCandidate = TrackingItemReferenceFields &
  RetentionItemState &
  Readonly<{
    scope: "organization";
    nodeId: GitHubNodeId;
    createdAt: UtcIsoDateTime;
    activity: TrackingActivity;
    authorType: "human" | "bot" | "unknown";
    notificationClass: TrackingNotificationClass;
  }>;

/** Organization外にある公開IssueまたはPull Requestの最小参照情報。 */
export type ExternalPublicTrackingCandidate = TrackingItemReferenceFields &
  Readonly<{
    scope: "external_public";
    nodeId: ExternalReferenceNodeId;
    state: TrackedItemState;
  }>;

/** 追跡選定へ渡すOrganization内項目または外部public項目。 */
export type TrackingCandidate = OrganizationTrackingCandidate | ExternalPublicTrackingCandidate;

/** reference関係が表すグラフ上の関係。 */
export type TrackingReferenceRelation =
  | Readonly<{
      type: "blocks";
      blockerNodeId: GraphNodeId;
      blockedNodeId: GraphNodeId;
    }>
  | Readonly<{
      type: "non_blocking";
      relationType: Exclude<RelationType, "blocks">;
    }>;

/** 一方の項目がもう一方を参照した関係。 */
export type TrackingReferenceConnection = Readonly<{
  kind: "reference";
  sourceId: SourceId;
  referencingNodeId: GraphNodeId;
  referencedNodeId: GraphNodeId;
  relation: TrackingReferenceRelation;
}>;

/** GitHub native dependencyによる接続。 */
export type TrackingNativeDependencyConnection = Readonly<{
  kind: "native_dependency";
  sourceId: SourceId;
  blockerNodeId: GraphNodeId;
  blockedNodeId: GraphNodeId;
}>;

/** GitHub native sub-issueによる接続。 */
export type TrackingNativeSubIssueConnection = Readonly<{
  kind: "native_sub_issue";
  sourceId: SourceId;
  parentNodeId: GraphNodeId;
  subIssueNodeId: GraphNodeId;
}>;

/** 追跡選定に使う参照、native dependency、native sub-issueの接続。 */
export type TrackingConnection =
  | TrackingReferenceConnection
  | TrackingNativeDependencyConnection
  | TrackingNativeSubIssueConnection;

/** 自動追跡の有効化とnative関係を辿る深度。 */
export type TrackingAutoIncludeSettings = Readonly<{
  createdAfterStart: boolean;
  changedAfterStart: boolean;
  referencedByTracked: boolean;
  referencesTracked: boolean;
  nativeRelations: boolean;
  relationDepth: number;
}>;

/** backfillを再開する決定論的な位置。 */
export type TrackingBackfillCursor =
  | Readonly<{
      status: "start";
    }>
  | Readonly<{
      status: "after";
      repositoryFullName: string;
      number: number;
      nodeId: GitHubNodeId;
    }>;

/** workflow_dispatchから渡すbackfill mode、repository filter、再開位置。 */
export type TrackingBackfillRequest =
  | Readonly<{
      mode: "none";
    }>
  | Readonly<{
      mode: "linked" | "all-open";
      repositoryFilter: readonly string[];
      cursor: TrackingBackfillCursor;
    }>;

/** 追跡対象を選定する入力。 */
export type SelectTrackingItemsInput = Readonly<{
  startAt: UtcIsoDateTime;
  evaluatedAt: UtcIsoDateTime;
  candidates: readonly TrackingCandidate[];
  connections: readonly TrackingConnection[];
  previouslyTrackedNodeIds: readonly GitHubNodeId[];
  explicitIncludes: readonly string[];
  autoInclude: TrackingAutoIncludeSettings;
  backfill: TrackingBackfillRequest;
  maxBackfillItemsPerRun: number;
}>;

/** 項目を追跡へ含めた根拠。 */
export type TrackingInclusionReason =
  | Readonly<{
      kind: "previously_tracked";
    }>
  | Readonly<{
      kind: "created_after_start";
    }>
  | Readonly<{
      kind: "changed_after_start";
    }>
  | Readonly<{
      kind: "referenced_by_tracked";
      trackedNodeId: GitHubNodeId;
      sourceId: SourceId;
    }>
  | Readonly<{
      kind: "references_tracked";
      trackedNodeId: GitHubNodeId;
      sourceId: SourceId;
    }>
  | Readonly<{
      kind: "native_relation";
      connectionKind: "native_dependency" | "native_sub_issue";
      depth: number;
      connectedFromNodeId: GitHubNodeId;
      sourceId: SourceId;
    }>
  | Readonly<{
      kind: "explicit_include";
      identifier: string;
    }>
  | Readonly<{
      kind: "backfill";
      mode: "linked" | "all-open";
    }>;

/** 追跡対象として選ばれたOrganization内項目と根拠。 */
export type SelectedTrackingItem = Readonly<{
  item: OrganizationTrackingCandidate;
  reasons: readonly [TrackingInclusionReason, ...TrackingInclusionReason[]];
}>;

/** backfillを行わなかった結果。 */
export type TrackingBackfillNotRequested = Readonly<{
  mode: "none";
  status: "not_requested";
  addedNodeIds: readonly GitHubNodeId[];
}>;

type TrackingBackfillRunFields = Readonly<{
  mode: "linked" | "all-open";
  eligibleItemCount: number;
  addedNodeIds: readonly GitHubNodeId[];
  processedThrough: TrackingBackfillCursor;
  remainingItemCount: number;
}>;

/** backfill候補をすべて処理した結果。 */
export type TrackingBackfillComplete = TrackingBackfillRunFields &
  Readonly<{
    status: "complete";
  }>;

/** backfill上限で中断し、次回の再開位置を残した結果。 */
export type TrackingBackfillLimitReached = TrackingBackfillRunFields &
  Readonly<{
    status: "limit_reached";
    processedThrough: Extract<TrackingBackfillCursor, { status: "after" }>;
  }>;

/** backfillの追加件数と再開位置。 */
export type TrackingBackfillProgress =
  TrackingBackfillNotRequested | TrackingBackfillComplete | TrackingBackfillLimitReached;

/** Organization外のpublic blockerを説明する通知非対象node。 */
export type ExternalGhostNode = Readonly<{
  kind: "external_reference";
  nodeId: ExternalReferenceNodeId;
  repositoryFullName: string;
  number: number;
  url: GitHubItemUrl;
  title: string;
  state: TrackedItemState;
  recursiveTracking: "not_allowed";
  directNotification: "not_eligible";
}>;

/** 追跡対象、今回の追加、外部ghost、backfill進捗をまとめた選定結果。 */
export type TrackingSelectionResult = Readonly<{
  trackedItems: readonly SelectedTrackingItem[];
  newlyTrackedItems: readonly SelectedTrackingItem[];
  ghostNodes: readonly ExternalGhostNode[];
  backfill: TrackingBackfillProgress;
}>;

interface SelectionDraft {
  item: OrganizationTrackingCandidate;
  reasons: TrackingInclusionReason[];
}

type NativeNeighbor = Readonly<{
  nodeId: GraphNodeId;
  connectionKind: "native_dependency" | "native_sub_issue";
  sourceId: SourceId;
}>;

const INCLUSION_REASON_ORDER = Object.freeze([
  "previously_tracked",
  "created_after_start",
  "changed_after_start",
  "explicit_include",
  "referenced_by_tracked",
  "references_tracked",
  "native_relation",
  "backfill",
] satisfies readonly TrackingInclusionReason["kind"][]);

function parseTimestamp(value: UtcIsoDateTime, context: string): number {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new TypeError(`${context}は有効な日時ではありません`);
  }
  return timestamp;
}

function validateRepositoryFullName(value: string, context: string): void {
  if (!/^[^/\s]+\/[^/\s]+$/u.test(value)) {
    throw new TypeError(`${context}はowner/repository形式にしてください`);
  }
}

function validateReferenceFields(candidate: TrackingCandidate, context: string): void {
  validateRepositoryFullName(candidate.repositoryFullName, `${context}のrepository full name`);
  if (!Number.isSafeInteger(candidate.number) || candidate.number <= 0) {
    throw new RangeError(`${context}の項目番号は正の安全な整数にしてください`);
  }
  if (candidate.title.length === 0) {
    throw new TypeError(`${context}のtitleは空にできません`);
  }
  if (!candidate.url.startsWith("https://github.com/")) {
    throw new TypeError(`${context}のURLはGitHubのHTTPS URLにしてください`);
  }
}

function validateOrganizationCandidate(
  candidate: OrganizationTrackingCandidate,
  evaluatedAt: number,
): void {
  const createdAt = parseTimestamp(candidate.createdAt, `${candidate.nodeId}の作成時刻`);
  if (createdAt > evaluatedAt) {
    throw new RangeError(`${candidate.nodeId}の作成時刻は判定時刻以前にしてください`);
  }
  const lastHumanActivityAt = parseTimestamp(
    candidate.activity.lastHumanActivityAt,
    `${candidate.nodeId}の最終human活動時刻`,
  );
  const lastProgressAt = parseTimestamp(
    candidate.activity.lastProgressAt,
    `${candidate.nodeId}の最終進捗時刻`,
  );
  if (
    lastHumanActivityAt < createdAt ||
    lastHumanActivityAt > evaluatedAt ||
    lastProgressAt < createdAt ||
    lastProgressAt > evaluatedAt
  ) {
    throw new RangeError(
      `${candidate.nodeId}の活動時刻は作成時刻以後かつ判定時刻以前にしてください`,
    );
  }
  if (candidate.state !== "open") {
    const terminalAt = parseTimestamp(
      candidate.terminalAt,
      `${candidate.nodeId}のterminal遷移時刻`,
    );
    if (terminalAt < createdAt || terminalAt > evaluatedAt) {
      throw new RangeError(
        `${candidate.nodeId}のterminal遷移時刻は作成時刻以後かつ判定時刻以前にしてください`,
      );
    }
  }
}

function validateCursor(cursor: TrackingBackfillCursor): void {
  if (cursor.status === "start") {
    return;
  }
  validateRepositoryFullName(cursor.repositoryFullName, "backfill cursorのrepository full name");
  if (!Number.isSafeInteger(cursor.number) || cursor.number <= 0) {
    throw new RangeError("backfill cursorの項目番号は正の安全な整数にしてください");
  }
}

function connectionNodeIds(connection: TrackingConnection): readonly [GraphNodeId, GraphNodeId] {
  switch (connection.kind) {
    case "reference":
      return [connection.referencingNodeId, connection.referencedNodeId];
    case "native_dependency":
      return [connection.blockerNodeId, connection.blockedNodeId];
    case "native_sub_issue":
      return [connection.parentNodeId, connection.subIssueNodeId];
    default:
      throw new UnreachableError(connection);
  }
}

function sameNodePair(
  firstLeft: GraphNodeId,
  firstRight: GraphNodeId,
  secondLeft: GraphNodeId,
  secondRight: GraphNodeId,
): boolean {
  return (
    (firstLeft === secondLeft && firstRight === secondRight) ||
    (firstLeft === secondRight && firstRight === secondLeft)
  );
}

function validateConnections(
  connections: readonly TrackingConnection[],
  candidatesByNodeId: ReadonlyMap<GraphNodeId, TrackingCandidate>,
): void {
  for (const connection of connections) {
    const [leftNodeId, rightNodeId] = connectionNodeIds(connection);
    if (leftNodeId === rightNodeId) {
      throw new TypeError(`追跡接続は異なる2項目を結んでください。対象: ${connection.sourceId}`);
    }
    if (!candidatesByNodeId.has(leftNodeId) || !candidatesByNodeId.has(rightNodeId)) {
      throw new TypeError(
        `追跡接続が候補にないnode IDを参照しています。対象: ${connection.sourceId}`,
      );
    }
    if (
      connection.kind === "reference" &&
      connection.relation.type === "blocks" &&
      !sameNodePair(
        connection.referencingNodeId,
        connection.referencedNodeId,
        connection.relation.blockerNodeId,
        connection.relation.blockedNodeId,
      )
    ) {
      throw new TypeError(
        `referenceのblocks関係が参照元と参照先以外を指しています。対象: ${connection.sourceId}`,
      );
    }
  }
}

function validateUniqueStrings(values: readonly string[], context: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (value.length === 0) {
      throw new TypeError(`${context}は空にできません`);
    }
    if (seen.has(value)) {
      throw new TypeError(`${context}が重複しています。対象: ${value}`);
    }
    seen.add(value);
  }
}

function validateInput(
  input: SelectTrackingItemsInput,
): ReadonlyMap<GraphNodeId, TrackingCandidate> {
  parseTimestamp(input.startAt, "tracking.startAt");
  const evaluatedAt = parseTimestamp(input.evaluatedAt, "追跡選定時刻");
  if (
    !Number.isSafeInteger(input.autoInclude.relationDepth) ||
    input.autoInclude.relationDepth < 0
  ) {
    throw new RangeError("native relationの追跡深度は0以上の安全な整数にしてください");
  }
  if (!Number.isSafeInteger(input.maxBackfillItemsPerRun) || input.maxBackfillItemsPerRun <= 0) {
    throw new RangeError("1 runのbackfill上限は正の安全な整数にしてください");
  }
  const candidatesByNodeId = new Map<GraphNodeId, TrackingCandidate>();
  const candidateNodeIdsByUrl = new Map<GitHubItemUrl, GraphNodeId>();
  for (const candidate of input.candidates) {
    validateReferenceFields(candidate, `候補 ${candidate.nodeId}`);
    if (candidatesByNodeId.has(candidate.nodeId)) {
      throw new TypeError(`追跡候補のnode IDが重複しています。対象: ${candidate.nodeId}`);
    }
    if (candidateNodeIdsByUrl.has(candidate.url)) {
      throw new TypeError(`追跡候補のURLが重複しています。対象: ${candidate.url}`);
    }
    if (candidate.scope === "organization") {
      validateOrganizationCandidate(candidate, evaluatedAt);
    }
    candidatesByNodeId.set(candidate.nodeId, candidate);
    candidateNodeIdsByUrl.set(candidate.url, candidate.nodeId);
  }

  validateUniqueStrings(input.previouslyTrackedNodeIds, "既存追跡項目のnode ID");
  validateUniqueStrings(input.explicitIncludes, "明示include");
  for (const nodeId of input.previouslyTrackedNodeIds) {
    const candidate = candidatesByNodeId.get(nodeId);
    if (candidate?.scope !== "organization") {
      throw new TypeError(`既存追跡項目がOrganization内候補にありません。対象: ${nodeId}`);
    }
  }
  if (input.backfill.mode !== "none") {
    validateUniqueStrings(input.backfill.repositoryFilter, "backfill repository filter");
    for (const repositoryFullName of input.backfill.repositoryFilter) {
      validateRepositoryFullName(repositoryFullName, "backfill repository filter");
    }
    validateCursor(input.backfill.cursor);
  }
  validateConnections(input.connections, candidatesByNodeId);
  return candidatesByNodeId;
}

function getOrganizationCandidate(
  candidatesByNodeId: ReadonlyMap<GraphNodeId, TrackingCandidate>,
  nodeId: GraphNodeId,
): OrganizationTrackingCandidate | undefined {
  const candidate = candidatesByNodeId.get(nodeId);
  return candidate?.scope === "organization" ? candidate : undefined;
}

function addInclusionReason(
  selectedByNodeId: Map<GitHubNodeId, SelectionDraft>,
  candidate: OrganizationTrackingCandidate,
  reason: TrackingInclusionReason,
): void {
  const selected = selectedByNodeId.get(candidate.nodeId);
  if (selected == null) {
    selectedByNodeId.set(candidate.nodeId, {
      item: candidate,
      reasons: [reason],
    });
    return;
  }
  selected.reasons.push(reason);
}

function isOpen(candidate: OrganizationTrackingCandidate): boolean {
  return candidate.state === "open";
}

function hasChangeAfterStart(
  candidate: OrganizationTrackingCandidate,
  startAt: UtcIsoDateTime,
): boolean {
  return (
    candidate.activity.lastHumanActivityAt > startAt || candidate.activity.lastProgressAt > startAt
  );
}

function includeAutomaticCandidates(
  input: SelectTrackingItemsInput,
  selectedByNodeId: Map<GitHubNodeId, SelectionDraft>,
): void {
  for (const candidate of input.candidates) {
    if (candidate.scope !== "organization" || !isOpen(candidate)) {
      continue;
    }
    if (input.autoInclude.createdAfterStart && candidate.createdAt >= input.startAt) {
      addInclusionReason(
        selectedByNodeId,
        candidate,
        Object.freeze({
          kind: "created_after_start",
        }),
      );
    }
    if (input.autoInclude.changedAfterStart && hasChangeAfterStart(candidate, input.startAt)) {
      addInclusionReason(
        selectedByNodeId,
        candidate,
        Object.freeze({
          kind: "changed_after_start",
        }),
      );
    }
  }
}

function includeExplicitCandidates(
  input: SelectTrackingItemsInput,
  candidatesByNodeId: ReadonlyMap<GraphNodeId, TrackingCandidate>,
  selectedByNodeId: Map<GitHubNodeId, SelectionDraft>,
): void {
  for (const identifier of input.explicitIncludes) {
    const candidate = input.candidates.find(
      (value) => value.nodeId === identifier || value.url === identifier,
    );
    if (candidate == null) {
      throw new TypeError(`明示includeを追跡候補へ解決できません。対象: ${identifier}`);
    }
    const organizationCandidate = getOrganizationCandidate(candidatesByNodeId, candidate.nodeId);
    if (organizationCandidate == null) {
      throw new TypeError(`Organization外の項目は明示追跡できません。対象: ${identifier}`);
    }
    addInclusionReason(
      selectedByNodeId,
      organizationCandidate,
      Object.freeze({
        kind: "explicit_include",
        identifier,
      }),
    );
  }
}

function includeReferencedCandidates(
  input: SelectTrackingItemsInput,
  candidatesByNodeId: ReadonlyMap<GraphNodeId, TrackingCandidate>,
  selectedByNodeId: Map<GitHubNodeId, SelectionDraft>,
): void {
  const referenceRoots = new Set<GitHubNodeId>(selectedByNodeId.keys());
  for (const connection of input.connections) {
    if (connection.kind !== "reference") {
      continue;
    }
    const referencingCandidate = getOrganizationCandidate(
      candidatesByNodeId,
      connection.referencingNodeId,
    );
    const referencedCandidate = getOrganizationCandidate(
      candidatesByNodeId,
      connection.referencedNodeId,
    );
    if (
      input.autoInclude.referencedByTracked &&
      referencingCandidate != null &&
      referenceRoots.has(referencingCandidate.nodeId)
    ) {
      if (referencedCandidate != null) {
        addInclusionReason(
          selectedByNodeId,
          referencedCandidate,
          Object.freeze({
            kind: "referenced_by_tracked",
            trackedNodeId: referencingCandidate.nodeId,
            sourceId: connection.sourceId,
          }),
        );
      }
    }
    if (
      input.autoInclude.referencesTracked &&
      referencedCandidate != null &&
      referenceRoots.has(referencedCandidate.nodeId)
    ) {
      if (referencingCandidate != null) {
        addInclusionReason(
          selectedByNodeId,
          referencingCandidate,
          Object.freeze({
            kind: "references_tracked",
            trackedNodeId: referencedCandidate.nodeId,
            sourceId: connection.sourceId,
          }),
        );
      }
    }
  }
}

function addNativeNeighbor(
  adjacency: Map<GraphNodeId, NativeNeighbor[]>,
  fromNodeId: GraphNodeId,
  neighbor: NativeNeighbor,
): void {
  const current = adjacency.get(fromNodeId);
  if (current == null) {
    adjacency.set(fromNodeId, [neighbor]);
    return;
  }
  current.push(neighbor);
}

function createNativeAdjacency(
  connections: readonly TrackingConnection[],
): ReadonlyMap<GraphNodeId, readonly NativeNeighbor[]> {
  const adjacency = new Map<GraphNodeId, NativeNeighbor[]>();
  for (const connection of connections) {
    if (connection.kind === "reference") {
      continue;
    }
    const [leftNodeId, rightNodeId] = connectionNodeIds(connection);
    const leftNeighbor = Object.freeze({
      nodeId: rightNodeId,
      connectionKind: connection.kind,
      sourceId: connection.sourceId,
    } satisfies NativeNeighbor);
    const rightNeighbor = Object.freeze({
      nodeId: leftNodeId,
      connectionKind: connection.kind,
      sourceId: connection.sourceId,
    } satisfies NativeNeighbor);
    addNativeNeighbor(adjacency, leftNodeId, leftNeighbor);
    addNativeNeighbor(adjacency, rightNodeId, rightNeighbor);
  }
  for (const neighbors of adjacency.values()) {
    neighbors.sort((left, right) => {
      if (left.nodeId !== right.nodeId) {
        return left.nodeId < right.nodeId ? -1 : 1;
      }
      if (left.sourceId !== right.sourceId) {
        return left.sourceId < right.sourceId ? -1 : 1;
      }
      return 0;
    });
  }
  return adjacency;
}

function includeNativeRelations(
  input: SelectTrackingItemsInput,
  candidatesByNodeId: ReadonlyMap<GraphNodeId, TrackingCandidate>,
  selectedByNodeId: Map<GitHubNodeId, SelectionDraft>,
): void {
  if (!input.autoInclude.nativeRelations || input.autoInclude.relationDepth === 0) {
    return;
  }
  const adjacency = createNativeAdjacency(input.connections);
  const roots = [...selectedByNodeId.keys()].sort();
  const queue: { nodeId: GitHubNodeId; depth: number }[] = roots.map((nodeId) => ({
    nodeId,
    depth: 0,
  }));
  const minimumDepthByNodeId = new Map<GitHubNodeId, number>(roots.map((nodeId) => [nodeId, 0]));
  let queueIndex = 0;

  while (queueIndex < queue.length) {
    const current = queue[queueIndex];
    assertNonNullable(current, "native relation探索queueの現在要素がありません");
    queueIndex += 1;
    if (current.depth >= input.autoInclude.relationDepth) {
      continue;
    }
    for (const neighbor of adjacency.get(current.nodeId) ?? []) {
      const candidate = getOrganizationCandidate(candidatesByNodeId, neighbor.nodeId);
      if (candidate == null) {
        continue;
      }
      const nextDepth = current.depth + 1;
      const knownDepth = minimumDepthByNodeId.get(candidate.nodeId);
      if (knownDepth != null && knownDepth <= nextDepth) {
        continue;
      }
      minimumDepthByNodeId.set(candidate.nodeId, nextDepth);
      addInclusionReason(
        selectedByNodeId,
        candidate,
        Object.freeze({
          kind: "native_relation",
          connectionKind: neighbor.connectionKind,
          depth: nextDepth,
          connectedFromNodeId: current.nodeId,
          sourceId: neighbor.sourceId,
        }),
      );
      queue.push({
        nodeId: candidate.nodeId,
        depth: nextDepth,
      });
    }
  }
}

function compareCandidates(
  left: OrganizationTrackingCandidate,
  right: OrganizationTrackingCandidate,
): -1 | 0 | 1 {
  if (left.repositoryFullName !== right.repositoryFullName) {
    return left.repositoryFullName < right.repositoryFullName ? -1 : 1;
  }
  if (left.number !== right.number) {
    return left.number < right.number ? -1 : 1;
  }
  if (left.nodeId !== right.nodeId) {
    return left.nodeId < right.nodeId ? -1 : 1;
  }
  return 0;
}

function compareCandidateAndCursor(
  candidate: OrganizationTrackingCandidate,
  cursor: Extract<TrackingBackfillCursor, { status: "after" }>,
): -1 | 0 | 1 {
  if (candidate.repositoryFullName !== cursor.repositoryFullName) {
    return candidate.repositoryFullName < cursor.repositoryFullName ? -1 : 1;
  }
  if (candidate.number !== cursor.number) {
    return candidate.number < cursor.number ? -1 : 1;
  }
  if (candidate.nodeId !== cursor.nodeId) {
    return candidate.nodeId < cursor.nodeId ? -1 : 1;
  }
  return 0;
}

function createCursor(candidate: OrganizationTrackingCandidate): TrackingBackfillCursor {
  return Object.freeze({
    status: "after",
    repositoryFullName: candidate.repositoryFullName,
    number: candidate.number,
    nodeId: candidate.nodeId,
  });
}

function isRepositoryAllowed(
  candidate: OrganizationTrackingCandidate,
  repositoryFilter: ReadonlySet<string>,
): boolean {
  return repositoryFilter.size === 0 || repositoryFilter.has(candidate.repositoryFullName);
}

function findLinkedBackfillCandidates(
  input: SelectTrackingItemsInput,
  candidatesByNodeId: ReadonlyMap<GraphNodeId, TrackingCandidate>,
  selectedByNodeId: ReadonlyMap<GitHubNodeId, SelectionDraft>,
): readonly OrganizationTrackingCandidate[] {
  const linkedByNodeId = new Map<GitHubNodeId, OrganizationTrackingCandidate>();
  for (const connection of input.connections) {
    const [leftNodeId, rightNodeId] = connectionNodeIds(connection);
    const leftCandidate = getOrganizationCandidate(candidatesByNodeId, leftNodeId);
    const rightCandidate = getOrganizationCandidate(candidatesByNodeId, rightNodeId);
    const leftSelected = leftCandidate != null && selectedByNodeId.has(leftCandidate.nodeId);
    const rightSelected = rightCandidate != null && selectedByNodeId.has(rightCandidate.nodeId);
    if (leftSelected && !rightSelected) {
      if (rightCandidate != null) {
        linkedByNodeId.set(rightCandidate.nodeId, rightCandidate);
      }
    }
    if (rightSelected && !leftSelected) {
      if (leftCandidate != null) {
        linkedByNodeId.set(leftCandidate.nodeId, leftCandidate);
      }
    }
  }
  return Object.freeze([...linkedByNodeId.values()]);
}

function performBackfill(
  input: SelectTrackingItemsInput,
  candidatesByNodeId: ReadonlyMap<GraphNodeId, TrackingCandidate>,
  selectedByNodeId: Map<GitHubNodeId, SelectionDraft>,
): TrackingBackfillProgress {
  if (input.backfill.mode === "none") {
    return Object.freeze({
      mode: "none",
      status: "not_requested",
      addedNodeIds: Object.freeze([]),
    });
  }

  const backfill = input.backfill;
  const repositoryFilter = new Set(backfill.repositoryFilter);
  const candidates =
    backfill.mode === "linked"
      ? findLinkedBackfillCandidates(input, candidatesByNodeId, selectedByNodeId)
      : input.candidates.filter(
          (candidate): candidate is OrganizationTrackingCandidate =>
            candidate.scope === "organization" && isOpen(candidate),
        );
  const eligibleCandidates = candidates
    .filter(
      (candidate) =>
        !selectedByNodeId.has(candidate.nodeId) &&
        isRepositoryAllowed(candidate, repositoryFilter) &&
        (backfill.cursor.status === "start" ||
          compareCandidateAndCursor(candidate, backfill.cursor) > 0),
    )
    .sort(compareCandidates);
  const additions = eligibleCandidates.slice(0, input.maxBackfillItemsPerRun);
  for (const candidate of additions) {
    addInclusionReason(
      selectedByNodeId,
      candidate,
      Object.freeze({
        kind: "backfill",
        mode: backfill.mode,
      }),
    );
  }

  const lastAddition = additions.at(-1);
  const processedThrough = lastAddition == null ? backfill.cursor : createCursor(lastAddition);
  const remainingItemCount = eligibleCandidates.length - additions.length;
  const fields = {
    mode: backfill.mode,
    eligibleItemCount: eligibleCandidates.length,
    addedNodeIds: Object.freeze(additions.map((candidate) => candidate.nodeId)),
    processedThrough,
    remainingItemCount,
  };
  if (remainingItemCount === 0) {
    return Object.freeze({
      ...fields,
      status: "complete",
    });
  }
  if (processedThrough.status !== "after") {
    throw new TypeError("backfill上限到達時の再開位置を確定できません");
  }
  return Object.freeze({
    ...fields,
    status: "limit_reached",
    processedThrough,
  });
}

function getExternalBlockerPair(connection: TrackingConnection): Readonly<{
  blockerNodeId: GraphNodeId;
  blockedNodeId: GraphNodeId;
}> | null {
  switch (connection.kind) {
    case "native_dependency":
      return Object.freeze({
        blockerNodeId: connection.blockerNodeId,
        blockedNodeId: connection.blockedNodeId,
      });
    case "reference":
      return connection.relation.type === "blocks"
        ? Object.freeze({
            blockerNodeId: connection.relation.blockerNodeId,
            blockedNodeId: connection.relation.blockedNodeId,
          })
        : null;
    case "native_sub_issue":
      return null;
    default:
      throw new UnreachableError(connection);
  }
}

function createGhostNodes(
  connections: readonly TrackingConnection[],
  candidatesByNodeId: ReadonlyMap<GraphNodeId, TrackingCandidate>,
  selectedByNodeId: ReadonlyMap<GitHubNodeId, SelectionDraft>,
): readonly ExternalGhostNode[] {
  const ghostsByNodeId = new Map<ExternalReferenceNodeId, ExternalGhostNode>();
  for (const connection of connections) {
    const blockerPair = getExternalBlockerPair(connection);
    if (blockerPair == null) {
      continue;
    }
    const blocked = getOrganizationCandidate(candidatesByNodeId, blockerPair.blockedNodeId);
    if (blocked == null || !selectedByNodeId.has(blocked.nodeId)) {
      continue;
    }
    const blocker = candidatesByNodeId.get(blockerPair.blockerNodeId);
    if (blocker?.scope !== "external_public") {
      continue;
    }
    ghostsByNodeId.set(
      blocker.nodeId,
      Object.freeze({
        kind: "external_reference",
        nodeId: blocker.nodeId,
        repositoryFullName: blocker.repositoryFullName,
        number: blocker.number,
        url: blocker.url,
        title: blocker.title,
        state: blocker.state,
        recursiveTracking: "not_allowed",
        directNotification: "not_eligible",
      }),
    );
  }
  return Object.freeze(
    [...ghostsByNodeId.values()].sort((left, right) => {
      if (left.repositoryFullName !== right.repositoryFullName) {
        return left.repositoryFullName < right.repositoryFullName ? -1 : 1;
      }
      if (left.number !== right.number) {
        return left.number < right.number ? -1 : 1;
      }
      if (left.nodeId !== right.nodeId) {
        return left.nodeId < right.nodeId ? -1 : 1;
      }
      return 0;
    }),
  );
}

function compareInclusionReasons(
  left: TrackingInclusionReason,
  right: TrackingInclusionReason,
): -1 | 0 | 1 {
  const leftRank = INCLUSION_REASON_ORDER.indexOf(left.kind);
  const rightRank = INCLUSION_REASON_ORDER.indexOf(right.kind);
  if (leftRank !== rightRank) {
    return leftRank < rightRank ? -1 : 1;
  }
  const leftText = JSON.stringify(left);
  const rightText = JSON.stringify(right);
  if (leftText !== rightText) {
    return leftText < rightText ? -1 : 1;
  }
  return 0;
}

function finalizeSelection(
  selectedByNodeId: ReadonlyMap<GitHubNodeId, SelectionDraft>,
): readonly SelectedTrackingItem[] {
  return Object.freeze(
    [...selectedByNodeId.values()]
      .sort((left, right) => compareCandidates(left.item, right.item))
      .map((selected) => {
        const reasons = selected.reasons.sort(compareInclusionReasons);
        const [firstReason, ...remainingReasons] = reasons;
        assertNonNullable(firstReason, "追跡項目のinclude根拠がありません");
        const frozenReasons: readonly [TrackingInclusionReason, ...TrackingInclusionReason[]] =
          Object.freeze([firstReason, ...remainingReasons]);
        return Object.freeze({
          item: selected.item,
          reasons: frozenReasons,
        });
      }),
  );
}

/** startAt、活動、参照、native関係、明示include、backfillから追跡対象を選ぶ。 */
export function selectTrackingItems(input: SelectTrackingItemsInput): TrackingSelectionResult {
  const candidatesByNodeId = validateInput(input);
  const selectedByNodeId = new Map<GitHubNodeId, SelectionDraft>();

  for (const nodeId of input.previouslyTrackedNodeIds) {
    const candidate = getOrganizationCandidate(candidatesByNodeId, nodeId);
    assertNonNullable(candidate, `既存追跡項目がありません。対象: ${nodeId}`);
    addInclusionReason(
      selectedByNodeId,
      candidate,
      Object.freeze({
        kind: "previously_tracked",
      }),
    );
  }
  includeAutomaticCandidates(input, selectedByNodeId);
  includeExplicitCandidates(input, candidatesByNodeId, selectedByNodeId);
  includeReferencedCandidates(input, candidatesByNodeId, selectedByNodeId);
  includeNativeRelations(input, candidatesByNodeId, selectedByNodeId);
  const backfill = performBackfill(input, candidatesByNodeId, selectedByNodeId);
  const trackedItems = finalizeSelection(selectedByNodeId);
  const newlyTrackedItems = Object.freeze(
    trackedItems.filter(
      (selected) => !selected.reasons.some((reason) => reason.kind === "previously_tracked"),
    ),
  );

  return Object.freeze({
    trackedItems,
    newlyTrackedItems,
    ghostNodes: createGhostNodes(input.connections, candidatesByNodeId, selectedByNodeId),
    backfill,
  });
}
