#!/usr/bin/env bash

set -euo pipefail

readonly STORAGE_ROOT="/srv/devserver"
readonly EXPECTED_DEVICE="${DEVSERVER_STORAGE_DEVICE:-/dev/sdb1}"
readonly DOCKER_SOCKET="unix:///run/docker-devserver.sock"

die() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

mountpoint -q "$STORAGE_ROOT" || die "$STORAGE_ROOT is not mounted"
actual_source="$(findmnt -rn -T "$STORAGE_ROOT" -o SOURCE)"
[[ "$(readlink -f "$actual_source")" == "$(readlink -f "$EXPECTED_DEVICE")" ]] || \
  die "unexpected storage source: $actual_source"
[[ "$(DOCKER_HOST="$DOCKER_SOCKET" docker info --format '{{.DockerRootDir}}')" == "$STORAGE_ROOT/docker" ]] || \
  die "dedicated Docker root escaped the storage disk"
grep -Fqx 'root = "/srv/devserver/containerd"' /etc/devserver-runtime/containerd.toml || \
  die "dedicated containerd root escaped the storage disk"

for name in devserver devserver-cloudflared; do
  DOCKER_HOST="$DOCKER_SOCKET" docker inspect "$name" >/dev/null 2>&1 || die "missing dedicated container: $name"
  if docker inspect "$name" >/dev/null 2>&1; then
    die "system Docker still owns container: $name"
  fi
  log_path="$(DOCKER_HOST="$DOCKER_SOCKET" docker inspect --format '{{.LogPath}}' "$name")"
  [[ "$log_path" == "$STORAGE_ROOT/"* ]] || die "$name log escaped storage disk: $log_path"
done

while IFS='|' read -r container_name source destination rw; do
  [[ "$rw" == "true" ]] || continue
  [[ "$source" == "$STORAGE_ROOT/"* ]] || \
    die "$container_name writable mount escaped storage disk: $source -> $destination"
done < <(
  for name in devserver devserver-cloudflared; do
    DOCKER_HOST="$DOCKER_SOCKET" docker inspect --format \
      '{{range .Mounts}}{{printf "%s|%s|%s|%v\n" $.Name .Source .Destination .RW}}{{end}}' "$name"
  done
)

systemctl is-active --quiet containerd-devserver.service
systemctl is-active --quiet docker-devserver.service
systemctl is-active --quiet devserver-network.service
systemctl is-active --quiet devserver-health-proxy.socket
sudo /usr/local/libexec/devserver-network.sh system-bridge-check >/dev/null
sudo /usr/local/libexec/devserver-network.sh daemon-bridge-check >/dev/null
sudo /usr/local/libexec/devserver-network.sh check >/dev/null

printf 'DevServer storage isolation verified: source=%s docker=%s containerd=%s\n' \
  "$actual_source" "$STORAGE_ROOT/docker" "$STORAGE_ROOT/containerd"
