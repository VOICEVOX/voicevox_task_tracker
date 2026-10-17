#!/usr/bin/env bash

set -euo pipefail

control="$(cat "$RUNNER_TEMP/continuity-second-control.json")"
if [[ "$SANDBOX_SCENARIO_ID" != continuity && "$SANDBOX_SCENARIO_ID" != continuity-strict-zero ]]; then
  echo 'continuity scenarioが不正です' >&2
  exit 1
fi
gh workflow run sandbox.yml --repo "$GITHUB_REPOSITORY" --ref "$GITHUB_REF_NAME" \
  -f operation=continue \
  -f source_ref="$SANDBOX_SOURCE_REF" \
  -f environment_id="$SANDBOX_ENVIRONMENT_ID" \
  -f analysis_mode=cache_probe \
  -f notification_action=send \
  -f scenario_id="$SANDBOX_SCENARIO_ID" \
  -f recording_control="$control"
