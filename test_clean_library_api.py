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
                "trash_candidates": 3,
                "db_repairs": 4,
                "metadata_fixes": 1,
                "layout_repairs": 5,
                "issue_count": 15,
            },
            "details": {
                "misfiled_media": ["foo.jpg"],
                "trash_candidates": ["bar.png"],
                "db_repairs": ["ghost.png"],
                "metadata_fixes": ["rot.jpg"],
                "layout_repairs": ["misc"],
            },
        }

        with patch("make_library_perfect.scan_library_cleanliness", return_value=scan_payload) as mock_scan:
            response = self.client.get("/api/library/make-perfect/scan")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json(), scan_payload)
        mock_scan.assert_called_once_with(self.library_path, db_path=self.db_path)


if __name__ == "__main__":
    unittest.main()
