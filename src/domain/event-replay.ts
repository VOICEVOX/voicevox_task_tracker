import { type SourceId } from "./source-id.js";
import {
  type Actor,
  type GitHubAccountActor,
  type GitHubNodeId,
  type NormalizedEvent,
  type UtcIsoDateTime,
} from "./types.js";

type ReplayActor =
  | Actor
  | Readonly<{
      status: "unavailable";
      reason: "actor_unavailable";
    }>;

type ReplayEventWithAvailability<Event extends NormalizedEvent> = Event extends unknown
  ? Omit<Event, "actor"> &
      Readonly<{
        actor: ReplayActor;
        sequence: number;
      }>
  : never;

type NormalizedAssigneeEvent = Extract<NormalizedEvent, { kind: "assignee" }>;
type NormalizedReviewRequestEvent = Extract<NormalizedEvent, { kind: "review_request" }>;

type ReplayAssigneeEvent = Omit<ReplayEventWithAvailability<NormalizedAssigneeEvent>, "assignee"> &
  Readonly<{
    assignee:
      | GitHubAccountActor
      | Readonly<{
          status: "unavailable";
          reason: "actor_unavailable";
        }>;
  }>;

type ReplayReviewRequestEvent = Omit<
  ReplayEventWithAvailability<NormalizedReviewRequestEvent>,
  "target"
> &
  Readonly<{
    target:
      | NormalizedReviewRequestEvent["target"]
      | Readonly<{
          status: "unavailable";
          reason: "actor_unavailable";
        }>;
  }>;

/** 正規化イベントにタイムライン内の決定論的な順序を付けた入力。 */
export type ReplayEvent =
  | ReplayAssigneeEvent
  | ReplayReviewRequestEvent
  | ReplayEventWithAvailability<
      Exclude<NormalizedEvent, NormalizedAssigneeEvent | NormalizedReviewRequestEvent>
    >;

/** 履歴から復元した値が既知かどうかを表す。 */
type ReplayKnowledge<Value> =
  | Readonly<{
      status: "known";
      value: Value;
    }>
  | Readonly<{
      status: "unknown";
      reason: "history_unavailable" | "actor_unavailable";
    }>;

type ReplayUnknownReason = "history_unavailable" | "actor_unavailable";

/** 現行review requestの対象。 */
type ReplayReviewRequestTarget =
  | Readonly<{
      type: "user" | "team";
      nodeId: GitHubNodeId;
    }>
  | Readonly<{
      status: "unavailable";
      reason: "actor_unavailable";
    }>;

/** 現行review request。 */
type ReplayCurrentReviewRequest = Readonly<{
  sourceId: SourceId;
  target: ReplayReviewRequestTarget;
}>;

/** 現行GitHub項目の状態と責務。 */
export type ReplayCurrentItem =
  | Readonly<{
      type: "issue";
      sourceId: SourceId;
      nodeId: GitHubNodeId;
      createdAt: UtcIsoDateTime;
      observedAt: UtcIsoDateTime;
      state: "open" | "closed";
      assignees: readonly GitHubAccountActor[];
      reviewRequests: readonly [];
    }>
  | Readonly<{
      type: "pull_request";
      sourceId: SourceId;
      nodeId: GitHubNodeId;
      createdAt: UtcIsoDateTime;
      observedAt: UtcIsoDateTime;
      state: "open" | "closed" | "merged";
      draft: boolean;
      assignees: readonly GitHubAccountActor[];
      reviewRequests: readonly ReplayCurrentReviewRequest[];
    }>;

/** 履歴取得の成否。 */
export type ReplayHistory =
  | Readonly<{
      availability: "available";
      events: readonly ReplayEvent[];
    }>
  | Readonly<{
      availability: "unavailable";
      reason: "history_unavailable" | "actor_unavailable";
    }>;

/** イベント再生へ渡す入力。tracking.startAtより前のイベントも除外しない。 */
export type ReplayItemHistoryInput = Readonly<{
  trackingStartAt: UtcIsoDateTime;
  currentItem: ReplayCurrentItem;
  history: ReplayHistory;
}>;

