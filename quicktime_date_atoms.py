"""QuickTime moov atom date read/write for MOV/QT/MP4/M4V.

All dates in the app allowed range (1900–2100) are written by patching
mvhd/tkhd/mdhd in the moov atom. Verification uses mvhd as authoritative;
ffprobe is a supplementary cross-check when it returns a value.
"""

from __future__ import annotations

import json
import os
import shutil
import struct
import subprocess
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Iterator, List, Optional, Tuple

QUICKTIME_EPOCH = datetime(1904, 1, 1, tzinfo=timezone.utc)
CANONICAL_DB_DATE_FORMAT = "%Y:%m:%d %H:%M:%S"
PATCH_ARTIFACT_SUFFIXES = (".bak", ".atompatch")
TIME_ATOM_TYPES = frozenset({b"mvhd", b"tkhd", b"mdhd"})
CHUNK_OFFSET_ATOM_TYPES = frozenset({b"stco", b"co64"})
CONTAINER_TYPES = frozenset({b"moov", b"trak", b"mdia", b"minf", b"stbl", b"edts"})
MOOV_CHILD_TYPES = frozenset({b"mvhd", b"trak", b"udta", b"free", b"skip", b"meta", b"iods"})
TRAK_CHILD_TYPES = frozenset({b"tkhd", b"edts", b"mdia", b"tref"})
MDIA_CHILD_TYPES = frozenset({b"mdhd", b"hdlr", b"minf", b"nmhd", b"dinf"})
MINF_CHILD_TYPES = frozenset({b"vmhd", b"smhd", b"hmhd", b"nmhd", b"dinf", b"stbl"})
STBL_CHILD_TYPES = frozenset({b"stsd", b"stts", b"stss", b"ctts", b"stsc", b"stsz", b"stco", b"co64", b"sgpd", b"sbgp"})
EDTS_CHILD_TYPES = frozenset({b"elst"})

CONTAINER_CHILD_TYPES = {
    b"moov": MOOV_CHILD_TYPES,
    b"trak": TRAK_CHILD_TYPES,
    b"mdia": MDIA_CHILD_TYPES,
    b"minf": MINF_CHILD_TYPES,
    b"stbl": STBL_CHILD_TYPES,
    b"edts": EDTS_CHILD_TYPES,
}


class QuickTimeDatePatchError(Exception):
    """Raised when QuickTime atom patching or verification fails."""


@dataclass(frozen=True)
class BoxRef:
    start: int
    end: int
    box_type: bytes


@dataclass(frozen=True)
class TopLevelLayout:
    moov: Optional[BoxRef]
    mdat: Optional[BoxRef]


def quicktime_seconds_from_canonical(date_str: str) -> int:
    target = datetime.strptime(date_str, CANONICAL_DB_DATE_FORMAT)
    target_utc = target.replace(tzinfo=timezone.utc)
    return int((target_utc - QUICKTIME_EPOCH).total_seconds())


def _normalize_ffprobe_creation_time(value: str | None) -> str | None:
    if not value:
        return None
    normalized = value.replace("T", " ").split(".")[0].rstrip("Z")
    return normalized.replace("-", ":", 2)


def _read_box_header(data: bytes, offset: int, limit: int) -> Tuple[int, bytes, int]:
    if offset + 8 > limit:
        raise ValueError("truncated atom header")
    size = int.from_bytes(data[offset : offset + 4], "big")
    box_type = bytes(data[offset + 4 : offset + 8])
    if size == 0:
        box_end = limit
    elif size == 1:
        if offset + 16 > limit:
            raise ValueError("truncated extended atom header")
        size = int.from_bytes(data[offset + 8 : offset + 16], "big")
        box_end = offset + size
    else:
        box_end = offset + size
    if size < 8 or box_end > limit:
        raise ValueError(f"invalid atom size for {box_type!r}")
    return box_end, box_type, offset + 8


