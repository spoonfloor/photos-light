#!/usr/bin/env python3
"""Static regression checks for virtual-grid catalog reset handoff invariants."""

from pathlib import Path
import re
import unittest


REPO_ROOT = Path(__file__).resolve().parent
MAIN_JS = REPO_ROOT / "static" / "js" / "main.js"
VIRTUAL_GRID_JS = REPO_ROOT / "static" / "js" / "virtualGrid.js"
GRID_LAYOUT_JS = REPO_ROOT / "static" / "js" / "gridLayout.js"
STYLES_CSS = REPO_ROOT / "static" / "css" / "styles.css"
APP_PY = REPO_ROOT / "app.py"


def _function_body(source, name):
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


class TestGridHandoffContract(unittest.TestCase):
    def setUp(self):
        self.main_js = MAIN_JS.read_text()
        self.virtual_grid_js = VIRTUAL_GRID_JS.read_text()
        self.grid_layout_js = GRID_LAYOUT_JS.read_text()
        self.styles_css = STYLES_CSS.read_text()
        self.app_py = APP_PY.read_text()

    def test_clean_completion_waits_for_catalog_rehydrate(self):
        body = _function_body(self.main_js, "executeCleanLibrary")
        rehydrate_at = body.find("await rehydrateLibraryCatalog({ throwOnError: true })")
        finished_at = body.find("showCleanLibraryFinishedUi()")
        self.assertGreaterEqual(rehydrate_at, 0)
        self.assertGreaterEqual(finished_at, 0)
        self.assertLess(rehydrate_at, finished_at)

    def test_committed_photo_load_rejects_provisional_virtual_grid(self):
        body = _function_body(self.main_js, "hasCommittedPhotoRender")
        self.assertIn("VirtualGrid.isActive()", body)
        self.assertIn("!VirtualGrid.getLayout()?.provisional", body)

    def test_safe_library_fallback_destroys_client_grid_session(self):
        body = _function_body(self.main_js, "renderSafeLibraryFallback")
        self.assertIn("currentPhotoLoadAbortController.abort()", body)
        self.assertIn("VirtualGrid.destroy()", body)
        self.assertIn("ThumbnailQueue.clear()", body)
        self.assertIn("resetPhotoWindowState()", body)
        self.assertIn("state.photoTotalCount = 0", body)
        self.assertIn("state.libraryPath = null", body)

    def test_virtual_grid_active_requires_connected_owned_dom(self):
        body = _function_body(self.virtual_grid_js, "isActive")
        self.assertIn("contentLayer.isConnected", body)
        self.assertIn("container.contains(contentLayer)", body)

    def test_refined_index_clears_provisional_artifacts_before_rebuild(self):
        body = _function_body(self.virtual_grid_js, "applyRefinedIndex")
        self.assertIn("const wasProvisional = Boolean(layout?.provisional)", body)
        clear_at = body.find("clearProvisionalArtifacts()")
        rebuild_at = body.find("rebuildLayoutFromIndex")
        self.assertGreaterEqual(clear_at, 0)
        self.assertGreaterEqual(rebuild_at, 0)
        self.assertLess(clear_at, rebuild_at)
        self.assertRegex(body, r"remount:\s*wasProvisional")

    def test_month_hydration_targets_virtual_sections_not_anchor(self):
        self.assertIn(
            'return `.virtual-month-section[data-month="${monthKey}"]`;',
            self.virtual_grid_js,
        )
        for name in (
            "hydrateMonthSection",
            "mountHydratedMonthSection",
            "mountPlaceholderSection",
            "revealCommittedSections",
            "setSectionsPending",
        ):
            body = _function_body(self.virtual_grid_js, name)
            self.assertIn("getMountedMonthSection(monthKey)", body)

    def test_grid_rhythm_tokens_shared_between_layout_css_and_virtual_grid(self):
        self.assertIn("function readGridRhythmTokens(container)", self.grid_layout_js)
        self.assertIn("getComputedStyle(container)", self.grid_layout_js)
        self.assertNotIn("const MONTH_HEADER_GAP = 20;", self.grid_layout_js)
        publish_body = _function_body(self.grid_layout_js, "publishCssVars")
        self.assertNotIn("'--grid-header-band-px'", publish_body)
        rhythm_body = _function_body(self.grid_layout_js, "readGridRhythmTokens")
        self.assertIn("'--grid-header-band-px'", rhythm_body)
        self.assertIn("function buildMonthHeaderBand(monthKey)", self.virtual_grid_js)
        self.assertIn("month-header-band", self.virtual_grid_js)
        self.assertNotIn(
            "headerGap.style.height = `${GridLayout.HEADER_BAND_HEIGHT}px`",
            self.virtual_grid_js,
        )
        self.assertIn(".month-header-band", self.styles_css)
        self.assertIn("--grid-header-band-px: calc(", self.styles_css)
        self.assertIn("height: var(--grid-header-band-px", self.styles_css)
        for token in (
            "--grid-gap-px:",
            "--grid-min-col-px:",
            "--grid-comfort-full-rows:",
            "--grid-comfort-partial-col-offset:",
            "--grid-comfort-partial-min-cols:",
        ):
            self.assertIn(token, self.styles_css)

    def test_publish_css_vars_sets_only_dynamic_geometry(self):
        body = _function_body(self.grid_layout_js, "publishCssVars")
        self.assertIn("'--grid-cols'", body)
        self.assertIn("'--grid-cell-px'", body)
        for static_token in (
            "'--grid-header-height-px'",
            "'--grid-header-gap-px'",
            "'--grid-month-section-margin-px'",
            "'--grid-gap-px'",
            "'--grid-header-band-px'",
        ):
            self.assertNotIn(static_token, body)

    def test_layout_math_reads_rhythm_tokens_not_js_constants(self):
        month_section_body = _function_body(self.grid_layout_js, "monthSectionHeight")
        chunk_body = _function_body(self.grid_layout_js, "tileChunkHeight")
        column_body = _function_body(self.grid_layout_js, "computeColumnLayout")
        self.assertIn("rhythm.headerBand", month_section_body)
        self.assertIn("rhythm.headerBand", chunk_body)
        self.assertIn("rhythm.comfortFullRows", chunk_body)
        self.assertIn("readGridRhythmTokens(container)", column_body)
        self.assertNotIn("HEADER_BAND_HEIGHT", month_section_body)
        self.assertNotIn("12 * cellSize", chunk_body)

    def test_comfort_chunk_builder_reads_repeat_pattern_tokens(self):
        body = _function_body(self.virtual_grid_js, "buildTileChunk")
        self.assertIn("rhythm.comfortFullRows", body)
        self.assertIn("comfortPartialCellCount", body)
        self.assertNotIn("row < 12", body)
        self.assertNotIn("columns - 2", body)

    def test_paged_grid_uses_css_rhythm_tokens(self):
        body = _function_body(self.main_js, "renderPhotoGrid")
        self.assertIn("setPagedGridContainerMode(container, true)", body)
        self.assertIn("month-header-band", body)
        self.assertIn(".grid-root.grid-paged .month-section", self.styles_css)
        self.assertIn(".grid-root.grid-paged .photo-grid", self.styles_css)
        self.assertIn("headerGap: 12", self.grid_layout_js)
        self.assertIn("headerBand: 56", self.grid_layout_js)
        self.assertIn("--grid-header-gap-px:", self.styles_css)
        rhythm_body = _function_body(self.grid_layout_js, "readGridRhythmTokens")
        self.assertIn("'--grid-header-gap-px'", rhythm_body)
        self.assertIn("'--grid-header-band-px'", rhythm_body)
        month_section_body = _function_body(self.grid_layout_js, "monthSectionHeight")
        self.assertIn("rhythm.headerBand", month_section_body)

    def test_healthy_open_library_skips_recovery_scan_before_switch(self):
        body = _function_body(self.main_js, "openLibraryFromBrowseUnified")
        healthy_match = re.search(
            r"if \(checkResult\.has_openable_db\) \{(.+?)\n\s*\}",
            body,
            re.DOTALL,
        )
        self.assertIsNotNone(healthy_match, "has_openable_db fast path not found")
        healthy_branch = healthy_match.group(1)
        self.assertIn("switchToLibrary", healthy_branch)
        self.assertNotIn("/api/library/make-perfect/scan", healthy_branch)
        self.assertNotIn("/api/library/recover-database", healthy_branch)
        self.assertNotIn("runLibraryRecoveryJourney", healthy_branch)

    def test_open_existing_library_uses_direct_switch_without_probe_scan(self):
        body = _function_body(self.main_js, "openExistingLibrary")
        self.assertIn("switchToLibrary", body)
        self.assertIn("showCancelButton", body)
        self.assertNotIn("/api/library/check", body)
        self.assertNotIn("/api/library/make-perfect/scan", body)
        self.assertNotIn("runLibraryRecoveryJourney", body)

    def test_switch_to_library_loads_grid_without_blocking_normalize_scan(self):
        body = _function_body(self.main_js, "switchToLibrary")
        self.assertIn("loadAndRenderPhotos", body)
        self.assertNotIn("/api/library/make-perfect/scan", body)
        self.assertNotIn("switchToLibraryWithBlockingNormalize", body)

    def test_import_complete_invalidates_grid_caches_before_sse_complete(self):
        complete_branch = self.app_py.split("elif event_name == 'complete':", 1)[1]
        complete_branch = complete_branch.split(
            "if not (yield from emit_event(event_name, payload)):",
            1,
        )[0]
        invalidate_at = complete_branch.find("invalidate_import_grid_caches()")
        log_path_at = complete_branch.find("payload['log_path'] = log_path_rel")
        self.assertGreaterEqual(invalidate_at, 0)
        self.assertGreaterEqual(log_path_at, 0)
        self.assertGreater(invalidate_at, log_path_at)


if __name__ == "__main__":
    unittest.main()
