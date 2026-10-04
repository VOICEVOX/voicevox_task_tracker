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
readonly ANALYSIS_ELEMENTS_JSON='["status","waitingOn","nextAction","relations","progress","importance","deadline","notification","selfCommitment"]'

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
  require_environment GITHUB_SHA
  if [[ ! "$GITHUB_RUN_ID" =~ ^[1-9][0-9]*$ ]]; then
    die "GITHUB_RUN_IDが不正です"
  fi
  if [[ ! "$GITHUB_RUN_ATTEMPT" =~ ^[1-9][0-9]*$ ]]; then
    die "GITHUB_RUN_ATTEMPTが不正です"
  fi
  validate_revision "$GITHUB_SHA"
  local checkout_revision
  checkout_revision="$(git rev-parse --verify 'HEAD^{commit}')" || die "checkoutしたコードのcommit SHAを取得できません"
  if [[ "$checkout_revision" != "$GITHUB_SHA" ]]; then
    die "checkoutしたコードのcommit SHAがworkflow SHAと一致しません"
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
  if [[ "$branch_revision" != "$GITHUB_SHA" ]]; then
    die "source_refのfork branchがworkflow SHAと一致しません"
  fi
  printf '%s\n' "$code_revision"
}

validate_operation_inputs() {
  require_environment SANDBOX_OPERATION
  case "$SANDBOX_OPERATION" in
    create|continue|reset|dispose|recover-reset|resume-preparing) ;;
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
    continue|resume-preparing)
      validate_environment_id "$environment_id"
      validate_source_ref "$source_ref"
      ;;
    reset|recover-reset)
      validate_environment_id "$environment_id"
      validate_source_ref "$source_ref"
      if [[ "$SANDBOX_OPERATION" == reset ]]; then
        case "${SANDBOX_RESET_SOURCE-}" in
          seed|latest) ;;
          *) die "reset_sourceにはseedまたはlatestを指定してください" ;;
        esac
      fi
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
    (.schemaVersion == 1 or .schemaVersion == 2) and
    (.environmentId | type == "string" and test($environment_pattern)) and
    (.sourceRepository | type == "string" and . == $expected_repository) and
    (.sourceRef | type == "string" and length > 0) and
    (.seedRevision | type == "string" and test($revision_pattern)) and
    (if .schemaVersion == 1 then
      (keys | sort) == ["environmentId", "schemaVersion", "seedRevision", "sourceRef", "sourceRepository"]
    else
      (keys | sort) == ["environmentId", "lifecycle", "schemaVersion", "seedRevision", "sourceRef", "sourceRepository"] and
      (.lifecycle | type == "object" and
        (.status == "preparing" or .status == "ready") and
        (.owner | type == "object" and (keys | sort) == ["actionsRunAttempt", "actionsRunId", "codeRevision"]) and
        (.owner.actionsRunId | type == "string" and test("^[1-9][0-9]*$")) and
        (.owner.actionsRunAttempt | type == "number" and . > 0 and . == floor) and
        (.owner.codeRevision | type == "string" and test($revision_pattern)) and
        (.creation | type == "object" and
          (if .kind == "reset" then
            (keys | sort) == ["kind", "sourceEnvironmentId", "sourceHeadRevision"] and
            (.sourceEnvironmentId | type == "string" and test($environment_pattern)) and
            (.sourceHeadRevision | type == "string" and test($revision_pattern))
          else (.kind == "create" or .kind == "legacy") and (keys | sort) == ["kind"] end)) and
        (if .status == "preparing" then
          (keys | sort) == ["creation", "owner", "status"] and .creation.kind != "legacy"
        else
          (keys | sort) == ["completion", "creation", "owner", "status"] and
          (.completion | type == "object" and
            (keys | sort) == ["actionsRunAttempt", "actionsRunId", "coverage", "finalStateRevision", "resultDigest", "trackingRunId"] and
            (.actionsRunId | type == "string" and test("^[1-9][0-9]*$")) and
            (.actionsRunAttempt | type == "number" and . > 0 and . == floor) and
            (.finalStateRevision | type == "string" and test($revision_pattern)) and
            (.trackingRunId | type == "string" and test("^tracker-run:[0-9a-f]{64}$")) and
            (.resultDigest | type == "string" and test("^sha256:[0-9a-f]{64}$")) and
            (.coverage | type == "object" and
              (if .kind == "verified" then
                (keys | sort) == ["digest", "kind"] and
                (.digest | type == "string" and test("^sha256:[0-9a-f]{64}$"))
              else .kind == "not_required" and (keys | sort) == ["kind"] end)))
        end))
      end)
  ' <<< "$source" >/dev/null; then
    die "sandbox environment manifestの形式が不正です"
  fi
  if [[ "$(jq -cS . <<< "$source")" != "$source" ]]; then
    die "sandbox environment manifestがcanonical JSONではありません"
  fi
  printf '%s' "$source"
}

