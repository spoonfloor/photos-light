#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "==> Installing Python packaging dependencies"
python3 -m pip install -q -r packaging/requirements-packaging.txt

echo "==> Generating app icon"
python3 packaging/generate_icon.py

echo "==> Building Python backend (photos-light-server)"
rm -rf build dist
pyinstaller --noconfirm "packaging/Backend.spec"

BACKEND_DIR="dist/photos-light-server"
if [[ ! -x "$BACKEND_DIR/photos-light-server" ]]; then
  echo "Backend build failed: $BACKEND_DIR/photos-light-server not found" >&2
  exit 1
fi

echo "==> Installing Electron dependencies"
cd electron
npm install --no-fund --no-audit

echo "==> Building Photos Light.app + DMG (Electron)"
npm run build
cd "$ROOT"

APP_PATH="dist/mac-arm64/Photos Light.app"
DMG_PATH="dist/Photos Light-1.0.0-arm64.dmg"
STAGING_DIR="dist/dmg-staging"

# electron-builder output names vary slightly by version/arch
if [[ ! -d "$APP_PATH" ]]; then
  APP_PATH="$(find dist -maxdepth 2 -name 'Photos Light.app' -type d | head -1 || true)"
fi
if [[ ! -f "$DMG_PATH" ]]; then
  DMG_PATH="$(find dist -maxdepth 1 -name 'Photos Light*.dmg' -type f | head -1 || true)"
fi

if [[ -z "${APP_PATH:-}" || ! -d "$APP_PATH" ]]; then
  echo "Electron build failed: Photos Light.app not found under dist/" >&2
  exit 1
fi

echo "==> Creating installer DMG with Applications link"
FINAL_DMG="dist/Photos Light.dmg"
rm -rf "$STAGING_DIR" "$FINAL_DMG"
mkdir -p "$STAGING_DIR"
cp -R "$APP_PATH" "$STAGING_DIR/"
ln -s /Applications "$STAGING_DIR/Applications"
cat > "$STAGING_DIR/README.txt" <<'EOF'
Photos Light

1. Drag Photos Light to Applications
2. Open Applications, control-click Photos Light, choose Open (first time only)
3. Photos Light opens in its own window

Requires Homebrew CLI tools:
  brew install exiftool ffmpeg jpeg-turbo
EOF

hdiutil create \
  -volname "Photos Light" \
  -ov \
  -format UDZO \
  "$FINAL_DMG" \
  -srcfolder "$STAGING_DIR" >/dev/null

rm -rf "$STAGING_DIR"

echo ""
echo "Done."
echo "  App: $APP_PATH ($(du -sh "$APP_PATH" | awk '{print $1}'))"
echo "  DMG: $FINAL_DMG ($(du -sh "$FINAL_DMG" | awk '{print $1}'))"
echo ""
echo "Dev: cd electron && npm start"
