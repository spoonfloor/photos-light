"""Per-client library session state for the Photos Light backend."""

from __future__ import annotations

import os
import sqlite3
import threading
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, Optional

from trash_catalog import ensure_user_deleted_trash_dir, invalidate_trash_grid_caches

SESSION_COOKIE_NAME = "pl_session"
SESSION_HEADER_NAME = "X-Photos-Light-Session"
TEST_SESSION_ID = "test-default"
DEFAULT_IDLE_TTL_SECONDS = 24 * 60 * 60


@dataclass
class LibraryContext:
    """All mutable per-session library state."""

    session_id: str
    library_path: Optional[str] = None
    db_path: Optional[str] = None
    thumbnail_cache_dir: Optional[str] = None
    trash_dir: Optional[str] = None
    db_backup_dir: Optional[str] = None
    import_temp_dir: Optional[str] = None
    log_dir: Optional[str] = None
    catalog_revision: int = 0
    photo_total_count_cache: Optional[int] = None
    photo_total_count_cache_revision: Optional[int] = None
    month_index_cache: Dict[Any, Any] = field(default_factory=dict)
    month_index_cache_revision: Optional[int] = None
    last_access_monotonic: float = field(default_factory=time.monotonic)

    def touch(self) -> None:
        self.last_access_monotonic = time.monotonic()

    def is_configured(self) -> bool:
        return bool(self.library_path and self.db_path)

    def get_catalog_revision(self) -> int:
        return self.catalog_revision

    def attach_catalog_revision(self, payload: Any) -> Any:
        if isinstance(payload, dict):
            payload = dict(payload)
            payload["catalog_revision"] = self.catalog_revision
        return payload

    def bump_catalog_revision(self) -> None:
        self.catalog_revision += 1
        self.invalidate_grid_read_caches()

    def invalidate_photo_total_count_cache(self) -> None:
        self.photo_total_count_cache = None
        self.photo_total_count_cache_revision = None

    def invalidate_month_index_cache(self) -> None:
        self.month_index_cache = {}

    def invalidate_grid_read_caches(self) -> None:
        self.invalidate_photo_total_count_cache()
        self.invalidate_month_index_cache()
        invalidate_trash_grid_caches()

    def commit_row_mutation(self, conn, *, invalidate_histogram: bool = True) -> None:
        conn.commit()
        if invalidate_histogram:
            self.invalidate_grid_read_caches()

    def notify_catalog_reset_from_make_perfect(self, result: Optional[dict]) -> None:
        if result and result.get("status") == "SUCCESS":
            self.bump_catalog_revision()

    def clear(self) -> None:
        self.library_path = None
        self.db_path = None
        self.thumbnail_cache_dir = None
        self.trash_dir = None
        self.db_backup_dir = None
        self.import_temp_dir = None
        self.log_dir = None
        self.invalidate_grid_read_caches()

    def get_db_connection(self) -> sqlite3.Connection:
        if not self.db_path:
            raise RuntimeError("No database configured for this session")
        conn = sqlite3.connect(self.db_path, timeout=60)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA busy_timeout=60000")
        conn.execute("PRAGMA foreign_keys=ON")
        return conn

    def update_paths(
        self,
        library_path: str,
        db_path: str,
        *,
        ensure_photo_grid_indices: Callable[[Optional[str]], None],
        schedule_open_reconcile: Optional[
            Callable[[str, str, int, Callable[[], None]], bool]
        ] = None,
    ) -> None:
        self.bump_catalog_revision()
        self.library_path = library_path
        self.db_path = db_path
        ensure_photo_grid_indices(db_path)
        self.thumbnail_cache_dir = os.path.join(library_path, ".thumbnails")
        self.trash_dir = os.path.join(library_path, ".trash")
        self.db_backup_dir = os.path.join(library_path, ".db_backups")
        self.import_temp_dir = os.path.join(library_path, ".import_temp")
        self.log_dir = os.path.join(library_path, ".logs")

        for directory in (
            self.thumbnail_cache_dir,
            self.trash_dir,
            self.db_backup_dir,
            self.log_dir,
        ):
            try:
                os.makedirs(directory, exist_ok=True)
            except (PermissionError, OSError) as exc:
                print(f"⚠️  Warning: Could not create directory {directory}: {exc}")
                print("   This may indicate the library is not accessible.")
        if self.trash_dir:
            ensure_user_deleted_trash_dir(self.trash_dir)

        if schedule_open_reconcile:
            try:
                scheduled = schedule_open_reconcile(
                    library_path,
                    db_path,
                    self.catalog_revision,
                    self.invalidate_grid_read_caches,
                )
                if scheduled:
                    print("  🔄 Open reconcile scheduled (background)")
            except Exception as exc:
                print(f"  ⚠️  Open reconcile schedule skipped: {exc}")

    def snapshot_for_thread(self) -> "LibraryContextSnapshot":
        """Immutable view of path state for background workers."""
        return LibraryContextSnapshot(
            session_id=self.session_id,
            library_path=self.library_path,
            db_path=self.db_path,
            thumbnail_cache_dir=self.thumbnail_cache_dir,
            trash_dir=self.trash_dir,
            db_backup_dir=self.db_backup_dir,
            import_temp_dir=self.import_temp_dir,
            log_dir=self.log_dir,
            catalog_revision=self.catalog_revision,
        )


@dataclass(frozen=True)
class LibraryContextSnapshot:
    """Path snapshot safe to use from background threads."""

    session_id: str
    library_path: Optional[str]
    db_path: Optional[str]
    thumbnail_cache_dir: Optional[str]
    trash_dir: Optional[str]
    db_backup_dir: Optional[str]
    import_temp_dir: Optional[str]
    log_dir: Optional[str]
    catalog_revision: int

    def get_db_connection(self) -> sqlite3.Connection:
        if not self.db_path:
            raise RuntimeError("No database configured for this session snapshot")
        conn = sqlite3.connect(self.db_path, timeout=60)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA busy_timeout=60000")
        conn.execute("PRAGMA foreign_keys=ON")
        return conn


class SessionRegistry:
    """Thread-safe in-memory session store."""

    def __init__(self, idle_ttl_seconds: float = DEFAULT_IDLE_TTL_SECONDS) -> None:
        self._lock = threading.RLock()
        self._sessions: Dict[str, LibraryContext] = {}
        self._idle_ttl_seconds = idle_ttl_seconds

    def get_or_create(self, session_id: str) -> LibraryContext:
        with self._lock:
            self._evict_idle_locked()
            ctx = self._sessions.get(session_id)
            if ctx is None:
                ctx = LibraryContext(session_id=session_id)
                self._sessions[session_id] = ctx
            ctx.touch()
            return ctx

    def clear_session(self, session_id: str) -> None:
        with self._lock:
            ctx = self._sessions.get(session_id)
            if ctx is not None:
                ctx.clear()

    def remove_session(self, session_id: str) -> None:
        with self._lock:
            self._sessions.pop(session_id, None)

    def _evict_idle_locked(self) -> None:
        if self._idle_ttl_seconds <= 0:
            return
        now = time.monotonic()
        stale = [
            sid
            for sid, ctx in self._sessions.items()
            if sid != TEST_SESSION_ID and (now - ctx.last_access_monotonic) > self._idle_ttl_seconds
        ]
        for sid in stale:
            self._sessions.pop(sid, None)


session_registry = SessionRegistry()


def new_session_id() -> str:
    return str(uuid.uuid4())