def _iter_boxes(data: bytes, start: int, end: int) -> Iterator[BoxRef]:
    offset = start
    while offset + 8 <= end:
        box_end, box_type, _payload_start = _read_box_header(data, offset, end)
        yield BoxRef(start=offset, end=box_end, box_type=box_type)
        offset = box_end


def _scan_top_level(data: bytes) -> TopLevelLayout:
    moov = None
    mdat = None
    for box in _iter_boxes(data, 0, len(data)):
        if box.box_type == b"moov" and moov is None:
            moov = box
        elif box.box_type == b"mdat" and mdat is None:
            mdat = box
    return TopLevelLayout(moov=moov, mdat=mdat)


def _find_all_boxes_of_type(
    data: bytearray, start: int, end: int, box_type: bytes
) -> List[BoxRef]:
    found: List[BoxRef] = []
    for box in _iter_boxes(data, start, end):
        if box.box_type == box_type:
            found.append(box)
        if box.box_type in CONTAINER_TYPES:
            found.extend(_find_all_boxes_of_type(data, box.start + 8, box.end, box_type))
    return found


def _resync_container(data: bytearray, start: int, limit: int) -> int:
    box_end, box_type, payload_start = _read_box_header(data, start, limit)
    if box_type not in CONTAINER_TYPES:
        return box_end

    allowed_children = CONTAINER_CHILD_TYPES.get(box_type, frozenset())
    offset = payload_start
    while offset + 8 <= limit:
        try:
            child_end, child_type, _child_payload_start = _read_box_header(data, offset, limit)
        except ValueError:
            break

        if offset >= box_end:
            if child_type not in allowed_children:
                break

        if box_type == b"edts" and child_type in TRAK_CHILD_TYPES - {b"edts"}:
            break

        if box_type != b"moov" and child_type in MOOV_CHILD_TYPES:
            break

        if child_type in CONTAINER_TYPES:
            child_end = _resync_container(data, offset, limit)
        if child_end <= offset:
            break
        offset = child_end

    data[start : start + 4] = struct.pack(">I", offset - start)
    return offset


def _sync_all_container_sizes(moov_data: bytearray) -> None:
    _resync_container(moov_data, 0, len(moov_data))


def _find_boxes(data: bytearray, start: int, end: int, box_type: bytes) -> List[BoxRef]:
    found: List[BoxRef] = []
    for box in _iter_boxes(data, start, end):
        if box.box_type == box_type:
            found.append(box)
        payload_start = box.start + 8
        if box.box_type in CONTAINER_TYPES:
            found.extend(_find_boxes(data, payload_start, box.end, box_type))
    return found


def _needs_v1_time_atom(target_seconds: int) -> bool:
    return target_seconds < 0 or target_seconds > 0xFFFFFFFF


def _upgrade_time_atom_payload(payload: bytes, target_seconds: int) -> bytes:
    if len(payload) < 4:
        raise ValueError("time atom payload too small")
    version = payload[0]
    flags = payload[1:4]

    if version == 0 and not _needs_v1_time_atom(target_seconds):
        patched = bytearray(payload)
        patched[4:8] = struct.pack(">I", target_seconds)
        patched[8:12] = struct.pack(">I", target_seconds)
        return bytes(patched)

    if version == 0:
        if len(payload) < 20:
            raise ValueError("time atom version 0 payload too small")
        timescale = payload[12:16]
        duration = payload[16:20]
        tail = payload[20:]
        return (
            bytes([1])
            + flags
            + struct.pack(">q", target_seconds)
            + struct.pack(">q", target_seconds)
            + timescale
            + duration
            + b"\x00\x00\x00\x00"
            + tail
        )

    if version == 1:
        if len(payload) < 32:
            raise ValueError("time atom version 1 payload too small")
        patched = bytearray(payload)
        patched[4:12] = struct.pack(">q", target_seconds)
        patched[12:20] = struct.pack(">q", target_seconds)
        return bytes(patched)

    raise ValueError(f"unsupported time atom version {version}")


