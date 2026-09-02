#!/usr/bin/env bash

set -euo pipefail

readonly DOCKER_SOCKET="unix:///run/docker-devserver.sock"
readonly NETWORK_NAME="devserver-edge"
readonly NETWORK_SUBNET="172.30.250.0/24"
readonly NETWORK_GATEWAY="172.30.250.1"
readonly BRIDGE_NAME="br-devserver"
readonly DAEMON_BRIDGE_NAME="br-ds-default"
readonly DAEMON_BRIDGE_SUBNET="172.30.251.0/24"
readonly DAEMON_BRIDGE_CIDR="172.30.251.1/24"

die() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

docker_devserver() {
  DOCKER_HOST="$DOCKER_SOCKET" docker "$@"
}

docker_system() {
  DOCKER_HOST="unix:///var/run/docker.sock" docker "$@"
}

ensure_root() {
  [[ "$(id -u)" -eq 0 ]] || die "run as root"
}

ensure_daemon_bridge() {
  local configured_cidrs

  if ip link show "$DAEMON_BRIDGE_NAME" >/dev/null 2>&1; then
    [[ -d "/sys/class/net/$DAEMON_BRIDGE_NAME/bridge" ]] || \
      die "$DAEMON_BRIDGE_NAME exists but is not a Linux bridge"
  else
    ip link add name "$DAEMON_BRIDGE_NAME" type bridge
  fi

  configured_cidrs="$(ip -4 -o addr show dev "$DAEMON_BRIDGE_NAME" scope global | awk '{print $4}')"
  if [[ -z "$configured_cidrs" ]]; then
    ip addr add "$DAEMON_BRIDGE_CIDR" dev "$DAEMON_BRIDGE_NAME"
  elif [[ "$configured_cidrs" != "$DAEMON_BRIDGE_CIDR" ]]; then
    die "unexpected $DAEMON_BRIDGE_NAME IPv4 configuration: $configured_cidrs"
  fi

  ip link set "$DAEMON_BRIDGE_NAME" up
}

check_daemon_bridge() {
  [[ -d "/sys/class/net/$DAEMON_BRIDGE_NAME/bridge" ]] || \
    die "missing Linux bridge: $DAEMON_BRIDGE_NAME"
  ip -4 -o addr show dev "$DAEMON_BRIDGE_NAME" scope global | \
    awk '{print $4}' | grep -Fqx "$DAEMON_BRIDGE_CIDR" || \
    die "missing $DAEMON_BRIDGE_CIDR on $DAEMON_BRIDGE_NAME"
  ip link show "$DAEMON_BRIDGE_NAME" | grep -Eq '<[^>]*UP[^>]*>' || \
    die "$DAEMON_BRIDGE_NAME is not administratively up"
}

check_system_bridge() {
  local bridge_name
  local bridge_record
  local gateway
  local prefix
  local subnet

  bridge_record="$(docker_system network inspect --format \
    '{{(index .IPAM.Config 0).Subnet}}|{{(index .IPAM.Config 0).Gateway}}|{{index .Options "com.docker.network.bridge.name"}}' \
    bridge)" || die "cannot inspect the system Docker bridge"
  IFS='|' read -r subnet gateway bridge_name <<<"$bridge_record"
  [[ -n "$subnet" && -n "$gateway" ]] || die "system Docker bridge has no IPv4 configuration"
  [[ -n "$bridge_name" && "$bridge_name" != "<no value>" ]] || bridge_name="docker0"
  [[ -d "/sys/class/net/$bridge_name/bridge" ]] || die "missing system Docker bridge: $bridge_name"

  prefix="${subnet#*/}"
  ip -4 -o addr show dev "$bridge_name" scope global | \
    awk '{print $4}' | grep -Fqx "$gateway/$prefix" || \
    die "missing $gateway/$prefix on system Docker bridge $bridge_name"
  ip -4 route show "$subnet" dev "$bridge_name" | grep -Fq "$subnet" || \
    die "missing system Docker bridge route: $subnet via $bridge_name"
}

