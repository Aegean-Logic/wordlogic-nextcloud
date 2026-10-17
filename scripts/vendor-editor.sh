#!/usr/bin/env bash
# Put the WordLogic web build in editor/: the page this app shows in its iframe.
#
# Usage (from anywhere):
#   scripts/vendor-editor.sh            build $WORDCRAFT/apps/wordcraft-web (trunk), then copy it
#   scripts/vendor-editor.sh <dir>      copy a built site (wordcraft/dist/web, or an unzipped release)
#   scripts/vendor-editor.sh <zip>      unpack wordcraft-web-<version>.zip (wordcraft/packaging/web/package.sh)
#
# WORDCRAFT defaults to ../wordcraft next to this repository. editor/README.md is kept.
set -euo pipefail

APP="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="$APP/editor"
WORDCRAFT="${WORDCRAFT:-$APP/../wordcraft}"
SRC="${1:-}"
TMP=""
trap '[ -n "$TMP" ] && rm -rf "$TMP"' EXIT

if [ -z "$SRC" ]; then
  command -v trunk >/dev/null || { echo "error: trunk not found (cargo install trunk --locked)" >&2; exit 1; }
  # Trunk.toml: dist = ../../dist/web, public_url = ./ (relative URLs, so any app path works).
  (cd "$WORDCRAFT/apps/wordcraft-web" && trunk build --release)
  SRC="$WORDCRAFT/dist/web"
elif [ -f "$SRC" ]; then
  TMP="$(mktemp -d)"
  unzip -q "$SRC" -d "$TMP"
  INDEX="$(find "$TMP" -name index.html -print -quit)"
  [ -n "$INDEX" ] || { echo "error: no index.html in $1" >&2; exit 1; }
  SRC="$(dirname "$INDEX")"
fi

[ -f "$SRC/index.html" ] || { echo "error: $SRC/index.html missing" >&2; exit 1; }
if grep -Eq '(src|href)="/[^/]' "$SRC/index.html"; then
  echo "error: $SRC/index.html has root-absolute URLs; build with public_url = \"./\"" >&2
  exit 1
fi
if ! grep -qa 'wordcraft:ready' "$SRC"/*.wasm "$SRC"/*.js 2>/dev/null; then
  echo "warning: this build has no host bridge (no 'wordcraft:ready'): it won't open files from Nextcloud" >&2
fi

mkdir -p "$DEST"
find "$DEST" -mindepth 1 -maxdepth 1 ! -name README.md -exec rm -rf {} +
cp -R "$SRC/." "$DEST/"
# Static-host samples from the release zip; Nextcloud serves the files itself.
rm -f "$DEST/_headers" "$DEST/.htaccess" "$DEST/HOSTING.md"
echo "editor/ now holds the WordLogic web build from $SRC:"
ls -l "$DEST"
