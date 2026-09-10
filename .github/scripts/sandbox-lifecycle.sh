#!/usr/bin/env bash

set -euo pipefail

readonly EXPECTED_REPOSITORY="Hiroshiba/voicevox_task_tracker"
readonly UPSTREAM_REPOSITORY="VOICEVOX/voicevox_task_tracker"
readonly UPSTREAM_STATE_BRANCH="tracker-state"
readonly STATE_BRANCH_PREFIX="sandbox-state"
readonly MANIFEST_PATH="state/sandbox-environment.json"
readonly ZERO_OBJECT_ID="0000000000000000000000000000000000000000"
readonly REVISION_PATTERN='^[0-9a-f]{40}$|^[0-9a-f]{64}$'
readonly ENVIRONMENT_ID_PATTERN='^env-[1-9][0-9]*-[1-9][0-9]*$'
readonly READ_RETRY_ATTEMPTS=3
readonly READ_RETRY_DELAY_SECONDS=2
readonly ANALYSIS_ELEMENTS_JSON='["status","waitingOn","nextAction","relations","progress","importance","deadline","notification"]'

die() {
  echo "$1" >&2
  exit 1
}

require_environment() {
  local name="$1"
  local value="${!name-}"
  if [[ -z "$value" ]]; then
    die "${name}が必要です"
  fi
}

require_absolute_path() {
  local name="$1"
  local value="${!name-}"
  require_environment "$name"
  if [[ "$value" != /* ]]; then
    die "${name}は絶対パスにしてください"
  fi
}

validate_repository() {
  require_environment GITHUB_REPOSITORY
  if [[ "$GITHUB_REPOSITORY" != "$EXPECTED_REPOSITORY" ]]; then
    die "sandbox workflowは${EXPECTED_REPOSITORY}でだけ実行できます"
  fi
  local origin_url normalized_url fetch_urls push_urls
  fetch_urls="$(git remote get-url --all origin 2>/dev/null)" || die "origin remoteを取得できません"
  if [[ -z "$fetch_urls" ]]; then
    die "origin remoteを取得できません"
  fi
  while IFS= read -r origin_url; do
    normalized_url="${origin_url%.git}"
    normalized_url="${normalized_url%/}"
    case "$normalized_url" in
      "git@github.com:${EXPECTED_REPOSITORY}"|"https://github.com/${EXPECTED_REPOSITORY}"|"ssh://git@github.com/${EXPECTED_REPOSITORY}") ;;
      *) die "origin remoteがsandbox forkではありません" ;;
    esac
  done <<< "$fetch_urls"
  push_urls="$(git remote get-url --push --all origin 2>/dev/null)" || die "originのpush remoteを取得できません"
  if [[ -z "$push_urls" ]]; then
    die "originのpush remoteを取得できません"
  fi
  while IFS= read -r origin_url; do
    normalized_url="${origin_url%.git}"
    normalized_url="${normalized_url%/}"
    case "$normalized_url" in
      "git@github.com:${EXPECTED_REPOSITORY}"|"https://github.com/${EXPECTED_REPOSITORY}"|"ssh://git@github.com/${EXPECTED_REPOSITORY}") ;;
      *) die "originのpush remoteがsandbox forkではありません" ;;
    esac
  done <<< "$push_urls"
}

validate_run_identity() {
  require_environment GITHUB_RUN_ID
  require_environment GITHUB_RUN_ATTEMPT
  if [[ ! "$GITHUB_RUN_ID" =~ ^[1-9][0-9]*$ ]]; then
    die "GITHUB_RUN_IDが不正です"
  fi
  if [[ ! "$GITHUB_RUN_ATTEMPT" =~ ^[1-9][0-9]*$ ]]; then
    die "GITHUB_RUN_ATTEMPTが不正です"
  fi
}

validate_environment_id() {
  local environment_id="$1"
  if [[ ! "$environment_id" =~ $ENVIRONMENT_ID_PATTERN ]]; then
    die "environment IDが不正です"
  fi
}

validate_revision() {
  local revision="$1"
  if [[ ! "$revision" =~ $REVISION_PATTERN ]]; then
    die "Git revisionが不正です"
  fi
}

validate_source_ref() {
  local source_ref="$1"
  if [[ -z "$source_ref" ]]; then
    die "source_refが必要です"
  fi
  if [[ "$source_ref" == sandbox-state/* || "$source_ref" == refs/* ]]; then
    die "source_refにはforkの作業branchを指定してください"
  fi
  if [[ ! "$source_ref" =~ ^[A-Za-z0-9._/-]+$ || "$source_ref" == /* || "$source_ref" == */ || "$source_ref" == *//* || "$source_ref" == *..* ]]; then
    die "source_refの形式が不正です"
  fi
  if ! git check-ref-format --branch "$source_ref" >/dev/null 2>&1; then
    die "source_refがGit branch名として不正です"
  fi
}

source_branch_revision() {
  local source_ref="$1"
  validate_source_ref "$source_ref"
  local branch_revision
  if ! branch_revision="$(git rev-parse --verify "refs/remotes/origin/${source_ref}^{commit}")"; then
    die "source_refのfork branchをcheckoutできません"
  fi
  validate_revision "$branch_revision"
  local code_revision
  if ! code_revision="$(git rev-parse --verify 'HEAD^{commit}')"; then
    die "checkoutしたコードのcommit SHAを取得できません"
  fi
  validate_revision "$code_revision"
  if [[ "$branch_revision" != "$code_revision" ]]; then
    die "checkoutしたコードのcommit SHAがsource_refのfork branchと一致しません"
  fi
  printf '%s\n' "$code_revision"
}

validate_operation_inputs() {
  require_environment SANDBOX_OPERATION
  case "$SANDBOX_OPERATION" in
    create|continue|reset|dispose) ;;
    *) die "SANDBOX_OPERATIONが不正です" ;;
  esac
  local source_ref="${SANDBOX_SOURCE_REF-}"
  local environment_id="${SANDBOX_ENVIRONMENT_ID-}"
  case "$SANDBOX_OPERATION" in
    create)
      if [[ -n "$environment_id" ]]; then
        die "createではenvironment IDを指定できません"
      fi
      if [[ -z "$source_ref" ]]; then
        source_ref=main
      fi
      validate_source_ref "$source_ref"
      ;;
    continue)
      validate_environment_id "$environment_id"
      validate_source_ref "$source_ref"
      ;;
    reset)
      validate_environment_id "$environment_id"
      validate_source_ref "$source_ref"
      case "${SANDBOX_RESET_SOURCE-}" in
        seed|latest) ;;
        *) die "reset_sourceにはseedまたはlatestを指定してください" ;;
      esac
      ;;
    dispose)
      validate_environment_id "$environment_id"
      if [[ -n "$source_ref" ]]; then
        die "disposeではsource_refを指定できません"
      fi
      ;;
  esac
}

