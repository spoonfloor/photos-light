"""Share media tier contract — publish, resolve, and viewer must stay aligned."""

from __future__ import annotations

import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SHARE_BOOT = ROOT / "static" / "js" / "shareBoot.js"
SHARE_RESOLVE = ROOT / "supabase" / "functions" / "share-resolve" / "index.ts"

BROWSER_NATIVE_STILL = {".jpg", ".jpeg", ".png", ".gif", ".webp"}


class ShareMediaContractTest(unittest.TestCase):
    def test_share_boot_resolves_display_url_with_native_original_fallback(self):
        text = SHARE_BOOT.read_text(encoding="utf-8")
        self.assertIn("function shareDisplayUrl(photo)", text)
        self.assertIn("BROWSER_NATIVE_STILL_EXTENSIONS", text)
        self.assertNotIn("useOriginal: false", text)
        lightbox_block = text.split("function renderLightboxMedia", 1)[1].split(
            "function closeLightbox",
            1,
        )[0]
        self.assertNotIn("mediaUrl(photo, 'thumb')", lightbox_block)
        open_block = text.split("function openLightbox", 1)[1].split("function stepLightbox", 1)[0]
        self.assertIn("if (!renderLightboxMedia())", open_block)
        self.assertIn("LightboxShell.show()", open_block)
        show_index = open_block.index("LightboxShell.show()")
        guard_index = open_block.index("if (!renderLightboxMedia())")
        self.assertLess(guard_index, show_index)

    def test_share_boot_download_uses_original_tier_only(self):
        text = SHARE_BOOT.read_text(encoding="utf-8")
        download_block = text.split("async function downloadPhotos", 1)[1].split(
            "function resolveDownloadTargets",
            1,
        )[0]
        self.assertIn("mediaUrl(photo, 'original')", download_block)
        self.assertNotIn("mediaUrl(photo, 'display')", download_block)
        self.assertIn("DownloadExport.shouldZip", download_block)
        self.assertIn("DownloadExport.downloadAsZip", download_block)
        self.assertIn("DownloadExport.buildShareArchiveFilename", download_block)
        self.assertNotIn("state.token || 'Shared Photos'", download_block)
        self.assertIn("Download failed", download_block)

    def test_download_export_zip_threshold_is_shared(self):
        text = (ROOT / "static" / "js" / "photoSurface" / "downloadExport.js").read_text(
            encoding="utf-8",
        )
        self.assertIn("const ZIP_THRESHOLD = 2", text)
        self.assertIn("function shouldZip(count, override)", text)

    def test_share_resolve_exports_display_url(self):
        text = SHARE_RESOLVE.read_text(encoding="utf-8")
        self.assertIn("display_path", text)
        self.assertIn("display_url: displayUrl", text)
        self.assertIn("BROWSER_NATIVE_STILL_EXTENSIONS", text)

    def test_viewer_and_resolve_share_browser_native_still_extensions(self):
        boot_text = SHARE_BOOT.read_text(encoding="utf-8")
        resolve_text = SHARE_RESOLVE.read_text(encoding="utf-8")
        boot_exts = set(re.findall(r"'\.\w+'", boot_text.split("BROWSER_NATIVE_STILL_EXTENSIONS", 1)[1][:400]))
        resolve_exts = set(
            re.findall(r'"\.\w+"', resolve_text.split("BROWSER_NATIVE_STILL_EXTENSIONS", 1)[1][:400]),
        )
        self.assertTrue(BROWSER_NATIVE_STILL.issubset({ext.strip("'\"") for ext in boot_exts}))
        self.assertEqual(
            {ext.strip("'\"") for ext in boot_exts},
            {ext.strip("'\"") for ext in resolve_exts},
        )


if __name__ == "__main__":
    unittest.main()
