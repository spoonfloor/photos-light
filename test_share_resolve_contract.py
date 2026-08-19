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
        self.assertNotIn("createSignedUrl", meta_block)

    def test_full_phase_still_signs_urls(self):
        text = SHARE_RESOLVE.read_text(encoding="utf-8")
        self.assertIn("createSignedUrl", text)

    def test_sort_order_query_param(self):
        text = SHARE_RESOLVE.read_text(encoding="utf-8")
        self.assertIn('parseSortOrder', text)
        self.assertIn('searchParams.get("sort")', text)


if __name__ == "__main__":
    unittest.main()
