#!/bin/bash
set -e

REPO="https://github.com/wuchengfeng/agent-monitor.git"
INSTALL_DIR="$HOME/.openclaw/workspace/agent-monitor"
OPENCLAW_JSON="$HOME/.openclaw/openclaw.json"
MONITOR_PORT=4000
PROXY_PORT=8888
UPSTREAM="http://ai-service.tal.com"

echo "=== OpenClaw Agent Monitor — Full Deploy ==="
echo ""

# --- 1. Check Node.js ---
if ! command -v node &>/dev/null; then
  echo "Error: Node.js not found. Install from https://nodejs.org (v18+)" >&2
  exit 1
fi
node -e "process.exit(parseInt(process.versions.node) < 18 ? 1 : 0)" 2>/dev/null || {
  echo "Error: Node.js v18+ required (current: $(node -v))" >&2
  exit 1
}
echo "[OK] Node.js $(node -v)"

# --- 2. Check Git ---
if ! command -v git &>/dev/null; then
  echo "Error: git not found." >&2
  exit 1
fi
echo "[OK] Git"

# --- 3. Check / install mitmproxy ---
if ! command -v mitmdump &>/dev/null; then
  echo "[..] mitmproxy not found, installing via Homebrew..."
  if ! command -v brew &>/dev/null; then
    echo "Error: Homebrew not found. Install from https://brew.sh then retry." >&2
    exit 1
  fi
  brew install mitmproxy
fi
echo "[OK] mitmproxy ($(mitmdump --version 2>/dev/null | head -1))"

# --- 4. Check install dir ---
if [ ! -d "$INSTALL_DIR" ]; then
  echo "Error: Install dir not found at $INSTALL_DIR" >&2
  exit 1
fi
echo "[OK] Code at $INSTALL_DIR"

# --- 5. Patch openclaw.json ---
if [ -f "$OPENCLAW_JSON" ]; then
  # Backup
  cp "$OPENCLAW_JSON" "${OPENCLAW_JSON}.bak"
  echo "[OK] Backed up openclaw.json → openclaw.json.bak"

  # Use node to safely modify JSON
  node -e "
    const fs = require('fs');
    const f = process.argv[1];
    const cfg = JSON.parse(fs.readFileSync(f, 'utf8'));
    const providers = cfg.models && cfg.models.providers || {};
    let changed = false;
    for (const [name, p] of Object.entries(providers)) {
      if (p.baseUrl && p.baseUrl.includes('ai-service.tal.com')) {
        p.baseUrl = p.baseUrl.replace(/ai-service\\.tal\\.com/, 'localhost:${PROXY_PORT}');
        changed = true;
      }
      if (p.api === 'openai-completions' && Array.isArray(p.models)) {
        for (const m of p.models) {
          if (!m.compat) m.compat = {};
          if (!m.compat.supportsUsageInStreaming) {
            m.compat.supportsUsageInStreaming = true;
            changed = true;
          }
        }
      }
    }
    if (changed) {
      fs.writeFileSync(f, JSON.stringify(cfg, null, 2) + '\n');
      console.log('[OK] Patched openclaw.json (baseUrl → localhost:${PROXY_PORT}, compat added)');
    } else {
      console.log('[OK] openclaw.json already patched');
    }
  " "$OPENCLAW_JSON"
else
  echo "[WARN] openclaw.json not found at $OPENCLAW_JSON — skipping config patch"
fi

# --- 6. Stop old processes ---
OLD_MONITOR=$(lsof -ti :$MONITOR_PORT 2>/dev/null || true)
if [ -n "$OLD_MONITOR" ]; then
  kill $OLD_MONITOR 2>/dev/null || true
  echo "[OK] Stopped old agent-monitor (pid $OLD_MONITOR)"
  sleep 0.5
fi

OLD_PROXY=$(lsof -ti :$PROXY_PORT 2>/dev/null || true)
if [ -n "$OLD_PROXY" ]; then
  kill $OLD_PROXY 2>/dev/null || true
  echo "[OK] Stopped old mitmproxy (pid $OLD_PROXY)"
  sleep 0.5
fi

# --- 7. Start agent-monitor server ---
cd "$INSTALL_DIR"
nohup node server.js > /tmp/agent-monitor.log 2>&1 &
MONITOR_PID=$!
echo "[OK] Agent monitor started (pid $MONITOR_PID, port $MONITOR_PORT)"

# --- 8. Start mitmproxy reverse proxy ---
nohup mitmdump \
  --mode "reverse:${UPSTREAM}" \
  --listen-port $PROXY_PORT \
  -s "$INSTALL_DIR/llm_capture.py" \
  --set flow_detail=0 \
  > /tmp/mitmproxy-llm.log 2>&1 &
PROXY_PID=$!
echo "[OK] mitmproxy started (pid $PROXY_PID, port $PROXY_PORT → $UPSTREAM)"

# --- 9. Done ---
echo ""
echo "=== Deploy complete ==="
echo ""
echo "  Agent Monitor:  http://localhost:$MONITOR_PORT"
echo "  LLM Proxy:      localhost:$PROXY_PORT → $UPSTREAM"
echo "  Logs:           /tmp/agent-monitor.log, /tmp/mitmproxy-llm.log"
echo ""
echo "  Stop:  bash $INSTALL_DIR/stop.sh"
echo ""
echo "  IMPORTANT: Restart openclaw gateway to pick up the new proxy config:"
echo "    openclaw gateway restart"
echo ""

# Open browser
(sleep 1 && open "http://localhost:$MONITOR_PORT" 2>/dev/null || true) &
