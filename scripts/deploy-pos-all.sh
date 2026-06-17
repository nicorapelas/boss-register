#!/usr/bin/env bash
set -euo pipefail

# Build and deploy POS to every terminal listed in scripts/pos-terminals.conf
#
# Usage:
#   scripts/deploy-pos-all.sh
#
# Each terminal gets its own build (till code is compiled into the AppImage).
# Optional env:
#   VITE_API_BASE_URL=http://192.168.1.10:4000/api
#   POS_TERMINALS_CONF=/path/to/custom.conf

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=pos-deploy-lib.sh
source "$SCRIPT_DIR/pos-deploy-lib.sh"

CONF="${POS_TERMINALS_CONF:-$SCRIPT_DIR/pos-terminals.conf}"
API_BASE_URL="${VITE_API_BASE_URL:-http://192.168.1.10:4000/api}"
POS_DISPLAY="${POS_DISPLAY:-:0}"
SSH_OPTS="-o StrictHostKeyChecking=no"

if [[ ! -f "$CONF" ]]; then
  echo "ERROR: Terminal config not found: $CONF" >&2
  exit 1
fi

entries=()
while IFS= read -r line || [[ -n "$line" ]]; do
  line="${line%%#*}"
  line="$(echo "$line" | xargs)"
  [[ -z "$line" ]] && continue
  entries+=("$line")
done < "$CONF"

if [[ ${#entries[@]} -eq 0 ]]; then
  echo "ERROR: No terminals in $CONF" >&2
  exit 1
fi

echo "== Deploy POS to ${#entries[@]} terminal(s) =="
failed=0

for entry in "${entries[@]}"; do
  IFS='|' read -r name host user till <<< "$entry"
  if [[ -z "$name" || -z "$host" || -z "$user" || -z "$till" ]]; then
    echo "ERROR: Invalid terminal entry (want name|host|user|till): $entry" >&2
    failed=$((failed + 1))
    continue
  fi

  xauthority="/home/${user}/.Xauthority"
  echo ""
  echo "========================================"
  echo " Terminal: $name ($till) @ $host"
  echo "========================================"

  if ! pos_deploy_one_terminal "$name" "$host" "$user" "$till" "$API_BASE_URL" 0 "$SSH_OPTS" "$POS_DISPLAY" "$xauthority"; then
    echo "ERROR: Deploy failed for $name ($host)" >&2
    failed=$((failed + 1))
  fi
done

echo ""
if [[ $failed -gt 0 ]]; then
  echo "Finished with $failed failure(s)." >&2
  exit 1
fi

echo "All terminal deploys complete."
