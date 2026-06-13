#!/usr/bin/env python3
"""Fail when Flask API routes have no references in static, electron, tests, or tools."""

from __future__ import annotations

import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
APP_PY = REPO_ROOT / "app.py"

SCAN_ROOTS = (
    REPO_ROOT / "static",
    REPO_ROOT / "electron",
    REPO_ROOT / "tools",
)
SCAN_TEST_GLOB = "test_*.py"

ROUTE_PATTERN = re.compile(
    r"@app\.route\(\s*['\"](?P<path>[^'\"]+)['\"]",
)
CLIENT_PATTERN = re.compile(r"['\"`](/api/[^'\"`?]+)")


def normalize_route(path: str) -> str:
    path = path.split("?", 1)[0]
    if not path.startswith("/"):
        path = f"/{path}"
    path = re.sub(r"\$\{[^}]+\}", "<param>", path)
    return re.sub(r"<[^>]+>", "<param>", path)


# Routes intentionally kept without a current static caller.
ROUTE_ALLOWLIST = {
    normalize_route(path)
    for path in (
        "/",
        "/<path:path>",
        "/api/check-path",
        "/api/file-counts",
        "/api/library/validate",
        "/api/photo/<int:photo_id>/dimensions",
        "/api/photo/update_date",
        "/api/photos/bulk-favorite",
        "/api/photos/bulk_update_date",
        "/api/photos/favorites",
        "/api/photos/nearest_month",
    )
}


def collect_flask_routes() -> set[str]:
    source = APP_PY.read_text(encoding="utf-8")
    routes = {normalize_route(match.group("path")) for match in ROUTE_PATTERN.finditer(source)}
    return {route for route in routes if route.startswith("/api/")}


def collect_client_references() -> set[str]:
    references: set[str] = set()
    for root in SCAN_ROOTS:
        if not root.exists():
            continue
        for path in root.rglob("*"):
            if not path.is_file() or path.suffix not in {".js", ".py", ".html", ".ts"}:
                continue
            if path.name == Path(__file__).name:
                continue
            text = path.read_text(encoding="utf-8", errors="ignore")
            for match in CLIENT_PATTERN.finditer(text):
                references.add(normalize_route(match.group(1)))

    for path in REPO_ROOT.glob(SCAN_TEST_GLOB):
        text = path.read_text(encoding="utf-8", errors="ignore")
        for match in CLIENT_PATTERN.finditer(text):
            references.add(normalize_route(match.group(1)))

    return references


def route_is_referenced(route: str, references: set[str]) -> bool:
    if route in references:
        return True
    prefix = route.rstrip("/")
    return any(ref.startswith(prefix) for ref in references)


def main() -> int:
    routes = collect_flask_routes()
    references = collect_client_references()
    orphans = sorted(
        route
        for route in routes
        if route not in ROUTE_ALLOWLIST and not route_is_referenced(route, references)
    )

    if orphans:
        print("Unexpected orphan API routes (no static/electron/test/tools reference):")
        for route in orphans:
            print(f"  - {route}")
        print(
            "\nAdd a caller, remove the route, or extend ROUTE_ALLOWLIST in "
            "tools/check_orphan_routes.py with justification.",
        )
        return 1

    print(f"Orphan route check OK ({len(routes)} API routes scanned).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
