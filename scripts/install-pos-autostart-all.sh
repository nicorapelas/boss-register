#!/usr/bin/env bash
set -euo pipefail

# Install login autostart on every terminal in scripts/pos-terminals.conf

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=pos-deploy-lib.sh
source "$SCRIPT_DIR/pos-deploy-lib.sh"

CONF="${POS_TERMINALS_CONF:-$SCRIPT_DIR/pos-terminals.conf}"
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

failed=0
for entry in "${entries[@]}"; do
  IFS='|' read -r name host user till <<< "$entry"
  if [[ -z "$name" || -z "$host" || -z "$user" ]]; then
    echo "ERROR: Invalid entry (want name|host|user|till): $entry" >&2
    failed=$((failed + 1))
    continue
  fi
  xauthority="/home/${user}/.Xauthority"
  echo ""
  echo "========================================"
  echo " Autostart: $name @ $host"
  echo "========================================"
  if ! pos_install_autostart_remote "$SSH_OPTS" "$user" "$host" "$POS_DISPLAY" "$xauthority"; then
    echo "ERROR: Autostart install failed for $name ($host)" >&2
    failed=$((failed + 1))
  fi
done

echo ""
if [[ $failed -gt 0 ]]; then
  echo "Finished with $failed failure(s)." >&2
  exit 1
fi
echo "Autostart installed on all terminals."
