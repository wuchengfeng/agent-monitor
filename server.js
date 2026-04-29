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
// token 统计缓存：filePath -> { size, input, output }
// 文件大小不变时直接复用，避免每次全量重解析
const statsCache = new Map();

// --- LLM Capture ring buffer (in-memory) ---
const llmCaptures = [];          // ordered by capturedAt
const MAX_CAPTURES = 200;
const MAX_CAPTURE_BYTES = 50 * 1024 * 1024;
let captureIdCounter = 0;
let captureTotalBytes = 0;

// --- Bridge Event ring buffer (in-memory) ---
const bridgeEvents = [];
const MAX_BRIDGE_EVENTS = 500;
let bridgeEventIdCounter = 0;

const MONITOR_SETTINGS_FILE = path.join(BASE_ROOT, 'agent-monitor', 'monitor_settings.json');
const CHANNEL_NICKNAMES_FILE = path.join(BASE_ROOT, 'agent-monitor', 'channel_nicknames.json');

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
    const type = obj.type || null;
    const customType = obj.customType || null;
    const customData = obj.data || null;
    const m = obj.message || {};
    const role = m.role || null;
    const contentArr = Array.isArray(m.content) ? m.content : [];
    // 提取 toolCalls
    const toolCalls = contentArr.filter((c) => c && c.type === 'toolCall');

    // 提取 textPreview
    const texts = contentArr.filter((c) => c && c.type === 'text').map((t) => t.text).join(' ');
    const textPreview = texts || (typeof m.content === 'string' ? m.content : '');

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

    let errorMessage = m.errorMessage || obj.errorMessage || null;
    let provider = obj.provider || m.provider || null;
    let model = obj.model || m.model || null;

    // 从 custom 事件的 data 字段提取信息
    if (type === 'custom' && customData) {
      if (!provider) provider = customData.provider || null;
      if (!model) model = customData.modelId || customData.model || null;
      if (customType === 'openclaw:prompt-error' && !errorMessage) {
        errorMessage = customData.error || null;
      }
    }

    const stopReason = obj.stopReason || m.stopReason || null;
    const msgId = obj.id || m.id || null;
    const usage = m.usage || null;
    const api = m.api || null;
    // toolResult 特有字段
    const isError = m.isError || null;
    const details = m.details || null;
    // thinking_level_change 事件
    const thinkingLevel = obj.thinkingLevel || null;
    // session 事件
    const cwd = obj.cwd || null;

    // For detailed timeline: pass through the full content and specific tool result info
    const fullContent = contentArr;
    const resultToolName = m.toolName || null;
    const resultToolId = m.toolCallId || null;

    // --- Topology relationship extraction ---
    let sendTarget = null;
    let sendResult = null;
    let spawnTarget = null;
    let spawnResult = null;
    let provenance = null;

    // sessions_send tool call
    const sendCall = toolCalls.find(t => t.name === 'sessions_send');
    if (sendCall && sendCall.arguments) {
      sendTarget = {
        sessionKey: sendCall.arguments.sessionKey || null,
        messagePreview: safeMessageSlice(sendCall.arguments.message, 120),
        timeoutS: sendCall.arguments.timeoutSeconds || null,
      };
    }

    // sessions_spawn tool call
    const spawnCall = toolCalls.find(t => t.name === 'sessions_spawn');
    if (spawnCall && spawnCall.arguments) {
      spawnTarget = {
        task: safeMessageSlice(spawnCall.arguments.task, 200),
        mode: spawnCall.arguments.mode || null,
        timeoutS: spawnCall.arguments.runTimeoutSeconds || null,
      };
    }

    // sessions_send / sessions_spawn tool results
    if (resultToolName === 'sessions_send' || resultToolName === 'sessions_spawn') {
      const resultText = contentArr.filter(c => c && c.type === 'text').map(c => c.text).join('');
      try {
        const parsed = JSON.parse(resultText);
        if (resultToolName === 'sessions_send') {
          sendResult = {
            status: parsed.status || null,
            sessionKey: parsed.sessionKey || null,
            replyPreview: safeMessageSlice(parsed.reply, 120),
          };
        } else if (resultToolName === 'sessions_spawn') {
          spawnResult = {
            childSessionKey: parsed.childSessionKey || null,
            runId: parsed.runId || null,
            status: parsed.status || 'accepted',
          };
        }
      } catch {}
    }

    // provenance on incoming messages
    if (m.provenance && m.provenance.kind === 'inter_session') {
      provenance = {
        kind: m.provenance.kind,
        sourceSessionKey: m.provenance.sourceSessionKey || null,
        sourceTool: m.provenance.sourceTool || null,
        sourceChannel: m.provenance.sourceChannel || null,
      };
    }

    return {
      sessionId,
      agentId,
      ts,
      type,
      customType,
      customData,
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
      resultToolId,
      api,
      isError,
      details,
      thinkingLevel,
      cwd,
      sendTarget,
      sendResult,
      spawnTarget,
      spawnResult,
      provenance,
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
          // Broadcast topology-edge hint when relationship data detected
          if (event.sendTarget || event.sendResult || event.spawnTarget || event.spawnResult || event.provenance) {
            const topoHint = { type: 'topology-edge', agentId, sessionId, ts: event.ts };
            for (const c of clients) sendEvent(c, topoHint);
            // Invalidate topology cache
            topologyCache.builtAt = 0;
          }
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

// --- Topology Cache ---
let topologyCache = { agents: [], contacts: [], contactEdges: [], agentEdges: [], agentEdgeSessions: [], subagents: {}, systemSummary: {}, version: 0, builtAt: 0 };
const TOPOLOGY_TTL_MS = 5000;

function parseAgentFromKey(sessionKey) {
  if (!sessionKey || typeof sessionKey !== 'string') return null;
  const parts = sessionKey.split(':');
  if (parts[0] === 'agent' && parts.length >= 2) return parts[1];
  return null;
}

// 读取频道昵称
function loadChannelNicknames() {
  return readJson(CHANNEL_NICKNAMES_FILE) || {};
}

// 判断是否为系统/匿名 session（heartbeat、openai API、webchat 无发送者）
function classifySession(sessionKey, origin, dc) {
  const keyParts = sessionKey.split(':');
  const agentId = keyParts[1];
  // heartbeat: agent:xxx:main
  if (keyParts.length === 3 && keyParts[2] === 'main') return { type: 'system', subtype: 'heartbeat' };
  // subagent: agent:{agentId}:subagent:{uuid}
  if (keyParts.length >= 4 && keyParts[2] === 'subagent') return { type: 'subagent', subagentId: keyParts.slice(3).join(':') };
  // openai API sessions: agent:xxx:openai:<uuid>
  if (keyParts[2] === 'openai' && (!dc.chatType || dc.chatType === 'unknown')) return { type: 'system', subtype: 'openai-api' };
  // webchat with unknown sender
  if (keyParts[2] === 'webchat' && (!origin.from || origin.from === 'unknown')) return { type: 'system', subtype: 'webchat' };
  // group chat
  const groupIdx = keyParts.indexOf('group');
  if (dc.chatType === 'group' || (groupIdx >= 0 && groupIdx < keyParts.length - 1)) {
    let groupId = null;
    if (groupIdx >= 0 && groupIdx < keyParts.length - 1) {
      groupId = keyParts.slice(groupIdx + 1).join(':');
    }
    return { type: 'group', groupId: groupId || sessionKey };
  }
  // DM: extract sender id
  // 格式: agent:agentId:channel:deviceId:direct:senderId 或 agent:agentId:direct:senderId
  let senderId = null;
  if (keyParts.includes('direct')) {
    const directIdx = keyParts.indexOf('direct');
    if (directIdx < keyParts.length - 1) {
      senderId = keyParts.slice(directIdx + 1).join(':');
    }
  }
  if (!senderId) senderId = origin.from || dc.to || null;
  if (!senderId || senderId === 'unknown') return { type: 'system', subtype: 'unknown' };
  return { type: 'person', senderId };
}

function buildTopology() {
  const now = Date.now();
  if (now - topologyCache.builtAt < TOPOLOGY_TTL_MS) return topologyCache;

  const agentIds = listAgentIds();
  const nicknames = loadChannelNicknames();
  const agents = [];
  const contactMap = new Map();  // contactId -> { id, label, type, channel, sessions[] }
  const contactEdgeMap = new Map(); // "contactId:agentId" -> { contactId, agentId, channel, chatType, sessionIds[], tokens, isActive }
  const agentEdgeDedup = new Map();
  const agentEdgeInteractions = []; // [{sourceAgent, targetAgent, edgeType, sourceSessionId, targetSessionKey, messagePreview, ts, status}]
  const _targetSessionsCache = new Map(); // agentId -> sessions.json object (cached for perf)
  const systemCounts = { heartbeat: 0, 'openai-api': 0, webchat: 0, unknown: 0 };
  const subagentSessions = new Map(); // agentId -> [{id, key, isActive, tokens, label, parentSessionId}]

  for (const agentId of agentIds) {
    const dir = getAgentSessionsDir(agentId);
    const sessionsJsonPath = path.join(dir, 'sessions.json');
    const sessionsJson = readJson(sessionsJsonPath) || {};

    let agentTotalInput = 0, agentTotalOutput = 0;
    let activeSessions = [];

    for (const [sessionKey, meta] of Object.entries(sessionsJson)) {
      if (!meta || typeof meta !== 'object') continue;
      const sessionId = meta.sessionId || null;
      if (!sessionId) continue;

      const origin = meta.origin || {};
      const dc = meta.deliveryContext || {};
      const fp = path.join(dir, `${sessionId}.jsonl`);
      const isActive = fs.existsSync(fp);
      let lastActiveTs = null;
      if (isActive) { try { lastActiveTs = fs.statSync(fp).mtimeMs; } catch {} }
      const cached = statsCache.get(fp);
      const tokens = cached ? { input: cached.input, output: cached.output } : { input: 0, output: 0 };
      agentTotalInput += tokens.input;
      agentTotalOutput += tokens.output;
      if (isActive) activeSessions.push(sessionId);

      const keyParts = sessionKey.split(':');
      const channel = dc.channel || origin.surface || origin.provider || keyParts[2] || 'unknown';
      const classification = classifySession(sessionKey, origin, dc);

      if (classification.type === 'system') {
        systemCounts[classification.subtype] = (systemCounts[classification.subtype] || 0) + 1;
        continue;
      }

      // Subagent — collect for separate display
      if (classification.type === 'subagent') {
        if (!subagentSessions.has(agentId)) subagentSessions.set(agentId, []);
        let task = null;
        const fp2 = path.join(dir, `${sessionId}.jsonl`);
        try {
          if (fs.existsSync(fp2)) {
            const head = fs.readFileSync(fp2, 'utf8').slice(0, 8000);
            const firstLines = head.split('\n').slice(0, 10);
            for (const line of firstLines) {
              if (!line) continue;
              try {
                const obj = JSON.parse(line);
                const m = obj.message || {};
                if (obj.type === 'session' && obj.task) task = String(obj.task).slice(0, 120);
                if (m.role === 'user' && !task) {
                  const texts = (Array.isArray(m.content) ? m.content : []).filter(c => c && c.type === 'text').map(c => c.text).join(' ');
                  if (texts) {
                    const taskMatch = texts.match(/\[Subagent Task\]:?\s*([\s\S]*)/i);
                    task = (taskMatch ? taskMatch[1].trim() : texts).slice(0, 120);
                  }
                }
              } catch {}
            }
          }
        } catch {}
        subagentSessions.get(agentId).push({
          id: sessionId, key: sessionKey, isActive, lastActiveTs,
          tokens: { input: tokens.input, output: tokens.output },
          label: task || origin.label || sessionId.slice(0, 8),
          parentSessionId: null, // resolved below via spawn scan
        });
        continue;
      }

      // Person or Group — create/update contact node
      let contactId, contactLabel, contactType, contactChannel;
      if (classification.type === 'group') {
        contactId = `group:${classification.groupId}`;
        contactLabel = classification.groupId;
        // 截短群号
        if (contactLabel.length > 16) contactLabel = contactLabel.slice(0, 14) + '..';
        contactType = 'group';
        contactChannel = channel;
      } else {
        // person — 用 senderId 去重（同一个人可能通过不同设备 account 发消息）
        const sid = classification.senderId;
        contactId = `person:${sid}`;
        // 从 origin.label 或 nicknames 获取名字
        const nKey = `${channel}:direct:${sid}`;
        contactLabel = nicknames[nKey] || origin.label || sid;
        contactType = 'person';
        contactChannel = channel;
      }

      if (!contactMap.has(contactId)) {
        contactMap.set(contactId, { id: contactId, label: contactLabel, type: contactType, channel: contactChannel, sessionCount: 0 });
      }
      const contact = contactMap.get(contactId);
      contact.sessionCount++;
      // 更新 label 如果找到了更好的名字
      if (contactLabel !== classification.senderId && contactLabel !== classification.groupId) {
        contact.label = contactLabel;
      }

      // Contact → Agent edge
      const ceKey = `${contactId}:${agentId}`;
      if (!contactEdgeMap.has(ceKey)) {
        contactEdgeMap.set(ceKey, {
          contactId, agentId, channel, chatType: classification.type === 'group' ? 'group' : 'direct',
          sessions: [], tokens: { input: 0, output: 0 }, isActive: false,
        });
      }
      const ce = contactEdgeMap.get(ceKey);
      ce.sessions.push({
        id: sessionId,
        key: sessionKey,
        isActive,
        lastActiveTs,
        tokens: { input: tokens.input, output: tokens.output },
        label: origin.label || null,
      });
      ce.tokens.input += tokens.input;
      ce.tokens.output += tokens.output;
      if (isActive) ce.isActive = true;
    }

    agents.push({
      id: agentId,
      sessionCount: Object.keys(sessionsJson).length,
      activeSessionCount: activeSessions.length,
      totalTokens: { input: agentTotalInput, output: agentTotalOutput },
      status: activeSessions.length > 0 ? 'active' : 'idle',
    });

    // Scan active JSONL files for inter-agent edges (sessions_send/sessions_spawn)
    // pendingSends tracks send calls before their result arrives in the same session
    const pendingSends = new Map(); // `${sid}:${targetAgent}` -> interaction object
    for (const sid of activeSessions) {
      const fp = path.join(dir, `${sid}.jsonl`);
      try {
        const data = fs.readFileSync(fp, 'utf8');
        const lines = data.split('\n');
        for (const line of lines) {
          if (!line) continue;
          if (!line.includes('sessions_send') && !line.includes('sessions_spawn') && !line.includes('provenance')) continue;
          const ev = parseLine(line, sid, agentId);
          if (!ev) continue;
          if (ev.sendTarget && ev.sendTarget.sessionKey) {
            const targetAgent = parseAgentFromKey(ev.sendTarget.sessionKey);
            const edgeKey = `send:${agentId}:${targetAgent}`;
            agentEdgeDedup.set(edgeKey, {
              type: 'send', sourceAgent: agentId, targetAgent,
              meta: { messagePreview: ev.sendTarget.messagePreview, ts: ev.ts },
            });
            // Collect interaction with session IDs
            const interaction = {
              sourceAgent: agentId, targetAgent,
              edgeType: 'send',
              sourceSessionId: sid,
              targetSessionKey: ev.sendTarget.sessionKey,
              targetSessionId: null,
              messagePreview: ev.sendTarget.messagePreview,
              ts: ev.ts, status: null,
            };
            // Resolve target session ID from the target agent's sessions.json (cached)
            if (!_targetSessionsCache.has(targetAgent)) {
              _targetSessionsCache.set(targetAgent, readJson(path.join(getAgentSessionsDir(targetAgent), 'sessions.json')) || {});
            }
            const targetMeta = _targetSessionsCache.get(targetAgent)[ev.sendTarget.sessionKey];
            if (targetMeta && targetMeta.sessionId) {
              interaction.targetSessionId = targetMeta.sessionId;
            }
            agentEdgeInteractions.push(interaction);
            pendingSends.set(`${sid}:${targetAgent}`, interaction);
          }
          if (ev.sendResult && ev.sendResult.sessionKey) {
            const targetAgent = parseAgentFromKey(ev.sendResult.sessionKey);
            const rKey = `send:${agentId}:${targetAgent}`;
            const existing = agentEdgeDedup.get(rKey);
            if (existing) existing.meta.status = ev.sendResult.status;
            // Update pending interaction with status
            const pending = pendingSends.get(`${sid}:${targetAgent}`);
            if (pending) {
              pending.status = ev.sendResult.status;
              // Also resolve target session ID from result if not yet resolved
              if (!pending.targetSessionId) {
                if (!_targetSessionsCache.has(targetAgent)) {
                  _targetSessionsCache.set(targetAgent, readJson(path.join(getAgentSessionsDir(targetAgent), 'sessions.json')) || {});
                }
                const targetMeta2 = _targetSessionsCache.get(targetAgent)[ev.sendResult.sessionKey];
                if (targetMeta2 && targetMeta2.sessionId) pending.targetSessionId = targetMeta2.sessionId;
              }
            }
          }
          if (ev.spawnResult && ev.spawnResult.childSessionKey) {
            const childAgent = parseAgentFromKey(ev.spawnResult.childSessionKey);
            agentEdgeDedup.set(`spawn:${agentId}:${childAgent}`, {
              type: 'spawn', sourceAgent: agentId, targetAgent: childAgent || agentId,
              meta: { status: ev.spawnResult.status, ts: ev.ts },
            });
            // Map childSessionKey → parent sessionId for subagent display
            const childMeta = sessionsJson[ev.spawnResult.childSessionKey];
            if (childMeta && childMeta.sessionId) {
              const subs = subagentSessions.get(agentId);
              if (subs) {
                const sub = subs.find(s => s.id === childMeta.sessionId);
                if (sub) sub.parentSessionId = sid;
              }
            }
          }
          if (ev.provenance && ev.provenance.sourceSessionKey) {
            const srcAgent = parseAgentFromKey(ev.provenance.sourceSessionKey);
            const pType = ev.provenance.sourceTool === 'subagent_announce' ? 'spawn-result' : 'send-incoming';
            agentEdgeDedup.set(`${pType}:${srcAgent}:${agentId}`, {
              type: pType, sourceAgent: srcAgent, targetAgent: agentId,
              meta: { sourceTool: ev.provenance.sourceTool, ts: ev.ts },
            });
          }
        }
      } catch {}
    }
  }

  // Convert subagentSessions map to plain object
  const subagents = {};
  for (const [aid, subs] of subagentSessions) subagents[aid] = subs;

  // Build agentEdgeSessions from collected interactions
  const agentEdgeSessions = agentEdgeInteractions.map((inter, idx) => {
    let tokens = { input: 0, output: 0 };
    let isActive = false;
    let lastActiveTs = null;
    // Get token stats from source session
    const srcDir = getAgentSessionsDir(inter.sourceAgent);
    const srcFp = path.join(srcDir, `${inter.sourceSessionId}.jsonl`);
    const srcCached = statsCache.get(srcFp);
    if (srcCached) { tokens = { input: srcCached.input, output: srcCached.output }; }
    try {
      isActive = fs.existsSync(srcFp);
      if (isActive) { lastActiveTs = fs.statSync(srcFp).mtimeMs; }
    } catch {}
    return {
      id: `ae-${inter.sourceAgent}-${inter.targetAgent}-${idx}`,
      sourceAgent: inter.sourceAgent,
      targetAgent: inter.targetAgent,
      edgeType: inter.edgeType,
      sourceSessionId: inter.sourceSessionId,
      targetSessionId: inter.targetSessionId,
      targetSessionKey: inter.targetSessionKey,
      messagePreview: inter.messagePreview,
      ts: inter.ts,
      status: inter.status,
      tokens,
      isActive,
      lastActiveTs,
    };
  });

  topologyCache = {
    agents,
    contacts: [...contactMap.values()],
    contactEdges: [...contactEdgeMap.values()],
    agentEdges: [...agentEdgeDedup.values()],
    agentEdgeSessions,
    subagents,
    systemSummary: systemCounts,
    version: topologyCache.version + 1,
    builtAt: now,
  };
  return topologyCache;
}

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
          fs.stat(fp, (statErr, st) => {
            const fileSize = statErr ? -1 : st.size;
            const cached = statsCache.get(fp);
            if (cached && cached.size === fileSize) {
              // 文件大小未变，直接复用缓存的 token 统计和尾部行
              const sessionId = path.basename(fp, '.jsonl');
              outStats[agentId][sessionId] = { input: cached.input, output: cached.output };
              for (const ev of cached.tail) outItems.push(ev);
              if (--pendingFiles === 0) {
                if (--pendingAgents === 0) finalize();
              }
              return;
            }
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
                const tailLines = allLines.slice(-maxLinesPerFile);
                const tailEvents = tailLines.map(l => parseLine(l, sessionId, agentId)).filter(Boolean);
                statsCache.set(fp, { size: fileSize, input: totalInput, output: totalOutput, tail: tailEvents });
                for (const ev of tailEvents) outItems.push(ev);
              }
              if (--pendingFiles === 0) {
                if (--pendingAgents === 0) finalize();
              }
            });
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

