"""Contract tests: duplicate identity is star-blind (logical rating strip)."""

from __future__ import annotations

import hashlib
import os
import shutil
import sqlite3
import unittest
from datetime import datetime
from tempfile import TemporaryDirectory
from unittest.mock import MagicMock

from PIL import Image

from file_operations import extract_exif_rating, write_exif_rating
from hash_cache import compute_hash_legacy
from make_library_clean_v2 import LibraryCleaner, MediaRecord
from media_dates import UNKNOWN_PHOTO_DATE_TAKEN
from media_finalization import finalize_mutated_media
from normalization_contract import compute_content_hash, compute_duplicate_key
from normalization_core import (
    NormalizationCoreDependencies,
    duplicate_row_for_hash,
    normalize_ingest_photo,
)
from normalization_repair import plan_repair_duplicate_decisions


def _sha256_file(path: str) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        digest.update(handle.read())
    return digest.hexdigest()


def _write_jpeg(path: str, color=(12, 34, 56)) -> None:
    Image.new("RGB", (16, 16), color=color).save(path, "JPEG", quality=95)


class StarBlindDuplicateKeyContractTest(unittest.TestCase):
    def test_starred_and_unstarred_share_duplicate_key_without_disk_mutation(self):
        with TemporaryDirectory() as tmpdir:
            plain = os.path.join(tmpdir, "plain.jpg")
            starred = os.path.join(tmpdir, "starred.jpg")
            _write_jpeg(plain)
            shutil.copy2(plain, starred)
            self.assertTrue(write_exif_rating(starred, 5))

            plain_mtime = os.stat(plain).st_mtime_ns
            starred_mtime_before = os.stat(starred).st_mtime_ns
            plain_hash = compute_content_hash(plain)
            starred_raw = compute_content_hash(starred)

            self.assertNotEqual(plain_hash, starred_raw)
            self.assertEqual(compute_duplicate_key(plain), plain_hash)
            self.assertEqual(compute_duplicate_key(starred), plain_hash)
            self.assertEqual(
                compute_duplicate_key(starred, fallback_hash=starred_raw),
                plain_hash,
            )

            # Logical strip must not mutate either file on disk.
            self.assertEqual(os.stat(plain).st_mtime_ns, plain_mtime)
            self.assertEqual(os.stat(starred).st_mtime_ns, starred_mtime_before)
            self.assertEqual(extract_exif_rating(starred), 5)
            self.assertIsNone(extract_exif_rating(plain))
            self.assertEqual(_sha256_file(starred), starred_raw)

    def test_rating_zero_also_collapses_to_unrated_duplicate_key(self):
        with TemporaryDirectory() as tmpdir:
            plain = os.path.join(tmpdir, "plain.jpg")
            rated_zero = os.path.join(tmpdir, "zero.jpg")
            _write_jpeg(plain)
            shutil.copy2(plain, rated_zero)
            self.assertTrue(write_exif_rating(rated_zero, 0))

            plain_hash = compute_content_hash(plain)
            self.assertEqual(compute_duplicate_key(rated_zero), plain_hash)

    def test_clean_trash_duplicates_collapses_starred_unstarred_pair(self):
        with TemporaryDirectory() as tmpdir:
            keep_path = os.path.join(tmpdir, "keep.jpg")
            lose_path = os.path.join(tmpdir, "lose.jpg")
            _write_jpeg(keep_path)
            shutil.copy2(keep_path, lose_path)
            self.assertTrue(write_exif_rating(lose_path, 5))

            shared_key = compute_duplicate_key(keep_path)
            self.assertEqual(compute_duplicate_key(lose_path), shared_key)
            self.assertNotEqual(compute_content_hash(keep_path), compute_content_hash(lose_path))

            cleaner = LibraryCleaner(tmpdir)
            cleaner.log = lambda *args, **kwargs: None
            trashed = []
            cleaner.move_to_trash = (
                lambda path, category: trashed.append((os.path.basename(path), category)) or path
            )

            records = [
                MediaRecord(
                    original_filename="keep.jpg",
                    source_rel_path="2026/2026-01-27/keep.jpg",
                    full_path=keep_path,
                    rel_path="2026/2026-01-27/keep.jpg",
                    ext=".jpg",
                    file_type="photo",
                    content_hash=compute_content_hash(keep_path),
                    duplicate_key=shared_key,
                    date_taken="2026:01:27 17:22:43",
                    date_obj=datetime(2026, 1, 27, 17, 22, 43),
                    width=16,
                    height=16,
                    rating=None,
                    metadata_cleaned=False,
                    has_metadata_cleanup_signal=False,
                    birth_time=2.0,
                    modified_time=2.0,
                ),
                MediaRecord(
                    original_filename="lose.jpg",
                    source_rel_path="1900/1900-01-01/lose.jpg",
                    full_path=lose_path,
                    rel_path="1900/1900-01-01/lose.jpg",
                    ext=".jpg",
                    file_type="photo",
                    content_hash=compute_content_hash(lose_path),
                    duplicate_key=shared_key,
                    date_taken=UNKNOWN_PHOTO_DATE_TAKEN,
                    date_obj=datetime(1900, 1, 1, 0, 0, 0),
                    width=16,
                    height=16,
                    rating=5,
                    metadata_cleaned=False,
                    has_metadata_cleanup_signal=False,
                    birth_time=1.0,
                    modified_time=1.0,
                ),
            ]

            survivors = cleaner.trash_duplicates(records)
            self.assertEqual([record.original_filename for record in survivors], ["keep.jpg"])
            self.assertEqual(trashed, [("lose.jpg", "duplicates")])
            # Winner/loser files untouched by star-blind key computation in this phase.
            self.assertTrue(os.path.exists(keep_path))
            self.assertEqual(extract_exif_rating(lose_path), 5)

    def test_plan_repair_duplicate_decisions_groups_by_star_blind_key(self):
        with TemporaryDirectory() as tmpdir:
            a = os.path.join(tmpdir, "a.jpg")
            b = os.path.join(tmpdir, "b.jpg")
            _write_jpeg(a)
            shutil.copy2(a, b)
            self.assertTrue(write_exif_rating(b, 5))
            shared_key = compute_duplicate_key(a)

            class _Rec:
                def __init__(self, path, name, rating):
                    self.full_path = path
                    self.duplicate_key = shared_key
                    self.original_filename = name
                    self.rating = rating

            decisions = plan_repair_duplicate_decisions(
                [_Rec(a, "a.jpg", None), _Rec(b, "b.jpg", 5)],
                sort_key=lambda rec: rec.original_filename,
            )
            self.assertEqual(len(decisions), 1)
            self.assertEqual(decisions[0].duplicate_key, shared_key)
            self.assertEqual(decisions[0].winner.original_filename, "a.jpg")
            self.assertEqual(
                [loser.original_filename for loser in decisions[0].losers],
                ["b.jpg"],
            )


