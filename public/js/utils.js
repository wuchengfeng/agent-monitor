// Pure utility functions — no state dependencies

export function fmtTs(ts) {
  try {
    const d = new Date(typeof ts === 'number' ? ts : Date.parse(ts));
    const date = `${d.getMonth()+1}-${String(d.getDate()).padStart(2,'0')}`;
    return `${date} ${d.toLocaleTimeString()}`;
  } catch { return String(ts); }
}

export function fmtTimeHms(ts) {
  try {
    const d = new Date(typeof ts === 'number' ? ts : Date.parse(ts));
    return d.getHours().toString().padStart(2,'0')+':'+d.getMinutes().toString().padStart(2,'0')+':'+d.getSeconds().toString().padStart(2,'0');
  } catch { return '--:--:--'; }
}

export function escHtml(s) {
  return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

export function tryPrettyJson(s) {
  if (s == null) return '';
  if (typeof s === 'object') return JSON.stringify(s, null, 2);
  const str = String(s);
  try { return JSON.stringify(JSON.parse(str), null, 2); } catch { return str; }
}

export function extractTextFromFullContent(fullContent) {
  if (!fullContent || !Array.isArray(fullContent)) return '';
  return fullContent.filter(x => x && x.type === 'text' && typeof x.text === 'string').map(x => x.text).join('\n').trim();
}

export function extractToolCallsFromFullContent(fullContent) {
  if (!fullContent || !Array.isArray(fullContent)) return [];
  return fullContent.filter(x => x && x.type === 'toolCall').map(x => ({ id: x.id, name: x.name, arguments: x.arguments }));
}

export function buildAssistantOutputText(fullContent, textPreview) {
  const text = extractTextFromFullContent(fullContent) || String(textPreview || '').trim();
  const toolCalls = extractToolCallsFromFullContent(fullContent);
  if (!toolCalls.length) return text;
  const toolBlock = JSON.stringify(toolCalls, null, 2);
  return [text, text ? '' : '', 'toolCalls:', toolBlock].filter(Boolean).join('\n');
}

export async function writeClipboard(text) {
  const payload = String(text == null ? '' : text);
  if (!payload.trim()) return false;
  try { await navigator.clipboard.writeText(payload); return true; } catch {
    try {
      const ta = document.createElement('textarea');
      ta.value = payload; ta.style.position = 'fixed'; ta.style.left = '-9999px'; ta.style.top = '0';
      document.body.appendChild(ta); ta.focus(); ta.select();
      const ok = document.execCommand('copy'); document.body.removeChild(ta); return !!ok;
    } catch { return false; }
  }
}

export function displayAgentName(agentId) { return agentId || 'unknown'; }
export function makeKey(agentId, sessionId) { return `${agentId}:${sessionId}`; }
export function parseKey(key) {
  const idx = key.indexOf(':');
  if (idx === -1) return { agentId: 'main', sessionId: key };
  return { agentId: key.slice(0, idx), sessionId: key.slice(idx + 1) };
}

export function findNearestUserInput(interactions, botTs) {
  const target = new Date(botTs || 0).getTime();
  if (!Number.isFinite(target) || !Array.isArray(interactions)) return '';
  for (const it of interactions) {
    const t = new Date(it.ts || 0).getTime();
    if (!Number.isFinite(t)) continue;
    if (t <= target && it.role === 'user') {
      return String(extractTextFromFullContent(it.fullContent) || it.textPreview || it.content || '').trim();
    }
  }
  return '';
}

export function fmtCompact(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return '0';
  const ax = Math.abs(x);
  const sign = x < 0 ? '-' : '';
  if (ax >= 1e9) return sign + (ax / 1e9).toFixed(1).replace(/\.0$/,'') + 'B';
  if (ax >= 1e6) return sign + (ax / 1e6).toFixed(1).replace(/\.0$/,'') + 'M';
  if (ax >= 1e3) return sign + (ax / 1e3).toFixed(1).replace(/\.0$/,'') + 'K';
  return String(x);
}

export function modelFamily(model) {
  const m = String(model||'').toLowerCase();
  if (m.includes('claude') || m.includes('anthropic')) return 'anthropic';
  if (m.includes('gpt') || m.includes('openai')) return 'openai';
  if (m.includes('gemini') || m.includes('google')) return 'google';
  if (m.includes('qwen') || m.includes('aliyun') || m.includes('alibaba')) return 'qwen';
  if (m.includes('deepseek')) return 'deepseek';
  return 'other';
}

export function getContextWindow(model) {
  const m = String(model || '').toLowerCase();
  if (m.includes('claude-opus-4') || m.includes('claude-sonnet-4') || m.includes('claude-haiku-4')) return 1280000;
  if (m.includes('gemini-1.5') || m.includes('gemini-2')) return 1000000;
  if (m.includes('gpt-5') || m.includes('gpt-4o') || m.includes('gpt-4-turbo')) return 128000;
  if (m.includes('claude-3-5') || m.includes('claude-3.5')) return 200000;
  if (m.includes('claude-3')) return 200000;
  if (m.includes('deepseek')) return 128000;
  return 200000;
}

export function computeLatestTurnTiming(interactions) {
  const items = (interactions || []).slice().reverse();
  const msgs = items.filter(i => i && (i.role === 'user' || i.role === 'assistant' || i.role === 'toolResult'));
  let lastTurn = null, curTurn = null, prevTs = null;
  function tsMs(ts) { return typeof ts === 'number' ? ts : new Date(ts).getTime(); }
  for (const evt of msgs) {
    const evtMs = tsMs(evt.ts);
    if (evt.role === 'user') {
      if (curTurn && curTurn.phases.length) lastTurn = curTurn;
      curTurn = { llmMs: 0, toolMs: 0, totalMs: 0, phases: [] };
      prevTs = evtMs; curTurn._startTs = evtMs; continue;
    }
    if (!curTurn) { prevTs = evtMs; continue; }
    if (evt.role === 'assistant') {
      const dur = Math.max(0, evtMs - (prevTs || evtMs));
      curTurn.phases.push({ type: 'llm', durationMs: dur });
      curTurn.llmMs += dur;
      if (!evt.toolName) curTurn._endTs = evtMs;
      prevTs = evtMs;
    }
    if (evt.role === 'toolResult') {
      const dur = (evt.details && evt.details.durationMs) ? evt.details.durationMs : Math.max(0, evtMs - (prevTs || evtMs));
      curTurn.phases.push({ type: 'tool', durationMs: dur });
      curTurn.toolMs += dur;
      prevTs = evtMs;
    }
  }
  if (curTurn && curTurn.phases.length) lastTurn = curTurn;
  if (!lastTurn) return null;
  lastTurn.totalMs = lastTurn.llmMs + lastTurn.toolMs;
  return lastTurn;
}

export function fmtDurShort(ms) {
  if (ms < 1000) return ms + 'ms';
  if (ms < 60000) return (ms / 1000).toFixed(1) + 's';
  return (ms / 60000).toFixed(1) + 'min';
}

export function computeGridLayout(n, width) {
  const w = width || window.innerWidth || 1200;
  let cols = Math.floor(w / 420);
  cols = Math.max(1, Math.min(n || 1, cols || 1));
  return { cols };
}

export function applyGridLayoutTo(grid, n) {
  const { cols } = computeGridLayout(n, grid ? grid.clientWidth : undefined);
  if (grid) grid.style.gridTemplateColumns = `repeat(${cols}, minmax(0, 1fr))`;
}

export function agentTagClass(agentId) {
  const id = (agentId || '').toLowerCase();
  if (id === 'main') return 'agent-tag agent-tag-main';
  if (id === 'nanbosirui') return 'agent-tag agent-tag-nanbosirui';
  if (id === 'nanbosuikesi') return 'agent-tag agent-tag-nanbosuikesi';
  return 'agent-tag agent-tag-default';
}

export function hexToRgb(hex) {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return result ? `${parseInt(result[1],16)},${parseInt(result[2],16)},${parseInt(result[3],16)}` : '100,100,100';
}

export function formatCompactTokens(n) {
  if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(n);
}

export function channelIcon(channel) {
  const c = String(channel || '').toLowerCase();
  if (c === 'yach') return '🔵';
  if (c === 'feishu' || c === 'lark') return '🪶';
  if (c === 'telegram') return '✈';
  if (c === 'slack') return '💬';
  if (c === 'discord') return '🎮';
  if (c === 'wechat') return '💚';
  if (c === 'heartbeat') return '💓';
  if (c === 'openai') return '🤖';
  if (c === 'webchat') return '🌐';
  return '📡';
}

export function isSystemChannel(entry) {
  const ch = (entry.channel || '').toLowerCase();
  if (ch === 'heartbeat') return true;
  if (ch === 'openai' && (entry.senderId === 'unknown' || entry.chatType === 'unknown')) return true;
  if (ch === 'webchat' && (entry.senderId === 'unknown' || entry.chatType === 'unknown')) return true;
  return false;
}
