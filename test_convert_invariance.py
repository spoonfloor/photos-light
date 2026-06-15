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

    def _run_convert(self, library_path, *, exif_date, write_side_effect, audit_issues=None):
        if audit_issues is None:
            audit_issues = []
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
        ), patch.object(
            photo_app,
            "write_video_metadata",
            side_effect=write_side_effect,
        ), patch("app.subprocess.run", return_value=self.fake_subprocess_result), patch(
            "clean_library_fast_audit.run_fast_library_audit",
            return_value=audit_issues,
        ):
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

    def test_import_accepts_post_2040_mov_when_ffprobe_already_matches(self):
        library_path, db_path = self._make_import_library("import-post-2040-mov")
        source_path = os.path.join(self.tmpdir.name, "img_20800101_f2b46044.mov")
        with open(source_path, "wb") as handle:
            handle.write(b"already-patched-future-mov")

        def fake_run(args, **_kwargs):
            if args[0] == "ffprobe":
                return subprocess.CompletedProcess(
                    args,
                    0,
                    '{"format":{"tags":{"creation_time":"2080-01-01T00:09:00.000000Z"}}}',
                    "",
                )
            raise AssertionError(f"Unexpected metadata write command: {args}")

        with patch("media_dates.subprocess.run", side_effect=fake_run):
            response_text = self._run_import(
                library_path,
                db_path,
                source_path,
                exif_date="2080:01:01 00:09:00",
                write_side_effect=AssertionError("photo writer should not be used for MOV"),
            )

        self.assertIn('"event": "imported"', response_text)
        self.assertIn('"errors": 0', response_text)
        row = self._read_single_row(db_path)
        self.assertEqual(row["date_taken"], "2080:01:01 00:09:00")
        self.assertTrue(row["current_path"].startswith("2080/2080-01-01/"))

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

    def test_convert_preflight_reports_counts_non_media_and_eta(self):
        library_path, _ = self._make_convert_library(
            "convert-preflight-lib",
            "photo.jpg",
            b"photo",
            123,
        )
        video_path = os.path.join(library_path, "incoming", "clip.mov")
        with open(video_path, "wb") as handle:
            handle.write(b"video")
        notes_path = os.path.join(library_path, "incoming", "notes.txt")
        with open(notes_path, "wb") as handle:
            handle.write(b"notes")

        response = self.client.post(
            "/api/library/terraform/scan",
            json={"library_path": library_path},
        )

        self.assertEqual(response.status_code, 200)
        payload = response.get_json()
        self.assertEqual(payload["status"], "INVENTORY")
        self.assertEqual(payload["photo_count"], 1)
        self.assertEqual(payload["video_count"], 1)
        self.assertEqual(payload["media_count"], 2)
        self.assertEqual(payload["non_media_count"], 1)
        self.assertIn("estimated_display", payload)

    def test_convert_final_audit_blocks_completion(self):
        payload = b"convert-audit-failure"
        library_path, _ = self._make_convert_library(
            "convert-audit-failure-lib",
            "audit.jpg",
            payload,
            123,
        )

        def fake_write_photo_exif(file_path, target_date):
            with open(file_path, "ab") as handle:
                handle.write(b"|canonical-date|" + target_date.encode("utf-8"))

        response_text = self._run_convert(
            library_path,
            exif_date=None,
            write_side_effect=fake_write_photo_exif,
            audit_issues=[
                {
                    "kind": "misnamed_or_misfiled",
                    "path": "incoming/audit.jpg",
                    "detail": "expected canonical path",
                }
            ],
        )

        self.assertIn("event: error", response_text)
        self.assertIn("Final verification failed", response_text)
        self.assertNotIn("event: complete", response_text)

    def test_convert_removes_empty_source_year_folder_after_rehousing(self):
        payload = b"convert-empty-year-folder"
        library_path = os.path.join(self.tmpdir.name, "convert-empty-year-lib")
        old_year_dir = os.path.join(library_path, "2080")
        old_source_dir = os.path.join(old_year_dir, "1999", "1999-11-27")
        source_path = os.path.join(old_source_dir, "source.jpg")
        os.makedirs(old_source_dir, exist_ok=True)
        with open(source_path, "wb") as handle:
            handle.write(payload)
        os.utime(source_path, (123, 123))

        def fake_write_photo_exif(file_path, target_date):
            with open(file_path, "ab") as handle:
                handle.write(b"|canonical-date|" + target_date.encode("utf-8"))

        response_text = self._run_convert(
            library_path,
            exif_date="1999:11:27 09:41:44",
            write_side_effect=fake_write_photo_exif,
        )

        self.assertIn("event: complete", response_text)
        self.assertFalse(os.path.exists(old_year_dir))

    def test_convert_handles_healthy_library_nested_inside_date_folder(self):
        library_path = os.path.join(self.tmpdir.name, "convert-nested-library-lib")
        nested_root = os.path.join(library_path, "2080", "1999", "1999-11-27")
        os.makedirs(nested_root, exist_ok=True)

        for rel_path, payload in (
            (".library/photo_library.db", b"old-db"),
            (".logs/terraform_old.jsonl", b"old-log"),
            (".thumbnails/aa/bb/thumb.jpg", b"thumb-not-media"),
            (".trash/duplicates/old.jpg", b"trashed-not-media"),
        ):
            artifact_path = os.path.join(nested_root, rel_path)
            os.makedirs(os.path.dirname(artifact_path), exist_ok=True)
            with open(artifact_path, "wb") as handle:
                handle.write(payload)

        for index in range(17):
            photo_path = os.path.join(
                nested_root,
                "1999",
                "1999-11-27",
                f"photo-{index:02d}.jpg",
            )
            os.makedirs(os.path.dirname(photo_path), exist_ok=True)
            with open(photo_path, "wb") as handle:
                handle.write(f"photo-{index:02d}".encode("utf-8"))

        for index in range(2):
            video_path = os.path.join(
                nested_root,
                "1999",
                "1999-11-27",
                f"video-{index:02d}.mov",
            )
            with open(video_path, "wb") as handle:
                handle.write(f"video-{index:02d}".encode("utf-8"))

        preflight_response = self.client.post(
            "/api/library/terraform/scan",
            json={"library_path": library_path},
        )
        self.assertEqual(preflight_response.status_code, 200)
        preflight = preflight_response.get_json()
        self.assertEqual(preflight["photo_count"], 17)
        self.assertEqual(preflight["video_count"], 2)
        self.assertEqual(preflight["media_count"], 19)

        def fake_write_metadata(file_path, target_date):
            with open(file_path, "ab") as handle:
                handle.write(b"|canonical-date|" + target_date.encode("utf-8"))

        response_text = self._run_convert(
            library_path,
            exif_date="1999:11:27 09:41:44",
            write_side_effect=fake_write_metadata,
        )

        self.assertIn("event: complete", response_text)
        self.assertFalse(os.path.exists(os.path.join(library_path, "2080")))

        conn = sqlite3.connect(canonical_db_path(library_path))
        row_count = conn.execute("SELECT COUNT(*) FROM photos").fetchone()[0]
        photo_count = conn.execute(
            "SELECT COUNT(*) FROM photos WHERE file_type = 'photo'"
        ).fetchone()[0]
        video_count = conn.execute(
            "SELECT COUNT(*) FROM photos WHERE file_type = 'video'"
        ).fetchone()[0]
        conn.close()

        self.assertEqual(row_count, 19)
        self.assertEqual(photo_count, 17)
        self.assertEqual(video_count, 2)

    def test_convert_processes_media_inside_root_hidden_folder(self):
        library_path = os.path.join(self.tmpdir.name, "convert-hidden-media-lib")
        source_path = os.path.join(library_path, ".hidden-album", "deep", "photo.jpg")
        notes_path = os.path.join(library_path, ".hidden-album", "notes.txt")
        os.makedirs(os.path.dirname(source_path), exist_ok=True)
        with open(source_path, "wb") as handle:
            handle.write(b"hidden-photo")
        with open(notes_path, "wb") as handle:
            handle.write(b"notes")

        preflight_response = self.client.post(
            "/api/library/terraform/scan",
            json={"library_path": library_path},
        )
        self.assertEqual(preflight_response.status_code, 200)
        preflight = preflight_response.get_json()
        self.assertEqual(preflight["photo_count"], 1)
        self.assertEqual(preflight["media_count"], 1)

        def fake_write_metadata(file_path, target_date):
            with open(file_path, "ab") as handle:
                handle.write(b"|canonical-date|" + target_date.encode("utf-8"))

        response_text = self._run_convert(
            library_path,
            exif_date="1999:11:27 09:41:44",
            write_side_effect=fake_write_metadata,
        )

        self.assertIn("event: complete", response_text)
        self.assertFalse(os.path.exists(os.path.join(library_path, ".hidden-album")))
        self.assertEqual(len(self._read_rows(canonical_db_path(library_path))), 1)

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
                verify=True,
            )

        self.assertEqual(result["status"], "CLEAN")
        self.assertEqual(result["summary"]["issue_count"], 0)

    def test_convert_audit_green_when_compliance_strips_video_rating_zero(self):
        """Convert video path leaves rating=0 on disk; compliance must fix before audit."""
        payload = b"convert-video-rating-zero"
        library_path, _source_path = self._make_convert_library(
            "convert-rating-zero-mov",
            "clip.mov",
            payload,
            1_700_000_000,
        )

        stripped_paths = set()

        def extract_rating(path):
            return None if path in stripped_paths else 0

        def strip_rating(path):
            stripped_paths.add(path)
            return True

        def fake_write_video_metadata(file_path, target_date):
            with open(file_path, "ab") as handle:
                handle.write(b"|video-date|" + target_date.encode("utf-8"))

        with patch.object(photo_app, "extract_exif_rating", side_effect=extract_rating), patch.object(
            photo_app,
            "strip_exif_rating",
            side_effect=strip_rating,
        ), patch(
            "library_metadata_compliance.extract_exif_rating",
            side_effect=extract_rating,
        ), patch(
            "library_metadata_compliance.strip_exif_rating",
            side_effect=strip_rating,
        ), patch(
            "clean_library_fast_audit.extract_exif_rating",
            side_effect=extract_rating,
        ), patch.object(
            photo_app,
            "extract_exif_date",
            return_value="2026:01:27 12:00:00",
        ), patch.object(
            photo_app,
            "bake_orientation",
            return_value=(False, "No orientation flag", None),
        ), patch.object(
            photo_app,
            "get_image_dimensions",
            return_value=(640, 480),
        ), patch.object(
            photo_app,
            "write_video_metadata",
            side_effect=fake_write_video_metadata,
        ), patch(
            "clean_library_fast_audit.verify_media_file",
            return_value=(True, "mock"),
        ), patch(
            "library_metadata_compliance.verify_media_file",
            return_value=(True, "mock"),
        ), patch("app.subprocess.run", return_value=self.fake_subprocess_result):
            response = self.client.post(
                "/api/library/terraform",
                json={"library_path": library_path},
                buffered=True,
            )

        response_text = response.get_data(as_text=True)
        self.assertEqual(response.status_code, 200)
        self.assertIn('"phase": "compliance"', response_text)
        self.assertIn("event: complete", response_text)
        self.assertNotIn("final verification failed", response_text.lower())
        self.assertTrue(stripped_paths)
        self.assertEqual(len(self._read_rows(canonical_db_path(library_path))), 1)


if __name__ == "__main__":
    unittest.main()
