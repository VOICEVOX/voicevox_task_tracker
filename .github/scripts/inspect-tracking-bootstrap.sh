#!/usr/bin/env bash
set -euo pipefail

case "$TRACKING_EFFECT_TARGET" in
  production)
    if [[ "$TRACKING_STATE_REF" != 'tracker-state' || "$TRACKING_EFFECT_CONCURRENCY_KEY" != 'voicevox-task-tracker-daily' || "$TRACKING_PAGES_ENVIRONMENT" != 'github-pages' || -n "$TRACKING_SANDBOX_CONTEXT_ARTIFACT" || -n "$TRACKING_SOURCE_CODE_REVISION" ]]; then
      echo "productionのstate、Pages、排他keyが一致しません" >&2
      exit 1
    fi
    ;;
  sandbox)
    if [[ "$GITHUB_REPOSITORY" != 'Hiroshiba/voicevox_task_tracker' || ! "$TRACKING_STATE_REF" =~ ^sandbox-state/env-[1-9][0-9]*-[1-9][0-9]*$ || "$TRACKING_EFFECT_CONCURRENCY_KEY" != "sandbox-$GITHUB_REPOSITORY-${TRACKING_STATE_REF#sandbox-state/}" || "$TRACKING_PAGES_ENVIRONMENT" != "sandbox-${TRACKING_STATE_REF#sandbox-state/}" || -z "$TRACKING_SANDBOX_CONTEXT_ARTIFACT" || ! "$TRACKING_SOURCE_CODE_REVISION" =~ ^[0-9a-f]{40}$ ]]; then
      echo "sandboxのstate、Pages、排他key、sourceが一致しません" >&2
      exit 1
    fi
    ;;
  *)
    echo "workflowのeffect targetが不正です" >&2
    exit 1
    ;;
esac

node --enable-source-maps dist/cli/tracker-run.js inspect-run-state --config "$TRACKING_CONFIG_PATH" --state-ref "$TRACKING_STATE_REF" > "$RUNNER_TEMP/tracking-bootstrap.json"
kind="$(jq -r '.kind' "$RUNNER_TEMP/tracking-bootstrap.json")"
case "$kind" in
  start_with_current_runtime)
    code_revision="${TRACKING_SOURCE_CODE_REVISION:-$GITHUB_SHA}"
    node_version="$(cat .node-version)"
    source_run_id=""
    run_id=""
    protocol_version=""
    ;;
  resume_with_exact_runtime)
    jq -e '.recoveryInput.runtimeRecoveryPlan.kind == "workflow_bundle" and (.recoveryInput.protocolVersion | IN(1, 2))' "$RUNNER_TEMP/tracking-bootstrap.json" > /dev/null
    code_revision="$(jq -r '.recoveryInput.runtimeRecoveryPlan.codeRevision' "$RUNNER_TEMP/tracking-bootstrap.json")"
    node_version="$(jq -r '.recoveryInput.runtimeRecoveryPlan.toolchain.nodeVersion | ltrimstr("v")' "$RUNNER_TEMP/tracking-bootstrap.json")"
    source_run_id="$(jq -r '.recoveryInput.runtimeRecoveryPlan.workflowRunId' "$RUNNER_TEMP/tracking-bootstrap.json")"
    run_id="$(jq -r '.recoveryInput.runId' "$RUNNER_TEMP/tracking-bootstrap.json")"
    protocol_version="$(jq -r '.recoveryInput.protocolVersion' "$RUNNER_TEMP/tracking-bootstrap.json")"
    expected_identity="$(jq -r '.recoveryInput.expectedWorkflowEffectAdapterIdentityDigest' "$RUNNER_TEMP/tracking-bootstrap.json")"
    if [[ "$protocol_version" == '1' ]]; then
      current_identity="$(node --input-type=module -e "import { workflowAdapterIdentity } from './dist/infrastructure/tracking-run/publication-runtime.js'; import { nodeContentDigestPort } from './dist/infrastructure/tracking-run/content-digest.js'; process.stdout.write(await workflowAdapterIdentity(process.cwd(), nodeContentDigestPort));")"
      if [[ "$current_identity" != "$expected_identity" ]]; then
        echo "実行中workflowの効果adapterが保留runの記録と一致しません" >&2
        exit 1
      fi
    fi
    ;;
  *)
    echo "永続stateから安全なruntimeを選べません。種別: $kind" >&2
    exit 1
    ;;
esac
if [[ -n "$TRACKING_EXPECTED_RUN_ID" ]]; then
  jq -e --arg run_id "$TRACKING_EXPECTED_RUN_ID" '.kind == "resume_with_exact_runtime" and .recoveryInput.runId == $run_id' "$RUNNER_TEMP/tracking-bootstrap.json" > /dev/null
fi
{
  echo "kind=$kind"
  echo "code_revision=$code_revision"
  echo "node_version=$node_version"
  echo "source_run_id=$source_run_id"
  echo "run_id=$run_id"
  echo "protocol_version=$protocol_version"
  if [[ "$kind" == 'resume_with_exact_runtime' ]]; then
    echo "expected_identity=$expected_identity"
  fi
} >> "$GITHUB_OUTPUT"