remote_branch_head() {
  remote_branch_head_from origin origin "$1"
}

remote_branch_head_from() {
  local remote="$1"
  local remote_label="$2"
  local branch="$3"
  local output=""
  local status=0
  local attempt
  for ((attempt = 1; attempt <= READ_RETRY_ATTEMPTS; attempt += 1)); do
    if output="$(git ls-remote --exit-code --heads "$remote" "refs/heads/${branch}")"; then
      break
    else
      status=$?
    fi
    if [[ "$status" -eq 2 ]]; then
      return 2
    fi
    if [[ "$attempt" -eq "$READ_RETRY_ATTEMPTS" ]]; then
      die "${remote_label}の${branch} branch headを取得できません"
    fi
    sleep "$READ_RETRY_DELAY_SECONDS"
  done
  if [[ "$output" == *$'\n'* || "$output" != *$'\t'* ]]; then
    die "${remote_label}のbranch head応答が不正です"
  fi
  local revision="${output%%$'\t'*}"
  local ref="${output#*$'\t'}"
  if [[ "$ref" != "refs/heads/${branch}" ]]; then
    die "${remote_label}のbranch head参照が一致しません"
  fi
  validate_revision "$revision"
  echo "$revision"
}

fetch_remote_branch() {
  local branch="$1"
  local status=0
  local attempt
  for ((attempt = 1; attempt <= READ_RETRY_ATTEMPTS; attempt += 1)); do
    if remote_branch_head "$branch" >/dev/null; then
      :
    else
      status=$?
      if [[ "$status" -eq 2 ]]; then
        die "originの${branch} branchがありません"
      fi
      die "originの${branch} branch headを取得できません"
    fi
    if git fetch --no-tags origin "refs/heads/${branch}:refs/heads/${branch}" >/dev/null; then
      return
    fi
    if [[ "$attempt" -eq "$READ_RETRY_ATTEMPTS" ]]; then
      die "originの${branch} branchを取得できません"
    fi
    sleep "$READ_RETRY_DELAY_SECONDS"
  done
}

