#!/usr/bin/env bash
# Map the NCR operator touchscreen (CoolTouch) to the primary display only.
# When a customer-facing monitor is connected, X maps touch across the full
# virtual desktop unless we apply a Coordinate Transformation Matrix.
set -euo pipefail

export DISPLAY="${DISPLAY:-:0}"
export XAUTHORITY="${XAUTHORITY:-${HOME}/.Xauthority}"

TOUCH_MATCH='CoolTouch'

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

touch_name="$(xinput list --name-only 2>/dev/null | grep -F "$TOUCH_MATCH" | head -1 || true)"
if [ -z "$touch_name" ]; then
  exit 0
fi

identity_matrix() {
  xinput set-prop "$touch_name" --type=float "Coordinate Transformation Matrix" \
    1 0 0 0 1 0 0 0 1 2>/dev/null || true
}

connected_count="$(xrandr --query 2>/dev/null | grep -c ' connected ' || true)"
if [ "${connected_count:-0}" -le 1 ]; then
  identity_matrix
  exit 0
fi

read -r TOTAL_W TOTAL_H < <(
  xrandr --query 2>/dev/null | awk '
    /current/ {
      for (i = 1; i <= NF; i++) {
        if ($i == "current") {
          w = $(i + 1); h = $(i + 3)
          gsub(",", "", w); gsub(",", "", h)
          print w, h
          exit
        }
      }
    }
  '
)
if [ -z "${TOTAL_W:-}" ] || [ -z "${TOTAL_H:-}" ] || [ "$TOTAL_W" -eq 0 ] || [ "$TOTAL_H" -eq 0 ]; then
  exit 0
fi

read -r OUT_W OUT_H OUT_X OUT_Y < <(
  xrandr --query 2>/dev/null | awk '
    / connected primary / {
      for (i = 1; i <= NF; i++) {
        if ($i ~ /^[0-9]+x[0-9]+\+[0-9]+\+[0-9]+$/) {
          split($i, p, /[x+]/)
          print p[1], p[2], p[3], p[4]
          exit
        }
      }
    }
  '
)
if [ -z "${OUT_W:-}" ] || [ -z "${OUT_H:-}" ]; then
  exit 0
fi

OUT_X="${OUT_X:-0}"
OUT_Y="${OUT_Y:-0}"

read -r a c e f < <(
  awk -v w="$OUT_W" -v h="$OUT_H" -v x="$OUT_X" -v y="$OUT_Y" -v tw="$TOTAL_W" -v th="$TOTAL_H" \
    'BEGIN {
      printf "%.10f %.10f %.10f %.10f\n", w / tw, x / tw, h / th, y / th
    }'
)

xinput set-prop "$touch_name" --type=float "Coordinate Transformation Matrix" \
  "$a" 0 "$c" 0 "$e" "$f" 0 0 1
