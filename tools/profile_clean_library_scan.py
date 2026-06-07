#!/usr/bin/env python3
"""
Profile per-file scan/normalize cost for Clean library v2.

Times the same primitives used in make_library_clean_v2.normalize_media_file
on a representative sample from a library (default: NAS speed-test fixture).

Example:
  python3 tools/profile_clean_library_scan.py \\
    --library /Volumes/public/clean-lib-speed-test
"""

from __future__ import annotations

import argparse
import json
import os
import random
import sys
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Callable, Dict, List, Optional, Tuple

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if REPO_ROOT not in sys.path:
    sys.path.insert(0, REPO_ROOT)

from hash_cache import HashCache, compute_hash_legacy  # noqa: E402
from library_cleanliness import (  # noqa: E402
    ALL_MEDIA_EXTENSIONS,
    IGNORED_LIBRARY_FILES,
    PHOTO_MEDIA_EXTENSIONS,
    VIDEO_MEDIA_EXTENSIONS,
    media_kind_for_extension,
)
from library_layout import resolve_db_path  # noqa: E402
from make_library_clean_v2 import (  # noqa: E402
    bake_orientation,
    canonicalize_photo_file,
    extract_exif_date,
    extract_exif_rating,
    get_orientation_flag,
    read_dimensions,
    strip_exif_rating,
    verify_media_file,
    write_photo_date_metadata,
)
from photo_canonicalization import canonicalize_photo_date  # noqa: E402
from db_schema import create_database_schema  # noqa: E402
import sqlite3  # noqa: E402


INFRA_DIRS = {
    ".library",
    ".db_backups",
    ".import_temp",
    ".logs",
    ".thumbnails",
    ".trash",
}


def iso_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def timed(label: str, fn: Callable[[], Any]) -> Tuple[Any, float]:
    start = time.perf_counter()
    result = fn()
    elapsed = time.perf_counter() - start
    return result, round(elapsed, 4)


@dataclass
class FileProfile:
    rel_path: str
    file_type: str
    size_bytes: int
    steps: Dict[str, float] = field(default_factory=dict)
    notes: List[str] = field(default_factory=list)

    @property
    def measured_total(self) -> float:
        return round(sum(self.steps.values()), 4)


def list_media_files(library_path: str) -> List[Tuple[str, str, int]]:
    items: List[Tuple[str, str, int]] = []
    for root, _dirs, files in os.walk(library_path):
        rel_root = os.path.relpath(root, library_path)
        if rel_root != "." and rel_root.split(os.sep)[0] in INFRA_DIRS:
            continue
        for filename in files:
            if filename in IGNORED_LIBRARY_FILES or filename == ".DS_Store":
                continue
            ext = os.path.splitext(filename)[1].lower()
            if ext not in ALL_MEDIA_EXTENSIONS:
                continue
            full_path = os.path.join(root, filename)
            rel_path = os.path.relpath(full_path, library_path)
            file_type = media_kind_for_extension(ext) or "photo"
            items.append((rel_path, file_type, os.path.getsize(full_path)))
    return items