function computeTimingChain(items, recentTurns) {
  // Only process message events, sorted chronologically
  const messages = items.filter(e => e.type === 'message').sort((a, b) => {
    const ta = typeof a.ts === 'number' ? a.ts : new Date(a.ts).getTime();
    const tb = typeof b.ts === 'number' ? b.ts : new Date(b.ts).getTime();
    return ta - tb;
  });

  const turns = [];
  let currentTurn = null;
  let prevTs = null;

  function tsMs(ts) {
    if (typeof ts === 'number') return ts > 1e12 ? ts : ts; // already ms
    return new Date(ts).getTime();
  }

  for (const evt of messages) {
    const evtMs = tsMs(evt.ts);

    if (evt.role === 'user') {
      if (currentTurn && currentTurn.phases.length) turns.push(currentTurn);
      currentTurn = {
        turnIndex: turns.length,
        startTs: evtMs,
        endTs: null,
        phases: [],
        llmMs: 0,
        toolMs: 0,
        userPreview: safeMessageSlice(evt.textPreview, 120),
        assistantPreview: '',
      };
      prevTs = evtMs;
      continue;
    }

    if (!currentTurn) {
      prevTs = evtMs;
      continue;
    }

    if (evt.role === 'assistant') {
      const llmDur = Math.max(0, evtMs - (prevTs || evtMs));
      currentTurn.phases.push({
        type: 'llm',
        durationMs: llmDur,
        startTs: prevTs,
        endTs: evtMs,
        model: evt.model || null,
        provider: evt.provider || null,
        inputTokens: evt.usage ? (evt.usage.input || 0) : 0,
        outputTokens: evt.usage ? (evt.usage.output || 0) : 0,
        hasToolCalls: !!evt.toolName,
        stopReason: evt.stopReason || null,
      });
      currentTurn.llmMs += llmDur;
      if (!evt.toolName) {
        currentTurn.endTs = evtMs;
        currentTurn.assistantPreview = safeMessageSlice(evt.textPreview, 120);
      }
      prevTs = evtMs;
    }

    if (evt.role === 'toolResult') {
      const toolDur = (evt.details && evt.details.durationMs) ? evt.details.durationMs : Math.max(0, evtMs - (prevTs || evtMs));
      currentTurn.phases.push({
        type: 'tool',
        name: evt.resultToolName || 'tool',
        durationMs: toolDur,
        startTs: prevTs,
        endTs: evtMs,
        status: evt.details ? evt.details.status : null,
        isError: evt.isError || false,
      });
      currentTurn.toolMs += toolDur;
      prevTs = evtMs;
    }
  }

  if (currentTurn && currentTurn.phases.length) turns.push(currentTurn);

  // Compute totalMs per turn
  for (const turn of turns) {
    if (!turn.endTs) turn.endTs = turn.phases.length ? turn.phases[turn.phases.length - 1].endTs : turn.startTs;
    turn.totalMs = turn.endTs - turn.startTs;
    turn.overheadMs = Math.max(0, turn.totalMs - turn.llmMs - turn.toolMs);
  }

  // Limit to recent turns if requested
  const limited = recentTurns && recentTurns > 0 ? turns.slice(-recentTurns) : turns;

  // Compute summary
  let totalMs = 0, totalLlmMs = 0, totalToolMs = 0;
  let longestLlm = null, longestTool = null;
  let llmCount = 0, toolCount = 0;
  for (const turn of limited) {
    totalMs += turn.totalMs;
    totalLlmMs += turn.llmMs;
    totalToolMs += turn.toolMs;
    for (const p of turn.phases) {
      if (p.type === 'llm') {
        llmCount++;
        if (!longestLlm || p.durationMs > longestLlm.durationMs) longestLlm = { ...p, turnIndex: turn.turnIndex };
      } else {
        toolCount++;
        if (!longestTool || p.durationMs > longestTool.durationMs) longestTool = { ...p, turnIndex: turn.turnIndex };
      }
    }
  }

  return {
    turns: limited,
    summary: {
      totalTurns: limited.length,
      totalMs,
      totalLlmMs,
      totalToolMs,
      avgLlmMs: llmCount ? Math.round(totalLlmMs / llmCount) : 0,
      avgToolMs: toolCount ? Math.round(totalToolMs / toolCount) : 0,
      llmCalls: llmCount,
      toolCalls: toolCount,
      longestLlm,
      longestTool,
    },
  };
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
    const dir = getAgentSessionsDir(agentId);
    // Remove from sessions.json so framework creates a fresh session on next message
    let removedKey = null;
    try {
      const sjPath = path.join(dir, 'sessions.json');
      const raw = fs.readFileSync(sjPath, 'utf8');
      const meta = JSON.parse(raw);
      for (const [key, val] of Object.entries(meta)) {
        if (val && val.sessionId === sessionId) { removedKey = key; delete meta[key]; break; }
      }
      if (removedKey) fs.writeFileSync(sjPath, JSON.stringify(meta, null, 2));
    } catch {}
    const src = sessionActivePath(sessionId, agentId);
    const dst = path.join(dir, `${sessionId}.jsonl.deleted.${new Date().toISOString().replace(/[:.]/g, '-')}`);
    if (!fs.existsSync(src)) {
      topologyCache.builtAt = 0;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok: true, sessionId, agentId, removedKey, note: 'file already absent' }));
      return;
    }
    fs.rename(src, dst, (err) => {
      if (err) {
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: String(err && err.message || err) }));
        return;
      }
      topologyCache.builtAt = 0;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok: true, sessionId, agentId, removedKey, deletedPath: dst }));
    });
    return;
  }
  if (parsed.pathname === '/session-reset' && req.method === 'POST') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    const sessionId = parsed.query && parsed.query.sid ? String(parsed.query.sid) : '';
    const agentId = parsed.query && parsed.query.agent ? String(parsed.query.agent) : defaultAgentId;
    if (!isValidSessionId(sessionId)) {
      res.statusCode = 400;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'invalid sid' }));
      return;
    }
    const dir = getAgentSessionsDir(agentId);
    const src = path.join(dir, `${sessionId}.jsonl`);
    const tag = new Date().toISOString().replace(/[:.]/g, '-');
    const dst = path.join(dir, `${sessionId}.jsonl.reset.${tag}`);
    const sessionsJsonPath = path.join(dir, 'sessions.json');
    let removedKey = null;
    try {
      const raw = fs.readFileSync(sessionsJsonPath, 'utf8');
      const meta = JSON.parse(raw);
      for (const [key, val] of Object.entries(meta)) {
        if (val && val.sessionId === sessionId) {
          removedKey = key;
          delete meta[key];
          break;
        }
      }
      if (removedKey) fs.writeFileSync(sessionsJsonPath, JSON.stringify(meta, null, 2));
    } catch {}
    if (fs.existsSync(src)) {
      try { fs.renameSync(src, dst); } catch {}
    }
    topologyCache.builtAt = 0;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: true, sessionId, agentId, removedKey, resetPath: dst }));
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
  if (parsed.pathname === '/api/channel-nicknames') {
    if (req.method === 'GET') {
      const nicknames = readJson(CHANNEL_NICKNAMES_FILE) || {};
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify(nicknames));
      return;
    }
    if (req.method === 'POST') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        try {
          const { key, nickname } = JSON.parse(body);
          if (typeof key !== 'string' || !key) throw new Error('missing key');
          const nicknames = readJson(CHANNEL_NICKNAMES_FILE) || {};
          if (nickname == null || String(nickname).trim() === '') {
            delete nicknames[key];
          } else {
            nicknames[key] = String(nickname).trim();
          }
          if (!writeJson(CHANNEL_NICKNAMES_FILE, nicknames)) throw new Error('write failed');
          res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
          res.end(JSON.stringify({ ok: true, nicknames }));
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

  if (parsed.pathname === '/api/channels') {
    // 读取各 agent 的 sessions.json，解析通道/发送者元数据
    const agentIds = listAgentIds();
    const channels = [];
    for (const agentId of agentIds) {
      const sessionsJsonPath = path.join(getAgentSessionsDir(agentId), 'sessions.json');
      const sessionsJson = readJson(sessionsJsonPath);
      if (!sessionsJson || typeof sessionsJson !== 'object') continue;
      for (const [sessionKey, meta] of Object.entries(sessionsJson)) {
        if (!meta || typeof meta !== 'object') continue;
        const sessionId = meta.sessionId || null;
        const updatedAt = meta.updatedAt || null;
        const origin = meta.origin || {};
        const deliveryContext = meta.deliveryContext || {};
        // 从 key 解析通道信息: agent:{agentId}:{channel}:{chatType}:{senderId}
        let channel = null, chatType = null, senderId = null;
        const keyParts = sessionKey.split(':');
        // keyParts[0]="agent", keyParts[1]=agentId, keyParts[2]=channel, keyParts[3]=chatType, keyParts[4..]=senderId
        if (keyParts.length >= 5) {
          channel = keyParts[2];
          chatType = keyParts[3];
          senderId = keyParts.slice(4).join(':');
        } else {
          // agent:main:main 或类似格式
          channel = origin.surface || origin.provider || deliveryContext.channel || keyParts[2] || null;
          chatType = origin.chatType || deliveryContext.chatType || null;
          const rawFrom = origin.from || deliveryContext.to || null;
          senderId = rawFrom ? rawFrom.replace(/^[a-z]+:/, '') : null;
        }
        const accountId = deliveryContext.accountId || origin.accountId || null;
        const senderLabel = origin.label || senderId || null;
        channels.push({
          agentId,
          sessionKey,
          sessionId,
          channel: channel || 'unknown',
          chatType: chatType || 'unknown',
          senderId: senderId || 'unknown',
          senderLabel: senderLabel || senderId || 'unknown',
          accountId,
          updatedAt,
        });
      }
    }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ channels }));
    return;
  }

  if (parsed.pathname === '/api/topology') {
    const topo = buildTopology();
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(topo));
    return;
  }

  if (parsed.pathname === '/api/session-history') {
    const sessionId = parsed.query && parsed.query.sid ? String(parsed.query.sid) : '';
    const agentId = parsed.query && parsed.query.agent ? String(parsed.query.agent) : defaultAgentId;
    if (!isValidSessionId(sessionId)) {
      res.statusCode = 400;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'invalid sid' }));
      return;
    }
    const maxLines = parsed.query && parsed.query.limit ? parseInt(parsed.query.limit, 10) : 500;
    const out = await collectSessionHistory(sessionId, agentId, Math.min(maxLines, 5000));
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ sessionId, agentId, items: out.items, source: out.source }));
    return;
  }

  if (parsed.pathname === '/api/session-timing') {
    const sessionId = parsed.query && parsed.query.sid ? String(parsed.query.sid) : '';
    const agentId = parsed.query && parsed.query.agent ? String(parsed.query.agent) : defaultAgentId;
    if (!isValidSessionId(sessionId)) {
      res.statusCode = 400;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'invalid sid' }));
      return;
    }
    const recentTurns = parsed.query && parsed.query.recentTurns ? parseInt(parsed.query.recentTurns, 10) : 0;
    const out = await collectSessionHistory(sessionId, agentId, 20000);
    const timing = computeTimingChain(out.items, recentTurns);
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ sessionId, agentId, ...timing }));
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
  // --- LLM Capture API ---
  if (parsed.pathname === '/api/llm-capture' && req.method === 'POST') {
    let body = '';
    req.on('data', c => { if (body.length < 5 * 1024 * 1024) body += c; });
    req.on('end', () => {
      try {
        const capture = JSON.parse(body);
        capture._id = ++captureIdCounter;
        const size = Buffer.byteLength(body, 'utf8');
        capture._size = size;

        // Evict oldest if over limits
        while (llmCaptures.length >= MAX_CAPTURES || (captureTotalBytes + size > MAX_CAPTURE_BYTES && llmCaptures.length > 0)) {
          const evicted = llmCaptures.shift();
          captureTotalBytes -= (evicted._size || 0);
        }
        llmCaptures.push(capture);
        captureTotalBytes += size;

        // SSE broadcast lightweight notification
        const notify = {
          type: 'llm-capture',
          captureId: capture._id,
          capturedAt: capture.capturedAt,
          model: capture.model,
          messageCount: capture.messageCount,
          toolCount: capture.toolCount,
          durationMs: capture.durationMs,
          requestSize: capture.requestSize,
          responseSize: capture.responseSize,
        };
        for (const c of clients) sendEvent(c, notify);

        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.end(JSON.stringify({ ok: true, id: capture._id }));
      } catch (e) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: String(e.message || e) }));
      }
    });
    return;
  }

  if (parsed.pathname === '/api/llm-captures' && req.method === 'GET') {
    const since = parsed.query.since ? new Date(parsed.query.since).getTime() : 0;
    const limit = Math.min(parseInt(parsed.query.limit) || 100, 500);
    const summaries = [];
    for (let i = llmCaptures.length - 1; i >= 0 && summaries.length < limit; i--) {
      const c = llmCaptures[i];
      if (since && new Date(c.capturedAt).getTime() <= since) continue;
      summaries.push({
        _id: c._id,
        capturedAt: c.capturedAt,
        requestStartedAt: c.requestStartedAt,
        durationMs: c.durationMs,
        model: c.model,
        messageCount: c.messageCount,
        toolCount: c.toolCount,
        requestSize: c.requestSize,
        responseSize: c.responseSize,
      });
    }
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.end(JSON.stringify(summaries));
    return;
  }

  // GET /api/llm-capture/:id
  const captureMatch = parsed.pathname.match(/^\/api\/llm-capture\/(\d+)$/);
  if (captureMatch && req.method === 'GET') {
    const id = parseInt(captureMatch[1]);
    const found = llmCaptures.find(c => c._id === id);
    if (!found) {
      res.statusCode = 404;
      res.end(JSON.stringify({ error: 'Capture not found' }));
      return;
    }
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.end(JSON.stringify(found));
    return;
  }

  // --- Bridge Event API ---
  if (parsed.pathname === '/api/bridge-event' && req.method === 'POST') {
    let body = '';
    req.on('data', c => { if (body.length < 512 * 1024) body += c; });
    req.on('end', () => {
      try {
        const ev = JSON.parse(body);
        ev._id = ++bridgeEventIdCounter;
        while (bridgeEvents.length >= MAX_BRIDGE_EVENTS) bridgeEvents.shift();
        bridgeEvents.push(ev);
        // SSE broadcast
        const notify = { type: 'bridge-event', ...ev };
        for (const c of clients) sendEvent(c, notify);
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.end(JSON.stringify({ ok: true, id: ev._id }));
      } catch (e) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: String(e.message || e) }));
      }
    });
    return;
  }

  if (parsed.pathname === '/api/bridge-events' && req.method === 'GET') {
    const limit = Math.min(parseInt(parsed.query.limit) || 200, 500);
    const filterSession = parsed.query.sessionId || null;
    const results = [];
    for (let i = bridgeEvents.length - 1; i >= 0 && results.length < limit; i--) {
      if (filterSession && bridgeEvents[i].sessionId !== filterSession) continue;
      results.push(bridgeEvents[i]);
    }
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.end(JSON.stringify(results));
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
