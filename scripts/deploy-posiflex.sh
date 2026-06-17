#!/usr/bin/env bash
set -euo pipefail

# Deploy POS to the Posiflex terminal (Till T1 @ 192.168.1.11).
exec "$(dirname "$0")/deploy-pos-terminal.sh" \
  --name Posiflex \
  --host "${POS_HOST:-${POSIFLEX_HOST:-192.168.1.11}}" \
  --user "${POS_USER:-${POSIFLEX_USER:-nico}}" \
  --till "${VITE_POS_TILL_CODE:-T1}" \
  "$@"
