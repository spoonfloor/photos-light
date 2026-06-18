import json
import os
import shutil
import sqlite3
import unittest
from datetime import datetime
from tempfile import TemporaryDirectory
from unittest.mock import patch

import app as photo_app
from db_schema import create_database_schema
from make_library_clean_v2 import DBNormalizationEngine, MediaRecord
from photo_catalog import insert_photo_row
from trash_catalog import restore_or_merge_deleted_photo


class DateAddedInsertTest(unittest.TestCase):
    def test_new_insert_assigns_date_added(self):
        with TemporaryDirectory() as tmpdir:
            db_path = os.path.join(tmpdir, "photo_library.db")
            conn = sqlite3.connect(db_path)
            conn.row_factory = sqlite3.Row
            create_database_schema(conn.cursor())

            with patch("photo_catalog.catalog_now_utc_iso", return_value="2026-06-17T12:00:00+00:00"):
                photo_id = insert_photo_row(
                    conn,
                    {
                        "original_filename": "photo.jpg",
                        "current_path": "2026/2026-06-17/photo.jpg",
                        "date_taken": "2026:06:17 10:00:00",
                        "content_hash": "a" * 64,
                        "file_size": 100,
                        "file_type": "photo",
                        "width": 100,
                        "height": 100,
                    },
                )
            conn.commit()

            row = conn.execute(
                "SELECT date_added FROM photos WHERE id = ?",
                (photo_id,),
            ).fetchone()
            conn.close()
            self.assertEqual(row["date_added"], "2026-06-17T12:00:00+00:00")

    def test_insert_preserves_provided_date_added(self):
        with TemporaryDirectory() as tmpdir:
            db_path = os.path.join(tmpdir, "photo_library.db")
            conn = sqlite3.connect(db_path)
            conn.row_factory = sqlite3.Row
            create_database_schema(conn.cursor())

            photo_id = insert_photo_row(
                conn,
                {
                    "original_filename": "photo.jpg",
                    "current_path": "2026/2026-06-17/photo.jpg",
                    "date_taken": "2026:06:17 10:00:00",
                    "content_hash": "a" * 64,
                    "file_size": 100,
                    "file_type": "photo",
                    "width": 100,
                    "height": 100,
                },
                date_added="2025-01-01T08:00:00+00:00",
            )
            conn.commit()

            row = conn.execute(
                "SELECT date_added FROM photos WHERE id = ?",
                (photo_id,),
            ).fetchone()
            conn.close()
            self.assertEqual(row["date_added"], "2025-01-01T08:00:00+00:00")


class DateAddedRebuildTest(unittest.TestCase):
    def test_rebuild_preserves_existing_date_added(self):
        with TemporaryDirectory() as tmpdir:
            db_path = os.path.join(tmpdir, ".library", "photo_library.db")
            os.makedirs(os.path.dirname(db_path), exist_ok=True)
            rel_path = "2026/2026-06-17/photo.jpg"
            full_path = os.path.join(tmpdir, rel_path)
            os.makedirs(os.path.dirname(full_path), exist_ok=True)
            with open(full_path, "wb") as handle:
                handle.write(b"photo")

            conn = sqlite3.connect(db_path)
            conn.row_factory = sqlite3.Row
            create_database_schema(conn.cursor())
            insert_photo_row(
                conn,
                {
                    "original_filename": "photo.jpg",
                    "current_path": rel_path,
                    "date_taken": "2020:01:01 10:00:00",
                    "content_hash": "a" * 64,
                    "file_size": 5,
                    "file_type": "photo",
                    "width": 10,
                    "height": 10,
                },
                date_added="2025-06-01T09:00:00+00:00",
            )
            conn.commit()
            conn.close()

            engine = DBNormalizationEngine(tmpdir, db_path=db_path)
            engine.setup()
            record = MediaRecord(
                original_filename="photo.jpg",
                source_rel_path=rel_path,
                full_path=full_path,
                rel_path=rel_path,
                ext=".jpg",
                file_type="photo",
                content_hash="a" * 64,
                duplicate_key="a" * 64,
                date_taken="2020:01:01 10:00:00",
                date_obj=datetime(2020, 1, 1, 10, 0, 0),
                width=10,
                height=10,
                rating=None,
                metadata_cleaned=False,
                has_metadata_cleanup_signal=False,
                birth_time=0.0,
                modified_time=0.0,
            )
            engine._rebuild_photos_table_full([record])

            conn = sqlite3.connect(db_path)
            conn.row_factory = sqlite3.Row
            row = conn.execute("SELECT date_added FROM photos").fetchone()
            conn.close()
            self.assertEqual(row["date_added"], "2025-06-01T09:00:00+00:00")


