"""Share delivery policy tests."""

from __future__ import annotations

import re
import unittest
from pathlib import Path

from share_delivery import (
    SHARE_BROWSER_NATIVE_STILL_EXTENSIONS,
    delivered_filename_from_library_path,
    plan_share_delivery,
)

ROOT = Path(__file__).resolve().parent
SHARE_BOOT = ROOT / "static" / "js" / "shareBoot.js"
SHARE_RESOLVE = ROOT / "supabase" / "functions" / "share-resolve" / "index.ts"


class ShareDeliveryTest(unittest.TestCase):
    def test_native_still_unchanged(self):
        plan = plan_share_delivery("2026/vacation.png", "photo")
        self.assertEqual(plan.action, "still_native")
        self.assertEqual(plan.delivered_filename, "vacation.png")
        self.assertEqual(plan.content_type, "image/png")

    def test_heic_converts_to_jpg_filename(self):
        plan = plan_share_delivery("2026/vacation.heic", "photo")
        self.assertEqual(plan.action, "still_jpeg")
        self.assertEqual(plan.delivered_filename, "vacation.jpg")
        self.assertEqual(plan.storage_name, "original.jpg")
        self.assertEqual(plan.content_type, "image/jpeg")

    def test_dng_converts_to_jpg_filename(self):
        plan = plan_share_delivery("RAW/IMG_0001.dng", "photo")
        self.assertEqual(plan.action, "still_jpeg")
        self.assertEqual(plan.delivered_filename, "IMG_0001.jpg")

    def test_tiff_converts_to_jpg_filename(self):
        plan = plan_share_delivery("scan.tiff", "photo")
        self.assertEqual(plan.action, "still_jpeg")
        self.assertEqual(plan.delivered_filename, "scan.jpg")

    def test_delivered_filename_from_library_path(self):
        self.assertEqual(
            delivered_filename_from_library_path("a/b/c.dng", ".jpg"),
            "c.jpg",
        )

    def test_viewer_native_still_extensions_match_delivery_module(self):
        boot_text = SHARE_BOOT.read_text(encoding="utf-8")
        resolve_text = SHARE_RESOLVE.read_text(encoding="utf-8")
        boot_exts = set(
            re.findall(
                r"'\.\w+'",
                boot_text.split("BROWSER_NATIVE_STILL_EXTENSIONS", 1)[1][:400],
            )
        )
        resolve_exts = set(
            re.findall(
                r'"\.\w+"',
                resolve_text.split("BROWSER_NATIVE_STILL_EXTENSIONS", 1)[1][:400],
            )
        )
        normalized_boot = {ext.strip("'\"") for ext in boot_exts}
        normalized_resolve = {ext.strip("'\"") for ext in resolve_exts}
        delivery_exts = set(SHARE_BROWSER_NATIVE_STILL_EXTENSIONS)
        self.assertEqual(normalized_boot, delivery_exts)
        self.assertEqual(normalized_resolve, delivery_exts)


if __name__ == "__main__":
    unittest.main()
