#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

ELECTRON_ONLY=0
for arg in "$@"; do
  case "$arg" in
    --electron-only)
      ELECTRON_ONLY=1
      ;;
    -h|--help)
      cat <<'EOF'
Usage: ./packaging/build.sh [--electron-only]

Builds dist/mac-arm64/Photos Light.app for packaged/prod testing.

  (default)        Rebuild PyInstaller backend + Electron shell
  --electron-only  Rebuild Electron shell only (requires existing backend bundle)
EOF
      exit 0
      ;;
    *)
      echo "Unknown option: $arg (try --help)" >&2
      exit 1
      ;;
  esac
done

BACKEND_DIR="dist/photos-light-server"
APP_GLOB="dist/mac-arm64/Photos Light.app"

require_backend() {
  if [[ ! -x "$BACKEND_DIR/photos-light-server" ]]; then
    echo "Backend bundle missing: $BACKEND_DIR/photos-light-server" >&2
    echo "Run ./packaging/build.sh without --electron-only first." >&2
    exit 1
  fi
}

find_app_path() {
  local app_path="$APP_GLOB"
  if [[ ! -d "$app_path" ]]; then
    app_path="$(find dist -maxdepth 2 -name 'Photos Light.app' -type d | head -1 || true)"
  fi
  if [[ -z "${app_path:-}" || ! -d "$app_path" ]]; then
    echo "Electron build failed: Photos Light.app not found under dist/" >&2
    exit 1
  fi
  printf '%s\n' "$app_path"
}

maybe_install_packaging_deps() {
  echo "==> Installing Python packaging dependencies"
  python3 -m pip install -q -r packaging/requirements-packaging.txt
}

maybe_generate_icon() {
  local source_icon="packaging/AppIcon.source.png"
  local built_icon="packaging/AppIcon.icns"
  if [[ ! -f "$built_icon" || "$source_icon" -nt "$built_icon" ]]; then
    echo "==> Generating app icon"
    python3 packaging/generate_icon.py
  else
    echo "==> App icon up to date"
  fi
}

build_backend() {
  echo "==> Building Python backend (photos-light-server)"
  rm -rf "$BACKEND_DIR" "$APP_GLOB" dist/mac-arm64 dist/*.dmg dist/dmg-staging 2>/dev/null || true
  pyinstaller --noconfirm "packaging/Backend.spec"

  if [[ ! -x "$BACKEND_DIR/photos-light-server" ]]; then
    echo "Backend build failed: $BACKEND_DIR/photos-light-server not found" >&2
    exit 1
  fi
}

maybe_install_electron_deps() {
  echo "==> Installing Electron dependencies"
  cd electron
  if [[ ! -d node_modules || package-lock.json -nt node_modules ]]; then
    npm install --no-fund --no-audit
  else
    echo "    node_modules up to date"
  fi
}

build_electron_app() {
  echo "==> Building Photos Light.app (Electron)"
  rm -rf "../$APP_GLOB" ../dist/mac-arm64 2>/dev/null || true
  npm run build
  cd "$ROOT"
}

if [[ "$ELECTRON_ONLY" -eq 1 ]]; then
  require_backend
  maybe_install_electron_deps
  build_electron_app
else
  maybe_install_packaging_deps
  maybe_generate_icon
  build_backend
  maybe_install_electron_deps
  build_electron_app
fi

APP_PATH="$(find_app_path)"

echo ""
echo "Done."
echo "  App: $APP_PATH ($(du -sh "$APP_PATH" | awk '{print $1}'))"
if [[ "$ELECTRON_ONLY" -eq 1 ]]; then
  echo "  Mode: electron-only (reused $BACKEND_DIR)"
else
  echo "  Mode: full (backend + electron)"
fi
echo ""
echo "Dev: cd electron && npm start"
