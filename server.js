const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const url = require('url');
const { exec } = require('child_process');

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 4000;
const OPENCLAW_DIR = process.env.OPENCLAW_DIR || path.join(os.homedir(), '.openclaw');
const BASE_ROOT = process.env.OPENCLAW_WORKSPACE || path.join(OPENCLAW_DIR, 'workspace');
const agentsRoot = process.env.OPENCLAW_AGENTS || path.join(OPENCLAW_DIR, 'agents');
const defaultAgentId = 'main';

const clients = new Set();
const fileOffsets = new Map();
const fileBuffers = new Map();

const MONITOR_SETTINGS_FILE = path.join(BASE_ROOT, 'agent-monitor', 'monitor_settings.json');

// --- Heartbeat Scheduler Logic ---
const HEARTBEAT_SCHEDULE_FILE = path.join(BASE_ROOT, 'agent-monitor', 'heartbeat_schedule.json');
const OPENCLAW_CONFIG_FILE = process.env.OPENCLAW_CONFIG || path.join(OPENCLAW_DIR, 'config.json');

function readJson(file) {
  try {
    if (fs.existsSync(file)) {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    }
  } catch (e) {
    console.error(`Failed to read ${file}:`, e);
  }
  return null;
}

function writeJson(file, data) {
  try {
    const dir = path.dirname(file);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
    return true;
  } catch (e) {
    console.error(`Failed to write ${file}:`, e);
    return false;
  }
}

function applyHeartbeatSchedule() {
  const schedule = readJson(HEARTBEAT_SCHEDULE_FILE) || [];
  // if (!Array.isArray(schedule)) return; // allow empty

  const now = new Date();
  const currentHm = now.getHours().toString().padStart(2, '0') + ':' + now.getMinutes().toString().padStart(2, '0');
  
  // Find matching rule
  const activeRule = schedule.find(r => currentHm >= r.start && currentHm < r.end);
  const targetInterval = activeRule ? activeRule.interval : '30m';

  let config = readJson(OPENCLAW_CONFIG_FILE) || {};
  
  // Ensure structure exists
  if (!config.agents) config.agents = {};
  if (!config.agents.defaults) config.agents.defaults = {};
  if (!config.agents.defaults.heartbeat) config.agents.defaults.heartbeat = {};

  const currentInterval = config.agents.defaults.heartbeat.every;

  if (currentInterval !== targetInterval) {
    console.log(`[Heartbeat Scheduler] Updating interval from ${currentInterval} to ${targetInterval} (Time: ${currentHm})`);
    config.agents.defaults.heartbeat.every = targetInterval;
    writeJson(OPENCLAW_CONFIG_FILE, config);

    // Restart OpenClaw gateway to apply changes
    console.log('[Heartbeat Scheduler] Restarting OpenClaw gateway...');
    const nodeBin = process.env.NODE_BIN || process.execPath;
    const openclawBin = process.env.OPENCLAW_BIN || 'openclaw';
    exec(`"${nodeBin}" "${openclawBin}" gateway restart`, (error, stdout, stderr) => {
      if (error) {
        console.error(`[Heartbeat Scheduler] Error restarting gateway: ${error.message}`);
        return;
      }
      if (stderr) {
        console.error(`[Heartbeat Scheduler] Gateway restart stderr: ${stderr}`);
      }
      console.log(`[Heartbeat Scheduler] Gateway restarted: ${stdout}`);
    });
  }
}

setInterval(applyHeartbeatSchedule, 60 * 1000);
applyHeartbeatSchedule();
// --- End Heartbeat Scheduler Logic ---

const defaultAutoSoftDeleteConfig = {
  enabled: process.env.AUTO_SOFT_DELETE_ENABLED ? process.env.AUTO_SOFT_DELETE_ENABLED !== '0' : true,
  ttlMs: process.env.AUTO_SOFT_DELETE_TTL_MS ? parseInt(process.env.AUTO_SOFT_DELETE_TTL_MS, 10) : 60 * 60 * 1000,
  intervalMs: process.env.AUTO_SOFT_DELETE_INTERVAL_MS ? parseInt(process.env.AUTO_SOFT_DELETE_INTERVAL_MS, 10) : 10 * 60 * 1000,
};

