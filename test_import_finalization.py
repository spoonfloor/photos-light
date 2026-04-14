import hashlib
import os
import sqlite3
import subprocess
import unittest
from tempfile import TemporaryDirectory
from unittest.mock import patch

import app as photo_app
from db_schema import create_database_schema
from library_cleanliness import build_canonical_photo_path


class ImportFinalizationRouteTest(unittest.TestCase):
    def setUp(self):
        self.tmpdir = TemporaryDirectory()
        self.library_path = os.path.join(self.tmpdir.name, "library")
        os.makedirs(self.library_path, exist_ok=True)
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

    def test_import_route_finalizes_full_hash_and_canonical_path_after_file_mutation(self):
        date_taken = "2026:04:12 09:30:15"
        source_bytes = b"import-source-bytes"
        metadata_suffix = b"-metadata-rewrite"
        source_path = os.path.join(self.tmpdir.name, "source.jpg")
        with open(source_path, "wb") as fh:
            fh.write(source_bytes)

        initial_hash = hashlib.sha256(source_bytes).hexdigest()[:7]
        initial_rel_path, _ = build_canonical_photo_path(date_taken, initial_hash, ".jpg")
        initial_full_path = os.path.join(self.library_path, initial_rel_path)

        final_bytes = source_bytes + metadata_suffix
        final_hash = hashlib.sha256(final_bytes).hexdigest()
        final_rel_path, _ = build_canonical_photo_path(date_taken, final_hash, ".jpg")
        final_full_path = os.path.join(self.library_path, final_rel_path)

        def fake_write_photo_exif(file_path, new_date):
            self.assertEqual(new_date, date_taken)
            with open(file_path, "ab") as fh:
                fh.write(metadata_suffix)

        fake_subprocess_result = subprocess.CompletedProcess(
            args=["exiftool"],
            returncode=0,
            stdout="",
            stderr="",
        )

        with patch.object(photo_app, "extract_exif_date", return_value=date_taken), patch.object(
            photo_app,
            "bake_orientation",
            return_value=(False, "No orientation flag", None),
        ), patch.object(
            photo_app,
            "get_image_dimensions",
            return_value=(640, 480),
        ), patch.object(
            photo_app,
            "write_photo_exif",
            side_effect=fake_write_photo_exif,
        ), patch(
            "subprocess.run",
            return_value=fake_subprocess_result,
        ):
            response = self.client.post(
                "/api/photos/import-from-paths",
                json={"paths": [source_path]},
                buffered=True,
            )

        self.assertEqual(response.status_code, 200)
        response_text = response.get_data(as_text=True)
        self.assertIn("event: complete", response_text)
        self.assertIn('"imported": 1', response_text)

        self.assertFalse(os.path.exists(initial_full_path))
        self.assertTrue(os.path.exists(final_full_path))

        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        row = conn.execute(
            "SELECT current_path, content_hash, width, height, file_size FROM photos"
        ).fetchone()
        conn.close()

        self.assertEqual(row["current_path"], final_rel_path)
        self.assertEqual(row["content_hash"], final_hash)
        self.assertEqual(row["width"], 640)
        self.assertEqual(row["height"], 480)
        self.assertEqual(row["file_size"], len(final_bytes))


if __name__ == "__main__":
    unittest.main()
