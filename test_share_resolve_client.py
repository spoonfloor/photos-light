"""Contract tests for share-resolve browser client."""

from __future__ import annotations

import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SHARE_RESOLVE_CLIENT = ROOT / "static" / "js" / "shareResolveClient.js"
SHARE_BOOT = ROOT / "static" / "js" / "shareBoot.js"
BUILD_SCRIPT = ROOT / "scripts" / "build-share-viewer.sh"


class ShareResolveClientContractTest(unittest.TestCase):
    def test_client_exports_resolver_api(self):
        text = SHARE_RESOLVE_CLIENT.read_text(encoding="utf-8")
        for symbol in (
            "ShareResolveError",
            "resolveMeta",
            "resolveFull",
            "messageForCode",
            "isPermanentFailure",
            "isRetryable",
            "MESSAGES",
        ):
            self.assertIn(symbol, text)

    def test_retry_policy_matches_transient_failures(self):
        text = SHARE_RESOLVE_CLIENT.read_text(encoding="utf-8")
        self.assertIn("share_unavailable", text)
        self.assertIn("share_not_found", text)
        self.assertIn("502", text)
        self.assertIn("503", text)
        self.assertIn("504", text)
        self.assertIn("429", text)
        self.assertIn("250 * attempt", text)

    def test_share_boot_uses_shared_client(self):
        text = SHARE_BOOT.read_text(encoding="utf-8")
        self.assertIn("ShareResolveClient.resolveMeta", text)
        self.assertIn("ShareResolveClient.resolveFull", text)
        self.assertNotIn("function fetchShareResolve", text)
        self.assertNotIn("function resolveShareMeta", text)
        self.assertIn("shareErrorRetryBtn", text)
        self.assertIn("wireShareErrorRetry", text)

    def test_build_script_includes_client(self):
        text = BUILD_SCRIPT.read_text(encoding="utf-8")
        self.assertIn("shareResolveClient.js", text)
        self.assertIn('id="shareErrorRetryBtn"', text)


if __name__ == "__main__":
    unittest.main()
