import os
import sqlite3
import unittest
from tempfile import TemporaryDirectory
from unittest.mock import patch

from clean_library_fast_audit import run_fast_library_audit
from db_schema import create_database_schema
from library_layout import canonical_db_path


class CleanLibraryFastAuditTest(unittest.TestCase):
    def _create_library_db(self, library_path: str):
        db_path = canonical_db_path(library_path)
        os.makedirs(os.path.dirname(db_path), exist_ok=True)
        conn = sqlite3.connect(db_path)
        create_database_schema(conn.cursor())
        conn.commit()
        return db_path, conn

    def test_detects_mole_and_ghost_without_heavy_canonicalize(self):
        with TemporaryDirectory() as tmpdir:
            db_path, conn = self._create_library_db(tmpdir)
            rel_path = os.path.join("2026", "2026-04-12", "img_20260412_abc1234d.jpg")
            full_path = os.path.join(tmpdir, rel_path)
            os.makedirs(os.path.dirname(full_path), exist_ok=True)
            with open(full_path, "wb") as handle:
                handle.write(b"photo-bytes")

            mole_path = os.path.join(tmpdir, "2026", "2026-04-12", "img_20260412_0000000m.jpg")
            with open(mole_path, "wb") as handle:
                handle.write(b"mole")

            conn.execute(
                """
                INSERT INTO photos (
                    original_filename, current_path, date_taken, content_hash,
                    file_size, file_type, width, height
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    "img_20260412_abc1234d.jpg",
                    rel_path,
                    "2026:04:12 09:30:15",
                    "deadbeef",
                    11,
                    "photo",
                    1,
                    1,
                ),
            )
            conn.execute(
                """
                INSERT INTO photos (
                    original_filename, current_path, date_taken, content_hash,
                    file_size, file_type, width, height
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    "ghost.jpg",
                    "2026/2026-04-12/ghost.jpg",
                    "2026:04:12 09:30:15",
                    "ghosthash",
                    1,
                    "photo",
                    1,
                    1,
                ),
            )
            conn.commit()
            conn.close()

            with patch(
                "clean_library_fast_audit.verify_media_file",
                return_value=(True, "mock"),
            ), patch(
                "clean_library_fast_audit.compute_hash_legacy",
                return_value=("abc123", False),
            ), patch(
                "clean_library_fast_audit.extract_exif_rating",
                return_value=None,
            ), patch(
                "clean_library_fast_audit.get_orientation_flag",
                return_value=1,
            ):
                issues = run_fast_library_audit(tmpdir, db_path=db_path)

            kinds = {issue["kind"] for issue in issues}
            self.assertIn("mole_missing_from_db", kinds)
            self.assertIn("ghost_db_reference", kinds)
            self.assertIn("db_hash_mismatch", kinds)

    def test_hash_duplicate_not_pixel(self):
        with TemporaryDirectory() as tmpdir:
            db_path, conn = self._create_library_db(tmpdir)
            conn.close()

            for suffix in ("11111111", "22222222"):
                rel_path = os.path.join("2026", "2026-04-12", f"img_20260412_{suffix}.jpg")
                full_path = os.path.join(tmpdir, rel_path)
                os.makedirs(os.path.dirname(full_path), exist_ok=True)
                with open(full_path, "wb") as handle:
                    handle.write(b"same-bytes")

            with patch(
                "clean_library_fast_audit.verify_media_file",
                return_value=(True, "mock"),
            ), patch(
                "clean_library_fast_audit.compute_hash_legacy",
                return_value=("samehash", False),
            ), patch(
                "clean_library_fast_audit.extract_exif_rating",
                return_value=None,
            ), patch(
                "clean_library_fast_audit.get_orientation_flag",
                return_value=1,
            ):
                issues = run_fast_library_audit(tmpdir, db_path=db_path)

            dupes = [issue for issue in issues if issue["kind"] == "duplicate_media"]
            self.assertEqual(len(dupes), 1)

    def test_audit_progress_uses_fixed_total(self):
        with TemporaryDirectory() as tmpdir:
            db_path, conn = self._create_library_db(tmpdir)
            conn.close()

            for index in range(5):
                rel_path = os.path.join(
                    "2026",
                    "2026-04-12",
                    f"img_20260412_{index:08x}.jpg",
                )
                full_path = os.path.join(tmpdir, rel_path)
                os.makedirs(os.path.dirname(full_path), exist_ok=True)
                with open(full_path, "wb") as handle:
                    handle.write(f"photo-{index}".encode())

            events = []

            with patch(
                "clean_library_fast_audit.verify_media_file",
                return_value=(True, "mock"),
            ), patch(
                "clean_library_fast_audit.compute_hash_legacy",
                side_effect=lambda _path: (f"hash-{os.path.basename(_path)}", False),
            ), patch(
                "clean_library_fast_audit.extract_exif_rating",
                return_value=None,
            ), patch(
                "clean_library_fast_audit.get_orientation_flag",
                return_value=1,
            ):
                run_fast_library_audit(
                    tmpdir,
                    db_path=db_path,
                    progress_callback=events.append,
                    audit_progress_total=5,
                )

            progress_events = [event for event in events if event.get("type") == "progress"]
            self.assertEqual(len(progress_events), 5)
            self.assertTrue(all(event["total"] == 5 for event in progress_events))
            self.assertEqual(progress_events[-1]["processed"], 5)


if __name__ == "__main__":
    unittest.main()
