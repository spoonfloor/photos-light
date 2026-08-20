#!/usr/bin/env bash
# Build share-viewer/ from static/ and push to GitHub Pages repo.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SHARE_OUT="$ROOT/share-viewer"
SHARING_REPO="${SHARE_VIEWER_PAGES_REPO:-spoonfloor/photos-light-sharing}"
DEPLOY_DIR="${SHARE_VIEWER_DEPLOY_DIR:-$(mktemp -d)}"
CLEANUP_DEPLOY_DIR=0

if [[ "${SHARE_VIEWER_DEPLOY_DIR:-}" == "" ]]; then
  CLEANUP_DEPLOY_DIR=1
fi

cleanup() {
  if [[ "$CLEANUP_DEPLOY_DIR" == 1 && -d "$DEPLOY_DIR" ]]; then
    rm -rf "$DEPLOY_DIR"
  fi
}
trap cleanup EXIT

echo "Building share viewer..."
bash "$ROOT/scripts/build-share-viewer.sh"

echo "Cloning $SHARING_REPO..."
git clone --depth 1 "https://github.com/${SHARING_REPO}.git" "$DEPLOY_DIR"

echo "Syncing share-viewer/ -> pages repo..."
rsync -a --delete \
  --exclude .git \
  "$SHARE_OUT/" \
  "$DEPLOY_DIR/"

cd "$DEPLOY_DIR"
if git diff --quiet && git diff --cached --quiet && [[ -z "$(git ls-files --others --exclude-standard)" ]]; then
  echo "No changes to deploy."
  exit 0
fi

git add -A
git commit -m "$(cat <<EOF
Deploy share viewer from photos-light.

EOF
)"
git push origin HEAD:main

echo "Deployed to https://github.com/${SHARING_REPO} (GitHub Pages will update shortly)."
