import { z } from "zod";

import type { AiCacheKey } from "../codex/cache.js";
import type {
  PersonalReminderCause,
  PersonalReminderTimeBasis,
} from "../domain/personal-reminder-causes.js";
import { parseSourceId } from "../domain/source-id.js";
import type { LegacyAiCacheEntry } from "./ai-cache-migration.js";
import { StateFormatError } from "./errors.js";
import { migrateStateSnapshot as migrateVersion21Snapshot } from "./snapshot-v21-migration.js";
import type { StateSnapshot as StateSnapshotVersion21 } from "./snapshot-v21.js";
import { createStateSnapshot, parseStateSnapshot, type StateSnapshot } from "./snapshot-v22.js";
import { migrateSeparatedLegacyCurrentAi } from "./snapshot-separated-ai-proof-migration.js";

const snapshotVersionSchema = z.object({ schemaVersion: z.string() });
const clockEventSourceKinds = new Set([
  "github_issue_comment",
  "github_pull_request_review_comment",
  "github_pull_request_review",
  "github_timeline_event",
  "github_review_request",
]);

function clockOnlyReviewRequestSourceIds(snapshot: StateSnapshotVersion21): ReadonlySet<string> {
  const clockBases = new Set<object>();
  const candidates = new Set<string>();
  for (const item of snapshot.items) {
    for (const cause of item.personalReminderCauses) {
      const bases = [
        cause.obligationSince,
        ...(cause.actionableClock.status === "observed"
          ? [cause.actionableClock.actionableSince, cause.actionableClock.stallSince]
          : []),
      ];
      for (const basis of bases) {
        clockBases.add(basis);
        if (basis.source !== "event") continue;
        for (const sourceId of basis.sourceIds) {
          if (parseSourceId(sourceId).kind === "github_review_request") candidates.add(sourceId);
        }
      }
    }
  }
  if (candidates.size === 0) return candidates;
  const referencedOutsideClock = new Set<string>();
  const inspect = (value: unknown): void => {
    if (typeof value === "string") {
      if (candidates.has(value)) referencedOutsideClock.add(value);
      return;
    }
    if (typeof value !== "object" || value == null || clockBases.has(value)) return;
    for (const member of Object.values(value)) inspect(member);
  };
  inspect(snapshot);
  return new Set([...candidates].filter((sourceId) => !referencedOutsideClock.has(sourceId)));
}

function legacyBasisForReconfirmation(
  basis: PersonalReminderTimeBasis,
  reviewRequestSourceIds: ReadonlySet<string>,
): PersonalReminderTimeBasis {
  if (
    basis.source !== "event" ||
    basis.sourceIds.every(
      (sourceId) =>
        clockEventSourceKinds.has(parseSourceId(sourceId).kind) &&
        !reviewRequestSourceIds.has(sourceId),
    )
  ) {
    return basis;
  }
  return Object.freeze({
    source: "reconfirmation_pending",
    at: basis.at,
    sourceIds: basis.sourceIds,
  });
}

function legacyCauseForReconfirmation(
  cause: PersonalReminderCause,
  reviewRequestSourceIds: ReadonlySet<string>,
): PersonalReminderCause {
  return Object.freeze({
    ...cause,
    obligationSince: legacyBasisForReconfirmation(cause.obligationSince, reviewRequestSourceIds),
    actionableClock:
      cause.actionableClock.status === "not_observed"
        ? cause.actionableClock
        : Object.freeze({
            ...cause.actionableClock,
            actionableSince: legacyBasisForReconfirmation(
              cause.actionableClock.actionableSince,
              reviewRequestSourceIds,
            ),
            stallSince: legacyBasisForReconfirmation(
              cause.actionableClock.stallSince,
              reviewRequestSourceIds,
            ),
          }),
  });
}

/** 旧世代snapshotの時計出典を再確認対象へ移す。 */
export function migrateStateSnapshot(
  source: string,
  legacyEntriesByCacheKey: ReadonlyMap<AiCacheKey, LegacyAiCacheEntry>,
  timezone: string,
): StateSnapshot {
  let value: unknown;
  try {
    const parseJson: (text: string) => unknown = JSON.parse;
    value = parseJson(source);
  } catch (error: unknown) {
    throw new StateFormatError("snapshot", { cause: error });
  }
  const version = snapshotVersionSchema.safeParse(value);
  if (!version.success) {
    throw StateFormatError.fromZodError("snapshot", version.error);
  }
  if (version.data.schemaVersion === "22") {
    return createStateSnapshot(migrateSeparatedLegacyCurrentAi(parseStateSnapshot(source)));
  }
  const previous = migrateVersion21Snapshot(source, legacyEntriesByCacheKey, timezone);
  const reviewRequestSourceIds = clockOnlyReviewRequestSourceIds(previous);
  return createStateSnapshot({
    ...previous,
    schemaVersion: "22",
    items: previous.items.map((item) => ({
      ...item,
      personalReminderCauses: item.personalReminderCauses.map((cause) =>
        legacyCauseForReconfirmation(cause, reviewRequestSourceIds),
      ),
    })),
  });
}
