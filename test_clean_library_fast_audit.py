import os
import sqlite3
import unittest
from tempfile import TemporaryDirectory
from unittest.mock import patch

from clean_library_fast_audit import FastAuditCancelled, run_fast_library_audit
from db_schema import create_database_schema
from library_layout import canonical_db_path
from normalization_contract import (
    INGEST_POLICY,
    REPAIR_POLICY,
    NormalizationMode,
    compute_duplicate_key,
    expected_canonical_rel_path_from_db_date,
    normalize_hash_result,
)


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

    def test_shared_normalization_contract_is_hash_based(self):
        self.assertEqual(NormalizationMode.INGEST.value, "ingest")
        self.assertFalse(INGEST_POLICY.blocking_audit)
        self.assertTrue(REPAIR_POLICY.blocking_audit)
        self.assertEqual(INGEST_POLICY.source_scope, "external")
        self.assertEqual(REPAIR_POLICY.source_scope, "library")
        self.assertEqual(INGEST_POLICY.duplicate_action, "skip")
        self.assertEqual(REPAIR_POLICY.duplicate_action, "trash_loser")
        self.assertEqual(INGEST_POLICY.misfiled_action, "copy_to_canonical")
        self.assertEqual(REPAIR_POLICY.misfiled_action, "move_to_canonical")
        self.assertEqual(INGEST_POLICY.unsupported_action, "reject")
        self.assertEqual(REPAIR_POLICY.unsupported_action, "trash")
        self.assertEqual(normalize_hash_result(("abc123", False)), "abc123")
        self.assertEqual(
            compute_duplicate_key(
                "/tmp/not-read.jpg",
                fallback_hash="f" * 64,
            ),
            "f" * 64,
        )
        self.assertEqual(
            expected_canonical_rel_path_from_db_date(
                "2026:04:12 09:30:15",
                "abc12345" + ("0" * 56),
                ".JPG",
            ),
            os.path.join("2026", "2026-04-12", "img_20260412_abc12345.jpg"),
        )

    def test_fast_audit_uses_computed_canonical_path_not_regex_only(self):
        with TemporaryDirectory() as tmpdir:
            db_path, conn = self._create_library_db(tmpdir)
            actual_hash = "abc12345" + ("0" * 56)
            rel_path = os.path.join("2026", "2026-04-12", "img_20260412_deadbeef.jpg")
            full_path = os.path.join(tmpdir, rel_path)
            os.makedirs(os.path.dirname(full_path), exist_ok=True)
            with open(full_path, "wb") as handle:
                handle.write(b"photo-bytes")

            conn.execute(
                """
                INSERT INTO photos (
                    original_filename, current_path, date_taken, content_hash,
                    file_size, file_type, width, height
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    "img_20260412_deadbeef.jpg",
                    rel_path,
                    "2026:04:12 09:30:15",
                    actual_hash,
                    os.path.getsize(full_path),
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
                return_value=actual_hash,
            ), patch(
                "clean_library_fast_audit.extract_exif_rating",
                return_value=None,
            ), patch(
                "clean_library_fast_audit.get_orientation_flag",
                return_value=1,
            ):
                issues = run_fast_library_audit(tmpdir, db_path=db_path)

            misfiled = [issue for issue in issues if issue["kind"] == "misnamed_or_misfiled"]
            self.assertEqual(len(misfiled), 1)
            self.assertIn("img_20260412_abc12345.jpg", misfiled[0]["detail"])

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

    def test_cancel_check_stops_audit_walk(self):
        with TemporaryDirectory() as tmpdir:
            db_path, conn = self._create_library_db(tmpdir)
            conn.close()

            for index in range(3):
                rel_path = os.path.join(
                    "2026",
                    "2026-04-12",
                    f"img_20260412_{index:08x}.jpg",
                )
                full_path = os.path.join(tmpdir, rel_path)
                os.makedirs(os.path.dirname(full_path), exist_ok=True)
                with open(full_path, "wb") as handle:
                    handle.write(f"photo-{index}".encode())

            cancel_after = {"count": 0}

            def cancel_check():
                cancel_after["count"] += 1
                return cancel_after["count"] >= 2

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
                with self.assertRaises(FastAuditCancelled):
                    run_fast_library_audit(
                        tmpdir,
                        db_path=db_path,
                        cancel_check=cancel_check,
                    )


if __name__ == "__main__":
    unittest.main()
