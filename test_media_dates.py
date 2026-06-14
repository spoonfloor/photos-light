import os
import subprocess
import unittest
from tempfile import TemporaryDirectory
from unittest.mock import patch

from media_dates import (
    MediaDateVerificationError,
    UnsupportedMediaDateWrite,
    ensure_video_date_write_supported,
    write_and_verify_video_date,
)


class MediaDatePolicyTest(unittest.TestCase):
    def test_post_2040_mov_requires_quicktime_atom_patching(self):
        with self.assertRaisesRegex(UnsupportedMediaDateWrite, "64-bit atom"):
            ensure_video_date_write_supported(
                "/tmp/future.mov",
                "2080:01:01 00:09:00",
            )

    def test_pre_2040_mov_can_use_verified_ffmpeg_path(self):
        ensure_video_date_write_supported(
            "/tmp/normal.mov",
            "2039:12:31 23:59:59",
        )

    def test_ffprobe_mismatch_fails_after_video_write(self):
        with TemporaryDirectory() as tmpdir:
            video_path = os.path.join(tmpdir, "clip.mp4")
            temp_path = os.path.join(tmpdir, "clip_temp.mp4")
            with open(video_path, "wb") as handle:
                handle.write(b"video")

            def fake_run(args, **_kwargs):
                if args[0] == "ffmpeg":
                    with open(temp_path, "wb") as handle:
                        handle.write(b"video-redated")
                    return subprocess.CompletedProcess(args, 0, "", "")
                if args[0] == "ffprobe":
                    return subprocess.CompletedProcess(
                        args,
                        0,
                        '{"format":{"tags":{"creation_time":"2038-01-01T00:00:00.000000Z"}}}',
                        "",
                    )
                raise AssertionError(args)

            with patch("media_dates.subprocess.run", side_effect=fake_run):
                with self.assertRaisesRegex(
                    MediaDateVerificationError,
                    "expected 2039:01:01 00:00:00",
                ):
                    write_and_verify_video_date(video_path, "2039:01:01 00:00:00")

    def test_verified_video_write_replaces_original(self):
        with TemporaryDirectory() as tmpdir:
            video_path = os.path.join(tmpdir, "clip.mp4")
            temp_path = os.path.join(tmpdir, "clip_temp.mp4")
            with open(video_path, "wb") as handle:
                handle.write(b"video")

            def fake_run(args, **_kwargs):
                if args[0] == "ffmpeg":
                    with open(temp_path, "wb") as handle:
                        handle.write(b"video-redated")
                    return subprocess.CompletedProcess(args, 0, "", "")
                if args[0] == "ffprobe":
                    return subprocess.CompletedProcess(
                        args,
                        0,
                        '{"format":{"tags":{"creation_time":"2039-01-01T00:00:00.000000Z"}}}',
                        "",
                    )
                raise AssertionError(args)

            with patch("media_dates.subprocess.run", side_effect=fake_run):
                write_and_verify_video_date(video_path, "2039:01:01 00:00:00")

            with open(video_path, "rb") as handle:
                self.assertEqual(handle.read(), b"video-redated")


if __name__ == "__main__":
    unittest.main()
