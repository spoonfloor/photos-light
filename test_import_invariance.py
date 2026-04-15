import os
import sqlite3
import unittest
from tempfile import TemporaryDirectory
from unittest.mock import patch

import app as photo_app
from db_schema import create_database_schema
from photo_canonicalization import UNKNOWN_PHOTO_DATE_TAKEN
from make_library_perfect import run_db_normalization_engine


class ImportInvarianceContractTest(unittest.TestCase):
    def test_app_extract_exif_date_uses_shared_reader_without_mtime_fallback(self):
        with patch("app.shared_extract_exif_date", return_value=None) as shared_reader:
            self.assertIsNone(photo_app.extract_exif_date("/tmp/example.jpg"))
            shared_reader.assert_called_once_with("/tmp/example.jpg")

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
        photo_app.app.config["TESTING"] = True

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

    def _create_library(self, name):
        library_path = os.path.join(self.tmpdir.name, name)
        os.makedirs(library_path, exist_ok=True)
        db_path = os.path.join(library_path, ".library", "photo_library.db")
        os.makedirs(os.path.dirname(db_path), exist_ok=True)

        conn = sqlite3.connect(db_path)
        conn.row_factory = sqlite3.Row
        create_database_schema(conn.cursor())
        conn.commit()
        conn.close()

        return library_path, db_path

    def _read_single_photo_row(self, db_path):
        conn = sqlite3.connect(db_path)
        conn.row_factory = sqlite3.Row
        row = conn.execute(
            "SELECT current_path, content_hash, date_taken, file_size FROM photos"
        ).fetchone()
        conn.close()
        return row

    def _import_photo(self, *, library_path, db_path, source_name, source_bytes, exif_date, mtime):
        photo_app.update_app_paths(library_path, db_path)
        client = photo_app.app.test_client()

        source_path = os.path.join(self.tmpdir.name, source_name)
        with open(source_path, "wb") as fh:
            fh.write(source_bytes)
        os.utime(source_path, (mtime, mtime))

        def fake_write_photo_exif(file_path, target_date):
            with open(file_path, "ab") as fh:
                fh.write(b"|canonical-date|" + target_date.encode("utf-8"))

        with patch.object(photo_app, "extract_exif_date", return_value=exif_date), patch.object(
            photo_app,
            "bake_orientation",
            return_value=(False, "No orientation flag", None),
        ), patch.object(
            photo_app,
            "get_image_dimensions",
            return_value=(640, 480),
        ), patch.object(
            photo_app,
            "extract_exif_rating",
            return_value=None,
        ), patch.object(
            photo_app,
            "strip_exif_rating",
            return_value=True,
        ), patch.object(
            photo_app,
            "write_photo_exif",
            side_effect=fake_write_photo_exif,
        ):
            response = client.post(
                "/api/photos/import-from-paths",
                json={"paths": [source_path]},
                buffered=True,
            )

        self.assertEqual(response.status_code, 200)
        self.assertIn("event: complete", response.get_data(as_text=True))

        row = self._read_single_photo_row(db_path)
        self.assertIsNotNone(row)
        full_path = os.path.join(library_path, row["current_path"])
        with open(full_path, "rb") as fh:
            stored_bytes = fh.read()

        return row, stored_bytes

    def test_same_embedded_date_bytes_import_to_identical_identity_across_libraries(self):
        source_bytes = b"mickey-photo-same-embedded-date"
        exif_date = "2026:04:12 09:30:15"

        library_a, db_a = self._create_library("library-a")
        row_a, stored_a = self._import_photo(
            library_path=library_a,
            db_path=db_a,
            source_name="mickey-a.jpg",
            source_bytes=source_bytes,
            exif_date=exif_date,
            mtime=100,
        )

        library_b, db_b = self._create_library("library-b")
        row_b, stored_b = self._import_photo(
            library_path=library_b,
            db_path=db_b,
            source_name="mickey-b.jpg",
            source_bytes=source_bytes,
            exif_date=exif_date,
            mtime=200,
        )

        self.assertEqual(stored_a, stored_b)
        self.assertEqual(row_a["content_hash"], row_b["content_hash"])
        self.assertEqual(row_a["current_path"], row_b["current_path"])

    def test_same_source_bytes_ignore_filesystem_mtime_when_no_embedded_date(self):
        source_bytes = b"mickey-photo-no-exif-different-mtime"

        library_a, db_a = self._create_library("library-mtime-a")
        row_a, stored_a = self._import_photo(
            library_path=library_a,
            db_path=db_a,
            source_name="mtime-a.jpg",
            source_bytes=source_bytes,
            exif_date=None,
            mtime=100,
        )

        library_b, db_b = self._create_library("library-mtime-b")
        row_b, stored_b = self._import_photo(
            library_path=library_b,
            db_path=db_b,
            source_name="mtime-b.jpg",
            source_bytes=source_bytes,
            exif_date=None,
            mtime=2000000000,
        )

        self.assertEqual(row_a["date_taken"], UNKNOWN_PHOTO_DATE_TAKEN)
        self.assertEqual(row_b["date_taken"], UNKNOWN_PHOTO_DATE_TAKEN)
        self.assertEqual(stored_a, stored_b)
        self.assertEqual(row_a["content_hash"], row_b["content_hash"])
        self.assertEqual(row_a["current_path"], row_b["current_path"])

    def test_no_embedded_date_uses_deterministic_unknown_date_path(self):
        source_bytes = b"mickey-photo-no-exif"
        library_path, db_path = self._create_library("library-no-exif")

        row, stored_bytes = self._import_photo(
            library_path=library_path,
            db_path=db_path,
            source_name="no-exif.jpg",
            source_bytes=source_bytes,
            exif_date=None,
            mtime=123456789,
        )

        self.assertEqual(row["date_taken"], UNKNOWN_PHOTO_DATE_TAKEN)
        self.assertTrue(row["current_path"].startswith("1900/1900-01-01/"))
        self.assertIn(UNKNOWN_PHOTO_DATE_TAKEN.encode("utf-8"), stored_bytes)

    def test_clean_library_is_noop_for_already_canonical_import(self):
        source_bytes = b"mickey-photo-clean-idempotent"
        exif_date = "2026:04:12 09:30:15"
        library_path, db_path = self._create_library("library-clean")

        row_before, stored_before = self._import_photo(
            library_path=library_path,
            db_path=db_path,
            source_name="clean.jpg",
            source_bytes=source_bytes,
            exif_date=exif_date,
            mtime=100,
        )

        with patch("make_library_perfect.verify_media_file", return_value=(True, "mock")), patch(
            "make_library_perfect.extract_exif_date", return_value=exif_date
        ), patch("make_library_perfect.extract_exif_rating", return_value=None), patch(
            "make_library_perfect.strip_exif_rating", return_value=True
        ), patch(
            "make_library_perfect.bake_orientation",
            return_value=(False, "No orientation flag", None),
        ), patch("make_library_perfect.get_orientation_flag", return_value=1), patch(
            "make_library_perfect.read_dimensions",
            return_value=(640, 480),
        ):
            result = run_db_normalization_engine(library_path, db_path=db_path)

        self.assertEqual(result["status"], "SUCCESS")

        row_after = self._read_single_photo_row(db_path)
        full_path_after = os.path.join(library_path, row_after["current_path"])
        with open(full_path_after, "rb") as fh:
            stored_after = fh.read()

        self.assertEqual(row_before["content_hash"], row_after["content_hash"])
        self.assertEqual(row_before["current_path"], row_after["current_path"])
        self.assertEqual(stored_before, stored_after)


if __name__ == "__main__":
    unittest.main()
