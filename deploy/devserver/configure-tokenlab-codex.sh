#!/usr/bin/env bash

set -euo pipefail

readonly KEY_NAME="${1:-devserver}"
readonly POSTGRES_CONTAINER="${TOKENLAB_POSTGRES_CONTAINER:-sub2api-postgres}"
readonly POSTGRES_USER="${TOKENLAB_POSTGRES_USER:-sub2api}"
readonly POSTGRES_DATABASE="${TOKENLAB_POSTGRES_DATABASE:-sub2api}"
readonly DEVSERVER_HOME="${DEVSERVER_HOME:-/home/ubuntu/.devserver/home}"
readonly CODEX_DIR="${DEVSERVER_HOME}/.codex"
readonly CODEX_CONFIG="${CODEX_DIR}/config.toml"
readonly CODEX_AUTH="${CODEX_DIR}/auth.json"

if [[ ! "$KEY_NAME" =~ ^[A-Za-z0-9._-]+$ ]]; then
  printf 'Invalid TokenLab API key name\n' >&2
  exit 2
fi

query="SELECT id, key FROM api_keys WHERE name = '${KEY_NAME}' AND status = 'active' AND deleted_at IS NULL AND (expires_at IS NULL OR expires_at > NOW()) ORDER BY id;"
rows="$(docker exec "$POSTGRES_CONTAINER" psql \
  -U "$POSTGRES_USER" \
  -d "$POSTGRES_DATABASE" \
  -v ON_ERROR_STOP=1 \
  -At \
  -F $'\t' \
  -c "$query")"

row_count="$(printf '%s\n' "$rows" | sed '/^$/d' | wc -l | tr -d ' ')"
if [[ "$row_count" != "1" ]]; then
  printf 'Expected exactly one active TokenLab API key named %s; found %s\n' "$KEY_NAME" "$row_count" >&2
  exit 3
fi

IFS=$'\t' read -r key_id api_key <<< "$rows"
if [[ ! "$key_id" =~ ^[0-9]+$ ]] || [[ ! "$api_key" =~ ^sk-[A-Za-z0-9_-]+$ ]]; then
  printf 'TokenLab API key record failed validation\n' >&2
  exit 4
fi

umask 077
mkdir -p "$CODEX_DIR"
config_tmp="$(mktemp "${CODEX_DIR}/.config.toml.XXXXXX")"
auth_tmp="$(mktemp "${CODEX_DIR}/.auth.json.XXXXXX")"
trap 'rm -f "$config_tmp" "$auth_tmp"' EXIT

{
  printf 'model = "gpt-5.6-luna"\n'
  printf 'model_reasoning_effort = "max"\n'
  printf 'model_provider = "TokenLab"\n'
  printf 'network_access = "enabled"\n'
  printf 'approval_policy = "never"\n'
  printf 'sandbox_mode = "danger-full-access"\n'
  printf 'disable_response_storage = true\n'
  printf 'check_for_update_on_startup = false\n'
  printf 'experimental_bearer_token = "%s"\n\n' "$api_key"
  printf '[model_providers.TokenLab]\n'
  printf 'name = "TokenLab"\n'
  printf 'requires_openai_auth = true\n'
  printf 'wire_api = "responses"\n'
  printf 'base_url = "https://api.tokenlab.cc.cd"\n'
  printf 'experimental_bearer_token = "%s"\n\n' "$api_key"
  printf '[features]\n'
  printf 'remote_compaction_v2 = true\n'
} > "$config_tmp"

printf '{\n  "OPENAI_API_KEY": null\n}\n' > "$auth_tmp"
install -m 0600 "$config_tmp" "$CODEX_CONFIG"
install -m 0600 "$auth_tmp" "$CODEX_AUTH"
unset api_key rows

printf 'Configured DevServer Codex with active TokenLab key id %s\n' "$key_id"
