import os
import unittest
from dataclasses import dataclass
from datetime import datetime
from tempfile import TemporaryDirectory
from typing import Optional

from normalization_repair import (
    RepairDependencies,
    RepairFileError,
    RepairPhaseDependencies,
    RepairPhaseState,
    RepairScanDependencies,
    iter_repair_events,
    normalize_repair_file,
    normalize_repair_scan_identity,
    plan_repair_duplicate_decisions,
)


@dataclass
class _Record:
    date_taken: str
    content_hash: str
    ext: str
    full_path: str
    rel_path: str
    source_rel_path: str
    has_metadata_cleanup_signal: bool = False
    sort_value: int = 0
    metadata_cleaned: bool = False

    @property
    def duplicate_key(self):
        return self.content_hash


class _HashCache:
    def __init__(self, content_hash):
        self.content_hash = content_hash

    def get_hash(self, _path):
        return self.content_hash, False


@dataclass
class _CanonicalPhoto:
    content_hash: str
    date_taken: str
    date_obj: datetime
    width: int
    height: int
    rating: Optional[int]
    metadata_changed: bool
    orientation_baked: bool
    rating_stripped: bool


def _scan_deps(**overrides):
    values = {
        "hash_cache": _HashCache("abc12345" + ("0" * 56)),
        "extract_exif_date": lambda _path: "2026:04:12 09:30:15",
        "extract_exif_rating": lambda _path: None,
        "strip_exif_rating": lambda _path: True,
        "get_orientation_flag": lambda _path: 1,
        "can_bake_losslessly": lambda _path: False,
        "bake_orientation": lambda _path: (False, "No orientation", None),
        "canonicalize_photo_file": lambda *_args, **_kwargs: _CanonicalPhoto(
            content_hash="abc12345" + ("0" * 56),
            date_taken="2026:04:12 09:30:15",
            date_obj=datetime(2026, 4, 12, 9, 30, 15),
            width=640,
            height=480,
            rating=None,
            metadata_changed=False,
            orientation_baked=False,
            rating_stripped=False,
        ),
        "write_photo_date_metadata": lambda _path, _date: None,
        "read_dimensions": lambda _path: (640, 480),
        "lossless_rotation_extensions": frozenset({".jpg", ".jpeg", ".png"}),
    }
    values.update(overrides)
    return RepairScanDependencies(**values)


