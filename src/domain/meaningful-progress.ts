import { type LabelEffectsResolver } from "./label-resolution.js";
import { type SourceId } from "./source-id.js";
import { type NormalizedEvent, type UtcIsoDateTime } from "./types.js";
import { assertNonNullable, UnreachableError } from "../util/index.js";

/** 依存グラフから渡す確定済みの依存解消。 */
export type DependencyResolutionProgress = Readonly<{
  occurredAt: UtcIsoDateTime;
  sourceIds: readonly [SourceId, ...SourceId[]];
}>;

/** 自然言語を含む進捗候補への検証済み判定。 */
export type NaturalLanguageProgressAssessment = Readonly<{
  candidateSourceId: SourceId;
  verdict: "meaningful_progress" | "not_meaningful_progress";
  confidence: number;
  sourceIds: readonly [SourceId, ...SourceId[]];
}>;

/** Codexで意味を判定する必要がある進捗候補。 */
export type NaturalLanguageProgressCandidate = Readonly<{
  kind: "human_comment";
  sourceId: SourceId;
  occurredAt: UtcIsoDateTime;
}>;

/** lastProgressAtへ反映した意味のある進捗。 */
export type MeaningfulProgress = Readonly<{
  kind:
    | "push"
    | "human_review"
    | "state_change"
    | "dependency_resolved"
    | "configured_label"
    | "natural_language";
  occurredAt: UtcIsoDateTime;
  sourceIds: readonly [SourceId, ...SourceId[]];
  determination: "deterministic" | "ai";
  confidence: number;
}>;

/** 前回までに確定した活動時刻。 */
export type PreviousActivityState =
  | Readonly<{
      status: "not_available";
    }>
  | Readonly<{
      status: "available";
      lastProgressAt: UtcIsoDateTime;
      lastHumanActivityAt: UtcIsoDateTime;
    }>;

/** 意味のある進捗を算出する入力。 */
export type MeaningfulProgressInput = Readonly<{
  createdAt: UtcIsoDateTime;
  evaluatedAt: UtcIsoDateTime;
  events: readonly NormalizedEvent[];
  dependencyResolutions: readonly DependencyResolutionProgress[];
  naturalLanguageAssessments: readonly NaturalLanguageProgressAssessment[];
  minimumAiConfidence: number;
  previousActivity: PreviousActivityState;
  repositoryFullName: string;
  resolveLabelEffects: LabelEffectsResolver;
}>;

/** 意味のある進捗とhuman活動の算出結果。 */
export type MeaningfulProgressResult = Readonly<{
  lastProgressAt: UtcIsoDateTime;
  lastHumanActivityAt: UtcIsoDateTime;
  progress: readonly MeaningfulProgress[];
  naturalLanguageCandidates: readonly NaturalLanguageProgressCandidate[];
}>;

function parseTimestamp(value: UtcIsoDateTime, context: string): number {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new TypeError(`${context}は有効な日時ではありません`);
  }
  return timestamp;
}

function validateConfidence(value: number, context: string): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new RangeError(`${context}は0以上1以下にしてください`);
  }
}