upstream_state_head() {
  local upstream_url="https://github.com/${UPSTREAM_REPOSITORY}.git"
  local status=0
  local attempt
  for ((attempt = 1; attempt <= READ_RETRY_ATTEMPTS; attempt += 1)); do
    if remote_branch_head_from "$upstream_url" upstream "$UPSTREAM_STATE_BRANCH" >/dev/null; then
      :
    else
      status=$?
      if [[ "$status" -eq 2 ]]; then
        die "upstreamの${UPSTREAM_STATE_BRANCH} branchがありません"
      fi
      die "upstreamの${UPSTREAM_STATE_BRANCH} branch headを取得できません"
    fi
    if git fetch --no-tags "$upstream_url" \
      "refs/heads/${UPSTREAM_STATE_BRANCH}:refs/remotes/sandbox-upstream/${UPSTREAM_STATE_BRANCH}" >/dev/null; then
      break
    fi
    if [[ "$attempt" -eq "$READ_RETRY_ATTEMPTS" ]]; then
      die "upstreamの${UPSTREAM_STATE_BRANCH} branchを取得できません"
    fi
    sleep "$READ_RETRY_DELAY_SECONDS"
  done
  local revision
  revision="$(git rev-parse "refs/remotes/sandbox-upstream/${UPSTREAM_STATE_BRANCH}")"
  validate_revision "$revision"
  echo "$revision"
}

manifest_source() {
  local revision="$1"
  local source
  if ! source="$(git show "${revision}:${MANIFEST_PATH}")"; then
    die "sandbox environment manifestがありません"
  fi
  if ! jq -e --arg expected_repository "$EXPECTED_REPOSITORY" --arg environment_pattern "$ENVIRONMENT_ID_PATTERN" --arg revision_pattern "$REVISION_PATTERN" '
    type == "object" and
    ((keys | sort) == ["environmentId", "schemaVersion", "seedRevision", "sourceRef", "sourceRepository"]) and
    .schemaVersion == 1 and
    (.environmentId | type == "string" and test($environment_pattern)) and
    (.sourceRepository | type == "string" and . == $expected_repository) and
    (.sourceRef | type == "string" and length > 0) and
    (.seedRevision | type == "string" and test($revision_pattern))
  ' <<< "$source" >/dev/null; then
    die "sandbox environment manifestの形式が不正です"
  fi
  printf '%s' "$source"
}

manifest_environment_id() {
  jq -er '.environmentId' <<< "$1"
}

manifest_seed_revision() {
  jq -er '.seedRevision' <<< "$1"
}

manifest_source_ref_value() {
  jq -er '.sourceRef' <<< "$1"
}

