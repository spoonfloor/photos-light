import hashlib
import os
import sqlite3
import unittest
from datetime import datetime
from tempfile import TemporaryDirectory
from unittest.mock import patch

from db_schema import create_database_schema
from hash_cache import HashCache
from library_layout import canonical_db_path, detect_existing_db_path, is_library_metadata_file
from library_cleanliness import (
    ALL_MEDIA_EXTENSIONS,
    EXIF_WRITABLE_PHOTO_EXTENSIONS,
    IGNORED_LIBRARY_FILES,
    PHOTO_MEDIA_EXTENSIONS,
    VIDEO_MEDIA_EXTENSIONS,
    build_canonical_photo_path,
    canonical_relative_path,
    in_infrastructure,
    is_day_folder_name,
    is_year_folder_name,
    is_supported_media_extension,
    media_kind_for_extension,
    parse_metadata_datetime,
    root_entry_allowed,
)
from make_library_perfect import (
    DBNormalizationEngine,
    LibraryCleaner,
    run_db_normalization_engine,
    scan_library_cleanliness,
    summarize_clean_library_issues,
)
from photo_canonicalization import UNKNOWN_PHOTO_DATE_TAKEN, canonicalize_photo_date


class MakeLibraryPerfectHelpersTest(unittest.TestCase):
    def test_parse_metadata_datetime_normalizes_exif_string(self):
        normalized, parsed = parse_metadata_datetime("2026:04:12 09:30:15", 0)
        self.assertEqual(normalized, "2026:04:12 09:30:15")
        self.assertEqual(parsed, datetime(2026, 4, 12, 9, 30, 15))

    def test_parse_metadata_datetime_falls_back_to_timestamp(self):
        normalized, parsed = parse_metadata_datetime(None, 0)
        expected = datetime.fromtimestamp(0)
        self.assertEqual(normalized, expected.strftime("%Y:%m:%d %H:%M:%S"))
        self.assertEqual(parsed, expected)

    def test_canonicalize_photo_date_uses_deterministic_unknown_date(self):
        normalized, parsed = canonicalize_photo_date(None)
        self.assertEqual(normalized, UNKNOWN_PHOTO_DATE_TAKEN)
        self.assertEqual(parsed, datetime(1900, 1, 1, 0, 0, 0))

    def test_canonical_relative_path_uses_expected_layout(self):
        rel_path = canonical_relative_path(
            datetime(2026, 4, 12, 9, 30, 15),
            "abc1234def567890fedcba0987654321abc1234def567890fedcba0987654321",
            ".JPG",
        )
        self.assertEqual(rel_path, "2026/2026-04-12/img_20260412_abc1234d.jpg")

    def test_build_canonical_photo_path_uses_same_shared_rule(self):
        rel_path, filename = build_canonical_photo_path(
            "2026:04:12 09:30:15",
            "abc1234def567890fedcba0987654321abc1234def567890fedcba0987654321",
            ".JPG",
        )
        self.assertEqual(rel_path, "2026/2026-04-12/img_20260412_abc1234d.jpg")
        self.assertEqual(filename, "img_20260412_abc1234d.jpg")

    def test_year_and_day_folder_validation(self):
        self.assertTrue(is_year_folder_name("2026"))
        self.assertFalse(is_year_folder_name("26"))
        self.assertTrue(is_day_folder_name("2026", "2026-04-12"))
        self.assertFalse(is_day_folder_name("2026", "2026-13-99"))
        self.assertFalse(is_day_folder_name("2026", "misc"))

    def test_root_entry_allowlist(self):
        self.assertTrue(root_entry_allowed(".library", True))
        self.assertTrue(root_entry_allowed(".trash", True))
        self.assertTrue(root_entry_allowed(".import_temp", True))
        self.assertTrue(root_entry_allowed("2026", True))
        self.assertIn(".DS_Store", IGNORED_LIBRARY_FILES)
        self.assertTrue(root_entry_allowed(".DS_Store", False))
        self.assertFalse(root_entry_allowed("photo_library.db", False))
        self.assertFalse(root_entry_allowed("notes.txt", False))
        self.assertFalse(root_entry_allowed(".hidden", True))

    def test_infrastructure_detection(self):
        self.assertTrue(in_infrastructure(".trash/duplicates/file.jpg"))
        self.assertTrue(in_infrastructure(".logs/run.jsonl"))
        self.assertTrue(in_infrastructure(".library/photo_library.db"))
        self.assertTrue(in_infrastructure(".import_temp/staged.jpg"))
        self.assertFalse(in_infrastructure("2026/2026-04-12/img_20260412_abc1234.jpg"))

    def test_shared_media_extension_policy_classifies_types_and_subsets(self):
        self.assertEqual(media_kind_for_extension(".JPG"), "photo")
        self.assertEqual(media_kind_for_extension(".webm"), "video")
        self.assertIsNone(media_kind_for_extension(".bmp"))
        self.assertTrue(is_supported_media_extension(".CR2"))
        self.assertFalse(is_supported_media_extension(".txt"))
        self.assertIn(".jpg", PHOTO_MEDIA_EXTENSIONS)
        self.assertIn(".mov", VIDEO_MEDIA_EXTENSIONS)
        self.assertTrue(EXIF_WRITABLE_PHOTO_EXTENSIONS.issubset(PHOTO_MEDIA_EXTENSIONS))
        self.assertEqual(ALL_MEDIA_EXTENSIONS, PHOTO_MEDIA_EXTENSIONS | VIDEO_MEDIA_EXTENSIONS)

    def test_library_metadata_detection_prefers_hidden_db(self):
        with TemporaryDirectory() as tmpdir:
            hidden_db = canonical_db_path(tmpdir)
            os.makedirs(os.path.dirname(hidden_db), exist_ok=True)
            with open(hidden_db, "w", encoding="utf-8"):
                pass

            self.assertEqual(detect_existing_db_path(tmpdir), hidden_db)

    def test_library_metadata_allowlist(self):
        self.assertTrue(is_library_metadata_file("photo_library.db"))
        self.assertTrue(is_library_metadata_file("photo_library.db-wal"))
        self.assertTrue(is_library_metadata_file("photo_library.db-shm"))
        self.assertFalse(is_library_metadata_file("notes.txt"))

    def test_db_normalization_engine_alias_exists(self):
        self.assertTrue(issubclass(DBNormalizationEngine, LibraryCleaner))

    def test_clean_library_issue_summary_groups_issue_kinds(self):
        payload = summarize_clean_library_issues(
            [
                {"kind": "misnamed_or_misfiled", "path": "a.jpg", "detail": "expected 2026/x.jpg"},
                {"kind": "duplicate_media", "path": "dup.png", "detail": "same hash as keep.png"},
                {"kind": "unsupported_or_nonmedia", "path": "note.txt", "detail": ""},
                {"kind": "ghost_db_reference", "path": "ghost.png", "detail": ""},
                {"kind": "unbaked_rotation", "path": "rot.jpg", "detail": "8"},
                {"kind": "noncanonical_folder", "path": "misc", "detail": ""},
            ]
        )

        self.assertEqual(
            payload["summary"],
            {
                "misfiled_media": 2,
                "duplicates": 1,
                "unsupported_files": 1,
                "database_repairs": 1,
                "metadata_cleanup": 1,
                "issue_count": 6,
            },
        )
        self.assertEqual(
            payload["details"]["misfiled_media"],
            [
                {
                    "kind": "misnamed_or_misfiled",
                    "path": "a.jpg",
                    "message": "a.jpg should be filed as 2026/x.jpg",
                },
                {
                    "kind": "noncanonical_folder",
                    "path": "misc",
                    "message": "misc is a noncanonical YYYY/YYYY-MM-DD folder",
                },
            ],
        )
        self.assertEqual(
            payload["details"]["duplicates"],
            [
                {
                    "kind": "duplicate_media",
                    "path": "dup.png",
                    "message": "dup.png duplicates keep.png",
                }
            ],
        )
        self.assertEqual(
            payload["details"]["unsupported_files"],
            [
                {
                    "kind": "unsupported_or_nonmedia",
                    "path": "note.txt",
                    "message": "note.txt is not a supported media file",
                }
            ],
        )

    def test_clean_library_issue_summary_prioritizes_duplicates_over_misfiled_and_db_repairs(self):
        payload = summarize_clean_library_issues(
            [
                {"kind": "noncanonical_root_file", "path": "foo.jpg", "detail": ""},
                {"kind": "misnamed_or_misfiled", "path": "foo.jpg", "detail": "expected 1900/1900-01-01/foo.jpg"},
                {"kind": "duplicate_media", "path": "foo.jpg", "detail": "same hash as 1900/1900-01-01/foo.jpg"},
                {"kind": "mole_missing_from_db", "path": "foo.jpg", "detail": ""},
            ]
        )

        self.assertEqual(
            payload["summary"],
            {
                "misfiled_media": 0,
                "duplicates": 1,
                "unsupported_files": 0,
                "database_repairs": 0,
                "metadata_cleanup": 0,
                "issue_count": 1,
            },
        )
        self.assertEqual(
            payload["details"]["duplicates"],
            [
                {
                    "kind": "duplicate_media",
                    "path": "foo.jpg",
                    "message": "foo.jpg duplicates 1900/1900-01-01/foo.jpg",
                }
            ],
        )