/** イベントとその発生時刻を保持する復元根拠。 */
type ReplayFact = Readonly<{
  occurredAt: UtcIsoDateTime;
  sourceIds: readonly [SourceId, ...SourceId[]];
}>;

/** 項目の状態区間の開始点。 */
type ReplayStateEpoch = ReplayFact &
  Readonly<{
    state: "open" | "closed" | "merged";
  }>;

/** Pull Requestのdraft区間の開始点。 */
type ReplayDraftEpoch = ReplayFact &
  Readonly<{
    draft: boolean;
  }>;

/** 責務を持つ対象。 */
type ReplayResponsibilityTarget =
  | Readonly<{
      kind: "assignee";
      nodeId: GitHubNodeId;
    }>
  | Readonly<{
      kind: "review_request";
      target: "user" | "team";
      nodeId: GitHubNodeId;
    }>
  | Readonly<{
      kind: "review_request";
      status: "unavailable";
      reason: "actor_unavailable";
    }>;

/** 責務集合の区間の開始点。 */
type ReplayResponsibilityEpoch = ReplayFact &
  Readonly<{
    targets: readonly ReplayResponsibilityTarget[];
  }>;

type NotApplicable = Readonly<{
  status: "not_applicable";
}>;

function createNotApplicable(): NotApplicable {
  return Object.freeze({
    status: "not_applicable",
  });
}

function createCurrentDraft(value: boolean): Readonly<{
  status: "known";
  value: boolean;
}> {
  return Object.freeze({
    status: "known",
    value,
  });
}

/** イベント再生で復元した時間的事実。 */
export type ReplayItemHistoryResult = Readonly<{
  trackingStartAt: UtcIsoDateTime;
  orderedEvents: readonly ReplayEvent[];
  currentState: "open" | "closed" | "merged";
  currentDraft:
    | Readonly<{
        status: "not_applicable";
      }>
    | Readonly<{
        status: "known";
        value: boolean;
      }>;
  currentResponsibilities: readonly ReplayResponsibilityTarget[];
  stateEpochs: ReplayKnowledge<readonly ReplayStateEpoch[]>;
  currentStateEpoch: ReplayKnowledge<ReplayStateEpoch>;
  draftEpochs:
    | ReplayKnowledge<readonly ReplayDraftEpoch[]>
    | Readonly<{
        status: "not_applicable";
      }>;
  currentDraftEpoch:
    | ReplayKnowledge<ReplayDraftEpoch>
    | Readonly<{
        status: "not_applicable";
      }>;
  responsibilityEpochs: ReplayKnowledge<readonly ReplayResponsibilityEpoch[]>;
  currentOwnerEpoch: ReplayKnowledge<ReplayResponsibilityEpoch>;
}>;

function createSourceIds(sourceIds: readonly SourceId[]): readonly [SourceId, ...SourceId[]] {
  const uniqueSourceIds = [...new Set(sourceIds)].sort();
  const firstSourceId = uniqueSourceIds[0];
  if (firstSourceId == null) {
    throw new TypeError("復元根拠のsource IDが1件もありません");
  }
  return Object.freeze([firstSourceId, ...uniqueSourceIds.slice(1)]);
}

function createFact(occurredAt: UtcIsoDateTime, sourceIds: readonly SourceId[]): ReplayFact {
  return Object.freeze({
    occurredAt,
    sourceIds: createSourceIds(sourceIds),
  });
}

function createStateEpoch(
  state: ReplayStateEpoch["state"],
  occurredAt: UtcIsoDateTime,
  sourceIds: readonly SourceId[],
): ReplayStateEpoch {
  return Object.freeze({
    ...createFact(occurredAt, sourceIds),
    state,
  });
}

function createDraftEpoch(
  draft: boolean,
  occurredAt: UtcIsoDateTime,
  sourceIds: readonly SourceId[],
): ReplayDraftEpoch {
  return Object.freeze({
    ...createFact(occurredAt, sourceIds),
    draft,
  });
}

