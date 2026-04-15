import os
import sqlite3
import subprocess
import unittest
from datetime import datetime
from tempfile import TemporaryDirectory
from unittest.mock import patch

import app as photo_app
from db_schema import create_database_schema
from library_layout import canonical_db_path
from make_library_perfect import scan_library_cleanliness
from photo_canonicalization import CanonicalizedPhoto, UNKNOWN_PHOTO_DATE_TAKEN


class ConvertInvarianceContractTest(unittest.TestCase):
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
        self.client = photo_app.app.test_client()
        self.fake_subprocess_result = subprocess.CompletedProcess(
            args=["tool"],
            returncode=0,
            stdout="",
            stderr="",
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

    def _make_convert_library(self, name, source_name, payload, mtime):
        library_path = os.path.join(self.tmpdir.name, name)
        source_path = os.path.join(library_path, "incoming", source_name)
        os.makedirs(os.path.dirname(source_path), exist_ok=True)
        with open(source_path, "wb") as handle:
            handle.write(payload)
        os.utime(source_path, (mtime, mtime))
        return library_path, source_path

    def _make_import_library(self, name):
        library_path = os.path.join(self.tmpdir.name, name)
        os.makedirs(library_path, exist_ok=True)
        db_path = canonical_db_path(library_path)
        os.makedirs(os.path.dirname(db_path), exist_ok=True)
        conn = sqlite3.connect(db_path)
        conn.row_factory = sqlite3.Row
        create_database_schema(conn.cursor())
        conn.commit()
        conn.close()
        return library_path, db_path

    def _read_rows(self, db_path):
        conn = sqlite3.connect(db_path)
        conn.row_factory = sqlite3.Row
        rows = conn.execute(
            "SELECT current_path, content_hash, date_taken, file_size FROM photos ORDER BY current_path"
        ).fetchall()
        conn.close()
        return rows

    def _read_single_row(self, db_path):
        rows = self._read_rows(db_path)
        self.assertEqual(len(rows), 1)
        return rows[0]

    def _run_convert(self, library_path, *, exif_date, write_side_effect):
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
            side_effect=write_side_effect,
        ), patch("app.subprocess.run", return_value=self.fake_subprocess_result):
            response = self.client.post(
                "/api/library/terraform",
                json={"library_path": library_path},
                buffered=True,
            )

        self.assertEqual(response.status_code, 200)
        return response.get_data(as_text=True)

    def _run_import(self, library_path, db_path, source_path, *, exif_date, write_side_effect):
        photo_app.update_app_paths(library_path, db_path)
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
            side_effect=write_side_effect,
        ):
            response = self.client.post(
                "/api/photos/import-from-paths",
                json={"paths": [source_path]},
                buffered=True,
            )

        self.assertEqual(response.status_code, 200)
        return response.get_data(as_text=True)

    def test_convert_uses_unknown_date_path_not_mtime_for_photo(self):
        payload = b"convert-no-exif"
        library_path, source_path = self._make_convert_library(
            "convert-no-exif-lib",
            "source.jpg",
            payload,
            2000000000,
        )

        def fake_write_photo_exif(file_path, target_date):
            with open(file_path, "ab") as handle:
                handle.write(b"|canonical-date|" + target_date.encode("utf-8"))

        response_text = self._run_convert(
            library_path,
            exif_date=None,
            write_side_effect=fake_write_photo_exif,
        )

        self.assertIn("event: complete", response_text)
        db_path = canonical_db_path(library_path)
        row = self._read_single_row(db_path)
        self.assertEqual(row["date_taken"], UNKNOWN_PHOTO_DATE_TAKEN)
        self.assertTrue(row["current_path"].startswith("1900/1900-01-01/"))
        self.assertFalse(os.path.exists(source_path))

        with open(os.path.join(library_path, row["current_path"]), "rb") as handle:
            stored_bytes = handle.read()
        self.assertIn(UNKNOWN_PHOTO_DATE_TAKEN.encode("utf-8"), stored_bytes)

    def test_convert_ignores_source_mtime_for_canonical_identity(self):
        payload = b"same-photo-different-mtime"

        library_a, _ = self._make_convert_library("convert-a", "a.jpg", payload, 100)
        library_b, _ = self._make_convert_library("convert-b", "b.jpg", payload, 2000000000)

        def fake_write_photo_exif(file_path, target_date):
            with open(file_path, "ab") as handle:
                handle.write(b"|canonical-date|" + target_date.encode("utf-8"))

        self._run_convert(library_a, exif_date=None, write_side_effect=fake_write_photo_exif)
        self._run_convert(library_b, exif_date=None, write_side_effect=fake_write_photo_exif)

        row_a = self._read_single_row(canonical_db_path(library_a))
        row_b = self._read_single_row(canonical_db_path(library_b))
        with open(os.path.join(library_a, row_a["current_path"]), "rb") as handle:
            stored_a = handle.read()
        with open(os.path.join(library_b, row_b["current_path"]), "rb") as handle:
            stored_b = handle.read()

        self.assertEqual(row_a["date_taken"], UNKNOWN_PHOTO_DATE_TAKEN)
        self.assertEqual(row_b["date_taken"], UNKNOWN_PHOTO_DATE_TAKEN)
        self.assertEqual(row_a["current_path"], row_b["current_path"])
        self.assertEqual(row_a["content_hash"], row_b["content_hash"])
        self.assertEqual(stored_a, stored_b)

    def test_convert_matches_import_canonical_identity_for_same_photo(self):
        payload = b"convert-versus-import"
        exif_date = "2026:04:12 09:30:15"

        convert_library, _ = self._make_convert_library("convert-identity", "convert.jpg", payload, 123)
        import_library, import_db_path = self._make_import_library("import-identity")
        import_source = os.path.join(self.tmpdir.name, "import-source.jpg")
        with open(import_source, "wb") as handle:
            handle.write(payload)

        def fake_write_photo_exif(file_path, target_date):
            with open(file_path, "ab") as handle:
                handle.write(b"|canonical-date|" + target_date.encode("utf-8"))

        convert_text = self._run_convert(
            convert_library,
            exif_date=exif_date,
            write_side_effect=fake_write_photo_exif,
        )
        import_text = self._run_import(
            import_library,
            import_db_path,
            import_source,
            exif_date=exif_date,
            write_side_effect=fake_write_photo_exif,
        )

        self.assertIn("event: complete", convert_text)
        self.assertIn("event: complete", import_text)

        convert_row = self._read_single_row(canonical_db_path(convert_library))
        import_row = self._read_single_row(import_db_path)
        with open(os.path.join(convert_library, convert_row["current_path"]), "rb") as handle:
            convert_bytes = handle.read()
        with open(os.path.join(import_library, import_row["current_path"]), "rb") as handle:
            import_bytes = handle.read()

        self.assertEqual(convert_row["current_path"], import_row["current_path"])
        self.assertEqual(convert_row["content_hash"], import_row["content_hash"])
        self.assertEqual(convert_row["date_taken"], import_row["date_taken"])
        self.assertEqual(convert_bytes, import_bytes)

    def test_failed_convert_preserves_original_source_photo(self):
        payload = b"convert-preserve-original-on-failure"
        library_path, source_path = self._make_convert_library(
            "convert-failure-lib",
            "failure.jpg",
            payload,
            12345,
        )

        def failing_write_photo_exif(_file_path, _target_date):
            raise RuntimeError("simulated metadata failure")

        response_text = self._run_convert(
            library_path,
            exif_date=None,
            write_side_effect=failing_write_photo_exif,
        )

        self.assertIn("event: rejected", response_text)
        self.assertTrue(os.path.exists(source_path))
        self.assertEqual(len(self._read_rows(canonical_db_path(library_path))), 0)

        import_temp_dir = os.path.join(library_path, ".import_temp")
        self.assertEqual(
            sorted(os.listdir(import_temp_dir)),
            [],
        )

    def test_convert_followed_by_clean_scan_reports_no_photo_issues(self):
        payload = b"convert-clean-scan"
        library_path, _ = self._make_convert_library(
            "convert-clean-scan-lib",
            "scan.jpg",
            payload,
            555,
        )

        def fake_write_photo_exif(file_path, target_date):
            with open(file_path, "ab") as handle:
                handle.write(b"|canonical-date|" + target_date.encode("utf-8"))

        self._run_convert(
            library_path,
            exif_date=None,
            write_side_effect=fake_write_photo_exif,
        )

        row = self._read_single_row(canonical_db_path(library_path))
        date_obj = datetime.strptime(row["date_taken"], "%Y:%m:%d %H:%M:%S")

        canonical_identity = CanonicalizedPhoto(
            date_taken=row["date_taken"],
            date_obj=date_obj,
            content_hash=row["content_hash"],
            relative_path=row["current_path"],
            canonical_name=os.path.basename(row["current_path"]),
            file_size=row["file_size"],
            width=640,
            height=480,
            rating=None,
            metadata_changed=False,
            orientation_baked=False,
            rating_stripped=False,
        )

        with patch("make_library_perfect.verify_media_file", return_value=(True, "mock")), patch(
            "make_library_perfect.extract_exif_date",
            return_value=None,
        ), patch(
            "make_library_perfect.extract_exif_rating",
            return_value=None,
        ), patch(
            "make_library_perfect.strip_exif_rating",
            return_value=True,
        ), patch(
            "make_library_perfect.bake_orientation",
            return_value=(False, "No orientation flag", None),
        ), patch(
            "make_library_perfect.get_orientation_flag",
            return_value=1,
        ), patch(
            "make_library_perfect.read_dimensions",
            return_value=(640, 480),
        ), patch(
            "make_library_perfect.canonicalize_photo_file",
            return_value=canonical_identity,
        ):
            result = scan_library_cleanliness(
                library_path,
                db_path=canonical_db_path(library_path),
            )

        self.assertEqual(result["status"], "CLEAN")
        self.assertEqual(result["summary"]["issue_count"], 0)


if __name__ == "__main__":
    unittest.main()