validated_analysis_mode_json() {
  local analysis_mode="${SANDBOX_ANALYSIS_MODE-}"
  local forced_node_id="${SANDBOX_FORCED_NODE_ID-}"
  local forced_elements="${SANDBOX_FORCED_ELEMENTS-}"
  case "$analysis_mode" in
    normal)
      if [[ -n "$forced_node_id" || -n "$forced_elements" ]]; then
        die "normal modeではforced対象を指定できません"
      fi
      printf '%s\n' '{"kind":"normal"}'
      ;;
    forced)
      if [[ -z "$forced_node_id" || "$forced_node_id" =~ [[:space:]] ]]; then
        die "forced modeにはnode IDが必要です"
      fi
      if [[ -z "$forced_elements" ]]; then
        die "forced modeにはelementsが必要です"
      fi
      local elements_json
      elements_json="$(jq -ce \
        --arg value "$forced_elements" \
        --argjson allowed_elements "$ANALYSIS_ELEMENTS_JSON" \
        '
          ($value | split(",") | map(gsub("^[[:space:]]+|[[:space:]]+$"; ""))) as $elements |
          if ($elements | length) == 0 or
            any($elements[]; length == 0) or
            (($elements | unique | length) != ($elements | length)) or
            ((($elements - $allowed_elements) | length) != 0) then
            error("elementsが不正です")
          else
            $elements
          end
        ' <<< '{}')" || die "forced modeのelementsが不正です"
      jq -cn --arg node_id "$forced_node_id" --argjson elements "$elements_json" \
        '{kind: "forced", target: {nodeId: $node_id, elements: $elements}}'
      ;;
    *)
      die "SANDBOX_ANALYSIS_MODEが不正です"
      ;;
  esac
}

create_context_file() {
  require_absolute_path SANDBOX_CONTEXT_PATH
  local environment_id="$1"
  local source_ref="$2"
  local seed_revision="$3"
  local base_state_revision="$4"
  local code_revision="$5"
  local analysis_mode_json="$6"
  jq -cS -n \
    --arg environment_id "$environment_id" \
    --arg source_repository "$EXPECTED_REPOSITORY" \
    --arg source_ref "$source_ref" \
    --arg seed_revision "$seed_revision" \
    --arg code_revision "$code_revision" \
    --arg base_state_revision "$base_state_revision" \
    --arg workflow_run_id "$GITHUB_RUN_ID" \
    --arg workflow_run_attempt "$GITHUB_RUN_ATTEMPT" \
    --argjson analysis_mode "$analysis_mode_json" '
      {
        schemaVersion: 1,
        environmentId: $environment_id,
        sourceRepository: $source_repository,
        sourceRef: $source_ref,
        seedRevision: $seed_revision,
        codeRevision: $code_revision,
        baseStateRevision: $base_state_revision,
        workflowRunId: $workflow_run_id,
        workflowRunAttempt: ($workflow_run_attempt | tonumber),
        analysisMode: $analysis_mode
      }
    ' > "$SANDBOX_CONTEXT_PATH"
  chmod 600 "$SANDBOX_CONTEXT_PATH"
}

create_manifest_commit() {
  local seed_revision="$1"
  local environment_id="$2"
  local source_ref="$3"
  local branch="$4"
  local manifest_file="${RUNNER_TEMP}/sandbox-environment-${environment_id}.json"
  local index_file="${RUNNER_TEMP}/sandbox-environment-${environment_id}.index"
  local committed_at
  committed_at="$(date -u +'%Y-%m-%dT%H:%M:%S.000Z')"
  jq -cS -n \
    --arg environment_id "$environment_id" \
    --arg source_repository "$EXPECTED_REPOSITORY" \
    --arg source_ref "$source_ref" \
    --arg seed_revision "$seed_revision" \
    '{schemaVersion: 1, environmentId: $environment_id, sourceRepository: $source_repository, sourceRef: $source_ref, seedRevision: $seed_revision}' \
    > "$manifest_file"
  rm -f -- "$index_file"
  GIT_INDEX_FILE="$index_file" git read-tree "$seed_revision"
  local manifest_blob
  manifest_blob="$(git hash-object -w --stdin < "$manifest_file")"
  GIT_INDEX_FILE="$index_file" git update-index --add --cacheinfo 100644 "$manifest_blob" "$MANIFEST_PATH"
  local tree_revision
  tree_revision="$(GIT_INDEX_FILE="$index_file" git write-tree)"
  local commit_revision
  commit_revision="$(printf 'sandbox environment %s\n' "$environment_id" | GIT_AUTHOR_DATE="$committed_at" GIT_AUTHOR_EMAIL='voicevox-task-tracker@users.noreply.github.com' GIT_AUTHOR_NAME='VOICEVOX Task Tracker' GIT_COMMITTER_DATE="$committed_at" GIT_COMMITTER_EMAIL='voicevox-task-tracker@users.noreply.github.com' GIT_COMMITTER_NAME='VOICEVOX Task Tracker' git commit-tree "$tree_revision" -p "$seed_revision")"
  validate_revision "$commit_revision"
  git update-ref "refs/heads/${branch}" "$commit_revision" "$ZERO_OBJECT_ID"
  rm -f -- "$index_file" "$manifest_file"
  if ! git push --no-follow-tags origin "${commit_revision}:refs/heads/${branch}" >/dev/null; then
    die "sandbox state branchの初期pushに失敗しました"
  fi
  local remote_revision
  remote_revision="$(remote_branch_head "$branch")"
  if [[ "$remote_revision" != "$commit_revision" ]]; then
    die "sandbox state branchの初期push後headが一致しません"
  fi
  echo "$commit_revision"
}