class CleanerFullHashRegressionTest(unittest.TestCase):
    def _create_library_db(self, library_path):
        db_path = canonical_db_path(library_path)
        os.makedirs(os.path.dirname(db_path), exist_ok=True)
        conn = sqlite3.connect(db_path)
        conn.row_factory = sqlite3.Row
        create_database_schema(conn.cursor())
        conn.commit()
        return db_path, conn

    def test_hash_cache_returns_full_sha256_values(self):
        with TemporaryDirectory() as tmpdir:
            db_path, conn = self._create_library_db(tmpdir)
            file_path = os.path.join(tmpdir, "sample.bin")
            payload = b"clean-library-full-hash"
            with open(file_path, "wb") as handle:
                handle.write(payload)

            cache = HashCache(conn)
            expected_hash = hashlib.sha256(payload).hexdigest()

            computed_hash, cache_hit = cache.get_hash(file_path)
            cached_hash, cached_hit = cache.get_hash(file_path)

            self.assertEqual(computed_hash, expected_hash)
            self.assertEqual(cached_hash, expected_hash)
            self.assertEqual(len(computed_hash), 64)
            self.assertFalse(cache_hit)
            self.assertTrue(cached_hit)
            conn.close()
            self.assertTrue(os.path.exists(db_path))

    def test_scan_flags_truncated_db_hash_against_full_disk_hash(self):
        with TemporaryDirectory() as tmpdir:
            db_path, conn = self._create_library_db(tmpdir)
            payload = b"scan-full-hash-regression"
            content_hash = hashlib.sha256(payload).hexdigest()
            date_taken = "2026:01:27 12:00:00"
            rel_path = canonical_relative_path(datetime(2026, 1, 27, 12, 0, 0), content_hash, ".png")
            full_path = os.path.join(tmpdir, rel_path)
            os.makedirs(os.path.dirname(full_path), exist_ok=True)
            with open(full_path, "wb") as handle:
                handle.write(payload)

            conn.execute(
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
                    "source.png",
                    rel_path,
                    date_taken,
                    content_hash[:7],
                    len(payload),
                    "photo",
                    1,
                    1,
                ),
            )
            conn.commit()
            conn.close()

            with patch("make_library_perfect.verify_media_file", return_value=(True, "mock")), patch(
                "make_library_perfect.extract_exif_date", return_value=date_taken
            ), patch("make_library_perfect.extract_exif_rating", return_value=None), patch(
                "make_library_perfect.get_orientation_flag", return_value=1
            ), patch("make_library_perfect.read_dimensions", return_value=(1, 1)):
                result = scan_library_cleanliness(tmpdir, db_path=db_path)

            self.assertEqual(result["status"], "DIRTY")
            self.assertEqual(result["summary"]["database_repairs"], 1)
            self.assertEqual(
                result["details"]["database_repairs"],
                [
                    {
                        "kind": "db_hash_mismatch",
                        "path": rel_path,
                        "message": f"{rel_path} hash mismatch (db={content_hash[:7]} disk={content_hash})",
                    }
                ],
            )

    def test_scan_flags_duplicates_by_canonicalized_photo_identity(self):
        with TemporaryDirectory() as tmpdir:
            db_path, conn = self._create_library_db(tmpdir)
            canonical_hash = "cafe" * 16
            canonical_date = "1900:01:01 00:00:00"
            canonical_obj = datetime(1900, 1, 1, 0, 0, 0)
            canonical_rel = canonical_relative_path(canonical_obj, canonical_hash, ".jpg")
            canonical_full = os.path.join(tmpdir, canonical_rel)
            stray_duplicate = os.path.join(tmpdir, "root_b.jpg")

            os.makedirs(os.path.dirname(canonical_full), exist_ok=True)
            with open(canonical_full, "wb") as handle:
                handle.write(b"photo-a")
            with open(stray_duplicate, "wb") as handle:
                handle.write(b"photo-b")

            conn.execute(
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
                    os.path.basename(canonical_full),
                    canonical_rel,
                    canonical_date,
                    canonical_hash,
                    os.path.getsize(canonical_full),
                    "photo",
                    1,
                    1,
                ),
            )
            conn.commit()
            conn.close()

            def canonicalize_side_effect(file_path, **_kwargs):
                basename = os.path.basename(file_path)
                if basename in {os.path.basename(canonical_full), os.path.basename(stray_duplicate)}:
                    return type(
                        "CanonicalPhoto",
                        (),
                        {
                            "content_hash": canonical_hash,
                            "date_taken": canonical_date,
                            "date_obj": canonical_obj,
                        },
                    )()
                raise AssertionError(f"Unexpected staged file: {basename}")

            with patch("make_library_perfect.verify_media_file", return_value=(True, "mock")), patch(
                "make_library_perfect.extract_exif_rating", return_value=None
            ), patch("make_library_perfect.get_orientation_flag", return_value=1), patch(
                "make_library_perfect.can_bake_losslessly", return_value=False
            ), patch(
                "make_library_perfect.extract_exif_date", return_value=None
            ), patch(
                "make_library_perfect.canonicalize_photo_file",
                side_effect=canonicalize_side_effect,
            ):
                result = scan_library_cleanliness(tmpdir, db_path=db_path)

            self.assertEqual(result["status"], "DIRTY")
            self.assertEqual(result["summary"]["duplicates"], 1)
            self.assertEqual(result["summary"]["misfiled_media"], 0)
            self.assertEqual(result["summary"]["database_repairs"], 0)
            self.assertEqual(
                result["details"]["duplicates"],
                [
                    {
                        "kind": "duplicate_media",
                        "path": "root_b.jpg",
                        "message": f"root_b.jpg duplicates {canonical_rel}",
                    }
                ],
            )

    def test_engine_rebuilds_db_from_disk_with_full_hashes(self):
        with TemporaryDirectory() as tmpdir:
            db_path, conn = self._create_library_db(tmpdir)
            date_taken = "2026:01:27 12:00:00"

            dup_payload = b"duplicate-image-bytes"
            unique_payload = b"unique-image-bytes"

            keep_path = os.path.join(tmpdir, "02_dupes", "keep.png")
            lose_path = os.path.join(tmpdir, "02_dupes", "lose.png")
            mole_path = os.path.join(tmpdir, "04_moles", "mole.png")
            fake_path = os.path.join(tmpdir, "03_fake-png.png")

            for path, payload in (
                (keep_path, dup_payload),
                (lose_path, dup_payload),
                (mole_path, unique_payload),
            ):
                os.makedirs(os.path.dirname(path), exist_ok=True)
                with open(path, "wb") as handle:
                    handle.write(payload)

            with open(fake_path, "w", encoding="utf-8") as handle:
                handle.write("not really a png")

            conn.execute(
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
                    "ghost.png",
                    "2026/2026-01-27/img_20260127_deadbeef.png",
                    date_taken,
                    "deadbeef" * 8,
                    999,
                    "photo",
                    1,
                    1,
                ),
            )
            conn.commit()
            conn.close()

            def verify_media_side_effect(file_path):
                if os.path.basename(file_path) == "03_fake-png.png":
                    return False, "validation failed"
                return True, "mock"

            with patch("make_library_perfect.verify_media_file", side_effect=verify_media_side_effect), patch(
                "make_library_perfect.extract_exif_date", return_value=date_taken
            ), patch("make_library_perfect.extract_exif_rating", return_value=None), patch(
                "make_library_perfect.get_orientation_flag", return_value=1
            ), patch("make_library_perfect.read_dimensions", return_value=(1, 1)):
                result = run_db_normalization_engine(tmpdir, db_path=db_path)

            self.assertEqual(result["status"], "SUCCESS")
            self.assertEqual(result["stats"]["duplicates_trashed"], 1)
            self.assertEqual(result["stats"]["moved_to_trash"], 2)

            trash_duplicate = os.path.join(tmpdir, ".trash", "duplicates", "02_dupes", "lose.png")
            trash_corrupted = os.path.join(tmpdir, ".trash", "corrupted", "03_fake-png.png")
            self.assertTrue(os.path.exists(trash_duplicate))
            self.assertTrue(os.path.exists(trash_corrupted))

            conn = sqlite3.connect(db_path)
            conn.row_factory = sqlite3.Row
            rows = conn.execute(
                "SELECT current_path, content_hash FROM photos ORDER BY current_path"
            ).fetchall()
            conn.close()

            self.assertEqual(len(rows), 2)

            surviving_hashes = {
                hashlib.sha256(dup_payload).hexdigest(),
                hashlib.sha256(unique_payload).hexdigest(),
            }
            surviving_paths = set()
            for row in rows:
                self.assertEqual(len(row["content_hash"]), 64)
                self.assertIn(row["content_hash"], surviving_hashes)
                full_path = os.path.join(tmpdir, row["current_path"])
                self.assertTrue(os.path.exists(full_path))
                surviving_paths.add(row["current_path"])
                self.assertEqual(
                    row["current_path"],
                    canonical_relative_path(datetime(2026, 1, 27, 12, 0, 0), row["content_hash"], ".png"),
                )

            self.assertNotIn("2026/2026-01-27/img_20260127_deadbeef.png", surviving_paths)

    def test_engine_does_not_count_metadata_cleanup_for_duplicate_file_that_gets_trashed(self):
        with TemporaryDirectory() as tmpdir:
            db_path, conn = self._create_library_db(tmpdir)
            conn.close()

            canonical_hash = "bead" * 16
            canonical_date = "1900:01:01 00:00:00"
            canonical_obj = datetime(1900, 1, 1, 0, 0, 0)
            canonical_rel = canonical_relative_path(canonical_obj, canonical_hash, ".jpg")
            canonical_full = os.path.join(tmpdir, canonical_rel)
            duplicate_full = os.path.join(tmpdir, "loose_mickey.jpg")

            os.makedirs(os.path.dirname(canonical_full), exist_ok=True)
            with open(canonical_full, "wb") as handle:
                handle.write(b"keep")
            with open(duplicate_full, "wb") as handle:
                handle.write(b"duplicate")

            def canonicalize_side_effect(file_path, **_kwargs):
                basename = os.path.basename(file_path)
                if basename == os.path.basename(canonical_full):
                    return type(
                        "CanonicalPhoto",
                        (),
                        {
                            "content_hash": canonical_hash,
                            "date_taken": canonical_date,
                            "date_obj": canonical_obj,
                            "width": 1,
                            "height": 1,
                            "rating": None,
                            "metadata_changed": False,
                            "orientation_baked": False,
                            "rating_stripped": False,
                        },
                    )()
                if basename == os.path.basename(duplicate_full):
                    return type(
                        "CanonicalPhoto",
                        (),
                        {
                            "content_hash": canonical_hash,
                            "date_taken": canonical_date,
                            "date_obj": canonical_obj,
                            "width": 1,
                            "height": 1,
                            "rating": None,
                            "metadata_changed": True,
                            "orientation_baked": False,
                            "rating_stripped": False,
                        },
                    )()
                raise AssertionError(f"Unexpected file {basename}")

            with patch("make_library_perfect.verify_media_file", return_value=(True, "mock")), patch(
                "make_library_perfect.extract_exif_date", return_value=None
            ), patch("make_library_perfect.extract_exif_rating", return_value=None), patch(
                "make_library_perfect.get_orientation_flag", return_value=1
            ), patch("make_library_perfect.read_dimensions", return_value=(1, 1)), patch(
                "make_library_perfect.canonicalize_photo_file", side_effect=canonicalize_side_effect
            ):
                result = run_db_normalization_engine(tmpdir, db_path=db_path)

            self.assertEqual(result["status"], "SUCCESS")
            self.assertEqual(result["stats"]["duplicates_trashed"], 1)
            self.assertEqual(result["stats"]["metadata_fixed"], 0)

    def test_engine_removes_noncanonical_folder_left_with_only_ds_store(self):
        with TemporaryDirectory() as tmpdir:
            db_path, conn = self._create_library_db(tmpdir)
            conn.close()

            date_taken = "2026:01:27 12:00:00"
            payload = b"folder-cleanup-regression"
            source_dir = os.path.join(tmpdir, "00_clean-files")
            source_path = os.path.join(source_dir, "source.png")
            os.makedirs(source_dir, exist_ok=True)

            with open(source_path, "wb") as handle:
                handle.write(payload)
            with open(os.path.join(source_dir, ".DS_Store"), "wb") as handle:
                handle.write(b"finder-noise")

            with patch("make_library_perfect.verify_media_file", return_value=(True, "mock")), patch(
                "make_library_perfect.extract_exif_date", return_value=date_taken
            ), patch("make_library_perfect.extract_exif_rating", return_value=None), patch(
                "make_library_perfect.get_orientation_flag", return_value=1
            ), patch("make_library_perfect.read_dimensions", return_value=(1, 1)):
                result = run_db_normalization_engine(tmpdir, db_path=db_path)

            self.assertEqual(result["status"], "SUCCESS")
            self.assertFalse(os.path.exists(source_dir))

            conn = sqlite3.connect(db_path)
            conn.row_factory = sqlite3.Row
            rows = conn.execute("SELECT current_path, content_hash FROM photos").fetchall()
            conn.close()

            self.assertEqual(len(rows), 1)
            self.assertEqual(len(rows[0]["content_hash"]), 64)
            self.assertTrue(os.path.exists(os.path.join(tmpdir, rows[0]["current_path"])))


if __name__ == "__main__":
    unittest.main()
