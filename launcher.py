#!/usr/bin/env python3
"""Production entry point for Photos Light (.app / DMG distribution)."""

from __future__ import annotations

import os
import socket
import sys
import threading
import time
import webbrowser

from runtime_paths import augment_path_for_cli_tools, ensure_app_support_dir, is_frozen

HOST = "127.0.0.1"
PORT = 5001
APP_URL = f"http://{HOST}:{PORT}"


def _port_is_free(host: str, port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            sock.bind((host, port))
        except OSError:
            return False
    return True


def _open_browser_when_ready(url: str, timeout_seconds: float = 30.0) -> None:
    deadline = time.time() + timeout_seconds
    while time.time() < deadline:
        try:
            with socket.create_connection((HOST, PORT), timeout=0.25):
                webbrowser.open(url)
                return
        except OSError:
            time.sleep(0.2)


def main() -> int:
    augment_path_for_cli_tools()
    ensure_app_support_dir()

    if not _port_is_free(HOST, PORT):
        message = f"Photos Light could not start: port {PORT} is already in use."
        print(message)
        print("Quit the other Photos Light instance and try again.")
        return 1

    from app import app, restore_library_session_from_config
    from waitress import serve

    print("\n🖼️  Photos Light Starting...")
    if is_frozen():
        print("📦 Running from application bundle")
    else:
        print("🚀 Running via launcher.py")
    if not restore_library_session_from_config():
        print("📚 No library loaded — choose one from the welcome screen.")

    print(f"🌐 Open: {APP_URL}\n")
    if os.environ.get("PHOTOS_LIGHT_ELECTRON") != "1":
        threading.Thread(target=_open_browser_when_ready, args=(APP_URL,), daemon=True).start()
    serve(app, host=HOST, port=PORT, threads=8)
    return 0


if __name__ == "__main__":
    sys.exit(main())
