import os
import unittest
from tempfile import TemporaryDirectory

from library_sync import count_media_files, count_media_files_by_type


class LibrarySyncMediaCountingTest(unittest.TestCase):
    def test_count_media_files_uses_shared_extension_policy_and_skips_hidden_dirs(self):
        with TemporaryDirectory() as tmpdir:
            visible_dir = os.path.join(tmpdir, "2026", "2026-04-12")
            hidden_dir = os.path.join(tmpdir, ".trash")
            os.makedirs(visible_dir, exist_ok=True)
            os.makedirs(hidden_dir, exist_ok=True)

            with open(os.path.join(visible_dir, "photo.JPG"), "wb") as fh:
                fh.write(b"photo")
            with open(os.path.join(visible_dir, "clip.WEBM"), "wb") as fh:
                fh.write(b"video")
            with open(os.path.join(visible_dir, "notes.txt"), "wb") as fh:
                fh.write(b"text")
            with open(os.path.join(hidden_dir, "ignored.jpg"), "wb") as fh:
                fh.write(b"hidden")

            self.assertEqual(count_media_files(tmpdir), 2)
            self.assertEqual(
                count_media_files_by_type(tmpdir),
                {"photo_count": 1, "video_count": 1, "total_count": 2},
            )


if __name__ == "__main__":
    unittest.main()
