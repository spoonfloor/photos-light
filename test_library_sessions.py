"""Multi-client library session isolation tests."""

from __future__ import annotations

import os
import sqlite3
import unittest
from tempfile import TemporaryDirectory

import app as photo_app
from db_schema import create_database_schema
from library_context import SESSION_HEADER_NAME, session_registry
from library_layout import canonical_db_path


def _create_library(root: str, name: str) -> tuple[str, str]:
    library_path = os.path.join(root, name)
    os.makedirs(library_path, exist_ok=True)
    db_path = canonical_db_path(library_path)
    os.makedirs(os.path.dirname(db_path), exist_ok=True)
    conn = sqlite3.connect(db_path)
    create_database_schema(conn.cursor())
    conn.commit()
    conn.close()
    return library_path, db_path


def _insert_photo(db_path: str, rel_path: str) -> None:
    conn = sqlite3.connect(db_path)
    conn.execute(
        """
        INSERT INTO photos (
            original_filename, current_path, date_taken, content_hash,
            file_size, file_type, width, height, rating, date_added
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            os.path.basename(rel_path),
            rel_path,
            "2024:01:15 12:00:00",
            f"hash-{rel_path}",
            100,
            "jpg",
            100,
            100,
            None,
            "2024-01-15T12:00:00",
        ),
    )
    conn.commit()
    conn.close()


class LibrarySessionIsolationTest(unittest.TestCase):
    def setUp(self):
        photo_app.app.config["TESTING"] = True
        photo_app.reset_test_library_state()
        self.tmpdir = TemporaryDirectory()
        session_registry._sessions.clear()

        self.library_a, self.db_a = _create_library(self.tmpdir.name, "library-a")
        self.library_b, self.db_b = _create_library(self.tmpdir.name, "library-b")
        _insert_photo(self.db_a, "2024/2024-01-15/a.jpg")
        _insert_photo(self.db_b, "2024/2024-01-15/b.jpg")

        self.client_a = photo_app.app.test_client()
        self.client_b = photo_app.app.test_client()
        self.headers_a = {SESSION_HEADER_NAME: "session-a"}
        self.headers_b = {SESSION_HEADER_NAME: "session-b"}

    def tearDown(self):
        session_registry._sessions.clear()
        photo_app.clear_library_session()
        self.tmpdir.cleanup()

    def _switch(self, client, library_path, db_path, headers):
        response = client.post(
            "/api/library/switch",
            json={"library_path": library_path, "db_path": db_path},
            headers=headers,
        )
        self.assertEqual(response.status_code, 200, response.get_json())
        return response.get_json()

    def test_two_sessions_keep_independent_libraries(self):
        self._switch(self.client_a, self.library_a, self.db_a, self.headers_a)
        self._switch(self.client_b, self.library_b, self.db_b, self.headers_b)

        current_a = self.client_a.get("/api/library/current", headers=self.headers_a).get_json()
        current_b = self.client_b.get("/api/library/current", headers=self.headers_b).get_json()

        self.assertEqual(os.path.abspath(current_a["library_path"]), os.path.abspath(self.library_a))
        self.assertEqual(os.path.abspath(current_b["library_path"]), os.path.abspath(self.library_b))

        status_a = self.client_a.get("/api/library/status", headers=self.headers_a).get_json()
        status_b = self.client_b.get("/api/library/status", headers=self.headers_b).get_json()
        self.assertEqual(status_a["status"], "healthy")
        self.assertEqual(status_b["status"], "healthy")

        photos_a = self.client_a.get("/api/photos?limit=10", headers=self.headers_a).get_json()
        photos_b = self.client_b.get("/api/photos?limit=10", headers=self.headers_b).get_json()
        self.assertEqual(photos_a["count"], 1)
        self.assertEqual(photos_b["count"], 1)
        self.assertIn("a.jpg", photos_a["photos"][0]["path"])
        self.assertIn("b.jpg", photos_b["photos"][0]["path"])

    def test_switch_in_one_session_does_not_change_the_other(self):
        self._switch(self.client_a, self.library_a, self.db_a, self.headers_a)
        self._switch(self.client_b, self.library_b, self.db_b, self.headers_b)
        self._switch(self.client_b, self.library_a, self.db_a, self.headers_b)

        current_a = self.client_a.get("/api/library/current", headers=self.headers_a).get_json()
        current_b = self.client_b.get("/api/library/current", headers=self.headers_b).get_json()

        self.assertEqual(os.path.abspath(current_a["library_path"]), os.path.abspath(self.library_a))
        self.assertEqual(os.path.abspath(current_b["library_path"]), os.path.abspath(self.library_a))

        photos_a = self.client_a.get("/api/photos?limit=10", headers=self.headers_a).get_json()
        self.assertEqual(photos_a["count"], 1)
        self.assertIn("a.jpg", photos_a["photos"][0]["path"])

    def test_reset_clears_only_requesting_session(self):
        self._switch(self.client_a, self.library_a, self.db_a, self.headers_a)
        self._switch(self.client_b, self.library_b, self.db_b, self.headers_b)

        response = self.client_a.delete("/api/library/reset", headers=self.headers_a)
        self.assertEqual(response.status_code, 200)

        status_a = self.client_a.get("/api/library/status", headers=self.headers_a).get_json()
        status_b = self.client_b.get("/api/library/status", headers=self.headers_b).get_json()
        self.assertEqual(status_a["status"], "not_configured")
        self.assertEqual(status_b["status"], "healthy")


if __name__ == "__main__":
    unittest.main()
