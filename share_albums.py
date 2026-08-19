"""Publish photo selections to Supabase Storage + Postgres album catalog."""

from __future__ import annotations

import json
import os
import re
import secrets
import string
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime
from typing import Any, Callable, Dict, Iterator, List, Optional, Tuple

SHARE_BUCKET = "shares"
SHARE_MAX_PHOTOS = 1000
_SLUG_ALPHABET = string.ascii_lowercase + string.digits


def load_env_file(base_dir: str) -> None:
    """Load KEY=VALUE lines from .env into os.environ (no overwrite)."""
    from runtime_paths import get_app_support_dir, is_frozen

    candidates = [os.path.join(base_dir, ".env")]
    if is_frozen():
        candidates.insert(0, os.path.join(get_app_support_dir(), ".env"))

    for env_path in candidates:
        if not os.path.isfile(env_path):
            continue
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


def share_config_error() -> Optional[str]:
    from runtime_paths import get_app_support_dir, is_frozen

    url, service_key, viewer_base = get_share_config()
    env_hint = (
        f"~/Library/Application Support/Photos Light/.env"
        if is_frozen()
        else ".env in the photos-light folder"
    )
    if not url:
        return f"Missing SUPABASE_URL in {env_hint}"
    if not service_key:
        return f"Missing SUPABASE_SERVICE_ROLE_KEY in {env_hint}"
    if not viewer_base:
        return f"Missing SHARE_VIEWER_BASE_URL in {env_hint}"
    return None


def generate_share_slug(length: int = 12) -> str:
    return "".join(secrets.choice(_SLUG_ALPHABET) for _ in range(length))


def generate_access_token(length: int = 32) -> str:
    """URL-safe capability token for share links (?t=)."""
    token = secrets.token_urlsafe(24)
    if len(token) >= length:
        return token[:length]
    extra = "".join(secrets.choice(_SLUG_ALPHABET) for _ in range(length - len(token)))
    return token + extra


def build_share_url(access_token: str, viewer_base: Optional[str] = None) -> str:
    _, _, base = get_share_config()
    root = (viewer_base or base).rstrip("/")
    return f"{root}/?t={access_token}"


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


