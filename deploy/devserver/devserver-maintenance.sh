#!/usr/bin/env bash

set -euo pipefail

readonly STORAGE_ROOT="${DEVSERVER_STORAGE_ROOT:-/srv/devserver}"
readonly EXPECTED_DEVICE="${DEVSERVER_STORAGE_DEVICE:-/dev/sdb1}"
readonly DOCKER_SOCKET="${DEVSERVER_DOCKER_SOCKET:-unix:///run/docker-devserver.sock}"
readonly STATE_ROOT="${DEVSERVER_MAINTENANCE_STATE_ROOT:-$STORAGE_ROOT/runtime/maintenance}"
readonly LOCK_FILE="${DEVSERVER_MAINTENANCE_LOCK_FILE:-/run/lock/devserver-maintenance.lock}"
readonly DISK_SOFT_PERCENT="${DEVSERVER_DISK_SOFT_PERCENT:-70}"
readonly DISK_HARD_PERCENT="${DEVSERVER_DISK_HARD_PERCENT:-85}"
readonly DISK_CRITICAL_PERCENT="${DEVSERVER_DISK_CRITICAL_PERCENT:-92}"
readonly PUBLIC_HEALTH_URL="${DEVSERVER_PUBLIC_HEALTH_URL:-https://devserver.ciward.dpdns.org/healthz}"
readonly PUBLIC_FAILURE_LIMIT="${DEVSERVER_PUBLIC_FAILURE_LIMIT:-3}"
readonly PUBLIC_FAILURE_FILE="$STATE_ROOT/public-health-failures"

log() {
  printf '[devserver-maintenance] %s\n' "$*"
}

die() {
  log "ERROR: $*" >&2
  exit 1
}

docker_devserver() {
  DOCKER_HOST="$DOCKER_SOCKET" docker "$@"
}

run_builder_prune() {
  local output

  if ! output="$(docker_devserver builder prune "$@" 2>&1)"; then
    log "builder prune failed: $output" >&2
    return 1
  fi
}

validate_integer() {
  local name="$1"
  local value="$2"
  local minimum="$3"
  local maximum="$4"

  [[ "$value" =~ ^[0-9]+$ ]] || die "$name must be an integer"
  (( value >= minimum && value <= maximum )) || \
    die "$name must be between $minimum and $maximum"
}

validate_runtime() {
  [[ "$(id -u)" -eq 0 ]] || die "run as root"
  mountpoint -q "$STORAGE_ROOT" || die "$STORAGE_ROOT is not mounted"

  local actual_source
  local actual_fstype
  local docker_root
  actual_source="$(findmnt -rn -T "$STORAGE_ROOT" -o SOURCE)"
  actual_fstype="$(findmnt -rn -T "$STORAGE_ROOT" -o FSTYPE)"
  [[ "$(readlink -f "$actual_source")" == "$(readlink -f "$EXPECTED_DEVICE")" ]] || \
    die "unexpected storage source: $actual_source"
  [[ "$actual_fstype" == "ext4" ]] || die "unexpected storage filesystem: $actual_fstype"

  docker_root="$(docker_devserver info --format '{{.DockerRootDir}}')"
  [[ "$docker_root" == "$STORAGE_ROOT/docker" ]] || die "unexpected DockerRootDir: $docker_root"

  if grep -Fq "system-bridge-check" /usr/local/libexec/devserver-network.sh; then
    /usr/local/libexec/devserver-network.sh system-bridge-check >/dev/null
  fi

  if grep -Fq "daemon-bridge-check" /usr/local/libexec/devserver-network.sh; then
    if ! /usr/local/libexec/devserver-network.sh daemon-bridge-check >/dev/null 2>&1; then
      log "repairing dedicated daemon bridge"
      /usr/local/libexec/devserver-network.sh daemon-bridge-up
    fi
  fi

  if ! /usr/local/libexec/devserver-network.sh check >/dev/null 2>&1; then
    log "repairing dedicated network rules"
    /usr/local/libexec/devserver-network.sh up
  fi
}

disk_used_percent() {
  df --output=pcent "$STORAGE_ROOT" | tail -n 1 | tr -dc '0-9'
}

directory_is_open() {
  local path="$1"
  command -v lsof >/dev/null 2>&1 && lsof +D "$path" >/dev/null 2>&1
}