require_ready_manifest() {
  local manifest="$1"
  if [[ "$(jq -r '.lifecycle.status // "ready"' <<< "$manifest")" != ready ]]; then
    die "sandbox environmentは準備中です。continueとdisposeは実行できません"
  fi
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
  local reset_source_head="$5"
  local reset_source_environment_id="$6"
  local manifest_file="${RUNNER_TEMP}/sandbox-environment-${environment_id}.json"
  local index_file="${RUNNER_TEMP}/sandbox-environment-${environment_id}.index"
  local committed_at
  committed_at="$(date -u +'%Y-%m-%dT%H:%M:%S.000Z')"
  jq -cS -n \
    --arg environment_id "$environment_id" \
    --arg source_repository "$EXPECTED_REPOSITORY" \
    --arg source_ref "$source_ref" \
    --arg seed_revision "$seed_revision" \
    --arg code_revision "$GITHUB_SHA" \
    --arg actions_run_id "$GITHUB_RUN_ID" \
    --argjson actions_run_attempt "$GITHUB_RUN_ATTEMPT" \
    --arg reset_source_head "$reset_source_head" \
    --arg reset_source_environment_id "$reset_source_environment_id" \
    '{schemaVersion: 2, environmentId: $environment_id, sourceRepository: $source_repository, sourceRef: $source_ref, seedRevision: $seed_revision, lifecycle: {status: "preparing", owner: {actionsRunId: $actions_run_id, actionsRunAttempt: $actions_run_attempt, codeRevision: $code_revision}, creation: (if $reset_source_head == "" then {kind: "create"} else {kind: "reset", sourceEnvironmentId: $reset_source_environment_id, sourceHeadRevision: $reset_source_head} end)}}' \
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
  if ! git push --no-follow-tags --force-with-lease="refs/heads/${branch}:" origin "${commit_revision}:refs/heads/${branch}" >/dev/null; then
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
  local reset_source_head=""
  if [[ "$operation" == create ]]; then
    seed_revision="$(upstream_state_head)"
  else
    local source_branch="${STATE_BRANCH_PREFIX}/${target_environment_id}"
    local source_remote_head
    source_remote_head="$(remote_branch_head "$source_branch")"
    fetch_remote_branch "$source_branch"
    local source_manifest
    source_manifest="$(manifest_source "$source_remote_head")"
    require_ready_manifest "$source_manifest"
    if [[ "$(manifest_environment_id "$source_manifest")" != "$target_environment_id" ]]; then
      die "reset対象のmanifest environment IDが一致しません"
    fi
    validate_source_ref "$(manifest_source_ref_value "$source_manifest")"
    reset_source_head="$source_remote_head"
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
  base_state_revision="$(create_manifest_commit "$seed_revision" "$environment_id" "$source_ref" "$branch" "$reset_source_head" "$target_environment_id")"
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
  if [[ -n "${SANDBOX_EXPECTED_BASE_REVISION-}" && "$remote_revision" != "$SANDBOX_EXPECTED_BASE_REVISION" ]]; then
    die "continuity secondのremote base revisionがfirstのfinal revisionと一致しません"
  fi
  fetch_remote_branch "$branch"
  local manifest
  manifest="$(manifest_source "$remote_revision")"
  if [[ "$(manifest_environment_id "$manifest")" != "$environment_id" ]]; then
    die "continue対象のmanifest environment IDが一致しません"
  fi
  require_ready_manifest "$manifest"
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

prepare_resume_preparing() {
  local source_ref="$1"
  local analysis_mode_json="$2"
  local environment_id="$SANDBOX_ENVIRONMENT_ID"
  local branch="${STATE_BRANCH_PREFIX}/${environment_id}"
  local remote_revision
  remote_revision="$(remote_branch_head "$branch")"
  if [[ "$remote_revision" != "${SANDBOX_EXPECTED_BASE_REVISION-}" ]]; then
    die "復旧対象のpending revisionが一致しません"
  fi
  fetch_remote_branch "$branch"
  local manifest
  manifest="$(manifest_source "$remote_revision")"
  if [[ "$(manifest_environment_id "$manifest")" != "$environment_id" ]] ||
    [[ "$(jq -r '.lifecycle.status' <<< "$manifest")" != preparing ]] ||
    [[ "$(jq -r '.lifecycle.creation.kind' <<< "$manifest")" != reset ]] ||
    [[ "$(manifest_source_ref_value "$manifest")" != "$source_ref" ]]; then
    die "復旧対象のpreparing manifestが一致しません"
  fi
  local code_revision
  code_revision="$(jq -r '.lifecycle.owner.codeRevision' <<< "$manifest")"
  if ! git cat-file -e "${code_revision}^{commit}" 2>/dev/null ||
    ! git diff --quiet "$code_revision" "$GITHUB_SHA" -- \
      .github/workflows/_tracking-run.yml \
      .github/workflows/_tracking-pages.yml \
      .github/workflows/_tracking-observe.yml; then
    die "元reset runのworkflow adapterと現在の定義が一致しません"
  fi
  local source_environment_id source_head
  source_environment_id="$(jq -r '.lifecycle.creation.sourceEnvironmentId' <<< "$manifest")"
  source_head="$(remote_branch_head "${STATE_BRANCH_PREFIX}/${source_environment_id}")"
  if [[ "$source_head" != "$(jq -r '.lifecycle.creation.sourceHeadRevision' <<< "$manifest")" ]]; then
    die "reset元environmentのheadが変更されています"
  fi
  require_environment GH_TOKEN
  local owner_run_id owner_run_attempt
  owner_run_id="$(jq -r '.lifecycle.owner.actionsRunId' <<< "$manifest")"
  owner_run_attempt="$(jq -r '.lifecycle.owner.actionsRunAttempt' <<< "$manifest")"
  local owner_terminal=false
  local attempt
  for ((attempt = 1; attempt <= 12; attempt += 1)); do
    if gh api "repos/$GITHUB_REPOSITORY/actions/runs/$owner_run_id" |
      jq -e --arg sha "$code_revision" --arg branch "$source_ref" \
        --arg title "sandbox-reset-${source_environment_id}" \
        --argjson owner_attempt "$owner_run_attempt" '
        .status == "completed" and .run_attempt == $owner_attempt and .head_sha == $sha and
        .head_branch == $branch and .display_title == $title and .event == "workflow_dispatch"
      ' >/dev/null; then
      owner_terminal=true
      break
    fi
    sleep 5
  done
  if [[ "$owner_terminal" != true ]]; then
    die "元reset runと子effectの終了を確認できません"
  fi
  if ! gh api "repos/$GITHUB_REPOSITORY/actions/workflows/sandbox.yml/runs?status=in_progress&per_page=100" |
    jq -e --arg current "$GITHUB_RUN_ID" --arg old "$source_environment_id" --arg next "$environment_id" '
      .total_count <= 100 and all(.workflow_runs[];
        (.id | tostring) == $current or
        (.display_title != "sandbox task tracking" and
          (.display_title | endswith("-" + $old) | not) and
          (.display_title | endswith("-" + $next) | not)))
    ' >/dev/null; then
    die "旧環境または新環境の進行中sandbox effectを除外できません"
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
    continue|resume-preparing)
      code_revision="$(source_branch_revision "$source_ref")"
      if [[ "$SANDBOX_OPERATION" == continue ]]; then
        prepare_continue "$source_ref" "$code_revision" "$analysis_mode_json"
      else
        prepare_resume_preparing "$source_ref" "$analysis_mode_json"
      fi
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
  require_environment SANDBOX_EXPECTED_REVISION
  validate_environment_id "$SANDBOX_ENVIRONMENT_ID"
  validate_revision "$SANDBOX_EXPECTED_REVISION"
  local branch="${STATE_BRANCH_PREFIX}/${SANDBOX_ENVIRONMENT_ID}"
  local remote_revision
  remote_revision="$(remote_branch_head "$branch")"
  if [[ "$remote_revision" != "$SANDBOX_EXPECTED_REVISION" ]]; then
    die "sandbox state branchの完了revisionがreceiptと一致しません"
  fi
  fetch_remote_branch "$branch"
  local local_revision
  local_revision="$(git rev-parse "refs/heads/${branch}")" || die "sandbox state branchのlocal headを取得できません"
  if [[ "$local_revision" != "$remote_revision" ]]; then
    die "sandbox state branchのremote再取得結果が一致しません"
  fi
  write_output state_revision "$remote_revision"
}

