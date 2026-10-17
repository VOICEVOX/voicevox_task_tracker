import { parseSourceId, type SourceId } from "../../../domain/source-id.js";
import type { GitHubNodeId } from "../../../domain/types.js";
import type { GitHubItemDetail } from "../../../github/item-detail-types.js";
import type { AnalysisPreviousState } from "../contracts/previous-state.js";
import { RunCompletenessError } from "./run-completeness-error.js";

/** 前回時計が参照する旧review requestのうちnode照合が必要なIDを返す。 */
export function legacyReviewRequestInspectionSourceIds(
  state: AnalysisPreviousState,
  details: readonly GitHubItemDetail[],
): readonly SourceId[] {
  if (state.snapshot.status !== "available") return Object.freeze([]);
  const currentSourceIds = new Set(
    details.flatMap((detail) =>
      detail.type === "pull_request"
        ? detail.reviewRequests.current.map((request) => request.sourceId)
        : [],
    ),
  );
  const ownersBySourceId = new Map<SourceId, Set<GitHubNodeId>>();
  for (const item of state.snapshot.trackedItems) {
    for (const cause of item.personalReminderCauses) {
      const bases = [
        cause.obligationSince,
        ...(cause.actionableClock.status === "observed"
          ? [cause.actionableClock.actionableSince, cause.actionableClock.stallSince]
          : []),
      ];
      for (const basis of bases) {
        if (
          basis.source !== "reconfirmation_pending" &&
          basis.source !== "reconfirmed_observation"
        ) {
          continue;
        }
        for (const sourceId of basis.sourceIds) {
          if (
            parseSourceId(sourceId).kind !== "github_review_request" ||
            (basis.source === "reconfirmed_observation" && !currentSourceIds.has(sourceId))
          ) {
            continue;
          }
          const owners = ownersBySourceId.get(sourceId) ?? new Set<GitHubNodeId>();
          owners.add(cause.itemNodeId);
          ownersBySourceId.set(sourceId, owners);
        }
      }
    }
  }
  for (const [sourceId, owners] of ownersBySourceId) {
    if (owners.size !== 1) {
      throw new RunCompletenessError(
        "source_id_conflict",
        sourceId,
        ["previousSnapshot", "personalReminderCauses", "clock"],
        undefined,
      );
    }
  }
  return Object.freeze([...ownersBySourceId.keys()].sort());
}
