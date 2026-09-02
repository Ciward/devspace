#!/usr/bin/env bash

set -euo pipefail

readonly STORAGE_ROOT="/srv/devserver"
readonly EXPECTED_DEVICE="${DEVSERVER_STORAGE_DEVICE:-/dev/sdb1}"
readonly CONFIG_ROOT="/etc/devserver-runtime"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_DIR

die() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

[[ "$(id -u)" -eq 0 ]] || die "run as root"
mountpoint -q "$STORAGE_ROOT" || die "$STORAGE_ROOT is not a mountpoint"
actual_source="$(findmnt -rn -T "$STORAGE_ROOT" -o SOURCE)"
actual_fstype="$(findmnt -rn -T "$STORAGE_ROOT" -o FSTYPE)"
[[ "$(readlink -f "$actual_source")" == "$(readlink -f "$EXPECTED_DEVICE")" ]] || \
  die "unexpected storage source: $actual_source"
[[ "$actual_fstype" == "ext4" ]] || die "unexpected storage filesystem: $actual_fstype"

device_bytes="$(blockdev --getsize64 "$EXPECTED_DEVICE")"
minimum_bytes=$((99 * 1024 * 1024 * 1024))
maximum_bytes=$((100 * 1024 * 1024 * 1024))
(( device_bytes >= minimum_bytes && device_bytes <= maximum_bytes )) || \
  die "storage partition is not the dedicated 100 GiB device: $device_bytes bytes"

install -d -m 0755 \
  "$STORAGE_ROOT/containerd" \
  "$STORAGE_ROOT/docker" \
  "$STORAGE_ROOT/runtime" \
  "$STORAGE_ROOT/runtime/home" \
  "$STORAGE_ROOT/runtime/work" \
  "$STORAGE_ROOT/runtime/cloudflared"
install -d -m 01777 "$STORAGE_ROOT/runtime/tmp"
chown -R 1000:1000 "$STORAGE_ROOT/runtime"

install -d -m 0755 "$CONFIG_ROOT" /usr/local/libexec
install -m 0644 "$SCRIPT_DIR/runtime/containerd.toml" "$CONFIG_ROOT/containerd.toml"
install -m 0644 "$SCRIPT_DIR/runtime/daemon.json" "$CONFIG_ROOT/daemon.json"
install -m 0755 "$SCRIPT_DIR/devserver-network.sh" /usr/local/libexec/devserver-network.sh
install -m 0755 "$SCRIPT_DIR/devserver-maintenance.sh" /usr/local/libexec/devserver-maintenance.sh

dockerd --validate --config-file "$CONFIG_ROOT/daemon.json" >/dev/null
containerd --config "$CONFIG_ROOT/containerd.toml" config dump >/dev/null

for unit in \
  containerd-devserver.service \
  docker-devserver.service \
  devserver-network.service \
  devserver-health-proxy.socket \
  devserver-health-proxy.service \
  devserver-maintenance.service \
  devserver-maintenance.timer; do
  install -m 0644 "$SCRIPT_DIR/systemd/$unit" "/etc/systemd/system/$unit"
done

systemctl daemon-reload
systemctl enable containerd-devserver.service docker-devserver.service
systemctl stop docker-devserver.service
systemctl restart containerd-devserver.service
systemctl start docker-devserver.service

for _ in $(seq 1 30); do
  if DOCKER_HOST=unix:///run/docker-devserver.sock docker info >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
DOCKER_HOST=unix:///run/docker-devserver.sock docker info >/dev/null
systemctl enable devserver-network.service devserver-health-proxy.socket devserver-maintenance.timer
systemctl restart devserver-network.service
systemctl reset-failed devserver-health-proxy.socket
systemctl restart devserver-health-proxy.socket
systemctl enable --now devserver-maintenance.timer

printf 'DevServer isolated runtime ready: device=%s root=%s socket=%s\n' \
  "$actual_source" "$STORAGE_ROOT" /run/docker-devserver.sock
