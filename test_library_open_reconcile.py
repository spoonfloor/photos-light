"""Contract tests for background open reconcile (Phase C slice 7)."""

from __future__ import annotations

import os
import sqlite3
import threading
import time
import unittest
from tempfile import TemporaryDirectory
from unittest.mock import patch

from db_schema import create_database_schema
from library_layout import ALLOWED_LIBRARY_METADATA_FILES, canonical_db_path
from library_open_reconcile import (
    collect_open_reconcile_delta,
    open_reconcile_state_path,
    run_open_reconcile,
    schedule_open_reconcile_background,
)
from normalization_repair import MetadataComplianceResult, RepairScanDependencies


class _HashCache:
    def __init__(self, content_hash="abcd1234" + ("0" * 56)):
        self.content_hash = content_hash

    def get_hash(self, _path):
        return self.content_hash, False


def _scan_deps(**overrides):
    values = {
        "hash_cache": _HashCache(),
        "extract_exif_date": lambda _path: "2026:04:12 09:30:15",
        "extract_exif_rating": lambda _path: None,
        "strip_exif_rating": lambda _path: True,
        "get_orientation_flag": lambda _path: 1,
        "can_bake_losslessly": lambda _path: False,
        "bake_orientation": lambda _path: (False, "No orientation", None),
        "canonicalize_photo_file": lambda *_args, **_kwargs: None,
        "write_photo_date_metadata": lambda _path, _date: None,
        "read_dimensions": lambda _path: (640, 480),
        "lossless_rotation_extensions": frozenset({".jpg", ".jpeg", ".png"}),
    }
    values.update(overrides)
    return RepairScanDependencies(**values)