function createResponsibilityEpoch(
  targets: readonly ReplayResponsibilityTarget[],
  occurredAt: UtcIsoDateTime,
  sourceIds: readonly SourceId[],
): ReplayResponsibilityEpoch {
  return Object.freeze({
    ...createFact(occurredAt, sourceIds),
    targets: Object.freeze([...targets]),
  });
}

function createKnown<Value>(value: Value): ReplayKnowledge<Value> {
  return Object.freeze({
    status: "known",
    value,
  });
}

function createUnknown(reason: ReplayUnknownReason): Readonly<{
  status: "unknown";
  reason: "history_unavailable" | "actor_unavailable";
}> {
  return Object.freeze({
    status: "unknown",
    reason,
  });
}

function parseTimestamp(value: UtcIsoDateTime, context: string): number {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new TypeError(`${context}は有効な日時ではありません`);
  }
  return timestamp;
}

function compareEvents(left: ReplayEvent, right: ReplayEvent): -1 | 0 | 1 {
  if (left.occurredAt < right.occurredAt) {
    return -1;
  }
  if (left.occurredAt > right.occurredAt) {
    return 1;
  }
  if (left.sequence < right.sequence) {
    return -1;
  }
  if (left.sequence > right.sequence) {
    return 1;
  }
  if (left.sourceId < right.sourceId) {
    return -1;
  }
  if (left.sourceId > right.sourceId) {
    return 1;
  }
  return 0;
}

