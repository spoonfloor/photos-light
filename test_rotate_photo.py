import hashlib
import os
import sqlite3
import unittest
from tempfile import TemporaryDirectory
from unittest.mock import patch

import app as photo_app
from db_schema import create_database_schema
from library_cleanliness import build_canonical_photo_path
from rotation_utils import RotationResult


class RotatePhotoRouteTest(unittest.TestCase):
    def setUp(self):
        self.tmpdir = TemporaryDirectory()
        self.library_path = self.tmpdir.name
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

    def test_rotate_photo_finalizes_full_hash_and_canonical_path(self):
        old_bytes = b"original-jpeg-bytes"
        old_hash = hashlib.sha256(old_bytes).hexdigest()
        date_taken = "2026:04:12 09:30:15"
        old_rel_path, _ = build_canonical_photo_path(date_taken, old_hash, ".jpg")
        old_full_path = os.path.join(self.library_path, old_rel_path)
        os.makedirs(os.path.dirname(old_full_path), exist_ok=True)
        with open(old_full_path, "wb") as fh:
            fh.write(old_bytes)

        conn = sqlite3.connect(self.db_path)
        conn.execute(
            """
            INSERT INTO photos (
                original_filename,
                current_path,
                date_taken,
                content_hash,
                file_size,
                file_type,
                width,
                height
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                "source.jpg",
                old_rel_path,
                date_taken,
                old_hash,
                len(old_bytes),
                "photo",
                400,
                300,
            ),
        )
        photo_id = conn.execute("SELECT id FROM photos").fetchone()[0]
        conn.commit()
        conn.close()

        def fake_rotate_file_in_place(file_path, degrees_ccw, **kwargs):
            self.assertEqual(file_path, old_full_path)
            self.assertEqual(degrees_ccw, 90)
            with open(file_path, "ab") as fh:
                fh.write(b"-rotated")
            return RotationResult(True, False, "Rotated with test stub")

        with patch.object(photo_app, "rotate_file_in_place", side_effect=fake_rotate_file_in_place), patch.object(
            photo_app, "get_orientation_flag", return_value=1
        ), patch.object(photo_app, "get_image_dimensions", return_value=(300, 400)):
            response = self.client.post(
                f"/api/photo/{photo_id}/rotate",
                json={"degrees_ccw": 90, "commit_lossy": True},
            )

        self.assertEqual(response.status_code, 200)
        payload = response.get_json()
        self.assertTrue(payload["ok"])
        self.assertTrue(payload["committed"])
        self.assertFalse(payload["reconcile_pending"])
        self.assertFalse(hasattr(photo_app, "schedule_rotation_reconcile"))

        expected_hash = hashlib.sha256(old_bytes + b"-rotated").hexdigest()
        expected_rel_path, _ = build_canonical_photo_path(date_taken, expected_hash, ".jpg")
        expected_full_path = os.path.join(self.library_path, expected_rel_path)

        self.assertEqual(payload["photo"]["content_hash"], expected_hash)
        self.assertEqual(payload["photo"]["path"], expected_rel_path)
        self.assertEqual(len(payload["photo"]["content_hash"]), 64)
        self.assertFalse(os.path.exists(old_full_path))
        self.assertTrue(os.path.exists(expected_full_path))

        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        row = conn.execute(
            "SELECT current_path, content_hash, width, height FROM photos WHERE id = ?",
            (photo_id,),
        ).fetchone()
        conn.close()

        self.assertEqual(row["current_path"], expected_rel_path)
        self.assertEqual(row["content_hash"], expected_hash)
        self.assertEqual(row["width"], 300)
        self.assertEqual(row["height"], 400)


if __name__ == "__main__":
    unittest.main()