class NormalizationRepairTest(unittest.TestCase):
    def test_iter_repair_events_runs_post_scan_phases_in_order(self):
        records = [
            _Record("2026:04:12 09:30:15", "a", ".jpg", "/live/a", "a.jpg", "a.jpg"),
            _Record("2026:04:12 09:30:15", "b", ".jpg", "/live/b", "b.jpg", "b.jpg", has_metadata_cleanup_signal=True),
        ]
        state = RepairPhaseState(records=list(records), canonicalize_index=1)
        calls = []
        phases = []

        def phase_is_before(phase, target):
            order = {
                "scan_complete": 2,
                "dedupe_complete": 4,
                "canonicalize_complete": 6,
                "folders_complete": 8,
                "rebuild_db_complete": 10,
            }
            return order[phase] < order[target]

        def set_current_phase(phase):
            phases.append(phase)

        deps = RepairPhaseDependencies(
            phase_is_before=phase_is_before,
            raise_if_cancelled=lambda: calls.append("cancel_check"),
            set_current_phase=set_current_phase,
            flush_checkpoint=lambda **kwargs: calls.append(("checkpoint", kwargs.get("records"))),
            emit_stats_feedback=lambda: calls.append("stats"),
            set_metadata_fixed=lambda count: calls.append(("metadata_fixed", count)),
            trash_duplicates=lambda items: items[:1],
            move_to_canonical_locations=lambda items, start_index=0: items,
            remove_empty_noncanonical_folders=lambda: calls.append("folders"),
            rebuild_photos_table=lambda items: calls.append(("rebuild", items)),
        )

        events = list(iter_repair_events(state, resume_phase="scan_complete", deps=deps))

        self.assertEqual(
            [(event["phase"], event["status"]) for event in events],
            [
                ("dedupe", "starting"),
                ("dedupe", "complete"),
                ("canonicalize", "starting"),
                ("canonicalize", "complete"),
                ("folders", "starting"),
                ("folders", "complete"),
                ("rebuild_db", "starting"),
                ("rebuild_db", "complete"),
            ],
        )
        self.assertEqual(events[2]["resumed_index"], 1)
        self.assertEqual(events[2]["total"], 1)
        self.assertEqual(state.records, records[:1])
        self.assertEqual(state.canonicalized, records[:1])
        self.assertIn("dedupe", phases)
        self.assertIn("rebuild_db_complete", phases)
        self.assertIn(("metadata_fixed", 0), calls)
        self.assertIn(("rebuild", records[:1]), calls)

    def test_iter_repair_events_respects_completed_resume_phase(self):
        records = [
            _Record("2026:04:12 09:30:15", "a", ".jpg", "/live/a", "a.jpg", "a.jpg")
        ]
        state = RepairPhaseState(records=list(records))
        calls = []

        deps = RepairPhaseDependencies(
            phase_is_before=lambda _phase, _target: False,
            raise_if_cancelled=lambda: calls.append("cancel_check"),
            set_current_phase=lambda phase: calls.append(("phase", phase)),
            flush_checkpoint=lambda **kwargs: calls.append("checkpoint"),
            emit_stats_feedback=lambda: calls.append("stats"),
            set_metadata_fixed=lambda count: calls.append(("metadata_fixed", count)),
            trash_duplicates=lambda items: calls.append("dedupe") or items,
            move_to_canonical_locations=lambda items, start_index=0: calls.append("canonicalize") or items,
            remove_empty_noncanonical_folders=lambda: calls.append("folders"),
            rebuild_photos_table=lambda items: calls.append("rebuild"),
        )

        events = list(iter_repair_events(state, resume_phase="rebuild_db_complete", deps=deps))

        self.assertEqual(events, [])
        self.assertEqual(calls, [])
        self.assertEqual(state.canonicalized, records)

    def test_plan_repair_duplicate_decisions_picks_first_sorted_live_record(self):
        records = [
            _Record("2026:04:12 09:30:15", "same", ".jpg", "/live/loser", "loser.jpg", "loser.jpg", sort_value=2),
            _Record("2026:04:12 09:30:15", "same", ".jpg", "/live/winner", "winner.jpg", "winner.jpg", sort_value=1),
            _Record("2026:04:12 09:30:15", "solo", ".jpg", "/live/solo", "solo.jpg", "solo.jpg", sort_value=3),
        ]

        decisions = plan_repair_duplicate_decisions(
            records,
            sort_key=lambda record: record.sort_value,
            path_exists=lambda path: path.startswith("/live/"),
        )

        by_key = {decision.duplicate_key: decision for decision in decisions}
        self.assertEqual(by_key["same"].winner.rel_path, "winner.jpg")
        self.assertEqual([record.rel_path for record in by_key["same"].losers], ["loser.jpg"])
        self.assertEqual(by_key["solo"].winner.rel_path, "solo.jpg")
        self.assertEqual(by_key["solo"].losers, [])

    def test_plan_repair_duplicate_decisions_ignores_missing_records(self):
        records = [
            _Record("2026:04:12 09:30:15", "same", ".jpg", "/missing/winner", "missing.jpg", "missing.jpg", sort_value=1),
            _Record("2026:04:12 09:30:15", "same", ".jpg", "/live/loser", "live.jpg", "live.jpg", sort_value=2),
        ]

        decisions = plan_repair_duplicate_decisions(
            records,
            sort_key=lambda record: record.sort_value,
            path_exists=lambda path: path.startswith("/live/"),
        )

        self.assertEqual(len(decisions), 1)
        self.assertEqual(decisions[0].winner.rel_path, "live.jpg")
        self.assertEqual(decisions[0].losers, [])

    def test_normalize_repair_scan_identity_returns_photo_metadata_logs(self):
        content_hash = "abc12345" + ("0" * 56)
        canonical_photo = _CanonicalPhoto(
            content_hash=content_hash,
            date_taken="2026:04:12 09:30:15",
            date_obj=datetime(2026, 4, 12, 9, 30, 15),
            width=640,
            height=480,
            rating=None,
            metadata_changed=True,
            orientation_baked=True,
            rating_stripped=False,
        )

        with TemporaryDirectory() as tmpdir:
            full_path = os.path.join(tmpdir, "photo.jpg")
            with open(full_path, "wb") as handle:
                handle.write(b"photo")

            identity = normalize_repair_scan_identity(
                full_path,
                ext=".jpg",
                stat_result=os.stat(full_path),
                deps=_scan_deps(
                    hash_cache=_HashCache(content_hash),
                    get_orientation_flag=lambda _path: 6,
                    can_bake_losslessly=lambda _path: True,
                    canonicalize_photo_file=lambda *_args, **_kwargs: canonical_photo,
                ),
            )

        self.assertIsNotNone(identity)
        assert identity is not None
        self.assertEqual(identity.file_type, "photo")
        self.assertEqual(identity.content_hash, content_hash)
        self.assertEqual(identity.duplicate_key, content_hash)
        self.assertTrue(identity.metadata_cleaned)
        self.assertTrue(identity.has_metadata_cleanup_signal)
        self.assertEqual([event.action for event in identity.log_events], ["orientation_baked"])

    def test_normalize_repair_scan_identity_returns_video_identity(self):
        content_hash = "def67890" + ("1" * 56)
        with TemporaryDirectory() as tmpdir:
            full_path = os.path.join(tmpdir, "clip.mov")
            with open(full_path, "wb") as handle:
                handle.write(b"video")

            identity = normalize_repair_scan_identity(
                full_path,
                ext=".mov",
                stat_result=os.stat(full_path),
                deps=_scan_deps(hash_cache=_HashCache(content_hash)),
            )

        self.assertIsNotNone(identity)
        assert identity is not None
        self.assertEqual(identity.file_type, "video")
        self.assertEqual(identity.content_hash, content_hash)
        self.assertEqual(identity.duplicate_key, content_hash)
        self.assertEqual(identity.date_taken, "2026:04:12 09:30:15")
        self.assertEqual((identity.width, identity.height), (640, 480))

    def test_normalize_repair_file_moves_misfiled_record_to_canonical_path(self):
        content_hash = "abc12345" + ("0" * 56)
        with TemporaryDirectory() as tmpdir:
            source_rel = "loose/photo.JPG"
            source_full = os.path.join(tmpdir, source_rel)
            os.makedirs(os.path.dirname(source_full), exist_ok=True)
            with open(source_full, "wb") as handle:
                handle.write(b"photo")

            record = _Record(
                date_taken="2026:04:12 09:30:15",
                content_hash=content_hash,
                ext=".JPG",
                full_path=source_full,
                rel_path=source_rel,
                source_rel_path=source_rel,
                has_metadata_cleanup_signal=True,
            )

            result = normalize_repair_file(
                record,
                RepairDependencies(library_path=tmpdir),
            )

            self.assertEqual(result.status, "moved")
            self.assertEqual(
                result.target_rel_path,
                os.path.join("2026", "2026-04-12", "img_20260412_abc12345.jpg"),
            )
            self.assertFalse(os.path.exists(source_full))
            self.assertTrue(os.path.exists(result.target_full_path))
            self.assertEqual(record.rel_path, result.target_rel_path)
            self.assertEqual(result.issue_paths["misfiled_media"], [source_rel])
            self.assertEqual(result.issue_paths["metadata_cleanup"], [source_rel])

    def test_normalize_repair_file_accepts_already_moved_resume_target(self):
        content_hash = "def67890" + ("1" * 56)
        with TemporaryDirectory() as tmpdir:
            target_rel = os.path.join("2026", "2026-04-12", "img_20260412_def67890.jpg")
            target_full = os.path.join(tmpdir, target_rel)
            os.makedirs(os.path.dirname(target_full), exist_ok=True)
            with open(target_full, "wb") as handle:
                handle.write(b"photo")

            record = _Record(
                date_taken="2026:04:12 09:30:15",
                content_hash=content_hash,
                ext=".jpg",
                full_path=os.path.join(tmpdir, "missing.jpg"),
                rel_path="missing.jpg",
                source_rel_path="missing.jpg",
            )

            result = normalize_repair_file(
                record,
                RepairDependencies(library_path=tmpdir),
            )

            self.assertEqual(result.status, "already_moved")
            self.assertEqual(record.full_path, target_full)
            self.assertEqual(record.rel_path, target_rel)

    def test_normalize_repair_file_refuses_to_overwrite_existing_target(self):
        content_hash = "feedface" + ("2" * 56)
        with TemporaryDirectory() as tmpdir:
            source_full = os.path.join(tmpdir, "source.jpg")
            with open(source_full, "wb") as handle:
                handle.write(b"source")

            target_rel = os.path.join("2026", "2026-04-12", "img_20260412_feedface.jpg")
            target_full = os.path.join(tmpdir, target_rel)
            os.makedirs(os.path.dirname(target_full), exist_ok=True)
            with open(target_full, "wb") as handle:
                handle.write(b"target")

            record = _Record(
                date_taken="2026:04:12 09:30:15",
                content_hash=content_hash,
                ext=".jpg",
                full_path=source_full,
                rel_path="source.jpg",
                source_rel_path="source.jpg",
            )

            with self.assertRaises(RepairFileError):
                normalize_repair_file(record, RepairDependencies(library_path=tmpdir))


if __name__ == "__main__":
    unittest.main()
