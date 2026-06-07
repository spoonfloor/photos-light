import hashlib
import os
import sqlite3
import unittest
from tempfile import TemporaryDirectory
from unittest.mock import patch

import app as photo_app
from db_schema import create_database_schema
from library_cleanliness import build_canonical_photo_path
from rotation_utils import (
    HEIC_ROTATION_OUTPUT_EXT,
    RotationResult,
    rotate_file_in_place,
)

try:
    from PIL import Image
    from pillow_heif import register_heif_opener

    register_heif_opener()
    HEIF_TESTS_AVAILABLE = True
except ImportError:
    HEIF_TESTS_AVAILABLE = False


def create_test_heic(path: str, size=(120, 80)) -> None:
    image = Image.new("RGB", size, color=(40, 120, 200))
    image.save(path, format="HEIF", quality=80)


class RotateHeicUtilsTest(unittest.TestCase):
    def setUp(self):
        self.tmpdir = TemporaryDirectory()
        self.heic_path = os.path.join(self.tmpdir.name, "sample.heic")
        if not HEIF_TESTS_AVAILABLE:
            self.skipTest("pillow-heif is not available")
        create_test_heic(self.heic_path)

    def tearDown(self):
        self.tmpdir.cleanup()

    def test_rotate_heic_deferred_until_commit(self):
        result = rotate_file_in_place(
            self.heic_path,
            90,
            allow_lossy_fallback=False,
        )
        self.assertFalse(result.success)
        self.assertTrue(os.path.exists(self.heic_path))
        self.assertFalse(os.path.exists(self.heic_path.replace(".heic", HEIC_ROTATION_OUTPUT_EXT)))

    @patch("rotation_utils._copy_metadata_with_exiftool", return_value=(True, "ok"))
    @patch("rotation_utils.strip_orientation_tag", return_value=(True, "ok"))
    def test_rotate_heic_commits_tiff_sibling(self, _strip_orientation, _copy_metadata):
        result = rotate_file_in_place(
            self.heic_path,
            90,
            allow_lossy_fallback=True,
        )
        self.assertTrue(result.success)
        self.assertTrue(result.lossless)
        self.assertIsNotNone(result.output_path)

        tiff_path = self.heic_path.replace(".heic", HEIC_ROTATION_OUTPUT_EXT)
        self.assertEqual(result.output_path, tiff_path)
        self.assertTrue(os.path.exists(tiff_path))
        self.assertTrue(os.path.exists(self.heic_path))

        with Image.open(tiff_path) as converted:
            self.assertEqual(converted.size, (80, 120))


class RotateHeicRouteTest(unittest.TestCase):
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

        if not HEIF_TESTS_AVAILABLE:
            self.skipTest("pillow-heif is not available")

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

    def _insert_heic_photo(self, heic_path: str, rel_path: str, content_hash: str) -> int:
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
                os.path.basename(heic_path),
                rel_path,
                "2026:04:12 09:30:15",
                content_hash,
                os.path.getsize(heic_path),
                "photo",
                120,
                80,
            ),
        )
        photo_id = conn.execute("SELECT id FROM photos").fetchone()[0]
        conn.commit()
        conn.close()
        return photo_id

    def test_rotate_heic_staged_on_first_request(self):
        old_hash = hashlib.sha256(b"heic-staged-test").hexdigest()
        rel_path, _ = build_canonical_photo_path("2026:04:12 09:30:15", old_hash, ".heic")
        full_path = os.path.join(self.library_path, rel_path)
        os.makedirs(os.path.dirname(full_path), exist_ok=True)
        create_test_heic(full_path)
        photo_id = self._insert_heic_photo(full_path, rel_path, old_hash)

        response = self.client.post(
            f"/api/photo/{photo_id}/rotate",
            json={"degrees_ccw": 90, "commit_lossy": False},
        )

        self.assertEqual(response.status_code, 200)
        payload = response.get_json()
        self.assertTrue(payload["staged"])
        self.assertFalse(payload["committed"])
        self.assertEqual(payload["reason"], "heic_conversion_deferred")
        self.assertTrue(os.path.exists(full_path))

    @patch("rotation_utils._copy_metadata_with_exiftool", return_value=(True, "ok"))
    @patch("rotation_utils.strip_orientation_tag", return_value=(True, "ok"))
    def test_rotate_heic_finalizes_tiff_and_removes_heic(
        self,
        _strip_orientation,
        _copy_metadata,
    ):
        rel_path, _ = build_canonical_photo_path(
            "2026:04:12 09:30:15",
            hashlib.sha256(b"heic-finalize-test").hexdigest(),
            ".heic",
        )
        full_path = os.path.join(self.library_path, rel_path)
        os.makedirs(os.path.dirname(full_path), exist_ok=True)
        create_test_heic(full_path)
        with open(full_path, "rb") as fh:
            old_hash = hashlib.sha256(fh.read()).hexdigest()

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
                os.path.basename(full_path),
                rel_path,
                "2026:04:12 09:30:15",
                old_hash,
                os.path.getsize(full_path),
                "photo",
                120,
                80,
            ),
        )
        photo_id = conn.execute("SELECT id FROM photos").fetchone()[0]
        conn.commit()
        conn.close()

        response = self.client.post(
            f"/api/photo/{photo_id}/rotate",
            json={"degrees_ccw": 90, "commit_lossy": True},
        )

        self.assertEqual(response.status_code, 200)
        payload = response.get_json()
        self.assertTrue(payload["committed"])
        self.assertTrue(payload["lossless"])
        self.assertFalse(os.path.exists(full_path))
        self.assertTrue(payload["photo"]["path"].endswith(".tiff"))

        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        row = conn.execute(
            "SELECT current_path, content_hash, width, height FROM photos WHERE id = ?",
            (photo_id,),
        ).fetchone()
        conn.close()

        self.assertEqual(row["current_path"], payload["photo"]["path"])
        self.assertEqual(row["width"], 80)
        self.assertEqual(row["height"], 120)
        self.assertTrue(os.path.exists(os.path.join(self.library_path, row["current_path"])))


if __name__ == "__main__":
    unittest.main()