function compareSourceIds(left: SourceId, right: SourceId): -1 | 0 | 1 {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function createSourceIds(sourceIds: readonly SourceId[]): readonly [SourceId, ...SourceId[]] {
  const uniqueSourceIds = [...new Set(sourceIds)].sort(compareSourceIds);
  const [firstSourceId, ...remainingSourceIds] = uniqueSourceIds;
  assertNonNullable(firstSourceId, "進捗のsource IDが1件もありません");
  return Object.freeze([firstSourceId, ...remainingSourceIds]);
}

function createProgress(
  kind: MeaningfulProgress["kind"],
  occurredAt: UtcIsoDateTime,
  sourceIds: readonly SourceId[],
  determination: MeaningfulProgress["determination"],
  confidence: number,
): MeaningfulProgress {
  return Object.freeze({
    kind,
    occurredAt,
    sourceIds: createSourceIds(sourceIds),
    determination,
    confidence,
  });
}

function compareProgress(left: MeaningfulProgress, right: MeaningfulProgress): -1 | 0 | 1 {
  if (left.occurredAt < right.occurredAt) {
    return -1;
  }
  if (left.occurredAt > right.occurredAt) {
    return 1;
  }
  const sourceComparison = compareSourceIds(left.sourceIds[0], right.sourceIds[0]);
  if (sourceComparison !== 0) {
    return sourceComparison;
  }
  if (left.kind < right.kind) {
    return -1;
  }
  if (left.kind > right.kind) {
    return 1;
  }
  return 0;
}

function compareCandidates(
  left: NaturalLanguageProgressCandidate,
  right: NaturalLanguageProgressCandidate,
): -1 | 0 | 1 {
  if (left.occurredAt < right.occurredAt) {
    return -1;
  }
  if (left.occurredAt > right.occurredAt) {
    return 1;
  }
  return compareSourceIds(left.sourceId, right.sourceId);
}

function validateSourceIds(sourceIds: readonly SourceId[], context: string): void {
  if (sourceIds.length === 0) {
    throw new TypeError(`${context}にはsource IDが1件以上必要です`);
  }
  if (new Set(sourceIds).size !== sourceIds.length) {
    throw new TypeError(`${context}のsource IDが重複しています`);
  }
}

function validateInput(input: MeaningfulProgressInput): void {
  const createdAt = parseTimestamp(input.createdAt, "項目作成時刻");
  const evaluatedAt = parseTimestamp(input.evaluatedAt, "判定時刻");
  if (createdAt > evaluatedAt) {
    throw new RangeError("項目作成時刻は判定時刻以前にしてください");
  }
  if (input.repositoryFullName.length === 0) {
    throw new TypeError("repository full nameは空にできません");
  }
  validateConfidence(input.minimumAiConfidence, "AI進捗判定の最低confidence");

  const eventSourceIds = new Set<SourceId>();
  for (const event of input.events) {
    if (eventSourceIds.has(event.sourceId)) {
      throw new TypeError(`正規化イベントのsource IDが重複しています。対象: ${event.sourceId}`);
    }
    eventSourceIds.add(event.sourceId);
    const occurredAt = parseTimestamp(event.occurredAt, `イベント ${event.sourceId}の発生時刻`);
    if (occurredAt < createdAt || occurredAt > evaluatedAt) {
      throw new RangeError(
        `イベントの発生時刻は項目作成時刻以後かつ判定時刻以前にしてください。対象: ${event.sourceId}`,
      );
    }
  }

  for (const resolution of input.dependencyResolutions) {
    validateSourceIds(resolution.sourceIds, "依存解消");
    const occurredAt = parseTimestamp(resolution.occurredAt, "依存解消時刻");
    if (occurredAt < createdAt || occurredAt > evaluatedAt) {
      throw new RangeError("依存解消時刻は項目作成時刻以後かつ判定時刻以前にしてください");
    }
  }

  if (input.previousActivity.status === "available") {
    const lastProgressAt = parseTimestamp(
      input.previousActivity.lastProgressAt,
      "前回の最終進捗時刻",
    );
    const lastHumanActivityAt = parseTimestamp(
      input.previousActivity.lastHumanActivityAt,
      "前回の最終human活動時刻",
    );
    if (
      lastProgressAt < createdAt ||
      lastProgressAt > evaluatedAt ||
      lastHumanActivityAt < createdAt ||
      lastHumanActivityAt > evaluatedAt
    ) {
      throw new RangeError("前回の活動時刻は項目作成時刻以後かつ判定時刻以前にしてください");
    }
  }
}

function createCandidates(
  events: readonly NormalizedEvent[],
): readonly NaturalLanguageProgressCandidate[] {
  return Object.freeze(
    events
      .filter(
        (
          event,
        ): event is Extract<NormalizedEvent, { kind: "comment" }> & {
          actor: Extract<NormalizedEvent, { kind: "comment" }>["actor"] & {
            type: "human";
          };
        } => event.kind === "comment" && event.actor.type === "human" && !event.bodyEmpty,
      )
      .map((event) =>
        Object.freeze({
          kind: "human_comment",
          sourceId: event.sourceId,
          occurredAt: event.occurredAt,
        } satisfies NaturalLanguageProgressCandidate),
      )
      .sort(compareCandidates),
  );
}

function validateAssessments(
  input: MeaningfulProgressInput,
  candidates: readonly NaturalLanguageProgressCandidate[],
): ReadonlyMap<SourceId, NaturalLanguageProgressAssessment> {
  const candidatesBySourceId = new Map(
    candidates.map((candidate) => [candidate.sourceId, candidate]),
  );
  const assessments = new Map<SourceId, NaturalLanguageProgressAssessment>();
  for (const assessment of input.naturalLanguageAssessments) {
    if (!candidatesBySourceId.has(assessment.candidateSourceId)) {
      throw new TypeError(
        `自然言語の進捗判定が候補ではないsource IDを参照しています。対象: ${assessment.candidateSourceId}`,
      );
    }
    if (assessments.has(assessment.candidateSourceId)) {
      throw new TypeError(
        `自然言語の進捗判定が重複しています。対象: ${assessment.candidateSourceId}`,
      );
    }
    validateConfidence(
      assessment.confidence,
      `自然言語の進捗判定 ${assessment.candidateSourceId}のconfidence`,
    );
    validateSourceIds(assessment.sourceIds, "自然言語の進捗判定");
    if (!assessment.sourceIds.includes(assessment.candidateSourceId)) {
      throw new TypeError(
        `自然言語の進捗判定根拠に候補のsource IDがありません。対象: ${assessment.candidateSourceId}`,
      );
    }
    assessments.set(assessment.candidateSourceId, assessment);
  }
  return assessments;
}

const PROGRESS_AND_HUMAN_ACTIVITY_EXCLUDED_EVENT_KINDS = Object.freeze([
  "ready_for_review",
  "converted_to_draft",
  "added_to_merge_queue",
  "removed_from_merge_queue",
  "auto_merge_enabled",
  "auto_merge_disabled",
] satisfies readonly NormalizedEvent["kind"][]);

type ProgressAndHumanActivityExcludedEvent = Extract<
  NormalizedEvent,
  { kind: (typeof PROGRESS_AND_HUMAN_ACTIVITY_EXCLUDED_EVENT_KINDS)[number] }
>;

/** 進捗とhuman活動から除外するイベントかを判定する。 */
export function isExcludedFromProgressAndHumanActivity(
  event: NormalizedEvent,
): event is ProgressAndHumanActivityExcludedEvent {
  return PROGRESS_AND_HUMAN_ACTIVITY_EXCLUDED_EVENT_KINDS.some((kind) => kind === event.kind);
}

function classifyDeterministicEvent(
  input: MeaningfulProgressInput,
  event: NormalizedEvent,
): MeaningfulProgress | undefined {
  if (isExcludedFromProgressAndHumanActivity(event)) {
    return undefined;
  }
  switch (event.kind) {
    case "push":
      return createProgress("push", event.occurredAt, [event.sourceId], "deterministic", 1);
    case "review":
      return event.actor.type === "human"
        ? createProgress("human_review", event.occurredAt, [event.sourceId], "deterministic", 1)
        : undefined;
    case "state":
      return createProgress("state_change", event.occurredAt, [event.sourceId], "deterministic", 1);
    case "relation":
      return event.relationType === "blocks" && event.action === "removed"
        ? createProgress(
            "dependency_resolved",
            event.occurredAt,
            [event.sourceId],
            "deterministic",
            1,
          )
        : undefined;
    case "label":
      return input.resolveLabelEffects(input.repositoryFullName, [event.labelName]).countsAsProgress
        ? createProgress("configured_label", event.occurredAt, [event.sourceId], "deterministic", 1)
        : undefined;
    case "comment":
    case "review_request":
    case "assignee":
      return undefined;
    default:
      throw new UnreachableError(event);
  }
}

function latestTimestamp(values: readonly UtcIsoDateTime[]): UtcIsoDateTime {
  const first = values[0];
  assertNonNullable(first, "比較する時刻が1件もありません");
  let latest = first;
  for (const value of values.slice(1)) {
    if (value > latest) {
      latest = value;
    }
  }
  return latest;
}

/** 正規化イベントと検証済みAI判定から意味のある進捗時刻を算出する。 */
export function determineMeaningfulProgress(
  input: MeaningfulProgressInput,
): MeaningfulProgressResult {
  validateInput(input);
  const candidates = createCandidates(input.events);
  const assessments = validateAssessments(input, candidates);
  const progress: MeaningfulProgress[] = [];

  for (const event of input.events) {
    const classified = classifyDeterministicEvent(input, event);
    if (classified != null) {
      progress.push(classified);
    }
  }

  for (const resolution of input.dependencyResolutions) {
    progress.push(
      createProgress(
        "dependency_resolved",
        resolution.occurredAt,
        resolution.sourceIds,
        "deterministic",
        1,
      ),
    );
  }

  for (const candidate of candidates) {
    const assessment = assessments.get(candidate.sourceId);
    if (
      assessment?.verdict === "meaningful_progress" &&
      assessment.confidence >= input.minimumAiConfidence
    ) {
      progress.push(
        createProgress(
          "natural_language",
          candidate.occurredAt,
          assessment.sourceIds,
          "ai",
          assessment.confidence,
        ),
      );
    }
  }

  const sortedProgress = Object.freeze(progress.sort(compareProgress));
  const previousProgress =
    input.previousActivity.status === "available" ? [input.previousActivity.lastProgressAt] : [];
  const previousHumanActivity =
    input.previousActivity.status === "available"
      ? [input.previousActivity.lastHumanActivityAt]
      : [];
  const humanEventTimes = input.events
    .filter(
      (event) => !isExcludedFromProgressAndHumanActivity(event) && event.actor.type === "human",
    )
    .map((event) => event.occurredAt);

  return Object.freeze({
    lastProgressAt: latestTimestamp([
      input.createdAt,
      ...previousProgress,
      ...sortedProgress.map((entry) => entry.occurredAt),
    ]),
    lastHumanActivityAt: latestTimestamp([
      input.createdAt,
      ...previousHumanActivity,
      ...humanEventTimes,
    ]),
    progress: sortedProgress,
    naturalLanguageCandidates: candidates,
  });
}
