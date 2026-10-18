#!/bin/bash
cd "$(dirname "$0")" || exit 1
if command -v python3 >/dev/null 2>&1; then
  python3 launch.py
elif command -v python >/dev/null 2>&1; then
  python launch.py
else
  echo "Please install Python 3.12 or later from python.org."
fi
read -r -p "Press Enter to close this window. "