recover_info() {
  validate_repository
  validate_run_identity
  validate_operation_inputs
  require_environment SANDBOX_RECOVERY_ENVIRONMENT_ID
  validate_environment_id "$SANDBOX_RECOVERY_ENVIRONMENT_ID"
  local branch="${STATE_BRANCH_PREFIX}/${SANDBOX_RECOVERY_ENVIRONMENT_ID}"
  local remote_revision
  remote_revision="$(remote_branch_head "$branch")"
  fetch_remote_branch "$branch"
  local manifest
  manifest="$(manifest_source "$remote_revision")"
  if [[ "$(manifest_environment_id "$manifest")" != "$SANDBOX_RECOVERY_ENVIRONMENT_ID" ]] ||
    [[ "$(jq -r '.lifecycle.creation.kind' <<< "$manifest")" != reset ]] ||
    [[ "$(jq -r '.lifecycle.creation.sourceEnvironmentId' <<< "$manifest")" != "$SANDBOX_ENVIRONMENT_ID" ]] ||
    [[ "$(manifest_source_ref_value "$manifest")" != "${SANDBOX_SOURCE_REF-}" ]]; then
    die "復旧対象のreset manifestが一致しません"
  fi
  local source_head
  source_head="$(remote_branch_head "${STATE_BRANCH_PREFIX}/${SANDBOX_ENVIRONMENT_ID}")"
  if [[ "$source_head" != "$(jq -r '.lifecycle.creation.sourceHeadRevision' <<< "$manifest")" ]]; then
    die "reset元environmentのheadが変更されています"
  fi
  write_output environment_id "$SANDBOX_RECOVERY_ENVIRONMENT_ID"
  local owner_run_id owner_run_attempt owner_code_revision completion_run_id completion_run_attempt
  owner_run_id="$(jq -r '.lifecycle.owner.actionsRunId' <<< "$manifest")"
  owner_run_attempt="$(jq -r '.lifecycle.owner.actionsRunAttempt' <<< "$manifest")"
  owner_code_revision="$(jq -r '.lifecycle.owner.codeRevision' <<< "$manifest")"
  require_environment GH_TOKEN
  if ! gh api "repos/$GITHUB_REPOSITORY/actions/runs/$owner_run_id" |
    jq -e --arg sha "$owner_code_revision" --arg branch "${SANDBOX_SOURCE_REF}" \
      --arg title "sandbox-reset-${SANDBOX_ENVIRONMENT_ID}" \
      --argjson attempt "$owner_run_attempt" '
      .status == "completed" and .head_sha == $sha and .head_branch == $branch and
      .display_title == $title and .run_attempt == $attempt and .event == "workflow_dispatch"
    ' >/dev/null; then
    die "元reset runと子effectの終了を確認できません"
  fi
  completion_run_id="${SANDBOX_RECOVERY_COMPLETION_RUN_ID:-$owner_run_id}"
  completion_run_attempt="${SANDBOX_RECOVERY_COMPLETION_RUN_ATTEMPT:-$owner_run_attempt}"
  if [[ ! "$completion_run_id" =~ ^[1-9][0-9]*$ || ! "$completion_run_attempt" =~ ^[1-9][0-9]*$ ]] ||
    [[ -n "${SANDBOX_RECOVERY_COMPLETION_RUN_ID-}" && -z "${SANDBOX_RECOVERY_COMPLETION_RUN_ATTEMPT-}" ]] ||
    [[ -z "${SANDBOX_RECOVERY_COMPLETION_RUN_ID-}" && -n "${SANDBOX_RECOVERY_COMPLETION_RUN_ATTEMPT-}" ]]; then
    die "復旧元Actions run IDとattemptの指定が不正です"
  fi
  write_output completion_run_id "$completion_run_id"
  write_output completion_run_attempt "$completion_run_attempt"
  write_output owner_run_id "$owner_run_id"
  write_output owner_run_attempt "$owner_run_attempt"
  write_output owner_code_revision "$owner_code_revision"
}

