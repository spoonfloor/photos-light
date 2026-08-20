"""Guardrails: share viewer must be built from static/, not a forked UI."""

from __future__ import annotations

import re
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SHARE = ROOT / "share-viewer"
BUILD_SCRIPT = ROOT / "scripts" / "build-share-viewer.sh"
SHARE_OVERRIDES = ROOT / "static" / "css" / "share-overrides.css"
SHARE_BOOT = ROOT / "static" / "js" / "shareBoot.js"

FORBIDDEN_OVERRIDE_PATTERNS = [
    re.compile(r":root\s*\{"),
    re.compile(r"\.photo-grid\s*[\{,:]"),
    re.compile(r"\.photo-card\s*[\{,:]"),
    re.compile(r"\.filter-chip\s*[\{,:]"),
    re.compile(r"\.app-bar-icon-button\s*[\{,:]"),
    re.compile(r"\.material-symbols-outlined\s*[\{,:]"),
    re.compile(r"fonts\.googleapis\.com"),
]

FORBIDDEN_SHARE_BOOT_PATTERNS = [
    re.compile(r"groupByDay"),
    re.compile(r"groupByMonth"),
    re.compile(r"clusterMode"),
    re.compile(r"function renderGrid\s*\("),
    re.compile(r"buildGridStarBadgeHTML"),
    re.compile(r"window\.alert"),
    re.compile(r"handleLightboxKeyboard"),
    re.compile(r"/rest/v1/albums"),
    re.compile(r"/rest/v1/album_photos"),
    re.compile(r"function publicUrl\s*\("),
    re.compile(r"/storage/v1/object/public/"),
]

LIGHTBOX_SHELL = ROOT / "static" / "js" / "photoSurface" / "lightboxShell.js"


