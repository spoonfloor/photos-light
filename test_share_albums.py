import os
import sqlite3
import tempfile
import unittest
import unittest.mock

from share_albums import (
    SharePublishError,
    bytes_to_display_mb,
    build_share_url,
    format_album_label,
    format_album_created_date,
    generate_access_token,
    generate_share_slug,
    get_share_storage_max_bytes,
    partition_share_photos_by_size,
    suggest_share_title,
    validate_photos_for_share,
    SHARE_DEFAULT_STORAGE_MAX_BYTES,
)


class ShareAlbumsTest(unittest.TestCase):
    def test_generate_share_slug_length(self):
        slug = generate_share_slug(12)
        self.assertEqual(len(slug), 12)
        self.assertTrue(slug.isalnum())
        self.assertTrue(slug.islower() or any(ch.isdigit() for ch in slug))

    def test_generate_access_token_length(self):
        token = generate_access_token(32)
        self.assertEqual(len(token), 32)

    def test_suggest_share_title_single_day(self):
        title = suggest_share_title(["2026:02:26 14:30:00", "2026:02:26 09:00:00"])
        self.assertEqual(title, "Feb 26 Photos")

    def test_suggest_share_title_single_month(self):
        title = suggest_share_title(["2026:02:01 10:00:00", "2026:02:20 10:00:00"])
        self.assertEqual(title, "February 2026 Photos")

    def test_validate_photos_for_share_accepts_sqlite_row(self):
        with tempfile.TemporaryDirectory() as library_path:
            photo_path = os.path.join(library_path, "2026", "sample.jpg")
            os.makedirs(os.path.dirname(photo_path), exist_ok=True)
            with open(photo_path, "wb") as handle:
                handle.write(b"fake")

            conn = sqlite3.connect(":memory:")
            conn.row_factory = sqlite3.Row
            cursor = conn.cursor()
            cursor.execute(
                "CREATE TABLE photos (id INTEGER, current_path TEXT)"
            )
            cursor.execute(
                "INSERT INTO photos (id, current_path) VALUES (?, ?)",
                (42, "2026/sample.jpg"),
            )
            row = cursor.execute(
                "SELECT id, current_path FROM photos WHERE id = 42"
            ).fetchone()
            conn.close()

            validate_photos_for_share(library_path, [row])

    def test_validate_photos_for_share_missing_file(self):
        with tempfile.TemporaryDirectory() as library_path:
            row = {"id": 7, "current_path": "missing/photo.jpg"}
            with self.assertRaises(SharePublishError) as ctx:
                validate_photos_for_share(library_path, [row])
            self.assertEqual(ctx.exception.code, "share_file_missing")

    def test_partition_share_photos_by_size(self):
        with tempfile.TemporaryDirectory() as library_path:
            small_path = os.path.join(library_path, "small.jpg")
            large_path = os.path.join(library_path, "large.jpg")
            with open(small_path, "wb") as handle:
                handle.write(b"x" * 1000)
            with open(large_path, "wb") as handle:
                handle.write(b"x" * 2000)

            rows = [
                {"id": 1, "current_path": "small.jpg"},
                {"id": 2, "current_path": "large.jpg"},
            ]
            oversized, shareable = partition_share_photos_by_size(
                library_path,
                rows,
                max_bytes=1500,
            )
            self.assertEqual(shareable, [1])
            self.assertEqual(len(oversized), 1)
            self.assertEqual(oversized[0]["photo_id"], 2)
            self.assertEqual(oversized[0]["filename"], "large.jpg")

    def test_get_share_storage_max_bytes_uses_env_and_bucket(self):
        old_bytes = os.environ.get("SHARE_STORAGE_MAX_BYTES")
        os.environ["SHARE_STORAGE_MAX_BYTES"] = str(40 * 1024 * 1024)
        try:
            with unittest.mock.patch(
                "share_albums.fetch_share_bucket_file_size_limit",
                return_value=500 * 1024 * 1024,
            ):
                self.assertEqual(get_share_storage_max_bytes(), 40 * 1024 * 1024)
        finally:
            if old_bytes is None:
                os.environ.pop("SHARE_STORAGE_MAX_BYTES", None)
            else:
                os.environ["SHARE_STORAGE_MAX_BYTES"] = old_bytes

    def test_get_share_storage_max_bytes_defaults_without_env(self):
        old_bytes = os.environ.pop("SHARE_STORAGE_MAX_BYTES", None)
        old_mb = os.environ.pop("SHARE_STORAGE_MAX_MB", None)
        try:
            with unittest.mock.patch(
                "share_albums.fetch_share_bucket_file_size_limit",
                return_value=None,
            ):
                self.assertEqual(
                    get_share_storage_max_bytes(),
                    SHARE_DEFAULT_STORAGE_MAX_BYTES,
                )
        finally:
            if old_bytes is not None:
                os.environ["SHARE_STORAGE_MAX_BYTES"] = old_bytes
            if old_mb is not None:
                os.environ["SHARE_STORAGE_MAX_MB"] = old_mb

    def test_build_share_url(self):
        os.environ["SHARE_VIEWER_BASE_URL"] = "https://example.com/viewer"
        self.assertEqual(
            build_share_url("abc123token", "https://example.com/viewer"),
            "https://example.com/viewer/?t=abc123token",
        )

    def test_format_album_label_with_title(self):
        label = format_album_label(
            "Tahoe Fun Times",
            "2026-08-18T12:00:00+00:00",
        )
        self.assertEqual(label, "Tahoe Fun Times (Aug 18 2026)")

    def test_format_album_label_without_title(self):
        label = format_album_label(None, "2026-08-17T12:00:00+00:00")
        self.assertEqual(label, "Aug 17 2026")

    def test_format_album_created_date(self):
        self.assertEqual(
            format_album_created_date("2026-08-18T12:00:00+00:00"),
            "Aug 18 2026",
        )

    def test_format_album_created_date_postgres_fractional_seconds(self):
        self.assertEqual(
            format_album_created_date("2026-08-18T23:59:40.19901+00:00"),
            "Aug 18 2026",
        )
        self.assertEqual(
            format_album_created_date("2026-08-18T23:48:42.95229+00:00"),
            "Aug 18 2026",
        )


if __name__ == "__main__":
    unittest.main()
