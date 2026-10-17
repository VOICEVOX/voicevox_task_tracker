import type { Config } from "../../../config/schema.js";
import {
  createUtcIsoDateTime,
  resolveTrackingStartAt,
  type TrackingBackfillRequest,
  type TrackingRunCompletion,
  type TrackingStartAtState,
  type UtcIsoDateTime,
} from "../../../domain/index.js";
import type { AnalysisPreviousState } from "../contracts/previous-state.js";
import type { RunExecutionPolicy } from "../request.js";

/** 設定と前回状態から追跡開始時刻を解決する。 */
export function resolveConfiguredTrackingStartAt(
  config: Config,
  previousState: TrackingStartAtState,
  run: TrackingRunCompletion,
): TrackingStartAtState {
  const configured = config.tracking.startAt;
  return resolveTrackingStartAt({
    configuredStartAt:
      configured == null
        ? Object.freeze({ status: "not_configured" })
        : Object.freeze({ status: "configured", value: createUtcIsoDateTime(configured) }),
    previousState,
    run,
  });
}

/** 追跡選別の開始時刻を確定する。 */
export function trackingSelectionStartAt(
  config: Config,
  state: AnalysisPreviousState,
  evaluatedAt: UtcIsoDateTime,
): UtcIsoDateTime {
  const resolved = resolveConfiguredTrackingStartAt(
    config,
    state.snapshot.status === "available"
      ? state.snapshot.trackingStartAt
      : Object.freeze({ status: "not_fixed" }),
    Object.freeze({ outcome: "incomplete", finishedAt: evaluatedAt }),
  );
  return resolved.status === "not_fixed" ? evaluatedAt : resolved.value;
}

/** 実行方針から追跡選別のbackfill要求を作る。 */
export function trackingBackfillRequest(
  executionPolicy: RunExecutionPolicy,
): TrackingBackfillRequest {
  if (executionPolicy.kind !== "backfill") {
    return Object.freeze({ mode: "none" });
  }
  return Object.freeze({
    mode: executionPolicy.backfillRange.kind,
    repositoryFilter: executionPolicy.backfillRange.repositories,
    cursor: Object.freeze({ status: "start" }),
  });
}
