import json
import os
import sqlite3
import unittest
from tempfile import TemporaryDirectory
from unittest.mock import patch

import app as photo_app
from db_health import DBStatus, check_database_health
from db_schema import create_database_schema
from library_layout import canonical_db_path


def create_photos_only_db(db_path, *, include_rating=True, extra_columns=None):
    """Create a minimal photos table fixture for DB health classification tests."""
    os.makedirs(os.path.dirname(db_path), exist_ok=True)

    columns = [
        "id INTEGER PRIMARY KEY AUTOINCREMENT",
        "original_filename TEXT NOT NULL",
        "current_path TEXT NOT NULL UNIQUE",
        "date_taken TEXT",
        "content_hash TEXT NOT NULL UNIQUE",
        "file_size INTEGER NOT NULL",
        "file_type TEXT NOT NULL",
        "width INTEGER",
        "height INTEGER",
    ]
    if include_rating:
        columns.append("rating INTEGER DEFAULT NULL")
    if extra_columns:
        columns.extend(extra_columns)

    conn = sqlite3.connect(db_path)
    conn.execute(f"CREATE TABLE photos ({', '.join(columns)})")
    conn.commit()
    conn.close()


class DBHealthMatrixTest(unittest.TestCase):
    def setUp(self):
        self.tmpdir = TemporaryDirectory()

    def tearDown(self):
        self.tmpdir.cleanup()

    def test_missing_database_reports_missing(self):
        db_path = os.path.join(self.tmpdir.name, "missing.db")

        report = check_database_health(db_path)

        self.assertEqual(report.status, DBStatus.MISSING)
        self.assertTrue(report.can_create_new)
        self.assertFalse(report.can_use_anyway)

    def test_corrupt_database_reports_corrupted(self):
        db_path = os.path.join(self.tmpdir.name, "corrupt.db")
        with open(db_path, "w", encoding="utf-8") as fh:
            fh.write("not a sqlite database")

        report = check_database_health(db_path)

        self.assertEqual(report.status, DBStatus.CORRUPTED)
        self.assertIn("database", report.error_message.lower())
        self.assertFalse(report.can_use_anyway)

    def test_missing_columns_reports_migration_needed(self):
        db_path = os.path.join(self.tmpdir.name, "missing_columns.db")
        create_photos_only_db(db_path, include_rating=False)

        report = check_database_health(db_path)

        self.assertEqual(report.status, DBStatus.MISSING_COLUMNS)
        self.assertEqual(report.missing_columns, ["rating"])
        self.assertTrue(report.can_migrate)
        self.assertTrue(report.can_use_anyway)

    def test_mixed_schema_reports_missing_and_extra_columns(self):
        db_path = os.path.join(self.tmpdir.name, "mixed_schema.db")
        create_photos_only_db(
            db_path,
            include_rating=False,
            extra_columns=["legacy_caption TEXT"],
        )

        report = check_database_health(db_path)

        self.assertEqual(report.status, DBStatus.MIXED_SCHEMA)
        self.assertEqual(report.missing_columns, ["rating"])
        self.assertEqual(report.extra_columns, ["legacy_caption"])
        self.assertTrue(report.can_migrate)
        self.assertTrue(report.can_use_anyway)


