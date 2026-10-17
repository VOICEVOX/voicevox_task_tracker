#!/usr/bin/env bash

validated_analysis_mode_json() {
  local analysis_mode="${SANDBOX_ANALYSIS_MODE-}"
  local forced_node_id="${SANDBOX_FORCED_NODE_ID-}"
  local forced_elements="${SANDBOX_FORCED_ELEMENTS-}"
  local cache_probe_json="${SANDBOX_CACHE_PROBE_JSON-}"
  case "$analysis_mode" in
    normal)
      if [[ -n "$forced_node_id" || -n "$forced_elements" || -n "$cache_probe_json" ]]; then
        die "normal modeではAI分析対象を指定できません"
      fi
      printf '%s\n' '{"kind":"normal"}'
      ;;
    forced)
      if [[ -n "$cache_probe_json" ]]; then
        die "forced modeではcache probeを指定できません"
      fi
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
    cache_probe)
      if [[ -n "$forced_node_id" || -n "$forced_elements" || -z "$cache_probe_json" ]]; then
        die "cache probe modeには検証済みのprobeだけを指定してください"
      fi
      jq -ce '{kind: "cache_probe", probe: .}' <<< "$cache_probe_json" || die "cache probeのJSONが不正です"
      ;;
    *)
      die "SANDBOX_ANALYSIS_MODEが不正です"
      ;;
  esac
}
