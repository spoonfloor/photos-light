"""Download filename sanitization — shared export module and server guard."""

from __future__ import annotations

import json
import subprocess
import unittest
from pathlib import Path

import app as photo_app

ROOT = Path(__file__).resolve().parent
DOWNLOAD_EXPORT = ROOT / "static" / "js" / "photoSurface" / "downloadExport.js"
SHARE_BOOT = ROOT / "static" / "js" / "shareBoot.js"
MAIN_JS = ROOT / "static" / "js" / "main.js"


def _run_download_export_js() -> dict:
    script = f"""
const fs = require('fs');
const code = fs.readFileSync({json.dumps(str(DOWNLOAD_EXPORT))}, 'utf8') + '; globalThis.DownloadExport = DownloadExport;';
eval(code);
console.log(JSON.stringify({{
  trip: DownloadExport.buildArchiveFilename('Trip: NYC / 2026', 'fallback-token'),
  emptyTitle: DownloadExport.buildArchiveFilename('::: ', 'fallback-token'),
  emoji: DownloadExport.buildArchiveFilename("Mom's 80th! 🎉", 'fallback'),
  longTitle: DownloadExport.buildArchiveFilename('a'.repeat(300), 'short'),
  entryPath: DownloadExport.sanitizeZipEntryName('../../etc/passwd'),
  entryNested: DownloadExport.sanitizeZipEntryName('foo/bar.jpg'),
  folderBase: DownloadExport.sanitizeFilenameBase('  spaced   name  ', 255),
}}));
"""
    result = subprocess.run(
        ["node", "-e", script],
        check=True,
        capture_output=True,
        text=True,
    )
    return json.loads(result.stdout.strip())


class DownloadExportFilenameTest(unittest.TestCase):
    def test_download_export_exports_sanitizers(self):
        text = DOWNLOAD_EXPORT.read_text(encoding="utf-8")
        self.assertIn("function sanitizeFilenameBase(name", text)
        self.assertIn("function buildArchiveFilename(base", text)
        self.assertIn("function sanitizeZipEntryName(name", text)
        self.assertIn("sanitizeZipEntryName(rawEntryName", text)

    def test_share_boot_uses_build_archive_filename(self):
        text = SHARE_BOOT.read_text(encoding="utf-8")
        download_block = text.split("async function downloadPhotos", 1)[1].split(
            "function resolveDownloadTargets",
            1,
        )[0]
        self.assertIn("DownloadExport.buildArchiveFilename", download_block)
        self.assertNotIn("`${state.album.title || state.token}.zip`", download_block)

    def test_main_js_delegates_folder_sanitize_to_download_export(self):
        text = MAIN_JS.read_text(encoding="utf-8")
        self.assertIn(
            "return DownloadExport.sanitizeFilenameBase(name, 255);",
            text,
        )
        self.assertIn(
            "return DownloadExport.buildArchiveFilename(fromPath || 'Photos', 'Photos');",
            text,
        )

    def test_sanitize_rules_via_node(self):
        cases = _run_download_export_js()
        self.assertEqual(cases["trip"], "Trip NYC 2026.zip")
        self.assertEqual(cases["emptyTitle"], "fallback-token.zip")
        self.assertEqual(cases["emoji"], "Mom's 80th! 🎉.zip")
        self.assertEqual(len(cases["longTitle"].removesuffix(".zip")), 200)
        self.assertEqual(cases["entryPath"], "passwd")
        self.assertEqual(cases["entryNested"], "bar.jpg")
        self.assertEqual(cases["folderBase"], "spaced name")


class ExportFilenameServerTest(unittest.TestCase):
    def test_sanitize_export_filename_strips_forbidden_chars(self):
        self.assertEqual(
            photo_app._sanitize_export_filename('Trip NYC 2026.zip', 'download.zip'),
            'Trip NYC 2026.zip',
        )

    def test_sanitize_export_filename_uses_basename_only(self):
        self.assertEqual(
            photo_app._sanitize_export_filename('../../etc/passwd', 'download'),
            'passwd',
        )

    def test_sanitize_export_filename_empty_falls_back(self):
        self.assertEqual(
            photo_app._sanitize_export_filename('::: ', 'download.zip'),
            'download.zip',
        )


if __name__ == "__main__":
    unittest.main()
