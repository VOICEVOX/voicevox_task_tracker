#!/usr/bin/env bash

set -euo pipefail

next_scenario="$1"
action="$2"
outcome="$3"
prior="$SANDBOX_NOTIFICATION_PRIOR_JSON"
if [[ "$SANDBOX_CONTINUITY_PHASE" != 'second' ]]; then
  coverage_digest="sha256:$(sha256sum "$SANDBOX_COVERAGE_PATH" | cut -d' ' -f1)"
  prior="$(jq -cn \
    --argjson previous "$prior" \
    --arg scenarioId "$SANDBOX_SCENARIO_ID" \
    --arg actionsRunId "$GITHUB_RUN_ID" \
    --argjson actionsRunAttempt "$GITHUB_RUN_ATTEMPT" \
    --arg environmentId "$SANDBOX_ENVIRONMENT_ID" \
    --arg finalStateRevision "$SANDBOX_FINAL_REVISION" \
    --arg coverageDigest "$coverage_digest" \
    '$previous + [{scenarioId: $scenarioId, actionsRunId: $actionsRunId, actionsRunAttempt: $actionsRunAttempt, environmentId: $environmentId, finalStateRevision: $finalStateRevision, coverageDigest: $coverageDigest}]')"
fi
control="$(jq -cn --arg outcome "$outcome" --argjson prior "$prior" '{outcome: $outcome, messageIndex: 0, notification: {phase: "first", prior: $prior}}')"
gh workflow run sandbox.yml --repo "$GITHUB_REPOSITORY" --ref "$GITHUB_REF_NAME" \
  -f operation=reset \
  -f source_ref="$SANDBOX_SOURCE_REF" \
  -f environment_id="$SANDBOX_ENVIRONMENT_ID" \
  -f reset_source=seed \
  -f analysis_mode=normal \
  -f notification_action="$action" \
  -f scenario_id="$next_scenario" \
  -f recording_control="$control"
