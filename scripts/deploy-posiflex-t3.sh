#!/usr/bin/env bash
set -euo pipefail

# Deploy POS to Posiflex T3 (jacobs-3 @ 192.168.1.14).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=pos-deploy-lib.sh
source "$SCRIPT_DIR/pos-deploy-lib.sh"

export VITE_POS_TERMINAL_PROFILE=posiflex
SSH_OPTS="-o StrictHostKeyChecking=no"
POS_HOST="${POS_HOST:-192.168.1.14}"
POS_USER="${POS_USER:-nico}"

pos_install_posiflex_serial_udev "$SSH_OPTS" "$POS_USER" "$POS_HOST" "$SCRIPT_DIR/udev/99-posiflex-serial.rules"
pos_install_posiflex_touchscreen_xorg "$SSH_OPTS" "$POS_USER" "$POS_HOST" "$SCRIPT_DIR/xorg/99-touchscreen-matrix.conf"
pos_install_posiflex_dual_display "$SSH_OPTS" "$POS_USER" "$POS_HOST" "$SCRIPT_DIR/posiflex-dual-display-setup.sh"

exec "$SCRIPT_DIR/deploy-pos-terminal.sh" \
  --name "Posiflex T3" \
  --host "$POS_HOST" \
  --user "$POS_USER" \
  --till "${VITE_POS_TILL_CODE:-T3}" \
  "$@"
