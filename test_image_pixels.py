#!/usr/bin/env python3

import os
import sys
import tempfile
import unittest
from unittest import mock

from PIL import Image

from library_cleanliness import RAW_PHOTO_EXTENSIONS

from image_pixels import (
    BROWSER_CONVERT_EXTENSIONS,
    THUMBNAIL_CACHE_VERSION,
    bake_heic_orientation_in_place,
    open_still_image,
    preview_decode_error_message,
    should_decode_with_sips,
    still_image_to_jpeg_buffer,
    thumbnail_cache_filename,
)


class ImagePixelsRoutingTests(unittest.TestCase):
    def test_heic_routes_to_sips_on_macos(self):
        with mock.patch("image_pixels.is_macos", return_value=True):
            self.assertTrue(should_decode_with_sips("/tmp/photo.heic"))
            self.assertTrue(should_decode_with_sips("/tmp/photo.HEIF"))
            self.assertFalse(should_decode_with_sips("/tmp/photo.jpg"))

    def test_raw_routes_to_sips_on_macos(self):
        with mock.patch("image_pixels.is_macos", return_value=True):
            for ext in RAW_PHOTO_EXTENSIONS:
                self.assertTrue(should_decode_with_sips(f"/tmp/photo{ext}"))
            self.assertFalse(should_decode_with_sips("/tmp/photo.tif"))

    def test_heic_does_not_route_to_sips_off_macos(self):
        with mock.patch("image_pixels.is_macos", return_value=False):
            self.assertFalse(should_decode_with_sips("/tmp/photo.heic"))

    def test_browser_convert_extensions_include_heic_and_tiff(self):
        self.assertIn(".heic", BROWSER_CONVERT_EXTENSIONS)
        self.assertIn(".tiff", BROWSER_CONVERT_EXTENSIONS)

    def test_browser_convert_extensions_include_raw_formats(self):
        for ext in RAW_PHOTO_EXTENSIONS:
            self.assertIn(ext, BROWSER_CONVERT_EXTENSIONS)
        self.assertNotIn(".jpg", BROWSER_CONVERT_EXTENSIONS)

    def test_preview_decode_error_message_detects_html_masquerading(self):
        with tempfile.NamedTemporaryFile(suffix=".dng", delete=False) as handle:
            temp_path = handle.name
            handle.write(b"<!DOCTYPE html><html><body>not an image</body></html>")
        try:
            message = preview_decode_error_message(temp_path, RuntimeError("sips failed"))
            self.assertIn("HTML", message)
        finally:
            os.remove(temp_path)

    def test_thumbnail_cache_version_bumps_legacy_cache(self):
        self.assertEqual(thumbnail_cache_filename("abc123"), f"abc123.{THUMBNAIL_CACHE_VERSION}.jpg")


