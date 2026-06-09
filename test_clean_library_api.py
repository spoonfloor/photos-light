import os
import sqlite3
import unittest
from tempfile import TemporaryDirectory
from unittest.mock import patch

import app as photo_app
from db_schema import create_database_schema
from library_layout import canonical_db_path


class CleanLibraryApiTest(unittest.TestCase):
    def setUp(self):
        self.tmpdir = TemporaryDirectory()
        self.library_path = os.path.join(self.tmpdir.name, "library")
        os.makedirs(self.library_path, exist_ok=True)
        self.db_path = canonical_db_path(self.library_path)
        os.makedirs(os.path.dirname(self.db_path), exist_ok=True)

        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        create_database_schema(conn.cursor())
        conn.commit()
        conn.close()

        self.original_paths = (
            photo_app.LIBRARY_PATH,
            photo_app.DB_PATH,
            photo_app.THUMBNAIL_CACHE_DIR,
            photo_app.TRASH_DIR,
            photo_app.DB_BACKUP_DIR,
            photo_app.IMPORT_TEMP_DIR,
            photo_app.LOG_DIR,
        )
        photo_app.update_app_paths(self.library_path, self.db_path)
        photo_app.app.config["TESTING"] = True
        self.client = photo_app.app.test_client()

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

    def test_clean_library_scan_route_uses_real_cleaner_scan(self):
        scan_payload = {
            "status": "DIRTY",
            "summary": {
                "misfiled_media": 2,
                "duplicates": 1,
                "unsupported_files": 2,
                "database_repairs": 4,
                "metadata_cleanup": 1,
                "issue_count": 15,
            },
            "details": {
                "misfiled_media": [{"kind": "misnamed_or_misfiled", "path": "foo.jpg", "message": "foo.jpg should be filed as 1900/x.jpg"}],
                "duplicates": [{"kind": "duplicate_media", "path": "dup.jpg", "message": "dup.jpg duplicates keep.jpg"}],
                "unsupported_files": [{"kind": "unsupported_or_nonmedia", "path": "bar.png", "message": "bar.png is not a supported media file"}],
                "database_repairs": [{"kind": "ghost_db_reference", "path": "ghost.png", "message": "ghost.png is missing on disk but still present in the database"}],
                "metadata_cleanup": [{"kind": "unbaked_rotation", "path": "rot.jpg", "message": "rot.jpg has unbaked rotation (8)"}],
            },
        }

        with patch("make_library_perfect.scan_library_cleanliness", return_value=scan_payload) as mock_scan:
            response = self.client.get("/api/library/make-perfect/scan")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json(), scan_payload)
        mock_scan.assert_called_once_with(
            self.library_path, db_path=self.db_path, verify=False
        )

    def test_clean_library_checkpoint_probe_none(self):
        with patch(
            "make_library_perfect.find_resumable_clean_library_checkpoint",
            return_value=None,
        ):
            response = self.client.get("/api/library/make-perfect/checkpoint")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json(), {"status": "NONE", "resumable": False})

    def test_clean_library_checkpoint_probe_resumable(self):
        checkpoint = {
            "phase": "scan",
            "scan_completed_count": 12,
            "canonicalize_index": 0,
            "manifest_path": "/tmp/manifest.jsonl",
            "_checkpoint_path": "/tmp/checkpoint.json",
        }
        with patch(
            "make_library_perfect.find_resumable_clean_library_checkpoint",
            return_value=checkpoint,
        ):
            response = self.client.get("/api/library/make-perfect/checkpoint")

        self.assertEqual(response.status_code, 200)
        payload = response.get_json()
        self.assertTrue(payload["resumable"])
        self.assertEqual(payload["resume"]["scan_completed_count"], 12)

    def test_clean_library_manifest_tail_returns_last_lines(self):
        logs_dir = os.path.join(self.library_path, ".logs")
        os.makedirs(logs_dir, exist_ok=True)
        manifest_path = os.path.join(logs_dir, "clean_library_test.jsonl")
        with open(manifest_path, "w", encoding="utf-8") as handle:
            for index in range(5):
                handle.write(f'{{"line": {index}}}\n')

        response = self.client.get(
            "/api/library/make-perfect/manifest-tail",
            query_string={"path": manifest_path, "lines": 2},
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()["lines"], ['{"line": 3}', '{"line": 4}'])

    def test_clean_library_manifest_tail_rejects_outside_logs(self):
        outside_path = os.path.join(self.tmpdir.name, "outside.jsonl")
        with open(outside_path, "w", encoding="utf-8") as handle:
            handle.write('{"line": 0}\n')

        response = self.client.get(
            "/api/library/make-perfect/manifest-tail",
            query_string={"path": outside_path},
        )

        self.assertEqual(response.status_code, 400)
        self.assertIn("Invalid manifest path", response.get_json()["error"])

    def test_import_scan_paths_returns_preflight_counts_and_estimate(self):
        source_dir = os.path.join(self.tmpdir.name, "import-source")
        os.makedirs(source_dir, exist_ok=True)
        photo_path = os.path.join(source_dir, "photo.jpg")
        video_path = os.path.join(source_dir, "clip.mov")
        note_path = os.path.join(source_dir, "notes.txt")

        with open(photo_path, "wb") as handle:
            handle.write(b"photo-bytes")
        with open(video_path, "wb") as handle:
            handle.write(b"video-bytes-video-bytes")
        with open(note_path, "wb") as handle:
            handle.write(b"not media")

        response = self.client.post(
            "/api/import/scan-paths",
            json={"paths": [source_dir]},
        )

        self.assertEqual(response.status_code, 200)
        payload = response.get_json()
        self.assertEqual(payload["status"], "success")
        self.assertEqual(payload["total_count"], 2)
        self.assertEqual(payload["photo_count"], 1)
        self.assertEqual(payload["video_count"], 1)
        self.assertEqual(payload["photo_bytes"], os.path.getsize(photo_path))
        self.assertEqual(payload["video_bytes"], os.path.getsize(video_path))
        self.assertGreater(payload["estimated_seconds"], 0)
        self.assertTrue(payload["estimated_display"])


if __name__ == "__main__":
    unittest.main()
