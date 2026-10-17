#!/usr/bin/env bash

set -euo pipefail

umask 077
jq -cn \
  --arg firstRunId "$GITHUB_RUN_ID" \
  --argjson firstRunAttempt "$GITHUB_RUN_ATTEMPT" \
  --arg firstTrackingRunId "$SANDBOX_TRACKING_RUN_ID" \
  --arg firstFinalStateRevision "$SANDBOX_FINAL_REVISION" \
  --arg firstCodeRevision "$SANDBOX_CODE_REVISION" \
  --slurpfile cacheProbe "$RUNNER_TEMP/cache-probe.json" \
  '{outcome: "recorded_success", messageIndex: 0, continuity: {phase: "second", firstRunId: $firstRunId, firstRunAttempt: $firstRunAttempt, firstTrackingRunId: $firstTrackingRunId, firstFinalStateRevision: $firstFinalStateRevision, firstCodeRevision: $firstCodeRevision, cacheProbe: $cacheProbe[0]}}' \
  > "$RUNNER_TEMP/continuity-second-control.json"
