#!/usr/bin/env bash
set -u

input="$(cat)"
mkdir -p .claude/retro

session_id="$(
  printf '%s' "$input" | jq -r '.session_id // .sessionId // empty' 2>/dev/null
)"
transcript_path="$(
  printf '%s' "$input" | jq -r '.transcript_path // .transcriptPath // empty' 2>/dev/null
)"
stop_hook_active="$(
  printf '%s' "$input" | jq -r '.stop_hook_active // false' 2>/dev/null
)"
if [ "$stop_hook_active" != "true" ]; then
  stop_hook_active="false"
fi

if [ -z "$transcript_path" ]; then
  transcript_path="${CLAUDE_TRANSCRIPT_PATH:-${CLAUDE_TRANSCRIPT:-${TRANSCRIPT_PATH:-}}}"
fi

if [ -z "$session_id" ]; then
  if [ -n "$transcript_path" ]; then
    session_id="$(basename "$transcript_path")"
    session_id="${session_id%.*}"
  else
    session_id="unknown"
  fi
fi

retro_id="$(printf '%s' "$session_id" | tr -c 'A-Za-z0-9_.-' '_')"
output_path=".claude/retro/${retro_id}.json"
generated_at="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"

if [ -n "$transcript_path" ] && [ -f "$transcript_path" ]; then
  jq -s \
    --arg retro_id "$retro_id" \
    --arg session_id "$session_id" \
    --arg transcript_path "$transcript_path" \
    --arg generated_at "$generated_at" \
    --argjson stop_hook_active "$stop_hook_active" \
    '{
      retro_id: $retro_id,
      session_id: $session_id,
      transcript_path: $transcript_path,
      generated_at: $generated_at,
      tool_uses: ([.[] | .. | objects | select(.type? == "tool_use")] | length),
      errors: ([.[] | .. | objects | select((.is_error? == true) or (.type? == "error") or (.error? != null) or (.error_message? != null))] | length),
      stop_hook_active: $stop_hook_active
    }' "$transcript_path" > "$output_path"
else
  jq -n \
    --arg retro_id "$retro_id" \
    --arg session_id "$session_id" \
    --arg transcript_path "$transcript_path" \
    --arg generated_at "$generated_at" \
    --argjson stop_hook_active "$stop_hook_active" \
    '{
      retro_id: $retro_id,
      session_id: $session_id,
      transcript_path: $transcript_path,
      generated_at: $generated_at,
      tool_uses: 0,
      errors: 0,
      stop_hook_active: $stop_hook_active
    }' > "$output_path"
fi

jq empty "$output_path"
