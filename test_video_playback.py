#!/usr/bin/env python3

import os
import shutil
import subprocess
import sys
import unittest
from unittest import mock

from image_pixels import (
    get_video_codec_name,
    iter_browser_mp4_chunks,
    needs_browser_video_proxy,
    video_mimetype_for_extension,
    video_to_browser_mp4_buffer,
)


def _ffmpeg_available() -> bool:
    return shutil.which("ffmpeg") is not None and shutil.which("ffprobe") is not None


class VideoPlaybackPolicyTests(unittest.TestCase):
    def test_mov_requires_browser_proxy(self):
        self.assertTrue(needs_browser_video_proxy("/tmp/sample.mov"))

    def test_mp4_h264_can_serve_directly(self):
        with mock.patch("image_pixels.get_video_codec_name", return_value="h264"):
            self.assertFalse(needs_browser_video_proxy("/tmp/sample.mp4"))

    def test_mp4_hevc_requires_proxy(self):
        with mock.patch("image_pixels.get_video_codec_name", return_value="hevc"):
            self.assertTrue(needs_browser_video_proxy("/tmp/sample.mp4"))

    def test_video_mimetype_mapping(self):
        self.assertEqual(video_mimetype_for_extension(".mp4"), "video/mp4")
        self.assertEqual(video_mimetype_for_extension(".mov"), "video/quicktime")
        self.assertEqual(video_mimetype_for_extension(".webm"), "video/webm")


class VideoPlaybackIntegrationTests(unittest.TestCase):
    def test_video_to_browser_mp4_buffer_remuxes_h264_mov(self):
        if sys.platform != "darwin" or not _ffmpeg_available():
            self.skipTest("ffmpeg integration test requires macOS tooling")

        sample = (
            "/Volumes/eric_files/photo_library/2016/2016-12-04/"
            "mov_20161204_6c3e887.mov"
        )
        if not os.path.exists(sample):
            self.skipTest("sample MOV not available")

        self.assertEqual(get_video_codec_name(sample), "h264")
        self.assertTrue(needs_browser_video_proxy(sample))

        buffer = video_to_browser_mp4_buffer(sample)
        payload = buffer.getvalue()
        self.assertGreater(len(payload), 1000)
        self.assertTrue(payload[4:8] == b"ftyp", "expected MP4 ftyp atom")

    def test_iter_browser_mp4_chunks_streams_first_ftyp_quickly(self):
        if sys.platform != "darwin" or not _ffmpeg_available():
            self.skipTest("ffmpeg integration test requires macOS tooling")

        sample = (
            "/Users/erichenry/Desktop/Photo Library/2011/2011-02-12/"
            "img_20110212_29fceb6a.mov"
        )
        if not os.path.exists(sample):
            sample = (
                "/Volumes/eric_files/photo_library/2016/2016-12-04/"
                "mov_20161204_6c3e887.mov"
            )
        if not os.path.exists(sample):
            self.skipTest("sample MOV not available")

        import time

        start = time.monotonic()
        chunk_iter = iter_browser_mp4_chunks(sample)
        first = next(chunk_iter)
        elapsed = time.monotonic() - start

        self.assertGreater(len(first), 8)
        self.assertEqual(first[4:8], b"ftyp", "expected MP4 ftyp atom")
        self.assertLess(elapsed, 2.0, "first chunk should arrive quickly")

        total = len(first)
        for chunk in chunk_iter:
            total += len(chunk)
        self.assertGreater(total, 1000)


if __name__ == "__main__":
    unittest.main()
