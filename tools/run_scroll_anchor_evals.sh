#!/usr/bin/env bash
# Autonomous scroll-anchor eval gate — run before requesting manual sort-toggle approval.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "=== Scroll anchor evals ==="

node --check tools/eval_scroll_anchor_harness.js
node --check static/js/gridScrollAnchor.js
node --check static/js/gridScrollTargetRecipe.js
node --check static/js/virtualGrid.js

node tools/eval_scroll_anchor_harness.js

python3 -m unittest test_scroll_anchor_eval.py -q

echo ""
echo "All scroll-anchor evals passed."
echo "Manual smoke still required for packaged UI (hydration/timing)."
