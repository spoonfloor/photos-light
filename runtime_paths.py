"""Resolve app, static, and config paths for dev and py2app bundles."""

from __future__ import annotations

import os
import sys

APP_SUPPORT_NAME = "Photos Light"
CONFIG_FILENAME = "config.json"


def is_frozen() -> bool:
    return getattr(sys, "frozen", False)


def get_base_dir() -> str:
    """Directory containing Python modules (repo root or bundle Resources)."""
    if is_frozen():
        meipass = getattr(sys, "_MEIPASS", None)
        if meipass:
            return meipass
        return os.path.abspath(
            os.path.join(os.path.dirname(sys.executable), "..", "Resources")
        )
    return os.path.dirname(os.path.abspath(__file__))


def get_static_dir() -> str:
    return os.path.join(get_base_dir(), "static")


def get_app_support_dir() -> str:
    return os.path.join(
        os.path.expanduser("~/Library/Application Support"),
        APP_SUPPORT_NAME,
    )


def get_config_file() -> str:
    if is_frozen():
        return os.path.join(get_app_support_dir(), CONFIG_FILENAME)
    return os.path.join(get_base_dir(), ".config.json")


def ensure_app_support_dir() -> str:
    path = get_app_support_dir()
    os.makedirs(path, exist_ok=True)
    return path


def augment_path_for_cli_tools() -> None:
    """Finder-launched apps often lack Homebrew on PATH."""
    extra = "/opt/homebrew/bin:/usr/local/bin"
    current = os.environ.get("PATH", "")
    if extra not in current:
        os.environ["PATH"] = f"{extra}:{current}" if current else extra
