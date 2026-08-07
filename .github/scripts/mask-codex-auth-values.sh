#!/usr/bin/env bash

set -euo pipefail

if [[ "$#" -ne 1 ]]; then
  echo "Codex認証ファイルのパスを1つ指定してください" >&2
  exit 1
fi

auth_file=$1
mask_values_file="$(mktemp)"
trap 'rm -f "$mask_values_file"' EXIT

jq --raw-output '
  .. | strings
  | gsub("\r"; "\n")
  | split("\n")[]
  | select(length >= 16)
' "$auth_file" > "$mask_values_file"

while IFS= read -r value; do
  escaped_value="${value//%/%25}"
  printf '::add-mask::%s\n' "$escaped_value"
done < "$mask_values_file"
