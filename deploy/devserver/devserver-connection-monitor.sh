#!/usr/bin/env bash

set -euo pipefail

readonly STORAGE_ROOT="${DEVSERVER_STORAGE_ROOT:-/srv/devserver}"
readonly DOCKER_SOCKET="${DEVSERVER_DOCKER_SOCKET:-unix:///run/docker-devserver.sock}"
readonly STATE_ROOT="${DEVSERVER_CONNECTION_MONITOR_STATE_ROOT:-$STORAGE_ROOT/runtime/monitor}"
readonly LOG_FILE="$STATE_ROOT/connection-monitor.ndjson"
readonly CONTINUATION_FILE="${DEVSERVER_CONTINUATION_FILE:-$STORAGE_ROOT/runtime/home/.local/share/devspace/pending-continuations.json}"
readonly LOCK_FILE="${DEVSERVER_CONNECTION_MONITOR_LOCK_FILE:-/run/lock/devserver-connection-monitor.lock}"
readonly PUBLIC_HEALTH_URL="${DEVSERVER_PUBLIC_HEALTH_URL:-https://devserver.ciward.dpdns.org/healthz}"
readonly WINDOW="${DEVSERVER_CONNECTION_MONITOR_WINDOW:-90s}"
readonly MAX_LOG_BYTES=$((50 * 1024 * 1024))

log() {
  printf '[devserver-connection-monitor] %s\n' "$*" >&2
}

docker_devserver() {
  DOCKER_HOST="$DOCKER_SOCKET" docker "$@"
}

count_pattern() {
  local text="$1"
  local pattern="$2"
  awk -v pattern="$pattern" '$0 ~ pattern { count++ } END { print count + 0 }' <<< "$text"
}

last_timestamp() {
  local text="$1"
  awk 'NF { timestamp=$1 } END { print timestamp }' <<< "$text"
}

read_cgroup_value() {
  local name="$1"
  docker_devserver exec devserver sh -lc "cat /sys/fs/cgroup/$name 2>/dev/null || printf unknown" 2>/dev/null
}

rotate_log() {
  [[ -f "$LOG_FILE" ]] || return 0
  local size
  size="$(stat -c '%s' "$LOG_FILE" 2>/dev/null || stat -f '%z' "$LOG_FILE")"
  if (( size >= MAX_LOG_BYTES )); then
    mv -f "$LOG_FILE" "${LOG_FILE}.1"
  fi
}

command -v jq >/dev/null 2>&1 || { log "jq is required"; exit 1; }

exec 9>"$LOCK_FILE"
flock -n 9 || exit 0

install -d -m 0750 "$STATE_ROOT"
rotate_log

local_body="$(mktemp)"
public_body="$(mktemp)"
trap 'rm -f "$local_body" "$public_body"' EXIT

local_http="$(curl --noproxy '*' -sS -o "$local_body" -w '%{http_code}' --max-time 15 http://127.0.0.1:17676/healthz || printf 000)"
public_http="$(curl --noproxy '*' -sS -o "$public_body" -w '%{http_code}' --max-time 20 "$PUBLIC_HEALTH_URL" || printf 000)"

app_logs="$(docker_devserver logs --since "$WINDOW" --timestamps devserver 2>&1 || true)"
tunnel_logs="$(docker_devserver logs --since "$WINDOW" --timestamps devserver-cloudflared 2>&1 || true)"

app_http_requests="$(count_pattern "$app_logs" 'http_request')"
app_tool_calls="$(count_pattern "$app_logs" 'tool_call')"
app_mcp_created="$(count_pattern "$app_logs" 'mcp_session_created')"
app_mcp_closed="$(count_pattern "$app_logs" 'mcp_session_closed')"
app_5xx="$(count_pattern "$app_logs" 'status=5[0-9][0-9]')"
app_unknown_session="$(count_pattern "$app_logs" 'Unknown process session')"
app_mcp_errors="$(count_pattern "$app_logs" 'mcp_request_error')"
app_aborted="$(count_pattern "$app_logs" 'mcp_request_aborted')"
app_closed_before_finish="$(count_pattern "$app_logs" 'mcp_response_closed_before_finish')"
tunnel_remote_canceled="$(count_pattern "$tunnel_logs" 'canceled by remote')"
tunnel_proxy_failures="$(count_pattern "$tunnel_logs" 'Failed to proxy HTTP')"
tunnel_connection_terminated="$(count_pattern "$tunnel_logs" 'connection terminated')"