write_output() {
  local name="$1"
  local value="$2"
  require_environment GITHUB_OUTPUT
  printf '%s=%s\n' "$name" "$value" >> "$GITHUB_OUTPUT"
}

prepare_create_or_reset() {
  local source_ref="$1"
  local code_revision="$2"
  local analysis_mode_json="$3"
  local operation="$SANDBOX_OPERATION"
  local target_environment_id="${SANDBOX_ENVIRONMENT_ID-}"
  local environment_id="env-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}"
  validate_environment_id "$environment_id"
  local seed_revision
  if [[ "$operation" == create ]]; then
    seed_revision="$(upstream_state_head)"
  else
    local source_branch="${STATE_BRANCH_PREFIX}/${target_environment_id}"
    local source_remote_head
    source_remote_head="$(remote_branch_head "$source_branch")"
    fetch_remote_branch "$source_branch"
    local source_manifest
    source_manifest="$(manifest_source "$source_remote_head")"
    if [[ "$(manifest_environment_id "$source_manifest")" != "$target_environment_id" ]]; then
      die "reset対象のmanifest environment IDが一致しません"
    fi
    validate_source_ref "$(manifest_source_ref_value "$source_manifest")"
    if [[ "$SANDBOX_RESET_SOURCE" == latest ]]; then
      seed_revision="$(upstream_state_head)"
    else
      seed_revision="$(manifest_seed_revision "$source_manifest")"
    fi
    if ! git cat-file -e "${seed_revision}^{commit}" 2>/dev/null; then
      die "reset元manifestのseed revisionが取得できません"
    fi
  fi
  validate_revision "$seed_revision"
  local branch="${STATE_BRANCH_PREFIX}/${environment_id}"
  if remote_branch_head "$branch" >/dev/null; then
    die "新しいsandbox state branchが既に存在します"
  else
    local status=$?
    if [[ "$status" -ne 2 ]]; then
      die "新しいsandbox state branchの存在確認に失敗しました"
    fi
  fi
  if git show-ref --verify --quiet "refs/heads/${branch}"; then
    die "新しいsandbox state branchのlocal refが既に存在します"
  fi
  local base_state_revision
  base_state_revision="$(create_manifest_commit "$seed_revision" "$environment_id" "$source_ref" "$branch")"
  create_context_file \
    "$environment_id" "$source_ref" "$seed_revision" "$base_state_revision" "$code_revision" \
    "$analysis_mode_json"
  write_output environment_id "$environment_id"
  write_output state_branch "$branch"
  write_output seed_revision "$seed_revision"
  write_output base_state_revision "$base_state_revision"
  write_output code_revision "$code_revision"
  write_output context_path "$SANDBOX_CONTEXT_PATH"
}

prepare_continue() {
  local source_ref="$1"
  local code_revision="$2"
  local analysis_mode_json="$3"
  local environment_id="$SANDBOX_ENVIRONMENT_ID"
  local branch="${STATE_BRANCH_PREFIX}/${environment_id}"
  local remote_revision
  remote_revision="$(remote_branch_head "$branch")"
  fetch_remote_branch "$branch"
  local manifest
  manifest="$(manifest_source "$remote_revision")"
  if [[ "$(manifest_environment_id "$manifest")" != "$environment_id" ]]; then
    die "continue対象のmanifest environment IDが一致しません"
  fi
  local manifest_source_ref
  manifest_source_ref="$(manifest_source_ref_value "$manifest")"
  if [[ "$manifest_source_ref" != "$source_ref" ]]; then
    die "continue対象のsource_refがmanifestと一致しません"
  fi
  local seed_revision
  seed_revision="$(manifest_seed_revision "$manifest")"
  create_context_file \
    "$environment_id" "$source_ref" "$seed_revision" "$remote_revision" "$code_revision" \
    "$analysis_mode_json"
  write_output environment_id "$environment_id"
  write_output state_branch "$branch"
  write_output seed_revision "$seed_revision"
  write_output base_state_revision "$remote_revision"
  write_output code_revision "$code_revision"
  write_output context_path "$SANDBOX_CONTEXT_PATH"
}