class DateAddedTrashRestoreTest(unittest.TestCase):
    def setUp(self):
        self._tmpdir = TemporaryDirectory()
        self.library_path = os.path.join(self._tmpdir.name, "library")
        os.makedirs(self.library_path, exist_ok=True)
        self.db_path = os.path.join(self.library_path, ".library", "photo_library.db")
        os.makedirs(os.path.dirname(self.db_path), exist_ok=True)

        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        create_database_schema(conn.cursor())
        conn.commit()
        conn.close()

        photo_app.LIBRARY_PATH = self.library_path
        photo_app.DB_PATH = self.db_path
        photo_app.update_app_paths(self.library_path, self.db_path)
        photo_app.app.config["TESTING"] = True

    def tearDown(self):
        shutil.rmtree(self._tmpdir.name, ignore_errors=True)

    def test_trash_restore_keeps_date_added(self):
        rel_path = "2024/2024-01-15/photo.jpg"
        full_path = os.path.join(self.library_path, rel_path)
        os.makedirs(os.path.dirname(full_path), exist_ok=True)
        with open(full_path, "wb") as handle:
            handle.write(b"photo-bytes")

        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        create_database_schema(conn.cursor())
        photo_id = insert_photo_row(
            conn,
            {
                "original_filename": "photo.jpg",
                "current_path": rel_path,
                "date_taken": "2024:01:15 12:00:00",
                "content_hash": "abc1234",
                "file_size": 11,
                "file_type": "photo",
                "width": 100,
                "height": 100,
            },
            date_added="2024-02-01T15:00:00+00:00",
        )
        conn.commit()
        conn.close()

        response = photo_app.app.test_client().post(
            "/api/photos/delete",
            json={"photo_ids": [photo_id]},
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()["deleted"], 1)

        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        cursor = conn.cursor()
        status, restored_id, error = restore_or_merge_deleted_photo(
            cursor,
            photo_id=photo_id,
            library_path=self.library_path,
            trash_dir=photo_app.TRASH_DIR,
        )
        conn.close()
        self.assertEqual(status, "restored")
        self.assertIsNone(error)

        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        row = conn.execute(
            "SELECT date_added FROM photos WHERE id = ?",
            (restored_id,),
        ).fetchone()
        conn.close()
        self.assertEqual(row["date_added"], "2024-02-01T15:00:00+00:00")


