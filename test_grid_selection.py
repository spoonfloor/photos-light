"""Unit tests for shared grid selection logic."""

from __future__ import annotations

import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent


class GridSelectionSourceTest(unittest.TestCase):
    def test_module_defines_core_api(self):
        with open("static/js/photoSurface/gridSelection.js", encoding="utf-8") as handle:
            text = handle.read()
        for symbol in (
            "handleMonthCircleClick",
            "toggleCard",
            "selectRange",
            "updateMonthCircleStates",
        ):
            self.assertIn(symbol, text)
        with open("static/js/shareBoot.js", encoding="utf-8") as handle:
            share_boot = handle.read()
        self.assertIn("lastClickedIndex", share_boot)

    def test_main_app_uses_shared_selection_modules(self):
        with open("static/js/main.js", encoding="utf-8") as handle:
            text = handle.read()
        for symbol in (
            "GridSelection.toggleCard",
            "GridSelection.handleMonthCircleClick",
            "GridSelection.applyToDom",
            "GridInteractions.wireContainer",
            "PhotoChrome.updateFilterChips",
            "PhotoChrome.toggleUtilitiesMenu",
        ):
            self.assertIn(symbol, text)
        self.assertNotIn("function togglePhotoSelection", text)
        self.assertNotIn("gridInteractionsWired", text)

    def test_grid_interactions_single_listener(self):
        with open("static/js/photoSurface/gridInteractions.js", encoding="utf-8") as handle:
            text = handle.read()
        self.assertIn("WeakMap", text)
        self.assertNotIn("gridInteractionsWired", text)

    def test_photo_surface_init_module_exists(self):
        init_js = ROOT / "static" / "js" / "photoSurface" / "init.js"
        text = init_js.read_text(encoding="utf-8")
        self.assertIn("PhotoSurface.init", text)
        self.assertIn("PhotoGrid.render", text)

    def test_virtual_grid_uses_shared_tile_and_month_modules(self):
        with open("static/js/virtualGrid.js", encoding="utf-8") as handle:
            virtual = handle.read()
        self.assertIn("GridTile.createCard", virtual)
        self.assertIn("MonthGrid.buildMonthHeaderBand", virtual)

    def test_simple_grid_uses_month_grid(self):
        with open("static/js/photoSurface/simpleGrid.js", encoding="utf-8") as handle:
            text = handle.read()
        self.assertIn("MonthGrid.createMonthSection", text)
        self.assertIn("MonthGrid.monthKeyFromDate", text)

    def test_photo_grid_routes_virtual_and_eager(self):
        with open("static/js/photoSurface/photoGrid.js", encoding="utf-8") as handle:
            text = handle.read()
        self.assertIn("initVirtual", text)
        self.assertIn("SimplePhotoGrid.render", text)
        self.assertIn("caps.virtual", text)

    def test_share_boot_uses_incremental_updates(self):
        with open("static/js/shareBoot.js", encoding="utf-8") as handle:
            text = handle.read()
        self.assertIn("GridSelection.toggleCard", text)
        self.assertIn("patchStarOnGrid", text)
        self.assertIn("rebuildPhotoGrid", text)
        self.assertNotIn("refreshPhotoGrid", text)
        toggle_star_body = text.split("function toggleStar(photoId) {", 1)[1].split(
            "\n  function clearStars()", 1
        )[0]
        self.assertIn("patchStarOnGrid(id)", toggle_star_body)
        self.assertNotIn("rebuildPhotoGrid", toggle_star_body)

    def test_simple_grid_renders_month_select_circle(self):
        with open("static/js/photoSurface/monthGrid.js", encoding="utf-8") as handle:
            text = handle.read()
        self.assertIn("month-select-circle", text)
        self.assertIn("month-section", text)
        with open("static/js/photoSurface/simpleGrid.js", encoding="utf-8") as handle:
            simple = handle.read()
        self.assertIn("MonthGrid.createMonthSection", simple)


if __name__ == "__main__":
    unittest.main()