class StarBlindIngestFinalizeContractTest(unittest.TestCase):
    def _make_conn(self):
        conn = sqlite3.connect(":memory:")
        conn.row_factory = sqlite3.Row
        conn.execute(
            """
            CREATE TABLE photos (
                id INTEGER PRIMARY KEY,
                original_filename TEXT,
                current_path TEXT,
                date_taken TEXT,
                content_hash TEXT NOT NULL UNIQUE,
                file_size INTEGER,
                file_type TEXT,
                width INTEGER,
                height INTEGER,
                rating INTEGER
            )
            """
        )
        return conn

    def test_ingest_skips_rated_file_when_unrated_twin_exists(self):
        with TemporaryDirectory() as tmpdir:
            library = os.path.join(tmpdir, "library")
            os.makedirs(library)

            plain = os.path.join(tmpdir, "plain.jpg")
            starred = os.path.join(tmpdir, "starred.jpg")
            _write_jpeg(plain)
            shutil.copy2(plain, starred)
            self.assertTrue(write_exif_rating(starred, 5))

            plain_hash = compute_hash_legacy(plain)
            conn = self._make_conn()
            conn.execute(
                """
                INSERT INTO photos (
                    original_filename, current_path, date_taken, content_hash,
                    file_size, file_type, width, height, rating
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    "plain.jpg",
                    "2026/2026-01-01/img_20260101_plain.jpg",
                    "2026:01:01 00:00:00",
                    plain_hash,
                    os.path.getsize(plain),
                    "photo",
                    16,
                    16,
                    None,
                ),
            )
            conn.commit()

            class _Staged:
                def __init__(self, staged_path, content_hash):
                    self.staged_path = staged_path
                    self.canonical_photo = MagicMock(
                        content_hash=content_hash,
                        relative_path="2026/2026-01-01/img_20260101_rated.jpg",
                    )

            staged_copy = os.path.join(tmpdir, "staged_starred.jpg")
            shutil.copy2(starred, staged_copy)

            deps = NormalizationCoreDependencies(
                library_path=library,
                hash_cache=MagicMock(),
                stage_photo_for_canonicalization=lambda _src, temp_prefix="": _Staged(
                    staged_copy, compute_hash_legacy(staged_copy)
                ),
                cleanup_staged_file=lambda path: os.path.exists(path) and os.remove(path),
                commit_staged_canonical_photo=lambda *_args, **_kwargs: (_ for _ in ()).throw(
                    AssertionError("must not commit duplicate")
                ),
                categorize_processing_error=lambda error: ("error", str(error)),
                extract_exif_date=lambda _path: "2026:01:01 00:00:00",
                write_video_metadata=lambda *_args, **_kwargs: None,
                finalize_mutated_media=lambda **_kwargs: None,
                compute_hash=compute_hash_legacy,
                get_dimensions=lambda _path: (16, 16),
                delete_thumbnail_for_hash=lambda _hash: None,
            )

            result = normalize_ingest_photo(
                conn, starred, filename="starred.jpg", deps=deps
            )
            self.assertEqual(result.status, "duplicate")
            self.assertTrue(duplicate_row_for_hash(conn, plain_hash))
            self.assertEqual(extract_exif_rating(starred), 5)

    def test_finalize_detects_duplicate_via_star_blind_key(self):
        with TemporaryDirectory() as tmpdir:
            library = os.path.join(tmpdir, "library")
            os.makedirs(os.path.join(library, "2026", "2026-01-01"))

            plain = os.path.join(library, "2026", "2026-01-01", "plain.jpg")
            rated = os.path.join(library, "2026", "2026-01-01", "rated.jpg")
            _write_jpeg(plain)
            shutil.copy2(plain, rated)
            self.assertTrue(write_exif_rating(rated, 5))

            plain_hash = compute_hash_legacy(plain)
            rated_hash = compute_hash_legacy(rated)
            self.assertNotEqual(plain_hash, rated_hash)

            conn = self._make_conn()
            conn.execute(
                """
                INSERT INTO photos (
                    id, original_filename, current_path, date_taken, content_hash,
                    file_size, file_type, width, height, rating
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    1,
                    "plain.jpg",
                    "2026/2026-01-01/plain.jpg",
                    "2026:01:01 00:00:00",
                    plain_hash,
                    os.path.getsize(plain),
                    "photo",
                    16,
                    16,
                    None,
                ),
            )
            conn.execute(
                """
                INSERT INTO photos (
                    id, original_filename, current_path, date_taken, content_hash,
                    file_size, file_type, width, height, rating
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    2,
                    "rated.jpg",
                    "2026/2026-01-01/rated.jpg",
                    "2026:01:01 00:00:00",
                    "0" * 64,  # old hash before mutation
                    os.path.getsize(rated),
                    "photo",
                    16,
                    16,
                    5,
                ),
            )
            conn.commit()

            deleted = []

            def build_canonical_path(date_taken, content_hash, ext):
                return f"2026/2026-01-01/img_{content_hash[:8]}{ext}", f"img_{content_hash[:8]}{ext}"

            result = finalize_mutated_media(
                conn=conn,
                photo_id=2,
                library_path=library,
                current_rel_path="2026/2026-01-01/rated.jpg",
                date_taken="2026:01:01 00:00:00",
                old_hash="0" * 64,
                build_canonical_path=build_canonical_path,
                compute_hash=compute_hash_legacy,
                get_dimensions=lambda _path: (16, 16),
                delete_thumbnail_for_hash=lambda h: deleted.append(h),
                duplicate_policy="delete",
            )

            self.assertEqual(result.status, "duplicate_removed")
            self.assertEqual(result.duplicate.photo_id, 1)
            self.assertIsNone(
                conn.execute("SELECT id FROM photos WHERE id = 2").fetchone()
            )
            self.assertFalse(os.path.exists(rated))
            self.assertTrue(os.path.exists(plain))
            self.assertEqual(extract_exif_rating(plain), None)


if __name__ == "__main__":
    unittest.main()
