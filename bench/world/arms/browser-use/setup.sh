#!/bin/sh
# Install Browser Use into this folder's .venv only. sleight-arch runs this; lanes do not.
set -eu
cd "$(dirname "$0")"
PIN=$(sed -n 's/.*"browser-use==\([^"]*\)".*/\1/p' pyproject.toml)
if [ "${1:-}" = --dry-run ]; then
  echo "uv sync --python 3.12 --frozen  # browser-use==${PIN}"
  exit 0
fi
uv sync --python 3.12 --frozen
