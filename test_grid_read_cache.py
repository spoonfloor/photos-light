import os
import sqlite3
import tempfile
import unittest

import app as photo_app


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


if __name__ == "__main__":
    unittest.main()
