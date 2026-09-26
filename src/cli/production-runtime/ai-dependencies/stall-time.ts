import type { ReducedCodexDecision } from "../../../codex/index.js";
import type {
  AiAnalysisDependency,
  TrackedItemAiDependencies,
} from "../../../domain/ai-analysis-dependencies.js";
import {
  resolveWaitingOnAccountIdentifiers,
  type NormalizedEvent,
  type SourceId,
  type StalenessWaitClass,
  type UtcIsoDateTime,
} from "../../../domain/index.js";
import { isExcludedFromProgressAndHumanActivity } from "../../../domain/meaningful-progress.js";
import type { FreshObservedGitHubItem } from "../../../github/index.js";
import { assertNonNullable, UnreachableError } from "../../../util/index.js";
import {
  combineSelectedAiDependencies,
  notDependentAiDependency,
  preferIndependentAiDependency,
  unrecordedAiDependency,
} from "./selection.js";

/** 待機区分の成立に必要なAI依存を得る。 */
export function stateDependenciesForWaitClass(
  decision: Readonly<Pick<ReducedCodexDecision, "status" | "waitingOn" | "evidence">>,
  waitClass: StalenessWaitClass,
  dependencies: Readonly<{
    status: AiAnalysisDependency;
    waitingOn: AiAnalysisDependency;
    evidence: AiAnalysisDependency;
  }>,
): readonly AiAnalysisDependency[] {
  if (waitClass === "notApplicable" || waitClass === "blockedParent") {
    return Object.freeze([dependencies.status]);
  }
  const primaryWaitingOn = decision.waitingOn[0];
  assertNonNullable(primaryWaitingOn, "継続中状態のprimary waitingOnがありません");
  const precedingConditions = [dependencies.status, dependencies.waitingOn];
  const withPrecedingConditions = (route: AiAnalysisDependency): AiAnalysisDependency =>
    combineSelectedAiDependencies([...precedingConditions, route]);
  switch (waitClass) {
    case "owner":
      if (primaryWaitingOn.kind === "unknown" || primaryWaitingOn.role === "unknown") {
        return Object.freeze([withPrecedingConditions(dependencies.waitingOn)]);
      }
      if (decision.status === "waiting_for_owner" || decision.status === "unknown") {
        return Object.freeze([withPrecedingConditions(dependencies.status)]);
      }
      throw new TypeError(`wait class ${waitClass}の成立経路がありません`);
    case "automation": {
      const routes: AiAnalysisDependency[] = [];
      if (decision.status === "waiting_for_automation") {
        routes.push(dependencies.status);
      }
      if (primaryWaitingOn.kind === "automation") {
        routes.push(dependencies.waitingOn);
      }
      if (routes.length === 0) {
        throw new TypeError(`wait class ${waitClass}の成立経路がありません`);
      }
      return Object.freeze([withPrecedingConditions(preferIndependentAiDependency(routes))]);
    }
    case "review": {
      const routes: AiAnalysisDependency[] = [];
      if (decision.status === "waiting_for_review") {
        routes.push(dependencies.status);
      }
      if (primaryWaitingOn.role === "reviewer") {
        routes.push(dependencies.waitingOn);
      }
      if (routes.length === 0) {
        throw new TypeError(`wait class ${waitClass}の成立経路がありません`);
      }
      return Object.freeze([withPrecedingConditions(preferIndependentAiDependency(routes))]);
    }
    case "assessment":
    case "decision":
    case "merge":
    case "reply":
      return Object.freeze([withPrecedingConditions(dependencies.status)]);
    case "revision": {
      if (decision.status !== "waiting_for_revision") {
        throw new TypeError(`wait class ${waitClass}とstatusの組み合わせが不正です`);
      }
      const revisionConditionDependencies = [
        dependencies.status,
        dependencies.waitingOn,
        dependencies.evidence,
      ];
      return Object.freeze([
        combineSelectedAiDependencies([...precedingConditions, ...revisionConditionDependencies]),
      ]);
    }
    case "work":
      if (decision.status === "waiting_for_revision") {
        const revisionConditionDependencies = [
          dependencies.status,
          dependencies.waitingOn,
          dependencies.evidence,
        ];
        return Object.freeze([
          combineSelectedAiDependencies([...precedingConditions, ...revisionConditionDependencies]),
        ]);
      }
      if (decision.status === "waiting_for_work" || decision.status === "in_progress") {
        return Object.freeze([withPrecedingConditions(dependencies.status)]);
      }
      throw new TypeError(`wait class ${waitClass}とstatusの組み合わせが不正です`);
    default:
      throw new UnreachableError(waitClass);
  }
}

