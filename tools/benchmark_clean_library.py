#!/usr/bin/env python3
"""
Benchmark Clean library (scan + run) for performance investigation.

Examples:
  python3 tools/benchmark_clean_library.py scan --library /Volumes/public/clean-lib-speed-test
  python3 tools/benchmark_clean_library.py run --library /Volumes/public/clean-lib-speed-test
  python3 tools/benchmark_clean_library.py suite --library /Volumes/public/clean-lib-speed-test --label nas-wifi
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Callable, Dict, List, Optional

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if REPO_ROOT not in sys.path:
    sys.path.insert(0, REPO_ROOT)

from library_cleanliness import (  # noqa: E402
    ALL_MEDIA_EXTENSIONS,
    PHOTO_MEDIA_EXTENSIONS,
    VIDEO_MEDIA_EXTENSIONS,
)
from library_layout import canonical_db_path, resolve_db_path  # noqa: E402
from make_library_perfect import (  # noqa: E402
    CLEAN_LIBRARY_ENGINE_VERSION,
    run_db_normalization_engine,
    scan_library_cleanliness,
)

EXTRAPOLATE_FILES = 60_000
RUN_PHASES = (
    "setup",
    "scan",
    "dedupe",
    "canonicalize",
    "folders",
    "rebuild_db",
    "audit",
)


@dataclass
class PhaseTimer:
    """Collect phase and progress timings from cleaner progress events."""

    label: str = ""
    started_at: float = field(default_factory=time.perf_counter)
    phase_started: Dict[str, float] = field(default_factory=dict)
    phase_elapsed: Dict[str, float] = field(default_factory=dict)
    progress_samples: Dict[str, List[Dict[str, Any]]] = field(default_factory=dict)
    events: List[Dict[str, Any]] = field(default_factory=list)
    _last_progress_print: float = 0.0
    progress_print_interval_sec: float = 8.0

    def callback(self, event: Dict[str, Any]) -> None:
        now = time.perf_counter()
        stamped = {"t": round(now - self.started_at, 3), **event}
        self.events.append(stamped)

        if event.get("type") == "phase":
            phase = str(event.get("phase") or "")
            status = event.get("status")
            if status == "starting":
                self.phase_started[phase] = now
                print(f"  [{self.label}] phase {phase} starting…", flush=True)
            elif status in {"complete", "failed"} and phase in self.phase_started:
                self.phase_elapsed[phase] = round(now - self.phase_started[phase], 3)
                extra = ""
                if status == "complete" and event.get("issue_count") is not None:
                    extra = f", issues={event['issue_count']}"
                print(
                    f"  [{self.label}] phase {phase} {status} "
                    f"({self.phase_elapsed[phase]:.1f}s){extra}",
                    flush=True,
                )

        if event.get("type") == "progress":
            phase = str(event.get("phase") or "")
            self.progress_samples.setdefault(phase, []).append(
                {
                    "t": round(now - self.started_at, 3),
                    "processed": event.get("processed"),
                    "total": event.get("total"),
                }
            )
            processed = event.get("processed")
            total = event.get("total")
            if (
                processed is not None
                and total is not None
                and now - self._last_progress_print >= self.progress_print_interval_sec
            ):
                self._last_progress_print = now
                print(
                    f"  [{self.label}] {phase}: {processed}/{total} "
                    f"({round(now - self.started_at, 0):.0f}s elapsed)",
                    flush=True,
                )

    def throughput(self, phase: str) -> Optional[float]:
        samples = self.progress_samples.get(phase) or []
        if len(samples) < 2:
            return None
        first, last = samples[0], samples[-1]
        dt = float(last["t"]) - float(first["t"])
        if dt <= 0:
            return None
        processed = int(last.get("processed") or 0) - int(first.get("processed") or 0)
        if processed <= 0:
            return None
        return round(processed / dt, 2)


def iso_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def count_media_files(library_path: str) -> Dict[str, int]:
    photo_count = 0
    video_count = 0
    other_media = 0
    total_files = 0

    for root, _dirs, files in os.walk(library_path):
        rel_root = os.path.relpath(root, library_path)
        if rel_root != "." and rel_root.split(os.sep)[0] in {
            ".library",
            ".db_backups",
            ".import_temp",
            ".logs",
            ".thumbnails",
            ".trash",
        }:
            continue
        for filename in files:
            if filename == ".DS_Store":
                continue
            total_files += 1
            ext = os.path.splitext(filename)[1].lower()
            if ext in PHOTO_MEDIA_EXTENSIONS:
                photo_count += 1
            elif ext in VIDEO_MEDIA_EXTENSIONS:
                video_count += 1
            elif ext in ALL_MEDIA_EXTENSIONS:
                other_media += 1

    media_count = photo_count + video_count + other_media
    return {
        "total_files": total_files,
        "media_files": media_count,
        "photo_files": photo_count,
        "video_files": video_count,
        "other_media_files": other_media,
    }


def count_db_photos(db_path: str) -> Optional[int]:
    if not db_path or not os.path.isfile(db_path):
        return None
    try:
        import sqlite3

        conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
        try:
            row = conn.execute("SELECT COUNT(*) FROM photos").fetchone()
            return int(row[0]) if row else 0
        finally:
            conn.close()
    except Exception:
        return None


def library_lock_holders(library_path: str) -> List[str]:
    try:
        result = subprocess.run(
            ["lsof", "+D", library_path],
            capture_output=True,
            text=True,
            timeout=10,
        )
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return []
    if result.returncode not in (0, 1):
        return []
    lines = [line.strip() for line in result.stdout.splitlines() if line.strip()]
    if len(lines) <= 1:
        return []
    return lines[1:]


def probe_library(library_path: str) -> Dict[str, Any]:
    library_path = os.path.abspath(library_path)
    db_path = resolve_db_path(library_path, None)
    counts = count_media_files(library_path)
    return {
        "library_path": library_path,
        "db_path": db_path,
        "canonical_db_path": canonical_db_path(library_path),
        "db_photo_rows": count_db_photos(db_path),
        **counts,
    }


def sec_per_media(elapsed_sec: float, media_files: int) -> Optional[float]:
    if media_files <= 0:
        return None
    return round(elapsed_sec / media_files, 4)


def extrapolate_hours(sec_per_file: Optional[float], file_count: int = EXTRAPOLATE_FILES) -> Optional[float]:
    if sec_per_file is None:
        return None
    return round((file_count * sec_per_file) / 3600, 2)


def print_step_result(step: Dict[str, Any]) -> None:
    name = step.get("step", "?")
    elapsed = step.get("elapsed_sec")
    time_str = f"{elapsed:.1f}s" if isinstance(elapsed, (int, float)) else "—"
    if step.get("kind") == "preflight_scan":
        print(
            f"<<< {name} done: {time_str}, status={step.get('status')}, "
            f"issues={step.get('issue_count')}, 60k≈{step.get('extrapolate_60k_hours')}h",
            flush=True,
        )
    else:
        print(
            f"<<< {name} done: {time_str}, ok={step.get('ok')}, "
            f"status={step.get('result_status')}",
            flush=True,
        )
        if step.get("error"):
            print(f"    error: {step['error']}", flush=True)


def timed_scan(library_path: str, label: str) -> Dict[str, Any]:
    timer = PhaseTimer(label=label)
    started = time.perf_counter()
    result = scan_library_cleanliness(library_path, progress_callback=timer.callback)
    elapsed = round(time.perf_counter() - started, 3)
    probe = probe_library(library_path)
    media_files = int(result.get("supported_media_files") or probe["media_files"] or 0)
    spp = sec_per_media(elapsed, media_files)
    return {
        "step": label,
        "kind": "preflight_scan",
        "elapsed_sec": elapsed,
        "status": result.get("status"),
        "issue_count": (result.get("summary") or {}).get("issue_count"),
        "supported_media_files": media_files,
        "sec_per_media_file": spp,
        "extrapolate_60k_hours": extrapolate_hours(spp),
        "phase_elapsed_sec": timer.phase_elapsed,
        "throughput_per_sec": {
            phase: timer.throughput(phase) for phase in sorted(timer.progress_samples)
        },
        "summary": result.get("summary"),
        "probe": probe,
    }


def timed_run(library_path: str, label: str) -> Dict[str, Any]:
    timer = PhaseTimer(label=label)
    started = time.perf_counter()
    try:
        result = run_db_normalization_engine(library_path, progress_callback=timer.callback)
        ok = True
        error = None
    except Exception as exc:
        result = {"status": "ERROR", "error": str(exc)}
        ok = False
        error = str(exc)
    elapsed = round(time.perf_counter() - started, 3)
    probe = probe_library(library_path)
    media_files = int(probe["media_files"] or 0)
    return {
        "step": label,
        "kind": "full_run",
        "elapsed_sec": elapsed,
        "ok": ok,
        "error": error,
        "result_status": result.get("status"),
        "stats": result.get("stats"),
        "phase_elapsed_sec": {phase: timer.phase_elapsed.get(phase) for phase in RUN_PHASES},
        "throughput_per_sec": {
            phase: timer.throughput(phase)
            for phase in RUN_PHASES
            if timer.throughput(phase) is not None
        },
        "probe": probe,
    }


def run_suite(library_path: str, label: str, skip_run: bool, warn_locks: bool) -> Dict[str, Any]:
    library_path = os.path.abspath(library_path)
    if not os.path.isdir(library_path):
        raise SystemExit(f"Library path is not a directory: {library_path}")

    locks = library_lock_holders(library_path)
    if locks and warn_locks:
        print("Warning: other processes have this library open (benchmark may be skewed):", file=sys.stderr)
        for line in locks[:5]:
            print(f"  {line}", file=sys.stderr)
        if len(locks) > 5:
            print(f"  ... and {len(locks) - 5} more", file=sys.stderr)

    steps: List[Dict[str, Any]] = []

    print("\n>>> STEP scan_dirty (preflight)", flush=True)
    steps.append(timed_scan(library_path, "scan_dirty"))
    print_step_result(steps[-1])

    if not skip_run:
        print("\n>>> STEP run_full (destructive clean)", flush=True)
        steps.append(timed_run(library_path, "run_full"))
        print_step_result(steps[-1])

        print("\n>>> STEP scan_clean (preflight after clean)", flush=True)
        steps.append(timed_scan(library_path, "scan_clean"))
        print_step_result(steps[-1])

        print("\n>>> STEP scan_clean_warm (repeat)", flush=True)
        steps.append(timed_scan(library_path, "scan_clean_warm"))
        print_step_result(steps[-1])

    report = {
        "label": label,
        "recorded_at": iso_now(),
        "engine": CLEAN_LIBRARY_ENGINE_VERSION,
        "library_path": library_path,
        "extrapolate_target_files": EXTRAPOLATE_FILES,
        "library_locks": locks,
        "steps": steps,
    }
    return report


def write_report(report: Dict[str, Any], output_path: Optional[str]) -> str:
    os.makedirs(os.path.join(REPO_ROOT, "tools", "results"), exist_ok=True)
    if not output_path:
        safe_label = "".join(ch if ch.isalnum() or ch in "-_" else "_" for ch in report["label"])
        output_path = os.path.join(
            REPO_ROOT,
            "tools",
            "results",
            f"{safe_label}_{report['recorded_at'].replace(':', '-')}.json",
        )
    else:
        output_path = os.path.abspath(output_path)
        os.makedirs(os.path.dirname(output_path) or ".", exist_ok=True)

    with open(output_path, "w", encoding="utf-8") as handle:
        json.dump(report, handle, indent=2)
        handle.write("\n")
    return output_path


def print_summary(report: Dict[str, Any]) -> None:
    print(f"\nClean library benchmark — {report['label']}")
    print(f"Engine: {report.get('engine', CLEAN_LIBRARY_ENGINE_VERSION)}")
    print(f"Library: {report['library_path']}")
    print(f"Recorded: {report['recorded_at']}\n")

    print(f"{'Step':<18} {'Time':>8}  {'Status':<8}  {'Issues':>7}  {'sec/file':>9}  {'60k est':>8}")
    print("-" * 70)
    for step in report["steps"]:
        elapsed = step.get("elapsed_sec")
        time_str = f"{elapsed:.1f}s" if isinstance(elapsed, (int, float)) else "—"
        if step["kind"] == "preflight_scan":
            status = str(step.get("status") or "—")
            issues = step.get("issue_count")
            issues_str = str(issues) if issues is not None else "—"
            spp = step.get("sec_per_media_file")
            spp_str = f"{spp:.3f}" if isinstance(spp, (int, float)) else "—"
            est = step.get("extrapolate_60k_hours")
            est_str = f"{est:.1f}h" if isinstance(est, (int, float)) else "—"
            print(f"{step['step']:<18} {time_str:>8}  {status:<8}  {issues_str:>7}  {spp_str:>9}  {est_str:>8}")
        else:
            status = str(step.get("result_status") or ("ERROR" if not step.get("ok") else "—"))
            print(f"{step['step']:<18} {time_str:>8}  {status:<8}  {'—':>7}  {'—':>9}  {'—':>8}")
            phases = step.get("phase_elapsed_sec") or {}
            phase_parts = [f"{name}={phases[name]:.1f}s" for name in RUN_PHASES if phases.get(name)]
            if phase_parts:
                print(f"  phases: {', '.join(phase_parts)}")

    print("\nNotes:")
    print("  • preflight scan = final_audit() only (Clean library overlay scan)")
    print("  • run_full phases: setup → scan → dedupe → canonicalize → folders → rebuild_db → audit")
    print("  • scan_clean_warm shows OS/SMB cache effect; use scan_clean for cold extrapolation")
    print()


def _add_common_args(parser: argparse.ArgumentParser) -> None:
    parser.add_argument(
        "--library",
        required=True,
        help="Absolute path to the library folder (e.g. /Volumes/public/clean-lib-speed-test)",
    )
    parser.add_argument(
        "--output",
        help="Write JSON report to this path (default: tools/results/<label>_<timestamp>.json)",
    )
    parser.add_argument(
        "--label",
        default="benchmark",
        help="Label for this run (used in report filename and summary)",
    )
    parser.add_argument(
        "--no-lock-warn",
        action="store_true",
        help="Do not warn when lsof shows open handles on the library",
    )


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Benchmark Clean library performance.")
    sub = parser.add_subparsers(dest="command", required=True)

    scan_parser = sub.add_parser("scan", help="Timed preflight scan only (final_audit)")
    _add_common_args(scan_parser)

    run_parser = sub.add_parser("run", help="Timed full clean with phase breakdown")
    _add_common_args(run_parser)
    run_parser.add_argument(
        "--destructive",
        action="store_true",
        help="Confirm this mutates the library (required for run subcommand)",
    )

    suite_parser = sub.add_parser(
        "suite",
        help="scan_dirty → run_full → scan_clean → scan_clean_warm",
    )
    _add_common_args(suite_parser)
    suite_parser.add_argument(
        "--skip-run",
        action="store_true",
        help="Only run preflight scan (non-destructive)",
    )
    suite_parser.add_argument(
        "--destructive",
        action="store_true",
        help="Allow destructive full clean in suite",
    )

    return parser


def main(argv: Optional[List[str]] = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    library_path = os.path.abspath(args.library)
    warn_locks = not args.no_lock_warn

    if args.command == "scan":
        report = {
            "label": args.label,
            "recorded_at": iso_now(),
            "engine": CLEAN_LIBRARY_ENGINE_VERSION,
            "library_path": library_path,
            "extrapolate_target_files": EXTRAPOLATE_FILES,
            "library_locks": library_lock_holders(library_path),
            "steps": [timed_scan(library_path, "scan")],
        }
    elif args.command == "run":
        if not args.destructive:
            parser.error("run mutates the library; pass --destructive to confirm")
        report = {
            "label": args.label,
            "recorded_at": iso_now(),
            "library_path": library_path,
            "extrapolate_target_files": EXTRAPOLATE_FILES,
            "library_locks": library_lock_holders(library_path),
            "steps": [timed_run(library_path, "run_full")],
        }
    elif args.command == "suite":
        if not args.skip_run and not args.destructive:
            parser.error("suite with full clean mutates the library; pass --destructive or --skip-run")
        report = run_suite(library_path, args.label, args.skip_run, warn_locks)
    else:
        parser.error(f"Unknown command: {args.command}")
        return 2

    output_path = write_report(report, args.output)
    print_summary(report)
    print(f"JSON report: {output_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
