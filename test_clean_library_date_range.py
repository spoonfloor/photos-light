import os
import sqlite3
import unittest
from datetime import date
from tempfile import TemporaryDirectory

from db_schema import create_database_schema
from library_filesystem import iter_library_walk_date_range
from make_library_clean_v2 import (
    CleanLibraryError,
    DBNormalizationEngine,
    MediaRecord,
    parse_clean_date_range,
)


class DateRangeCleanTest(unittest.TestCase):
    def test_parse_clean_date_range(self):
        start, end = parse_clean_date_range("2026-05-01", "2026-06-30")
        self.assertEqual(start, date(2026, 5, 1))
        self.assertEqual(end, date(2026, 6, 30))

    def test_parse_clean_date_range_rejects_inverted(self):
        with self.assertRaises(CleanLibraryError):
            parse_clean_date_range("2026-06-01", "2026-05-01")

    def test_iter_library_walk_date_range_only_visits_range(self):
        with TemporaryDirectory() as tmpdir:
            in_path = os.path.join(tmpdir, "2026", "2026-06-15", "img_test.jpg")
            out_path = os.path.join(tmpdir, "2026", "2026-01-01", "img_old.jpg")
            os.makedirs(os.path.dirname(in_path), exist_ok=True)
            os.makedirs(os.path.dirname(out_path), exist_ok=True)
            open(in_path, "wb").close()
            open(out_path, "wb").close()

            seen = {
                os.path.join(root, name)
                for root, _dirs, files in iter_library_walk_date_range(
                    tmpdir,
                    date(2026, 6, 1),
                    date(2026, 6, 30),
                )
                for name in files
            }
            self.assertIn(in_path, seen)
            self.assertNotIn(out_path, seen)

    def test_rebuild_photos_table_date_scoped_preserves_out_of_range_rows(self):
        with TemporaryDirectory() as tmpdir:
            db_path = os.path.join(tmpdir, ".library", "photo_library.db")
            os.makedirs(os.path.dirname(db_path), exist_ok=True)
            conn = sqlite3.connect(db_path)
            conn.row_factory = sqlite3.Row
            create_database_schema(conn.cursor())
            conn.execute(
                """
                INSERT INTO photos (
                    original_filename, current_path, date_taken, content_hash,
                    file_size, file_type, width, height, rating
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    "old.jpg",
                    "2025/2025-01-01/old.jpg",
                    "2025:01:01 12:00:00",
                    "a" * 64,
                    10,
                    "photo",
                    100,
                    100,
                    None,
                ),
            )
            conn.commit()
            conn.close()

            engine = DBNormalizationEngine(
                tmpdir,
                db_path=db_path,
                date_from=date(2026, 6, 1),
                date_to=date(2026, 6, 30),
            )
            engine.setup()
            in_range_path = os.path.join(tmpdir, "2026", "2026-06-15", "img_new.jpg")
            os.makedirs(os.path.dirname(in_range_path), exist_ok=True)
            with open(in_range_path, "wb") as handle:
                handle.write(b"new")

            from datetime import datetime

            in_range_record = MediaRecord(
                original_filename="img_new.jpg",
                source_rel_path="2026/2026-06-15/img_new.jpg",
                full_path=in_range_path,
                rel_path="2026/2026-06-15/img_new.jpg",
                ext=".jpg",
                file_type="photo",
                content_hash="b" * 64,
                duplicate_key="b" * 64,
                date_taken="2026:06:15 10:00:00",
                date_obj=datetime(2026, 6, 15, 10, 0, 0),
                width=200,
                height=200,
                rating=None,
                metadata_cleaned=False,
                has_metadata_cleanup_signal=False,
                birth_time=0.0,
                modified_time=0.0,
            )
            engine._rebuild_photos_table_date_scoped([in_range_record])

            conn = sqlite3.connect(db_path)
            conn.row_factory = sqlite3.Row
            rows = conn.execute(
                "SELECT current_path, date_taken FROM photos ORDER BY date_taken"
            ).fetchall()
            conn.close()
            self.assertEqual(len(rows), 2)
            self.assertEqual(rows[0]["current_path"], "2025/2025-01-01/old.jpg")
            self.assertEqual(rows[1]["current_path"], "2026/2026-06-15/img_new.jpg")


if __name__ == "__main__":
    unittest.main()
