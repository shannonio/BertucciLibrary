#!/bin/bash
#
# Install Bertucci Library as an always-running launchd service on macOS,
# published on the tailnet over HTTPS via Tailscale Serve.
#
#   ./scripts/install-service.sh
#   ./scripts/install-service.sh --uninstall
#
# Everything is derived from where this repo actually sits and which node is on
# PATH — launchd runs with a minimal environment, so absolute paths matter and
# getting them wrong is the usual reason a plist silently does nothing.

set -euo pipefail

LABEL="com.bertucci.library"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG_DIR="$REPO/data/logs"
PORT="${PORT:-4173}"

# ------------------------------------------------------------- uninstall

if [[ "${1:-}" == "--uninstall" ]]; then
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  rm -f "$PLIST"
  echo "Removed the launchd service. Tailscale Serve is untouched:"
  echo "  tailscale serve --https=443 off"
  exit 0
fi

# ------------------------------------------------------------- checks

NODE="$(command -v node || true)"
if [[ -z "$NODE" ]]; then
  echo "node is not on PATH. Install Node 20+ first (brew install node)." >&2
  exit 1
fi

NODE_MAJOR="$("$NODE" -pe 'process.versions.node.split(".")[0]')"
if (( NODE_MAJOR < 20 )); then
  echo "Node $NODE_MAJOR found; this needs Node 20 or newer." >&2
  exit 1
fi

if [[ ! -f "$REPO/.env" ]]; then
  echo "No .env in $REPO — copy it across before installing." >&2
  exit 1
fi

if [[ ! -d "$REPO/node_modules" ]]; then
  echo "node_modules is missing. Run 'npm install' in $REPO first." >&2
  echo "(better-sqlite3 is a native module, so it must be built on this machine" >&2
  echo " — copying node_modules from another computer will not work.)" >&2
  exit 1
fi

mkdir -p "$LOG_DIR" "$HOME/Library/LaunchAgents"

# ------------------------------------------------------------- plist

# HOST=127.0.0.1 keeps the app off the LAN; Tailscale Serve is the only way in.
cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>

  <key>ProgramArguments</key>
  <array>
    <string>$NODE</string>
    <string>$REPO/server/index.js</string>
  </array>

  <key>WorkingDirectory</key>
  <string>$REPO</string>

  <key>EnvironmentVariables</key>
  <dict>
    <key>HOST</key>
    <string>127.0.0.1</string>
    <key>PORT</key>
    <string>$PORT</string>
    <key>NODE_ENV</key>
    <string>production</string>
  </dict>

  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>10</integer>

  <key>StandardOutPath</key>
  <string>$LOG_DIR/library.log</string>
  <key>StandardErrorPath</key>
  <string>$LOG_DIR/library.error.log</string>
</dict>
</plist>
PLIST_EOF

# bootout first so re-running picks up changes rather than silently keeping the
# old definition.
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
launchctl enable "gui/$(id -u)/$LABEL"

echo "Installed $LABEL"
echo "  repo : $REPO"
echo "  node : $NODE"
echo "  logs : $LOG_DIR/library.log"
echo ""

sleep 2
if curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then
  echo "Service is up on 127.0.0.1:$PORT"
else
  echo "Service did not answer yet. Check:"
  echo "  tail -n 40 $LOG_DIR/library.error.log"
fi

echo ""
echo "Next — publish it on the tailnet over HTTPS:"
echo "  tailscale serve --bg $PORT"
echo ""
echo "Then check the URL it prints, or run:  tailscale serve status"
