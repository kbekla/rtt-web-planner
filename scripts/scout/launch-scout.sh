#!/usr/bin/env bash
set -euo pipefail

readonly EXPECTED_REPO="/home/karl/rtt-map-factory/worktrees/codex-scout"
readonly STATE_ROOT="/home/karl/rtt-map-factory/scout/private/real-source-validation/be-20261004-r02-operator-v22/state"
readonly FACTORY_DIR="/home/karl/rtt-map-factory"
readonly PORT="${SCOUT_OPERATOR_PORT:-8770}"
readonly URL="http://127.0.0.1:${PORT}/"
readonly HEALTH_URL="${URL%/}/health"
last_health_result="no response"

notify_failure() {
  local message="$1"
  if command -v zenity >/dev/null 2>&1; then
    zenity --error --title='RT&T Scout' --text="$message" >/dev/null 2>&1 || true
  elif command -v notify-send >/dev/null 2>&1; then
    notify-send 'RT&T Scout' "$message" || true
  fi
}

launcher_log=""
log_event() {
  [[ -n "$launcher_log" ]] || return 0
  printf '%s stage=%s %s\n' "$(date -u +'%Y-%m-%dT%H:%M:%SZ')" "$1" "${2-}" >>"$launcher_log"
}
health_ready() {
  local response
  response="$(curl --silent --connect-timeout 0.25 --max-time 1 "$HEALTH_URL" 2>/dev/null)" || { last_health_result='curl failed to reach the loopback health endpoint'; return 1; }
  last_health_result="$response"
  [[ "$response" == '{"status":"RTT_SCOUT_READY"}' ]]
}
show_open_failure() {
  local reason="$1"
  log_event browser-failed "url=$URL reason=$reason scout_health=healthy"
  notify_failure "AMBER — RT&T Scout is running, but Ubuntu could not open its browser. Open $URL manually. Details: $launcher_log"
  # Keep the desktop launcher from reporting Scout itself as failed. The local
  # service is healthy; the dialog gives Karl the URL and diagnostic log.
  exit 0
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
  notify_failure "RED — the existing private Scout state database is unavailable. No Scout service was started. Ask for the configured Scout state path to be repaired."
  exit 2
fi
if ! command -v node >/dev/null 2>&1 || ! command -v curl >/dev/null 2>&1 || ! command -v flock >/dev/null 2>&1; then
  notify_failure "RED — a required local runtime tool (Node.js, curl, or flock) is missing. No Scout service was started."
  exit 2
fi

export SCOUT_GEO_ROOT="$STATE_ROOT"
export SCOUT_RAW_ROOT="$STATE_ROOT/raw"
export FACTORY_DIR
export SCOUT_OPERATOR_PORT="$PORT"
# The GNOME .desktop launch context is not guaranteed to inherit Karl's
# interactive-shell exports. Keep the non-secret owner alert mailbox explicit
# here so detached Scout operator jobs inherit it through operator-ui.
export SCOUT_NOTIFICATION_EMAIL="${SCOUT_NOTIFICATION_EMAIL:-info@roadtrailandtide.com}"
mkdir -p -m 700 "$STATE_ROOT/operator-logs"
chmod 700 "$STATE_ROOT/operator-logs"
log_file="$STATE_ROOT/operator-logs/operator-ui.log"
lock_file="$STATE_ROOT/operator-logs/operator-ui.lock"
launcher_log="$STATE_ROOT/operator-logs/launcher.log"
if [[ -L "$launcher_log" || -L "$launcher_log.1" ]]; then
  notify_failure "RED — the private Scout launcher log is a symlink. No Scout service was started."
  exit 2
fi
if [[ -e "$launcher_log" && ! -f "$launcher_log" ]]; then
  notify_failure "RED — the private Scout launcher log is not a regular file. No Scout service was started."
  exit 2
fi
if [[ -f "$launcher_log" && $(stat -c %s "$launcher_log") -gt 262144 ]]; then
  mv -f -- "$launcher_log" "$launcher_log.1"
fi
umask 077
touch "$launcher_log"
chmod 600 "$launcher_log"
log_event start "repo=$repo branch=codex/scout port=$PORT current_desktop=${XDG_CURRENT_DESKTOP:-unset} display=${DISPLAY:-unset} wayland=${WAYLAND_DISPLAY:-unset} dbus_session=$([[ -n ${DBUS_SESSION_BUS_ADDRESS:-} ]] && echo set || echo unset)"

if ! health_ready; then
  log_event operator-start "health=not-ready action=start"
  nohup flock -n "$lock_file" node "$repo/scripts/scout/operator-ui.mjs" >>"$log_file" 2>&1 </dev/null &
  ready=0
  # Allow a bounded 20 seconds for a cold local Node start.
  for _ in {1..40}; do
    if health_ready; then ready=1; break; fi
    sleep 0.5
  done
  if [[ "$ready" != 1 ]]; then
    detail="Scout did not become ready. State and jobs were left untouched."
    if [[ -r "$log_file" ]]; then
      last_line="$(tail -n 1 "$log_file" 2>/dev/null || true)"
      [[ -z "$last_line" ]] || detail+=$'\n'"$last_line"
    fi
    log_event operator-start-failed "health=not-ready endpoint=$HEALTH_URL response=${last_health_result:0:120} log=$log_file"
    notify_failure "RED — Scout could not start safely. $detail See $launcher_log for launcher diagnostics."
    exit 2
  fi
  log_event operator-started "health=RTT_SCOUT_READY wait_seconds<=20"
else
  log_event operator-reused "health=RTT_SCOUT_READY"
fi

open_output="$(mktemp "$STATE_ROOT/operator-logs/browser-open.XXXXXX")"
chmod 600 "$open_output"
if command -v gio >/dev/null 2>&1; then
  if gio open "$URL" >"$open_output" 2>&1; then log_event browser-opened "method=gio-open url=$URL"; rm -f -- "$open_output"; exit 0
  else rc=$?; message="$(tr '\n\r' '  ' <"$open_output" | cut -c1-300)"; log_event browser-attempt-failed "method=gio-open exit=$rc detail=${message:-no diagnostic}"; fi
fi
if command -v xdg-open >/dev/null 2>&1; then
  if xdg-open "$URL" >"$open_output" 2>&1; then log_event browser-opened "method=xdg-open url=$URL"; rm -f -- "$open_output"; exit 0
  else rc=$?; message="$(tr '\n\r' '  ' <"$open_output" | cut -c1-300)"; log_event browser-attempt-failed "method=xdg-open exit=$rc detail=${message:-no diagnostic}"; fi
fi
default_browser="$(xdg-settings get default-web-browser 2>/dev/null || true)"
if [[ "$default_browser" =~ ^[A-Za-z0-9._-]+\.desktop$ ]] && command -v gtk-launch >/dev/null 2>&1; then
  if gtk-launch "$default_browser" "$URL" >"$open_output" 2>&1; then log_event browser-opened "method=gtk-launch default=$default_browser url=$URL"; rm -f -- "$open_output"; exit 0
  else rc=$?; message="$(tr '\n\r' '  ' <"$open_output" | cut -c1-300)"; log_event browser-attempt-failed "method=gtk-launch default=$default_browser exit=$rc detail=${message:-no diagnostic}"; fi
fi
message="$(tr '\n\r' '  ' <"$open_output" | cut -c1-300)"
rm -f -- "$open_output"
show_open_failure "${message:-all desktop browser open methods failed}"
