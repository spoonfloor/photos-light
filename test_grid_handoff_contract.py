#!/usr/bin/env python3
"""Static regression checks for virtual-grid catalog reset handoff invariants."""

from pathlib import Path
import re
import unittest


REPO_ROOT = Path(__file__).resolve().parent
MAIN_JS = REPO_ROOT / "static" / "js" / "main.js"
VIRTUAL_GRID_JS = REPO_ROOT / "static" / "js" / "virtualGrid.js"
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
