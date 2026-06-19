#!/usr/bin/env python3
"""Quick NCR 2x20 line display test on the till (run on NCR via SSH).

Usage:
  python3 test-ncr-line-display.py [/dev/hidraw4] [mode]

Modes:
  classic   — 2-byte hidraw [0,byte], 18-char rows (original working test)
  padded    — 2-byte hidraw, 20-char rows + cursor 0x14 between rows
  report8   — 8-byte HID reports (usually wrong on XR7)
"""
import os
import sys
import time

ESC = 0x1B
LINE2_START = 0x14
PATH = sys.argv[1] if len(sys.argv) > 1 else "/dev/hidraw4"
MODE = sys.argv[2] if len(sys.argv) > 2 else "classic"


def send_2byte(path: str, data: bytes) -> None:
    fd = os.open(path, os.O_RDWR)
    try:
        for b in data:
            os.write(fd, bytes([0, b]))
            time.sleep(0.003)
    finally:
        os.close(fd)


def send_8byte(path: str, data: bytes) -> None:
    fd = os.open(path, os.O_RDWR)
    try:
        for b in data:
            os.write(fd, bytes([0, b & 0xFF, 0, 0, 0, 0, 0, 0]))
            time.sleep(0.005)
    finally:
        os.close(fd)


def main() -> None:
    if MODE == "classic":
        row1 = b"BYTE MODE TEST 1!!"
        row2 = b"BYTE MODE ROW 2!!!"
        payload = bytes([ESC, 0x05, ESC, 0x02]) + row1 + bytes([ESC, 0x13, LINE2_START]) + row2
        send_2byte(PATH, payload)
        print(f"classic: sent {len(payload)} bytes (2-byte reports) to {PATH}")
        return

    if MODE == "padded":
        row1 = b"*** drv5 test ***".ljust(20)[:20]
        row2 = b"Line display OK".ljust(20)[:20]
        payload = bytes([ESC, 0x05, ESC, 0x02]) + row1 + bytes([ESC, 0x13, LINE2_START]) + row2
        send_2byte(PATH, payload)
        print(f"padded: sent {len(payload)} bytes (2-byte reports) to {PATH}")
        return

    if MODE == "report8":
        row1 = b"*** drv5 test ***".ljust(20)[:20]
        row2 = b"Line display OK".ljust(20)[:20]
        payload = (
            bytes([ESC, 0x05, ESC, 0x0C, ESC, 0x02])
            + row1
            + bytes([ESC, 0x13, LINE2_START])
            + row2
        )
        send_8byte(PATH, payload)
        print(f"report8: sent {len(payload)} bytes (8-byte reports) to {PATH}")
        return

    print(f"Unknown mode {MODE!r}. Use classic, padded, or report8.", file=sys.stderr)
    sys.exit(1)


if __name__ == "__main__":
    main()
