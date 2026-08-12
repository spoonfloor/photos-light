"""Publish photo selections to Supabase Storage + Postgres album catalog."""

from __future__ import annotations

import json
import os
import secrets
import string
import tempfile
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime
from typing import Any, Callable, Dict, Iterator, List, Optional, Tuple

SHARE_BUCKET = "shares"
SHARE_MAX_PHOTOS = 1000
_SLUG_ALPHABET = string.ascii_lowercase + string.digits


def load_env_file(base_dir: str) -> None:
    """Load KEY=VALUE lines from repo-root .env into os.environ (no overwrite)."""
    env_path = os.path.join(base_dir, ".env")
    if not os.path.isfile(env_path):
        return
    with open(env_path, encoding="utf-8") as handle:
        for raw_line in handle:
            line = raw_line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            os.environ.setdefault(key.strip(), value.strip())


def get_share_config() -> Tuple[str, str, str]:
    url = os.environ.get("SUPABASE_URL", "").rstrip("/")
    service_key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "").strip()
    viewer_base = os.environ.get("SHARE_VIEWER_BASE_URL", "").rstrip("/")
    return url, service_key, viewer_base


def share_is_configured() -> bool:
    url, service_key, viewer_base = get_share_config()
    return bool(url and service_key and viewer_base)


def generate_share_slug(length: int = 12) -> str:
    return "".join(secrets.choice(_SLUG_ALPHABET) for _ in range(length))


def build_share_url(slug: str, viewer_base: Optional[str] = None) -> str:
    _, _, base = get_share_config()
    root = (viewer_base or base).rstrip("/")
    return f"{root}/?s={slug}"


def parse_photo_date(date_str: Optional[str]) -> Optional[datetime]:
    if not date_str:
        return None
    text = date_str.strip()
    if len(text) >= 19 and text[4] == ":":
        try:
            return datetime.strptime(text[:19], "%Y:%m:%d %H:%M:%S")
        except ValueError:
            pass
    if len(text) >= 10 and text[4] == "-":
        try:
            return datetime.strptime(text[:10], "%Y-%m-%d")
        except ValueError:
            pass
    return None


def suggest_share_title(date_strings: List[Optional[str]]) -> str:
    parsed = [dt for dt in (parse_photo_date(value) for value in date_strings) if dt]
    if not parsed:
        return "Shared Photos"
    unique_days = {dt.date() for dt in parsed}
    if len(unique_days) == 1:
        day = next(iter(unique_days))
        return f"{day.strftime('%b')} {day.day} Photos"
    unique_months = {(dt.year, dt.month) for dt in parsed}
    if len(unique_months) == 1:
        year, month = next(iter(unique_months))
        sample = datetime(year, month, 1)
        return f"{sample.strftime('%B %Y')} Photos"
    return "Shared Photos"


def _supabase_request(
    method: str,
    path: str,
    *,
    body: Optional[bytes] = None,
    content_type: str = "application/json",
    extra_headers: Optional[Dict[str, str]] = None,
) -> Any:
    supabase_url, service_key, _viewer_base = get_share_config()
    if not supabase_url or not service_key:
        raise RuntimeError("Supabase share is not configured")

    headers = {
        "Authorization": f"Bearer {service_key}",
        "apikey": service_key,
        "Content-Type": content_type,
    }
    if extra_headers:
        headers.update(extra_headers)

    request = urllib.request.Request(
        f"{supabase_url}{path}",
        data=body,
        headers=headers,
        method=method,
    )
    try:
        with urllib.request.urlopen(request, timeout=120) as response:
            payload = response.read()
            if not payload:
                return None
            if "application/json" in response.headers.get("Content-Type", ""):
                return json.loads(payload.decode("utf-8"))
            return payload
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"Supabase {method} {path} failed ({exc.code}): {detail}") from exc


def insert_album(slug: str, title: Optional[str], photo_count: int) -> Dict[str, Any]:
    payload = json.dumps(
        {
            "slug": slug,
            "title": title or None,
            "photo_count": photo_count,
        }
    ).encode("utf-8")
    rows = _supabase_request(
        "POST",
        "/rest/v1/albums",
        body=payload,
        extra_headers={"Prefer": "return=representation"},
    )
    if not rows:
        raise RuntimeError("Album insert returned no rows")
    return rows[0]


def insert_album_photos(rows: List[Dict[str, Any]]) -> None:
    if not rows:
        return
    payload = json.dumps(rows).encode("utf-8")
    _supabase_request(
        "POST",
        "/rest/v1/album_photos",
        body=payload,
        extra_headers={"Prefer": "return=minimal"},
    )


