"""Any→any QuickTime date transition contract tests."""

from __future__ import annotations

import os
import shutil
import subprocess
import unittest
from itertools import product
from tempfile import TemporaryDirectory

from media_dates import read_media_date, read_video_creation_time, write_and_verify_media_date
from quicktime_date_atoms import read_mvhd_canonical_date

CORNER_DATES = (
    "1900:01:02 00:00:00",
    "1904:01:01 00:00:00",
    "2039:12:31 23:59:59",
    "2040:02:07 00:00:00",
    "2060:01:02 00:00:00",
    "2100:01:01 00:00:00",
)

REAL_FIXTURE_CANDIDATES = (
    "/Users/erichenry/Desktop/Photo Library/2060/2060-01-02/img_20600102_9b99df1f.mov",
    "/Users/erichenry/Desktop/_colors/img_20600102_a8aa6960.mov",
)


def _ffmpeg_available() -> bool:
    return shutil.which("ffmpeg") is not None and shutil.which("ffprobe") is not None


def _build_minimal_mov(path: str) -> None:
    """Create a tiny decodable MOV with moov before mdat (faststart)."""
    result = subprocess.run(
        [
            "ffmpeg",
            "-y",
            "-f",
            "lavfi",
            "-i",
            "color=c=black:s=16x16:d=0.1",
            "-c:v",
            "libx264",
            "-t",
            "0.1",
            "-movflags",
            "+faststart",
            path,
        ],
        capture_output=True,
        text=True,
        timeout=60,
    )
    if result.returncode != 0:
        raise RuntimeError(result.stderr or result.stdout)


@unittest.skipUnless(_ffmpeg_available(), "ffmpeg/ffprobe required")
class QuickTimeDateTransitionMatrixTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls._tmpdir = TemporaryDirectory()
        cls.base_mov = os.path.join(cls._tmpdir.name, "base.mov")
        _build_minimal_mov(cls.base_mov)

    @classmethod
    def tearDownClass(cls):
        cls._tmpdir.cleanup()

    def _prepare_at_date(self, work_path: str, date: str) -> None:
        shutil.copy2(self.base_mov, work_path)
        write_and_verify_media_date(work_path, date)
        self.assertEqual(read_mvhd_canonical_date(work_path), date)

    def test_minimal_mov_any_to_any_transitions(self):
        for src_date, dst_date in product(CORNER_DATES, repeat=2):
            if src_date == dst_date:
                continue
            with self.subTest(src=src_date, dst=dst_date):
                work_path = os.path.join(
                    self._tmpdir.name,
                    f"transition_{src_date[:10]}_{dst_date[:10]}.mov",
                )
                self._prepare_at_date(work_path, src_date)
                write_and_verify_media_date(work_path, dst_date)
                self.assertEqual(read_mvhd_canonical_date(work_path), dst_date)
                self.assertEqual(read_video_creation_time(work_path), dst_date)
                self.assertEqual(
                    read_media_date(work_path, allow_mtime_fallback=False),
                    dst_date,
                )
                self.assertFalse(os.path.exists(f"{work_path}.bak"))
                self.assertFalse(os.path.exists(f"{work_path}.atompatch"))


@unittest.skipUnless(_ffmpeg_available(), "ffmpeg/ffprobe required")
class QuickTimeRealFixtureTransitionTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.fixture_path = next(
            (path for path in REAL_FIXTURE_CANDIDATES if os.path.isfile(path)),
            None,
        )

    def setUp(self):
        if self.fixture_path is None:
            self.skipTest("real MOV fixture not available on this machine")
        self._tmpdir = TemporaryDirectory()
        self.work_path = os.path.join(self._tmpdir.name, "fixture.mov")

    def tearDown(self):
        self._tmpdir.cleanup()

    def test_real_mov_2060_to_1900_to_2026(self):
        shutil.copy2(self.fixture_path, self.work_path)
        transitions = (
            "2060:01:02 00:00:00",
            "1900:01:02 00:00:00",
            "2026:06:13 00:00:00",
        )
        for index in range(len(transitions) - 1):
            dst = transitions[index + 1]
            with self.subTest(dst=dst):
                write_and_verify_media_date(self.work_path, dst)
                self.assertEqual(read_mvhd_canonical_date(self.work_path), dst)
                self.assertEqual(read_video_creation_time(self.work_path), dst)

    def test_real_mov_corner_subset(self):
        shutil.copy2(self.fixture_path, self.work_path)
        for dst_date in ("1900:01:02 00:00:00", "2100:01:01 00:00:00"):
            with self.subTest(dst=dst_date):
                write_and_verify_media_date(self.work_path, dst_date)
                self.assertEqual(read_mvhd_canonical_date(self.work_path), dst_date)


if __name__ == "__main__":
    unittest.main()
