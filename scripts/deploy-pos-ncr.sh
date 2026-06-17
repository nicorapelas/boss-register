#!/usr/bin/env bash
set -euo pipefail

# Deploy POS to the NCR terminal (Till T2 @ 192.168.1.12).
exec "$(dirname "$0")/deploy-pos-terminal.sh" \
  --name NCR \
  --host "${POS_HOST:-${POSIFLEX_HOST:-192.168.1.12}}" \
  --user "${POS_USER:-${POSIFLEX_USER:-nico}}" \
  --till "${VITE_POS_TILL_CODE:-T2}" \
  "$@"
