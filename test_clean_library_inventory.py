import os
import unittest
from tempfile import TemporaryDirectory

from clean_library_inventory import (
    estimate_clean_duration_seconds,
    estimate_remaining_duration_seconds,
    format_about_duration,
    inventory_media_library,
)


class CleanLibraryInventoryTest(unittest.TestCase):
    def test_format_about_duration_hours(self):
        _sec, display = format_about_duration(86 * 3600)
        self.assertEqual(display, "about 86 hours")

    def test_inventory_counts_photos_and_videos(self):
        with TemporaryDirectory() as tmpdir:
            os.makedirs(os.path.join(tmpdir, "a"), exist_ok=True)
            with open(os.path.join(tmpdir, "a", "one.jpg"), "wb") as handle:
                handle.write(b"x" * 1000)
            with open(os.path.join(tmpdir, "a", "two.mov"), "wb") as handle:
                handle.write(b"y" * 2_000_000)

            result = inventory_media_library(tmpdir)
            self.assertEqual(result["photo_count"], 1)
            self.assertEqual(result["video_count"], 1)
            self.assertEqual(result["media_count"], 2)
            self.assertGreater(result["estimated_seconds"], 0)
            self.assertIn(
                result["estimated_display"],
                {"less than a minute", "about 1 minute"},
            )

    def test_estimate_remaining_scales_with_scan_progress(self):
        inventory = {
            "media_count": 100,
            "estimated_seconds": 1000.0,
        }
        half = estimate_remaining_duration_seconds(
            inventory,
            phase="scan",
            scan_completed_count=50,
        )
        self.assertAlmostEqual(half, 500.0, delta=1.0)


if __name__ == "__main__":
    unittest.main()
