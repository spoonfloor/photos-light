import hashlib
import os
import sqlite3
import unittest
from tempfile import TemporaryDirectory
from unittest.mock import patch

import app as photo_app
from db_schema import create_database_schema
from library_cleanliness import build_canonical_photo_path


class ToggleFavoriteRouteTest(unittest.TestCase):
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

    def _insert_photo(self, *, file_bytes, date_taken, rating=None):
        content_hash = hashlib.sha256(file_bytes).hexdigest()
        rel_path, _ = build_canonical_photo_path(date_taken, content_hash, ".jpg")
        full_path = os.path.join(self.library_path, rel_path)
        os.makedirs(os.path.dirname(full_path), exist_ok=True)
        with open(full_path, "wb") as fh:
            fh.write(file_bytes)

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
                height,
                rating
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                "source.jpg",
                rel_path,
                date_taken,
                content_hash,
                len(file_bytes),
                "photo",
                400,
                300,
                rating,
            ),
        )
        photo_id = conn.execute("SELECT id FROM photos ORDER BY id DESC").fetchone()[0]
        conn.commit()
        conn.close()
        return photo_id, rel_path, full_path, content_hash

    def _create_thumbnail(self, content_hash):
        thumb_path = os.path.join(
            photo_app.THUMBNAIL_CACHE_DIR,
            content_hash[:2],
            content_hash[2:4],
            f"{content_hash}.jpg",
        )
        os.makedirs(os.path.dirname(thumb_path), exist_ok=True)
        with open(thumb_path, "wb") as fh:
            fh.write(b"thumb")
        return thumb_path

    def test_toggle_favorite_finalizes_hash_path_and_thumbnail_after_exif_write(self):
        date_taken = "2026:04:12 09:30:15"
        old_bytes = b"favorite-source-bytes"
        photo_id, old_rel_path, old_full_path, old_hash = self._insert_photo(
            file_bytes=old_bytes,
            date_taken=date_taken,
        )
        old_thumb_path = self._create_thumbnail(old_hash)

        final_bytes = old_bytes + b"-rating-five"
        final_hash = hashlib.sha256(final_bytes).hexdigest()
        final_rel_path, _ = build_canonical_photo_path(date_taken, final_hash, ".jpg")
        final_full_path = os.path.join(self.library_path, final_rel_path)

        def fake_write_exif_rating(file_path, rating):
            self.assertEqual(file_path, old_full_path)
            self.assertEqual(rating, 5)
            with open(file_path, "ab") as fh:
                fh.write(b"-rating-five")
            return True

        with patch("file_operations.extract_exif_rating", return_value=None), patch(
            "file_operations.write_exif_rating",
            side_effect=fake_write_exif_rating,
        ), patch.object(photo_app, "get_image_dimensions", return_value=(640, 480)):
            response = self.client.post(f"/api/photo/{photo_id}/favorite")

        self.assertEqual(response.status_code, 200)
        payload = response.get_json()
        self.assertEqual(payload["photo_id"], photo_id)
        self.assertEqual(payload["rating"], 5)
        self.assertTrue(payload["favorited"])
        self.assertEqual(payload["photo"]["path"], final_rel_path)

        self.assertFalse(os.path.exists(old_full_path))
        self.assertTrue(os.path.exists(final_full_path))
        self.assertFalse(os.path.exists(old_thumb_path))

        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        row = conn.execute(
            "SELECT current_path, content_hash, file_size, width, height, rating FROM photos WHERE id = ?",
            (photo_id,),
        ).fetchone()
        conn.close()

        self.assertEqual(row["current_path"], final_rel_path)
        self.assertEqual(row["content_hash"], final_hash)
        self.assertEqual(row["file_size"], len(final_bytes))
        self.assertEqual(row["width"], 640)
        self.assertEqual(row["height"], 480)
        self.assertEqual(row["rating"], 5)

    def test_toggle_favorite_trashes_photo_when_it_becomes_duplicate(self):
        date_taken = "2026:04:12 09:30:15"
        duplicate_bytes = b"duplicate-source-rated"
        _, duplicate_rel_path, duplicate_full_path, duplicate_hash = self._insert_photo(
            file_bytes=duplicate_bytes,
            date_taken=date_taken,
            rating=5,
        )
        self.assertTrue(os.path.exists(duplicate_full_path))

        old_bytes = b"duplicate-source"
        photo_id, old_rel_path, old_full_path, old_hash = self._insert_photo(
            file_bytes=old_bytes,
            date_taken=date_taken,
        )
        old_thumb_path = self._create_thumbnail(old_hash)

        self.assertEqual(hashlib.sha256(old_bytes + b"-rated").hexdigest(), duplicate_hash)

        def fake_write_exif_rating(file_path, rating):
            self.assertEqual(file_path, old_full_path)
            self.assertEqual(rating, 5)
            with open(file_path, "ab") as fh:
                fh.write(b"-rated")
            return True

        with patch("file_operations.extract_exif_rating", return_value=None), patch(
            "file_operations.write_exif_rating",
            side_effect=fake_write_exif_rating,
        ), patch.object(photo_app, "get_image_dimensions", return_value=(640, 480)):
            response = self.client.post(f"/api/photo/{photo_id}/favorite")

        self.assertEqual(response.status_code, 200)
        payload = response.get_json()
        self.assertTrue(payload["duplicate_removed"])

        self.assertFalse(os.path.exists(old_full_path))
        self.assertFalse(os.path.exists(old_thumb_path))
        trash_duplicates_dir = os.path.join(photo_app.TRASH_DIR, "duplicates")
        trashed_files = os.listdir(trash_duplicates_dir)
        self.assertEqual(len(trashed_files), 1)

        conn = sqlite3.connect(self.db_path)
        source_row = conn.execute("SELECT id FROM photos WHERE id = ?", (photo_id,)).fetchone()
        duplicate_row = conn.execute(
            "SELECT current_path, content_hash, rating FROM photos WHERE current_path = ?",
            (duplicate_rel_path,),
        ).fetchone()
        conn.close()

        self.assertIsNone(source_row)
        self.assertEqual(duplicate_row[0], duplicate_rel_path)
        self.assertEqual(duplicate_row[1], duplicate_hash)
        self.assertEqual(duplicate_row[2], 5)


if __name__ == "__main__":
    unittest.main()
