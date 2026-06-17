import os
import shutil
import sqlite3
import unittest
from tempfile import TemporaryDirectory

import app as photo_app
from db_schema import create_database_schema
from library_cleanliness import build_canonical_photo_path
from tools.repair_row_drift import assess_row, find_file_by_content_hash


class RepairRowDriftTest(unittest.TestCase):
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

    def tearDown(self):
        self.tmpdir.cleanup()

    def _insert_row(self, *, photo_id=None, rel_path, content_hash):
        conn = sqlite3.connect(self.db_path)
        conn.execute(
            """
            INSERT INTO photos (
                original_filename, current_path, date_taken, content_hash,
                file_size, file_type, width, height, rating
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                os.path.basename(rel_path),
                rel_path,
                "2026:04:12 09:30:15",
                content_hash,
                10,
                "photo",
                1,
                1,
                None,
            ),
        )
        conn.commit()
        if photo_id is None:
            photo_id = conn.execute("SELECT id FROM photos ORDER BY id DESC").fetchone()[0]
        conn.close()
        return photo_id

    def test_find_file_by_content_hash_matches_canonical_name(self):
        rel_path = "2026/2026-04-12/source.jpg"
        full_path = os.path.join(self.library_path, rel_path)
        os.makedirs(os.path.dirname(full_path), exist_ok=True)
        with open(full_path, "wb") as handle:
            handle.write(b"payload")

        photo_app.update_app_paths(self.library_path, self.db_path)
        actual_hash = photo_app.compute_full_hash(full_path)
        canonical_rel, _ = build_canonical_photo_path(
            "2026:04:12 09:30:15",
            actual_hash,
            ".jpg",
        )
        canonical_full = os.path.join(self.library_path, canonical_rel)
        os.makedirs(os.path.dirname(canonical_full), exist_ok=True)
        shutil.move(full_path, canonical_full)

        found, reason = find_file_by_content_hash(
            self.library_path,
            content_hash=actual_hash,
            date_taken="2026:04:12 09:30:15",
            db_paths=set(),
        )
        self.assertEqual(found, canonical_rel)
        self.assertEqual(reason, "content_hash_match")

    def test_find_file_uses_single_orphan_heuristic(self):
        rel_path = "2026/2026-04-12/orphan.jpg"
        full_path = os.path.join(self.library_path, rel_path)
        os.makedirs(os.path.dirname(full_path), exist_ok=True)
        with open(full_path, "wb") as handle:
            handle.write(b"orphan")

        found, reason = find_file_by_content_hash(
            self.library_path,
            content_hash="f" * 64,
            date_taken="2026:04:12 09:30:15",
            db_paths=set(),
        )
        self.assertEqual(found, rel_path)
        self.assertEqual(reason, "single_orphan_in_date_folder")

    def test_assess_row_detects_missing_path(self):
        stale_path = "2026/2026-04-12/missing.jpg"
        self._insert_row(rel_path=stale_path, content_hash="b" * 64)
        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        row = conn.execute("SELECT id, current_path, content_hash, date_taken, rating FROM photos").fetchone()
        conn.close()

        assessment = assess_row(self.library_path, row, {stale_path})
        self.assertEqual(assessment["action"], "unresolved")


if __name__ == "__main__":
    unittest.main()
