import os
import subprocess
import unittest
from tempfile import TemporaryDirectory
from unittest.mock import patch

from media_dates import (
    MediaDateVerificationError,
    UnsupportedMediaDateWrite,
    metadata_write_policy,
    write_and_verify_media_date,
    write_and_verify_video_date,
)


class MediaDatePolicyTest(unittest.TestCase):
    def test_metadata_write_policy_marks_jpg_writable(self):
        policy = metadata_write_policy(".jpg")
        self.assertTrue(policy.readable)
        self.assertTrue(policy.writable)
        self.assertEqual(policy.media_kind, "photo")

    def test_metadata_write_policy_marks_avi_unwritable(self):
        policy = metadata_write_policy(".avi")
        self.assertTrue(policy.readable)
        self.assertFalse(policy.writable)
        self.assertEqual(policy.media_kind, "video")

    def test_metadata_write_policy_marks_mov_atom_writer(self):
        policy = metadata_write_policy(".mov")
        self.assertTrue(policy.writable)
        self.assertEqual(policy.writer, "quicktime_atoms")
        self.assertEqual(policy.verifier, "mvhd")

    def test_metadata_write_policy_marks_mp4_atom_writer(self):
        policy = metadata_write_policy(".mp4")
        self.assertTrue(policy.writable)
        self.assertEqual(policy.writer, "quicktime_atoms")
        self.assertEqual(policy.verifier, "mvhd")

    def test_metadata_write_policy_marks_mkv_ffmpeg_writer(self):
        policy = metadata_write_policy(".mkv")
        self.assertTrue(policy.writable)
        self.assertEqual(policy.writer, "ffmpeg+exiftool")
        self.assertEqual(policy.verifier, "ffprobe")

    def test_write_and_verify_media_date_rejects_unwritable_photo_extension(self):
        with self.assertRaises(UnsupportedMediaDateWrite):
            write_and_verify_media_date("/tmp/photo.webp", "2026:01:01 00:00:00")

    def test_mov_uses_atom_writer_not_ffmpeg(self):
        with patch(
            "quicktime_date_atoms.write_quicktime_media_date"
        ) as atom_write, patch(
            "media_dates._write_video_date_ffmpeg"
        ) as ffmpeg_write, patch(
            "quicktime_date_atoms.read_mvhd_canonical_date",
            side_effect=Exception("no moov"),
        ):
            write_and_verify_video_date("/tmp/clip.mov", "2026:01:01 00:00:00")
        atom_write.assert_called_once_with("/tmp/clip.mov", "2026:01:01 00:00:00")
        ffmpeg_write.assert_not_called()

    def test_mov_is_noop_when_mvhd_already_matches(self):
        with patch(
            "quicktime_date_atoms.read_mvhd_canonical_date",
            return_value="2039:12:31 23:59:59",
        ) as mvhd_read, patch(
            "quicktime_date_atoms.write_quicktime_media_date"
        ) as atom_write:
            write_and_verify_video_date("/tmp/clip.mov", "2039:12:31 23:59:59")
        mvhd_read.assert_called_once_with("/tmp/clip.mov")
        atom_write.assert_not_called()

    def test_ffprobe_mismatch_fails_after_mkv_ffmpeg_write(self):
        with TemporaryDirectory() as tmpdir:
            video_path = os.path.join(tmpdir, "clip.mkv")
            temp_path = os.path.join(tmpdir, "clip_temp.mkv")
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
                if args[0] == "exiftool":
                    return subprocess.CompletedProcess(args, 0, "", "")
                raise AssertionError(args)

            with patch("media_dates.subprocess.run", side_effect=fake_run):
                with self.assertRaisesRegex(
                    MediaDateVerificationError,
                    "expected 2039:01:01 00:00:00",
                ):
                    write_and_verify_video_date(video_path, "2039:01:01 00:00:00")

    def test_verified_mkv_write_replaces_original(self):
        with TemporaryDirectory() as tmpdir:
            video_path = os.path.join(tmpdir, "clip.mkv")
            temp_path = os.path.join(tmpdir, "clip_temp.mkv")
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
