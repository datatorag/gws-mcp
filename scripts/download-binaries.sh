#!/bin/bash
set -euo pipefail

VERSION="0.22.5"
BASE_URL="https://github.com/googleworkspace/cli/releases/download/v${VERSION}"
BIN_DIR="$(cd "$(dirname "$0")/.." && pwd)/bin"

mkdir -p "$BIN_DIR"

TARGETS=(
  "gws-aarch64-apple-darwin"
  "gws-x86_64-apple-darwin"
  "gws-x86_64-unknown-linux-gnu"
  "gws-x86_64-pc-windows-msvc"
)

# Since 0.22.4 (cargo-dist dropped) release assets are named
# google-workspace-cli-<target> and the tarballs contain a bare `gws`, so
# each one is extracted into its own gws-<target>/ directory to keep the
# layout gws-client.ts resolves. The Windows zip still ships gws.exe at the
# archive root and lands at bin/gws.exe as before.
for TARGET in "${TARGETS[@]}"; do
  ASSET="google-workspace-cli-${TARGET#gws-}"
  if [[ "$TARGET" == *"windows"* ]]; then
    ARCHIVE="${ASSET}.zip"
  else
    ARCHIVE="${ASSET}.tar.gz"
  fi

  echo "Downloading ${ARCHIVE}..."
  curl -fL -o "$BIN_DIR/${ARCHIVE}" "${BASE_URL}/${ARCHIVE}"

  echo "Extracting ${ARCHIVE}..."
  if [[ "$ARCHIVE" == *.zip ]]; then
    unzip -o "$BIN_DIR/${ARCHIVE}" -d "$BIN_DIR"
  else
    mkdir -p "$BIN_DIR/${TARGET}"
    tar -xzf "$BIN_DIR/${ARCHIVE}" -C "$BIN_DIR/${TARGET}"
  fi

  rm "$BIN_DIR/${ARCHIVE}"
done

# Set executable permissions on macOS/Linux binaries
chmod +x "$BIN_DIR/gws-aarch64-apple-darwin/gws" "$BIN_DIR/gws-x86_64-apple-darwin/gws" "$BIN_DIR/gws-x86_64-unknown-linux-gnu/gws" 2>/dev/null || true

echo "Done. Binaries in ${BIN_DIR}:"
ls -la "$BIN_DIR"