ensure_network() {
  local actual
  if ! docker_devserver network inspect "$NETWORK_NAME" >/dev/null 2>&1; then
    docker_devserver network create \
      --driver bridge \
      --subnet "$NETWORK_SUBNET" \
      --gateway "$NETWORK_GATEWAY" \
      --opt "com.docker.network.bridge.name=$BRIDGE_NAME" \
      "$NETWORK_NAME" >/dev/null
  fi
  actual="$(docker_devserver network inspect --format '{{(index .IPAM.Config 0).Subnet}}|{{(index .IPAM.Config 0).Gateway}}|{{index .Options "com.docker.network.bridge.name"}}' "$NETWORK_NAME")"
  [[ "$actual" == "$NETWORK_SUBNET|$NETWORK_GATEWAY|$BRIDGE_NAME" ]] || \
    die "unexpected network configuration: $actual"
  ip link show "$BRIDGE_NAME" >/dev/null 2>&1 || die "missing bridge: $BRIDGE_NAME"
}

add_rule() {
  local table="$1"
  shift
  if [[ "$table" == "filter" ]]; then
    iptables -w -C DOCKER-USER "$@" 2>/dev/null || iptables -w -I DOCKER-USER 1 "$@"
  else
    iptables -w -t nat -C POSTROUTING "$@" 2>/dev/null || \
      iptables -w -t nat -I POSTROUTING 1 "$@"
  fi
}

delete_rule() {
  local table="$1"
  shift
  if [[ "$table" == "filter" ]]; then
    while iptables -w -C DOCKER-USER "$@" 2>/dev/null; do
      iptables -w -D DOCKER-USER "$@"
    done
  else
    while iptables -w -t nat -C POSTROUTING "$@" 2>/dev/null; do
      iptables -w -t nat -D POSTROUTING "$@"
    done
  fi
}

rules_up() {
  iptables -w -n -L DOCKER-USER >/dev/null 2>&1 || die "system Docker DOCKER-USER chain is unavailable"
  add_rule filter -i "$BRIDGE_NAME" -j ACCEPT
  add_rule filter -o "$BRIDGE_NAME" -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT
  add_rule nat -s "$NETWORK_SUBNET" ! -o "$BRIDGE_NAME" -j MASQUERADE
  add_rule filter -i "$DAEMON_BRIDGE_NAME" -j ACCEPT
  add_rule filter -o "$DAEMON_BRIDGE_NAME" -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT
  add_rule nat -s "$DAEMON_BRIDGE_SUBNET" ! -o "$DAEMON_BRIDGE_NAME" -j MASQUERADE
}

rules_down() {
  delete_rule filter -i "$BRIDGE_NAME" -j ACCEPT
  delete_rule filter -o "$BRIDGE_NAME" -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT
  delete_rule nat -s "$NETWORK_SUBNET" ! -o "$BRIDGE_NAME" -j MASQUERADE
  delete_rule filter -i "$DAEMON_BRIDGE_NAME" -j ACCEPT
  delete_rule filter -o "$DAEMON_BRIDGE_NAME" -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT
  delete_rule nat -s "$DAEMON_BRIDGE_SUBNET" ! -o "$DAEMON_BRIDGE_NAME" -j MASQUERADE
}

rules_check() {
  ensure_network
  iptables -w -C DOCKER-USER -i "$BRIDGE_NAME" -j ACCEPT
  iptables -w -C DOCKER-USER -o "$BRIDGE_NAME" -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT
  iptables -w -t nat -C POSTROUTING -s "$NETWORK_SUBNET" ! -o "$BRIDGE_NAME" -j MASQUERADE
  iptables -w -C DOCKER-USER -i "$DAEMON_BRIDGE_NAME" -j ACCEPT
  iptables -w -C DOCKER-USER -o "$DAEMON_BRIDGE_NAME" -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT
  iptables -w -t nat -C POSTROUTING -s "$DAEMON_BRIDGE_SUBNET" ! -o "$DAEMON_BRIDGE_NAME" -j MASQUERADE
}

ensure_root
case "${1:-}" in
  system-bridge-check)
    check_system_bridge
    ;;
  daemon-bridge-up)
    ensure_daemon_bridge
    check_daemon_bridge
    ;;
  daemon-bridge-check)
    check_daemon_bridge
    ;;
  up)
    ensure_network
    rules_up
    ;;
  down)
    rules_down
    ;;
  check)
    rules_check
    ;;
  *)
    die "usage: $0 system-bridge-check|daemon-bridge-up|daemon-bridge-check|up|down|check"
    ;;
esac