function stableSerialize(value: unknown): string {
  if (value == null) {
    return "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableSerialize(entry)).join(",")}]`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value).sort(([left], [right]) => {
      if (left < right) {
        return -1;
      }
      if (left > right) {
        return 1;
      }
      return 0;
    });
    return `{${entries
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableSerialize(entry)}`)
      .join(",")}}`;
  }
  if (typeof value === "bigint" || typeof value === "function" || typeof value === "symbol") {
    throw new TypeError("イベント内容を安定した文字列へ変換できません");
  }
  return JSON.stringify(value);
}

function eventContentSignature(event: ReplayEvent): string {
  return stableSerialize(
    Object.fromEntries(Object.entries(event).filter(([key]) => key !== "sequence")),
  );
}

function validateCurrentItem(input: ReplayItemHistoryInput): void {
  const { currentItem } = input;
  const createdAt = parseTimestamp(currentItem.createdAt, "項目作成時刻");
  const observedAt = parseTimestamp(currentItem.observedAt, "観測時刻");
  parseTimestamp(input.trackingStartAt, "tracking.startAt");
  if (createdAt > observedAt) {
    throw new RangeError("項目作成時刻は観測時刻以前にしてください");
  }
  if (currentItem.sourceId.length === 0 || currentItem.nodeId.length === 0) {
    throw new TypeError("現行項目のsource IDとnode IDは空にできません");
  }

  const assigneeNodeIds = new Set<GitHubNodeId>();
  for (const assignee of currentItem.assignees) {
    if (assigneeNodeIds.has(assignee.nodeId)) {
      throw new TypeError(`現行assigneeが重複しています。対象: ${assignee.nodeId}`);
    }
    assigneeNodeIds.add(assignee.nodeId);
  }

  if (currentItem.type !== "pull_request") {
    return;
  }
  const reviewRequestSourceIds = new Set<SourceId>();
  const reviewRequestTargetKeys = new Set<string>();
  for (const request of currentItem.reviewRequests) {
    if (reviewRequestSourceIds.has(request.sourceId)) {
      throw new TypeError(`現行review requestが重複しています。対象: ${request.sourceId}`);
    }
    reviewRequestSourceIds.add(request.sourceId);
    if ("status" in request.target) {
      continue;
    }
    const targetKey = createReviewRequestTargetKey(request.target);
    if (reviewRequestTargetKeys.has(targetKey)) {
      throw new TypeError(`現行review requestの責務対象が重複しています。対象: ${targetKey}`);
    }
    reviewRequestTargetKeys.add(targetKey);
  }
}

function deduplicateAndSortEvents(input: ReplayItemHistoryInput): readonly ReplayEvent[] {
  const createdAt = parseTimestamp(input.currentItem.createdAt, "項目作成時刻");
  const observedAt = parseTimestamp(input.currentItem.observedAt, "観測時刻");
  const bySourceId = new Map<SourceId, Readonly<{ event: ReplayEvent; signature: string }>>();

  for (const event of input.history.availability === "available" ? input.history.events : []) {
    if (event.itemNodeId !== input.currentItem.nodeId) {
      throw new TypeError(
        `イベントのitem node IDが現行項目と一致しません。対象: ${event.sourceId}`,
      );
    }
    if (event.sourceId.length === 0) {
      throw new TypeError("イベントのsource IDは空にできません");
    }
    if (!Number.isSafeInteger(event.sequence) || event.sequence < 0) {
      throw new RangeError(`イベントのsequenceが不正です。対象: ${event.sourceId}`);
    }
    const occurredAt = parseTimestamp(event.occurredAt, `イベント ${event.sourceId}の発生時刻`);
    if (occurredAt < createdAt || occurredAt > observedAt) {
      throw new RangeError(
        `イベントの発生時刻は項目作成時刻以後かつ観測時刻以前にしてください。対象: ${event.sourceId}`,
      );
    }
    const signature = eventContentSignature(event);
    const previous = bySourceId.get(event.sourceId);
    if (previous == null) {
      bySourceId.set(event.sourceId, Object.freeze({ event, signature }));
      continue;
    }
    if (previous.signature !== signature) {
      throw new TypeError(`同じsource IDに異なるイベント内容があります。対象: ${event.sourceId}`);
    }
    if (event.sequence < previous.event.sequence) {
      bySourceId.set(event.sourceId, Object.freeze({ event, signature }));
    }
  }

  return Object.freeze([...bySourceId.values()].map((value) => value.event).sort(compareEvents));
}

function assertEventKindsForItem(item: ReplayCurrentItem, events: readonly ReplayEvent[]): void {
  for (const event of events) {
    if (item.type === "issue") {
      if (
        (event.kind === "state" && event.state === "merged") ||
        event.kind === "ready_for_review" ||
        event.kind === "converted_to_draft" ||
        event.kind === "added_to_merge_queue" ||
        event.kind === "removed_from_merge_queue" ||
        event.kind === "auto_merge_enabled" ||
        event.kind === "auto_merge_disabled"
      ) {
        throw new TypeError(`IssueにPull Request専用イベントがあります。対象: ${event.sourceId}`);
      }
    }
  }
}

function replayStateEpochs(
  item: ReplayCurrentItem,
  events: readonly ReplayEvent[],
): readonly ReplayStateEpoch[] {
  type StateEvent = Extract<ReplayEvent, { kind: "state" }>;
  let state: ReplayStateEpoch["state"] = "open";
  const epochs: ReplayStateEpoch[] = [createStateEpoch("open", item.createdAt, [item.sourceId])];
  const stateEvents = events.filter((event): event is StateEvent => event.kind === "state");
  let eventIndex = 0;
  while (eventIndex < stateEvents.length) {
    const event = stateEvents[eventIndex];
    if (event == null) {
      throw new TypeError("stateイベントのindexが範囲外です");
    }
    const sameTimeEvents: StateEvent[] = [event];
    let nextIndex = eventIndex + 1;
    while (
      nextIndex < stateEvents.length &&
      stateEvents[nextIndex]?.occurredAt === event.occurredAt
    ) {
      const sameTimeEvent = stateEvents[nextIndex];
      if (sameTimeEvent == null) {
        throw new TypeError("同時刻stateイベントのindexが範囲外です");
      }
      sameTimeEvents.push(sameTimeEvent);
      nextIndex += 1;
    }
    const mergedEvents = sameTimeEvents.filter((value) => value.state === "merged");
    if (mergedEvents.length > 0) {
      const mergedEvent = mergedEvents[0];
      if (mergedEvent == null) {
        throw new TypeError("mergedイベントを取得できませんでした");
      }
      if (item.type !== "pull_request") {
        throw new TypeError(`Issueをmergeできません。対象: ${mergedEvent.sourceId}`);
      }
      if (
        mergedEvents.length !== 1 ||
        sameTimeEvents.some((value) => value.state === "reopened" || value.state === "open")
      ) {
        throw new TypeError("同時刻のmergedイベントに矛盾するstateイベントがあります");
      }
      if (state !== "open") {
        throw new TypeError(`open状態以外をmergeできません。対象: ${mergedEvent.sourceId}`);
      }
      state = "merged";
      epochs.push(
        createStateEpoch(
          state,
          event.occurredAt,
          sameTimeEvents.map((value) => value.sourceId),
        ),
      );
      eventIndex = nextIndex;
      continue;
    }
    if (event.state === "reopened" || event.state === "open") {
      if (state !== "closed") {
        throw new TypeError(`open状態からreopenできません。対象: ${event.sourceId}`);
      }
      state = "open";
    } else if (event.state === "closed") {
      if (state !== "open") {
        throw new TypeError(`open状態以外をcloseできません。対象: ${event.sourceId}`);
      }
      state = "closed";
    } else {
      if (item.type !== "pull_request") {
        throw new TypeError(`Issueをmergeできません。対象: ${event.sourceId}`);
      }
      if (state !== "open") {
        throw new TypeError(`open状態以外をmergeできません。対象: ${event.sourceId}`);
      }
      state = "merged";
    }
    epochs.push(createStateEpoch(state, event.occurredAt, [event.sourceId]));
    eventIndex += 1;
  }
  if (state !== item.state) {
    throw new TypeError("イベント再生結果と現行GitHub状態が一致しません");
  }
  return Object.freeze(epochs);
}

function replayDraftEpochs(
  item: Extract<ReplayCurrentItem, { type: "pull_request" }>,
  events: readonly ReplayEvent[],
): readonly ReplayDraftEpoch[] {
  type DraftLifecycleEvent = ReplayEvent &
    Readonly<{
      kind: "ready_for_review" | "converted_to_draft";
    }>;
  const lifecycleEvents = events.filter(
    (event): event is DraftLifecycleEvent =>
      event.kind === "ready_for_review" || event.kind === "converted_to_draft",
  );
  const firstEvent = lifecycleEvents[0];
  let draft = firstEvent == null ? item.draft : firstEvent.kind === "ready_for_review";
  const epochs: ReplayDraftEpoch[] = [createDraftEpoch(draft, item.createdAt, [item.sourceId])];
  for (const event of lifecycleEvents) {
    if (event.kind === "ready_for_review") {
      if (!draft) {
        throw new TypeError(`ready PRをreadyにできません。対象: ${event.sourceId}`);
      }
      draft = false;
    } else {
      if (draft) {
        throw new TypeError(`draft PRをdraftにできません。対象: ${event.sourceId}`);
      }
      draft = true;
    }
    epochs.push(createDraftEpoch(draft, event.occurredAt, [event.sourceId]));
  }
  if (draft !== item.draft) {
    throw new TypeError("draftイベントの再生結果と現行GitHub状態が一致しません");
  }
  return Object.freeze(epochs);
}

function createAssigneeTarget(nodeId: GitHubNodeId): ReplayResponsibilityTarget {
  return Object.freeze({
    kind: "assignee",
    nodeId,
  });
}

function createReviewRequestTarget(
  target: Extract<NormalizedEvent, { kind: "review_request" }>["target"],
): ReplayResponsibilityTarget {
  return Object.freeze({
    kind: "review_request",
    target: target.type,
    nodeId: target.nodeId,
  });
}

function createReviewRequestTargetKey(
  target: Extract<ReplayReviewRequestTarget, { type: "user" | "team" }>,
): string {
  return `review_request:${target.type}:${target.nodeId}`;
}

function responsibilityTargetKey(target: ReplayResponsibilityTarget): string {
  if (target.kind === "assignee") {
    return `assignee:${target.nodeId}`;
  }
  if ("status" in target) {
    return "review_request:unavailable";
  }
  return `review_request:${target.target}:${target.nodeId}`;
}

function sortResponsibilityTargets(
  targets: readonly ReplayResponsibilityTarget[],
): readonly ReplayResponsibilityTarget[] {
  return Object.freeze(
    [...targets].sort((left, right) => {
      const leftKey = responsibilityTargetKey(left);
      const rightKey = responsibilityTargetKey(right);
      if (leftKey < rightKey) {
        return -1;
      }
      if (leftKey > rightKey) {
        return 1;
      }
      return 0;
    }),
  );
}

function resolveCurrentResponsibilities(
  item: ReplayCurrentItem,
): readonly ReplayResponsibilityTarget[] {
  const targets: ReplayResponsibilityTarget[] = item.assignees.map((assignee) =>
    createAssigneeTarget(assignee.nodeId),
  );
  if (item.type === "pull_request") {
    for (const request of item.reviewRequests) {
      if ("status" in request.target) {
        targets.push(
          Object.freeze({
            kind: "review_request",
            status: "unavailable",
            reason: request.target.reason,
          }),
        );
      } else {
        targets.push(
          Object.freeze({
            kind: "review_request",
            target: request.target.type,
            nodeId: request.target.nodeId,
          }),
        );
      }
    }
  }
  return sortResponsibilityTargets(targets);
}

function replayResponsibilityEpochs(
  item: ReplayCurrentItem,
  events: readonly ReplayEvent[],
): ReplayKnowledge<readonly ReplayResponsibilityEpoch[]> {
  const active = new Map<string, ReplayResponsibilityTarget>();
  const epochs: ReplayResponsibilityEpoch[] = [
    createResponsibilityEpoch([], item.createdAt, [item.sourceId]),
  ];
  for (const event of events) {
    if (event.kind !== "assignee" && event.kind !== "review_request") {
      continue;
    }
    let target: ReplayResponsibilityTarget;
    if (event.kind === "assignee") {
      if ("status" in event.assignee) {
        return createUnknown("actor_unavailable");
      }
      target = createAssigneeTarget(event.assignee.nodeId);
    } else {
      if ("status" in event.target) {
        return createUnknown("actor_unavailable");
      }
      target = createReviewRequestTarget(event.target);
    }
    const key = responsibilityTargetKey(target);
    if (event.action === "added") {
      if (active.has(key)) {
        throw new TypeError(`既にactiveな責務対象をaddedできません。対象: ${key}`);
      }
      active.set(key, target);
    } else {
      if (!active.delete(key)) {
        throw new TypeError(`activeでない責務対象をremovedできません。対象: ${key}`);
      }
    }
    epochs.push(
      createResponsibilityEpoch(sortResponsibilityTargets([...active.values()]), event.occurredAt, [
        event.sourceId,
      ]),
    );
  }
  return createKnown(Object.freeze(epochs));
}

function sameResponsibilityTargets(
  left: readonly ReplayResponsibilityTarget[],
  right: readonly ReplayResponsibilityTarget[],
): boolean {
  const leftKeys = left.map(responsibilityTargetKey);
  const rightKeys = right.map(responsibilityTargetKey);
  return (
    leftKeys.length === rightKeys.length && leftKeys.every((key, index) => key === rightKeys[index])
  );
}

function validateCurrentResponsibilities(
  item: ReplayCurrentItem,
  epochs: ReplayKnowledge<readonly ReplayResponsibilityEpoch[]>,
): void {
  if (epochs.status === "unknown") {
    return;
  }
  const current = resolveCurrentResponsibilities(item);
  if (current.some((target) => "status" in target)) {
    return;
  }
  const latest = epochs.value.at(-1);
  if (latest == null || !sameResponsibilityTargets(latest.targets, current)) {
    throw new TypeError("責務イベントの再生結果と現行GitHub状態が一致しません");
  }
}

function replayUnavailableResult(
  input: ReplayItemHistoryInput,
  reason: "history_unavailable" | "actor_unavailable",
): ReplayItemHistoryResult {
  const currentItem = input.currentItem;
  const currentDraft =
    currentItem.type === "issue" ? createNotApplicable() : createCurrentDraft(currentItem.draft);
  return Object.freeze({
    trackingStartAt: input.trackingStartAt,
    orderedEvents: Object.freeze([]),
    currentState: currentItem.state,
    currentDraft,
    currentResponsibilities: resolveCurrentResponsibilities(currentItem),
    stateEpochs: createUnknown(reason),
    currentStateEpoch: createUnknown(reason),
    draftEpochs: currentItem.type === "issue" ? createNotApplicable() : createUnknown(reason),
    currentDraftEpoch: currentItem.type === "issue" ? createNotApplicable() : createUnknown(reason),
    responsibilityEpochs: createUnknown(reason),
    currentOwnerEpoch: createUnknown(reason),
  });
}

/** 現行GitHub値とイベント列を照合し、項目の時間的事実を再生する。 */
export function replayItemHistory(input: ReplayItemHistoryInput): ReplayItemHistoryResult {
  validateCurrentItem(input);
  if (input.history.availability === "unavailable") {
    return replayUnavailableResult(input, input.history.reason);
  }

  const orderedEvents = deduplicateAndSortEvents(input);
  assertEventKindsForItem(input.currentItem, orderedEvents);
  const stateEpochs = replayStateEpochs(input.currentItem, orderedEvents);
  const currentStateEpoch = stateEpochs.at(-1);
  if (currentStateEpoch == null) {
    throw new TypeError("状態区間を1件も復元できませんでした");
  }
  const currentResponsibilities = resolveCurrentResponsibilities(input.currentItem);
  const responsibilityEpochs = replayResponsibilityEpochs(input.currentItem, orderedEvents);
  validateCurrentResponsibilities(input.currentItem, responsibilityEpochs);
  const currentOwnerEpoch =
    responsibilityEpochs.status === "unknown" ||
    currentResponsibilities.some((target) => "status" in target)
      ? createUnknown("actor_unavailable")
      : createKnown(
          (() => {
            const latestResponsibilityEpoch = responsibilityEpochs.value.at(-1);
            if (latestResponsibilityEpoch == null) {
              throw new TypeError("責務区間を1件も復元できませんでした");
            }
            return latestResponsibilityEpoch;
          })(),
        );

  if (input.currentItem.type === "issue") {
    return Object.freeze({
      trackingStartAt: input.trackingStartAt,
      orderedEvents,
      currentState: input.currentItem.state,
      currentDraft: createNotApplicable(),
      currentResponsibilities,
      stateEpochs: createKnown(stateEpochs),
      currentStateEpoch: createKnown(currentStateEpoch),
      draftEpochs: createNotApplicable(),
      currentDraftEpoch: createNotApplicable(),
      responsibilityEpochs,
      currentOwnerEpoch,
    });
  }

  const draftEpochs = replayDraftEpochs(input.currentItem, orderedEvents);
  const currentDraftEpoch = draftEpochs.at(-1);
  if (currentDraftEpoch == null) {
    throw new TypeError("draft区間を1件も復元できませんでした");
  }
  return Object.freeze({
    trackingStartAt: input.trackingStartAt,
    orderedEvents,
    currentState: input.currentItem.state,
    currentDraft: createCurrentDraft(input.currentItem.draft),
    currentResponsibilities,
    stateEpochs: createKnown(stateEpochs),
    currentStateEpoch: createKnown(currentStateEpoch),
    draftEpochs: createKnown(draftEpochs),
    currentDraftEpoch: createKnown(currentDraftEpoch),
    responsibilityEpochs,
    currentOwnerEpoch,
  });
}
