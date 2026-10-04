#!/usr/bin/env bash
set -euo pipefail

recovery_run_id=''
if [[ $# -ne 0 ]]; then
  if [[ $# -ne 2 || "$1" != '--recovery-run-id' || ! "$2" =~ ^tracker-run:[0-9a-f]{64}$ ]]; then
    echo 'production Pages leaseの復旧run IDが不正です' >&2
    exit 1
  fi
  recovery_run_id="$2"
fi

lease_ref='refs/heads/tracker-pages-effect-lease'
lease_path='state/production-pages-effect-lease-v1.json'
remote_ref="$(git ls-remote origin "$lease_ref")"
if [[ -z "$remote_ref" ]]; then
  exit 0
fi
revision="${remote_ref%%$'\t'*}"
if [[ ! "$revision" =~ ^[0-9a-f]{40}$ ]]; then
  echo 'production Pages leaseのrevisionが不正です' >&2
  exit 1
fi
git fetch --no-tags origin "$lease_ref" >/dev/null
if [[ -z "$(git ls-tree "$revision" -- "$lease_path")" ]]; then
  echo 'production Pages lease branchに固定fileがありません' >&2
  exit 1
fi
lease_file="$RUNNER_TEMP/production-pages-lease.json"
git show "$revision:$lease_path" > "$lease_file"
if ! jq -e --arg run_id "$recovery_run_id" \
  '(.schemaVersion == 1 or .schemaVersion == 2) and (.status == "released" or (.status == "active" and $run_id != "" and .runId == $run_id))' \
  "$lease_file" >/dev/null; then
  echo 'production Pages childの効果が未確定です' >&2
  exit 1
fi
