import { runRequestSchema, type RunRequest } from "../../application/tracking-run/request.js";
import { createUtcIsoDateTime, type UtcIsoDateTime } from "../../domain/index.js";
import { UnreachableError } from "../../util/index.js";
import type {
  BackfillCliCommand,
  CollectAnalyzeCliCommand,
  DailyCliCommand,
  DryRunCliCommand,
  RunSequentialCliCommand,
} from "./command-input.js";

type OnlineCommand =
  | DailyCliCommand
  | DryRunCliCommand
  | BackfillCliCommand
  | CollectAnalyzeCliCommand
  | RunSequentialCliCommand;

function resolveScheduledFor(command: OnlineCommand, startedAt: UtcIsoDateTime): UtcIsoDateTime {
  const scheduledFor = command.schedule.kind === "specified" ? command.schedule.value : startedAt;
  if (scheduledFor > startedAt) {
    throw new RangeError("runの予定時刻は開始時刻以前にしてください");
  }
  return scheduledFor;
}

function executionRequest(command: OnlineCommand): object {
  switch (command.kind) {
    case "daily":
      return {
        requestKind: "sequential_daily",
        executionPolicy: {
          kind: "production_daily",
          executionShape: "sequential",
          effectTarget: "production",
          notificationAction: command.notificationAction,
        },
        output: { kind: "publication" },
      };
    case "dry-run":
      return {
        requestKind: "dry_run",
        executionPolicy: {
          kind: "dry_run",
          executionShape: "sequential",
          effectTarget: "recording",
          notificationAction: "hold",
        },
        output: { kind: "dry_run_artifact", path: command.artifactPath },
      };
    case "backfill":
    case "collect-analyze": {
      if (command.kind === "collect-analyze" && command.sandboxContextPath != null) {
        return {
          requestKind: "sandbox_daily",
          executionPolicy: {
            kind: "sandbox_daily",
            executionShape: "split_workflow",
            effectTarget: "sandbox",
            notificationAction: command.notificationAction,
          },
          sandboxContextPath: command.sandboxContextPath,
          output: { kind: "analysis_artifact", path: command.artifactPath },
        };
      }
      if (command.mode === "none") {
        if (command.kind === "backfill") {
          return {
            requestKind: "backfill_none",
            executionPolicy: {
              kind: "production_daily",
              executionShape: "sequential",
              effectTarget: "production",
              notificationAction: command.notificationAction,
            },
            output: { kind: "publication" },
          };
        }
        return {
          requestKind: "split_daily",
          executionPolicy: {
            kind: "production_daily",
            executionShape: "split_workflow",
            effectTarget: "production",
            notificationAction: command.notificationAction,
          },
          output: { kind: "analysis_artifact", path: command.artifactPath },
        };
      }
      return {
        requestKind: command.kind === "backfill" ? "sequential_backfill" : "split_backfill",
        executionPolicy: {
          kind: "backfill",
          executionShape: command.kind === "backfill" ? "sequential" : "split_workflow",
          effectTarget: "production",
          notificationAction: command.notificationAction,
          backfillRange: {
            kind: command.mode,
            repositories: command.repositoryFilter,
          },
        },
        output:
          command.kind === "backfill"
            ? { kind: "publication" }
            : { kind: "analysis_artifact", path: command.artifactPath },
      };
    }
    case "run-sequential":
      return command.mode === "none"
        ? {
            requestKind: "sequential_daily",
            executionPolicy: {
              kind: "production_daily",
              executionShape: "sequential",
              effectTarget: "production",
              notificationAction: command.notificationAction,
            },
            output: { kind: "publication" },
          }
        : {
            requestKind: "sequential_backfill",
            executionPolicy: {
              kind: "backfill",
              executionShape: "sequential",
              effectTarget: "production",
              notificationAction: command.notificationAction,
              backfillRange: { kind: command.mode, repositories: command.repositoryFilter },
            },
            output: { kind: "publication" },
          };
    default:
      throw new UnreachableError(command);
  }
}

/** CLI入力を新規runの閉じた実行要求へ変換する。 */
export function parseRunRequest(
  command: OnlineCommand,
  now: Date,
  invocationId: string,
): RunRequest {
  if (!Number.isFinite(now.getTime())) {
    throw new TypeError("run runtimeのnowは有効な日時を返してください");
  }
  const startedAt = createUtcIsoDateTime(now.toISOString());
  return runRequestSchema.parse({
    invocationId,
    configPath: command.configPath,
    reportPath: command.reportPath,
    scheduledFor: resolveScheduledFor(command, startedAt),
    startedAt,
    ...executionRequest(command),
  });
}
