#!/usr/bin/env python3
"""Scroll-anchor eval runner + static contract checks for sort-toggle work."""

from __future__ import annotations

import json
import re
import subprocess
import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parent
HARNESS = REPO_ROOT / "tools" / "eval_scroll_anchor_harness.js"
GRID_SCROLL_ANCHOR_JS = REPO_ROOT / "static" / "js" / "gridScrollAnchor.js"
VIRTUAL_GRID_JS = REPO_ROOT / "static" / "js" / "virtualGrid.js"
GRID_LAYOUT_JS = REPO_ROOT / "static" / "js" / "gridLayout.js"


def _function_body(source: str, name: str) -> str:
    match = re.search(rf"function {name}\([^)]*\) \{{", source)
    if not match:
        raise AssertionError(f"{name} not found")
    start = match.end()
    depth = 1
    index = start
    while index < len(source) and depth:
        char = source[index]
        if char == "{":
            depth += 1
        elif char == "}":
            depth -= 1
        index += 1
    if depth:
        raise AssertionError(f"{name} body did not close")
    return source[start : index - 1]


class TestScrollAnchorHarness(unittest.TestCase):
    def test_node_harness_syntax(self):
        subprocess.run(
            ["node", "--check", str(HARNESS)],
            check=True,
            cwd=REPO_ROOT,
        )

    def test_recipe_module_syntax(self):
        subprocess.run(
            ["node", "--check", str(REPO_ROOT / "static/js/gridScrollTargetRecipe.js")],
            check=True,
            cwd=REPO_ROOT,
        )

    def test_scroll_target_recipe_fixture_exists(self):
        recipe_path = REPO_ROOT / "tools/fixtures/scroll_anchor_recipe.json"
        self.assertTrue(recipe_path.is_file(), "scroll_anchor_recipe.json required")
        recipe = json.loads(recipe_path.read_text())
        self.assertGreaterEqual(len(recipe.get("steps") or []), 1)
        self.assertIn("containerWidth", recipe.get("setup") or {})

    def test_offline_eval_harness_passes(self):
        proc = subprocess.run(
            ["node", str(HARNESS), "--json"],
            check=False,
            cwd=REPO_ROOT,
            capture_output=True,
            text=True,
        )
        self.assertEqual(
            proc.returncode,
            0,
            msg=f"harness failed:\n{proc.stdout}\n{proc.stderr}",
        )
        summary = json.loads(proc.stdout)
        self.assertEqual(summary["required_failed"], 0, summary)
        self.assertEqual(summary["guard_failed"], 0, summary)
        self.assertGreaterEqual(summary["passed"], 11, summary)


class TestScrollAnchorContract(unittest.TestCase):
    def setUp(self):
        self.grid_scroll_anchor_js = GRID_SCROLL_ANCHOR_JS.read_text()
        self.virtual_grid_js = VIRTUAL_GRID_JS.read_text()
        self.grid_layout_js = GRID_LAYOUT_JS.read_text()

    def test_sort_toggle_resolver_uses_freeze_row_not_catalog_home(self):
        body = _function_body(self.grid_scroll_anchor_js, "resolveScrollAnchor")
        self.assertIn("TRIGGER.SORT_TOGGLE", body)
        self.assertIn("KIND.FREEZE_ROW", body)
        self.assertNotIn("catalogHomeAfterSort", body)

    def test_apply_date_then_row_requires_row(self):
        body = _function_body(self.grid_scroll_anchor_js, "applyScrollAnchor")
        date_branch = body.split("case KIND.DATE_THEN_ROW:")[1].split("case KIND.FREEZE_ROW:")[0]
        self.assertIn("if (anchor.row)", date_branch)
        self.assertIn("return false", date_branch)

    def test_restore_wires_filter_prepare_before_apply(self):
        body = _function_body(self.virtual_grid_js, "restoreScrollAfterLayoutChange")
        prepare_at = body.find("prepareFilterScrollAnchor(")
        apply_at = body.find("applyGridScrollAnchor(anchor)")
        self.assertGreaterEqual(prepare_at, 0)
        self.assertGreaterEqual(apply_at, 0)
        self.assertLess(prepare_at, apply_at)

    def test_sort_path_has_no_edge_exceptions(self):
        self.assertNotIn("function prepareSortScrollAnchor", self.virtual_grid_js)
        self.assertNotIn("previousEdgeMax", self.virtual_grid_js)

    def test_apply_sort_disables_pixel_fallback(self):
        body = _function_body(self.virtual_grid_js, "applySortOrderInstant")
        self.assertIn("applyCatalogFilterWarm", body)
        self.assertIn("allowPixelFallback: false", body)

    def test_sort_capture_uses_dom_visible_row_even_at_home(self):
        body = _function_body(self.virtual_grid_js, "captureGridScrollAnchor")
        self.assertIn("findTopmostVisiblePhotoRowAnchor", body)
        self.assertNotIn("scrollTop > GridScrollAnchor.HOME_SCROLL_EPSILON", body)

    def test_layout_exports_row_anchor_helpers(self):
        exports = self.grid_layout_js.split("return {", 1)[1]
        for symbol in (
            "findTopVisibleRowAnchor",
            "scrollTopToPreserveRowViewportY",
            "scrollTopToAlignRowIndex",
            "homeGridTopDocumentY",
        ):
            self.assertIn(symbol, exports)


if __name__ == "__main__":
    unittest.main()