def insert_album(
    slug: str,
    access_token: str,
    title: Optional[str],
    photo_count: int,
) -> Dict[str, Any]:
    payload = json.dumps(
        {
            "slug": slug,
            "access_token": access_token,
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


def _parse_postgres_timestamptz(text: str) -> Optional[datetime]:
    """Parse Postgres timestamptz strings with variable fractional-second precision."""
    normalized = text.strip().replace("Z", "+00:00")
    match = re.match(
        r"^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(?:\.(\d+))?([+-]\d{2}(?::?\d{2})?)?$",
        normalized,
    )
    if not match:
        return None

    date_part, time_part, fractional, tz_part = match.groups()
    iso_base = f"{date_part}T{time_part}"
    if fractional is not None:
        micros = (fractional + "000000")[:6]
        iso_base = f"{iso_base}.{micros}"
    if tz_part:
        if len(tz_part) == 3:
            tz_part = f"{tz_part}:00"
        iso_base = f"{iso_base}{tz_part}"

    try:
        return datetime.fromisoformat(iso_base)
    except ValueError:
        return None


def format_album_created_date(created_at: str) -> str:
    """Format album created_at for manage-links labels (e.g. Aug 18 2026)."""
    text = (created_at or "").strip()
    if not text:
        return ""
    normalized = text.replace("Z", "+00:00")
    try:
        parsed = datetime.fromisoformat(normalized)
    except ValueError:
        parsed = _parse_postgres_timestamptz(text)
        if parsed is None:
            return text[:10]
    return parsed.strftime("%b %d %Y")


def format_album_label(title: Optional[str], created_at: str) -> str:
    date_label = format_album_created_date(created_at)
    cleaned_title = (title or "").strip()
    if cleaned_title:
        return f"{cleaned_title} ({date_label})" if date_label else cleaned_title
    return date_label or "Shared link"


def list_share_albums() -> List[Dict[str, Any]]:
    rows = _supabase_request(
        "GET",
        "/rest/v1/albums?select=id,title,created_at,access_token&order=created_at.desc",
    )
    if not rows:
        return []

    albums: List[Dict[str, Any]] = []
    for row in rows:
        access_token = row.get("access_token") or ""
        created_at = row.get("created_at") or ""
        title = row.get("title")
        albums.append(
            {
                "id": row["id"],
                "title": title,
                "created_at": created_at,
                "url": build_share_url(access_token) if access_token else "",
                "label": format_album_label(title, created_at),
            }
        )
    return albums


def _normalize_storage_path(prefix: str, name: str) -> str:
    if name.startswith(prefix):
        return name
    return f"{prefix.rstrip('/')}/{name.lstrip('/')}"


def _is_storage_folder(entry: Dict[str, Any]) -> bool:
    if not entry:
        return False
    if entry.get("id"):
        return False
    if entry.get("metadata") is not None:
        return False
    return bool((entry.get("name") or "").strip())


def _list_all_storage_files(prefix: str) -> List[str]:
    """Recursively list file object paths under a storage prefix."""
    normalized_prefix = prefix if prefix.endswith("/") else f"{prefix}/"
    paths: List[str] = []
    seen_paths = set()
    seen_prefixes = set()
    stack = [normalized_prefix]

    while stack:
        current_prefix = stack.pop()
        offset = 0
        while True:
            payload = json.dumps(
                {"prefix": current_prefix, "limit": 1000, "offset": offset}
            ).encode("utf-8")
            batch = _supabase_request(
                "POST",
                f"/storage/v1/object/list/{SHARE_BUCKET}",
                body=payload,
            ) or []
            if not batch:
                break

            for item in batch:
                name = (item or {}).get("name")
                if not name:
                    continue
                full_path = _normalize_storage_path(current_prefix, name)
                if _is_storage_folder(item):
                    folder_prefix = (
                        full_path if full_path.endswith("/") else f"{full_path}/"
                    )
                    if folder_prefix not in seen_prefixes:
                        seen_prefixes.add(folder_prefix)
                        stack.append(folder_prefix)
                    continue
                if full_path not in seen_paths:
                    seen_paths.add(full_path)
                    paths.append(full_path)

            if len(batch) < 1000:
                break
            offset += 1000

    return paths


def _delete_storage_paths(paths: List[str], *, retries: int = 3) -> None:
    if not paths:
        return
    unique_paths = list(dict.fromkeys(paths))
    chunk_size = 1000
    for start in range(0, len(unique_paths), chunk_size):
        chunk = unique_paths[start : start + chunk_size]
        payload = json.dumps({"prefixes": chunk}).encode("utf-8")
        last_error: Optional[RuntimeError] = None
        for attempt in range(retries):
            try:
                _supabase_request(
                    "DELETE",
                    f"/storage/v1/object/{SHARE_BUCKET}",
                    body=payload,
                )
                last_error = None
                break
            except RuntimeError as exc:
                last_error = exc
                if attempt + 1 >= retries:
                    raise
                time.sleep(0.25 * (attempt + 1))
        if last_error is not None:
            raise last_error


def delete_share_album(album_id: str) -> None:
    """Hard-delete one share: catalog row first (link 404), then storage cleanup."""
    album_key = urllib.parse.quote(str(album_id or "").strip(), safe="")
    if not album_key:
        raise ValueError("Missing album id")

    album_rows = _supabase_request(
        "GET",
        f"/rest/v1/albums?id=eq.{album_key}&select=id,access_token",
    )
    if not album_rows:
        raise ValueError("Share not found")

    access_token = album_rows[0].get("access_token") or ""
    if not access_token:
        raise ValueError("Share missing access token")

    photo_rows = _supabase_request(
        "GET",
        f"/rest/v1/album_photos?album_id=eq.{album_key}&select=thumb_path,original_path",
    ) or []

    storage_paths: List[str] = []
    seen = set()

    def add_path(path: Optional[str]) -> None:
        if path and path not in seen:
            seen.add(path)
            storage_paths.append(path)

    for row in photo_rows:
        add_path(row.get("thumb_path"))
        add_path(row.get("original_path"))

    prefix = f"{access_token}/"
    if not storage_paths:
        for path in _list_all_storage_files(prefix):
            add_path(path)

    _supabase_request("DELETE", f"/rest/v1/albums?id=eq.{album_key}")

    if not storage_paths:
        return

    try:
        _delete_storage_paths(storage_paths)
    except RuntimeError:
        # Catalog is already gone — link is dead; storage cleanup is best-effort.
        return


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


def iter_publish_share_album(
    *,
    slug: str,
    access_token: str,
    title: Optional[str],
    photo_rows: List[Dict[str, Any]],
    library_path: str,
    generate_still_thumb,
    generate_video_thumb,
    to_rgb,
):
    """
    Upload originals + thumbs to Supabase and insert album catalog rows.

    Yields (event_name, payload) tuples for SSE streaming.
    photo_rows: sqlite rows with id, current_path, date_taken, file_type, width, height, rating
    """
    if len(photo_rows) > SHARE_MAX_PHOTOS:
        raise ValueError(f"Share limit is {SHARE_MAX_PHOTOS} photos")

    album = insert_album(slug, access_token, title, len(photo_rows))
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
        storage_base = f"{access_token}/{index:04d}_{photo_id}"
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

        yield (
            "progress",
            {
                "completed": index + 1,
                "total": len(photo_rows),
                "photo_id": photo_id,
            },
        )

    insert_album_photos(catalog_rows)
    share_url = build_share_url(access_token)
    yield (
        "complete",
        {
            "slug": slug,
            "access_token": access_token,
            "url": share_url,
            "title": title,
            "photo_count": len(photo_rows),
            "album_id": album_id,
        },
    )


def publish_share_album(
    *,
    slug: str,
    access_token: str,
    title: Optional[str],
    photo_rows: List[Dict[str, Any]],
    library_path: str,
    generate_still_thumb,
    generate_video_thumb,
    to_rgb,
    on_progress: Optional[Callable[[Dict[str, Any]], None]] = None,
) -> Dict[str, Any]:
    """Blocking publish wrapper — use iter_publish_share_album for SSE."""
    result: Optional[Dict[str, Any]] = None
    for event_name, payload in iter_publish_share_album(
        slug=slug,
        access_token=access_token,
        title=title,
        photo_rows=photo_rows,
        library_path=library_path,
        generate_still_thumb=generate_still_thumb,
        generate_video_thumb=generate_video_thumb,
        to_rgb=to_rgb,
    ):
        if on_progress:
            on_progress({"type": event_name, **payload})
        if event_name == "complete":
            result = payload
    if result is None:
        raise RuntimeError("Share publish did not complete")
    return result
