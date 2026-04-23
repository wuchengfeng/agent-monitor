import {
  state, archived, showArchived, expandedSessions,
  topologyViewActive, channelViewActive, editingNicknameKey,
  deletedCache, _renderScheduled, set_renderScheduled, saveArchived,
} from './state.js';
import {
  escHtml, fmtTs, fmtCompact, displayAgentName, makeKey, parseKey,
  applyGridLayoutTo, getContextWindow,
} from './utils.js';
import { renderStepPane, renderApiPane, getCurrentStepLabel } from './sessions.js';
import { renderTopologyView } from './topology.js';

let _renderChannels = null;
async function getRenderChannels() {
  if (!_renderChannels) {
    const mod = await import('./channels.js');
    _renderChannels = mod.renderChannels;
  }
  return _renderChannels;
}

export function render() {
  if (_renderScheduled) return;
  set_renderScheduled(true);
  requestAnimationFrame(() => {
    set_renderScheduled(false);
    _doRender();
  });
}

function _doRender() {
  if (topologyViewActive) {
    renderTopologyView();
    return;
  }
  if (channelViewActive) {
    if (editingNicknameKey) return;
    getRenderChannels().then(fn => fn());
    return;
  }
  const grid = document.getElementById('grid');
  const scrollMap = new Map();
  grid.querySelectorAll('[data-scroll-id]').forEach(el => {
    scrollMap.set(el.dataset.scrollId, el.scrollTop);
  });
  grid.innerHTML = '';
  const btnToggle = document.getElementById('btn-toggle-archived');
  if (btnToggle) btnToggle.textContent = showArchived ? '隐藏归档' : `显示归档 (${archived.size})`;
  const btnDeleted = document.getElementById('btn-toggle-deleted');
  if (btnDeleted) {
    const n = deletedCache && deletedCache.length ? deletedCache.length : 0;
    btnDeleted.textContent = `已删除 (${n})`;
  }

  const groups = new Map();
  for (const [key, s] of state.entries()) {
    const agentId = s.agentId || 'main';
    if (!groups.has(agentId)) groups.set(agentId, []);
    groups.get(agentId).push([key, s]);
  }
  const agentIds = [...groups.keys()].sort();
  const activeSet = expandedSessions.size ? new Set(expandedSessions) : null;
  if (!agentIds.length) {
    grid.innerHTML = '<div class="mono">暂无 session</div>';
    return;
  }
  agentIds.forEach((agentId) => {
    const allItems = groups.get(agentId) || [];
    const sorted = allItems.sort((a, b) => {
      const tsA = new Date(a[1].lastTs || 0).getTime();
      const tsB = new Date(b[1].lastTs || 0).getTime();
      if (tsB !== tsA) return tsB - tsA;
      return (b[1].bumpTs || 0) - (a[1].bumpTs || 0);
    });
    const items = sorted.filter(([key]) => showArchived ? true : !archived.has(key));
    const visibleItems = activeSet ? items.filter(([key]) => activeSet.has(key)) : items;
    const block = document.createElement('div');
    block.className = 'agent-block';
    const count = visibleItems.length;
    block.innerHTML = `
      <div class="agent-head">
        <div class="badge">Agent</div>
        <div class="mono">${escHtml(displayAgentName(agentId))}</div>
        <div class="badge">Sessions</div>
        <div class="mono">${count}</div>
      </div>
    `;
    const agentGrid = document.createElement('div');
    agentGrid.className = 'agent-grid';
    if (expandedSessions.size === 1) {
      agentGrid.style.gridTemplateColumns = 'minmax(0, 1fr)';
    } else {
      applyGridLayoutTo(agentGrid, Math.max(1, count));
    }
    visibleItems.forEach(([key, s], idx) => {
      const { sessionId } = parseKey(key);
      const isArchived = archived.has(key);
      const isPrimary = !isArchived && idx === 0;
      const now = Date.now();
      const isHighlight = s.updatedAt && (now - s.updatedAt < 3000);
      const isExpanded = expandedSessions.has(key);
      const isFullscreen = expandedSessions.size === 1 && isExpanded;
      const el = document.createElement('div');
      el.className = 'card' + (isPrimary ? ' primary' : '') + (isHighlight ? ' highlight' : '') + (isFullscreen ? ' fullscreen' : '');
      if (isArchived) el.style.opacity = '0.6';
      el.innerHTML = `
        <div class="row">
          <div class="badge">Session</div>
          <div class="mono">${escHtml(sessionId)}</div>
          <button class="btn-link" onclick="openHistory('${key}')">历史</button>
          <button class="btn-copy" onclick="copySessionDetail('${key}')">复制</button>
          <button class="btn-danger" onclick="softDeleteSession('${key}')">删除</button>
          <button class="btn-link" onclick="toggleDetails('${key}')">${isExpanded ? '取消激活' : '激活'}</button>
          <button class="btn-archive" onclick="toggleArchive('${key}')">${isArchived ? '取消归档' : '归档'}</button>
        </div>
        <div class="row" style="margin-top:6px">
          <div class="badge">${escHtml(s.role||'n/a')}</div>
          <div class="badge">${escHtml(s.provider||'provider')}</div>
          <div class="badge">${escHtml(s.model||'model')}</div>
          <div class="badge" title="Total Tokens: ${(s.totalTokens?.input||0).toLocaleString()}/${(s.totalTokens?.output||0).toLocaleString()}">${fmtCompact((s.totalTokens?.input||0) + (s.totalTokens?.output||0))} (${fmtCompact(s.totalTokens?.input||0)}/${fmtCompact(s.totalTokens?.output||0)})</div>
          <div class="ts">${fmtTs(s.ts)}</div>
        </div>
        <div class="row" style="margin-top:6px">
          <div class="badge">最近一步</div>
          <div class="title">${escHtml(getCurrentStepLabel(s))}</div>
        </div>
        ${s.toolArgs ? `<div class="mono" style="margin-top:6px;max-height:100px;overflow:auto">${JSON.stringify(s.toolArgs)}</div>` : ''}
        ${s.errorMessage ? `<div class="mono" style="margin-top:6px;color:#ffb4b4;max-height:100px;overflow:auto">错误: ${s.errorMessage}</div>` : ''}
        <div class="card-body">
          ${renderStepPane(key, s.interactions || [], isFullscreen)}
          ${renderApiPane(key, s.interactions || [], isFullscreen)}
        </div>
      `;
      agentGrid.appendChild(el);
    });
    block.appendChild(agentGrid);
    grid.appendChild(block);
  });
  grid.querySelectorAll('[data-scroll-id]').forEach(el => {
    const saved = scrollMap.get(el.dataset.scrollId);
    if (saved !== undefined) el.scrollTop = saved;
  });
}