remove_stale_path() {
  local root="$1"
  local path="$2"
  local bytes

  case "$path" in
    "$root"/*) ;;
    *) die "refusing cleanup outside $root: $path" ;;
  esac
  [[ -e "$path" || -L "$path" ]] || return 0
  if [[ -d "$path" ]] && directory_is_open "$path"; then
    log "skipping open temporary directory: $path"
    return 0
  fi

  bytes="$(du -sx --block-size=1 "$path" 2>/dev/null | awk '{print $1}')"
  rm -rf --one-file-system -- "$path"
  log "removed stale temporary path bytes=${bytes:-0} path=$path"
}

cleanup_matching_children() {
  local root="$1"
  local pattern="$2"
  local age_days="$3"
  local path

  [[ -d "$root" ]] || return 0
  while IFS= read -r -d '' path; do
    remove_stale_path "$root" "$path"
  done < <(
    find "$root" -xdev -mindepth 1 -maxdepth 1 \
      -name "$pattern" -mtime "+$age_days" -print0
  )
}

cleanup_stale_scratch() {
  cleanup_matching_children "$STORAGE_ROOT/runtime/tmp" "*" 3
  cleanup_matching_children "$STORAGE_ROOT/runtime/work/.devspace-go-tmp" "go-build*" 2
  cleanup_matching_children "$STORAGE_ROOT/runtime/work/.devspace-tmp" "go-build*" 2
  cleanup_matching_children "$STORAGE_ROOT/runtime/work/.devspace-tmp" "sub2api-backup-part-*" 2
  cleanup_matching_children "$STORAGE_ROOT/runtime/home/.npm/_logs" "*.log" 14
}

routine_docker_cleanup() {
  docker_devserver container prune --force --filter until=24h >/dev/null
  docker_devserver image prune --force --filter until=168h >/dev/null
  run_builder_prune --force --filter until=24h --keep-storage 8GB
}

soft_pressure_cleanup() {
  log "soft disk-pressure cleanup"
  docker_devserver image prune --all --force --filter until=168h >/dev/null
  run_builder_prune --all --force --filter until=24h --keep-storage 4GB
}

active_build_processes() {
  docker_devserver top devserver -eo args 2>/dev/null \
    | tail -n +2 \
    | grep -Eq '(^|[ /])(go|git|npm|npx|pnpm|yarn|cargo|rustc|gcc|g\+\+|make)([ /]|$)'
}

hard_pressure_cleanup() {
  log "hard disk-pressure cleanup"
  docker_devserver image prune --all --force >/dev/null
  run_builder_prune --all --force --keep-storage 1GB

  if active_build_processes; then
    log "skipping package-cache cleanup while a build process is active"
    return 0
  fi

  docker_devserver exec --user 1000:1000 devserver sh -lc '
    npm cache clean --force >/dev/null 2>&1 || true
    pnpm store prune >/dev/null 2>&1 || true
    go clean -cache >/dev/null 2>&1 || true
  ' || log "package-cache cleanup returned a non-zero status"
}

ensure_container_running() {
  local name="$1"
  local status

  docker_devserver inspect "$name" >/dev/null 2>&1 || die "missing dedicated container: $name"
  status="$(docker_devserver inspect --format '{{.State.Status}}' "$name")"
  if [[ "$status" != "running" ]]; then
    log "starting stopped container: $name status=$status"
    docker_devserver start "$name" >/dev/null
  fi
}

wait_for_devserver_health() {
  local health
  local attempt

  for ((attempt = 0; attempt < 60; attempt++)); do
    health="$(docker_devserver inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' devserver)"
    if [[ "$health" == "healthy" ]]; then
      return 0
    fi
    if [[ "$(docker_devserver inspect --format '{{.State.Status}}' devserver)" != "running" ]]; then
      return 1
    fi
    sleep 2
  done
  return 1
}

heal_containers() {
  local health

  ensure_container_running devserver
  health="$(docker_devserver inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' devserver)"
  if [[ "$health" == "unhealthy" ]]; then
    log "restarting unhealthy devserver container"
    docker_devserver restart devserver >/dev/null
    wait_for_devserver_health || die "devserver did not become healthy after restart"
  elif [[ "$health" == "starting" ]]; then
    wait_for_devserver_health || die "devserver did not become healthy after start"
  elif [[ "$health" == "none" ]]; then
    die "devserver container has no healthcheck"
  fi

  ensure_container_running devserver-cloudflared
}

write_public_failure_count() {
  local count="$1"
  local temporary="$PUBLIC_FAILURE_FILE.$$"
  printf '%s\n' "$count" > "$temporary"
  mv -f "$temporary" "$PUBLIC_FAILURE_FILE"
}

check_public_health() {
  local failures=0

  if curl --noproxy '*' --fail --silent --show-error --max-time 15 \
    "$PUBLIC_HEALTH_URL" >/dev/null; then
    write_public_failure_count 0
    return 0
  fi

  if [[ -r "$PUBLIC_FAILURE_FILE" ]]; then
    failures="$(tr -dc '0-9' < "$PUBLIC_FAILURE_FILE")"
  fi
  failures="${failures:-0}"
  failures=$((failures + 1))
  write_public_failure_count "$failures"
  log "public health probe failed count=$failures limit=$PUBLIC_FAILURE_LIMIT"

  if (( failures < PUBLIC_FAILURE_LIMIT )); then
    return 0
  fi

  log "restarting cloudflared after consecutive public health failures"
  docker_devserver restart devserver-cloudflared >/dev/null
  sleep 5
  if curl --noproxy '*' --fail --silent --show-error --max-time 15 \
    "$PUBLIC_HEALTH_URL" >/dev/null; then
    write_public_failure_count 0
    return 0
  fi
  return 1
}

log_resource_state() {
  local pid
  local cgroup_relative
  local cgroup_root
  local memory_current="unknown"
  local memory_peak="unknown"
  local memory_max="unknown"
  local swap_current="unknown"
  local pids_current="unknown"
  local memory_events="unknown"

  pid="$(docker_devserver inspect --format '{{.State.Pid}}' devserver)"
  if [[ "$pid" =~ ^[1-9][0-9]*$ && -r "/proc/$pid/cgroup" ]]; then
    cgroup_relative="$(awk -F: '$1 == "0" { print $3 }' "/proc/$pid/cgroup")"
    cgroup_root="/sys/fs/cgroup${cgroup_relative}"
    [[ -r "$cgroup_root/memory.current" ]] && memory_current="$(<"$cgroup_root/memory.current")"
    [[ -r "$cgroup_root/memory.peak" ]] && memory_peak="$(<"$cgroup_root/memory.peak")"
    [[ -r "$cgroup_root/memory.max" ]] && memory_max="$(<"$cgroup_root/memory.max")"
    [[ -r "$cgroup_root/memory.swap.current" ]] && swap_current="$(<"$cgroup_root/memory.swap.current")"
    [[ -r "$cgroup_root/pids.current" ]] && pids_current="$(<"$cgroup_root/pids.current")"
    if [[ -r "$cgroup_root/memory.events" ]]; then
      memory_events="$(tr '\n' ',' < "$cgroup_root/memory.events")"
    fi
  fi

  log "resources disk_percent=$(disk_used_percent) memory_current=$memory_current memory_peak=$memory_peak memory_max=$memory_max swap_current=$swap_current pids_current=$pids_current memory_events=$memory_events"
}

main() {
  local used_before
  local used_after
  local health_result=0

  validate_integer DEVSERVER_DISK_SOFT_PERCENT "$DISK_SOFT_PERCENT" 1 99
  validate_integer DEVSERVER_DISK_HARD_PERCENT "$DISK_HARD_PERCENT" 1 99
  validate_integer DEVSERVER_DISK_CRITICAL_PERCENT "$DISK_CRITICAL_PERCENT" 1 99
  validate_integer DEVSERVER_PUBLIC_FAILURE_LIMIT "$PUBLIC_FAILURE_LIMIT" 1 100
  (( DISK_SOFT_PERCENT < DISK_HARD_PERCENT )) || die "soft threshold must be below hard threshold"
  (( DISK_HARD_PERCENT < DISK_CRITICAL_PERCENT )) || die "hard threshold must be below critical threshold"

  install -d -m 0755 "$STATE_ROOT"
  exec 9>"$LOCK_FILE"
  if ! flock -n 9; then
    log "another maintenance run is active"
    return 0
  fi

  validate_runtime
  heal_containers
  cleanup_stale_scratch
  routine_docker_cleanup

  used_before="$(disk_used_percent)"
  if (( used_before >= DISK_SOFT_PERCENT )); then
    soft_pressure_cleanup
  fi
  if (( used_before >= DISK_HARD_PERCENT )); then
    hard_pressure_cleanup
  fi
  if (( used_before >= DISK_CRITICAL_PERCENT )); then
    log "CRITICAL: storage remains above the critical watermark before cleanup"
  fi

  check_public_health || health_result=1
  used_after="$(disk_used_percent)"
  log_resource_state
  log "completed disk_before=${used_before}% disk_after=${used_after}% public_health=$([[ "$health_result" -eq 0 ]] && printf ok || printf failed)"
  return "$health_result"
}

main "$@"