prepare() {
  validate_repository
  validate_run_identity
  validate_operation_inputs
  require_absolute_path RUNNER_TEMP
  require_absolute_path SANDBOX_CONTEXT_PATH
  require_environment SANDBOX_ANALYSIS_MODE
  local analysis_mode_json
  analysis_mode_json="$(validated_analysis_mode_json)"
  local source_ref="${SANDBOX_SOURCE_REF-}"
  if [[ "$SANDBOX_OPERATION" == create && -z "$source_ref" ]]; then
    source_ref=main
  fi
  local code_revision
  case "$SANDBOX_OPERATION" in
    create|reset)
      code_revision="$(source_branch_revision "$source_ref")"
      prepare_create_or_reset "$source_ref" "$code_revision" "$analysis_mode_json"
      ;;
    continue)
      code_revision="$(source_branch_revision "$source_ref")"
      prepare_continue "$source_ref" "$code_revision" "$analysis_mode_json"
      ;;
    dispose) die "disposeはprepareではなくdispose commandで実行してください" ;;
  esac
}

finalize() {
  validate_repository
  validate_run_identity
  require_environment SANDBOX_OPERATION
  if [[ "$SANDBOX_OPERATION" == dispose ]]; then
    die "disposeはfinalizeではなくdispose commandで実行してください"
  fi
  require_environment SANDBOX_ENVIRONMENT_ID
  validate_environment_id "$SANDBOX_ENVIRONMENT_ID"
  local branch="${STATE_BRANCH_PREFIX}/${SANDBOX_ENVIRONMENT_ID}"
  local local_revision
  local_revision="$(git rev-parse "refs/heads/${branch}")" || die "sandbox state branchのlocal headを取得できません"
  validate_revision "$local_revision"
  local remote_revision
  remote_revision="$(remote_branch_head "$branch")"
  if [[ "$remote_revision" != "$local_revision" ]]; then
    die "sandbox state branchの完了publish後headが一致しません"
  fi
  write_output state_revision "$local_revision"
}

dispose() {
  validate_repository
  validate_run_identity
  validate_operation_inputs
  local environment_id="$SANDBOX_ENVIRONMENT_ID"
  local branch="${STATE_BRANCH_PREFIX}/${environment_id}"
  local remote_revision
  remote_revision="$(remote_branch_head "$branch")"
  fetch_remote_branch "$branch"
  local manifest
  manifest="$(manifest_source "$remote_revision")"
  if [[ "$(manifest_environment_id "$manifest")" != "$environment_id" ]]; then
    die "dispose対象のmanifest environment IDが一致しません"
  fi
  if ! git push --no-follow-tags --force-with-lease="refs/heads/${branch}:${remote_revision}" origin ":refs/heads/${branch}"; then
    die "sandbox state branchの削除に失敗しました"
  fi
  if remote_branch_head "$branch" >/dev/null; then
    die "sandbox state branchが削除されていません"
  else
    local status=$?
    if [[ "$status" -ne 2 ]]; then
      die "sandbox state branch削除後の確認に失敗しました"
    fi
  fi
  write_output environment_id "$environment_id"
  write_output deleted_revision "$remote_revision"
}

if [[ "$#" -ne 1 ]]; then
  die "sandbox-lifecycleにはprepare、finalize、disposeのいずれかを指定してください"
fi

case "$1" in
  prepare) prepare ;;
  finalize) finalize ;;
  dispose) dispose ;;
  *) die "sandbox-lifecycleにはprepare、finalize、disposeのいずれかを指定してください" ;;
esac
