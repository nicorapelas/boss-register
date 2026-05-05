#!/usr/bin/env bash
set -euo pipefail

# Usage:
#   scripts/deploy-posiflex.sh
# Optional env overrides:
#   POSIFLEX_HOST=192.168.1.11 POSIFLEX_USER=nico VITE_API_BASE_URL=http://192.168.1.10:4000/api scripts/deploy-posiflex.sh

POSIFLEX_HOST="${POSIFLEX_HOST:-192.168.1.11}"
POSIFLEX_USER="${POSIFLEX_USER:-nico}"
POSIFLEX_DISPLAY="${POSIFLEX_DISPLAY:-:0}"
POSIFLEX_XAUTHORITY="${POSIFLEX_XAUTHORITY:-/home/${POSIFLEX_USER}/.Xauthority}"
API_BASE_URL="${VITE_API_BASE_URL:-http://192.168.1.10:4000/api}"
REMOTE_APP="/home/${POSIFLEX_USER}/electropos-new.AppImage"
SSH_OPTS="-o StrictHostKeyChecking=no"

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

VERSION="$(node -p "JSON.parse(require('fs').readFileSync('package.json','utf8')).version")"
APP_IMAGE="$ROOT_DIR/release/$VERSION/ElectroPOS Register-Linux-$VERSION.AppImage"

echo "== Build POS v$VERSION =="
VITE_API_BASE_URL="$API_BASE_URL" npm run build
npx electron-builder --publish never --linux AppImage

if [[ ! -f "$APP_IMAGE" ]]; then
  echo "ERROR: AppImage not found: $APP_IMAGE" >&2
  exit 1
fi

echo "== Copy AppImage to ${POSIFLEX_USER}@${POSIFLEX_HOST} =="
scp $SSH_OPTS "$APP_IMAGE" "${POSIFLEX_USER}@${POSIFLEX_HOST}:${REMOTE_APP}"

echo "== Restart POS on Posiflex =="
ssh $SSH_OPTS "${POSIFLEX_USER}@${POSIFLEX_HOST}" "
  pids=\"\$(pgrep -x electropos-pos || true)\"
  [ -n \"\$pids\" ] && kill -9 \$pids || true
  chmod +x \"$REMOTE_APP\"
  nohup env DISPLAY=\"$POSIFLEX_DISPLAY\" XAUTHORITY=\"$POSIFLEX_XAUTHORITY\" \"$REMOTE_APP\" --no-sandbox --disable-gpu > /home/${POSIFLEX_USER}/electropos.log 2>&1 < /dev/null &
  sleep 2
  echo REMOTE_PROCESS:
  pgrep -af \"$REMOTE_APP|electropos-pos\" || true
  echo REMOTE_LOG:
  tail -n 25 /home/${POSIFLEX_USER}/electropos.log || true
"

echo "Deploy complete: POS v$VERSION"
