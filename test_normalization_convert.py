import os
import sqlite3
import unittest
from dataclasses import dataclass
from tempfile import TemporaryDirectory

from db_schema import create_database_schema
from library_layout import canonical_db_path
from normalization_convert import (
    ConvertDependencies,
    iter_convert_events,
    normalize_convert_file,
    rewrite_library_layout,
    scan_convert_library,
)
from normalization_core import NormalizationFileResult, expected_canonical_rel_path
from photo_canonicalization import UNKNOWN_PHOTO_DATE_TAKEN


class _HashCache:
    def __init__(self, content_hash):
        self.content_hash = content_hash

    def get_hash(self, _path):
        return self.content_hash, False


@dataclass
class _StagedPhoto:
    staged_path: str
    canonical_photo: object


@dataclass
class _CanonicalPhoto:
    content_hash: str
    relative_path: str
    date_taken: str
    file_size: int
    width: int
    height: int


class NormalizationConvertTest(unittest.TestCase):
    def test_scan_convert_library_delegates_to_shared_partition(self):
        with TemporaryDirectory() as tmpdir:
            media_path = os.path.join(tmpdir, "photo.jpg")
            other_path = os.path.join(tmpdir, "notes.txt")
            with open(media_path, "wb") as handle:
                handle.write(b"photo")
            with open(other_path, "wb") as handle:
                handle.write(b"notes")

            scan = scan_convert_library(tmpdir)

        self.assertEqual(scan.media_files, [media_path])
        self.assertEqual(scan.non_media_files, [other_path])
        self.assertEqual(scan.total_media, 1)

    def test_rewrite_library_layout_delegates_to_shared_cleanup(self):
        with TemporaryDirectory() as tmpdir:
            os.makedirs(os.path.join(tmpdir, "incoming"), exist_ok=True)
            os.makedirs(os.path.join(tmpdir, "2026", "2026-04-12"), exist_ok=True)
            with open(os.path.join(tmpdir, "2026", "2026-04-12", "img.jpg"), "wb") as handle:
                handle.write(b"photo")

            removed = rewrite_library_layout(tmpdir)

            self.assertEqual(removed, 1)
            self.assertFalse(os.path.exists(os.path.join(tmpdir, "incoming")))

    def test_normalize_convert_photo_uses_shared_ingest_and_removes_source(self):
        content_hash = "abc12345" + ("0" * 56)
        relative_path = f"1900/1900-01-01/img_19000101_{content_hash[:8]}.jpg"

        with TemporaryDirectory() as tmpdir:
            source_path = os.path.join(tmpdir, "incoming", "source.jpg")
            os.makedirs(os.path.dirname(source_path), exist_ok=True)
            with open(source_path, "wb") as handle:
                handle.write(b"convert-photo")

            db_path = canonical_db_path(tmpdir)
            os.makedirs(os.path.dirname(db_path), exist_ok=True)
            conn = sqlite3.connect(db_path)
            create_database_schema(conn.cursor())
            conn.commit()

            staged_path = os.path.join(tmpdir, ".import_temp", "convert_photo_1.jpg")
            os.makedirs(os.path.dirname(staged_path), exist_ok=True)
            with open(staged_path, "wb") as handle:
                handle.write(b"staged")

            canonical = _CanonicalPhoto(
                content_hash=content_hash,
                relative_path=relative_path,
                date_taken=UNKNOWN_PHOTO_DATE_TAKEN,
                file_size=6,
                width=640,
                height=480,
            )

            trashed: list[str] = []

            deps = ConvertDependencies(
                library_path=tmpdir,
                hash_cache=_HashCache(content_hash),
                stage_photo_for_canonicalization=lambda _path, **kwargs: _StagedPhoto(
                    staged_path=staged_path,
                    canonical_photo=canonical,
                ),
                cleanup_staged_file=lambda _path: None,
                commit_staged_canonical_photo=lambda conn, **kwargs: self._fake_commit_photo(
                    conn,
                    source_path=kwargs["source_path"],
                    original_filename=kwargs["original_filename"],
                    relative_path=relative_path,
                    content_hash=content_hash,
                    date_taken=UNKNOWN_PHOTO_DATE_TAKEN,
                    remove_source_after_commit=kwargs["remove_source_after_commit"],
                ),
                categorize_processing_error=lambda error: ("error", str(error)),
                extract_exif_date=lambda _path: None,
                write_video_metadata=lambda *_args: None,
                finalize_mutated_media=lambda **_kwargs: NormalizationFileResult(status="imported"),
                compute_hash=lambda _path: content_hash,
                get_dimensions=lambda _path: (640, 480),
                delete_thumbnail_for_hash=lambda _hash: None,
                remove_source_after_commit=True,
                move_duplicate_to_trash=lambda path: trashed.append(path) or path,
            )

            result = normalize_convert_file(conn, source_path, filename="source.jpg", deps=deps)

            self.assertEqual(result.status, "imported")
            self.assertFalse(os.path.exists(source_path))

    def test_iter_convert_events_trashes_duplicates(self):
        content_hash = "abc12345" + ("0" * 56)
        relative_path = f"1900/1900-01-01/img_19000101_{content_hash[:8]}.jpg"

        with TemporaryDirectory() as tmpdir:
            first_path = os.path.join(tmpdir, "a.jpg")
            dup_path = os.path.join(tmpdir, "b.jpg")
            for path in (first_path, dup_path):
                with open(path, "wb") as handle:
                    handle.write(b"same")

            db_path = canonical_db_path(tmpdir)
            os.makedirs(os.path.dirname(db_path), exist_ok=True)
            conn = sqlite3.connect(db_path)
            create_database_schema(conn.cursor())
            conn.commit()

            staged_path = os.path.join(tmpdir, ".import_temp", "convert_photo_1.jpg")
            os.makedirs(os.path.dirname(staged_path), exist_ok=True)
            with open(staged_path, "wb") as handle:
                handle.write(b"staged")

            canonical = _CanonicalPhoto(
                content_hash=content_hash,
                relative_path=relative_path,
                date_taken=UNKNOWN_PHOTO_DATE_TAKEN,
                file_size=4,
                width=640,
                height=480,
            )
            trashed: list[str] = []
            inserted = {"count": 0}

            def commit(conn, **kwargs):
                inserted["count"] += 1
                if inserted["count"] > 1:
                    raise RuntimeError("should not commit duplicate")
                target = os.path.join(tmpdir, relative_path)
                os.makedirs(os.path.dirname(target), exist_ok=True)
                with open(target, "wb") as handle:
                    handle.write(b"stored")
                cursor = conn.cursor()
                cursor.execute(
                    """
                        INSERT INTO photos (current_path, original_filename, content_hash, file_size, file_type, date_taken, width, height)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (relative_path, "a.jpg", content_hash, 4, "photo", UNKNOWN_PHOTO_DATE_TAKEN, 640, 480),
                )
                conn.commit()
                return 1, target

            deps = ConvertDependencies(
                library_path=tmpdir,
                hash_cache=_HashCache(content_hash),
                stage_photo_for_canonicalization=lambda _path, **kwargs: _StagedPhoto(
                    staged_path=staged_path,
                    canonical_photo=canonical,
                ),
                cleanup_staged_file=lambda _path: None,
                commit_staged_canonical_photo=commit,
                categorize_processing_error=lambda error: ("error", str(error)),
                extract_exif_date=lambda _path: None,
                write_video_metadata=lambda *_args: None,
                finalize_mutated_media=lambda **_kwargs: NormalizationFileResult(status="imported"),
                compute_hash=lambda _path: content_hash,
                get_dimensions=lambda _path: (640, 480),
                delete_thumbnail_for_hash=lambda _hash: None,
                remove_source_after_commit=True,
                move_duplicate_to_trash=lambda path: self._fake_trash(path, trashed),
            )

            events = list(iter_convert_events(conn, [first_path, dup_path], deps))

            complete = events[-1]
            self.assertEqual(complete[0], "complete")
            self.assertEqual(complete[1]["processed"], 1)
            self.assertEqual(complete[1]["duplicates"], 1)
            self.assertEqual(trashed, [dup_path])
            self.assertFalse(os.path.exists(dup_path))

    def test_normalize_convert_video_uses_post_metadata_hash_for_path_and_dimensions(self):
        pre_hash = "11111111" + ("1" * 56)
        post_hash = "22222222" + ("2" * 56)
        date_taken = "2026:04:12 09:30:15"
        expected_rel = expected_canonical_rel_path(date_taken, post_hash, ".MOV")

        with TemporaryDirectory() as tmpdir:
            source_path = os.path.join(tmpdir, "incoming", "clip.MOV")
            os.makedirs(os.path.dirname(source_path), exist_ok=True)
            with open(source_path, "wb") as handle:
                handle.write(b"video")

            db_path = canonical_db_path(tmpdir)
            os.makedirs(os.path.dirname(db_path), exist_ok=True)
            conn = sqlite3.connect(db_path)
            conn.row_factory = sqlite3.Row
            create_database_schema(conn.cursor())
            conn.commit()

            def write_metadata(path, _date_taken):
                with open(path, "ab") as handle:
                    handle.write(b"|metadata|")

            deps = ConvertDependencies(
                library_path=tmpdir,
                hash_cache=_HashCache(pre_hash),
                stage_photo_for_canonicalization=lambda *_args, **_kwargs: None,
                cleanup_staged_file=lambda _path: None,
                commit_staged_canonical_photo=lambda *_args, **_kwargs: None,
                categorize_processing_error=lambda error: ("error", str(error)),
                extract_exif_date=lambda _path: date_taken,
                write_video_metadata=write_metadata,
                finalize_mutated_media=lambda **_kwargs: NormalizationFileResult(status="imported"),
                compute_hash=lambda _path: post_hash,
                get_dimensions=lambda _path: (1920, 1080),
                delete_thumbnail_for_hash=lambda _hash: None,
                remove_source_after_commit=True,
                move_duplicate_to_trash=lambda path: path,
            )

            result = normalize_convert_file(conn, source_path, filename="clip.MOV", deps=deps)
            row = conn.execute("SELECT * FROM photos").fetchone()

            self.assertEqual(result.status, "imported")
            self.assertEqual(row["current_path"], expected_rel)
            self.assertEqual(row["content_hash"], post_hash)
            self.assertEqual(row["width"], 1920)
            self.assertEqual(row["height"], 1080)
            self.assertFalse(os.path.exists(source_path))
            self.assertTrue(os.path.exists(os.path.join(tmpdir, expected_rel)))

    def _fake_commit_photo(
        self,
        conn,
        *,
        source_path,
        original_filename,
        relative_path,
        content_hash,
        date_taken,
        remove_source_after_commit,
    ):
        target = os.path.join(os.path.dirname(os.path.dirname(source_path)), relative_path)
        os.makedirs(os.path.dirname(target), exist_ok=True)
        with open(target, "wb") as handle:
            handle.write(b"stored")
        cursor = conn.cursor()
        cursor.execute(
            """
                INSERT INTO photos (current_path, original_filename, content_hash, file_size, file_type, date_taken, width, height)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (relative_path, original_filename, content_hash, 6, "photo", date_taken, 640, 480),
        )
        conn.commit()
        if remove_source_after_commit and os.path.exists(source_path):
            os.remove(source_path)
        return cursor.lastrowid, target

    def _fake_trash(self, path, trashed):
        trashed.append(path)
        os.remove(path)
        return path


if __name__ == "__main__":
    unittest.main()
