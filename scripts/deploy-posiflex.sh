#!/usr/bin/env bash
set -euo pipefail

# Deploy POS to the Posiflex terminal (Till T1 @ 192.168.1.11).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=pos-deploy-lib.sh
source "$SCRIPT_DIR/pos-deploy-lib.sh"

export VITE_POS_TERMINAL_PROFILE=posiflex
SSH_OPTS="-o StrictHostKeyChecking=no"
POS_HOST="${POS_HOST:-${POSIFLEX_HOST:-192.168.1.11}}"
POS_USER="${POS_USER:-${POSIFLEX_USER:-nico}}"

pos_install_posiflex_serial_udev "$SSH_OPTS" "$POS_USER" "$POS_HOST" "$SCRIPT_DIR/udev/99-posiflex-serial.rules"

exec "$SCRIPT_DIR/deploy-pos-terminal.sh" \
  --name Posiflex \
  --host "$POS_HOST" \
  --user "$POS_USER" \
  --till "${VITE_POS_TILL_CODE:-T1}" \
  "$@"
