#!/usr/bin/env bash
# Posiflex dual monitor + touch (matches working T1 @ 192.168.1.11).
# T3 has USB + IR touch devices; operator panel uses IRTOUCH mapped to LVDS1 (USB disabled).
set -euo pipefail

export DISPLAY="${DISPLAY:-:0}"
export XAUTHORITY="${XAUTHORITY:-${HOME}/.Xauthority}"

OPERATOR_OUTPUT="${POSIFLEX_OPERATOR_OUTPUT:-LVDS1}"
CUSTOMER_OUTPUT="${POSIFLEX_CUSTOMER_OUTPUT:-VGA1}"
IR_TOUCH_NAME="${POSIFLEX_IR_TOUCH_NAME:-Beijing IRTOUCH SYSTEMS Co.,LtD IRTOUCH InfraRed TouchScreen Mouse}"
USB_TOUCH_NAME="${POSIFLEX_USB_TOUCH_NAME:-Posiflex Inc. USB TOUCH V380}"

x_num="${DISPLAY#:}"
x_num="${x_num%%.*}"
for _ in $(seq 1 60); do
  if [ -S "/tmp/.X11-unix/X${x_num}" ]; then
    break
  fi
  sleep 1
done
sleep 1

if ! command -v xinput >/dev/null 2>&1 || ! command -v xrandr >/dev/null 2>&1; then
  exit 0
fi

connected_count="$(xrandr --query 2>/dev/null | grep -c ' connected ' || true)"
if [ "${connected_count:-0}" -le 1 ]; then
  exit 0
fi

if xrandr --query 2>/dev/null | grep -q "^${OPERATOR_OUTPUT} connected"; then
  xrandr --output "$OPERATOR_OUTPUT" --primary --auto --pos 0x0 2>/dev/null || true
fi
if xrandr --query 2>/dev/null | grep -q "^${CUSTOMER_OUTPUT} connected"; then
  xrandr --output "$CUSTOMER_OUTPUT" --auto --right-of "$OPERATOR_OUTPUT" 2>/dev/null || true
fi

# Same as T1 ~/.profile — IRTOUCH on operator LVDS; USB touch conflicts and stays off.
# Do not reset Coordinate Transformation Matrix after map-to-output; that undoes the mapping.
xinput disable "$USB_TOUCH_NAME" 2>/dev/null || true
xinput map-to-output "$IR_TOUCH_NAME" "$OPERATOR_OUTPUT" 2>/dev/null || true
