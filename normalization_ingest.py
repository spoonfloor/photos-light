"""
Engine-facing ingest mode for Add photos.

This is the first runtime-convergence layer: Add photos calls an engine-style
ingest API while app.py remains responsible for HTTP/SSE and import-specific UX.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Callable, Dict, Iterable, Iterator, Optional, Tuple

from normalization_core import (
    NormalizationCoreDependencies,
    NormalizationFileResult,
    normalize_ingest_file,
)


@dataclass
class IngestDependencies(NormalizationCoreDependencies):
    """Ingest-facing alias for the shared per-file dependency bundle."""


@dataclass
class IngestCounters:
    imported: int = 0
    duplicates: int = 0
    errors: int = 0

    def progress_payload(self, *, current: int, total: int, **extra: Any) -> Dict[str, Any]:
        payload: Dict[str, Any] = {
            "imported": self.imported,
            "duplicates": self.duplicates,
            "errors": self.errors,
            "current": current,
            "total": total,
        }
        payload.update(extra)
        return payload


IngestFileResult = NormalizationFileResult


def iter_ingest_events(
    conn,
    file_paths: Iterable[str],
    deps: IngestDependencies,
    *,
    stop_check: Optional[Callable[[], bool]] = None,
    log_entry: Optional[Callable[[str, Dict[str, Any]], None]] = None,
) -> Iterator[Tuple[str, Dict[str, Any]]]:
    paths = list(file_paths)
    total = len(paths)
    counters = IngestCounters()

    def _build_log_entry(event_type: str, data: Dict[str, Any]) -> Dict[str, Any]:
        return {
            "timestamp": datetime.now().isoformat(),
            "event": event_type,
            **data,
        }

    def _log(event_type: str, data: Dict[str, Any]) -> Dict[str, Any]:
        entry = _build_log_entry(event_type, data)
        if log_entry is not None:
            log_entry(event_type, data)
        return entry

    start_entry = _log("start", {"total": total})
    yield "log", {"entry": start_entry}

    for file_index, source_path in enumerate(paths, 1):
        if stop_check and stop_check():
            return

        filename = os.path.basename(source_path)
        if not os.path.exists(source_path):
            counters.errors += 1
            missing_entry = _log("missing_file", {"file": source_path})
            yield "log", {"entry": missing_entry}
            yield "progress", counters.progress_payload(current=file_index, total=total)
            continue

        try:
            result = normalize_ingest_file(conn, source_path, filename=filename, deps=deps)

            if result.status == "imported":
                counters.imported += 1
                payload = counters.progress_payload(current=file_index, total=total)
                if result.photo_id:
                    payload["photo_id"] = result.photo_id
                imported_entry = _log(
                    "imported",
                    {"file": source_path, "photo_id": result.photo_id},
                )
                yield "log", {"entry": imported_entry}
                yield "progress", payload
            elif result.status == "duplicate":
                counters.duplicates += 1
                duplicate_entry = _log("duplicate", {"file": source_path})
                yield "log", {"entry": duplicate_entry}
                yield "progress", counters.progress_payload(current=file_index, total=total)
            elif result.status == "rejected":
                rejection = dict(result.rejection or {})
                category = rejection.get("category")
                if category == "duplicate":
                    counters.duplicates += 1
                else:
                    counters.errors += 1
                rejected_entry = _log(
                    "rejected",
                    {
                        "file": rejection.get("file") or source_path,
                        "reason": rejection.get("reason"),
                        "category": category,
                    },
                )
                yield "log", {"entry": rejected_entry}
                rejection.update(counters.progress_payload(current=file_index, total=total))
                yield "rejected", rejection
            else:
                counters.errors += 1
                error_entry = _log(
                    "error",
                    {
                        "file": result.error_file or source_path,
                        "message": result.error,
                    },
                )
                yield "log", {"entry": error_entry}
                yield "progress", counters.progress_payload(
                    current=file_index,
                    total=total,
                    error=result.error,
                    error_file=result.error_file or filename,
                )
        except Exception as error:
            counters.errors += 1
            error_entry = _log("error", {"file": source_path, "message": str(error)})
            yield "log", {"entry": error_entry}
            yield "progress", counters.progress_payload(
                current=file_index,
                total=total,
                error=str(error),
                error_file=filename,
            )

    complete_payload = {
        "imported": counters.imported,
        "duplicates": counters.duplicates,
        "errors": counters.errors,
        "total": total,
    }
    complete_entry = _log("complete", complete_payload)
    yield "log", {"entry": complete_entry}
    yield "complete", complete_payload