def pick_sample(
    items: List[Tuple[str, str, int]],
    *,
    photos: int,
    videos: int,
    seed: int,
) -> List[Tuple[str, str, int]]:
    photos_only = [item for item in items if item[1] == "photo"]
    videos_only = [item for item in items if item[1] == "video"]
    rng = random.Random(seed)

    def pick_bucket(bucket: List[Tuple[str, str, int]], count: int) -> List[Tuple[str, str, int]]:
        if not bucket or count <= 0:
            return []
        sorted_bucket = sorted(bucket, key=lambda item: item[2])
        picks: List[Tuple[str, str, int]] = []
        if count >= 1:
            picks.append(sorted_bucket[0])  # smallest
        if count >= 2:
            picks.append(sorted_bucket[len(sorted_bucket) // 2])  # median
        if count >= 3:
            picks.append(sorted_bucket[-1])  # largest
        remaining = count - len(picks)
        pool = [item for item in bucket if item not in picks]
        if remaining > 0 and pool:
            picks.extend(rng.sample(pool, min(remaining, len(pool))))
        return picks[:count]

    sample = pick_bucket(photos_only, photos) + pick_bucket(videos_only, videos)
    # Stable order: photos first by size, then videos by size
    return sorted(sample, key=lambda item: (0 if item[1] == "photo" else 1, item[2]))


def profile_photo(full_path: str, rel_path: str, size_bytes: int, hash_cache: HashCache) -> FileProfile:
    profile = FileProfile(rel_path=rel_path, file_type="photo", size_bytes=size_bytes)

    _, profile.steps["stat"] = timed("stat", lambda: os.stat(full_path))

    valid, _msg = None, None

    def run_verify_before() -> bool:
        nonlocal valid, _msg
        valid, _msg = verify_media_file(full_path)
        return valid

    _, profile.steps["verify_before"] = timed("verify_before", run_verify_before)
    if not valid:
        profile.notes.append("verify_before_failed")

    _, profile.steps["orientation_before"] = timed(
        "orientation_before", lambda: get_orientation_flag(full_path)
    )
    _, profile.steps["rating_before"] = timed(
        "rating_before", lambda: extract_exif_rating(full_path)
    )
    _, profile.steps["exif_date"] = timed("exif_date", lambda: extract_exif_date(full_path))

    def run_canonicalize() -> Any:
        return canonicalize_photo_file(
            full_path,
            extract_exif_date=extract_exif_date,
            bake_orientation=bake_orientation,
            get_dimensions=lambda path: read_dimensions(path),
            compute_hash=lambda path: hash_cache.get_hash(path)[0],
            write_photo_exif=write_photo_date_metadata,
            extract_exif_rating=extract_exif_rating,
            strip_exif_rating=strip_exif_rating,
        )

    _, profile.steps["canonicalize_photo_file"] = timed("canonicalize_photo_file", run_canonicalize)

    _, profile.steps["verify_after"] = timed(
        "verify_after", lambda: verify_media_file(full_path)[0]
    )

    # Standalone full-file hash (cache miss path) for comparison
    _, profile.steps["hash_compute_legacy"] = timed(
        "hash_compute_legacy", lambda: compute_hash_legacy(full_path)
    )

    return profile


def profile_video(full_path: str, rel_path: str, size_bytes: int, hash_cache: HashCache) -> FileProfile:
    profile = FileProfile(rel_path=rel_path, file_type="video", size_bytes=size_bytes)

    stat_result, profile.steps["stat"] = timed("stat", lambda: os.stat(full_path))

    _, profile.steps["verify_before"] = timed(
        "verify_before", lambda: verify_media_file(full_path)[0]
    )
    _, profile.steps["orientation_before"] = timed(
        "orientation_before", lambda: get_orientation_flag(full_path)
    )
    _, profile.steps["rating_before"] = timed(
        "rating_before", lambda: extract_exif_rating(full_path)
    )
    _, profile.steps["exif_date"] = timed("exif_date", lambda: extract_exif_date(full_path))
    _, profile.steps["dimensions"] = timed("dimensions", lambda: read_dimensions(full_path))
    _, profile.steps["hash_cache"] = timed(
        "hash_cache", lambda: hash_cache.get_hash(full_path)[0]
    )
    _, profile.steps["verify_after"] = timed(
        "verify_after", lambda: verify_media_file(full_path)[0]
    )
    _, profile.steps["hash_compute_legacy"] = timed(
        "hash_compute_legacy", lambda: compute_hash_legacy(full_path)
    )
    _ = stat_result
    return profile


def summarize_profiles(profiles: List[FileProfile]) -> Dict[str, Any]:
    by_type: Dict[str, List[FileProfile]] = {"photo": [], "video": []}
    for item in profiles:
        by_type.setdefault(item.file_type, []).append(item)

    def agg_step(step: str, items: List[FileProfile]) -> Optional[Dict[str, float]]:
        values = [item.steps.get(step, 0.0) for item in items if step in item.steps]
        if not values:
            return None
        values.sort()
        return {
            "min": values[0],
            "median": values[len(values) // 2],
            "max": values[-1],
            "sum": round(sum(values), 4),
        }

    step_names = sorted(
        {step for profile in profiles for step in profile.steps.keys()}
    )

    per_type: Dict[str, Any] = {}
    for file_type, items in by_type.items():
        if not items:
            continue
        totals = [item.measured_total for item in items]
        totals.sort()
        step_totals: Dict[str, float] = {}
        for step in step_names:
            step_totals[step] = round(sum(item.steps.get(step, 0.0) for item in items), 4)
        grand = sum(totals) or 1.0
        per_type[file_type] = {
            "sample_count": len(items),
            "size_bytes": {
                "min": min(item.size_bytes for item in items),
                "median": sorted(item.size_bytes for item in items)[len(items) // 2],
                "max": max(item.size_bytes for item in items),
            },
            "measured_total_sec": {
                "min": totals[0],
                "median": totals[len(totals) // 2],
                "max": totals[-1],
            },
            "step_totals_sec": step_totals,
            "step_share_pct": {
                step: round(100 * sec / grand, 1)
                for step, sec in sorted(step_totals.items(), key=lambda kv: -kv[1])
            },
            "per_step": {step: agg_step(step, items) for step in step_names},
        }

    # Weighted extrapolation using full-library byte and count composition
    return {
        "per_type": per_type,
        "step_names": step_names,
    }


def extrapolate_library(
    library_path: str,
    profiles: List[FileProfile],
    summary: Dict[str, Any],
) -> Dict[str, Any]:
    all_media = list_media_files(library_path)
    photo_items = [item for item in all_media if item[1] == "photo"]
    video_items = [item for item in all_media if item[1] == "video"]

    def type_seconds(items: List[Tuple[str, str, int]], file_type: str) -> float:
        type_summary = summary["per_type"].get(file_type)
        if not type_summary or not items:
            return 0.0
        med = type_summary["measured_total_sec"]["median"]
        return med * len(items)

    photo_sec = type_seconds(photo_items, "photo")
    video_sec = type_seconds(video_items, "video")
    total_sec = photo_sec + video_sec

    return {
        "library_media_count": len(all_media),
        "photo_count": len(photo_items),
        "video_count": len(video_items),
        "estimated_scan_sec": round(total_sec, 1),
        "estimated_scan_hours": round(total_sec / 3600, 2),
        "extrapolate_60k_hours_median_per_file": round(
            ((total_sec / max(len(all_media), 1)) * 60_000) / 3600, 2
        ),
        "note": "Uses median measured_total per type × type counts; videos dominate if present.",
    }


def print_report(
    library_path: str,
    profiles: List[FileProfile],
    summary: Dict[str, Any],
    extrapolation: Dict[str, Any],
) -> None:
    print(f"\nClean library scan profile — {library_path}")
    print(f"Engine sample paths mirror make_library_clean_v2.normalize_media_file\n")

    for profile in profiles:
        mb = profile.size_bytes / (1024 * 1024)
        print(f"• {profile.file_type.upper()} {mb:.2f} MB — {profile.rel_path}")
        for step, sec in sorted(profile.steps.items(), key=lambda kv: -kv[1]):
            pct = 100 * sec / max(profile.measured_total, 0.0001)
            print(f"    {step:28s} {sec:7.3f}s  ({pct:4.0f}%)")
        print(f"    {'TOTAL (measured)':28s} {profile.measured_total:7.3f}s")
        if profile.notes:
            print(f"    notes: {', '.join(profile.notes)}")
        print()

    for file_type, block in summary["per_type"].items():
        print(f"=== {file_type.upper()} aggregate ({block['sample_count']} samples) ===")
        print(
            f"  size: {block['size_bytes']['min']/1e6:.2f}–{block['size_bytes']['max']/1e6:.2f} MB "
            f"(median {block['size_bytes']['median']/1e6:.2f} MB)"
        )
        print(
            f"  measured total/file: median {block['measured_total_sec']['median']:.3f}s "
            f"(min {block['measured_total_sec']['min']:.3f}s, max {block['measured_total_sec']['max']:.3f}s)"
        )
        print("  step share of measured total (sum across samples):")
        for step, pct in block["step_share_pct"].items():
            if pct < 1:
                continue
            sec = block["step_totals_sec"][step]
            print(f"    {step:28s} {pct:5.1f}%  ({sec:.3f}s summed)")
        print()

    print("=== Library extrapolation (this fixture) ===")
    print(f"  media files: {extrapolation['library_media_count']} "
          f"({extrapolation['photo_count']} photos, {extrapolation['video_count']} videos)")
    print(f"  estimated scan: {extrapolation['estimated_scan_sec']}s "
          f"({extrapolation['estimated_scan_hours']}h)")
    print(f"  naive 60k extrapolation: {extrapolation['extrapolate_60k_hours_median_per_file']}h")
    print()


def main() -> int:
    parser = argparse.ArgumentParser(description="Profile Clean library scan per-file costs")
    parser.add_argument(
        "--library",
        default="/Volumes/public/clean-lib-speed-test",
        help="Library path (default: NAS speed-test fixture)",
    )
    parser.add_argument("--photos", type=int, default=5, help="Photo samples to profile")
    parser.add_argument("--videos", type=int, default=3, help="Video samples to profile")
    parser.add_argument("--seed", type=int, default=7, help="Random sample seed")
    parser.add_argument(
        "--output",
        default="",
        help="Optional JSON output path under tools/results/",
    )
    args = parser.parse_args()

    library_path = os.path.abspath(args.library)
    if not os.path.isdir(library_path):
        print(f"Library not found: {library_path}", file=sys.stderr)
        return 1

    items = list_media_files(library_path)
    if not items:
        print("No media files found.", file=sys.stderr)
        return 1

    sample = pick_sample(items, photos=args.photos, videos=args.videos, seed=args.seed)
    db_path = resolve_db_path(library_path, None)
    os.makedirs(os.path.dirname(db_path), exist_ok=True)
    conn = sqlite3.connect(db_path)
    create_database_schema(conn.cursor())
    conn.commit()
    hash_cache = HashCache(conn)

    profiles: List[FileProfile] = []
    for rel_path, file_type, size_bytes in sample:
        full_path = os.path.join(library_path, rel_path)
        if file_type == "photo":
            profiles.append(profile_photo(full_path, rel_path, size_bytes, hash_cache))
        else:
            profiles.append(profile_video(full_path, rel_path, size_bytes, hash_cache))

    conn.close()

    summary = summarize_profiles(profiles)
    extrapolation = extrapolate_library(library_path, profiles, summary)

    print_report(library_path, profiles, summary, extrapolation)

    payload = {
        "generated_at": iso_now(),
        "library_path": library_path,
        "sample_size": len(profiles),
        "profiles": [
            {
                "rel_path": p.rel_path,
                "file_type": p.file_type,
                "size_bytes": p.size_bytes,
                "steps_sec": p.steps,
                "measured_total_sec": p.measured_total,
                "notes": p.notes,
            }
            for p in profiles
        ],
        "summary": summary,
        "extrapolation": extrapolation,
    }

    if args.output:
        output_path = args.output
    else:
        stamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H-%M-%S+00-00")
        os.makedirs(os.path.join(REPO_ROOT, "tools", "results"), exist_ok=True)
        output_path = os.path.join(REPO_ROOT, "tools", "results", f"scan-profile_{stamp}.json")

    with open(output_path, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, indent=2, sort_keys=True)
        handle.write("\n")
    print(f"Wrote {output_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
