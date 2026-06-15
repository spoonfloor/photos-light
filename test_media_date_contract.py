import os
import shutil
import sqlite3
import subprocess
import unittest
from datetime import datetime
from tempfile import TemporaryDirectory
from unittest.mock import patch

from db_schema import create_database_schema
from library_sync import synchronize_library_generator
from media_dates import (
    read_media_date,
    write_and_verify_media_date,
)
from photo_canonicalization import UNKNOWN_PHOTO_DATE_TAKEN as PHOTO_UNKNOWN
import app as photo_app


class MediaDateReadContractTest(unittest.TestCase):
    def test_video_basename_wins_when_embedded_disagrees(self):
        with TemporaryDirectory() as tmpdir:
            video_path = os.path.join(tmpdir, "img_19001127_deadbeef.mov")
            with open(video_path, "wb") as handle:
                handle.write(b"video")

            def fake_run(args, **_kwargs):
                if args[0] == "ffprobe":
                    return subprocess.CompletedProcess(
                        args,
                        0,
                        '{"format":{"tags":{"creation_time":"2037-11-27T00:00:00.000000Z"}}}',
                        "",
                    )
                raise AssertionError(args)

            with patch("media_dates.subprocess.run", side_effect=fake_run):
                resolved = read_media_date(video_path, allow_mtime_fallback=False)

        self.assertEqual(resolved, "1900:11:27 00:00:00")

    def test_video_ingest_uses_mtime_when_no_embedded_or_basename(self):
        with TemporaryDirectory() as tmpdir:
            video_path = os.path.join(tmpdir, "vacation.mov")
            with open(video_path, "wb") as handle:
                handle.write(b"video")
            os.utime(video_path, (1_700_000_000, 1_700_000_000))

            with patch("media_dates.read_embedded_media_date", return_value=None):
                resolved = read_media_date(video_path, allow_mtime_fallback=True)

        expected = datetime.fromtimestamp(1_700_000_000).strftime("%Y:%m:%d %H:%M:%S")
        self.assertEqual(resolved, expected)

    def test_rebuild_read_does_not_use_mtime_for_videos(self):
        with TemporaryDirectory() as tmpdir:
            video_path = os.path.join(tmpdir, "vacation.mov")
            with open(video_path, "wb") as handle:
                handle.write(b"video")
            os.utime(video_path, (1_700_000_000, 1_700_000_000))

            with patch("media_dates.read_embedded_media_date", return_value=None):
                resolved = read_media_date(video_path, allow_mtime_fallback=False)

        self.assertEqual(resolved, PHOTO_UNKNOWN)

    def test_photo_without_metadata_uses_unknown_placeholder(self):
        with TemporaryDirectory() as tmpdir:
            photo_path = os.path.join(tmpdir, "snapshot.jpg")
            with open(photo_path, "wb") as handle:
                handle.write(b"jpg")

            with patch("media_dates.read_embedded_media_date", return_value=None):
                resolved = read_media_date(photo_path, allow_mtime_fallback=False)

        self.assertEqual(resolved, PHOTO_UNKNOWN)


class MediaDateRebuildContractTest(unittest.TestCase):
    def test_rebuild_indexes_video_with_basename_date_not_stale_embedded(self):
        with TemporaryDirectory() as tmpdir:
            library_path = tmpdir
            db_path = os.path.join(library_path, ".library", "photo_library.db")
            os.makedirs(os.path.dirname(db_path), exist_ok=True)

            rel_path = os.path.join("1900", "1900-11-27", "img_19001127_deadbeef.mov")
            full_path = os.path.join(library_path, rel_path)
            os.makedirs(os.path.dirname(full_path), exist_ok=True)
            with open(full_path, "wb") as handle:
                handle.write(b"edited-video")

            conn = sqlite3.connect(db_path)
            create_database_schema(conn.cursor())
            conn.commit()

            def fake_run(args, **_kwargs):
                if args[0] == "ffprobe":
                    return subprocess.CompletedProcess(
                        args,
                        0,
                        '{"format":{"tags":{"creation_time":"2037-11-27T00:00:00.000000Z"}}}',
                        "",
                    )
                raise AssertionError(args)

            with patch("media_dates.subprocess.run", side_effect=fake_run):
                events = list(
                    synchronize_library_generator(
                        library_path,
                        conn,
                        lambda _path: (None, None),
                        mode="full",
                    )
                )

            row = conn.execute(
                "SELECT date_taken, current_path FROM photos WHERE current_path = ?",
                (rel_path.replace(os.sep, "/"),),
            ).fetchone()
            conn.close()

            self.assertTrue(any("event: complete" in event for event in events))
            self.assertIsNotNone(row)
            self.assertEqual(row[0], "1900:11:27 00:00:00")


