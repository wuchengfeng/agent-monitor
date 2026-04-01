# OpenClaw Agent Monitor

A real-time web dashboard for monitoring [OpenClaw](https://openclaw.ai) agent sessions — view live token usage, tool calls, session history, and manage heartbeat schedules.

## Prerequisites

- [OpenClaw](https://openclaw.ai) installed and running (`openclaw gateway start`)
- Node.js ≥ 18
- Git

## One-line Deploy (Mac)

Full deploy including LLM request capture:

```bash
curl -fsSL https://raw.githubusercontent.com/wuchengfeng/agent-monitor/main/deploy.sh | bash
```

This will:
1. Install mitmproxy if missing (via Homebrew)
2. Clone/update the repo to `~/.openclaw-agent-monitor`
3. Patch `~/.openclaw/openclaw.json` to route LLM calls through the proxy
4. Start both the monitor server (port 4000) and LLM proxy (port 8888)
5. Open the dashboard in your browser

**After deploy, restart your OpenClaw gateway:**
```bash
openclaw gateway restart
```

**Stop everything:**
```bash
bash ~/.openclaw-agent-monitor/stop.sh
```

## Monitor Only (no LLM capture)

```bash
curl -fsSL https://raw.githubusercontent.com/wuchengfeng/agent-monitor/main/install.sh | bash
```

## Manual Start

```bash
git clone https://github.com/wuchengfeng/agent-monitor.git
cd agent-monitor
node server.js
```

Open **http://localhost:4000** in your browser.

## Configuration

All config is via environment variables. Zero config needed for a standard OpenClaw install.

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `4000` | HTTP port for the dashboard |
| `OPENCLAW_DIR` | `~/.openclaw` | OpenClaw data directory |
| `OPENCLAW_WORKSPACE` | `~/.openclaw/workspace` | Agent workspace path |
| `OPENCLAW_AGENTS` | `~/.openclaw/agents` | Agent sessions path |
| `OPENCLAW_CONFIG` | `~/.openclaw/config.json` | OpenClaw config file |
| `OPENCLAW_BIN` | `openclaw` (from PATH) | OpenClaw binary (for gateway restart) |

### Custom OpenClaw location

```bash
OPENCLAW_DIR=/custom/path/.openclaw npm start
```

### Custom port

```bash
PORT=3001 npm start
```

## Features

- **Live session stream** — real-time token and tool call feed via SSE
- **Session history** — browse past sessions with full message timeline
- **Token usage** — input/output/cache token counts per message
- **LLM request capture** — view full API requests (system prompt, messages, tools, parameters) via mitmproxy
- **Heartbeat scheduler** — configure time-based heartbeat intervals
- **Auto soft-delete** — automatically archive old sessions

## Heartbeat Schedule

Edit `heartbeat_schedule.json` to set per-time-window heartbeat intervals:

```json
[
  { "start": "09:00", "end": "20:00", "interval": "10m" },
  { "start": "20:00", "end": "23:59", "interval": "30m" },
  { "start": "00:00", "end": "09:00", "interval": "1h" }
]
```

Changes take effect within 1 minute (no restart needed).