export function upsert(e, isSnapshot = false) {
  const agentId = e.agentId || 'main';
  const sessionId = e.sessionId || 'unknown';
  const k = makeKey(agentId, sessionId);
  const now = Date.now();
  const prev = state.get(k) || { interactions: [] };

  const newTs = new Date(e.ts).getTime();
  const oldTs = prev.lastTs ? new Date(prev.lastTs).getTime() : 0;

  if (!isSnapshot && archived.has(k) && oldTs > 0 && newTs > oldTs) {
    archived.delete(k);
    saveArchived();
  }

  let interactions = prev.interactions ? [...prev.interactions] : [];

  let iType = 'Info';
  let iContent = '';

  const isToolResult = e.role === 'toolResult' || e.resultToolName || e.resultToolId;
  const text = e.textPreview || '';

  if (e.type === 'thinking_level_change') {
    iType = 'ThinkingChange';
    iContent = `thinking: ${e.thinkingLevel || 'unknown'}`;
  } else if (e.type === 'session') {
    iType = 'Session';
    iContent = `cwd: ${e.cwd || 'unknown'}`;
  } else if (e.type === 'custom' && e.customType === 'model-snapshot') {
    iType = 'ModelSwitch';
    iContent = `${e.provider || ''}/${e.model || ''}`;
  } else if (e.type === 'custom' && e.customType === 'openclaw:prompt-error') {
    iType = 'Error';
    iContent = `Error: ${e.errorMessage || 'unknown'}`;
  } else if (e.toolName) {
    iType = 'ToolCall';
    iContent = `Call: ${e.toolName}`;
  } else if (isToolResult) {
    iType = 'ToolResult';
    iContent = `Result: ${e.resultToolName || e.resultToolId || 'tool'}`;
  } else if (e.role === 'user') {
    iType = 'User';
    iContent = text || 'User Input';
  } else if (e.role === 'assistant') {
    iType = 'Bot';
    iContent = text || (e.stopReason ? `Stop: ${e.stopReason}` : 'Response');
  } else if (e.role === 'system') {
    iType = 'System';
    iContent = 'System Instruction';
  } else if (text) {
    iType = 'Info';
    iContent = text;
  }

  const fingerprint = `${e.ts}_${iType}_${iContent}`;
  const exists = interactions.some(item => `${item.ts}_${item.type}_${item.content}` === fingerprint);

  if (!exists && iContent) {
    interactions.push({
      ts: e.ts, type: iType, content: iContent, model: e.model, usage: e.usage,
      role: e.role, provider: e.provider, toolName: e.toolName, toolArgs: e.toolArgs,
      resultToolName: e.resultToolName, resultToolId: e.resultToolId,
      stopReason: e.stopReason, errorMessage: e.errorMessage, msgId: e.msgId,
      textPreview: text, fullContent: e.fullContent, api: e.api,
      isError: e.isError, details: e.details, thinkingLevel: e.thinkingLevel, cwd: e.cwd,
    });
    interactions.sort((a, b) => new Date(b.ts).getTime() - new Date(a.ts).getTime());
    if (interactions.length > 50) interactions = interactions.slice(0, 50);
  }

  const localTokens = interactions.reduce((acc, curr) => {
    if (curr.usage) {
      acc.input += (curr.usage.input || 0);
      acc.output += (curr.usage.output || 0);
    }
    return acc;
  }, { input: 0, output: 0 });

  const finalTokens = prev.serverTotalTokens || localTokens;

  state.set(k, { ...prev, ...e, agentId, sessionId, lastTs: e.ts, bumpTs: isSnapshot ? (prev.bumpTs || now) : now, updatedAt: isSnapshot ? (prev.updatedAt || now) : now, interactions, totalTokens: finalTokens });
  render();
}

export async function pollSnapshot() {
  try {
    const r = await fetch('/snapshot', { cache: 'no-store' });
    if (!r.ok) return;
    const j = await r.json();
    if (Array.isArray(j.items)) {
      for (const e of j.items) {
        upsert(e, true);
      }

      if (j.stats) {
        let changed = false;
        for (const [agentId, sessions] of Object.entries(j.stats)) {
          for (const [sid, stat] of Object.entries(sessions || {})) {
            const key = makeKey(agentId, sid);
            const s = state.get(key);
            if (s) {
              state.set(key, { ...s, serverTotalTokens: stat, totalTokens: stat });
              changed = true;
            }
          }
        }
        if (changed) render();
      }

      if (j.activeByAgent) {
        const activeSet = new Set();
        for (const [agentId, sessions] of Object.entries(j.activeByAgent)) {
          for (const sid of sessions || []) {
            activeSet.add(makeKey(agentId, sid));
          }
        }
        let pruned = false;
        for (const key of [...state.keys()]) {
          if (!activeSet.has(key)) {
            state.delete(key);
            archived.delete(key);
            expandedSessions.delete(key);
            pruned = true;
          }
        }
        if (pruned) {
          saveArchived();
          render();
        }
      }
    }
  } catch {}
}
