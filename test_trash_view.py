"""Tests for user-deleted trash folder wiring and trash grid APIs."""

import json
import os
import shutil
import sqlite3
import tempfile
import unittest

import app as photo_app
from db_schema_v3 import create_database_schema
from trash_catalog import (
    USER_DELETED_TRASH_CATEGORY,
    deleted_row_for_content_hash,
    move_photo_to_user_trash,
    resolve_user_deleted_trash_path,
)


class TrashViewTests(unittest.TestCase):
    def setUp(self):
        self._tmpdir = tempfile.mkdtemp()
        self.library_path = os.path.join(self._tmpdir, "Library")
        os.makedirs(self.library_path, exist_ok=True)
        self.db_path = os.path.join(self.library_path, "db")
        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        create_database_schema(conn.cursor())
        conn.commit()
        conn.close()

        photo_app.LIBRARY_PATH = self.library_path
        photo_app.DB_PATH = self.db_path
        photo_app.update_app_paths(self.library_path, self.db_path)
        photo_app.app.config["TESTING"] = True
        self.client = photo_app.app.test_client()

        self._seed_photo()

    def tearDown(self):
        shutil.rmtree(self._tmpdir, ignore_errors=True)

    def _seed_photo(self):
        rel_path = "2024/2024-01-15/photo.jpg"
        full_path = os.path.join(self.library_path, rel_path)
        os.makedirs(os.path.dirname(full_path), exist_ok=True)
        with open(full_path, "wb") as handle:
            handle.write(b"photo-bytes")

        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        cursor = conn.cursor()
        cursor.execute(
            """
            INSERT INTO photos (
                id, original_filename, current_path, date_taken,
                content_hash, file_size, file_type, width, height, rating
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                1,
                "photo.jpg",
                rel_path,
                "2024:01:15 12:00:00",
                "abc1234",
                11,
                "photo",
                100,
                100,
                5,
            ),
        )
        conn.commit()
        conn.close()

    def test_delete_moves_file_into_user_deleted_subfolder(self):
        response = self.client.post(
            "/api/photos/delete",
            json={"photo_ids": [1]},
        )
        self.assertEqual(response.status_code, 200)
        payload = response.get_json()
        self.assertEqual(payload["deleted"], 1)

        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        row = conn.execute(
            "SELECT trash_filename FROM deleted_photos WHERE id = 1",
        ).fetchone()
        conn.close()
        self.assertTrue(row["trash_filename"].startswith(f"{USER_DELETED_TRASH_CATEGORY}/"))
        trash_path = resolve_user_deleted_trash_path(photo_app.TRASH_DIR, row["trash_filename"])
        self.assertTrue(os.path.isfile(trash_path))
        self.assertFalse(os.path.exists(os.path.join(self.library_path, "2024/2024-01-15/photo.jpg")))

    def test_trash_grid_lists_deleted_photos_only(self):
        self.client.post("/api/photos/delete", json={"photo_ids": [1]})
        response = self.client.get("/api/trash/photos?limit=10&sort=newest")
        self.assertEqual(response.status_code, 200)
        payload = response.get_json()
        self.assertEqual(payload["total"], 1)
        self.assertEqual(payload["photos"][0]["id"], 1)

        library = self.client.get("/api/photos?limit=10&sort=newest").get_json()
        self.assertEqual(library["total"], 0)

    def test_restore_from_user_deleted_subfolder(self):
        self.client.post("/api/photos/delete", json={"photo_ids": [1]})
        response = self.client.post("/api/photos/restore", json={"photo_ids": [1]})
        self.assertEqual(response.status_code, 200)
        payload = response.get_json()
        self.assertEqual(payload["restored"], 1)
        self.assertEqual(payload["merged"], 0)
        self.assertTrue(
            os.path.exists(os.path.join(self.library_path, "2024/2024-01-15/photo.jpg"))
        )

        conn = sqlite3.connect(self.db_path)
        deleted_count = conn.execute("SELECT COUNT(*) FROM deleted_photos").fetchone()[0]
        live_count = conn.execute("SELECT COUNT(*) FROM photos").fetchone()[0]
        conn.close()
        self.assertEqual(deleted_count, 0)
        self.assertEqual(live_count, 1)

    def test_restore_merges_when_live_copy_already_exists(self):
        self.client.post("/api/photos/delete", json={"photo_ids": [1]})

        rel_path = "2024/2024-01-15/photo.jpg"
        full_path = os.path.join(self.library_path, rel_path)
        os.makedirs(os.path.dirname(full_path), exist_ok=True)
        with open(full_path, "wb") as handle:
            handle.write(b"photo-bytes")

        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        cursor = conn.cursor()
        cursor.execute(
            """
            INSERT INTO photos (
                id, original_filename, current_path, date_taken,
                content_hash, file_size, file_type, width, height, rating
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                2,
                "photo.jpg",
                rel_path,
                "2024:01:15 12:00:00",
                "abc1234",
                11,
                "photo",
                100,
                100,
                None,
            ),
        )
        conn.commit()
        conn.close()

        response = self.client.post("/api/photos/restore", json={"photo_ids": [1]})
        self.assertEqual(response.status_code, 200)
        payload = response.get_json()
        self.assertEqual(payload["restored"], 1)
        self.assertEqual(payload["merged"], 1)
        self.assertEqual(payload["processed_ids"], [1])

        conn = sqlite3.connect(self.db_path)
        deleted_count = conn.execute("SELECT COUNT(*) FROM deleted_photos").fetchone()[0]
        live_count = conn.execute("SELECT COUNT(*) FROM photos").fetchone()[0]
        live_id = conn.execute("SELECT id FROM photos").fetchone()[0]
        conn.close()
        self.assertEqual(deleted_count, 0)
        self.assertEqual(live_count, 1)
        self.assertEqual(live_id, 2)
        self.assertTrue(os.path.isfile(full_path))

    def test_deleted_row_for_content_hash_finds_trashed_photo(self):
        self.client.post("/api/photos/delete", json={"photo_ids": [1]})

        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        row = deleted_row_for_content_hash(conn.cursor(), "abc1234")
        conn.close()

        self.assertIsNotNone(row)
        self.assertEqual(row["id"], 1)

    def test_purge_permanently_deletes_trash_rows_and_files(self):
        self.client.post("/api/photos/delete", json={"photo_ids": [1]})
        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        row = conn.execute(
            "SELECT trash_filename FROM deleted_photos WHERE id = 1",
        ).fetchone()
        conn.close()
        trash_path = resolve_user_deleted_trash_path(photo_app.TRASH_DIR, row["trash_filename"])
        self.assertTrue(os.path.isfile(trash_path))

        response = self.client.post("/api/trash/purge", json={"photo_ids": [1]})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()["purged"], 1)
        self.assertFalse(os.path.exists(trash_path))

        conn = sqlite3.connect(self.db_path)
        deleted_count = conn.execute("SELECT COUNT(*) FROM deleted_photos").fetchone()[0]
        conn.close()
        self.assertEqual(deleted_count, 0)

    def test_move_photo_to_user_trash_preserves_relative_path(self):
        rel_path = "2024/2024-01-15/photo.jpg"
        full_path = os.path.join(self.library_path, rel_path)
        trash_filename = move_photo_to_user_trash(
            self.library_path,
            photo_app.TRASH_DIR,
            full_path,
        )
        self.assertTrue(trash_filename.startswith(f"{USER_DELETED_TRASH_CATEGORY}/2024/"))
        resolved = resolve_user_deleted_trash_path(photo_app.TRASH_DIR, trash_filename)
        self.assertTrue(os.path.isfile(resolved))


if __name__ == "__main__":
    unittest.main()