def _replace_box_bytes(data: bytearray, box: BoxRef, new_payload: bytes) -> None:
    header = data[box.start : box.start + 8]
    new_size = 8 + len(new_payload)
    data[box.start : box.end] = struct.pack(">I", new_size) + header[4:8] + new_payload


def _moov_content_bounds(moov_data: bytearray) -> Tuple[int, int]:
    if len(moov_data) < 8 or moov_data[4:8] != b"moov":
        raise QuickTimeDatePatchError("invalid moov atom slice")
    return 8, len(moov_data)


def _patch_chunk_offsets(moov_data: bytearray, delta: int) -> None:
    if delta == 0:
        return
    content_start, _content_end = _moov_content_bounds(moov_data)
    for atom_type in CHUNK_OFFSET_ATOM_TYPES:
        for box in _find_boxes(moov_data, content_start, len(moov_data), atom_type):
            payload_start = box.start + 8
            payload = moov_data[payload_start:box.end]
            if len(payload) < 8:
                continue
            version = payload[0]
            entry_count = struct.unpack(">I", payload[4:8])[0]
            entries_start = 8
            patched = bytearray(payload)
            if atom_type == b"stco":
                for index in range(entry_count):
                    offset = entries_start + index * 4
                    if offset + 4 > len(payload):
                        break
                    value = struct.unpack(">I", payload[offset : offset + 4])[0]
                    patched[offset : offset + 4] = struct.pack(">I", value + delta)
            else:
                for index in range(entry_count):
                    offset = entries_start + index * 8
                    if offset + 8 > len(payload):
                        break
                    value = struct.unpack(">Q", payload[offset : offset + 8])[0]
                    patched[offset : offset + 8] = struct.pack(">Q", value + delta)
            if version != 0:
                continue
            _replace_box_bytes(moov_data, box, bytes(patched))


def _patch_time_atoms(moov_data: bytearray, target_seconds: int) -> None:
    content_start, content_end = _moov_content_bounds(moov_data)
    boxes: List[BoxRef] = []
    for atom_type in TIME_ATOM_TYPES:
        boxes.extend(_find_boxes(moov_data, content_start, len(moov_data), atom_type))

    for box in sorted(boxes, key=lambda item: item.start, reverse=True):
        payload = bytes(moov_data[box.start + 8 : box.end])
        new_payload = _upgrade_time_atom_payload(payload, target_seconds)
        if new_payload == payload:
            continue
        _replace_box_bytes(moov_data, box, new_payload)


def _read_mvhd_creation_seconds(data: bytes) -> int:
    layout = _scan_top_level(data)
    if layout.moov is None:
        raise QuickTimeDatePatchError("QuickTime moov atom not found")
    moov_data = data[layout.moov.start : layout.moov.end]
    boxes = _find_boxes(bytearray(moov_data), 8, len(moov_data), b"mvhd")
    if not boxes:
        raise QuickTimeDatePatchError("QuickTime mvhd atom not found")
    box = boxes[0]
    payload = moov_data[box.start + 8 : box.end]
    if len(payload) < 12:
        raise QuickTimeDatePatchError("QuickTime mvhd payload too small")
    if payload[0] == 0:
        if len(payload) < 12:
            raise QuickTimeDatePatchError("QuickTime mvhd v0 payload too small")
        return struct.unpack(">I", payload[4:8])[0]
    if payload[0] == 1:
        return struct.unpack(">q", payload[4:12])[0]
    raise QuickTimeDatePatchError(f"unsupported mvhd version {payload[0]}")


def quicktime_seconds_to_canonical(seconds: int) -> str:
    from datetime import timedelta

    resolved = QUICKTIME_EPOCH + timedelta(seconds=seconds)
    return resolved.strftime(CANONICAL_DB_DATE_FORMAT)


def read_mvhd_canonical_date(file_path: str) -> str:
    """Read mvhd creation time from QuickTime atoms."""
    with open(file_path, "rb") as handle:
        file_data = handle.read()
    return quicktime_seconds_to_canonical(_read_mvhd_creation_seconds(file_data))