class MediaDateEditRebuildContractTest(unittest.TestCase):
    def setUp(self):
        self.tmpdir = TemporaryDirectory()
        self.original_paths = (
            photo_app.LIBRARY_PATH,
            photo_app.DB_PATH,
            photo_app.THUMBNAIL_CACHE_DIR,
            photo_app.TRASH_DIR,
            photo_app.DB_BACKUP_DIR,
            photo_app.IMPORT_TEMP_DIR,
            photo_app.LOG_DIR,
        )

    def tearDown(self):
        (
            photo_app.LIBRARY_PATH,
            photo_app.DB_PATH,
            photo_app.THUMBNAIL_CACHE_DIR,
            photo_app.TRASH_DIR,
            photo_app.DB_BACKUP_DIR,
            photo_app.IMPORT_TEMP_DIR,
            photo_app.LOG_DIR,
        ) = self.original_paths
        self.tmpdir.cleanup()

    def _setup_library(self):
        library_path = os.path.join(self.tmpdir.name, "library")
        os.makedirs(library_path, exist_ok=True)
        db_path = os.path.join(library_path, ".library", "photo_library.db")
        os.makedirs(os.path.dirname(db_path), exist_ok=True)

        photo_app.LIBRARY_PATH = library_path
        photo_app.DB_PATH = db_path
        photo_app.THUMBNAIL_CACHE_DIR = os.path.join(library_path, ".thumbnails")
        photo_app.TRASH_DIR = os.path.join(library_path, ".trash")
        photo_app.DB_BACKUP_DIR = os.path.join(library_path, ".backups")
        photo_app.IMPORT_TEMP_DIR = os.path.join(library_path, ".import_temp")
        photo_app.LOG_DIR = os.path.join(library_path, ".logs")
        for directory in (
            photo_app.THUMBNAIL_CACHE_DIR,
            photo_app.TRASH_DIR,
            photo_app.DB_BACKUP_DIR,
            photo_app.IMPORT_TEMP_DIR,
            photo_app.LOG_DIR,
        ):
            os.makedirs(directory, exist_ok=True)

        conn = sqlite3.connect(db_path)
        conn.row_factory = sqlite3.Row
        create_database_schema(conn.cursor())
        conn.commit()
        return library_path, db_path, conn

    def test_edit_then_rebuild_keeps_verified_embedded_date(self):
        library_path, db_path, conn = self._setup_library()
        rel_path = "1900/1900-11-27/img_19001127_deadbeef.mkv"
        full_path = os.path.join(library_path, rel_path)
        os.makedirs(os.path.dirname(full_path), exist_ok=True)
        with open(full_path, "wb") as handle:
            handle.write(b"video")

        conn.execute(
            """
            INSERT INTO photos (current_path, original_filename, content_hash, file_size, file_type, date_taken)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (
                rel_path,
                "img_19001127_deadbeef.mkv",
                "deadbeef" * 8,
                5,
                "video",
                "2037:11:27 00:00:00",
            ),
        )
        conn.commit()

        target_date = "1900:11:27 00:00:00"

        def fake_run(args, **_kwargs):
            if args[0] == "ffmpeg":
                temp_output = args[-1]
                with open(temp_output, "wb") as handle:
                    handle.write(b"video-redated")
                return subprocess.CompletedProcess(args, 0, "", "")
            if args[0] == "ffprobe":
                return subprocess.CompletedProcess(
                    args,
                    0,
                    '{"format":{"tags":{"creation_time":"1900-11-27T00:00:00.000000Z"}}}',
                    "",
                )
            if args[0] == "exiftool":
                return subprocess.CompletedProcess(args, 0, "", "")
            raise AssertionError(args)

        with patch("media_dates.subprocess.run", side_effect=fake_run):
            success, result, _transaction = photo_app.update_photo_date_with_files(
                1,
                target_date,
                conn,
            )
            self.assertTrue(success)
            self.assertEqual(result["status"], "updated")

            conn.execute("DELETE FROM photos")
            conn.commit()

            rebuild_conn = sqlite3.connect(db_path)
            events = list(
                synchronize_library_generator(
                    library_path,
                    rebuild_conn,
                    lambda _path: (None, None),
                    mode="full",
                )
            )
            row = rebuild_conn.execute(
                "SELECT date_taken FROM photos"
            ).fetchone()
            rebuild_conn.close()

        self.assertTrue(any("event: complete" in event for event in events))
        self.assertIsNotNone(row)
        self.assertEqual(row[0], target_date)


class QuickTimePatchArtifactContractTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        import shutil
        import subprocess

        cls._ffmpeg_available = (
            shutil.which("ffmpeg") is not None and shutil.which("ffprobe") is not None
        )
        if not cls._ffmpeg_available:
            return
        cls._tmpdir = TemporaryDirectory()
        cls.source_mov = os.path.join(cls._tmpdir.name, "source.mov")
        result = subprocess.run(
            [
                "ffmpeg",
                "-y",
                "-f",
                "lavfi",
                "-i",
                "color=c=black:s=16x16:d=0.1",
                "-c:v",
                "libx264",
                "-t",
                "0.1",
                "-movflags",
                "+faststart",
                cls.source_mov,
            ],
            capture_output=True,
            text=True,
            timeout=60,
        )
        if result.returncode != 0:
            cls._ffmpeg_available = False

    @classmethod
    def tearDownClass(cls):
        if getattr(cls, "_tmpdir", None) is not None:
            cls._tmpdir.cleanup()

    def setUp(self):
        if not self._ffmpeg_available:
            self.skipTest("ffmpeg/ffprobe required")
        self.tmpdir = TemporaryDirectory()
        self.original_paths = (
            photo_app.LIBRARY_PATH,
            photo_app.DB_PATH,
            photo_app.THUMBNAIL_CACHE_DIR,
            photo_app.TRASH_DIR,
            photo_app.DB_BACKUP_DIR,
            photo_app.IMPORT_TEMP_DIR,
            photo_app.LOG_DIR,
        )

    def tearDown(self):
        (
            photo_app.LIBRARY_PATH,
            photo_app.DB_PATH,
            photo_app.THUMBNAIL_CACHE_DIR,
            photo_app.TRASH_DIR,
            photo_app.DB_BACKUP_DIR,
            photo_app.IMPORT_TEMP_DIR,
            photo_app.LOG_DIR,
        ) = self.original_paths
        self.tmpdir.cleanup()

    def _setup_library_with_mov(self, *, date_taken: str):
        library_path = os.path.join(self.tmpdir.name, "library")
        os.makedirs(library_path, exist_ok=True)
        db_path = os.path.join(library_path, ".library", "photo_library.db")
        os.makedirs(os.path.dirname(db_path), exist_ok=True)

        photo_app.LIBRARY_PATH = library_path
        photo_app.DB_PATH = db_path
        photo_app.THUMBNAIL_CACHE_DIR = os.path.join(library_path, ".thumbnails")
        photo_app.TRASH_DIR = os.path.join(library_path, ".trash")
        photo_app.DB_BACKUP_DIR = os.path.join(library_path, ".backups")
        photo_app.IMPORT_TEMP_DIR = os.path.join(library_path, ".import_temp")
        photo_app.LOG_DIR = os.path.join(library_path, ".logs")
        for directory in (
            photo_app.THUMBNAIL_CACHE_DIR,
            photo_app.TRASH_DIR,
            photo_app.DB_BACKUP_DIR,
            photo_app.IMPORT_TEMP_DIR,
            photo_app.LOG_DIR,
        ):
            os.makedirs(directory, exist_ok=True)

        conn = sqlite3.connect(db_path)
        conn.row_factory = sqlite3.Row
        create_database_schema(conn.cursor())
        conn.commit()

        rel_path = "2026/2026-06-13/img_20260613_deadbeef.mov"
        full_path = os.path.join(library_path, rel_path)
        os.makedirs(os.path.dirname(full_path), exist_ok=True)
        shutil.copy2(self.source_mov, full_path)

        conn.execute(
            """
            INSERT INTO photos (current_path, original_filename, content_hash, file_size, file_type, date_taken)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (
                rel_path,
                "img_20260613_deadbeef.mov",
                "deadbeef" * 8,
                os.path.getsize(full_path),
                "video",
                date_taken,
            ),
        )
        conn.commit()
        return library_path, conn, full_path, rel_path

    def _patch_artifacts_under(self, root: str):
        artifacts = []
        for dirpath, _dirnames, filenames in os.walk(root):
            for name in filenames:
                if name.endswith((".bak", ".atompatch")):
                    artifacts.append(os.path.join(dirpath, name))
        return artifacts

    def test_multi_hop_date_edit_leaves_no_patch_artifacts_or_stale_folders(self):
        library_path, conn, _full_path, _rel_path = self._setup_library_with_mov(
            date_taken="2026:06:13 12:48:54"
        )
        transitions = (
            "1900:06:13 12:48:54",
            "2026:06:13 12:48:54",
            "2100:06:13 12:48:54",
        )
        photo_id = 1

        for new_date in transitions:
            with self.subTest(new_date=new_date):
                success, result, _transaction = photo_app.update_photo_date_with_files(
                    photo_id,
                    new_date,
                    conn,
                )
                self.assertTrue(success, result)
                self.assertEqual(result["status"], "updated")
                conn.commit()

        self.assertEqual(self._patch_artifacts_under(library_path), [])
        self.assertFalse(os.path.isdir(os.path.join(library_path, "1900")))
        self.assertFalse(os.path.isdir(os.path.join(library_path, "2026")))
        self.assertTrue(
            os.path.exists(
                os.path.join(library_path, "2100", "2100-06-13")
            )
        )
        row = conn.execute(
            "SELECT current_path, date_taken FROM photos WHERE id = ?",
            (photo_id,),
        ).fetchone()
        conn.close()
        self.assertEqual(row["date_taken"], transitions[-1])
        self.assertTrue(row["current_path"].startswith("2100/2100-06-13/"))


if __name__ == "__main__":
    unittest.main()