function sanitizeAutoSoftDeleteConfig(input) {
  const enabled = typeof input?.enabled === 'boolean' ? input.enabled : defaultAutoSoftDeleteConfig.enabled;
  const ttlMsRaw = Number.isFinite(input?.ttlMs) ? input.ttlMs : defaultAutoSoftDeleteConfig.ttlMs;
  const intervalMsRaw = Number.isFinite(input?.intervalMs) ? input.intervalMs : defaultAutoSoftDeleteConfig.intervalMs;
  const ttlMs = Math.max(60 * 1000, Math.min(30 * 24 * 60 * 60 * 1000, Math.floor(ttlMsRaw)));
  const intervalMs = Math.max(10 * 1000, Math.min(60 * 60 * 1000, Math.floor(intervalMsRaw)));
  return { enabled, ttlMs, intervalMs };
}

function loadAutoSoftDeleteConfig() {
  const settings = readJson(MONITOR_SETTINGS_FILE);
  const cfg = settings && settings.autoSoftDelete ? settings.autoSoftDelete : null;
  return sanitizeAutoSoftDeleteConfig(cfg || {});
}

function saveAutoSoftDeleteConfig(config) {
  const safe = sanitizeAutoSoftDeleteConfig(config || {});
  const current = readJson(MONITOR_SETTINGS_FILE) || {};
  const next = { ...current, autoSoftDelete: safe };
  if (!writeJson(MONITOR_SETTINGS_FILE, next)) return null;
  return safe;
}

let autoSoftDeleteConfig = loadAutoSoftDeleteConfig();
let autoSoftDeleteTimer = null;

function autoSoftDeleteStaleSessions() {
  if (!autoSoftDeleteConfig.enabled) return;
  const now = Date.now();
  const agentIds = listAgentIds();
  for (const agentId of agentIds) {
    const dir = getAgentSessionsDir(agentId);
    fs.readdir(dir, (err, files) => {
      if (err) return;
      const jsonlFiles = files.filter((f) => f.endsWith('.jsonl'));
      for (const f of jsonlFiles) {
        const sid = path.basename(f, '.jsonl');
        if (!isValidSessionId(sid)) continue;
        const fp = path.join(dir, f);
        fs.stat(fp, (e, st) => {
          if (e || !st) return;
          const ageMs = now - st.mtimeMs;
          if (ageMs <= autoSoftDeleteConfig.ttlMs) return;
          const dst = path.join(
            dir,
            `${sid}.jsonl.deleted.${new Date().toISOString().replace(/[:.]/g, '-')}`
          );
          fs.rename(fp, dst, (renameErr) => {
            if (renameErr) return;
            console.log(`[Auto Soft Delete] ${agentId}/${sid} -> ${dst} (stale ${(ageMs / 60000).toFixed(0)}m)`);
          });
        });
      }
    });
  }
}

function startAutoSoftDeleteScheduler() {
  if (autoSoftDeleteTimer) clearInterval(autoSoftDeleteTimer);
  autoSoftDeleteTimer = setInterval(autoSoftDeleteStaleSessions, autoSoftDeleteConfig.intervalMs);
  autoSoftDeleteStaleSessions();
}

startAutoSoftDeleteScheduler();

