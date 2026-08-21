"""Tests for import path scanning and browser drop staging."""

from __future__ import annotations

import io
import json
import os
import unittest
from tempfile import TemporaryDirectory

import import_scan
from werkzeug.datastructures import FileStorage


class ImportScanTest(unittest.TestCase):
    def setUp(self):
        self.tmpdir = TemporaryDirectory()

    def tearDown(self):
        self.tmpdir.cleanup()

    def test_scan_media_paths_counts_photos_and_videos(self):
        source_dir = os.path.join(self.tmpdir.name, "source")
        os.makedirs(source_dir, exist_ok=True)
        photo_path = os.path.join(source_dir, "photo.jpg")
        video_path = os.path.join(source_dir, "clip.mov")
        with open(photo_path, "wb") as handle:
            handle.write(b"photo")
        with open(video_path, "wb") as handle:
            handle.write(b"video" * 10)

        result = import_scan.scan_media_paths([source_dir])

        self.assertEqual(result.total_count, 2)
        self.assertEqual(result.photo_count, 1)
        self.assertEqual(result.video_count, 1)
        self.assertIn(photo_path, result.files)
        self.assertIn(video_path, result.files)

    def test_scan_media_paths_skips_hidden_paths(self):
        source_dir = os.path.join(self.tmpdir.name, "source")
        hidden_dir = os.path.join(source_dir, ".hidden")
        os.makedirs(hidden_dir, exist_ok=True)
        visible_photo = os.path.join(source_dir, "photo.jpg")
        hidden_photo = os.path.join(hidden_dir, "secret.jpg")
        with open(visible_photo, "wb") as handle:
            handle.write(b"photo")
        with open(hidden_photo, "wb") as handle:
            handle.write(b"secret")

        result = import_scan.scan_media_paths([source_dir])

        self.assertEqual(result.total_count, 1)
        self.assertEqual(result.files, [visible_photo])

    def test_stage_drop_uploads_scans_and_cleans_up(self):
        uploads = [
            (
                FileStorage(
                    stream=io.BytesIO(b"photo-bytes"),
                    filename="photo.jpg",
                ),
                "photo.jpg",
            ),
            (
                FileStorage(
                    stream=io.BytesIO(b"video-bytes"),
                    filename="nested/clip.mov",
                ),
                "nested/clip.mov",
            ),
        ]

        batch_id, result = import_scan.stage_drop_uploads(uploads)

        self.assertEqual(result.total_count, 2)
        self.assertEqual(result.photo_count, 1)
        self.assertEqual(result.video_count, 1)
        batch_root = import_scan._drop_batch_root(batch_id)
        self.assertTrue(os.path.isdir(batch_root))
        manifest_path = os.path.join(batch_root, "manifest.json")
        self.assertTrue(os.path.isfile(manifest_path))

        deleted = import_scan.delete_drop_batch(batch_id)
        self.assertTrue(deleted)
        self.assertFalse(os.path.exists(batch_root))

    def test_stage_drop_uses_system_temp_not_dot_folder(self):
        uploads = [
            (
                FileStorage(
                    stream=io.BytesIO(b"photo-bytes"),
                    filename="photo.jpg",
                ),
                "photo.jpg",
            ),
        ]

        batch_id, _result = import_scan.stage_drop_uploads(uploads)
        batch_root = import_scan._drop_batch_root(batch_id)

        self.assertIn(import_scan._DROP_BATCH_DIR, batch_root)
        self.assertNotIn(".import_temp", batch_root)


class ImportStageDropRouteTest(unittest.TestCase):
    def setUp(self):
        import app as photo_app

        self.photo_app = photo_app
        photo_app.app.config["TESTING"] = True
        photo_app.reset_test_library_state()
        self.client = photo_app.app.test_client()

    def tearDown(self):
        drops_dir = import_scan._DROP_BATCH_DIR
        if os.path.isdir(drops_dir):
            for entry in os.listdir(drops_dir):
                if entry.startswith(import_scan.DROP_BATCH_PREFIX):
                    import_scan.delete_drop_batch(entry.replace(import_scan.DROP_BATCH_PREFIX, ""))

    def test_stage_drop_route_returns_scan_payload(self):
        data = {
            "relative_paths": json.dumps(["photo.jpg"]),
        }
        data_bytes = io.BytesIO(b"photo-bytes")
        response = self.client.post(
            "/api/import/stage-drop",
            data={
                **data,
                "files": (data_bytes, "photo.jpg"),
            },
            content_type="multipart/form-data",
        )

        self.assertEqual(response.status_code, 200)
        payload = response.get_json()
        self.assertEqual(payload["total_count"], 1)
        self.assertEqual(payload["photo_count"], 1)
        self.assertIn("batch_id", payload)

        deleted = self.client.delete(f"/api/import/drop-batch/{payload['batch_id']}")
        self.assertEqual(deleted.status_code, 200)


if __name__ == "__main__":
    unittest.main()
