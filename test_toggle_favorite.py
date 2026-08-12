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

    def _read_file_bytes(self, path):
        with open(path, "rb") as fh:
            return fh.read()

    def test_toggle_favorite_stars_db_only_without_file_mutation(self):
        date_taken = "2026:04:12 09:30:15"
        file_bytes = b"favorite-source-bytes"
        photo_id, rel_path, full_path, content_hash = self._insert_photo(
            file_bytes=file_bytes,
            date_taken=date_taken,
        )
        before_bytes = self._read_file_bytes(full_path)

        def fail_if_called(*args, **kwargs):
            raise AssertionError("EXIF rating helpers must not run for DB-only stars")

        with patch("file_operations.extract_exif_rating", side_effect=fail_if_called), patch(
            "file_operations.write_exif_rating",
            side_effect=fail_if_called,
        ), patch(
            "file_operations.strip_exif_rating",
            side_effect=fail_if_called,
        ), patch.object(
            photo_app,
            "finalize_mutated_media",
            side_effect=fail_if_called,
        ):
            response = self.client.post(f"/api/photo/{photo_id}/favorite")

        self.assertEqual(response.status_code, 200)
        payload = response.get_json()
        self.assertEqual(payload["photo_id"], photo_id)
        self.assertEqual(payload["rating"], 5)
        self.assertTrue(payload["favorited"])
        self.assertEqual(payload["photo"]["path"], rel_path)
        self.assertEqual(payload["photo"]["content_hash"], content_hash)

        self.assertEqual(self._read_file_bytes(full_path), before_bytes)

        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        row = conn.execute(
            "SELECT current_path, content_hash, file_size, width, height, rating FROM photos WHERE id = ?",
            (photo_id,),
        ).fetchone()
        conn.close()

        self.assertEqual(row["current_path"], rel_path)
        self.assertEqual(row["content_hash"], content_hash)
        self.assertEqual(row["file_size"], len(file_bytes))
        self.assertEqual(row["width"], 400)
        self.assertEqual(row["height"], 300)
        self.assertEqual(row["rating"], 5)

    def test_toggle_favorite_unstars_db_only(self):
        date_taken = "2026:04:12 09:30:15"
        file_bytes = b"already-starred"
        photo_id, rel_path, full_path, content_hash = self._insert_photo(
            file_bytes=file_bytes,
            date_taken=date_taken,
            rating=5,
        )
        before_bytes = self._read_file_bytes(full_path)

        def fail_if_called(*args, **kwargs):
            raise AssertionError("EXIF rating helpers must not run for DB-only stars")

        with patch("file_operations.extract_exif_rating", side_effect=fail_if_called), patch(
            "file_operations.write_exif_rating",
            side_effect=fail_if_called,
        ), patch(
            "file_operations.strip_exif_rating",
            side_effect=fail_if_called,
        ):
            response = self.client.post(f"/api/photo/{photo_id}/favorite")

        self.assertEqual(response.status_code, 200)
        payload = response.get_json()
        self.assertIsNone(payload["rating"])
        self.assertFalse(payload["favorited"])
        self.assertEqual(payload["photo"]["path"], rel_path)
        self.assertEqual(payload["photo"]["content_hash"], content_hash)
        self.assertEqual(self._read_file_bytes(full_path), before_bytes)

    def test_toggle_favorite_does_not_trash_duplicate(self):
        date_taken = "2026:04:12 09:30:15"
        duplicate_bytes = b"duplicate-source-rated"
        _, duplicate_rel_path, duplicate_full_path, duplicate_hash = self._insert_photo(
            file_bytes=duplicate_bytes,
            date_taken=date_taken,
            rating=5,
        )
        photo_id, old_rel_path, old_full_path, old_hash = self._insert_photo(
            file_bytes=b"duplicate-source",
            date_taken=date_taken,
        )

        response = self.client.post(f"/api/photo/{photo_id}/favorite")

        self.assertEqual(response.status_code, 200)
        payload = response.get_json()
        self.assertNotIn("duplicate_removed", payload)
        self.assertTrue(payload["favorited"])
        self.assertTrue(os.path.exists(old_full_path))
        self.assertTrue(os.path.exists(duplicate_full_path))

        conn = sqlite3.connect(self.db_path)
        source_row = conn.execute(
            "SELECT current_path, content_hash, rating FROM photos WHERE id = ?",
            (photo_id,),
        ).fetchone()
        duplicate_row = conn.execute(
            "SELECT current_path, content_hash, rating FROM photos WHERE current_path = ?",
            (duplicate_rel_path,),
        ).fetchone()
        conn.close()

        self.assertEqual(source_row[0], old_rel_path)
        self.assertEqual(source_row[1], old_hash)
        self.assertEqual(source_row[2], 5)
        self.assertEqual(duplicate_row[1], duplicate_hash)
        self.assertEqual(duplicate_row[2], 5)

    def test_set_favorite_explicit_rating_noop_when_already_starred(self):
        date_taken = "2026:04:12 09:30:15"
        file_bytes = b"already-starred"
        photo_id, rel_path, full_path, content_hash = self._insert_photo(
            file_bytes=file_bytes,
            date_taken=date_taken,
            rating=5,
        )

        def fail_if_called(*args, **kwargs):
            raise AssertionError("EXIF write should not run for settled favorite")

        with patch("file_operations.extract_exif_rating", side_effect=fail_if_called), patch(
            "file_operations.write_exif_rating",
            side_effect=fail_if_called,
        ), patch(
            "file_operations.strip_exif_rating",
            side_effect=fail_if_called,
        ):
            response = self.client.post(
                f"/api/photo/{photo_id}/favorite",
                json={"rating": 5},
            )

        self.assertEqual(response.status_code, 200)
        payload = response.get_json()
        self.assertEqual(payload["rating"], 5)
        self.assertTrue(payload["favorited"])
        self.assertEqual(payload["photo"]["path"], rel_path)
        self.assertEqual(payload["photo"]["content_hash"], content_hash)
        self.assertTrue(os.path.exists(full_path))

    def test_set_favorite_explicit_rating_stars_without_toggle(self):
        date_taken = "2026:04:12 09:30:15"
        file_bytes = b"explicit-star-bytes"
        photo_id, rel_path, full_path, content_hash = self._insert_photo(
            file_bytes=file_bytes,
            date_taken=date_taken,
        )
        before_bytes = self._read_file_bytes(full_path)

        response = self.client.post(
            f"/api/photo/{photo_id}/favorite",
            json={"rating": 5},
        )

        self.assertEqual(response.status_code, 200)
        payload = response.get_json()
        self.assertEqual(payload["rating"], 5)
        self.assertTrue(payload["favorited"])
        self.assertEqual(payload["photo"]["path"], rel_path)
        self.assertEqual(payload["photo"]["content_hash"], content_hash)
        self.assertEqual(self._read_file_bytes(full_path), before_bytes)

    def test_bulk_favorite_updates_db_only(self):
        date_taken = "2026:04:12 09:30:15"
        file_bytes = b"bulk-star-bytes"
        photo_id, rel_path, full_path, content_hash = self._insert_photo(
            file_bytes=file_bytes,
            date_taken=date_taken,
        )
        before_bytes = self._read_file_bytes(full_path)

        response = self.client.post(
            "/api/photos/bulk-favorite",
            json={"photo_ids": [photo_id], "rating": 5},
        )

        self.assertEqual(response.status_code, 200)
        payload = response.get_json()
        self.assertEqual(payload["success_count"], 1)
        self.assertEqual(payload["error_count"], 0)
        self.assertEqual(payload["results"][0]["photo"]["path"], rel_path)
        self.assertEqual(payload["results"][0]["photo"]["content_hash"], content_hash)
        self.assertEqual(self._read_file_bytes(full_path), before_bytes)

        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        row = conn.execute(
            "SELECT current_path, content_hash, rating FROM photos WHERE id = ?",
            (photo_id,),
        ).fetchone()
        conn.close()

        self.assertEqual(row["current_path"], rel_path)
        self.assertEqual(row["content_hash"], content_hash)
        self.assertEqual(row["rating"], 5)

    def test_bulk_favorite_all_clears_starred_photos_db_only(self):
        date_taken = "2026:04:12 09:30:15"
        starred_id, _, starred_full, _ = self._insert_photo(
            file_bytes=b"starred-photo",
            date_taken=date_taken,
            rating=5,
        )
        unstarred_id, _, unstarred_full, _ = self._insert_photo(
            file_bytes=b"plain-photo",
            date_taken=date_taken,
            rating=None,
        )
        starred_before = self._read_file_bytes(starred_full)

        def fail_if_called(*args, **kwargs):
            raise AssertionError("EXIF strip must not run for DB-only bulk unstar")

        with patch("file_operations.strip_exif_rating", side_effect=fail_if_called):
            response = self.client.post(
                "/api/photos/bulk-favorite",
                json={"all": True, "rating": 0},
            )

        self.assertEqual(response.status_code, 200)
        payload = response.get_json()
        self.assertEqual(payload["success_count"], 1)
        self.assertEqual(payload["error_count"], 0)
        self.assertEqual(self._read_file_bytes(starred_full), starred_before)

        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        starred_row = conn.execute(
            "SELECT rating FROM photos WHERE id = ?",
            (starred_id,),
        ).fetchone()
        unstarred_row = conn.execute(
            "SELECT rating FROM photos WHERE id = ?",
            (unstarred_id,),
        ).fetchone()
        conn.close()

        self.assertIsNone(starred_row["rating"])
        self.assertIsNone(unstarred_row["rating"])
        self.assertTrue(os.path.exists(unstarred_full))

    def test_bulk_favorite_all_requires_rating_zero(self):
        response = self.client.post(
            "/api/photos/bulk-favorite",
            json={"all": True, "rating": 5},
        )
        self.assertEqual(response.status_code, 400)
        self.assertIn("rating 0", response.get_json()["error"])


if __name__ == "__main__":
    unittest.main()