class OpenReconcileContractTest(unittest.TestCase):
    def _create_library(self, library_path):
        db_path = canonical_db_path(library_path)
        os.makedirs(os.path.dirname(db_path), exist_ok=True)
        conn = sqlite3.connect(db_path)
        conn.row_factory = sqlite3.Row
        create_database_schema(conn.cursor())
        conn.commit()
        return db_path, conn

    def _insert_photo(self, conn, *, rel_path, content_hash, file_size):
        conn.execute(
            """
            INSERT INTO photos (
                original_filename, current_path, date_taken, content_hash,
                file_size, file_type, width, height
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                os.path.basename(rel_path),
                rel_path,
                "2026:04:12 09:30:15",
                content_hash,
                file_size,
                "photo",
                640,
                480,
            ),
        )
        conn.commit()

    def test_allowed_metadata_includes_open_reconcile_state(self):
        self.assertIn("open_reconcile_state.json", ALLOWED_LIBRARY_METADATA_FILES)

    def test_collect_delta_classifies_ghosts_moles_and_size_drift(self):
        with TemporaryDirectory() as tmpdir:
            db_path, conn = self._create_library(tmpdir)
            live_rel = os.path.join("2026", "2026-04-12", "img_20260412_live.jpg")
            live_full = os.path.join(tmpdir, live_rel)
            os.makedirs(os.path.dirname(live_full), exist_ok=True)
            with open(live_full, "wb") as handle:
                handle.write(b"live-bytes")

            drifted_rel = os.path.join("2026", "2026-04-12", "img_20260412_drift.jpg")
            drifted_full = os.path.join(tmpdir, drifted_rel)
            with open(drifted_full, "wb") as handle:
                handle.write(b"now-longer-on-disk")

            mole_rel = os.path.join("2026", "2026-04-12", "img_20260412_mole.jpg")
            mole_full = os.path.join(tmpdir, mole_rel)
            with open(mole_full, "wb") as handle:
                handle.write(b"mole")

            self._insert_photo(
                conn,
                rel_path=live_rel,
                content_hash="a" * 64,
                file_size=len(b"live-bytes"),
            )
            self._insert_photo(
                conn,
                rel_path=drifted_rel,
                content_hash="b" * 64,
                file_size=4,
            )
            self._insert_photo(
                conn,
                rel_path=os.path.join("2026", "2026-04-12", "img_20260412_ghost.jpg"),
                content_hash="c" * 64,
                file_size=10,
            )

            delta = collect_open_reconcile_delta(tmpdir, conn)
            conn.close()

            self.assertEqual(delta.filesystem_count, 3)
            self.assertEqual(delta.db_count, 3)
            self.assertEqual(delta.ghosts, [os.path.join("2026", "2026-04-12", "img_20260412_ghost.jpg")])
            self.assertEqual(delta.moles, [mole_rel])
            self.assertEqual(delta.size_mismatched, [drifted_rel])

    def test_run_open_reconcile_removes_ghosts_and_updates_size_drift(self):
        with TemporaryDirectory() as tmpdir:
            db_path, conn = self._create_library(tmpdir)
            drifted_rel = os.path.join("2026", "2026-04-12", "img_20260412_drift.jpg")
            drifted_full = os.path.join(tmpdir, drifted_rel)
            os.makedirs(os.path.dirname(drifted_full), exist_ok=True)
            payload = b"externally-edited-bytes"
            with open(drifted_full, "wb") as handle:
                handle.write(payload)

            ghost_rel = os.path.join("2026", "2026-04-12", "img_20260412_ghost.jpg")
            self._insert_photo(
                conn,
                rel_path=drifted_rel,
                content_hash="oldhash" + ("0" * 56),
                file_size=3,
            )
            self._insert_photo(
                conn,
                rel_path=ghost_rel,
                content_hash="ghost" + ("1" * 59),
                file_size=9,
            )
            conn.close()

            new_hash = "newhash" + ("2" * 57)

            def fake_compliance(full_path, *, ext, deps):
                return MetadataComplianceResult(
                    fixed=True,
                    content_hash=new_hash,
                    file_size=len(payload),
                )

            with patch(
                "library_open_reconcile.verify_media_file",
                return_value=(True, "mock"),
            ), patch(
                "library_open_reconcile.repair_file_metadata_compliance",
                side_effect=fake_compliance,
            ):
                result = run_open_reconcile(
                    tmpdir,
                    db_path=db_path,
                    deps=_scan_deps(hash_cache=_HashCache(new_hash)),
                )

            self.assertFalse(result.cancelled)
            self.assertEqual(result.ghosts_removed, 1)
            self.assertEqual(result.size_mismatched, 1)
            self.assertEqual(result.metadata_fixed, 1)
            self.assertEqual(result.hashes_updated, 1)
            self.assertTrue(os.path.exists(open_reconcile_state_path(tmpdir)))

            conn = sqlite3.connect(db_path)
            conn.row_factory = sqlite3.Row
            rows = conn.execute(
                "SELECT current_path, content_hash, file_size FROM photos"
            ).fetchall()
            conn.close()

            self.assertEqual(len(rows), 1)
            self.assertEqual(rows[0]["current_path"], drifted_rel)
            self.assertEqual(rows[0]["content_hash"], new_hash)
            self.assertEqual(rows[0]["file_size"], len(payload))

    def test_run_open_reconcile_respects_cancel_check(self):
        with TemporaryDirectory() as tmpdir:
            db_path, conn = self._create_library(tmpdir)
            conn.close()
            result = run_open_reconcile(
                tmpdir,
                db_path=db_path,
                cancel_check=lambda: True,
                persist_state=False,
            )
            self.assertTrue(result.cancelled)

    def test_schedule_returns_immediately_and_invokes_callback(self):
        with TemporaryDirectory() as tmpdir:
            db_path, conn = self._create_library(tmpdir)
            conn.close()
            done = threading.Event()
            seen = {}

            def on_complete(result):
                seen["result"] = result
                done.set()

            os.environ["PHOTOS_LIGHT_ENABLE_OPEN_RECONCILE"] = "1"
            try:
                started = time.perf_counter()
                scheduled = schedule_open_reconcile_background(
                    tmpdir,
                    db_path,
                    generation=42,
                    on_complete=on_complete,
                )
                elapsed_ms = (time.perf_counter() - started) * 1000
            finally:
                os.environ.pop("PHOTOS_LIGHT_ENABLE_OPEN_RECONCILE", None)

            self.assertTrue(scheduled)
            self.assertLess(elapsed_ms, 250)
            self.assertTrue(done.wait(timeout=5))
            self.assertFalse(seen["result"].cancelled)


if __name__ == "__main__":
    unittest.main()
