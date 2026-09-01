#!/usr/bin/env bash
set -euo pipefail

if [[ -z "${RUNNER_TEMP:-}" ]]; then
  echo "RUNNER_TEMPが必要です" >&2
  exit 1
fi
if [[ "$RUNNER_TEMP" != /* ]]; then
  echo "RUNNER_TEMPは絶対パスにしてください" >&2
  exit 1
fi
if [[ -z "${GITHUB_JOB:-}" ]]; then
  echo "GITHUB_JOBが必要です" >&2
  exit 1
fi
if [[ ! "$GITHUB_JOB" =~ ^[A-Za-z0-9_-]+$ ]]; then
  echo "GITHUB_JOBが不正です" >&2
  exit 1
fi

diagnostics_path="${RUNNER_TEMP}/voicevox-task-tracker-diagnostics-${GITHUB_JOB}.jsonl"
encrypted_path="${RUNNER_TEMP}/voicevox-task-tracker-diagnostics-${GITHUB_JOB}.bundle"
trap 'rm -f -- "$diagnostics_path"' EXIT

if [[ "$#" -ne 1 ]]; then
  echo "tracker entrypointを1つ指定してください" >&2
  exit 1
fi

tracker_entrypoint="$1"
case "$tracker_entrypoint" in
  dist/cli/tracker-run.js | artifacts/workflow/runtime/tracker-run.mjs) ;;
  *)
    echo "未対応のtracker entrypointです" >&2
    exit 1
    ;;
esac

if [[ -z "${GITHUB_RUN_ID:-}" ]]; then
  echo "GITHUB_RUN_IDが必要です" >&2
  exit 1
fi
if [[ -z "${GITHUB_RUN_ATTEMPT:-}" ]]; then
  echo "GITHUB_RUN_ATTEMPTが必要です" >&2
  exit 1
fi
if [[ -z "${VOICEVOX_TASK_TRACKER_DIAGNOSTICS_AES256_KEY_V1_B64:-}" ]]; then
  echo "診断暗号化鍵が必要です" >&2
  exit 1
fi

if [[ ! -f "$diagnostics_path" ]]; then
  echo "診断JSONLがありません" >&2
  exit 1
fi

node --enable-source-maps "$tracker_entrypoint" diagnostics encrypt \
  --input "$diagnostics_path" \
  --output "$encrypted_path" \
  --run-id "$GITHUB_RUN_ID" \
  --run-attempt "$GITHUB_RUN_ATTEMPT" \
  --job "$GITHUB_JOB" \
  --invocation-id "daily:${GITHUB_RUN_ID}:${GITHUB_RUN_ATTEMPT}:${GITHUB_JOB}"
