import { trackingRunStageNames } from "./contracts/closed-values.js";
import type { PublicFailureArtifact, FailedRun } from "./failure-artifact.js";
import { assertNonNullable } from "../../util/assert-non-nullable.js";
import type { OperationsAlertLedgerKind } from "../../domain/index.js";

const stageOrder = [
  "prepare",
  "runtime_bootstrap",
  "runtime_selection",
  "runtime_launch",
  ...trackingRunStageNames.slice(0, 13),
  "checkpoint_encoding",
  "checkpoint_binding",
  ...trackingRunStageNames.slice(13),
  "workflow_effect_observation",
] satisfies readonly FailedRun["failedStage"][];

function causeDepth(
  artifact: PublicFailureArtifact,
  byDigest: ReadonlyMap<string, PublicFailureArtifact>,
): number {
  let depth = 0;
  let current = artifact;
  const seen = new Set<string>();
  while (current.failure.causedByFailureArtifactDigest != null) {
    if (seen.has(current.failureArtifactDigest)) {
      throw new TypeError("公開失敗artifactの原因連鎖が循環しています");
    }
    seen.add(current.failureArtifactDigest);
    const previous = byDigest.get(current.failure.causedByFailureArtifactDigest);
    if (previous == null) {
      throw new TypeError("公開失敗artifactの原因が取得できません");
    }
    current = previous;
    depth += 1;
  }
  return depth;
}

/** canonical段階、完了phase、原因連鎖から最初の失敗を選ぶ。 */
export function selectPrimaryFailureArtifact(
  artifacts: readonly PublicFailureArtifact[],
): PublicFailureArtifact {
  if (artifacts.length === 0) {
    throw new TypeError("主因を選ぶ公開失敗artifactがありません");
  }
  const byDigest = new Map(artifacts.map((artifact) => [artifact.failureArtifactDigest, artifact]));
  if (byDigest.size !== artifacts.length) {
    throw new TypeError("公開失敗artifactのdigestが重複しています");
  }
  for (const artifact of artifacts) {
    causeDepth(artifact, byDigest);
  }
  const sorted = [...artifacts].sort((left, right) => {
    const stageDifference =
      stageOrder.indexOf(left.failure.failedStage) - stageOrder.indexOf(right.failure.failedStage);
    if (stageDifference !== 0) {
      return stageDifference;
    }
    const sequenceDifference =
      (left.failure.completedPhaseSequence ?? 0) - (right.failure.completedPhaseSequence ?? 0);
    if (sequenceDifference !== 0) {
      return sequenceDifference;
    }
    const depthDifference = causeDepth(left, byDigest) - causeDepth(right, byDigest);
    return depthDifference === 0
      ? left.failureArtifactDigest.localeCompare(right.failureArtifactDigest)
      : depthDifference;
  });
  const primary = sorted[0];
  assertNonNullable(primary, "公開失敗artifactの主因を取得できません");
  return primary;
}

/** 失敗段階を運用障害通知の処理分類へ変換する。 */
export function operationsIncidentKindForFailure(failure: FailedRun): OperationsAlertLedgerKind {
  if (failure.failureKind === "workflow_infrastructure_failure") {
    return "workflow_infrastructure_failure";
  }
  if (
    failure.failedStage === "initial_pages_prepared" ||
    failure.failedStage === "initial_pages_published" ||
    failure.failedStage === "notification_history_pages_prepared" ||
    failure.failedStage === "notification_history_pages_published"
  ) {
    return "pages";
  }
  if (failure.failedStage === "notifications_settled") {
    return "discord";
  }
  return "collection";
}
