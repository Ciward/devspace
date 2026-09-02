#!/usr/bin/env bash

set -euo pipefail

readonly STORAGE_ROOT="/srv/devserver"
readonly EXPECTED_DEVICE="${DEVSERVER_STORAGE_DEVICE:-/dev/sdb1}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_DIR
export DOCKER_HOST="unix:///run/docker-devserver.sock"

die() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

mountpoint -q "$STORAGE_ROOT" || die "$STORAGE_ROOT is not mounted"
actual_source="$(findmnt -rn -T "$STORAGE_ROOT" -o SOURCE)"
[[ "$(readlink -f "$actual_source")" == "$(readlink -f "$EXPECTED_DEVICE")" ]] || \
  die "unexpected storage source: $actual_source"
docker_root="$(docker info --format '{{.DockerRootDir}}')"
[[ "$docker_root" == "$STORAGE_ROOT/docker" ]] || die "unexpected Docker root: $docker_root"
systemctl is-active --quiet devserver-network.service || die "DevServer network service is inactive"
sudo /usr/local/libexec/devserver-network.sh check >/dev/null

exec docker compose -f "$SCRIPT_DIR/compose.yaml" "$@"
