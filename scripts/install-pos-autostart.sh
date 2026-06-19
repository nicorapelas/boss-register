#!/usr/bin/env bash
set -euo pipefail

# Install CogniPOS login autostart on a POS terminal (no rebuild / redeploy).
#
# Usage:
#   scripts/install-pos-autostart.sh --host 192.168.1.11 --user nico
#   POS_HOST=192.168.1.12 scripts/install-pos-autostart.sh
#
# Requires: SSH access, AppImage already at ~/electropos-new.AppImage
# Optional: POS_DISPLAY=:0  POS_XAUTHORITY=/home/nico/.Xauthority

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=pos-deploy-lib.sh
source "$SCRIPT_DIR/pos-deploy-lib.sh"

POS_TERMINAL_NAME="${POS_TERMINAL_NAME:-}"
POS_HOST="${POS_HOST:-${POSIFLEX_HOST:-}}"
POS_USER="${POS_USER:-${POSIFLEX_USER:-nico}}"
POS_DISPLAY="${POS_DISPLAY:-${POSIFLEX_DISPLAY:-:0}}"
POS_XAUTHORITY="${POS_XAUTHORITY:-${POSIFLEX_XAUTHORITY:-/home/${POS_USER}/.Xauthority}}"
SSH_OPTS="-o StrictHostKeyChecking=no"

usage() {
  cat <<'EOF'
Usage: install-pos-autostart.sh [options]

Install CogniPOS Register autostart on a till (opens app when the user logs in).

Options:
  --name NAME   Friendly label (optional, for log output)
  --host HOST   Terminal IP or hostname
  --user USER   SSH user (default: nico)
  -h, --help    Show this help

Env: POS_HOST, POS_USER, POS_DISPLAY, POS_XAUTHORITY
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --name)
      POS_TERMINAL_NAME="$2"
      shift 2
      ;;
    --host)
      POS_HOST="$2"
      shift 2
      ;;
    --user)
      POS_USER="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if [[ -z "$POS_HOST" ]]; then
  echo "ERROR: Set --host or POS_HOST" >&2
  usage >&2
  exit 1
fi

if [[ -z "$POS_TERMINAL_NAME" ]]; then
  POS_TERMINAL_NAME="${POS_HOST}"
fi

echo "== Autostart: ${POS_TERMINAL_NAME} @ ${POS_HOST} (${POS_USER}) =="
pos_install_autostart_remote "$SSH_OPTS" "$POS_USER" "$POS_HOST" "$POS_DISPLAY" "$POS_XAUTHORITY"
echo "Done. CogniPOS will launch after ${POS_USER} logs into the desktop session."
