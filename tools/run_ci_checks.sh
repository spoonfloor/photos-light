#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

node --check static/js/main.js
node --check static/js/virtualGrid.js
python3 tools/check_orphan_routes.py
python3 -m unittest discover -q

echo "CI checks passed."
