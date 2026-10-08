#!/usr/bin/env bash
set -euo pipefail
readonly FACTORY_DIR="${RTT_FACTORY_DIR:-${HOME:?}/rtt-map-factory}"
readonly EXPECTED_REPO="$FACTORY_DIR/worktrees/codex-scout"
readonly REPO="$(cd -- "$(dirname -- "$(readlink -f -- "$0")")/../.." && pwd -P)"
if [[ "$REPO" != "$EXPECTED_REPO" || "$(git -C "$REPO" branch --show-current)" != "codex/scout" ]]; then
  printf '%s\n' 'Refusing launcher installation outside the expected Scout worktree/branch.' >&2
  exit 2
fi
readonly BIN_DIR="${HOME:?}/.local/bin"
readonly APP_DIR="${HOME:?}/.local/share/applications"
mkdir -p "$BIN_DIR" "$APP_DIR"
ln -sfn "$REPO/scripts/scout/launch-scout.sh" "$BIN_DIR/rtt-scout"
install -m 644 "$REPO/desktop/rtt-scout.desktop" "$APP_DIR/rtt-scout.desktop"
if command -v update-desktop-database >/dev/null 2>&1; then update-desktop-database "$APP_DIR"; fi
printf 'Installed RT&T Scout in %s and %s\n' "$APP_DIR/rtt-scout.desktop" "$BIN_DIR/rtt-scout"
