#!/bin/sh
set -eu

apply=false
case "${1:-}" in
  "")
    ;;
  --apply)
    apply=true
    ;;
  *)
    echo "Usage: $0 [--apply]" >&2
    exit 2
    ;;
esac

note() {
  printf '%s\n' "$*"
}

run() {
  if [ "$apply" = true ]; then
    "$@"
  else
    printf '[dry-run]'
    printf ' %s' "$@"
    printf '\n'
  fi
}

is_prototype_service_file() {
  file=$1
  [ -f "$file" ] || return 1
  grep -Eq 'hunsu-bridge supervise|bridge-app\.json|HUNSU_BRIDGE_APP_STATE_PATH|hunsu-bridge-sidecar' "$file"
}

systemd_unit="$HOME/.config/systemd/user/hunsu-bridge.service"
if is_prototype_service_file "$systemd_unit"; then
  note "Removing verified prototype systemd user unit: $systemd_unit"
  if command -v systemctl >/dev/null 2>&1; then
    run systemctl --user disable --now hunsu-bridge.service || true
  fi
  run rm -f -- "$systemd_unit"
  if command -v systemctl >/dev/null 2>&1; then
    run systemctl --user daemon-reload || true
  fi
elif [ -e "$systemd_unit" ]; then
  note "Skipped non-prototype systemd unit at the reserved path: $systemd_unit"
fi

launch_agent="$HOME/Library/LaunchAgents/app.hunsu.bridge.plist"
if is_prototype_service_file "$launch_agent"; then
  note "Removing verified prototype LaunchAgent: $launch_agent"
  if command -v launchctl >/dev/null 2>&1; then
    run launchctl bootout "gui/$(id -u)/app.hunsu.bridge" || true
  fi
  run rm -f -- "$launch_agent"
elif [ -e "$launch_agent" ]; then
  note "Skipped non-prototype LaunchAgent at the reserved path: $launch_agent"
fi

protocol_file="$HOME/.local/share/applications/hunsu-bridge.desktop"
if [ -f "$protocol_file" ] &&
  grep -Fqx 'Name=Hunsu Bridge' "$protocol_file" &&
  grep -Fqx 'MimeType=x-scheme-handler/hunsu;' "$protocol_file"; then
  note "Removing verified prototype protocol handler: $protocol_file"
  run rm -f -- "$protocol_file"
  if command -v update-desktop-database >/dev/null 2>&1; then
    run update-desktop-database "$HOME/.local/share/applications" || true
  fi
elif [ -e "$protocol_file" ]; then
  note "Skipped unrecognized desktop entry at the reserved path: $protocol_file"
fi

user_app="$HOME/Applications/Hunsu Bridge.app"
user_app_executable="$user_app/Contents/MacOS/hunsu-bridge"
if [ -f "$user_app_executable" ] && [ -f "$user_app/Contents/Info.plist" ]; then
  note "Removing exact user-installed prototype app bundle: $user_app"
  if command -v launchctl >/dev/null 2>&1; then
    run launchctl bootout "gui/$(id -u)/app.hunsu.bridge" || true
  fi
  run rm -rf -- "$user_app"
fi

system_app="/Applications/Hunsu Bridge.app"
if [ -e "$system_app" ]; then
  note "System app found at $system_app; remove that exact bundle with administrator review."
fi

note "Workspace, configuration, credential, runtime-state, and log directories were not read or removed."
if [ "$apply" = false ]; then
  note "Dry run only. Re-run with --apply after reviewing the exact targets above."
fi
