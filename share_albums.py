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

from image_pixels import (
    still_image_to_jpeg_buffer,
    video_to_browser_mp4_buffer,
)
from share_delivery import (
    estimate_share_upload_size_bytes,
    plan_share_delivery,
)

SHARE_BUCKET = "shares"
SHARE_MAX_PHOTOS = 1000
SHARE_API_TIMEOUT_SEC = 120
SHARE_STORAGE_TIMEOUT_SEC = 600
SHARE_STORAGE_UPLOAD_RETRIES = 3
# Conservative global cap when SHARE_STORAGE_MAX_BYTES is unset (Supabase Free tier).
SHARE_DEFAULT_STORAGE_MAX_BYTES = 50 * 1024 * 1024
SHARE_OVERSIZED_DETAILS_LIMIT = 50
_SLUG_ALPHABET = string.ascii_lowercase + string.digits


class SharePublishError(RuntimeError):
    """Structured share publish failure for SSE + terminal logs."""

    def __init__(
        self,
        code: str,
        message: str,
        *,
        photo_index: Optional[int] = None,
        photo_id: Optional[int] = None,
        step: Optional[str] = None,
        detail: Optional[str] = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.photo_index = photo_index
        self.photo_id = photo_id
        self.step = step
        self.detail = detail or message

    def to_payload(self) -> Dict[str, Any]:
        payload: Dict[str, Any] = {
            "error": str(self),
            "code": self.code,
            "detail": self.detail,
        }
        if self.photo_index is not None:
            payload["photo_index"] = self.photo_index
        if self.photo_id is not None:
            payload["photo_id"] = self.photo_id
        if self.step:
            payload["step"] = self.step
        return payload


def _share_log(message: str) -> None:
    print(f"[share] {message}", flush=True)


def _classify_share_failure(
    exc: BaseException,
    *,
    photo_index: Optional[int] = None,
    photo_id: Optional[int] = None,
    step: Optional[str] = None,
) -> SharePublishError:
    if isinstance(exc, SharePublishError):
        return exc

    message = str(exc)
    lowered = message.lower()
    code = "share_unknown"
    if "file not found" in lowered or "missing a file path" in lowered:
        code = "share_file_missing"
    elif "timed out" in lowered or "timeout" in lowered:
        code = "share_upload_timeout"
    elif (
        "entity too large" in lowered
        or "payload too large" in lowered
        or "file size limit" in lowered
        or "file too large" in lowered
        or "413" in message
    ):
        code = "share_file_too_large"
    elif "invalid_mime_type" in lowered or "invalidmimetype" in lowered:
        code = "share_unsupported_format"
    elif "supabase" in lowered and "storage" in lowered:
        code = "share_storage_error"
    elif "supabase" in lowered:
        code = "share_supabase_error"
    elif "share limit" in lowered:
        code = "share_limit"

    return SharePublishError(
        code,
        message,
        photo_index=photo_index,
        photo_id=photo_id,
        step=step,
        detail=message,
    )


def _log_share_failure(exc: BaseException) -> None:
    if isinstance(exc, SharePublishError):
        _share_log(
            "FAILED "
            f"code={exc.code} "
            f"photo_index={exc.photo_index if exc.photo_index is not None else '-'} "
            f"photo_id={exc.photo_id if exc.photo_id is not None else '-'} "
            f"step={exc.step or '-'} "
            f"detail={exc.detail}"
        )
        return
    _share_log(f"FAILED detail={exc}")


def validate_photos_for_share(
    library_path: str,
    photo_rows: List[Dict[str, Any]],
) -> None:
    """Raise SharePublishError when selected files are missing on disk."""
    for index, row in enumerate(photo_rows):
        # sqlite3.Row (library fetch) has no .get(); bracket access works for Row + dict.
        relative_path = row["current_path"]
        photo_id = row["id"]
        if not relative_path:
            raise SharePublishError(
                "share_file_missing",
                f"Photo {photo_id} is missing a file path",
                photo_index=index,
                photo_id=photo_id,
                step="validate",
            )
        full_path = os.path.join(library_path, relative_path)
        if not os.path.exists(full_path):
            raise SharePublishError(
                "share_file_missing",
                f"Photo file not found: {relative_path}",
                photo_index=index,
                photo_id=photo_id,
                step="validate",
                detail=relative_path,
            )


def bytes_to_display_mb(size_bytes: int) -> float:
    """Human MB for share copy (1 MiB = 1024² bytes)."""
    return round(size_bytes / (1024 * 1024), 1)


def _env_share_storage_max_bytes() -> Optional[int]:
    raw = os.environ.get("SHARE_STORAGE_MAX_BYTES", "").strip()
    if raw:
        try:
            return int(raw)
        except ValueError:
            pass
    raw_mb = os.environ.get("SHARE_STORAGE_MAX_MB", "").strip()
    if raw_mb:
        try:
            return int(float(raw_mb) * 1024 * 1024)
        except ValueError:
            pass
    return None


def fetch_share_bucket_file_size_limit() -> Optional[int]:
    """Return bucket file_size_limit bytes, or None if unavailable."""
    try:
        data = _supabase_request("GET", f"/storage/v1/bucket/{SHARE_BUCKET}")
    except Exception as exc:
        _share_log(f"prepare bucket limit lookup failed detail={exc}")
        return None
    if not isinstance(data, dict):
        return None
    limit = data.get("file_size_limit")
    if limit is None:
        return None
    try:
        return int(limit)
    except (TypeError, ValueError):
        return None


def get_share_storage_max_bytes() -> int:
    """
    Effective per-object upload cap: min(env global, bucket limit, default global).
    Env SHARE_STORAGE_MAX_BYTES (or SHARE_STORAGE_MAX_MB) mirrors dashboard global limit.
    """
    limits: List[int] = []
    env_limit = _env_share_storage_max_bytes()
    if env_limit is not None and env_limit > 0:
        limits.append(env_limit)
    else:
        limits.append(SHARE_DEFAULT_STORAGE_MAX_BYTES)
    bucket_limit = fetch_share_bucket_file_size_limit()
    if bucket_limit is not None and bucket_limit > 0:
        limits.append(bucket_limit)
    return min(limits)


def _row_file_type(row: Any) -> str:
    try:
        value = row["file_type"]
    except (KeyError, IndexError, TypeError):
        value = None
    return "video" if value == "video" else "photo"


def partition_share_photos_by_size(
    library_path: str,
    photo_rows: List[Any],
    max_bytes: int,
) -> Tuple[List[Dict[str, Any]], List[int]]:
    """
    Split selection into oversized entries and shareable photo ids (preserves input order).
    """
    oversized: List[Dict[str, Any]] = []
    shareable_ids: List[int] = []
    for row in photo_rows:
        photo_id = int(row["id"])
        relative_path = row["current_path"]
        file_type = _row_file_type(row)
        full_path = os.path.join(library_path, relative_path)
        size_bytes = estimate_share_upload_size_bytes(
            library_path,
            relative_path,
            file_type,
        )
        if size_bytes <= 0:
            try:
                size_bytes = os.path.getsize(full_path)
            except OSError:
                size_bytes = max_bytes + 1
        if size_bytes > max_bytes:
            filename = os.path.basename(relative_path) or relative_path
            oversized.append(
                {
                    "photo_id": photo_id,
                    "filename": filename,
                    "size_bytes": size_bytes,
                    "size_mb": bytes_to_display_mb(size_bytes),
                }
            )
        else:
            shareable_ids.append(photo_id)
    oversized.sort(key=lambda item: item["size_bytes"], reverse=True)
    return oversized, shareable_ids


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
    timeout: int = SHARE_API_TIMEOUT_SEC,
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
        with urllib.request.urlopen(request, timeout=timeout) as response:
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


def _get_completed_share_positions(album_id: str) -> set[int]:
    album_key = urllib.parse.quote(str(album_id).strip(), safe="")
    rows = _supabase_request(
        "GET",
        f"/rest/v1/album_photos?album_id=eq.{album_key}&select=position",
    ) or []
    positions: set[int] = set()
    for row in rows:
        try:
            positions.add(int(row["position"]))
        except (KeyError, TypeError, ValueError):
            continue
    return positions


def _find_or_create_share_album(
    slug: str,
    access_token: str,
    title: Optional[str],
    photo_count: int,
) -> Dict[str, Any]:
    existing = _lookup_share_album_rows(access_token=access_token, slug=slug)
    if existing:
        album = existing[0]
        _share_log(
            f"resume existing album id={album['id']} slug={slug} "
            f"photo_count={album.get('photo_count')}"
        )
        return album

    try:
        album = insert_album(slug, access_token, title, photo_count)
        _share_log(f"created album id={album['id']} slug={slug} photos={photo_count}")
        return album
    except RuntimeError as exc:
        if not _is_duplicate_slug_error(exc):
            raise
        _share_log(f"duplicate slug {slug}; cleaning orphan then retrying insert")
        cleanup_share_album(access_token=access_token, slug=slug)
        album = insert_album(slug, access_token, title, photo_count)
        _share_log(f"created album id={album['id']} slug={slug} photos={photo_count}")
        return album


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


def _is_duplicate_slug_error(exc: BaseException) -> bool:
    message = str(exc)
    return "23505" in message or "already exists" in message


def _collect_album_storage_paths(
    album_key: str,
    access_token: str,
) -> List[str]:
    photo_rows = _supabase_request(
        "GET",
        f"/rest/v1/album_photos?album_id=eq.{album_key}&select=thumb_path,original_path,display_path",
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
        add_path(row.get("display_path"))

    prefix = f"{access_token}/"
    if not storage_paths:
        for path in _list_all_storage_files(prefix):
            add_path(path)
    return storage_paths


def _delete_album_catalog_and_storage(album_key: str, access_token: str) -> None:
    """Hard-delete one share: catalog row first (link 404), then storage cleanup."""
    storage_paths = _collect_album_storage_paths(album_key, access_token)
    _supabase_request("DELETE", f"/rest/v1/albums?id=eq.{album_key}")
    if not storage_paths:
        return
    try:
        _delete_storage_paths(storage_paths)
    except RuntimeError:
        # Catalog is already gone — link is dead; storage cleanup is best-effort.
        return


def _cleanup_storage_prefix(access_token: str) -> None:
    token = (access_token or "").strip()
    if not token:
        return
    prefix = f"{token}/"
    paths = _list_all_storage_files(prefix)
    if not paths:
        return
    try:
        _delete_storage_paths(paths)
    except RuntimeError:
        return


def cleanup_share_album(
    *,
    album_id: Optional[str] = None,
    access_token: Optional[str] = None,
    slug: Optional[str] = None,
) -> bool:
    """
    Hard-delete share catalog + storage. Idempotent when nothing exists.

    Returns True when an album catalog row was removed.
    """
    token = (access_token or "").strip()
    slug_value = (slug or "").strip()
    album_rows: List[Dict[str, Any]] = []

    if album_id:
        album_key = urllib.parse.quote(str(album_id).strip(), safe="")
        if not album_key:
            raise ValueError("Missing album id")
        album_rows = _supabase_request(
            "GET",
            f"/rest/v1/albums?id=eq.{album_key}&select=id,access_token,slug",
        ) or []
    elif token:
        encoded_token = urllib.parse.quote(token, safe="")
        album_rows = _supabase_request(
            "GET",
            f"/rest/v1/albums?access_token=eq.{encoded_token}&select=id,access_token,slug",
        ) or []
        if slug_value:
            album_rows = [
                row for row in album_rows if (row.get("slug") or "") == slug_value
            ]
    elif slug_value:
        encoded_slug = urllib.parse.quote(slug_value, safe="")
        album_rows = _supabase_request(
            "GET",
            f"/rest/v1/albums?slug=eq.{encoded_slug}&select=id,access_token,slug",
        ) or []
    else:
        raise ValueError("Missing album id, access token, or slug")

    if not album_rows:
        if token:
            _cleanup_storage_prefix(token)
        return False

    row = album_rows[0]
    album_key = urllib.parse.quote(str(row["id"]).strip(), safe="")
    row_token = row.get("access_token") or token
    if not row_token:
        raise ValueError("Share missing access token")

    _delete_album_catalog_and_storage(album_key, row_token)
    return True


def delete_share_album(album_id: str) -> None:
    if not cleanup_share_album(album_id=album_id):
        raise ValueError("Share not found")


def _lookup_share_album_rows(
    *,
    album_id: Optional[str] = None,
    access_token: Optional[str] = None,
    slug: Optional[str] = None,
) -> List[Dict[str, Any]]:
    token = (access_token or "").strip()
    slug_value = (slug or "").strip()

    if album_id:
        album_key = urllib.parse.quote(str(album_id).strip(), safe="")
        if not album_key:
            raise ValueError("Missing album id")
        return _supabase_request(
            "GET",
            f"/rest/v1/albums?id=eq.{album_key}&select=id,access_token,slug,title,photo_count",
        ) or []

    if token:
        encoded_token = urllib.parse.quote(token, safe="")
        album_rows = _supabase_request(
            "GET",
            f"/rest/v1/albums?access_token=eq.{encoded_token}&select=id,access_token,slug,title,photo_count",
        ) or []
        if slug_value:
            return [
                row for row in album_rows if (row.get("slug") or "") == slug_value
            ]
        return album_rows

    if slug_value:
        encoded_slug = urllib.parse.quote(slug_value, safe="")
        return _supabase_request(
            "GET",
            f"/rest/v1/albums?slug=eq.{encoded_slug}&select=id,access_token,slug,title,photo_count",
        ) or []

    raise ValueError("Missing album id, access token, or slug")


def get_share_publish_outcome(
    *,
    access_token: Optional[str] = None,
    slug: Optional[str] = None,
    album_id: Optional[str] = None,
) -> Dict[str, Any]:
    """
    Resolve whether a publish attempt left no album, a partial album, or a complete share.
    """
    try:
        album_rows = _lookup_share_album_rows(
            album_id=album_id,
            access_token=access_token,
            slug=slug,
        )
    except ValueError:
        return {"status": "none"}

    if not album_rows:
        return {"status": "none"}

    row = album_rows[0]
    album_key = urllib.parse.quote(str(row["id"]).strip(), safe="")
    token = row.get("access_token") or (access_token or "").strip()
    expected_count = int(row.get("photo_count") or 0)
    photo_rows = _supabase_request(
        "GET",
        f"/rest/v1/album_photos?album_id=eq.{album_key}&select=id",
    ) or []
    uploaded_count = len(photo_rows)

    if expected_count > 0 and uploaded_count >= expected_count:
        status = "complete"
    else:
        status = "partial"

    return {
        "status": status,
        "album_id": row["id"],
        "url": build_share_url(token) if token else "",
        "title": row.get("title"),
        "photo_count": expected_count,
        "uploaded_count": uploaded_count,
    }


def upload_storage_object(storage_path: str, data: bytes, content_type: str) -> None:
    max_bytes = get_share_storage_max_bytes()
    if len(data) > max_bytes:
        raise SharePublishError(
            "share_file_too_large",
            (
                f"Upload exceeds share size limit "
                f"({bytes_to_display_mb(len(data))} MB; "
                f"limit {bytes_to_display_mb(max_bytes)} MB)"
            ),
            step="upload",
            detail=storage_path,
        )
    encoded_path = "/".join(urllib.parse.quote(part, safe="") for part in storage_path.split("/"))
    last_error: Optional[RuntimeError] = None
    for attempt in range(SHARE_STORAGE_UPLOAD_RETRIES):
        try:
            _supabase_request(
                "POST",
                f"/storage/v1/object/{SHARE_BUCKET}/{encoded_path}",
                body=data,
                content_type=content_type,
                extra_headers={"x-upsert": "true"},
                timeout=SHARE_STORAGE_TIMEOUT_SEC,
            )
            return
        except RuntimeError as exc:
            last_error = exc
            if attempt + 1 >= SHARE_STORAGE_UPLOAD_RETRIES:
                raise
            delay = 0.25 * (attempt + 1)
            _share_log(
                f"storage upload retry {attempt + 1}/{SHARE_STORAGE_UPLOAD_RETRIES} "
                f"path={storage_path} after {delay:.2f}s"
            )
            time.sleep(delay)
    if last_error is not None:
        raise last_error


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
        raise SharePublishError(
            "share_limit",
            f"Share limit is {SHARE_MAX_PHOTOS} photos",
        )

    total = len(photo_rows)
    validate_photos_for_share(library_path, photo_rows)
    _share_log(f"publish start slug={slug} photos={total} token={access_token[:8]}…")

    album_id: Optional[str] = None
    current_index: Optional[int] = None
    current_photo_id: Optional[int] = None
    current_step = "init"

    try:
        album = _find_or_create_share_album(slug, access_token, title, total)
        album_id = album["id"]
        completed_positions = _get_completed_share_positions(album_id)
        if completed_positions:
            _share_log(
                f"resume skip positions={sorted(completed_positions)} "
                f"of {total}"
            )

        if total > 0 and len(completed_positions) >= total:
            _share_log(f"publish already complete album_id={album_id}")
            yield (
                "complete",
                {
                    "slug": slug,
                    "access_token": access_token,
                    "url": build_share_url(access_token),
                    "title": title,
                    "photo_count": total,
                    "album_id": album_id,
                },
            )
            return

        for index, row in enumerate(photo_rows):
            current_index = index
            current_photo_id = row["id"]
            photo_id = row["id"]
            if index in completed_positions:
                _share_log(f"{index + 1}/{total} photo_id={photo_id} skip=uploaded")
                yield (
                    "progress",
                    {
                        "completed": index + 1,
                        "total": total,
                        "photo_id": photo_id,
                        "resumed": True,
                    },
                )
                continue

            relative_path = row["current_path"]
            full_path = os.path.join(library_path, relative_path)
            file_type = _row_file_type(row)
            delivery = plan_share_delivery(
                relative_path,
                file_type,
                full_path=full_path,
            )
            storage_base = f"{access_token}/{index:04d}_{photo_id}"
            original_path = f"{storage_base}/{delivery.storage_name}"
            thumb_path = f"{storage_base}/thumb.jpg"
            display_path = None

            if delivery.action == "still_jpeg":
                current_step = "convert_jpeg"
                _share_log(
                    f"{index + 1}/{total} photo_id={photo_id} step={current_step} "
                    f"path={relative_path} deliver={delivery.delivered_filename}"
                )
                jpeg_buffer = still_image_to_jpeg_buffer(
                    full_path,
                    quality=95,
                    to_rgb=to_rgb,
                )
                current_step = "upload_original"
                upload_storage_object(
                    original_path,
                    jpeg_buffer.getvalue(),
                    delivery.content_type,
                )
            elif delivery.action == "video_transcode":
                current_step = "video_transcode"
                _share_log(
                    f"{index + 1}/{total} photo_id={photo_id} step={current_step} "
                    f"path={relative_path} deliver={delivery.delivered_filename}"
                )
                yield (
                    "heartbeat",
                    {
                        "photo_index": index,
                        "photo_id": photo_id,
                        "step": current_step,
                        "completed": index,
                        "total": total,
                        "message": f"Preparing video {index + 1} of {total}…",
                    },
                )
                mp4_buffer = video_to_browser_mp4_buffer(full_path)
                current_step = "upload_original"
                upload_storage_object(
                    original_path,
                    mp4_buffer.getvalue(),
                    delivery.content_type,
                )
            else:
                current_step = "read_original"
                _share_log(
                    f"{index + 1}/{total} photo_id={photo_id} step={current_step} "
                    f"path={relative_path} deliver={delivery.delivered_filename}"
                )
                with open(full_path, "rb") as handle:
                    original_bytes = handle.read()
                current_step = "upload_original"
                upload_storage_object(
                    original_path,
                    original_bytes,
                    delivery.content_type,
                )

            current_step = "thumb"
            _share_log(f"{index + 1}/{total} photo_id={photo_id} step={current_step}")
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
                current_step = "upload_thumb"
                upload_storage_object(thumb_path, thumb_bytes, "image/jpeg")
            finally:
                if os.path.exists(temp_thumb_path):
                    os.remove(temp_thumb_path)

            parsed_date = parse_photo_date(row["date_taken"])
            catalog_row = {
                "album_id": album_id,
                "position": index,
                "date_taken": parsed_date.isoformat() if parsed_date else None,
                "file_type": file_type,
                "width": row["width"],
                "height": row["height"],
                "rating": row["rating"] if row["rating"] == 5 else None,
                "thumb_path": thumb_path,
                "original_path": original_path,
                "display_path": display_path,
                "original_filename": delivery.delivered_filename,
            }
            current_step = "catalog_insert"
            insert_album_photos([catalog_row])
            _share_log(f"{index + 1}/{total} photo_id={photo_id} step=done")

            yield (
                "progress",
                {
                    "completed": index + 1,
                    "total": total,
                    "photo_id": photo_id,
                },
            )

        share_url = build_share_url(access_token)
        _share_log(f"publish complete album_id={album_id} photos={total}")
        yield (
            "complete",
            {
                "slug": slug,
                "access_token": access_token,
                "url": share_url,
                "title": title,
                "photo_count": total,
                "album_id": album_id,
            },
        )
    except Exception as exc:
        failure = _classify_share_failure(
            exc,
            photo_index=current_index,
            photo_id=current_photo_id,
            step=current_step,
        )
        _log_share_failure(failure)
        raise failure from exc


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
