#!/usr/bin/env bash
set -euo pipefail

readonly EXPECTED_REPO="/home/karl/rtt-map-factory/worktrees/codex-scout"
readonly STATE_ROOT="/home/karl/rtt-map-factory/scout/private/real-source-validation/be-20261004-r02-operator-v22/state"
readonly FACTORY_DIR="/home/karl/rtt-map-factory"
readonly PORT="${SCOUT_OPERATOR_PORT:-8770}"
readonly URL="http://127.0.0.1:${PORT}/"

notify_failure() {
  local message="$1"
  if command -v zenity >/dev/null 2>&1; then
    zenity --error --title='RT&T Scout' --text="$message" >/dev/null 2>&1 || true
  elif command -v notify-send >/dev/null 2>&1; then
    notify-send 'RT&T Scout' "$message" || true
  fi
}

script_path="$(readlink -f -- "$0")"
repo="$(cd -- "$(dirname -- "$script_path")/../.." && pwd -P)"
if [[ "$repo" != "$EXPECTED_REPO" || "$repo" == "$FACTORY_DIR/runner/repo" ]]; then
  notify_failure "RED — Scout launcher resolved to an unexpected installation. No service was started."
  exit 2
fi
if [[ "$(git -C "$repo" branch --show-current 2>/dev/null || true)" != "codex/scout" ]]; then
  notify_failure "RED — the Scout development installation is not on its expected branch. No service was started."
  exit 2
fi
if [[ ! -f "$STATE_ROOT/scout.sqlite" || -L "$STATE_ROOT" || -L "$STATE_ROOT/scout.sqlite" ]]; then
  notify_failure "AMBER — the existing private Scout state database is unavailable. Ask for the configured Scout state path to be repaired."
  exit 2
fi
if ! command -v node >/dev/null 2>&1 || ! command -v curl >/dev/null 2>&1 || ! command -v flock >/dev/null 2>&1; then
  notify_failure "RED — a required local runtime tool (Node.js, curl, or flock) is missing."
  exit 2
fi

export SCOUT_GEO_ROOT="$STATE_ROOT"
export SCOUT_RAW_ROOT="$STATE_ROOT/raw"
export FACTORY_DIR
export SCOUT_OPERATOR_PORT="$PORT"
mkdir -p -m 700 "$STATE_ROOT/operator-logs"
chmod 700 "$STATE_ROOT/operator-logs"
log_file="$STATE_ROOT/operator-logs/operator-ui.log"
lock_file="$STATE_ROOT/operator-logs/operator-ui.lock"

if ! curl --silent --fail --max-time 1 "$URL/health" >/dev/null 2>&1; then
  nohup flock -n "$lock_file" node "$repo/scripts/scout/operator-ui.mjs" >>"$log_file" 2>&1 </dev/null &
  ready=0
  for _ in {1..50}; do
    if curl --silent --fail --max-time 1 "$URL/health" >/dev/null 2>&1; then ready=1; break; fi
    sleep 0.1
  done
  if [[ "$ready" != 1 ]]; then
    detail="Scout did not become ready. State and jobs were left untouched."
    if [[ -r "$log_file" ]]; then
      last_line="$(tail -n 1 "$log_file" 2>/dev/null || true)"
      [[ -z "$last_line" ]] || detail+=$'\n'"$last_line"
    fi
    notify_failure "AMBER — $detail"
    exit 2
  fi
fi

if ! xdg-open "$URL" >/dev/null 2>&1; then
  notify_failure "AMBER — Scout is running locally at $URL, but Ubuntu could not open the browser."
  exit 2
fi
