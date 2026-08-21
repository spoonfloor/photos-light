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
    archive_live_photo_to_user_trash,
    deleted_row_for_content_hash,
    move_photo_to_user_trash,
    resolve_user_deleted_trash_path,
)


class TrashViewTests(unittest.TestCase):
    def setUp(self):
        photo_app.app.config["TESTING"] = True
        photo_app.reset_test_library_state()
        self._tmpdir = tempfile.mkdtemp()
        self.library_path = os.path.join(self._tmpdir, "Library")
        os.makedirs(self.library_path, exist_ok=True)
        self.db_path = os.path.join(self.library_path, "db")
        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        create_database_schema(conn.cursor())
        conn.commit()
        conn.close()

        photo_app.update_app_paths(self.library_path, self.db_path)
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
        self.assertEqual(payload["merged_ids"], [])

        from library_cleanliness import build_canonical_photo_path

        expected_rel, _ = build_canonical_photo_path(
            "2024:01:15 12:00:00",
            "abc1234",
            ".jpg",
        )
        self.assertTrue(os.path.exists(os.path.join(self.library_path, expected_rel)))

        conn = sqlite3.connect(self.db_path)
        deleted_count = conn.execute("SELECT COUNT(*) FROM deleted_photos").fetchone()[0]
        live_count = conn.execute("SELECT COUNT(*) FROM photos").fetchone()[0]
        live_path = conn.execute("SELECT current_path FROM photos WHERE id = 1").fetchone()[0]
        conn.close()
        self.assertEqual(deleted_count, 0)
        self.assertEqual(live_count, 1)
        self.assertEqual(live_path, expected_rel)

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
        self.assertEqual(payload["merged_ids"], [1])

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

    def _insert_live_photo(self, photo_id, rel_path="2024/2024-01-15/photo.jpg", content_hash="abc1234"):
        full_path = os.path.join(self.library_path, rel_path)
        os.makedirs(os.path.dirname(full_path), exist_ok=True)
        with open(full_path, "wb") as handle:
            handle.write(b"photo-bytes")

        conn = sqlite3.connect(self.db_path)
        cursor = conn.cursor()
        cursor.execute(
            """
            INSERT INTO photos (
                id, original_filename, current_path, date_taken,
                content_hash, file_size, file_type, width, height, rating
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                photo_id,
                os.path.basename(rel_path),
                rel_path,
                "2024:01:15 12:00:00",
                content_hash,
                11,
                "photo",
                100,
                100,
                None,
            ),
        )
        conn.commit()
        conn.close()

    def test_delete_merges_when_same_hash_already_in_trash(self):
        self.client.post("/api/photos/delete", json={"photo_ids": [1]})

        self._insert_live_photo(2)

        response = self.client.post("/api/photos/delete", json={"photo_ids": [2]})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()["deleted"], 1)

        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        deleted_count = conn.execute("SELECT COUNT(*) FROM deleted_photos").fetchone()[0]
        row = conn.execute(
            "SELECT id, trash_filename FROM deleted_photos",
        ).fetchone()
        live_count = conn.execute("SELECT COUNT(*) FROM photos").fetchone()[0]
        conn.close()

        self.assertEqual(deleted_count, 1)
        self.assertEqual(row["id"], 1)
        self.assertEqual(live_count, 0)

        trash_path = resolve_user_deleted_trash_path(photo_app.TRASH_DIR, row["trash_filename"])
        self.assertTrue(os.path.isfile(trash_path))

        grid = self.client.get("/api/trash/photos?limit=10&sort=newest").get_json()
        self.assertEqual(grid["total"], 1)
        self.assertEqual(grid["photos"][0]["id"], 1)

    def test_trash_grid_one_row_after_import_trash_twice(self):
        self.client.post("/api/photos/delete", json={"photo_ids": [1]})
        self._insert_live_photo(2)
        self.client.post("/api/photos/delete", json={"photo_ids": [2]})
        self._insert_live_photo(3)
        self.client.post("/api/photos/delete", json={"photo_ids": [3]})

        grid = self.client.get("/api/trash/photos?limit=10&sort=newest").get_json()
        month_index = self.client.get("/api/trash/month_index?sort=newest").get_json()

        self.assertEqual(grid["total"], 1)
        self.assertEqual(len(grid["photos"]), 1)
        self.assertEqual(month_index["total"], 1)

    def test_archive_live_photo_to_user_trash_adopts_file_when_canonical_missing(self):
        self.client.post("/api/photos/delete", json={"photo_ids": [1]})

        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        row = conn.execute(
            "SELECT trash_filename FROM deleted_photos WHERE id = 1",
        ).fetchone()
        trash_path = resolve_user_deleted_trash_path(
            photo_app.TRASH_DIR,
            row["trash_filename"],
        )
        os.remove(trash_path)
        conn.close()

        self._insert_live_photo(2)

        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        cursor = conn.cursor()
        live = cursor.execute("SELECT * FROM photos WHERE id = 2").fetchone()
        outcome, trash_filename, error = archive_live_photo_to_user_trash(
            cursor,
            photo_id=2,
            photo_data=dict(live),
            current_path=live["current_path"],
            library_path=self.library_path,
            trash_dir=photo_app.TRASH_DIR,
            deleted_at="2024-01-16T12:00:00",
        )
        conn.commit()
        conn.close()

        self.assertIsNone(error)
        self.assertEqual(outcome, "merged_duplicate")
        self.assertIsNone(trash_filename)

        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        rows = conn.execute("SELECT id, trash_filename FROM deleted_photos").fetchall()
        conn.close()
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["id"], 1)
        adopted = resolve_user_deleted_trash_path(
            photo_app.TRASH_DIR,
            rows[0]["trash_filename"],
        )
        self.assertTrue(os.path.isfile(adopted))

    def test_restore_helper_does_not_commit_caller_owns_transaction(self):
        from trash_catalog import restore_or_merge_deleted_photo

        self.client.post("/api/photos/delete", json={"photo_ids": [1]})

        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        cursor = conn.cursor()
        status, restored_id, error = restore_or_merge_deleted_photo(
            cursor,
            photo_id=1,
            trash_dir=photo_app.TRASH_DIR,
            library_path=self.library_path,
        )
        self.assertEqual(status, "restored")
        self.assertIsNone(error)
        self.assertEqual(restored_id, 1)

        # Uncommitted: a fresh connection must not see the restore yet.
        other = sqlite3.connect(self.db_path)
        self.assertEqual(
            other.execute("SELECT COUNT(*) FROM deleted_photos").fetchone()[0],
            1,
        )
        self.assertEqual(
            other.execute("SELECT COUNT(*) FROM photos").fetchone()[0],
            0,
        )
        other.close()

        conn.commit()
        conn.close()

        other = sqlite3.connect(self.db_path)
        self.assertEqual(
            other.execute("SELECT COUNT(*) FROM deleted_photos").fetchone()[0],
            0,
        )
        self.assertEqual(
            other.execute("SELECT COUNT(*) FROM photos").fetchone()[0],
            1,
        )
        other.close()

    def test_restore_merges_star_blind_when_live_twin_has_stripped_hash(self):
        """Rated trash copy collapses against unrated live twin (star-blind)."""
        from file_operations import write_exif_rating
        from hash_cache import compute_hash_legacy
        from library_cleanliness import build_canonical_photo_path
        from PIL import Image

        self.client.post("/api/photos/delete", json={"photo_ids": [1]})
        # Purge the seeded short-hash fixture so we can use real JPEG hashes.
        self.client.post("/api/trash/purge", json={"photo_ids": [1]})

        plain = os.path.join(self._tmpdir, "plain.jpg")
        starred = os.path.join(self._tmpdir, "starred.jpg")
        Image.new("RGB", (12, 12), (9, 8, 7)).save(plain, "JPEG", quality=95)
        shutil.copy2(plain, starred)
        self.assertTrue(write_exif_rating(starred, 5))
        plain_hash = compute_hash_legacy(plain)
        starred_hash = compute_hash_legacy(starred)
        self.assertNotEqual(plain_hash, starred_hash)

        date_taken = "2024:01:15 12:00:00"
        live_rel, _ = build_canonical_photo_path(date_taken, plain_hash, ".jpg")
        live_full = os.path.join(self.library_path, live_rel)
        os.makedirs(os.path.dirname(live_full), exist_ok=True)
        shutil.copy2(plain, live_full)

        conn = sqlite3.connect(self.db_path)
        conn.execute(
            """
            INSERT INTO photos (
                id, original_filename, current_path, date_taken,
                content_hash, file_size, file_type, width, height, rating
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                10,
                "plain.jpg",
                live_rel,
                date_taken,
                plain_hash,
                os.path.getsize(live_full),
                "photo",
                12,
                12,
                None,
            ),
        )
        # Put starred twin into trash via archive helper path: insert deleted row + file.
        trash_rel = f"{USER_DELETED_TRASH_CATEGORY}/2024/2024-01-15/starred.jpg"
        trash_full = os.path.join(photo_app.TRASH_DIR, trash_rel)
        os.makedirs(os.path.dirname(trash_full), exist_ok=True)
        shutil.copy2(starred, trash_full)
        photo_data = {
            "id": 11,
            "original_filename": "starred.jpg",
            "current_path": "misc/starred.jpg",
            "date_taken": date_taken,
            "content_hash": starred_hash,
            "file_size": os.path.getsize(starred),
            "file_type": "photo",
            "width": 12,
            "height": 12,
            "rating": 5,
        }
        conn.execute(
            """
            INSERT INTO deleted_photos (id, original_path, trash_filename, deleted_at, photo_data)
            VALUES (?, ?, ?, ?, ?)
            """,
            (11, "misc/starred.jpg", trash_rel, "2024-01-16T00:00:00", json.dumps(photo_data)),
        )
        conn.commit()
        conn.close()

        response = self.client.post("/api/photos/restore", json={"photo_ids": [11]})
        self.assertEqual(response.status_code, 200)
        payload = response.get_json()
        self.assertEqual(payload["restored"], 1)
        self.assertEqual(payload["merged"], 1)

        conn = sqlite3.connect(self.db_path)
        self.assertEqual(conn.execute("SELECT COUNT(*) FROM photos").fetchone()[0], 1)
        self.assertEqual(conn.execute("SELECT COUNT(*) FROM deleted_photos").fetchone()[0], 0)
        self.assertEqual(conn.execute("SELECT id FROM photos").fetchone()[0], 10)
        conn.close()
        self.assertTrue(os.path.isfile(live_full))
        self.assertFalse(os.path.exists(trash_full))


if __name__ == "__main__":
    unittest.main()
