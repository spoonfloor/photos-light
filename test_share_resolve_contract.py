"""Contract tests for share-resolve edge function."""

from __future__ import annotations

import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SHARE_RESOLVE = ROOT / "supabase" / "functions" / "share-resolve" / "index.ts"


class ShareResolveContractTest(unittest.TestCase):
    def test_meta_phase_supported(self):
        text = SHARE_RESOLVE.read_text(encoding="utf-8")
        self.assertIn('phase === "meta"', text)
        self.assertIn("first_cluster", text)
        self.assertIn("photo_count", text)
        meta_block = text.split('if (phase === "meta")', 1)[1].split("const { data: photoRows", 1)[0]
        self.assertIn("day_key", text)
        meta_block = text.split('if (phase === "meta")', 1)[1].split("const { data: photoRows", 1)[0]
        self.assertIn("day_key", meta_block)
        self.assertNotIn("createSignedUrl", meta_block)

    def test_full_phase_signs_display_urls(self):
        text = SHARE_RESOLVE.read_text(encoding="utf-8")
        self.assertIn("display_path", text)
        self.assertIn("display_url", text)

    def test_sort_order_query_param(self):
        text = SHARE_RESOLVE.read_text(encoding="utf-8")
        self.assertIn('parseSortOrder', text)
        self.assertIn('searchParams.get("sort")', text)

    def test_structured_error_codes(self):
        text = SHARE_RESOLVE.read_text(encoding="utf-8")
        self.assertIn('code: "share_not_found"', text)
        self.assertIn('code: "share_revoked"', text)
        self.assertIn('code: "share_expired"', text)
        self.assertIn('code: "share_unavailable"', text)
        self.assertIn('code: "share_misconfigured"', text)
        self.assertIn('kind: "db_error"', text)
        self.assertNotIn("albumIsAccessible", text)

    def test_db_errors_are_unavailable_not_not_found(self):
        text = SHARE_RESOLVE.read_text(encoding="utf-8")
        lookup_block = text.split("async function loadAlbumByToken", 1)[1].split(
            "async function loadFirstClusterPhoto",
            1,
        )[0]
        self.assertIn('kind: "db_error"', lookup_block)
        self.assertIn("album lookup failed", lookup_block)
        self.assertIn("unavailableResponse", text)
        self.assertIn("503", text)


if __name__ == "__main__":
    unittest.main()
