#!/usr/bin/env bash

set -euo pipefail

readonly TMP_SIZE_GIB="80"
readonly MIN_HOST_HEADROOM_GIB="8"
readonly DEVSERVER_STATE_ROOT="${DEVSERVER_STATE_ROOT:-/home/ubuntu/.devserver}"
readonly TMP_IMAGE="${DEVSERVER_TMP_IMAGE:-${DEVSERVER_STATE_ROOT}/storage/devserver-tmp-80g.ext4}"
readonly TMP_MOUNT="${DEVSERVER_TMP_ROOT:-${DEVSERVER_STATE_ROOT}/tmp80}"
readonly FSTAB_ENTRY="${TMP_IMAGE} ${TMP_MOUNT} ext4 loop,nofail,nodev,nosuid 0 0"

if [[ "$(id -u)" -ne 0 ]]; then
  printf 'Run this script as root, for example with sudo.\n' >&2
  exit 2
fi

case "$TMP_IMAGE" in
  "${DEVSERVER_STATE_ROOT}/"*) ;;
  *) printf 'TMP image must stay under %s\n' "$DEVSERVER_STATE_ROOT" >&2; exit 3 ;;
esac
case "$TMP_MOUNT" in
  "${DEVSERVER_STATE_ROOT}/"*) ;;
  *) printf 'TMP mount must stay under %s\n' "$DEVSERVER_STATE_ROOT" >&2; exit 3 ;;
esac

mkdir -p "$(dirname "$TMP_IMAGE")" "$TMP_MOUNT"

expected_bytes=$((TMP_SIZE_GIB * 1024 * 1024 * 1024))
if [[ -e "$TMP_IMAGE" ]]; then
  actual_bytes="$(stat -c %s "$TMP_IMAGE")"
  if [[ "$actual_bytes" -ne "$expected_bytes" ]]; then
    printf 'Existing TMP image has unexpected size: %s bytes\n' "$actual_bytes" >&2
    exit 4
  fi
else
  backing_available_bytes="$(df -B1 --output=avail "$(dirname "$TMP_IMAGE")" | tail -n 1 | tr -d ' ')"
  minimum_available_bytes=$(((TMP_SIZE_GIB + MIN_HOST_HEADROOM_GIB) * 1024 * 1024 * 1024))
  if [[ "$backing_available_bytes" -lt "$minimum_available_bytes" ]]; then
    printf 'Not enough host disk space for %sGiB TMP plus %sGiB headroom\n' \
      "$TMP_SIZE_GIB" "$MIN_HOST_HEADROOM_GIB" >&2
    exit 6
  fi
  truncate -s "${TMP_SIZE_GIB}G" "$TMP_IMAGE"
  mkfs.ext4 -F -m 0 -L devserver-tmp "$TMP_IMAGE" >/dev/null
  chmod 0600 "$TMP_IMAGE"
fi

if ! grep -Fqx "$FSTAB_ENTRY" /etc/fstab; then
  printf '%s\n' "$FSTAB_ENTRY" >> /etc/fstab
fi

if ! mountpoint -q "$TMP_MOUNT"; then
  mount "$TMP_MOUNT"
fi

if [[ "$(findmnt -rn -T "$TMP_MOUNT" -o FSTYPE)" != "ext4" ]]; then
  printf 'DevServer TMP mount is not ext4: %s\n' "$TMP_MOUNT" >&2
  exit 5
fi

chmod 01777 "$TMP_MOUNT"
available_bytes="$(df -B1 --output=avail "$TMP_MOUNT" | tail -n 1 | tr -d ' ')"
printf 'DevServer /tmp storage ready: mount=%s size=%sGiB available_bytes=%s\n' \
  "$TMP_MOUNT" "$TMP_SIZE_GIB" "$available_bytes"
