import { createHash } from "node:crypto";

import {
  runIdentitySchema,
  type RunIdentity,
  type RunRequest,
} from "../../../application/tracking-run/request.js";
import { serializeCanonicalJson } from "../../../canonical-json/value.js";
import { UnreachableError } from "../../../util/index.js";

function runIdPayload(request: RunRequest): object {
  const common = { configPath: request.configPath, scheduledFor: request.scheduledFor };
  switch (request.requestKind) {
    case "sequential_daily":
      return {
        kind: "daily",
        ...common,
        notificationAction: request.executionPolicy.notificationAction,
      };
    case "split_daily":
      return {
        kind: "collect-analyze",
        ...common,
        mode: "none",
        notificationAction: request.executionPolicy.notificationAction,
        repositoryFilter: [],
      };
    case "backfill_none":
      return {
        kind: "backfill",
        ...common,
        mode: "none",
        notificationAction: request.executionPolicy.notificationAction,
        repositoryFilter: [],
      };
    case "sandbox_daily":
      return {
        kind: "daily",
        ...common,
        notificationAction: request.executionPolicy.notificationAction,
        sandboxContextPath: request.sandboxContextPath,
      };
    case "dry_run":
      return { kind: "dry-run", ...common };
    case "sequential_backfill":
    case "split_backfill":
      return {
        kind: request.requestKind === "split_backfill" ? "collect-analyze" : "backfill",
        ...common,
        mode: request.executionPolicy.backfillRange.kind,
        notificationAction: request.executionPolicy.notificationAction,
        repositoryFilter: request.executionPolicy.backfillRange.repositories,
      };
    default:
      throw new UnreachableError(request);
  }
}

/** 検証済み要求からrunと起動の識別情報を確定する。 */
export function createRunIdentity(request: RunRequest): RunIdentity {
  const digest = createHash("sha256")
    .update(serializeCanonicalJson(runIdPayload(request)))
    .digest("hex");
  return runIdentitySchema.parse({
    runId: `tracker-run:${digest}`,
    invocationId: request.invocationId,
    scheduledFor: request.scheduledFor,
    startedAt: request.startedAt,
  });
}
