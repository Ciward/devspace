#!/usr/bin/env bash

set -uo pipefail

readonly CODEX_PACKAGE="@openai/codex"
readonly CODEX_HOME_ROOT="${HOME}/.npm-global"
readonly CODEX_VERSIONS_DIR="${CODEX_HOME_ROOT}/versions"
readonly CODEX_CURRENT_LINK="${CODEX_HOME_ROOT}/current"
readonly CODEX_CURRENT_BIN="${CODEX_CURRENT_LINK}/bin/codex"
readonly CODEX_FALLBACK="${DEVSERVER_CODEX_FALLBACK:-/usr/local/bin/codex}"
readonly UPDATE_TIMEOUT_SECONDS="${DEVSERVER_CODEX_UPDATE_TIMEOUT_SECONDS:-90}"

log() {
  printf '[devserver-codex] %s\n' "$*" >&2
}

run_with_timeout() {
  if command -v timeout >/dev/null 2>&1; then
    timeout "${UPDATE_TIMEOUT_SECONDS}s" "$@"
  else
    "$@"
  fi
}

valid_codex() {
  local candidate="$1"
  [[ -x "$candidate" ]] \
    && "$candidate" --version >/dev/null 2>&1 \
    && "$candidate" app-server --help >/dev/null 2>&1
}

codex_version() {
  "$1" --version 2>/dev/null | awk 'NF { print $NF; exit }'
}

activate_version() {
  local version_dir="$1"
  local next_link="${CODEX_HOME_ROOT}/.current.$$.next"

  rm -f "$next_link"
  ln -s "$version_dir" "$next_link" || return 1
  mv -f "$next_link" "$CODEX_CURRENT_LINK" || {
    rm -f "$next_link"
    return 1
  }
}

install_version() {
  local version="$1"
  local version_dir="${CODEX_VERSIONS_DIR}/${version}"
  local stage

  if valid_codex "${version_dir}/bin/codex"; then
    activate_version "$version_dir"
    return
  fi

  stage="$(mktemp -d "${CODEX_VERSIONS_DIR}/.${version}.XXXXXX")" || return 1
  if ! run_with_timeout npm install --global --prefix "$stage" "${CODEX_PACKAGE}@${version}" >/dev/null 2>&1; then
    rm -rf "$stage"
    return 1
  fi
  if ! valid_codex "${stage}/bin/codex"; then
    rm -rf "$stage"
    return 1
  fi

  if [[ -e "$version_dir" ]]; then
    rm -rf "$stage"
  else
    mv "$stage" "$version_dir" || {
      rm -rf "$stage"
      return 1
    }
  fi
  activate_version "$version_dir"
}

mkdir -p "$CODEX_VERSIONS_DIR"

selected=""
if valid_codex "$CODEX_CURRENT_BIN"; then
  selected="$CODEX_CURRENT_BIN"
elif valid_codex "$CODEX_FALLBACK"; then
  selected="$CODEX_FALLBACK"
fi

latest="$(run_with_timeout npm view @openai/codex version --silent 2>/dev/null || true)"
latest="${latest//$'\r'/}"
latest="${latest//$'\n'/}"
if [[ "$latest" =~ ^[0-9]+\.[0-9]+\.[0-9]+([+-][0-9A-Za-z.-]+)?$ ]]; then
  current_version=""
  if [[ -n "$selected" ]]; then
    current_version="$(codex_version "$selected")"
  fi
  if [[ "$current_version" != "$latest" ]]; then
    if install_version "$latest"; then
      selected="$CODEX_CURRENT_BIN"
      log "activated Codex ${latest}"
    else
      log "Codex update failed; retaining the last valid installation"
    fi
  elif [[ "$selected" != "$CODEX_CURRENT_BIN" ]] && install_version "$latest"; then
    selected="$CODEX_CURRENT_BIN"
  fi
else
  log "registry lookup failed; retaining the last valid installation"
fi

if [[ -z "$selected" ]] || ! valid_codex "$selected"; then
  log "no Codex installation with app-server support is available"
  exit 1
fi

export CODEX_COMMAND="$selected"
export PATH="${CODEX_CURRENT_LINK}/bin:${PATH}"

exec "$@"
