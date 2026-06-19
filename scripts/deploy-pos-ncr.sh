#!/usr/bin/env bash
set -euo pipefail

# Deploy POS to the NCR terminal (Till T2 @ 192.168.1.12).
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=pos-deploy-lib.sh
source "$SCRIPT_DIR/pos-deploy-lib.sh"

POS_HOST="${POS_HOST:-${POSIFLEX_HOST:-192.168.1.12}}"
POS_USER="${POS_USER:-${POSIFLEX_USER:-nico}}"
SSH_OPTS="-o StrictHostKeyChecking=no"

pos_install_ncr_printer_udev "$SSH_OPTS" "$POS_USER" "$POS_HOST" "$SCRIPT_DIR/udev/99-ncr-pos-printer.rules"
pos_install_ncr_line_display_udev "$SSH_OPTS" "$POS_USER" "$POS_HOST" "$SCRIPT_DIR/udev/99-ncr-line-display.rules"

exec "$SCRIPT_DIR/deploy-pos-terminal.sh" \
  --name NCR \
  --host "$POS_HOST" \
  --user "$POS_USER" \
  --till "${VITE_POS_TILL_CODE:-T2}" \
  "$@"