def upload_storage_object(storage_path: str, data: bytes, content_type: str) -> None:
    encoded_path = "/".join(urllib.parse.quote(part, safe="") for part in storage_path.split("/"))
    _supabase_request(
        "POST",
        f"/storage/v1/object/{SHARE_BUCKET}/{encoded_path}",
        body=data,
        content_type=content_type,
        extra_headers={"x-upsert": "true"},
    )


def guess_content_type(file_path: str, file_type: str) -> str:
    ext = os.path.splitext(file_path)[1].lower()
    if file_type == "video":
        if ext in {".mov", ".qt"}:
            return "video/quicktime"
        if ext == ".webm":
            return "video/webm"
        return "video/mp4"
    mapping = {
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".png": "image/png",
        ".gif": "image/gif",
        ".webp": "image/webp",
        ".heic": "image/heic",
        ".heif": "image/heif",
    }
    return mapping.get(ext, "application/octet-stream")


def publish_share_album(
    *,
    slug: str,
    title: Optional[str],
    photo_rows: List[Dict[str, Any]],
    library_path: str,
    generate_still_thumb,
    generate_video_thumb,
    to_rgb,
    on_progress: Optional[Callable[[Dict[str, Any]], None]] = None,
) -> Dict[str, Any]:
    """
    Upload originals + thumbs to Supabase and insert album catalog rows.

    photo_rows: sqlite rows with id, current_path, date_taken, file_type, width, height, rating
    """
    if len(photo_rows) > SHARE_MAX_PHOTOS:
        raise ValueError(f"Share limit is {SHARE_MAX_PHOTOS} photos")

    album = insert_album(slug, title, len(photo_rows))
    album_id = album["id"]
    catalog_rows: List[Dict[str, Any]] = []

    for index, row in enumerate(photo_rows):
        relative_path = row["current_path"]
        if not relative_path:
            raise RuntimeError(f"Photo {row['id']} is missing a file path")

        full_path = os.path.join(library_path, relative_path)
        if not os.path.exists(full_path):
            raise RuntimeError(f"Photo file not found: {relative_path}")

        photo_id = row["id"]
        file_type = row["file_type"] if row["file_type"] == "video" else "photo"
        ext = os.path.splitext(relative_path)[1].lower() or ".jpg"
        original_name = os.path.basename(relative_path)
        storage_base = f"{slug}/{index:04d}_{photo_id}"
        original_path = f"{storage_base}/original{ext}"
        thumb_path = f"{storage_base}/thumb.jpg"

        with open(full_path, "rb") as handle:
            original_bytes = handle.read()
        upload_storage_object(
            original_path,
            original_bytes,
            guess_content_type(relative_path, file_type),
        )

        with tempfile.NamedTemporaryFile(suffix=".jpg", delete=False) as temp_thumb:
            temp_thumb_path = temp_thumb.name
        try:
            if file_type == "video":
                temp_frame = temp_thumb_path + ".frame.jpg"
                generate_video_thumb(
                    full_path,
                    temp_thumb_path,
                    temp_frame_path=temp_frame,
                    to_rgb=to_rgb,
                )
                if os.path.exists(temp_frame):
                    os.remove(temp_frame)
            else:
                generate_still_thumb(full_path, temp_thumb_path, to_rgb=to_rgb)
            with open(temp_thumb_path, "rb") as handle:
                thumb_bytes = handle.read()
            upload_storage_object(thumb_path, thumb_bytes, "image/jpeg")
        finally:
            if os.path.exists(temp_thumb_path):
                os.remove(temp_thumb_path)

        parsed_date = parse_photo_date(row["date_taken"])
        catalog_rows.append(
            {
                "album_id": album_id,
                "position": index,
                "date_taken": parsed_date.isoformat() if parsed_date else None,
                "file_type": file_type,
                "width": row["width"],
                "height": row["height"],
                "rating": row["rating"] if row["rating"] == 5 else None,
                "thumb_path": thumb_path,
                "original_path": original_path,
                "original_filename": original_name,
            }
        )

        if on_progress:
            on_progress(
                {
                    "type": "progress",
                    "completed": index + 1,
                    "total": len(photo_rows),
                    "photo_id": photo_id,
                }
            )

    insert_album_photos(catalog_rows)
    share_url = build_share_url(slug)
    result = {
        "slug": slug,
        "url": share_url,
        "title": title,
        "photo_count": len(photo_rows),
        "album_id": album_id,
    }
    if on_progress:
        on_progress({"type": "complete", **result})
    return result
