#!/bin/bash
set -e

REPO="https://github.com/wuchengfeng/agent-monitor.git"
INSTALL_DIR="$HOME/.openclaw-agent-monitor"

# Check node
if ! command -v node &>/dev/null; then
  echo "Error: Node.js not found. Install from https://nodejs.org (v18+)" >&2
  exit 1
fi

NODE_VER=$(node -e "process.exit(parseInt(process.versions.node) < 18 ? 1 : 0)" 2>/dev/null && echo ok || echo old)
if [ "$NODE_VER" = "old" ]; then
  echo "Error: Node.js v18+ required (current: $(node -v))" >&2
  exit 1
fi

# Clone or update
if [ -d "$INSTALL_DIR/.git" ]; then
  echo "Updating agent-monitor..."
  git -C "$INSTALL_DIR" pull --ff-only
else
  echo "Installing agent-monitor..."
  git clone "$REPO" "$INSTALL_DIR"
fi

echo ""
echo "Starting at http://localhost:4000 ..."
echo "Press Ctrl+C to stop."
echo ""

# Open browser after short delay (background)
(sleep 1 && open "http://localhost:4000" 2>/dev/null || xdg-open "http://localhost:4000" 2>/dev/null || true) &

cd "$INSTALL_DIR"
node server.js