last_tool_at="$(last_timestamp "$(grep 'tool_call' <<< "$app_logs" || true)")"
last_mcp_at="$(last_timestamp "$(grep 'path=\"/mcp\"' <<< "$app_logs" || true)")"
last_lifecycle_at="$(last_timestamp "$(grep -E 'mcp_request_aborted|mcp_response_closed_before_finish' <<< "$app_logs" || true)")"

container_status="$(docker_devserver inspect --format '{{.State.Status}}' devserver 2>/dev/null || printf unknown)"
container_health="$(docker_devserver inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' devserver 2>/dev/null || printf unknown)"
container_restarts="$(docker_devserver inspect --format '{{.RestartCount}}' devserver 2>/dev/null || printf -1)"
container_oom="$(docker_devserver inspect --format '{{.State.OOMKilled}}' devserver 2>/dev/null || printf unknown)"
cloudflared_status="$(docker_devserver inspect --format '{{.State.Status}}' devserver-cloudflared 2>/dev/null || printf unknown)"
process_count="$(docker_devserver exec devserver sh -lc 'ps -e --no-headers 2>/dev/null | wc -l' 2>/dev/null || printf -1)"
disk_percent="$(df --output=pcent "$STORAGE_ROOT" 2>/dev/null | tail -1 | tr -dc '0-9' || printf -1)"
memory_current="$(read_cgroup_value memory.current)"
memory_peak="$(read_cgroup_value memory.peak)"
memory_max="$(read_cgroup_value memory.max)"
memory_events="$(read_cgroup_value memory.events | tr '\n' ';')"
swap_current="$(read_cgroup_value memory.swap.current)"
pids_current="$(read_cgroup_value pids.current)"
pids_max="$(read_cgroup_value pids.max)"

maybe_send_interruption_alert() {
  [[ "${DEVSERVER_INTERRUPTION_ALERT_ENABLED:-0}" == "1" ]] || return 0
  [[ "$local_http" == 200 && "$public_http" == 200 && "$container_health" == healthy && "$container_oom" == false ]] || return 0
  [[ "$app_5xx" == 0 && "$app_mcp_errors" == 0 && "$tunnel_connection_terminated" == 0 ]] || return 0
  [[ -r "$CONTINUATION_FILE" ]] || return 0
  local recipient="${DEVSERVER_INTERRUPTION_ALERT_TO:-ciwardsmith@gmail.com}"
  local grace="${DEVSERVER_INTERRUPTION_ALERT_GRACE_SECONDS:-300}"
  local cooldown="${DEVSERVER_INTERRUPTION_ALERT_COOLDOWN_SECONDS:-1800}"
  [[ "$grace" =~ ^[0-9]+$ && "$cooldown" =~ ^[0-9]+$ ]] || return 0
  [[ "$recipient" =~ ^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$ ]] || return 0
  local now candidate key workspace_id session_id age last_claim
  now="$(date +%s)"
  candidate="$(jq -cer --argjson now "$((now * 1000))" --argjson grace "$((grace * 1000))" '
    select(.sampledAt <= $now and .sampledAt > ($now - 60000)) |
    select(.activeToolRequests == 0 and ($now - .lastToolRequestAt) >= $grace) |
    .bootId as $boot |
    [.sessions[]? | select(.running == true and ($now - .lastPolledAt) >= $grace) |
      {key: ($boot + ":" + (.sessionId|tostring)), workspaceId, sessionId,
       age: (($now - .lastPolledAt)/1000|floor)}] | first // empty' "$CONTINUATION_FILE" 2>/dev/null)" || return 0
  key="$(jq -r .key <<< "$candidate")"
  workspace_id="$(jq -r .workspaceId <<< "$candidate")"
  session_id="$(jq -r .sessionId <<< "$candidate")"
  age="$(jq -r .age <<< "$candidate")"
  local claims="$STATE_ROOT/interruption-alert.claims"
  if [[ -r "$claims" ]]; then
    grep -Fq " $key" "$claims" && return 0
    last_claim="$(tail -1 "$claims" | awk '{print $1}')"
    (( now - last_claim >= cooldown )) || return 0
  fi
  # Claim before SMTP: ambiguous delivery must not trigger duplicate emails.
  printf '%s %s\n' "$now" "$key" >> "$claims"
  chmod 0600 "$claims"
  if python3 "$(dirname "$0")/devserver-send-reminder.py" "$recipient" "$workspace_id" "$session_id" "$age" "$key"; then
    log "interruption reminder smtp_accepted key=$key"
  else
    log "interruption reminder delivery_unknown key=$key; claim retained"
  fi
}
maybe_send_interruption_alert

