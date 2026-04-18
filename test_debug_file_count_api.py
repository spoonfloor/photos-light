import os
import sqlite3
import unittest
from tempfile import TemporaryDirectory
from unittest.mock import patch

from PIL import Image

import app as photo_app
from db_schema import create_database_schema


class DebugFileCountApiTest(unittest.TestCase):
    def setUp(self):
        self.tmpdir = TemporaryDirectory()
        self.library_path = os.path.join(self.tmpdir.name, "library")
        self.scan_path = os.path.join(self.tmpdir.name, "scan")
        os.makedirs(self.library_path, exist_ok=True)
        os.makedirs(self.scan_path, exist_ok=True)

        self.db_path = os.path.join(self.library_path, ".library", "photo_library.db")
        os.makedirs(os.path.dirname(self.db_path), exist_ok=True)

        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        create_database_schema(conn.cursor())
        conn.commit()
        conn.close()

        self.original_paths = (
            photo_app.LIBRARY_PATH,
            photo_app.DB_PATH,
            photo_app.THUMBNAIL_CACHE_DIR,
            photo_app.TRASH_DIR,
            photo_app.DB_BACKUP_DIR,
            photo_app.IMPORT_TEMP_DIR,
            photo_app.LOG_DIR,
        )
        photo_app.update_app_paths(self.library_path, self.db_path)
        photo_app.app.config["TESTING"] = True
        self.client = photo_app.app.test_client()

    def tearDown(self):
        (
            photo_app.LIBRARY_PATH,
            photo_app.DB_PATH,
            photo_app.THUMBNAIL_CACHE_DIR,
            photo_app.TRASH_DIR,
            photo_app.DB_BACKUP_DIR,
            photo_app.IMPORT_TEMP_DIR,
            photo_app.LOG_DIR,
        ) = self.original_paths
        self.tmpdir.cleanup()

    def test_debug_file_count_groups_pixel_duplicates_and_counts_non_media(self):
        keep_path = os.path.join(self.scan_path, "keep.png")
        dup_path = os.path.join(self.scan_path, "dup.png")
        note_path = os.path.join(self.scan_path, "notes.txt")

        pixels = Image.new("RGB", (4, 4), (12, 34, 56))
        pixels.save(keep_path, format="PNG", compress_level=0)
        pixels.save(dup_path, format="PNG", compress_level=9)
        with open(note_path, "w", encoding="utf-8") as handle:
            handle.write("hello")

        with patch.object(photo_app, "extract_exif_date", return_value=None), patch.object(
            photo_app,
            "bake_orientation",
            return_value=(False, "No rotation needed", 1),
        ), patch.object(
            photo_app,
            "extract_exif_rating",
            return_value=None,
        ), patch.object(
            photo_app,
            "write_photo_exif",
            return_value=None,
        ):
            response = self.client.post(
                "/api/debug/analyze-file-count",
                json={"path": self.scan_path},
            )

        self.assertEqual(response.status_code, 200)
        payload = response.get_json()

        self.assertEqual(payload["unique_media_count"], 1)
        self.assertEqual(payload["duplicate_media_count"], 1)
        self.assertEqual(payload["other_file_count"], 1)
        self.assertCountEqual(payload["files"], [keep_path, dup_path, note_path])
        self.assertEqual(len(payload["file_buckets"]), len(payload["files"]))
        by_base = {
            os.path.basename(p): b for p, b in zip(payload["files"], payload["file_buckets"])
        }
        self.assertEqual(by_base["notes.txt"], "other_files")
        self.assertEqual(
            {by_base["keep.png"], by_base["dup.png"]},
            {"unique_media", "duplicate_media"},
        )

    def test_debug_file_count_buckets_unreadable_media_as_other(self):
        fake_png_path = os.path.join(self.scan_path, "broken.png")
        with open(fake_png_path, "w", encoding="utf-8") as handle:
            handle.write("not really a png")

        response = self.client.post(
            "/api/debug/analyze-file-count",
            json={"path": self.scan_path},
        )

        self.assertEqual(response.status_code, 200)
        payload = response.get_json()

        self.assertEqual(payload["unique_media_count"], 0)
        self.assertEqual(payload["duplicate_media_count"], 0)
        self.assertEqual(payload["other_file_count"], 1)
        self.assertEqual(payload["files"], [fake_png_path])
        self.assertEqual(payload["file_buckets"], ["other_files"])


if __name__ == "__main__":
    unittest.main()
