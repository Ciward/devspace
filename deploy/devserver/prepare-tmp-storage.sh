#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_DIR

printf 'prepare-tmp-storage.sh is retained as a compatibility entrypoint; installing the isolated runtime.\n' >&2
exec "$SCRIPT_DIR/install-isolated-runtime.sh" "$@"