class DBHealthRouteConsistencyTest(unittest.TestCase):
    def setUp(self):
        self.tmpdir = TemporaryDirectory()
        self.config_path = os.path.join(self.tmpdir.name, "config.json")
        self.config_patcher = patch.object(photo_app, "CONFIG_FILE", self.config_path)
        self.config_patcher.start()

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
        self.config_patcher.stop()
        self.tmpdir.cleanup()

    def _make_library(self, name):
        library_path = os.path.join(self.tmpdir.name, name)
        os.makedirs(library_path, exist_ok=True)
        return library_path

    def _write_config(self, library_path, db_path):
        with open(self.config_path, "w", encoding="utf-8") as fh:
            json.dump({"library_path": library_path, "db_path": db_path}, fh)

    def _create_healthy_db(self, library_path):
        db_path = canonical_db_path(library_path)
        os.makedirs(os.path.dirname(db_path), exist_ok=True)
        conn = sqlite3.connect(db_path)
        create_database_schema(conn.cursor())
        conn.commit()
        conn.close()
        return db_path

    def test_library_status_missing_db_becomes_not_configured_and_clears_config(self):
        library_path = self._make_library("missing-db-library")
        db_path = canonical_db_path(library_path)
        self._write_config(library_path, db_path)

        response = self.client.get("/api/library/status")

        self.assertEqual(response.status_code, 200)
        payload = response.get_json()
        self.assertEqual(payload["status"], "not_configured")
        self.assertFalse(payload["valid"])
        self.assertIsNone(payload["library_path"])
        self.assertFalse(os.path.exists(self.config_path))

    def test_library_status_missing_columns_becomes_needs_migration(self):
        library_path = self._make_library("missing-columns-library")
        db_path = canonical_db_path(library_path)
        create_photos_only_db(db_path, include_rating=False)
        self._write_config(library_path, db_path)

        response = self.client.get("/api/library/status")

        self.assertEqual(response.status_code, 200)
        payload = response.get_json()
        self.assertEqual(payload["status"], "needs_migration")
        self.assertEqual(payload["missing_columns"], ["rating"])
        self.assertTrue(payload["can_continue"])
        self.assertEqual(payload["library_path"], library_path)

    def test_switch_library_missing_db_requires_create_new(self):
        library_path = self._make_library("switch-missing-db")

        response = self.client.post("/api/library/switch", json={"library_path": library_path})

        self.assertEqual(response.status_code, 400)
        payload = response.get_json()
        self.assertEqual(payload["status"], "needs_action")
        self.assertEqual(payload["action"], "create_new")

    def test_switch_library_corrupted_db_requires_rebuild(self):
        library_path = self._make_library("switch-corrupt-db")
        db_path = canonical_db_path(library_path)
        os.makedirs(os.path.dirname(db_path), exist_ok=True)
        with open(db_path, "w", encoding="utf-8") as fh:
            fh.write("not a sqlite database")

        response = self.client.post("/api/library/switch", json={"library_path": library_path})

        self.assertEqual(response.status_code, 400)
        payload = response.get_json()
        self.assertEqual(payload["status"], "needs_action")
        self.assertEqual(payload["action"], "rebuild")
        self.assertIn("database", payload["error"].lower())

    def test_switch_library_missing_columns_requires_migration(self):
        library_path = self._make_library("switch-missing-columns")
        db_path = canonical_db_path(library_path)
        create_photos_only_db(db_path, include_rating=False)

        response = self.client.post("/api/library/switch", json={"library_path": library_path})

        self.assertEqual(response.status_code, 400)
        payload = response.get_json()
        self.assertEqual(payload["status"], "needs_migration")
        self.assertEqual(payload["action"], "migrate")
        self.assertEqual(payload["missing_columns"], ["rating"])
        self.assertTrue(payload["can_continue"])

    def test_switch_library_extra_columns_still_succeeds(self):
        library_path = self._make_library("switch-extra-columns")
        db_path = canonical_db_path(library_path)
        create_photos_only_db(db_path, extra_columns=["legacy_caption TEXT"])

        response = self.client.post("/api/library/switch", json={"library_path": library_path})

        self.assertEqual(response.status_code, 200)
        payload = response.get_json()
        self.assertEqual(payload["status"], "success")
        self.assertEqual(payload["library_path"], library_path)
        self.assertEqual(payload["db_path"], db_path)
        self.assertEqual(photo_app.LIBRARY_PATH, library_path)
        self.assertEqual(photo_app.DB_PATH, db_path)
        self.assertTrue(os.path.exists(self.config_path))

    def test_switch_library_healthy_db_succeeds(self):
        library_path = self._make_library("switch-healthy")
        db_path = self._create_healthy_db(library_path)

        response = self.client.post("/api/library/switch", json={"library_path": library_path})

        self.assertEqual(response.status_code, 200)
        payload = response.get_json()
        self.assertEqual(payload["status"], "success")
        self.assertEqual(payload["library_path"], library_path)
        self.assertEqual(payload["db_path"], db_path)

    def test_library_probe_reports_openable_db_for_healthy_library(self):
        library_path = self._make_library("probe-healthy")
        db_path = self._create_healthy_db(library_path)

        response = self.client.post("/api/library/probe", json={"library_path": library_path})

        self.assertEqual(response.status_code, 200)
        payload = response.get_json()
        self.assertEqual(payload["library_path"], library_path)
        self.assertTrue(payload["has_db"])
        self.assertTrue(payload["has_openable_db"])
        self.assertEqual(payload["db_path"], db_path)

    def test_library_probe_reports_non_openable_db_for_corrupt_library(self):
        library_path = self._make_library("probe-corrupt")
        db_path = canonical_db_path(library_path)
        os.makedirs(os.path.dirname(db_path), exist_ok=True)
        with open(db_path, "w", encoding="utf-8") as fh:
            fh.write("not a sqlite database")

        response = self.client.post("/api/library/probe", json={"library_path": library_path})

        self.assertEqual(response.status_code, 200)
        payload = response.get_json()
        self.assertTrue(payload["has_db"])
        self.assertFalse(payload["has_openable_db"])
        self.assertEqual(payload["db_path"], db_path)

    def test_library_check_uses_openable_db_not_raw_db_existence(self):
        library_path = self._make_library("check-corrupt")
        db_path = canonical_db_path(library_path)
        os.makedirs(os.path.dirname(db_path), exist_ok=True)
        with open(db_path, "w", encoding="utf-8") as fh:
            fh.write("not a sqlite database")

        response = self.client.post("/api/library/check", json={"library_path": library_path})

        self.assertEqual(response.status_code, 200)
        payload = response.get_json()
        self.assertTrue(payload["has_db"])
        self.assertFalse(payload["has_openable_db"])
        self.assertFalse(payload["exists"])
        self.assertEqual(payload["db_status"], DBStatus.CORRUPTED.value)
        self.assertEqual(payload["db_path"], db_path)

    def test_library_check_reports_desktop_like_warning(self):
        library_path = self._make_library("check-desktop-like")
        with open(os.path.join(library_path, "report.pdf"), "w", encoding="utf-8") as fh:
            fh.write("notes")
        with open(os.path.join(library_path, "todo.docx"), "w", encoding="utf-8") as fh:
            fh.write("notes")

        response = self.client.post("/api/library/check", json={"library_path": library_path})

        self.assertEqual(response.status_code, 200)
        payload = response.get_json()
        self.assertTrue(payload["folder_warning"]["show"])
        self.assertTrue(payload["folder_warning"]["obvious_signals_present"])

    def test_get_photos_keeps_null_dates_and_infers_month_from_canonical_path(self):
        library_path = self._make_library("photos-null-dates")
        db_path = self._create_healthy_db(library_path)

        conn = sqlite3.connect(db_path)
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
                height,
                rating
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                "dated.jpg",
                "2024/2024-01-03/img_20240103_deadbeef.jpg",
                "2024:01:03 10:11:12",
                "deadbeef000000000000000000000000",
                123,
                "photo",
                1,
                1,
                None,
            ),
        )
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
                height,
                rating
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                "undated.jpg",
                "2025/2025-04-15/img_20250415_feedface.jpg",
                None,
                "feedface000000000000000000000000",
                456,
                "photo",
                1,
                1,
                None,
            ),
        )
        conn.commit()
        conn.close()

        photo_app.LIBRARY_PATH = library_path
        photo_app.DB_PATH = db_path

        response = self.client.get("/api/photos?sort=newest")

        self.assertEqual(response.status_code, 200)
        payload = response.get_json()
        self.assertEqual(payload["count"], 2)
        self.assertEqual([photo["path"] for photo in payload["photos"]], [
            "2024/2024-01-03/img_20240103_deadbeef.jpg",
            "2025/2025-04-15/img_20250415_feedface.jpg",
        ])
        self.assertEqual(payload["photos"][0]["month"], "2024-01")
        self.assertIsNone(payload["photos"][1]["date"])
        self.assertEqual(payload["photos"][1]["month"], "2025-04")

    def test_recover_database_quarantines_corrupt_db_and_creates_usable_canonical_db(self):
        library_path = self._make_library("recover-corrupt")
        db_path = canonical_db_path(library_path)
        os.makedirs(os.path.dirname(db_path), exist_ok=True)
        with open(db_path, "w", encoding="utf-8") as fh:
            fh.write("not a sqlite database")
        with open(f"{db_path}-wal", "w", encoding="utf-8") as fh:
            fh.write("sidecar")

        response = self.client.post(
            "/api/library/recover-database",
            json={"library_path": library_path},
        )

        self.assertEqual(response.status_code, 200)
        payload = response.get_json()
        self.assertEqual(payload["status"], "recovered")
        self.assertEqual(payload["db_path"], db_path)
        self.assertTrue(os.path.exists(db_path))
        self.assertFalse(os.path.exists(f"{db_path}-wal"))
        self.assertGreaterEqual(len(payload["quarantined_paths"]), 1)
        for backup_path in payload["quarantined_paths"]:
            self.assertTrue(os.path.exists(backup_path))

        report = check_database_health(db_path)
        self.assertEqual(report.status, DBStatus.HEALTHY)

    def test_recover_database_quarantines_unexpected_library_metadata_artifacts(self):
        library_path = self._make_library("recover-stray-metadata")
        db_path = canonical_db_path(library_path)
        metadata_dir = os.path.dirname(db_path)
        os.makedirs(metadata_dir, exist_ok=True)
        stray_artifact = os.path.join(metadata_dir, "photo_library.db.zip")
        with open(stray_artifact, "w", encoding="utf-8") as fh:
            fh.write("backup bytes")

        response = self.client.post(
            "/api/library/recover-database",
            json={"library_path": library_path},
        )

        self.assertEqual(response.status_code, 200)
        payload = response.get_json()
        self.assertEqual(payload["status"], "recovered")
        self.assertTrue(os.path.exists(db_path))
        self.assertFalse(os.path.exists(stray_artifact))
        self.assertTrue(
            any(path.endswith("photo_library.db.zip") for path in payload["quarantined_paths"])
        )
        for backup_path in payload["quarantined_paths"]:
            self.assertTrue(os.path.exists(backup_path))

    def test_list_directory_separates_db_presence_from_openable_db(self):
        library_path = self._make_library("list-directory-corrupt")
        db_path = canonical_db_path(library_path)
        os.makedirs(os.path.dirname(db_path), exist_ok=True)
        with open(db_path, "w", encoding="utf-8") as fh:
            fh.write("not a sqlite database")

        response = self.client.post("/api/filesystem/list-directory", json={"path": library_path})

        self.assertEqual(response.status_code, 200)
        payload = response.get_json()
        self.assertTrue(payload["has_db"])
        self.assertFalse(payload["has_openable_db"])
        self.assertEqual(payload["current_path"], library_path)


if __name__ == "__main__":
    unittest.main()
