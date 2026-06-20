"""Any→any QuickTime date transition contract tests."""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
import unittest
from itertools import product
from tempfile import TemporaryDirectory

from media_dates import read_media_date, read_video_creation_time, write_and_verify_media_date
from quicktime_date_atoms import _iter_boxes, _scan_top_level, read_mvhd_canonical_date

CORNER_DATES = (
    "1900:01:02 00:00:00",
    "1904:01:01 00:00:00",
    "2039:12:31 23:59:59",
    "2040:02:07 00:00:00",
    "2060:01:02 00:00:00",
    "2100:01:01 00:00:00",
)

REAL_FIXTURE_SOURCE_CANDIDATES = (
    "/Users/erichenry/Desktop/_photos-test-files/_colors/img_20600102_a8aa6960.mov",
    "/Users/erichenry/Desktop/_colors/img_20600102_a8aa6960.mov",
    "/Users/erichenry/Desktop/Photo Library/2060/2060-01-02/img_20600102_9b99df1f.mov",
)

REAL_FIXTURE_CANDIDATES = REAL_FIXTURE_SOURCE_CANDIDATES


def _ffmpeg_available() -> bool:
    return shutil.which("ffmpeg") is not None and shutil.which("ffprobe") is not None


def _moov_direct_children(file_path: str) -> list[tuple[bytes, int]]:
    with open(file_path, "rb") as handle:
        data = handle.read()
    layout = _scan_top_level(data)
    if layout.moov is None:
        return []
    moov = data[layout.moov.start : layout.moov.end]
    return [
        (box.box_type, box.end - box.start)
        for box in _iter_boxes(moov, 8, len(moov))
    ]


def _avfoundation_video_track_count(file_path: str) -> tuple[bool, float, int]:
    escaped_path = file_path.replace("\\", "\\\\").replace('"', '\\"')
    script = f"""
import AVFoundation
let asset = AVURLAsset(url: URL(fileURLWithPath: "{escaped_path}"))
let playable = asset.isPlayable
let duration = CMTimeGetSeconds(asset.duration)
let tracks = asset.tracks(withMediaType: .video).count
print(playable, duration, tracks)
"""
    result = subprocess.run(
        ["swift", "-e", script],
        capture_output=True,
        text=True,
        timeout=60,
    )
    if result.returncode != 0:
        raise RuntimeError(result.stderr or result.stdout)
    playable_text, duration_text, tracks_text = result.stdout.strip().split()
    return playable_text == "true", float(duration_text), int(tracks_text)


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

    def test_pre_1970_date_survives_ffprobe_cross_check(self):
        """mvhd v0 values before 1970-01-01 are misread by ffprobe as Unix seconds."""
        work_path = os.path.join(self._tmpdir.name, "pre_1970_ffprobe.mov")
        target = "1918:06:19 22:48:00"
        self._prepare_at_date(work_path, "2026:06:19 22:48:00")
        write_and_verify_media_date(work_path, target)
        self.assertEqual(read_mvhd_canonical_date(work_path), target)
        self.assertEqual(read_video_creation_time(work_path), target)


@unittest.skipUnless(_ffmpeg_available(), "ffmpeg/ffprobe required")
class QuickTimeRealFixtureTransitionTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.fixture_path = next(
            (path for path in REAL_FIXTURE_SOURCE_CANDIDATES if os.path.isfile(path)),
            None,
        )

    def setUp(self):
        if self.fixture_path is None:
            self.skipTest("real MOV fixture not available on this machine")
        self._tmpdir = TemporaryDirectory()
        self.work_path = os.path.join(self._tmpdir.name, "fixture.mov")

    def tearDown(self):
        self._tmpdir.cleanup()

    def test_real_mov_patch_preserves_moov_siblings(self):
        shutil.copy2(self.fixture_path, self.work_path)
        before = _moov_direct_children(self.work_path)
        if not any(box_type == b"udta" for box_type, _size in before):
            self.skipTest("fixture has no udta atom; sibling-preservation not applicable")

        write_and_verify_media_date(self.work_path, "2060:01:02 00:00:00")
        after = _moov_direct_children(self.work_path)
        self.assertEqual(
            [box_type for box_type, _size in before],
            [box_type for box_type, _size in after],
        )
        before_sizes = {box_type: size for box_type, size in before}
        after_sizes = {box_type: size for box_type, size in after}
        self.assertEqual(before_sizes[b"trak"], after_sizes[b"trak"])
        self.assertEqual(before_sizes[b"udta"], after_sizes[b"udta"])

    @unittest.skipUnless(sys.platform == "darwin", "AVFoundation integration requires macOS")
    def test_real_mov_patch_stays_avfoundation_playable(self):
        shutil.copy2(self.fixture_path, self.work_path)
        write_and_verify_media_date(self.work_path, "2060:01:02 00:00:00")
        playable, duration, tracks = _avfoundation_video_track_count(self.work_path)
        self.assertTrue(playable)
        self.assertGreater(duration, 0.0)
        self.assertEqual(tracks, 1)

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
