#!/bin/bash
set -e

# 自动找安装目录（兼容两种路径）
DIR="${AGENT_MONITOR_DIR:-$HOME/.openclaw/workspace/agent-monitor}"
[ -d "$DIR/.git" ] || DIR="$HOME/.openclaw-agent-monitor"

if [ ! -d "$DIR/.git" ]; then
  echo "Error: agent-monitor not found. Run install.sh first." >&2
  exit 1
fi

echo "Updating agent-monitor..."
git -C "$DIR" pull --ff-only

# 停掉旧进程
OLD=$(lsof -ti :4000 2>/dev/null || true)
if [ -n "$OLD" ]; then
  kill $OLD 2>/dev/null || true
  echo "Stopped old server (pid $OLD)"
  sleep 0.5
fi

echo "Starting at http://localhost:4000 ..."
cd "$DIR" && node server.js
