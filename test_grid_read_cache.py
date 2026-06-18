import os
import sqlite3
import tempfile
import unittest
from urllib.parse import quote
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
                date_added TEXT,
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

    def _insert_photo(
        self,
        conn,
        *,
        filename,
        path,
        date_taken,
        content_hash,
        file_type="photo",
        rating=None,
        date_added=None,
    ):
        conn.execute(
            """
            INSERT INTO photos (
                original_filename, current_path, date_taken, date_added, content_hash,
                file_size, file_type, width, height, rating
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                filename,
                path,
                date_taken,
                date_added,
                content_hash,
                100,
                file_type,
                1,
                1,
                rating,
            ),
        )

    def test_month_index_import_sets_returns_import_months(self):
        conn = sqlite3.connect(self.db_path)
        self._insert_photo(
            conn,
            filename="old.jpg",
            path="1900/1900-01-01/old.jpg",
            date_taken="1900:01:01 00:00:00",
            content_hash="hashbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            date_added="2026-06-15T10:00:00+00:00",
        )
        self._insert_photo(
            conn,
            filename="new.jpg",
            path="1920/1920-01-01/new.jpg",
            date_taken="1920:01:01 00:00:00",
            content_hash="hashcccccccccccccccccccccccccccc",
            date_added="2026-05-17T10:00:00+00:00",
        )
        conn.commit()
        conn.close()
        photo_app.invalidate_grid_read_caches()

        payload = self.client.get(
            "/api/photos/month_index?sort=newest&import_sets=2",
        ).get_json()
        self.assertTrue(payload["filtered"])
        self.assertEqual(payload["section_axis"], "import")
        self.assertEqual(payload["import_sets"], 2)
        self.assertEqual(payload["total"], 2)
        self.assertEqual(len(payload["months"]), 2)
        self.assertTrue(all(m["month"].startswith("import:") for m in payload["months"]))
        self.assertEqual(payload["months"][0]["month"], "import:2026-06")
        self.assertEqual(payload["months"][0]["count"], 1)
        self.assertEqual(payload["months"][1]["month"], "import:2026-05")
        self.assertEqual(payload["months"][1]["count"], 1)
        self.assertEqual(payload["import_month_keys"], ["2026-06", "2026-05"])

        unfiltered = self.client.get("/api/photos/month_index?sort=newest").get_json()
        self.assertFalse(unfiltered["filtered"])
        self.assertEqual(unfiltered["section_axis"], "date_taken")

    def test_month_index_import_sets_consolidates_same_import_month(self):
        conn = sqlite3.connect(self.db_path)
        self._insert_photo(
            conn,
            filename="a.jpg",
            path="1900/1900-01-01/a.jpg",
            date_taken="1900:01:01 00:00:00",
            content_hash="hashbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            date_added="2026-06-18T10:00:01+00:00",
        )
        self._insert_photo(
            conn,
            filename="b.jpg",
            path="1900/1900-01-02/b.jpg",
            date_taken="1900:01:02 00:00:00",
            content_hash="hashcccccccccccccccccccccccccccc",
            date_added="2026-06-18T10:00:02+00:00",
        )
        self._insert_photo(
            conn,
            filename="c.jpg",
            path="1900/1900-01-03/c.jpg",
            date_taken="1900:01:03 00:00:00",
            content_hash="hashdddddddddddddddddddddddddddd",
            date_added="2026-06-18T10:00:03+00:00",
        )
        conn.commit()
        conn.close()
        photo_app.invalidate_grid_read_caches()

        payload = self.client.get(
            "/api/photos/month_index?sort=newest&import_sets=5",
        ).get_json()
        self.assertEqual(len(payload["months"]), 1)
        self.assertEqual(payload["months"][0]["month"], "import:2026-06")
        self.assertEqual(payload["months"][0]["count"], 3)
        self.assertEqual(payload["total"], 3)

    def test_month_index_import_sets_combined_with_starred_and_video(self):
        conn = sqlite3.connect(self.db_path)
        self._insert_photo(
            conn,
            filename="star.jpg",
            path="1900/1900-01-02/star.jpg",
            date_taken="1900:01:02 00:00:00",
            content_hash="hashdddddddddddddddddddddddddddd",
            rating=5,
            date_added="2026-06-17T10:00:00+00:00",
        )
        self._insert_photo(
            conn,
            filename="clip.mov",
            path="1900/1900-01-03/clip.mov",
            date_taken="1900:01:03 00:00:00",
            content_hash="hasheeeeeeeeeeeeeeeeeeeeeeeeeeee",
            file_type="video",
            date_added="2026-06-16T10:00:00+00:00",
        )
        conn.commit()
        conn.close()
        photo_app.invalidate_grid_read_caches()

        starred = self.client.get(
            "/api/photos/month_index?sort=newest&import_sets=5&starred=1",
        ).get_json()
        self.assertTrue(starred["filtered"])
        self.assertEqual(starred["total"], 1)

        video = self.client.get(
            "/api/photos/month_index?sort=newest&import_sets=5&video=1",
        ).get_json()
        self.assertTrue(video["filtered"])
        self.assertEqual(video["total"], 1)

        combined = self.client.get(
            "/api/photos/month_index?sort=newest&import_sets=5&starred=1&video=1",
        ).get_json()
        self.assertEqual(combined["total"], 0)

    def test_month_index_cache_key_separates_import_sets_variants(self):
        conn = sqlite3.connect(self.db_path)
        self._insert_photo(
            conn,
            filename="cluster.jpg",
            path="1900/1900-01-01/cluster.jpg",
            date_taken="1900:01:01 00:00:00",
            content_hash="hashffffffffffffffffffffffffffffff",
            date_added="2026-06-17T10:00:00+00:00",
        )
        conn.commit()
        conn.close()
        photo_app.invalidate_grid_read_caches()

        unfiltered = self.client.get("/api/photos/month_index?sort=newest").get_json()
        starred = self.client.get(
            "/api/photos/month_index?sort=newest&starred=1",
        ).get_json()
        import_sets = self.client.get(
            "/api/photos/month_index?sort=newest&import_sets=5",
        ).get_json()

        self.assertFalse(unfiltered["filtered"])
        self.assertTrue(starred["filtered"])
        self.assertTrue(import_sets["filtered"])
        self.assertEqual(unfiltered["section_axis"], "date_taken")
        self.assertEqual(import_sets["section_axis"], "import")

        conn = sqlite3.connect(self.db_path)
        self._insert_photo(
            conn,
            filename="extra.jpg",
            path="1920/1920-01-01/extra.jpg",
            date_taken="1920:01:01 00:00:00",
            content_hash="hashgggggggggggggggggggggggggggg",
            date_added="2026-06-18T10:00:00+00:00",
        )
        conn.commit()
        conn.close()

        stale_unfiltered = self.client.get(
            "/api/photos/month_index?sort=newest",
        ).get_json()
        self.assertEqual(stale_unfiltered["total"], unfiltered["total"])

        photo_app.invalidate_grid_read_caches()
        fresh_unfiltered = self.client.get(
            "/api/photos/month_index?sort=newest",
        ).get_json()
        self.assertEqual(fresh_unfiltered["total"], 3)

    def test_month_hydrates_import_month_section(self):
        conn = sqlite3.connect(self.db_path)
        self._insert_photo(
            conn,
            filename="older.jpg",
            path="1900/1900-01-01/older.jpg",
            date_taken="1900:01:01 00:00:00",
            content_hash="hashhhhhhhhhhhhhhhhhhhhhhhhhhhhh",
            date_added="2026-06-17T10:00:00+00:00",
        )
        self._insert_photo(
            conn,
            filename="newer.jpg",
            path="2026/2026-01-01/newer.jpg",
            date_taken="2026:01:01 00:00:00",
            content_hash="hashiiiiiiiiiiiiiiiiiiiiiiiiiiiiii",
            date_added="2026-06-17T11:00:00+00:00",
        )
        conn.commit()
        conn.close()
        photo_app.invalidate_grid_read_caches()

        month_key = photo_app.encode_import_cluster_key("2026-06")
        payload = self.client.get(
            f"/api/photos/month?month={quote(month_key, safe='')}",
        ).get_json()
        self.assertEqual(payload["month"], month_key)
        self.assertEqual(payload["count"], 2)
        self.assertEqual(len(payload["photos"]), 2)
        self.assertEqual(payload["photos"][0]["path"], "2026/2026-01-01/newer.jpg")
        self.assertEqual(payload["photos"][1]["path"], "1900/1900-01-01/older.jpg")


if __name__ == "__main__":
    unittest.main()