class ShareViewerBuildTest(unittest.TestCase):
    def test_build_script_produces_viewer(self):
        subprocess.run(["bash", str(BUILD_SCRIPT)], check=True, cwd=ROOT)
        self.assertTrue((SHARE / "index.html").is_file())
        self.assertTrue((SHARE / "css" / "styles.css").is_file())
        self.assertTrue((SHARE / "js" / "shareBoot.js").is_file())
        self.assertTrue((SHARE / "js" / "viewCapabilities.js").is_file())
        self.assertTrue((SHARE / "js" / "photoSurface" / "gridSelection.js").is_file())
        self.assertTrue((SHARE / "js" / "photoSurface" / "lightboxShell.js").is_file())
        self.assertTrue((SHARE / "fonts" / "MaterialSymbolsOutlined.woff2").is_file())

    def test_no_forked_share_css(self):
        self.assertFalse((SHARE / "css" / "share.css").exists())

    def test_no_legacy_app_js(self):
        self.assertFalse((SHARE / "js" / "app.js").exists())

    def test_index_uses_shared_stylesheet(self):
        index = (SHARE / "index.html").read_text(encoding="utf-8")
        self.assertIn('href="css/styles.css', index)
        self.assertNotIn("share.css", index)
        self.assertNotIn("fonts.googleapis.com", index)
        self.assertIn("js/shareBoot.js", index)
        self.assertIn("js/photoSurface/gridSelection.js", index)
        self.assertIn("js/photoSurface/filterChipLifecycle.js", index)
        self.assertIn("js/photoSurface/gridTile.js", index)
        self.assertIn("js/photoSurface/monthGrid.js", index)
        self.assertIn("js/photoSurface/init.js", index)
        self.assertIn("js/photoSurface/surfaceSkeletonGrid.js", index)
        self.assertIn("js/photoSurface/shareSkeletonGrid.js", index)
        self.assertIn("js/photoSurface/surfaceLoadOverlay.js", index)
        self.assertIn('id="surfaceLoadOverlay"', index)
        self.assertIn("js/photoSurface/lightboxMediaCache.js", index)
        self.assertIn("js/photoSurface/lightboxMedia.js", index)
        self.assertIn("js/photoSurface/lightboxShell.js", index)
        self.assertIn("js/photoSurface/shareDatePicker.js", index)
        self.assertIn("js/photoSurface/datePickerChrome.js", index)
        self.assertIn('id="lightboxInfoPanel"', index)

    def test_lightbox_shell_exports_shared_api(self):
        text = LIGHTBOX_SHELL.read_text(encoding="utf-8")
        for symbol in ("wire", "show", "hide", "handleKey", "refreshChrome", "setNavArrows"):
            self.assertIn(symbol, text)
        self.assertIn("addEventListener('keydown'", text)

    def test_share_boot_uses_lightbox_shell(self):
        text = SHARE_BOOT.read_text(encoding="utf-8")
        self.assertIn("LightboxShell.wire", text)

    def test_share_overrides_stay_minimal(self):
        text = SHARE_OVERRIDES.read_text(encoding="utf-8")
        for pattern in FORBIDDEN_OVERRIDE_PATTERNS:
            self.assertIsNone(
                pattern.search(text),
                f"share-overrides.css must not define {pattern.pattern}",
            )

    def test_share_boot_uses_shared_modules(self):
        text = SHARE_BOOT.read_text(encoding="utf-8")
        for pattern in FORBIDDEN_SHARE_BOOT_PATTERNS:
            self.assertIsNone(
                pattern.search(text),
                f"shareBoot.js must not reimplement {pattern.pattern}",
            )
        self.assertIn("PhotoSurface.init", text)
        self.assertIn("PhotoSurface.mountChrome", text)
        init_js = ROOT / "static" / "js" / "photoSurface" / "init.js"
        self.assertTrue(init_js.is_file())
        self.assertIn("renderGrid", init_js.read_text(encoding="utf-8"))
        self.assertNotIn("shareAppBar.html", BUILD_SCRIPT.read_text(encoding="utf-8"))
        self.assertIn("appBarShare.html", BUILD_SCRIPT.read_text(encoding="utf-8"))
        self.assertIn("filterChipRailShare.html", BUILD_SCRIPT.read_text(encoding="utf-8"))
        self.assertIn("surfaceLoadOverlayShareBoot.html", BUILD_SCRIPT.read_text(encoding="utf-8"))
        simple_grid = ROOT / "static" / "js" / "photoSurface" / "simpleGrid.js"
        self.assertIn("GridInteractions.wireContainer", simple_grid.read_text(encoding="utf-8"))
        self.assertIn("utilitiesMenuShare.html", BUILD_SCRIPT.read_text(encoding="utf-8"))
        self.assertIn("toast.html", BUILD_SCRIPT.read_text(encoding="utf-8"))
        self.assertIn("copyShareLink", text)
        self.assertIn("shareDisplayUrl", text)
        self.assertIn("Download failed", text)
        self.assertIn("LightboxShell.wire", text)
        self.assertIn("LightboxMedia.loadIntoContent", text)
        self.assertIn("LightboxMedia.prepareContentSwap", text)
        self.assertIn("LightboxMediaCache.prefetchAdjacent", text)
        self.assertIn("resolveShareMeta", text)
        self.assertIn("ShareSkeletonGrid.renderInstantBoot", text)
        self.assertIn("ShareSkeletonGrid.applyMeta", text)
        self.assertIn("SurfaceLoadOverlay.begin", text)
        self.assertIn("SurfaceLoadChrome.adoptLoading", text)
        self.assertIn("FilterChipLifecycle.applyAutoClear", text)
        self.assertIn("phase: 'meta'", text)
        self.assertIn("deferThumbSrc", text)
        self.assertIn("shareResolveUrl", text)

    def test_index_html_first_load_shell(self):
        index = (SHARE / "index.html").read_text(encoding="utf-8")
        self.assertIn('class="share-view surface-load-active surface-load-phase-loading', index)
        self.assertIn('id="surfaceLoadOverlay"', index)
        self.assertIn('style="display: flex"', index)
        self.assertNotIn('data-filter="recentImports"', index)
        self.assertIn('data-filter="starred"', index)
        self.assertIn('id="addPhotoBtn"', index)
        self.assertIn('id="copyShareLinkBtn"', index)
        self.assertNotIn('id="manageShareLinksBtn"', index)
        self.assertIn('id="toast"', index)

    def test_lightbox_fits_media_to_content_box(self):
        media = (ROOT / "static" / "js" / "photoSurface" / "lightboxMedia.js").read_text(
            encoding="utf-8"
        )
        css = (ROOT / "static" / "css" / "styles.css").read_text(encoding="utf-8")
        self.assertIn("function availableViewport", media)
        self.assertIn("relayoutCurrent", media)
        self.assertNotIn("calc(100vh - 100px)", css)
        info_at = css.find(".lightbox-info-panel")
        self.assertGreater(info_at, 0)
        snippet = css[info_at : info_at + 160]
        self.assertIn("position: relative", snippet)
        self.assertNotIn("position: fixed", snippet)

    def test_styles_css_is_copied_from_static(self):
        static_css = (ROOT / "static" / "css" / "styles.css").read_text(encoding="utf-8")
        share_css = (SHARE / "css" / "styles.css").read_text(encoding="utf-8")
        self.assertEqual(static_css, share_css)


if __name__ == "__main__":
    unittest.main()
