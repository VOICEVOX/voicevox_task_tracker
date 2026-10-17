#!/usr/bin/env bash

set -euo pipefail

cp "$RUNNER_TEMP/sandbox-state/state/sandbox-environment.json" "$RUNNER_TEMP/matrix-current/sandbox-environment.json"
cp "$RUNNER_TEMP/sandbox-state/state/durable-publication-record-v1.json" "$RUNNER_TEMP/matrix-current/durable-publication-record-v1.json"
cp "$RUNNER_TEMP/sandbox-coverage.json" "$RUNNER_TEMP/matrix-current/sandbox-coverage.json"
cp "$RUNNER_TEMP/sandbox-result.json" "$RUNNER_TEMP/matrix-current/sandbox-result.json"

for destination in "$RUNNER_TEMP"/prior/* "$RUNNER_TEMP/matrix-current"; do
  manifest="$destination/sandbox-environment.json"
  scenario_id="$(jq -er '.scenarioId' "$destination/sandbox-result.json")"
  environment_id="$(jq -er '.environmentId | select(test("^env-[1-9][0-9]*-[1-9][0-9]*$"))' "$manifest")"
  source_environment_id="$(jq -er '.lifecycle.creation.sourceEnvironmentId | select(test("^env-[1-9][0-9]*-[1-9][0-9]*$"))' "$manifest")"
  expected_head="$(jq -er '.lifecycle.creation.sourceHeadRevision | select(test("^[0-9a-f]{40}$"))' "$manifest")"
  final_revision="$(jq -er '.finalStateRevision | select(test("^[0-9a-f]{40}$"))' "$destination/sandbox-result.json")"
  seed_revision="$(jq -er '.seedRevision | select(test("^[0-9a-f]{40}$"))' "$manifest")"

  git fetch --no-tags origin "refs/heads/sandbox-state/$source_environment_id:refs/remotes/sandbox-matrix-source/$source_environment_id"
  source_head="$(git rev-parse "refs/remotes/sandbox-matrix-source/$source_environment_id")"
  [[ "$source_head" == "$expected_head" ]] || { echo 'reset元environmentのHEADが一致しません' >&2; exit 1; }
  git show "$source_head:state/sandbox-environment.json" > "$destination/source-environment.json"
  if [[ "$scenario_id" != send-clear-rejection ]]; then
    source_final="$(jq -er '.lifecycle.completion.finalStateRevision | select(test("^[0-9a-f]{40}$"))' "$destination/source-environment.json")"
    if [[ "$(git rev-parse "$source_head^")" != "$source_final" ]] ||
      [[ "$(git diff --name-only "$source_final" "$source_head")" != 'state/sandbox-environment.json' ]]; then
      echo 'reset元のready commitが不正です' >&2
      exit 1
    fi
  fi
  printf '%s\n' "$source_head" > "$destination/source-head-revision.txt"

  git fetch --no-tags origin "refs/heads/sandbox-state/$environment_id:refs/remotes/sandbox-matrix/$environment_id"
  ready_head="$(git rev-parse "refs/remotes/sandbox-matrix/$environment_id")"
  if [[ "$(git rev-parse "$ready_head^")" != "$final_revision" ]] ||
    [[ "$(git diff --name-only "$final_revision" "$ready_head")" != 'state/sandbox-environment.json' ]]; then
    echo 'scenarioのready commitが不正です' >&2
    exit 1
  fi
  git show "$ready_head:state/sandbox-environment.json" > "$destination/ready-environment.json"
  printf '%s\n' "$ready_head" > "$destination/ready-head-revision.txt"

  creation_revision="$(git rev-list --first-parent --reverse "$seed_revision..$ready_head" | sed -n '1p')"
  if [[ -z "$creation_revision" ]] || [[ "$(git rev-parse "$creation_revision^")" != "$seed_revision" ]]; then
    echo 'scenarioの物理seed親が一致しません' >&2
    exit 1
  fi
  git show "$creation_revision:state/sandbox-environment.json" > "$destination/creation-environment.json"
  printf '%s\n' "$creation_revision" > "$destination/creation-revision.txt"
done

origin="$RUNNER_TEMP/prior/send-clear-rejection"
source_head="$(cat "$origin/source-head-revision.txt")"
git show "$source_head:state/run-transaction-marker-v1.json" > "$origin/continuity-second-marker.json"
git show "$source_head:state/durable-publication-record-v1.json" > "$origin/continuity-second-record.json"
second_run_id="$(jq -er '.runtimeRecoveryPlan.workflowRunId | select(test("^[1-9][0-9]*$"))' "$origin/continuity-second-record.json")"
second_attempt="$(jq -er '.runtimeRecoveryPlan.workflowRunAttempt | select(. > 0)' "$origin/continuity-second-record.json")"
source_environment_id="$(jq -er '.environmentId' "$origin/source-environment.json")"
mkdir -p "$origin/continuity-second-result" "$origin/continuity-second-coverage" "$origin/continuity-second-receipts"
gh run download "$second_run_id" --repo "$GITHUB_REPOSITORY" \
  --name "sandbox-result-$source_environment_id-$second_run_id-$second_attempt" --dir "$origin/continuity-second-result"
gh run download "$second_run_id" --repo "$GITHUB_REPOSITORY" \
  --name "sandbox-coverage-$source_environment_id-$second_run_id-$second_attempt" --dir "$origin/continuity-second-coverage"
gh run download "$second_run_id" --repo "$GITHUB_REPOSITORY" \
  --name tracking-stage-complete --dir "$origin/continuity-second-receipts"
gh api "repos/$GITHUB_REPOSITORY/actions/runs/$second_run_id" > "$origin/continuity-second-run.json"

first_ready="$(jq -er '.baseStateRevision | select(test("^[0-9a-f]{40}$"))' "$origin/continuity-second-result/sandbox-result.json")"
second_final="$(jq -er '.finalStateRevision | select(test("^[0-9a-f]{40}$"))' "$origin/continuity-second-result/sandbox-result.json")"
[[ "$second_final" == "$source_head" ]] || { echo 'second finalがreset元HEADと一致しません' >&2; exit 1; }
printf '%s\n' "$first_ready" > "$origin/continuity-first-ready-revision.txt"
git merge-base --is-ancestor "$first_ready" "$second_final"
git show "$first_ready:state/sandbox-environment.json" > "$origin/continuity-first-ready-environment.json"
first_final="$(jq -er '.lifecycle.completion.finalStateRevision | select(test("^[0-9a-f]{40}$"))' "$origin/continuity-first-ready-environment.json")"
if [[ "$(git rev-parse "$first_ready^")" != "$first_final" ]] ||
  [[ "$(git diff --name-only "$first_final" "$first_ready")" != 'state/sandbox-environment.json' ]]; then
  echo 'first readyとfirst finalの連鎖が不正です' >&2
  exit 1
fi
first_run_id="$(jq -er '.lifecycle.completion.actionsRunId | select(test("^[1-9][0-9]*$"))' "$origin/continuity-first-ready-environment.json")"
first_attempt="$(jq -er '.lifecycle.completion.actionsRunAttempt | select(. > 0)' "$origin/continuity-first-ready-environment.json")"
mkdir -p "$origin/continuity-first-result" "$origin/continuity-first-coverage" "$origin/continuity-first-receipts"
gh run download "$first_run_id" --repo "$GITHUB_REPOSITORY" \
  --name "sandbox-result-$source_environment_id-$first_run_id-$first_attempt" --dir "$origin/continuity-first-result"
gh run download "$first_run_id" --repo "$GITHUB_REPOSITORY" \
  --name "sandbox-coverage-$source_environment_id-$first_run_id-$first_attempt" --dir "$origin/continuity-first-coverage"
gh run download "$first_run_id" --repo "$GITHUB_REPOSITORY" \
  --name tracking-stage-complete --dir "$origin/continuity-first-receipts"
gh api "repos/$GITHUB_REPOSITORY/actions/runs/$first_run_id" > "$origin/continuity-first-run.json"
git show "$first_final:state/run-transaction-marker-v1.json" > "$origin/continuity-first-marker.json"
git show "$first_final:state/durable-publication-record-v1.json" > "$origin/continuity-first-record.json"
git show "$first_final:state/snapshot.json" > "$origin/continuity-first-snapshot.json"
git show "$second_final:state/snapshot.json" > "$origin/continuity-second-snapshot.json"
origin_seed="$(jq -er '.seedRevision | select(test("^[0-9a-f]{40}$"))' "$origin/source-environment.json")"
origin_head="$(jq -er '.lifecycle.creation.sourceHeadRevision' "$origin/sandbox-environment.json")"
origin_creation="$(git rev-list --first-parent --reverse "$origin_seed..$origin_head" | sed -n '1p')"
if [[ -z "$origin_creation" ]] || [[ "$(git rev-parse "$origin_creation^")" != "$origin_seed" ]]; then
  echo 'continuity初回環境の物理seed親が一致しません' >&2
  exit 1
fi
git show "$origin_creation:state/sandbox-environment.json" > "$origin/continuity-creation-environment.json"
printf '%s\n' "$origin_creation" > "$origin/continuity-creation-revision.txt"
