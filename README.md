# OpenClaw Agent Monitor

A real-time web dashboard for monitoring [OpenClaw](https://openclaw.ai) agent sessions — view live token usage, tool calls, session history, and manage heartbeat schedules.

## Prerequisites

- [OpenClaw](https://openclaw.ai) installed and running (`openclaw gateway start`)
- Node.js ≥ 18

## Quick Start

```bash
git clone <this-repo>
cd openclaw-agent-monitor
npm start
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
