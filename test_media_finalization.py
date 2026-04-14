import os
import sqlite3
import unittest
from tempfile import TemporaryDirectory

from db_schema import create_database_schema
from library_cleanliness import build_canonical_photo_path
from media_finalization import finalize_mutated_media


class MediaFinalizationTest(unittest.TestCase):
    def setUp(self):
        self.tmpdir = TemporaryDirectory()
        self.library_path = self.tmpdir.name
        self.db_path = os.path.join(self.library_path, "test.db")
        self.conn = sqlite3.connect(self.db_path)
        self.conn.row_factory = sqlite3.Row
        create_database_schema(self.conn.cursor())
        self.conn.commit()
        self.deleted_thumbnails = []

    def tearDown(self):
        self.conn.close()
        self.tmpdir.cleanup()

    def _insert_photo(self, *, current_path, content_hash, original_filename="source.jpg"):
        full_path = os.path.join(self.library_path, current_path)
        os.makedirs(os.path.dirname(full_path), exist_ok=True)
        with open(full_path, "wb") as fh:
            fh.write(b"payload")

        cursor = self.conn.cursor()
        cursor.execute(
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
                original_filename,
                current_path,
                "2026:04:12 09:30:15",
                content_hash,
                os.path.getsize(full_path),
                "photo",
                None,
                None,
            ),
        )
        self.conn.commit()
        return cursor.lastrowid, full_path

    def test_finalize_mutated_media_updates_db_and_moves_to_canonical_path(self):
        photo_id, old_full_path = self._insert_photo(
            current_path="2026/2026-04-12/img_20260412_oldhash.jpg",
            content_hash="oldhash1",
        )

        result = finalize_mutated_media(
            conn=self.conn,
            photo_id=photo_id,
            library_path=self.library_path,
            current_rel_path="2026/2026-04-12/img_20260412_oldhash.jpg",
            date_taken="2026:04:12 09:30:15",
            old_hash="oldhash1",
            build_canonical_path=build_canonical_photo_path,
            compute_hash=lambda _: "newhash8",
            get_dimensions=lambda _: (480, 640),
            delete_thumbnail_for_hash=self.deleted_thumbnails.append,
        )
        self.conn.commit()

        expected_rel_path = "2026/2026-04-12/img_20260412_newhash8.jpg"
        self.assertEqual(result.status, "finalized")
        self.assertEqual(result.current_path, expected_rel_path)
        self.assertFalse(os.path.exists(old_full_path))
        self.assertTrue(os.path.exists(os.path.join(self.library_path, expected_rel_path)))
        self.assertEqual(self.deleted_thumbnails, ["oldhash1"])

        row = self.conn.execute(
            "SELECT current_path, content_hash, width, height FROM photos WHERE id = ?",
            (photo_id,),
        ).fetchone()
        self.assertEqual(row["current_path"], expected_rel_path)
        self.assertEqual(row["content_hash"], "newhash8")
        self.assertEqual(row["width"], 480)
        self.assertEqual(row["height"], 640)

    def test_finalize_mutated_media_trashes_duplicate_and_deletes_row(self):
        duplicate_id, _ = self._insert_photo(
            current_path="2026/2026-04-12/img_20260412_dupehash.jpg",
            content_hash="dupehash",
            original_filename="existing.jpg",
        )
        photo_id, current_full_path = self._insert_photo(
            current_path="2026/2026-04-12/img_20260412_source.jpg",
            content_hash="oldhash1",
        )

        result = finalize_mutated_media(
            conn=self.conn,
            photo_id=photo_id,
            library_path=self.library_path,
            current_rel_path="2026/2026-04-12/img_20260412_source.jpg",
            date_taken="2026:04:12 09:30:15",
            old_hash="oldhash1",
            build_canonical_path=build_canonical_photo_path,
            compute_hash=lambda _: "dupehash",
            get_dimensions=lambda _: (640, 480),
            delete_thumbnail_for_hash=self.deleted_thumbnails.append,
            duplicate_policy="trash",
            duplicate_trash_dir=os.path.join(self.library_path, ".trash", "duplicates"),
        )
        self.conn.commit()

        self.assertEqual(result.status, "duplicate_removed")
        self.assertEqual(result.duplicate.photo_id, duplicate_id)
        self.assertFalse(os.path.exists(current_full_path))
        self.assertTrue(os.path.exists(result.duplicate_destination))
        self.assertEqual(self.deleted_thumbnails, ["oldhash1"])

        row = self.conn.execute(
            "SELECT id FROM photos WHERE id = ?",
            (photo_id,),
        ).fetchone()
        self.assertIsNone(row)

    def test_finalize_mutated_media_deletes_duplicate_import_copy(self):
        self._insert_photo(
            current_path="2026/2026-04-12/img_20260412_dupehash.jpg",
            content_hash="dupehash",
            original_filename="existing.jpg",
        )
        photo_id, current_full_path = self._insert_photo(
            current_path="2026/2026-04-12/img_20260412_import.jpg",
            content_hash="oldhash1",
            original_filename="import.jpg",
        )

        result = finalize_mutated_media(
            conn=self.conn,
            photo_id=photo_id,
            library_path=self.library_path,
            current_rel_path="2026/2026-04-12/img_20260412_import.jpg",
            date_taken="2026:04:12 09:30:15",
            old_hash="oldhash1",
            build_canonical_path=build_canonical_photo_path,
            compute_hash=lambda _: "dupehash",
            get_dimensions=lambda _: (640, 480),
            delete_thumbnail_for_hash=self.deleted_thumbnails.append,
            duplicate_policy="delete",
        )
        self.conn.commit()

        self.assertEqual(result.status, "duplicate_removed")
        self.assertFalse(os.path.exists(current_full_path))
        row = self.conn.execute(
            "SELECT id FROM photos WHERE id = ?",
            (photo_id,),
        ).fetchone()
        self.assertIsNone(row)


if __name__ == "__main__":
    unittest.main()