function sendEvent(res, event) {
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

function isValidSessionId(sessionId) {
  return typeof sessionId === 'string' && /^[a-f0-9-]{36}$/i.test(sessionId);
}

function listAgentIds() {
  try {
    const entries = fs.readdirSync(agentsRoot, { withFileTypes: true });
    const ids = entries.filter((d) => d.isDirectory()).map((d) => d.name);
    return ids.length ? ids : [defaultAgentId];
  } catch {
    return [defaultAgentId];
  }
}

function getAgentSessionsDir(agentId) {
  return path.join(agentsRoot, agentId, 'sessions');
}

function sessionActivePath(sessionId, agentId = defaultAgentId) {
  return path.join(getAgentSessionsDir(agentId), `${sessionId}.jsonl`);
}

function listDeletedCandidates(sessionId, agentId = defaultAgentId) {
  return new Promise((resolve) => {
    const dir = getAgentSessionsDir(agentId);
    fs.readdir(dir, (err, files) => {
      if (err) return resolve([]);
      const prefix = `${sessionId}.jsonl.deleted.`;
      const matches = files.filter((f) => f.startsWith(prefix)).map((f) => path.join(dir, f));
      if (!matches.length) return resolve([]);
      let pending = matches.length;
      const out = [];
      matches.forEach((fp) => {
        fs.stat(fp, (e, st) => {
          if (!e && st) out.push({ path: fp, mtimeMs: st.mtimeMs });
          if (--pending === 0) {
            out.sort((a, b) => b.mtimeMs - a.mtimeMs);
            resolve(out);
          }
        });
      });
    });
  });
}

function safeMessageSlice(msg, n) {
  if (!msg) return '';
  if (msg.length <= n) return msg;
  return msg.slice(0, n) + '…';
}

function parseLine(line, sessionId, agentId) {
  try {
    const obj = JSON.parse(line);
    const ts = obj.timestamp || Date.now();
    const m = obj.message || {};
    const role = m.role || null;
    const contentArr = Array.isArray(m.content) ? m.content : [];
    // 提取 toolCalls
    const toolCalls = contentArr.filter((c) => c && c.type === 'toolCall');
    
    // 提取 textPreview
    const texts = contentArr.filter((c) => c && c.type === 'text').map((t) => t.text).join(' ');
    const textPreview = texts;
    
    // 构造更详细的工具调用信息
    const toolCallDetails = toolCalls.map(tool => {
      return {
        name: tool.name,
        args: tool.arguments
      };
    });

    const toolName = toolCallDetails.length ? toolCallDetails.map(t => t.name).join(', ') : null;
    // 如果是 sessions_spawn，提取 task 信息以便在前端展示
    const toolArgs = toolCallDetails.length ? toolCallDetails.map(t => {
      if (t.name === 'sessions_spawn' && t.args && t.args.task) {
        return `[Spawn Task] ${t.args.task.substring(0, 200)}...`; 
      }
      return JSON.stringify(t.args);
    }).join('; ') : null;

    const errorMessage = m.errorMessage || obj.errorMessage || null;
    const provider = obj.provider || m.provider || null;
    const model = obj.model || m.model || null;
    const stopReason = obj.stopReason || m.stopReason || null;
    const msgId = obj.id || m.id || null;
    const usage = m.usage || null;
    
    // For detailed timeline: pass through the full content and specific tool result info
    const fullContent = contentArr;
    const resultToolName = m.toolName || null;
    const resultToolId = m.toolCallId || null;
    
    return {
      sessionId,
      agentId,
      ts,
      role,
      textPreview,
      toolName,
      toolArgs,
      errorMessage,
      provider,
      model,
      stopReason,
      msgId,
      usage,
      fullContent,
      resultToolName,
      resultToolId
    };
  } catch {
    return null;
  }
}

function readNewData(filePath, agentId) {
  fs.stat(filePath, (err, stat) => {
    if (err) return;
    const prev = fileOffsets.get(filePath) || 0;
    const size = stat.size;
    if (size <= prev) return;
    const stream = fs.createReadStream(filePath, { start: prev, end: size - 1, encoding: 'utf8' });
    let buf = fileBuffers.get(filePath) || '';
    stream.on('data', (chunk) => {
      buf += chunk;
      let idx;
      while ((idx = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        const sessionId = path.basename(filePath, '.jsonl');
        const event = parseLine(line, sessionId, agentId);
        if (event) {
          for (const c of clients) sendEvent(c, event);
        }
      }
    });
    stream.on('end', () => {
      fileBuffers.set(filePath, buf);
      fileOffsets.set(filePath, size);
    });
  });
}

function initialCatchUp(filePath, agentId, maxLines = 50) {
  fs.readFile(filePath, 'utf8', (err, data) => {
    if (err) return;
    const lines = data.trim().split('\n');
    const tail = lines.slice(-maxLines);
    const sessionId = path.basename(filePath, '.jsonl');
    for (const line of tail) {
      const event = parseLine(line, sessionId, agentId);
      if (event) {
        for (const c of clients) sendEvent(c, event);
      }
    }
    fileOffsets.set(filePath, Buffer.byteLength(data, 'utf8'));
    fileBuffers.set(filePath, '');
  });
}

function scanExistingFiles() {
  const agentIds = listAgentIds();
  for (const agentId of agentIds) {
    const dir = getAgentSessionsDir(agentId);
    fs.readdir(dir, (err, files) => {
      if (err) return;
      for (const f of files) {
        if (f.endsWith('.jsonl')) {
          const fp = path.join(dir, f);
          if (!fileOffsets.has(fp)) {
            initialCatchUp(fp, agentId, 30);
          }
        }
      }
    });
  }
}

const agentWatchers = new Map();

function ensureAgentWatch(agentId) {
  if (agentWatchers.has(agentId)) return;
  const dir = getAgentSessionsDir(agentId);
  try {
    if (!fs.existsSync(dir)) return;
  } catch {
    return;
  }
  const watcher = fs.watch(dir, { persistent: true }, (eventType, filename) => {
    if (!filename || !filename.endsWith('.jsonl')) return;
    const fp = path.join(dir, filename);
    if (!fileOffsets.has(fp)) initialCatchUp(fp, agentId, 30);
    readNewData(fp, agentId);
  });
  agentWatchers.set(agentId, watcher);
}

function ensureAgentWatches() {
  const agentIds = listAgentIds();
  for (const agentId of agentIds) {
    ensureAgentWatch(agentId);
  }
}

try {
  fs.watch(agentsRoot, { persistent: true }, () => {
    ensureAgentWatches();
    scanExistingFiles();
  });
} catch {}

function collectSnapshot(maxLinesPerFile = 30) {
  return new Promise((resolve) => {
    const agentIds = listAgentIds();
    if (!agentIds.length) return resolve({ items: [], stats: {}, activeByAgent: {} });
    let pendingAgents = agentIds.length;
    const outItems = [];
    const outStats = {};
    const activeByAgent = {};
    const finalize = () => {
      outItems.sort((a, b) => (b.ts || 0) - (a.ts || 0));
      resolve({ items: outItems, stats: outStats, activeByAgent });
    };
    agentIds.forEach((agentId) => {
      const dir = getAgentSessionsDir(agentId);
      fs.readdir(dir, (err, files) => {
        if (err) {
          activeByAgent[agentId] = [];
          if (--pendingAgents === 0) finalize();
          return;
        }
        const jsonl = files.filter((f) => f.endsWith('.jsonl'));
        activeByAgent[agentId] = jsonl.map((f) => path.basename(f, '.jsonl'));
        if (!jsonl.length) {
          if (--pendingAgents === 0) finalize();
          return;
        }
        outStats[agentId] = outStats[agentId] || {};
        let pendingFiles = jsonl.length;
        jsonl.forEach((f) => {
          const fp = path.join(dir, f);
          fs.readFile(fp, 'utf8', (e, data) => {
            if (!e && data) {
              const allLines = data.trim().split('\n');
              const sessionId = path.basename(fp, '.jsonl');
              let totalInput = 0;
              let totalOutput = 0;
              for (const line of allLines) {
                const ev = parseLine(line, sessionId, agentId);
                if (ev && ev.usage) {
                  totalInput += (ev.usage.input || 0);
                  totalOutput += (ev.usage.output || 0);
                }
              }
              outStats[agentId][sessionId] = { input: totalInput, output: totalOutput };
              const tail = allLines.slice(-maxLinesPerFile);
              for (const line of tail) {
                const ev = parseLine(line, sessionId, agentId);
                if (ev) outItems.push(ev);
              }
            }
            if (--pendingFiles === 0) {
              if (--pendingAgents === 0) finalize();
            }
          });
        });
      });
    });
  });
}

function collectSessionHistory(sessionId, agentId = defaultAgentId, maxLines = 2000) {
  return new Promise((resolve) => {
    const fp = sessionActivePath(sessionId, agentId);
    fs.readFile(fp, 'utf8', (err, data) => {
      if (!err && data) {
        const lines = data.trim().split('\n');
        const tail = lines.slice(-maxLines);
        const out = [];
        for (const line of tail) {
          const ev = parseLine(line, sessionId, agentId);
          if (ev) out.push(ev);
        }
        out.sort((a, b) => (a.ts || 0) - (b.ts || 0));
        resolve({ items: out, source: 'active', filePath: fp });
        return;
      }
      listDeletedCandidates(sessionId, agentId).then((candidates) => {
        if (!candidates.length) return resolve({ items: [], source: 'missing', filePath: null });
        const deletedPath = candidates[0].path;
        fs.readFile(deletedPath, 'utf8', (e2, d2) => {
          if (e2 || !d2) return resolve({ items: [], source: 'deleted', filePath: deletedPath });
          const lines = d2.trim().split('\n');
          const tail = lines.slice(-maxLines);
          const out = [];
          for (const line of tail) {
            const ev = parseLine(line, sessionId, agentId);
            if (ev) out.push(ev);
          }
          out.sort((a, b) => (a.ts || 0) - (b.ts || 0));
          resolve({ items: out, source: 'deleted', filePath: deletedPath });
        });
      });
    });
  });
}

const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  if (parsed.pathname === '/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });
    clients.add(res);
    req.on('close', () => {
      clients.delete(res);
    });
    ensureAgentWatches();
    scanExistingFiles();
    return;
  }

  // Heartbeat API
  if (parsed.pathname === '/api/heartbeat/schedule') {
    if (req.method === 'GET') {
      const schedule = readJson(HEARTBEAT_SCHEDULE_FILE) || [];
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(schedule));
    } else if (req.method === 'POST') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        try {
          const schedule = JSON.parse(body);
          if (writeJson(HEARTBEAT_SCHEDULE_FILE, schedule)) {
            applyHeartbeatSchedule();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true }));
          } else {
            throw new Error('Write failed');
          }
        } catch (e) {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: e.message }));
        }
      });
    }
    return;
  }

  if (parsed.pathname === '/api/heartbeat/current') {
    const config = readJson(OPENCLAW_CONFIG_FILE);
    const interval = config?.agents?.defaults?.heartbeat?.every || '30m';
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ interval }));
    return;
  }

  if (parsed.pathname === '/api/monitor/auto-soft-delete') {
    if (req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ config: autoSoftDeleteConfig, defaults: defaultAutoSoftDeleteConfig }));
      return;
    }
    if (req.method === 'POST') {
      let body = '';
      req.on('data', (chunk) => body += chunk);
      req.on('end', () => {
        try {
          const nextCfg = JSON.parse(body || '{}');
          const saved = saveAutoSoftDeleteConfig(nextCfg);
          if (!saved) {
            res.statusCode = 500;
            res.end(JSON.stringify({ error: 'write failed' }));
            return;
          }
          autoSoftDeleteConfig = saved;
          startAutoSoftDeleteScheduler();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, config: autoSoftDeleteConfig }));
        } catch (e) {
          res.statusCode = 400;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: String(e && e.message || e) }));
        }
      });
      return;
    }
    res.statusCode = 405;
    res.end('Method not allowed');
    return;
  }

  if (parsed.pathname === '/session-history') {
    const sessionId = parsed.query && parsed.query.sid ? String(parsed.query.sid) : '';
    const agentId = parsed.query && parsed.query.agent ? String(parsed.query.agent) : defaultAgentId;
    if (!isValidSessionId(sessionId)) {
      res.statusCode = 400;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'invalid sid' }));
      return;
    }
    const limit = parsed.query && parsed.query.limit ? parseInt(parsed.query.limit, 10) : 2000;
    const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.min(20000, limit)) : 2000;
    const out = await collectSessionHistory(sessionId, agentId, safeLimit);
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(JSON.stringify({ sessionId, agentId, items: out.items, source: out.source, filePath: out.filePath }));
    return;
  }
  if (parsed.pathname === '/activity') {
    const fp = path.join(__dirname, 'public', 'activity.html');
    fs.readFile(fp, (err, data) => {
      if (err) {
        res.statusCode = 404;
        res.end('Not found');
        return;
      }
      res.setHeader('Content-Type', 'text/html');
      res.end(data);
    });
    return;
  }
  if (parsed.pathname === '/sessions') {
    const includeDeleted = String(parsed.query && parsed.query.includeDeleted || '') === '1';
    const agentIds = listAgentIds();
    let pendingAgents = agentIds.length;
    const agents = [];
    if (!pendingAgents) {
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(JSON.stringify({ agents }));
      return;
    }
    agentIds.forEach((agentId) => {
      const dir = getAgentSessionsDir(agentId);
      fs.readdir(dir, async (err, files) => {
        if (err) {
          agents.push({ agentId, active: [], deleted: [] });
          if (--pendingAgents === 0) {
            res.writeHead(200, {
              'Content-Type': 'application/json',
              'Access-Control-Allow-Origin': '*',
            });
            res.end(JSON.stringify({ agents }));
          }
          return;
        }
        const active = files.filter((f) => f.endsWith('.jsonl')).map((f) => path.basename(f, '.jsonl'));
        if (!includeDeleted) {
          agents.push({ agentId, active, deleted: [] });
          if (--pendingAgents === 0) {
            res.writeHead(200, {
              'Content-Type': 'application/json',
              'Access-Control-Allow-Origin': '*',
            });
            res.end(JSON.stringify({ agents }));
          }
          return;
        }
        const deletedFiles = files.filter((f) => f.includes('.jsonl.deleted.')).map((f) => path.join(dir, f));
        let pending = deletedFiles.length;
        const deleted = [];
        if (!pending) {
          agents.push({ agentId, active, deleted });
          if (--pendingAgents === 0) {
            res.writeHead(200, {
              'Content-Type': 'application/json',
              'Access-Control-Allow-Origin': '*',
            });
            res.end(JSON.stringify({ agents }));
          }
          return;
        }
        deletedFiles.forEach((fp) => {
          fs.stat(fp, (e, st) => {
            if (!e && st) {
              const base = path.basename(fp);
              const sid = base.split('.jsonl.deleted.')[0];
              deleted.push({ sessionId: sid, path: fp, deletedAt: st.mtimeMs });
            }
            if (--pending === 0) {
              deleted.sort((a, b) => b.deletedAt - a.deletedAt);
              agents.push({ agentId, active, deleted });
              if (--pendingAgents === 0) {
                res.writeHead(200, {
                  'Content-Type': 'application/json',
                  'Access-Control-Allow-Origin': '*',
                });
                res.end(JSON.stringify({ agents }));
              }
            }
          });
        });
      });
    });
    return;
  }
  if (parsed.pathname === '/session-delete' && req.method === 'POST') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    const sessionId = parsed.query && parsed.query.sid ? String(parsed.query.sid) : '';
    const agentId = parsed.query && parsed.query.agent ? String(parsed.query.agent) : defaultAgentId;
    if (!isValidSessionId(sessionId)) {
      res.statusCode = 400;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'invalid sid' }));
      return;
    }
    const src = sessionActivePath(sessionId, agentId);
    const dst = path.join(getAgentSessionsDir(agentId), `${sessionId}.jsonl.deleted.${new Date().toISOString().replace(/[:.]/g, '-')}`);
    fs.rename(src, dst, (err) => {
      if (err) {
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: String(err && err.message || err) }));
        return;
      }
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok: true, sessionId, agentId, deletedPath: dst }));
    });
    return;
  }
  if (parsed.pathname === '/session-restore' && req.method === 'POST') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    const sessionId = parsed.query && parsed.query.sid ? String(parsed.query.sid) : '';
    const agentId = parsed.query && parsed.query.agent ? String(parsed.query.agent) : defaultAgentId;
    if (!isValidSessionId(sessionId)) {
      res.statusCode = 400;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'invalid sid' }));
      return;
    }
    const dst = sessionActivePath(sessionId, agentId);
    fs.stat(dst, async (existsErr) => {
      if (!existsErr) {
        res.statusCode = 409;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'active session file already exists' }));
        return;
      }
      const candidates = await listDeletedCandidates(sessionId, agentId);
      if (!candidates.length) {
        res.statusCode = 404;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'no deleted session found' }));
        return;
      }
      const src = candidates[0].path;
      fs.rename(src, dst, (err) => {
        if (err) {
          res.statusCode = 500;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: String(err && err.message || err) }));
          return;
        }
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ ok: true, sessionId, agentId, restoredFrom: src }));
      });
    });
    return;
  }
  if (parsed.pathname === '/snapshot') {
    const limit = parsed.query && parsed.query.limit ? parseInt(parsed.query.limit, 10) : 30;
    const data = await collectSnapshot(limit);
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(JSON.stringify(data));
    return;
  }
  if (parsed.pathname === '/write-text' && req.method === 'POST') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    const target = (parsed.query && parsed.query.path) ? String(parsed.query.path) : '';
    if (!target) {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: 'missing path query' }));
      return;
    }
    const abs = path.resolve(target);
    if (!abs.startsWith(BASE_ROOT + path.sep)) {
      res.statusCode = 403;
      res.end(JSON.stringify({ error: 'path not allowed' }));
      return;
    }
    const tmp = abs + '.tmp';
    const dir = path.dirname(abs);
    try { fs.mkdirSync(dir, { recursive: true }); } catch {}
    let size = 0;
    const limit = 2 * 1024 * 1024; // 2MB
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        res.statusCode = 413;
        res.end(JSON.stringify({ error: 'payload too large' }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        const buf = Buffer.concat(chunks);
        fs.writeFileSync(tmp, buf);
        fs.renameSync(tmp, abs);
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ ok: true, path: abs, bytes: buf.length }));
      } catch (e) {
        res.statusCode = 500;
        res.end(JSON.stringify({ error: String(e && e.message || e) }));
      }
    });
    return;
  }
  let pathname = parsed.pathname === '/' ? 'index.html' : parsed.pathname.replace(/^\/+/, '');
  const fp = path.join(__dirname, 'public', pathname);
  fs.readFile(fp, (err, data) => {
    if (err) {
      res.statusCode = 404;
      res.end('Not found');
      return;
    }
    const ext = path.extname(fp);
    const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
    res.setHeader('Content-Type', types[ext] || 'application/octet-stream');
    res.end(data);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Agent Monitor listening on http://localhost:${PORT}/`);
});
