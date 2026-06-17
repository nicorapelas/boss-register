#!/usr/bin/env bash
set -euo pipefail

# Deploy POS to a single terminal (build + copy + restart).
#
# Usage:
#   scripts/deploy-pos-terminal.sh --name Posiflex --host 192.168.1.11 --user nico --till T1
#
# Or via env (backward compatible with deploy-posiflex.sh):
#   POS_HOST=192.168.1.12 POS_USER=nico VITE_POS_TILL_CODE=T2 scripts/deploy-pos-terminal.sh
#
# Optional:
#   VITE_API_BASE_URL=http://192.168.1.10:4000/api
#   POS_DISPLAY=:0
#   POS_XAUTHORITY=/home/nico/.Xauthority
#   POS_SKIP_BUILD=1   # push existing AppImage only (same till code as last build)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=pos-deploy-lib.sh
source "$SCRIPT_DIR/pos-deploy-lib.sh"

POS_TERMINAL_NAME="${POS_TERMINAL_NAME:-}"
POS_HOST="${POS_HOST:-${POSIFLEX_HOST:-}}"
POS_USER="${POS_USER:-${POSIFLEX_USER:-nico}}"
VITE_POS_TILL_CODE="${VITE_POS_TILL_CODE:-T1}"
API_BASE_URL="${VITE_API_BASE_URL:-http://192.168.1.10:4000/api}"
POS_DISPLAY="${POS_DISPLAY:-${POSIFLEX_DISPLAY:-:0}}"
POS_XAUTHORITY="${POS_XAUTHORITY:-${POSIFLEX_XAUTHORITY:-/home/${POS_USER}/.Xauthority}}"
POS_SKIP_BUILD="${POS_SKIP_BUILD:-0}"
SSH_OPTS="-o StrictHostKeyChecking=no"

usage() {
  cat <<'EOF'
Usage: deploy-pos-terminal.sh [options]

Options:
  --name NAME     Friendly label (e.g. Posiflex, NCR)
  --host HOST     Terminal IP or hostname
  --user USER     SSH user (default: nico)
  --till CODE     Till code baked into build (default: T1)
  --skip-build    Upload/restart using existing AppImage
  -h, --help      Show this help

Env: POS_HOST, POS_USER, VITE_POS_TILL_CODE, VITE_API_BASE_URL, POS_SKIP_BUILD=1
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
    --till)
      VITE_POS_TILL_CODE="$2"
      shift 2
      ;;
    --skip-build)
      POS_SKIP_BUILD=1
      shift
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

pos_deploy_one_terminal \
  "$POS_TERMINAL_NAME" \
  "$POS_HOST" \
  "$POS_USER" \
  "$VITE_POS_TILL_CODE" \
  "$API_BASE_URL" \
  "$POS_SKIP_BUILD" \
  "$SSH_OPTS" \
  "$POS_DISPLAY" \
  "$POS_XAUTHORITY"
