#!/bin/bash

echo "=== Stopping Agent Monitor & LLM Proxy ==="

STOPPED=0

# Stop agent-monitor (port 4000)
PIDS=$(lsof -ti :4000 2>/dev/null || true)
if [ -n "$PIDS" ]; then
  kill $PIDS 2>/dev/null || true
  echo "[OK] Stopped agent-monitor (pid $PIDS)"
  STOPPED=1
fi

# Stop mitmproxy (port 8888)
PIDS=$(lsof -ti :8888 2>/dev/null || true)
if [ -n "$PIDS" ]; then
  kill $PIDS 2>/dev/null || true
  echo "[OK] Stopped mitmproxy (pid $PIDS)"
  STOPPED=1
fi

if [ "$STOPPED" -eq 0 ]; then
  echo "No running processes found."
fi
