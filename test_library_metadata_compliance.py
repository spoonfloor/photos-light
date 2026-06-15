import os
import sqlite3
import unittest
from tempfile import TemporaryDirectory
from unittest.mock import patch

from clean_library_fast_audit import run_fast_library_audit
from db_schema import create_database_schema
from library_layout import canonical_db_path
from library_metadata_compliance import (
    METADATA_COMPLIANCE_SPEC,
    ensure_library_metadata_compliant,
)
from normalization_repair import (
    RepairScanDependencies,
    file_needs_metadata_compliance,
    repair_file_metadata_compliance,
)


class _HashCache:
    def __init__(self, content_hash="abc12345" + ("0" * 56)):
        self.content_hash = content_hash

    def get_hash(self, _path):
        return self.content_hash, False


class MetadataComplianceSpecTest(unittest.TestCase):
    def test_auto_fix_kinds_match_audit_metadata_kinds(self):
        self.assertEqual(
            set(METADATA_COMPLIANCE_SPEC["auto_fix_kinds"]),
            set(METADATA_COMPLIANCE_SPEC["audit_metadata_kinds"]),
        )
        self.assertIn("rating_zero", METADATA_COMPLIANCE_SPEC["auto_fix_kinds"])
        self.assertIn("unbaked_rotation", METADATA_COMPLIANCE_SPEC["auto_fix_kinds"])
        self.assertIn("corrupted_media", METADATA_COMPLIANCE_SPEC["blocking_kinds"])
        self.assertIn("db_hash_mismatch", METADATA_COMPLIANCE_SPEC["blocking_kinds"])


class RepairFileMetadataComplianceTest(unittest.TestCase):
    def _scan_deps(self, **overrides):
        values = {
            "hash_cache": _HashCache(),
            "extract_exif_date": lambda _path: "2026:04:12 09:30:15",
            "extract_exif_rating": lambda _path: 0,
            "strip_exif_rating": lambda _path: True,
            "get_orientation_flag": lambda _path: 1,
            "can_bake_losslessly": lambda _path: False,
            "bake_orientation": lambda _path: (False, "No orientation", None),
            "canonicalize_photo_file": lambda *_args, **_kwargs: type(
                "CanonicalPhoto",
                (),
                {
                    "content_hash": "abc12345" + ("0" * 56),
                    "file_size": 5,
                    "metadata_changed": True,
                    "orientation_baked": False,
                    "rating_stripped": True,
                },
            )(),
            "write_photo_date_metadata": lambda _path, _date: None,
            "read_dimensions": lambda _path: (640, 480),
            "lossless_rotation_extensions": frozenset({".jpg", ".jpeg", ".png"}),
        }
        values.update(overrides)
        return RepairScanDependencies(**values)

    def test_file_needs_metadata_compliance_detects_rating_zero(self):
        with TemporaryDirectory() as tmpdir:
            full_path = os.path.join(tmpdir, "photo.jpg")
            with open(full_path, "wb") as handle:
                handle.write(b"photo")

            self.assertTrue(
                file_needs_metadata_compliance(
                    full_path,
                    ".jpg",
                    get_orientation_flag=lambda _path: 1,
                    can_bake_losslessly=lambda _path: False,
                    extract_exif_rating=lambda _path: 0,
                    lossless_rotation_extensions=frozenset({".jpg"}),
                )
            )

    def test_repair_file_metadata_compliance_strips_rating_for_photos(self):
        with TemporaryDirectory() as tmpdir:
            full_path = os.path.join(tmpdir, "photo.jpg")
            with open(full_path, "wb") as handle:
                handle.write(b"photo")

            result = repair_file_metadata_compliance(
                full_path,
                ext=".jpg",
                deps=self._scan_deps(),
            )

            self.assertTrue(result.fixed)
            self.assertEqual([event.action for event in result.log_events], ["rating_stripped"])

    def test_repair_file_metadata_compliance_noop_when_clean(self):
        with TemporaryDirectory() as tmpdir:
            full_path = os.path.join(tmpdir, "photo.jpg")
            with open(full_path, "wb") as handle:
                handle.write(b"photo")

            result = repair_file_metadata_compliance(
                full_path,
                ext=".jpg",
                deps=self._scan_deps(extract_exif_rating=lambda _path: None),
            )

            self.assertFalse(result.fixed)
            self.assertEqual(result.log_events, [])


class EnsureLibraryMetadataComplianceTest(unittest.TestCase):
    def _create_library_db(self, library_path: str):
        db_path = canonical_db_path(library_path)
        os.makedirs(os.path.dirname(db_path), exist_ok=True)
        conn = sqlite3.connect(db_path)
        conn.row_factory = sqlite3.Row
        create_database_schema(conn.cursor())
        conn.commit()
        return db_path, conn

    def test_compliance_pass_then_audit_returns_no_metadata_issues(self):
        with TemporaryDirectory() as tmpdir:
            rel_path = os.path.join("2026", "2026-04-12", "img_20260412_abc12345.jpg")
            full_path = os.path.join(tmpdir, rel_path)
            os.makedirs(os.path.dirname(full_path), exist_ok=True)
            with open(full_path, "wb") as handle:
                handle.write(b"photo-bytes")

            db_path, conn = self._create_library_db(tmpdir)
            conn.execute(
                """
                INSERT INTO photos (
                    original_filename, current_path, date_taken, content_hash,
                    file_size, file_type, width, height
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    "img_20260412_abc12345.jpg",
                    rel_path,
                    "2026:04:12 09:30:15",
                    "abc12345" + ("0" * 56),
                    len(b"photo-bytes"),
                    "photo",
                    640,
                    480,
                ),
            )
            conn.commit()
            conn.close()

            rating_reads = {"count": 0}

            def _rating_side_effect(_path):
                rating_reads["count"] += 1
                return 0 if rating_reads["count"] == 1 else None

            with patch(
                "library_metadata_compliance.extract_exif_rating",
                side_effect=_rating_side_effect,
            ), patch(
                "library_metadata_compliance.strip_exif_rating",
                return_value=True,
            ), patch(
                "library_metadata_compliance.verify_media_file",
                return_value=(True, "mock"),
            ), patch(
                "library_metadata_compliance.canonicalize_photo_file",
                return_value=type(
                    "CanonicalPhoto",
                    (),
                    {
                        "content_hash": "abc12345" + ("0" * 56),
                        "file_size": len(b"photo-bytes"),
                        "metadata_changed": True,
                        "orientation_baked": False,
                        "rating_stripped": True,
                    },
                )(),
            ), patch(
                "clean_library_fast_audit.verify_media_file",
                return_value=(True, "mock"),
            ), patch(
                "clean_library_fast_audit.compute_hash_legacy",
                return_value=("abc12345" + ("0" * 56), False),
            ), patch(
                "clean_library_fast_audit.extract_exif_rating",
                return_value=None,
            ), patch(
                "clean_library_fast_audit.get_orientation_flag",
                return_value=1,
            ):
                stats = ensure_library_metadata_compliant(tmpdir, db_path=db_path)
                issues = run_fast_library_audit(tmpdir, db_path=db_path)

            self.assertEqual(stats.files_fixed, 1)
            self.assertEqual(stats.rating_stripped, 1)
            metadata_kinds = {
                issue["kind"]
                for issue in issues
                if issue["kind"] in METADATA_COMPLIANCE_SPEC["audit_metadata_kinds"]
            }
            self.assertEqual(metadata_kinds, set())


if __name__ == "__main__":
    unittest.main()