promote() {
  validate_repository
  validate_run_identity
  require_environment SANDBOX_ENVIRONMENT_ID
  require_environment SANDBOX_EXPECTED_REVISION
  require_environment SANDBOX_TRACKING_RUN_ID
  require_absolute_path SANDBOX_RESULT_PATH
  require_absolute_path SANDBOX_STATE_VERIFICATION_PATH
  require_absolute_path SANDBOX_RECEIPT_VERIFICATION_PATH
  require_absolute_path SANDBOX_RECEIPT_CHAIN_PATH
  validate_environment_id "$SANDBOX_ENVIRONMENT_ID"
  validate_revision "$SANDBOX_EXPECTED_REVISION"
  if [[ ! "$SANDBOX_TRACKING_RUN_ID" =~ ^tracker-run:[0-9a-f]{64}$ ]]; then
    die "sandbox tracking run IDが不正です"
  fi
  if [[ ! -s "$SANDBOX_STATE_VERIFICATION_PATH" || ! -s "$SANDBOX_RECEIPT_VERIFICATION_PATH" ||
    ! -s "$SANDBOX_RECEIPT_CHAIN_PATH" ]]; then
    die "sandbox stateとreceiptの検証結果がありません"
  fi
  if ! jq -e --arg final_revision "$SANDBOX_EXPECTED_REVISION" '
    ([.entries[].receipt | select(.receiptType == "pages_deployment" and .phase == "initial" and .status == "deployed" and .result.externalReference.kind == "recording")] | length) == 1 and
    ([.entries[].receipt | select(.receiptType == "pages_deployment" and .phase == "notification_history" and (.status == "not_required" or (.status == "deployed" and .result.externalReference.kind == "recording")))] | length) == 1 and
    ([.entries[].receipt | select(.receiptType == "notification_settlement")] | length) == 1 and
    ([.entries[].receipt | select(.receiptType == "run_finalization" and .result.resultingStateRevision == $final_revision)] | length) == 1 and
    ([.entries[].receipt | select(.receiptType == "completion" and .result.finalStateRevision == $final_revision)] | length) == 1
  ' "$SANDBOX_RECEIPT_CHAIN_PATH" >/dev/null; then
    die "sandboxのPages、通知、finalization receiptがそろっていません"
  fi
  local branch="${STATE_BRANCH_PREFIX}/${SANDBOX_ENVIRONMENT_ID}"
  local remote_revision
  remote_revision="$(remote_branch_head "$branch")"
  fetch_remote_branch "$branch"
  local manifest
  manifest="$(manifest_source "$remote_revision")"
  if [[ "$(manifest_environment_id "$manifest")" != "$SANDBOX_ENVIRONMENT_ID" ]]; then
    die "昇格対象のmanifestが一致しません"
  fi
  if [[ "${SANDBOX_OPERATION-}" == continue && "$(jq -r '.schemaVersion' <<< "$manifest")" == 2 ]]; then
    if [[ "$remote_revision" != "$SANDBOX_EXPECTED_REVISION" ]] ||
      [[ "$(jq -r '.lifecycle.status' <<< "$manifest")" != ready ]]; then
      die "continue完了時のmanifestまたはheadが不正です"
    fi
    write_output ready_revision "$remote_revision"
    return
  fi
  local owner_run_id owner_run_attempt owner_code_revision
  owner_run_id="$(jq -r --arg current "$GITHUB_RUN_ID" '.lifecycle.owner.actionsRunId // $current' <<< "$manifest")"
  owner_run_attempt="$(jq -r --arg current "$GITHUB_RUN_ATTEMPT" '.lifecycle.owner.actionsRunAttempt // $current' <<< "$manifest")"
  owner_code_revision="$(jq -r --arg current "$GITHUB_SHA" '.lifecycle.owner.codeRevision // $current' <<< "$manifest")"
  if [[ "${SANDBOX_OPERATION-}" == recover-reset ]]; then
    require_environment SANDBOX_RECOVERY_OWNER_RUN_ID
    require_environment SANDBOX_RECOVERY_OWNER_RUN_ATTEMPT
    require_environment SANDBOX_RECOVERY_OWNER_CODE_REVISION
    if [[ "$owner_run_id" != "$SANDBOX_RECOVERY_OWNER_RUN_ID" ]] ||
      [[ "$owner_run_attempt" != "$SANDBOX_RECOVERY_OWNER_RUN_ATTEMPT" ]] ||
      [[ "$owner_code_revision" != "$SANDBOX_RECOVERY_OWNER_CODE_REVISION" ]]; then
      die "復旧対象の元Actions runがmanifestと一致しません"
    fi
  elif [[ "${SANDBOX_OPERATION-}" != resume-preparing ]] &&
    { [[ "${SANDBOX_PROMOTION_OWNER_RUN_ID:-$GITHUB_RUN_ID}" != "$owner_run_id" ]] ||
      [[ "${SANDBOX_PROMOTION_OWNER_RUN_ATTEMPT:-$GITHUB_RUN_ATTEMPT}" != "$owner_run_attempt" ]]; }; then
    die "昇格操作の元Actions runがmanifestと一致しません"
  fi
  if [[ "${SANDBOX_OPERATION-}" != recover-reset && "${SANDBOX_OPERATION-}" != resume-preparing ]] &&
    [[ "$owner_code_revision" != "$GITHUB_SHA" ]]; then
    die "昇格対象のcode revisionが一致しません"
  fi
  local completion_run_id="${SANDBOX_PROMOTION_OWNER_RUN_ID:-$GITHUB_RUN_ID}"
  local completion_run_attempt="${SANDBOX_PROMOTION_OWNER_RUN_ATTEMPT:-$GITHUB_RUN_ATTEMPT}"
  if ! jq -e \
    --arg environment_id "$SANDBOX_ENVIRONMENT_ID" \
    --arg final_revision "$SANDBOX_EXPECTED_REVISION" \
    --arg tracking_run_id "$SANDBOX_TRACKING_RUN_ID" \
    --arg owner_run_id "$completion_run_id" \
    --arg owner_code_revision "$owner_code_revision" \
    --argjson owner_run_attempt "$completion_run_attempt" '
      .environmentId == $environment_id and
      .finalStateRevision == $final_revision and
      .trackingRunId == $tracking_run_id and
      .productionPagesDeployed == false and
      .productionDiscordSent == false and
      (if .schemaVersion == 2 then
        .actionsRunId == $owner_run_id and .actionsRunAttempt == $owner_run_attempt and
        (if .scenarioId == "continuity" then .codeRevision == $owner_code_revision else
          .scenarioId == "send-clear-rejection" or .scenarioId == "hold" or
          .scenarioId == "acknowledge-current" or .scenarioId == "ambiguous-retry" or
          .scenarioId == "ambiguous-acknowledge" end)
      else .schemaVersion == 1 end)
    ' "$SANDBOX_RESULT_PATH" >/dev/null; then
    die "sandbox完了情報が昇格対象と一致しません"
  fi
  local result_digest coverage_json
  result_digest="sha256:$(sha256sum "$SANDBOX_RESULT_PATH" | cut -d' ' -f1)"
  if [[ "$(jq -r '.schemaVersion' "$SANDBOX_RESULT_PATH")" == 2 ]] &&
    [[ "$(jq -r '.receiptChainDigest' "$SANDBOX_RESULT_PATH")" != "sha256:$(sha256sum "$SANDBOX_RECEIPT_CHAIN_PATH" | cut -d' ' -f1)" ]]; then
    die "sandbox完了情報のreceipt chain digestが一致しません"
  fi
  if [[ -n "${SANDBOX_COVERAGE_PATH-}" ]]; then
    require_absolute_path SANDBOX_COVERAGE_PATH
    if [[ ! -s "$SANDBOX_COVERAGE_PATH" ]]; then
      die "sandbox coverageがありません"
    fi
    local coverage_digest
    coverage_digest="sha256:$(sha256sum "$SANDBOX_COVERAGE_PATH" | cut -d' ' -f1)"
    if ! jq -e --arg digest "$coverage_digest" \
      '.schemaVersion == 2 and .coverageDigest == $digest' "$SANDBOX_RESULT_PATH" >/dev/null ||
      ! jq -e --arg code_revision "$owner_code_revision" --arg environment_id "$SANDBOX_ENVIRONMENT_ID" \
        --arg tracking_run_id "$SANDBOX_TRACKING_RUN_ID" --arg final_revision "$SANDBOX_EXPECTED_REVISION" \
        --arg owner_run_id "$completion_run_id" --argjson owner_run_attempt "$completion_run_attempt" '
        .schemaVersion == 2 and .run.codeRevision == $code_revision and
        .run.environmentId == $environment_id and .run.trackingRunId == $tracking_run_id and
        .run.finalStateRevision == $final_revision and .run.actionsRunId == $owner_run_id and
        .run.actionsRunAttempt == $owner_run_attempt
      ' "$SANDBOX_COVERAGE_PATH" >/dev/null; then
      die "sandbox coverage digestが完了情報と一致しません"
    fi
    coverage_json="$(jq -cnS --arg digest "$coverage_digest" '{kind: "verified", digest: $digest}')"
  else
    if ! jq -e '.schemaVersion == 1' "$SANDBOX_RESULT_PATH" >/dev/null; then
      die "sandbox coverageが必要です"
    fi
    coverage_json='{"kind":"not_required"}'
  fi
  local source_environment_id source_head
  source_environment_id="$(jq -r '.lifecycle.creation.sourceEnvironmentId // empty' <<< "$manifest")"
  if [[ -n "$source_environment_id" ]]; then
    source_head="$(remote_branch_head "${STATE_BRANCH_PREFIX}/${source_environment_id}")"
    if [[ "$source_head" != "$(jq -r '.lifecycle.creation.sourceHeadRevision' <<< "$manifest")" ]]; then
      die "reset元environmentのheadが変更されています"
    fi
  fi
  if [[ "$(jq -r '.lifecycle.status' <<< "$manifest")" == ready ]]; then
    if [[ "$(jq -r '.lifecycle.completion.finalStateRevision' <<< "$manifest")" != "$SANDBOX_EXPECTED_REVISION" ]] ||
      [[ "$(jq -r '.lifecycle.completion.actionsRunId' <<< "$manifest")" != "$completion_run_id" ]] ||
      [[ "$(jq -r '.lifecycle.completion.actionsRunAttempt' <<< "$manifest")" != "$completion_run_attempt" ]] ||
      [[ "$(jq -r '.lifecycle.completion.resultDigest' <<< "$manifest")" != "$result_digest" ]] ||
      [[ "$(jq -cS '.lifecycle.completion.coverage' <<< "$manifest")" != "$coverage_json" ]] ||
      [[ "$(git rev-parse "${remote_revision}^")" != "$SANDBOX_EXPECTED_REVISION" ]]; then
      die "ready manifestの確定証拠が一致しません"
    fi
    write_output ready_revision "$remote_revision"
    return
  fi
  if [[ "$remote_revision" != "$SANDBOX_EXPECTED_REVISION" ]]; then
    die "sandbox state headが完了revisionから変更されています"
  fi
  if ! git show "${remote_revision}:state/run-transaction-marker-v1.json" |
    jq -e --arg tracking_run_id "$SANDBOX_TRACKING_RUN_ID" '.phase == "run_finalized" and .runId == $tracking_run_id' >/dev/null; then
    die "sandbox stateがfinalizedになっていません"
  fi
  local manifest_file="${RUNNER_TEMP}/sandbox-ready-${SANDBOX_ENVIRONMENT_ID}.json"
  local index_file="${RUNNER_TEMP}/sandbox-ready-${SANDBOX_ENVIRONMENT_ID}.index"
  jq -cS --arg final_revision "$SANDBOX_EXPECTED_REVISION" \
    --arg tracking_run_id "$SANDBOX_TRACKING_RUN_ID" \
    --arg result_digest "$result_digest" \
    --arg code_revision "$GITHUB_SHA" \
    --arg owner_run_id "$owner_run_id" \
    --argjson owner_run_attempt "$owner_run_attempt" \
    --arg completion_run_id "$completion_run_id" \
    --argjson completion_run_attempt "$completion_run_attempt" \
    --argjson coverage "$coverage_json" \
    '.schemaVersion = 2 | .lifecycle = {status: "ready", owner: (.lifecycle.owner // {actionsRunId: $owner_run_id, actionsRunAttempt: $owner_run_attempt, codeRevision: $code_revision}), creation: (.lifecycle.creation // {kind: "legacy"}), completion: {actionsRunId: $completion_run_id, actionsRunAttempt: $completion_run_attempt, finalStateRevision: $final_revision, trackingRunId: $tracking_run_id, resultDigest: $result_digest, coverage: $coverage}}' \
    <<< "$manifest" > "$manifest_file"
  local before_digest after_digest changed_manifest manifest_digest operation_id
  before_digest="sha256:$(git show "${remote_revision}:${MANIFEST_PATH}" | sha256sum | cut -d' ' -f1)"
  after_digest="sha256:$(sha256sum "$manifest_file" | cut -d' ' -f1)"
  changed_manifest="$(jq -cnS --arg path "$MANIFEST_PATH" --arg before "$before_digest" --arg after "$after_digest" '{schemaVersion: 1, entries: [{path: $path, kind: "modified", beforeDigest: $before, afterDigest: $after}]}')"
  manifest_digest="sha256:$(printf '%s' "$changed_manifest" | sha256sum | cut -d' ' -f1)"
  operation_id="operation:v1:$(printf '%s' "$manifest_file:$result_digest" | sha256sum | cut -d' ' -f1)"
  rm -f -- "$index_file"
  GIT_INDEX_FILE="$index_file" git read-tree "$remote_revision"
  local manifest_blob tree_revision commit_revision
  manifest_blob="$(git hash-object -w --stdin < "$manifest_file")"
  GIT_INDEX_FILE="$index_file" git update-index --add --cacheinfo 100644 "$manifest_blob" "$MANIFEST_PATH"
  tree_revision="$(GIT_INDEX_FILE="$index_file" git write-tree)"
  commit_revision="$(printf 'sandbox environment %s ready\n\nState-Metadata-Version: 1\nState-Commit-Scope: sandbox_manifest\nState-Operation-Id: %s\nState-Changed-Path-Manifest-Version: 1\nState-Changed-Path-Manifest-Digest: %s\n' "$SANDBOX_ENVIRONMENT_ID" "$operation_id" "$manifest_digest" | GIT_AUTHOR_EMAIL='voicevox-task-tracker@users.noreply.github.com' GIT_AUTHOR_NAME='VOICEVOX Task Tracker' GIT_COMMITTER_EMAIL='voicevox-task-tracker@users.noreply.github.com' GIT_COMMITTER_NAME='VOICEVOX Task Tracker' git commit-tree "$tree_revision" -p "$remote_revision")"
  validate_revision "$commit_revision"
  rm -f -- "$index_file" "$manifest_file"
  if ! git push --no-follow-tags --force-with-lease="refs/heads/${branch}:${remote_revision}" origin "${commit_revision}:refs/heads/${branch}" >/dev/null; then
    local observed
    observed="$(remote_branch_head "$branch")"
    if [[ "$observed" != "$commit_revision" ]]; then
      die "sandbox ready昇格のCASが競合しました"
    fi
  fi
  if [[ "$(remote_branch_head "$branch")" != "$commit_revision" ]]; then
    die "sandbox ready昇格後のheadが一致しません"
  fi
  write_output ready_revision "$commit_revision"
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
  require_ready_manifest "$manifest"
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
  die "sandbox-lifecycleにはprepare、finalize、dispose、recover-info、promoteのいずれかを指定してください"
fi

case "$1" in
  prepare) prepare ;;
  finalize) finalize ;;
  dispose) dispose ;;
  recover-info) recover_info ;;
  promote) promote ;;
  *) die "sandbox-lifecycleにはprepare、finalize、dispose、recover-info、promoteのいずれかを指定してください" ;;
esac
