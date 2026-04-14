import hashlib
import os
import sqlite3
import unittest
from tempfile import TemporaryDirectory
from unittest.mock import patch

import app as photo_app
from db_schema import create_database_schema
from library_cleanliness import build_canonical_photo_path


class UpdatePhotoDateRouteTest(unittest.TestCase):
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

    def _insert_photo(self, *, file_bytes, date_taken):
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
                height
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
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

    def test_update_photo_date_finalizes_hash_path_and_thumbnail_after_exif_write(self):
        old_date = "2026:04:12 09:30:15"
        new_date = "2026:04:15 12:34:56"
        old_bytes = b"date-edit-source-bytes"
        photo_id, old_rel_path, old_full_path, old_hash = self._insert_photo(
            file_bytes=old_bytes,
            date_taken=old_date,
        )
        old_thumb_path = self._create_thumbnail(old_hash)

        final_bytes = old_bytes + b"-redated"
        final_hash = hashlib.sha256(final_bytes).hexdigest()
        final_rel_path, final_filename = build_canonical_photo_path(new_date, final_hash, ".jpg")
        final_full_path = os.path.join(self.library_path, final_rel_path)

        def fake_write_photo_exif(file_path, target_date):
            self.assertEqual(file_path, old_full_path)
            self.assertEqual(target_date, new_date)
            with open(file_path, "ab") as fh:
                fh.write(b"-redated")

        with patch.object(photo_app, "bake_orientation", return_value=(False, "No orientation flag", None)), patch.object(
            photo_app, "write_photo_exif", side_effect=fake_write_photo_exif
        ), patch.object(photo_app, "get_image_dimensions", return_value=(640, 480)):
            response = self.client.post(
                "/api/photo/update_date",
                json={"photo_id": photo_id, "new_date": new_date},
            )

        self.assertEqual(response.status_code, 200)
        payload = response.get_json()
        self.assertEqual(payload["status"], "success")
        self.assertEqual(payload["new_date"], new_date)
        self.assertEqual(payload["photo"]["path"], final_rel_path)
        self.assertEqual(payload["photo"]["content_hash"], final_hash)

        self.assertFalse(os.path.exists(old_full_path))
        self.assertTrue(os.path.exists(final_full_path))
        self.assertFalse(os.path.exists(old_thumb_path))

        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        row = conn.execute(
            """
            SELECT current_path, content_hash, file_size, width, height, date_taken, original_filename
            FROM photos
            WHERE id = ?
            """,
            (photo_id,),
        ).fetchone()
        conn.close()

        self.assertEqual(row["current_path"], final_rel_path)
        self.assertEqual(row["content_hash"], final_hash)
        self.assertEqual(row["file_size"], len(final_bytes))
        self.assertEqual(row["width"], 640)
        self.assertEqual(row["height"], 480)
        self.assertEqual(row["date_taken"], new_date)
        self.assertEqual(row["original_filename"], final_filename)

    def test_update_photo_date_trashes_photo_when_it_becomes_duplicate(self):
        old_date = "2026:04:12 09:30:15"
        new_date = "2026:04:15 12:34:56"

        duplicate_bytes = b"date-edit-duplicate-source-redated"
        _, duplicate_rel_path, duplicate_full_path, duplicate_hash = self._insert_photo(
            file_bytes=duplicate_bytes,
            date_taken=new_date,
        )
        self.assertTrue(os.path.exists(duplicate_full_path))

        old_bytes = b"date-edit-duplicate-source"
        photo_id, old_rel_path, old_full_path, old_hash = self._insert_photo(
            file_bytes=old_bytes,
            date_taken=old_date,
        )
        old_thumb_path = self._create_thumbnail(old_hash)

        self.assertEqual(hashlib.sha256(old_bytes + b"-redated").hexdigest(), duplicate_hash)

        def fake_write_photo_exif(file_path, target_date):
            self.assertEqual(file_path, old_full_path)
            self.assertEqual(target_date, new_date)
            with open(file_path, "ab") as fh:
                fh.write(b"-redated")

        with patch.object(photo_app, "bake_orientation", return_value=(False, "No orientation flag", None)), patch.object(
            photo_app, "write_photo_exif", side_effect=fake_write_photo_exif
        ), patch.object(photo_app, "get_image_dimensions", return_value=(640, 480)):
            response = self.client.post(
                "/api/photo/update_date",
                json={"photo_id": photo_id, "new_date": new_date},
            )

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
            "SELECT current_path, content_hash FROM photos WHERE current_path = ?",
            (duplicate_rel_path,),
        ).fetchone()
        conn.close()

        self.assertIsNone(source_row)
        self.assertEqual(duplicate_row[0], duplicate_rel_path)
        self.assertEqual(duplicate_row[1], duplicate_hash)


if __name__ == "__main__":
    unittest.main()
