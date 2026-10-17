#!/usr/bin/env bash

set -euo pipefail

case "$1" in
  verify-ready)
    remote_revision="$2"
    expected_final="$SANDBOX_EXPECTED_BASE_REVISION"
    [[ "$expected_final" =~ ^[0-9a-f]{40}$ && -s "$SANDBOX_FIRST_RESULT_PATH" && -s "$SANDBOX_FIRST_COVERAGE_PATH" ]] ||
      { echo 'first完了証拠がありません' >&2; exit 1; }
    manifest="$(git show "$remote_revision:state/sandbox-environment.json")"
    if ! [[ "$(git rev-parse "${remote_revision}^")" == "$expected_final" ]] ||
      [[ "$(git diff --name-only "$expected_final" "$remote_revision")" != 'state/sandbox-environment.json' ]] ||
      [[ "$(jq -r '.lifecycle.completion.finalStateRevision' <<< "$manifest")" != "$expected_final" ]] ||
      [[ "$(jq -r '.lifecycle.completion.resultDigest' <<< "$manifest")" != "sha256:$(sha256sum "$SANDBOX_FIRST_RESULT_PATH" | cut -d' ' -f1)" ]] ||
      [[ "$(jq -r '.lifecycle.completion.coverage.digest' <<< "$manifest")" != "sha256:$(sha256sum "$SANDBOX_FIRST_COVERAGE_PATH" | cut -d' ' -f1)" ]] ||
      [[ "$(jq -r '.lifecycle.completion.trackingRunId' <<< "$manifest")" != "$(jq -r '.trackingRunId' "$SANDBOX_FIRST_RESULT_PATH")" ]] ||
      [[ "$(jq -r '.lifecycle.completion.actionsRunId' <<< "$manifest")" != "$(jq -r '.actionsRunId' "$SANDBOX_FIRST_RESULT_PATH")" ]] ||
      [[ "$(jq -r '.lifecycle.completion.actionsRunAttempt' <<< "$manifest")" != "$(jq -r '.actionsRunAttempt' "$SANDBOX_FIRST_RESULT_PATH")" ]] ||
      [[ "$(jq -r '.lifecycle.owner.actionsRunId' <<< "$manifest")" != "$(jq -r '.actionsRunId' "$SANDBOX_FIRST_RESULT_PATH")" ]] ||
      [[ "$(jq -r '.lifecycle.owner.actionsRunAttempt' <<< "$manifest")" != "$(jq -r '.actionsRunAttempt' "$SANDBOX_FIRST_RESULT_PATH")" ]] ||
      [[ "$(jq -r '.lifecycle.owner.codeRevision' <<< "$manifest")" != "$(jq -r '.codeRevision' "$SANDBOX_FIRST_RESULT_PATH")" ]]; then
      echo 'continuity secondのready manifestとfirst完了証拠が一致しません' >&2
      exit 1
    fi
    ;;
  verify-first)
    gh api "repos/$GITHUB_REPOSITORY/actions/runs/$SANDBOX_FIRST_RUN_ID" |
      jq -e --arg branch "$GITHUB_REF_NAME" --arg sha "$GITHUB_SHA" \
        '.conclusion == "success" and .head_branch == $branch and .head_sha == $sha' >/dev/null
    node .github/scripts/sandbox-coverage.mjs verify-first
    ;;
  snapshot)
    state_root="$2"
    ready_revision="$3"
    first_final="$4"
    second_final="$5"
    snapshot_path="$6"
    if [[ "$(git -C "$state_root" rev-parse "${ready_revision}^")" != "$first_final" ]] ||
      [[ "$(git -C "$state_root" diff --name-only "$first_final" "$ready_revision")" != 'state/sandbox-environment.json' ]] ||
      ! git -C "$state_root" merge-base --is-ancestor "$ready_revision" "$second_final"; then
      echo 'F1、R1、F2の連鎖が一致しません' >&2
      exit 1
    fi
    git -C "$state_root" show "$first_final:state/snapshot.json" > "$snapshot_path"
    ;;
  *)
    echo 'continuity source proof commandが不正です' >&2
    exit 1
    ;;
esac