class DateAddedApiSortTest(unittest.TestCase):
    def setUp(self):
        self._tmpdir = TemporaryDirectory()
        self.library_path = os.path.join(self._tmpdir.name, "library")
        os.makedirs(self.library_path, exist_ok=True)
        self.db_path = os.path.join(self.library_path, ".library", "photo_library.db")
        os.makedirs(os.path.dirname(self.db_path), exist_ok=True)

        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        create_database_schema(conn.cursor())
        insert_photo_row(
            conn,
            {
                "original_filename": "old.jpg",
                "current_path": "2020/2020-01-01/old.jpg",
                "date_taken": "2020:01:01 10:00:00",
                "content_hash": "a" * 64,
                "file_size": 10,
                "file_type": "photo",
                "width": 10,
                "height": 10,
            },
            date_added="2026-06-17T12:00:00+00:00",
        )
        insert_photo_row(
            conn,
            {
                "original_filename": "new.jpg",
                "current_path": "2026/2026-06-01/new.jpg",
                "date_taken": "2026:06:01 10:00:00",
                "content_hash": "b" * 64,
                "file_size": 10,
                "file_type": "photo",
                "width": 10,
                "height": 10,
            },
            date_added="2026-06-01T10:00:00+00:00",
        )
        conn.commit()
        conn.close()

        photo_app.LIBRARY_PATH = self.library_path
        photo_app.DB_PATH = self.db_path

    def tearDown(self):
        shutil.rmtree(self._tmpdir.name, ignore_errors=True)

    def test_recently_added_sort_differs_from_newest(self):
        client = photo_app.app.test_client()
        recent = client.get("/api/photos?limit=10&sort=recently_added").get_json()
        newest = client.get("/api/photos?limit=10&sort=newest").get_json()

        recent_ids = [photo["id"] for photo in recent["photos"]]
        newest_ids = [photo["id"] for photo in newest["photos"]]
        self.assertNotEqual(recent_ids, newest_ids)
        self.assertEqual(recent["sort"], "recently_added")

    def test_import_sets_limits_to_top_distinct_date_added_clusters(self):
        client = photo_app.app.test_client()
        payload = client.get(
            "/api/photos?limit=50&sort=recently_added&import_sets=2"
        ).get_json()

        self.assertEqual(payload["import_sets"], 2)
        self.assertEqual(payload["import_set_count"], 2)
        self.assertEqual(payload["total"], 2)
        self.assertEqual(len(payload["photos"]), 2)

    def test_import_sets_empty_when_no_date_added_values(self):
        conn = sqlite3.connect(self.db_path)
        conn.execute("UPDATE photos SET date_added = NULL")
        conn.commit()
        conn.close()

        client = photo_app.app.test_client()
        payload = client.get(
            "/api/photos?limit=50&sort=recently_added&import_sets=5"
        ).get_json()

        self.assertEqual(payload["import_set_count"], 0)
        self.assertEqual(payload["total"], 0)
        self.assertEqual(payload["photos"], [])


class DateAddedMigrationBackfillTest(unittest.TestCase):
    def test_backfill_from_import_logs(self):
        with TemporaryDirectory() as tmpdir:
            library_path = tmpdir
            logs_dir = os.path.join(library_path, ".logs")
            os.makedirs(logs_dir, exist_ok=True)
            db_path = os.path.join(library_path, ".library", "photo_library.db")
            os.makedirs(os.path.dirname(db_path), exist_ok=True)

            conn = sqlite3.connect(db_path)
            create_database_schema(conn.cursor())
            conn.execute(
                """
                INSERT INTO photos (
                    original_filename, current_path, date_taken, content_hash,
                    file_size, file_type, width, height
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    "photo.jpg",
                    "2026/2026-06-17/photo.jpg",
                    "2026:06:17 10:00:00",
                    "a" * 64,
                    10,
                    "photo",
                    10,
                    10,
                ),
            )
            conn.commit()
            conn.close()

            with open(os.path.join(logs_dir, "import_20260617.jsonl"), "w", encoding="utf-8") as handle:
                handle.write(
                    json.dumps(
                        {
                            "timestamp": "2026-06-17T11:00:00",
                            "event": "imported",
                            "photo_id": 1,
                            "file": "/tmp/photo.jpg",
                        }
                    )
                    + "\n"
                )

            from migrate_db import check_and_migrate_schema

            self.assertTrue(check_and_migrate_schema(db_path))

            conn = sqlite3.connect(db_path)
            conn.row_factory = sqlite3.Row
            row = conn.execute("SELECT date_added FROM photos WHERE id = 1").fetchone()
            conn.close()
            self.assertEqual(row["date_added"], "2026-06-17T11:00:00")


if __name__ == "__main__":
    unittest.main()