def _verify_mov_health(file_path: str, expected_date: str) -> None:
    expected_seconds = quicktime_seconds_from_canonical(expected_date)
    with open(file_path, "rb") as handle:
        file_data = handle.read()
    actual_seconds = _read_mvhd_creation_seconds(file_data)
    if actual_seconds != expected_seconds:
        raise QuickTimeDatePatchError(
            f"mvhd verification failed: expected {expected_seconds}, got {actual_seconds}"
        )

    ffprobe = subprocess.run(
        [
            "ffprobe",
            "-v",
            "quiet",
            "-print_format",
            "json",
            "-show_entries",
            "format_tags=creation_time",
            file_path,
        ],
        capture_output=True,
        text=True,
        timeout=30,
    )
    if ffprobe.returncode == 0:
        payload = json.loads(ffprobe.stdout or "{}")
        creation_time = payload.get("format", {}).get("tags", {}).get("creation_time")
        actual = _normalize_ffprobe_creation_time(creation_time)
        if actual and actual != expected_date:
            raise QuickTimeDatePatchError(
                f"ffprobe cross-check failed: expected {expected_date}, got {actual}"
            )

    decode = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", file_path, "-frames:v", "1", "-f", "null", "-"],
        capture_output=True,
        text=True,
        timeout=60,
    )
    if decode.returncode != 0:
        raise QuickTimeDatePatchError(
            f"ffmpeg decode failed after atom patch: {decode.stderr.strip() or decode.stdout}"
        )


def remove_quicktime_patch_artifacts(file_path: str) -> None:
    """Remove atom-patch backup/temp files adjacent to a media file."""
    for suffix in PATCH_ARTIFACT_SUFFIXES:
        artifact = f"{file_path}{suffix}"
        if os.path.exists(artifact):
            os.remove(artifact)


def cleanup_orphan_patch_artifacts_in_dir(directory: str) -> None:
    """Remove stray patch artifacts in a library folder."""
    if not os.path.isdir(directory):
        return
    for name in os.listdir(directory):
        if name.endswith(PATCH_ARTIFACT_SUFFIXES):
            try:
                os.remove(os.path.join(directory, name))
            except OSError:
                pass


def write_quicktime_media_date(file_path: str, new_date: str) -> None:
    """Patch QuickTime moov time atoms (mvhd/tkhd/mdhd) to the target date."""
    target_seconds = quicktime_seconds_from_canonical(new_date)
    backup_path = f"{file_path}.bak"

    with open(file_path, "rb") as handle:
        original = bytearray(handle.read())

    layout = _scan_top_level(original)
    if layout.moov is None:
        raise QuickTimeDatePatchError("QuickTime moov atom not found")

    moov_before_mdat = (
        layout.mdat is not None and layout.moov.start < layout.mdat.start
    )
    old_moov = bytearray(original[layout.moov.start : layout.moov.end])
    old_moov_size = len(old_moov)

    _patch_time_atoms(old_moov, target_seconds)
    _sync_all_container_sizes(old_moov)
    moov_delta = len(old_moov) - old_moov_size
    if moov_before_mdat:
        _patch_chunk_offsets(old_moov, moov_delta)

    old_moov[0:4] = struct.pack(">I", len(old_moov))

    patched = bytearray()
    patched.extend(original[: layout.moov.start])
    patched.extend(old_moov)
    patched.extend(original[layout.moov.end :])

    if os.path.exists(backup_path):
        os.remove(backup_path)
    shutil.copy2(file_path, backup_path)

    temp_path = f"{file_path}.atompatch"
    try:
        with open(temp_path, "wb") as handle:
            handle.write(patched)
        os.replace(temp_path, file_path)
        _verify_mov_health(file_path, new_date)
    except Exception:
        if os.path.exists(backup_path):
            shutil.copy2(backup_path, file_path)
        raise
    else:
        if os.path.exists(backup_path):
            os.remove(backup_path)
    finally:
        if os.path.exists(temp_path):
            os.remove(temp_path)
