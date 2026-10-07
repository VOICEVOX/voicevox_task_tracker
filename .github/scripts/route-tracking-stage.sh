#!/usr/bin/env bash
set -euo pipefail

arguments=(inspect-run-state --config "$TRACKING_CONFIG_PATH" --state-ref "$TRACKING_STATE_REF")
if [[ -n "$TRACKING_RUN_ID" ]]; then
  remote_ref="$(git ls-remote origin "refs/heads/$TRACKING_STATE_REF")"
  if [[ -n "$remote_ref" ]]; then
    state_revision="${remote_ref%%$'\t'*}"
    if [[ ! "$state_revision" =~ ^[0-9a-f]{40}$ ]]; then
      echo "再開するremote state revisionが不正です" >&2
      exit 1
    fi
    arguments+=(--run-id "$TRACKING_RUN_ID" --state-revision "$state_revision")
  fi
fi
node --enable-source-maps artifacts/workflow/runtime/tracker-run.mjs "${arguments[@]}" > "$RUNNER_TEMP/tracking-stage-bootstrap.json"
protocol_version="$(jq -r '.recoveryInput.protocolVersion // 1' "$RUNNER_TEMP/tracking-stage-bootstrap.json")"
if [[ "$protocol_version" == '2' ]]; then
  run_id="$(jq -r '.recoveryInput.runId' "$RUNNER_TEMP/tracking-stage-bootstrap.json")"
  if [[ -n "$TRACKING_RUN_ID" && "$run_id" != "$TRACKING_RUN_ID" ]]; then
    echo "V2回復対象のrun IDが一致しません" >&2
    exit 1
  fi
  node --enable-source-maps artifacts/workflow/runtime/tracker-run.mjs runtime-recovery-v2 --operation inspect --config "$TRACKING_CONFIG_PATH" --state-ref "$TRACKING_STATE_REF" --run-id "$run_id" --run-attempt "$GITHUB_RUN_ATTEMPT" --bundle-root artifacts/workflow/runtime > "$RUNNER_TEMP/tracking-v2-inspect.json"
  jq -cnS --slurpfile result "$RUNNER_TEMP/tracking-v2-inspect.json" '{schemaVersion:1,runId:$result[0].runId,nextStage:$result[0].nextStage}' > "$RUNNER_TEMP/tracking-route.json"
elif [[ "$protocol_version" == '1' ]]; then
  arguments=(route-stage --config "$TRACKING_CONFIG_PATH" --state-ref "$TRACKING_STATE_REF" --effect-target "$TRACKING_EFFECT_TARGET")
  if [[ -n "$TRACKING_RUN_ID" ]]; then
    arguments+=(--run-id "$TRACKING_RUN_ID")
  fi
  node --enable-source-maps artifacts/workflow/runtime/tracker-run.mjs "${arguments[@]}" > "$RUNNER_TEMP/tracking-route.json"
else
  echo "未対応のruntime protocolです" >&2
  exit 1
fi
jq -e '.schemaVersion == 1 and (.nextStage | IN("analyze", "commit-initial-state", "prepare-initial-pages", "preflight-initial-pages-deployment", "settle-notifications", "finalize-run", "prepare-history-pages", "preflight-history-pages-deployment", "complete", "done"))' "$RUNNER_TEMP/tracking-route.json" > /dev/null
run_id="$(jq -r '.runId // ""' "$RUNNER_TEMP/tracking-route.json")"
echo "run_id=$run_id" >> "$GITHUB_OUTPUT"
echo "run_suffix=${run_id#tracker-run:}" >> "$GITHUB_OUTPUT"
echo "next_stage=$(jq -r '.nextStage' "$RUNNER_TEMP/tracking-route.json")" >> "$GITHUB_OUTPUT"
echo "protocol_version=$protocol_version" >> "$GITHUB_OUTPUT"