class ImagePixelsDecodeTests(unittest.TestCase):
    def test_open_still_image_uses_sips_for_heic_on_macos(self):
        if sys.platform != "darwin":
            self.skipTest("sips integration test requires macOS")

        sample = (
            "/Volumes/eric_files/photo_library/2026/2026-04-08/"
            "img_20260408_c8bd08bb.heic"
        )
        if not os.path.exists(sample):
            self.skipTest("sample HEIC not available")

        image = open_still_image(sample)
        try:
            self.assertGreater(image.width, 0)
            self.assertGreater(image.height, 0)
        finally:
            image.close()

    def test_open_still_image_applies_exif_orientation_after_sips(self):
        if sys.platform != "darwin":
            self.skipTest("sips integration test requires macOS")

        sample = (
            "/Volumes/eric_files/photo_library/2026/2026-03-20/"
            "img_20260320_deb7c5e9.heic"
        )
        if not os.path.exists(sample):
            self.skipTest("oriented sample HEIC not available")

        image = open_still_image(sample)
        try:
            self.assertEqual(image.size, (4284, 5712))
        finally:
            image.close()

    def test_still_image_to_jpeg_buffer_produces_jpeg(self):
        if sys.platform != "darwin":
            self.skipTest("sips integration test requires macOS")

        sample = (
            "/Volumes/eric_files/photo_library/2026/2026-04-08/"
            "img_20260408_c8bd08bb.heic"
        )
        if not os.path.exists(sample):
            self.skipTest("sample HEIC not available")

        buffer = still_image_to_jpeg_buffer(sample)
        self.assertGreater(len(buffer.getvalue()), 1000)
        buffer.seek(0)
        with Image.open(buffer) as image:
            self.assertEqual(image.format, "JPEG")

    def test_still_image_to_jpeg_buffer_produces_jpeg_for_raw_on_macos(self):
        if sys.platform != "darwin":
            self.skipTest("sips integration test requires macOS")

        candidates = [
            "/Users/erichenry/Desktop/_photos-test-files/raw-files/sample1.dng",
            "/Users/erichenry/Desktop/import me/sample1.dng",
            "/Volumes/eric_files/photo_library/2026",
            os.path.expanduser("~/Desktop/photos-light/test_fixtures"),
        ]
        sample = None
        for root in candidates:
            if os.path.isfile(root) and os.path.splitext(root)[1].lower() in RAW_PHOTO_EXTENSIONS:
                sample = root
                break
            if not os.path.isdir(root):
                continue
            for dirpath, _, filenames in os.walk(root):
                for name in filenames:
                    ext = os.path.splitext(name)[1].lower()
                    if ext in RAW_PHOTO_EXTENSIONS:
                        sample = os.path.join(dirpath, name)
                        break
                if sample:
                    break
            if sample:
                break

        if not sample:
            self.skipTest("sample RAW not available")

        image = open_still_image(sample)
        try:
            self.assertGreater(image.width, 1000)
            self.assertGreater(image.height, 1000)
        finally:
            image.close()

        buffer = still_image_to_jpeg_buffer(sample)
        self.assertGreater(len(buffer.getvalue()), 100000)
        buffer.seek(0)
        with Image.open(buffer) as image:
            self.assertEqual(image.format, "JPEG")
            self.assertGreater(image.width, 1000)
            self.assertGreater(image.height, 1000)

    def test_pil_fallback_still_used_for_jpeg(self):
        with tempfile.NamedTemporaryFile(suffix=".jpg", delete=False) as handle:
            temp_path = handle.name
        try:
            Image.new("RGB", (32, 24), color=(10, 20, 30)).save(temp_path, format="JPEG")
            with mock.patch("image_pixels._sips_decode_to_pil") as sips_decode:
                image = open_still_image(temp_path)
                try:
                    self.assertEqual(image.size, (32, 24))
                finally:
                    image.close()
                sips_decode.assert_not_called()
        finally:
            os.remove(temp_path)

    def test_bake_heic_orientation_strips_tag_on_macos(self):
        if sys.platform != "darwin":
            self.skipTest("sips integration test requires macOS")

        source = (
            "/Volumes/eric_files/photo_library/2026/2026-03-20/"
            "img_20260320_deb7c5e9.heic"
        )
        if not os.path.exists(source):
            self.skipTest("oriented sample HEIC not available")

        with tempfile.TemporaryDirectory() as temp_dir:
            target = os.path.join(temp_dir, "oriented.heic")
            with open(source, "rb") as src, open(target, "wb") as dst:
                dst.write(src.read())

            def strip_tag(path):
                return True, "Removed orientation tag"

            baked, message, orientation = bake_heic_orientation_in_place(
                target,
                orientation=6,
                strip_orientation_tag=strip_tag,
            )
            self.assertTrue(baked, message)
            self.assertEqual(orientation, 6)

            image = open_still_image(target)
            try:
                self.assertEqual(image.size, (4284, 5712))
            finally:
                image.close()


if __name__ == "__main__":
    unittest.main()