/** 条件に合う最新イベントの時刻を得る。 */
export function latestEventTime(
  events: readonly NormalizedEvent[],
  predicate: (event: NormalizedEvent) => boolean,
): UtcIsoDateTime | undefined {
  let latest: UtcIsoDateTime | undefined;
  for (const event of events) {
    if (!predicate(event)) {
      continue;
    }
    if (latest == null || event.occurredAt > latest) {
      latest = event.occurredAt;
    }
  }
  return latest;
}

type ReducedWaitingOn = readonly ReducedCodexDecision["waitingOn"][number][];

/** 待ち相手の集合が同じか判定する。 */
export function sameWaitingOnEntities(left: ReducedWaitingOn, right: ReducedWaitingOn): boolean {
  if (left.length !== right.length) {
    return false;
  }
  return left.every((waitingOn, index) => {
    const other = right[index];
    assertNonNullable(other, "比較対象のwaitingOnがありません");
    return (
      waitingOn.kind === other.kind &&
      waitingOn.candidateId === other.candidateId &&
      waitingOn.role === other.role
    );
  });
}

/** 待ち相手の最後の人間による活動時刻を得る。 */
export function lastResponsibleHumanActivityAt(
  item: FreshObservedGitHubItem,
  waitingOn: ReducedWaitingOn,
): UtcIsoDateTime | undefined {
  const accountIdentifiers = resolveWaitingOnAccountIdentifiers(waitingOn);
  return latestEventTime(
    item.events,
    (event) =>
      !isExcludedFromProgressAndHumanActivity(event) &&
      event.actor.type === "human" &&
      (accountIdentifiers.has(event.actor.login) || accountIdentifiers.has(event.actor.nodeId)),
  );
}

/** 最後の人間によるレビュー時刻を得る。 */
export function lastHumanReviewAt(item: FreshObservedGitHubItem): UtcIsoDateTime | undefined {
  return latestEventTime(
    item.events,
    (event) => event.kind === "review" && event.actor.type === "human",
  );
}

/** Pull Requestがレビュー待ちか判定する。 */
export function isPullRequestReviewWait(
  item: FreshObservedGitHubItem,
  decision: Readonly<Pick<ReducedCodexDecision, "status">>,
): boolean {
  return (
    item.type === "pull_request" &&
    (decision.status === "waiting_for_owner" || decision.status === "waiting_for_review")
  );
}

export type AiDependencyTimeCandidate = Readonly<{
  occurredAt: UtcIsoDateTime;
  dependency: AiAnalysisDependency;
}>;

/** 状態遷移の根拠時刻に対するAI依存を得る。 */
export function transitionBasisAiDependency(
  item: FreshObservedGitHubItem,
  sourceOccurredAtById: ReadonlyMap<SourceId, UtcIsoDateTime>,
  decision: ReducedCodexDecision,
  basis: Readonly<{
    occurredAt: UtcIsoDateTime;
    sourceIds: readonly SourceId[];
  }>,
  itemDependencies: TrackedItemAiDependencies,
  deterministicDependency: AiAnalysisDependency,
): AiAnalysisDependency {
  if (decision.origin === "deterministic") {
    return deterministicDependency;
  }
  const evidenceSourceIds = new Set<string>(decision.evidence.map((evidence) => evidence.sourceId));
  const waitingOnSourceIds = new Set<string>(
    decision.waitingOn.flatMap((waitingOn) => waitingOn.sourceIds),
  );
  const sourceIdsAtBasis = basis.sourceIds.filter(
    (sourceId) => sourceOccurredAtById.get(sourceId) === basis.occurredAt,
  );
  const dependencies: AiAnalysisDependency[] = [];
  if (basis.occurredAt === item.createdAt) {
    dependencies.push(notDependentAiDependency());
  }
  if (sourceIdsAtBasis.some((sourceId) => evidenceSourceIds.has(sourceId))) {
    dependencies.push(itemDependencies.evidence);
  }
  if (sourceIdsAtBasis.some((sourceId) => waitingOnSourceIds.has(sourceId))) {
    dependencies.push(itemDependencies.waitingOn);
  }
  return dependencies.length === 0
    ? unrecordedAiDependency()
    : preferIndependentAiDependency(dependencies);
}

/** 時刻候補の条件とAI依存を結合する。 */
export function candidateAiDependency(
  dependency: AiAnalysisDependency,
  conditionDependencies: readonly AiAnalysisDependency[],
): AiAnalysisDependency {
  return combineSelectedAiDependencies([dependency, ...conditionDependencies]);
}