jq -cn \
  --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --arg local_http "$local_http" \
  --arg public_http "$public_http" \
  --arg local_body "$(tr -d '\n' < "$local_body" | cut -c1-200)" \
  --arg public_body "$(tr -d '\n' < "$public_body" | cut -c1-200)" \
  --arg container_status "$container_status" \
  --arg container_health "$container_health" \
  --arg container_oom "$container_oom" \
  --arg cloudflared_status "$cloudflared_status" \
  --arg last_tool_at "$last_tool_at" \
  --arg last_mcp_at "$last_mcp_at" \
  --arg last_lifecycle_at "$last_lifecycle_at" \
  --arg memory_current "$memory_current" \
  --arg memory_peak "$memory_peak" \
  --arg memory_max "$memory_max" \
  --arg memory_events "$memory_events" \
  --arg swap_current "$swap_current" \
  --arg pids_current "$pids_current" \
  --arg pids_max "$pids_max" \
  --argjson app_http_requests "$app_http_requests" \
  --argjson app_tool_calls "$app_tool_calls" \
  --argjson app_mcp_created "$app_mcp_created" \
  --argjson app_mcp_closed "$app_mcp_closed" \
  --argjson app_5xx "$app_5xx" \
  --argjson app_unknown_session "$app_unknown_session" \
  --argjson app_mcp_errors "$app_mcp_errors" \
  --argjson app_aborted "$app_aborted" \
  --argjson app_closed_before_finish "$app_closed_before_finish" \
  --argjson tunnel_remote_canceled "$tunnel_remote_canceled" \
  --argjson tunnel_proxy_failures "$tunnel_proxy_failures" \
  --argjson tunnel_connection_terminated "$tunnel_connection_terminated" \
  --argjson container_restarts "$container_restarts" \
  --argjson process_count "$process_count" \
  --argjson disk_percent "$disk_percent" \
  '{ts:$ts, local_http:$local_http, public_http:$public_http, local_body:$local_body, public_body:$public_body, container_status:$container_status, container_health:$container_health, container_restarts:$container_restarts, container_oom:$container_oom, cloudflared_status:$cloudflared_status, disk_percent:$disk_percent, process_count:$process_count, memory_current:$memory_current, memory_peak:$memory_peak, memory_max:$memory_max, memory_events:$memory_events, swap_current:$swap_current, pids_current:$pids_current, pids_max:$pids_max, app_http_requests:$app_http_requests, app_tool_calls:$app_tool_calls, app_mcp_created:$app_mcp_created, app_mcp_closed:$app_mcp_closed, app_5xx:$app_5xx, app_unknown_session:$app_unknown_session, app_mcp_errors:$app_mcp_errors, app_aborted:$app_aborted, app_closed_before_finish:$app_closed_before_finish, tunnel_remote_canceled:$tunnel_remote_canceled, tunnel_proxy_failures:$tunnel_proxy_failures, tunnel_connection_terminated:$tunnel_connection_terminated, last_tool_at:$last_tool_at, last_mcp_at:$last_mcp_at, last_lifecycle_at:$last_lifecycle_at}' \
  >> "$LOG_FILE"

log "recorded local_http=$local_http public_http=$public_http tool_calls=$app_tool_calls closed_before_finish=$app_closed_before_finish tunnel_proxy_failures=$tunnel_proxy_failures disk=${disk_percent}%"
