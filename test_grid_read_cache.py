import os
import sqlite3
import tempfile
import unittest
from unittest.mock import patch

import app as photo_app
from media_finalization import FinalizeMediaResult


class GridReadCacheTest(unittest.TestCase):
    def setUp(self):
        self._tmpdir = tempfile.TemporaryDirectory()
        self.library_path = os.path.join(self._tmpdir.name, "library")
        os.makedirs(self.library_path, exist_ok=True)
        self.db_path = os.path.join(self.library_path, "photos.db")

        conn = sqlite3.connect(self.db_path)
        conn.executescript(
            """
            CREATE TABLE photos (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                original_filename TEXT,
                current_path TEXT,
                date_taken TEXT,
                content_hash TEXT,
                file_size INTEGER,
                file_type TEXT,
                width INTEGER,
                height INTEGER,
                rating INTEGER
            );
            """
        )
        conn.execute(
            """
            INSERT INTO photos (
                original_filename, current_path, date_taken, content_hash,
                file_size, file_type, width, height, rating
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                "a.jpg",
                "1900/1900-01-01/a.jpg",
                "1900:01:01 00:00:00",
                "hashaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                100,
                "photo",
                1,
                1,
                None,
            ),
        )
        conn.commit()
        conn.close()

        photo_app.LIBRARY_PATH = self.library_path
        photo_app.DB_PATH = self.db_path
        photo_app.TRASH_DIR = os.path.join(self.library_path, ".trash")
        photo_app.THUMBNAIL_CACHE_DIR = os.path.join(self.library_path, ".thumbnails")
        os.makedirs(photo_app.TRASH_DIR, exist_ok=True)
        os.makedirs(photo_app.THUMBNAIL_CACHE_DIR, exist_ok=True)
        photo_app.invalidate_grid_read_caches()
        self.client = photo_app.app.test_client()

    def tearDown(self):
        photo_app.invalidate_grid_read_caches()
        self._tmpdir.cleanup()

    def test_month_index_cache_serves_stale_data_until_invalidated(self):
        first = self.client.get("/api/photos/month_index?sort=newest").get_json()
        self.assertEqual(first["total"], 1)
        self.assertEqual(first["months"][0]["month"], "1900-01")
        self.assertEqual(first["months"][0]["count"], 1)

        conn = sqlite3.connect(self.db_path)
        conn.execute(
            """
            INSERT INTO photos (
                original_filename, current_path, date_taken, content_hash,
                file_size, file_type, width, height, rating
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                "b.jpg",
                "1920/1920-01-01/b.jpg",
                "1920:01:01 00:00:00",
                "hashbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
                100,
                "photo",
                1,
                1,
                None,
            ),
        )
        conn.commit()
        conn.close()

        stale = self.client.get("/api/photos/month_index?sort=newest").get_json()
        self.assertEqual(stale["total"], 1)

        photo_app.invalidate_grid_read_caches()
        fresh = self.client.get("/api/photos/month_index?sort=newest").get_json()
        self.assertEqual(fresh["total"], 2)
        self.assertEqual(
            {entry["month"]: entry["count"] for entry in fresh["months"]},
            {"1920-01": 1, "1900-01": 1},
        )

    def test_invalidate_grid_read_caches_clears_total_count(self):
        first_total = self.client.get("/api/photos?sort=newest&limit=1").get_json()["total"]
        self.assertEqual(first_total, 1)

        conn = sqlite3.connect(self.db_path)
        conn.execute(
            """
            INSERT INTO photos (
                original_filename, current_path, date_taken, content_hash,
                file_size, file_type, width, height, rating
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                "c.jpg",
                "1920/1920-02-01/c.jpg",
                "1920:02:01 00:00:00",
                "hashcccccccccccccccccccccccccccc",
                100,
                "photo",
                1,
                1,
                None,
            ),
        )
        conn.commit()
        conn.close()

        stale_total = self.client.get("/api/photos?sort=newest&limit=1").get_json()["total"]
        self.assertEqual(stale_total, 1)

        photo_app.invalidate_grid_read_caches()
        fresh_total = self.client.get("/api/photos?sort=newest&limit=1").get_json()["total"]
        self.assertEqual(fresh_total, 2)

    def test_month_index_supports_starred_and_video_filters(self):
        conn = sqlite3.connect(self.db_path)
        conn.execute(
            """
            INSERT INTO photos (
                original_filename, current_path, date_taken, content_hash,
                file_size, file_type, width, height, rating
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                "star.jpg",
                "1900/1900-01-02/star.jpg",
                "1900:01:02 00:00:00",
                "hashbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
                100,
                "photo",
                1,
                1,
                5,
            ),
        )
        conn.execute(
            """
            INSERT INTO photos (
                original_filename, current_path, date_taken, content_hash,
                file_size, file_type, width, height, rating
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                "clip.mov",
                "1900/1900-01-03/clip.mov",
                "1900:01:03 00:00:00",
                "hashcccccccccccccccccccccccccccc",
                100,
                "video",
                1,
                1,
                None,
            ),
        )
        conn.commit()
        conn.close()
        photo_app.invalidate_grid_read_caches()

        unfiltered = self.client.get("/api/photos/month_index?sort=newest").get_json()
        self.assertEqual(unfiltered["total"], 3)
        self.assertFalse(unfiltered["filtered"])

        starred = self.client.get(
            "/api/photos/month_index?sort=newest&starred=1",
        ).get_json()
        self.assertTrue(starred["filtered"])
        self.assertEqual(starred["total"], 1)
        self.assertEqual(starred["months"], [{"month": "1900-01", "count": 1}])

        video = self.client.get(
            "/api/photos/month_index?sort=newest&video=1",
        ).get_json()
        self.assertTrue(video["filtered"])
        self.assertEqual(video["total"], 1)
        self.assertEqual(video["months"], [{"month": "1900-01", "count": 1}])

    def test_toggle_favorite_invalidates_starred_month_index_cache(self):
        photo_dir = os.path.join(self.library_path, "1900", "1900-01-01")
        os.makedirs(photo_dir, exist_ok=True)
        photo_path = os.path.join(photo_dir, "a.jpg")
        with open(photo_path, "wb") as fh:
            fh.write(b"test-photo-bytes")

        self.client.get("/api/photos/month_index?sort=newest").get_json()
        starred_before = self.client.get(
            "/api/photos/month_index?sort=newest&starred=1",
        ).get_json()
        self.assertEqual(starred_before["total"], 0)

        finalize_result = FinalizeMediaResult(
            status="finalized",
            current_path="1900/1900-01-01/a.jpg",
            full_path=photo_path,
            content_hash="hashaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            file_size=len(b"test-photo-bytes"),
            width=1,
            height=1,
        )

        with patch(
            "file_operations.extract_exif_rating",
            side_effect=[None, 5],
        ), patch("file_operations.write_exif_rating", return_value=True), patch.object(
            photo_app,
            "finalize_mutated_media",
            return_value=finalize_result,
        ):
            response = self.client.post("/api/photo/1/favorite")

        self.assertEqual(response.status_code, 200)

        starred_after = self.client.get(
            "/api/photos/month_index?sort=newest&starred=1",
        ).get_json()
        self.assertEqual(starred_after["total"], 1)
        self.assertEqual(starred_after["months"], [{"month": "1900-01", "count": 1}])

    def test_delete_invalidates_month_index_cache(self):
        photo_dir = os.path.join(self.library_path, "1900", "1900-01-01")
        os.makedirs(photo_dir, exist_ok=True)
        with open(os.path.join(photo_dir, "a.jpg"), "wb") as fh:
            fh.write(b"test-photo-bytes")

        before = self.client.get("/api/photos/month_index?sort=newest").get_json()
        self.assertEqual(before["total"], 1)

        response = self.client.post("/api/photos/delete", json={"photo_ids": [1]})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()["deleted"], 1)

        after = self.client.get("/api/photos/month_index?sort=newest").get_json()
        self.assertEqual(after["total"], 0)
        self.assertEqual(after["months"], [])

    def test_restore_invalidates_month_index_cache(self):
        photo_dir = os.path.join(self.library_path, "1900", "1900-01-01")
        os.makedirs(photo_dir, exist_ok=True)
        with open(os.path.join(photo_dir, "a.jpg"), "wb") as fh:
            fh.write(b"test-photo-bytes")

        delete_response = self.client.post("/api/photos/delete", json={"photo_ids": [1]})
        self.assertEqual(delete_response.status_code, 200)
        self.assertEqual(delete_response.get_json()["deleted"], 1)

        empty = self.client.get("/api/photos/month_index?sort=newest").get_json()
        self.assertEqual(empty["total"], 0)

        restore_response = self.client.post("/api/photos/restore", json={"photo_ids": [1]})
        self.assertEqual(restore_response.status_code, 200)
        self.assertEqual(restore_response.get_json()["restored"], 1)

        restored = self.client.get("/api/photos/month_index?sort=newest").get_json()
        self.assertEqual(restored["total"], 1)
        self.assertEqual(restored["months"], [{"month": "1900-01", "count": 1}])


if __name__ == "__main__":
    unittest.main()
