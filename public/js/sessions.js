import { state, archived, showArchived, setShowArchived, expandedSessions,
  selectedStepIndexBySession, selectedApiIndexBySession, deletedPanelOpen, setDeletedPanelOpen,
  deletedCache, setDeletedCache, deletedCacheAt, setDeletedCacheAt, saveArchived,
  autoDeleteSettingsCache, setAutoDeleteSettingsCache } from './state.js';
import { fmtTs, fmtTimeHms, escHtml, tryPrettyJson, extractTextFromFullContent,
  extractToolCallsFromFullContent, buildAssistantOutputText, writeClipboard,
  displayAgentName, makeKey, parseKey, findNearestUserInput, fmtCompact, modelFamily,
  getContextWindow, computeLatestTurnTiming, fmtDurShort } from './utils.js';
import { render, pollSnapshot } from './render.js';

// --- Archive / Toggle ---
export function toggleArchive(key) {
  if (archived.has(key)) archived.delete(key); else archived.add(key);
  saveArchived(); render();
}

export function toggleDetails(key) {
  if (expandedSessions.has(key)) expandedSessions.delete(key); else expandedSessions.add(key);
  render();
}

export function toggleShowArchived() {
  setShowArchived(!showArchived);
  render();
}

// --- Copy helpers ---
export function buildSessionCopyText(key, extra = {}) {
  const s = state.get(key) || {};
  const { agentId, sessionId } = parseKey(key);
  const interactions = Array.isArray(s.interactions) ? s.interactions : [];
  const last = interactions.slice(0, 20).map((it) => {
    const t = fmtTs(it.ts);
    const type = it.type || '-';
    const model = it.model ? ` ${it.model}` : '';
    const text = String(extractTextFromFullContent(it.fullContent) || it.textPreview || it.content || '').trim();
    return `- [${t}] ${type}${model}\n${text ? text : '-'}`;
  }).join('\n\n');
  const currentMsg = String((extractTextFromFullContent(s.fullContent) || s.textPreview || '')).trim();
  const toolArgs = s.toolArgs != null ? tryPrettyJson(s.toolArgs) : '';
  const header = [
    `agentId: ${displayAgentName(agentId)}`, `sessionId: ${sessionId}`,
    s.ts ? `ts: ${fmtTs(s.ts)}` : '', s.updatedAt ? `updatedAt: ${fmtTs(s.updatedAt)}` : '',
    s.role ? `role: ${s.role}` : '', s.provider ? `provider: ${s.provider}` : '',
    s.model ? `model: ${s.model}` : '', s.stopReason ? `stopReason: ${s.stopReason}` : '',
    s.toolName ? `toolName: ${s.toolName}` : '', s.errorMessage ? `error: ${s.errorMessage}` : '',
  ].filter(Boolean).join('\n');
  return [
    header,
    toolArgs ? `\n---\ntoolArgs:\n${toolArgs}` : '',
    currentMsg ? `\n---\ncurrentMessage:\n${currentMsg}` : '',
    last ? `\n---\nrecentInteractions:\n${last}` : '',
    extra && extra.text ? `\n---\n${extra.title || 'extra'}:\n${extra.text}` : '',
  ].filter(Boolean).join('\n');
}

export async function copySessionDetail(key) {
  const ok = await writeClipboard(buildSessionCopyText(key));
  if (!ok) alert('复制失败：浏览器未授予剪贴板权限');
}

export async function copyStepDetail(key) {
  const s = state.get(key) || {};
  const currentStep = getCurrentStepLabel(s);
  const currentMsg = String((extractTextFromFullContent(s.fullContent) || s.textPreview || '')).trim();
  const extra = { title: 'step', text: [`currentStep: ${currentStep}`, currentMsg ? `message:\n${currentMsg}` : 'message: -'].join('\n') };
  const ok = await writeClipboard(buildSessionCopyText(key, extra));
  if (!ok) alert('复制失败：浏览器未授予剪贴板权限');
}

export async function copyApiDetail(key) {
  const s = state.get(key) || {};
  const all = Array.isArray(s.interactions) ? s.interactions : [];
  const apiOnly = all.filter(i => i && i.role === 'assistant' && i.model);
  const view = apiOnly.slice(0, 50);
  const sel = Math.min(Math.max(0, Number(selectedApiIndexBySession.get(key) || 0)), Math.max(0, view.length - 1));
  const selected = view[sel] || null;
  if (!selected) {
    const ok = await writeClipboard(buildSessionCopyText(key, { title: 'api', text: 'no selected api call' }));
    if (!ok) alert('复制失败：浏览器未授予剪贴板权限');
    return;
  }
  const tokenIn = selected.usage?.input || 0;
  const tokenOut = selected.usage?.output || 0;
  const tokenCacheR2 = selected.usage?.cacheRead || 0;
  const tokenCacheW2 = selected.usage?.cacheWrite || 0;
  const tokenCtx2 = tokenIn + tokenCacheR2 + tokenCacheW2;
  const inText = findNearestUserInput(all, selected.ts) || '';
  const outText = String(buildAssistantOutputText(selected.fullContent, selected.textPreview)).trim();
  const payload = [
    selected.ts ? `ts: ${fmtTs(selected.ts)}` : '',
    selected.provider ? `provider: ${selected.provider}` : '',
    selected.model ? `model: ${selected.model}` : '',
    selected.stopReason ? `stopReason: ${selected.stopReason}` : '',
    selected.errorMessage ? `error: ${selected.errorMessage}` : '',
    `ctx: ${tokenCtx2.toLocaleString()} (in:${tokenIn.toLocaleString()} cR:${tokenCacheR2.toLocaleString()} cW:${tokenCacheW2.toLocaleString()}) → out: ${tokenOut.toLocaleString()}`,
    '', 'input:', inText || '-', '', 'output:', outText || '-', '', 'raw:', tryPrettyJson(selected),
  ].filter(Boolean).join('\n');
  const ok = await writeClipboard(buildSessionCopyText(key, { title: 'api', text: payload }));
  if (!ok) alert('复制失败：浏览器未授予剪贴板权限');
}

// --- Select step / api ---
export function selectStep(key, idx) { selectedStepIndexBySession.set(key, Number(idx)||0); render(); }
export function selectApi(key, idx) { selectedApiIndexBySession.set(key, Number(idx)||0); render(); }

export function getCurrentStepLabel(s) {
  const interactions = Array.isArray(s?.interactions) ? s.interactions : [];
  const top = interactions[0];
  if (top) {
    if (top.type === 'ToolCall') return `工具调用: ${top.toolName || top.content || 'tool'}`;
    if (top.type === 'ToolResult') return `工具结果: ${top.resultToolName || top.resultToolId || 'tool'}`;
    if (top.type === 'User') return '用户输入';
    if (top.type === 'Bot') return top.stopReason ? `状态: ${top.stopReason}` : '模型回复';
  }
  if (s?.toolName) return `工具: ${s.toolName}`;
  if (s?.stopReason) return `状态: ${s.stopReason}`;
  return '消息更新';
}

// --- Auto-delete settings ---
export async function loadAutoDeleteSettings(force = false) {
  if (!force && autoDeleteSettingsCache) return autoDeleteSettingsCache;
  const r = await fetch('/api/monitor/auto-soft-delete', { cache: 'no-store' });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || r.statusText);
  setAutoDeleteSettingsCache(j);
  return j;
}

export function openAutoDeleteSettings() {
  document.getElementById('settings-overlay').style.display = 'flex';
  renderAutoDeleteSettings();
}

export function closeAutoDeleteSettings() {
  document.getElementById('settings-overlay').style.display = 'none';
}

export async function renderAutoDeleteSettings() {
  const box = document.getElementById('settings-box');
  box.innerHTML = '<div class="mono">加载中…</div>';
  try {
    const j = await loadAutoDeleteSettings(true);
    const cfg = j && j.config ? j.config : {};
    const enabled = !!cfg.enabled;
    const ttlHours = cfg.ttlMs ? (cfg.ttlMs / (60 * 60 * 1000)) : 1;
    const intervalMin = cfg.intervalMs ? (cfg.intervalMs / (60 * 1000)) : 10;
    box.innerHTML = `
      <div class="row" style="justify-content:space-between">
        <div class="row" style="gap:10px"><div class="badge">自动软删</div><div class="mono">超过 N 小时无更新自动软删除</div></div>
        <div class="row"><button class="toggle-archived" onclick="closeAutoDeleteSettings()">关闭</button></div>
      </div>
      <div style="margin-top:12px;display:grid;grid-template-columns:1fr;gap:10px">
        <label class="row" style="gap:10px"><input id="auto-delete-enabled" type="checkbox" ${enabled ? 'checked' : ''} /><span class="mono">启用</span></label>
        <div class="row" style="gap:10px"><div class="mono" style="min-width:120px">无更新阈值</div><input id="auto-delete-ttl-hours" type="number" min="0.1" step="0.1" value="${ttlHours}" style="width:120px;background:#0b0f14;border:1px solid #243444;color:#e6eef8;border-radius:6px;padding:6px 8px" /><div class="mono">小时</div></div>
        <div class="row" style="gap:10px"><div class="mono" style="min-width:120px">扫描间隔</div><input id="auto-delete-interval-min" type="number" min="0.2" step="0.2" value="${intervalMin}" style="width:120px;background:#0b0f14;border:1px solid #243444;color:#e6eef8;border-radius:6px;padding:6px 8px" /><div class="mono">分钟</div></div>
        <div class="row" style="justify-content:flex-end;gap:10px"><button class="toggle-archived" onclick="saveAutoDeleteSettings()">保存并生效</button></div>
      </div>`;
  } catch (e) {
    box.innerHTML = `<div class="mono" style="color:#ffb4b4">加载失败：${escHtml(e && e.message || e)}</div>`;
  }
}

export async function saveAutoDeleteSettings() {
  try {
    const enabled = !!document.getElementById('auto-delete-enabled')?.checked;
    const ttlHours = parseFloat(document.getElementById('auto-delete-ttl-hours')?.value || '1');
    const intervalMin = parseFloat(document.getElementById('auto-delete-interval-min')?.value || '10');
    const r = await fetch('/api/monitor/auto-soft-delete', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled, ttlMs: Math.round(ttlHours * 60 * 60 * 1000), intervalMs: Math.round(intervalMin * 60 * 1000) })
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || r.statusText);
    setAutoDeleteSettingsCache(null);
    await renderAutoDeleteSettings();
    alert('已保存并生效');
  } catch (e) { alert(`保存失败：${String(e && e.message || e)}`); }
}

// --- Session CRUD ---
export function openHistory(key) {
  const s = state.get(key) || {};
  location.href = `/activity?agent=${encodeURIComponent(s.agentId || 'main')}&sid=${encodeURIComponent(s.sessionId || '')}`;
}

export async function softDeleteSession(key) {
  const s = state.get(key) || {};
  const agentId = s.agentId || 'main';
  const sessionId = s.sessionId || '';
  if (!confirm(`确定要软删这个 session 吗？\n\n${sessionId}\n\n可在「已删除」里恢复。`)) return;
  try {
    const r = await fetch(`/session-delete?agent=${encodeURIComponent(agentId)}&sid=${encodeURIComponent(sessionId)}`, { method: 'POST' });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { alert(`删除失败：${j.error || r.statusText}`); return; }
    state.delete(key); archived.delete(key); expandedSessions.delete(key); saveArchived();
    await refreshDeletedList(true); render();
  } catch (e) { alert(`删除失败：${String(e && e.message || e)}`); }
}

export async function restoreSession(agentId, sessionId) {
  try {
    const r = await fetch(`/session-restore?agent=${encodeURIComponent(agentId)}&sid=${encodeURIComponent(sessionId)}`, { method: 'POST' });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { alert(`恢复失败：${j.error || r.statusText}`); return; }
    await refreshDeletedList(true); pollSnapshot();
  } catch (e) { alert(`恢复失败：${String(e && e.message || e)}`); }
}

export async function refreshDeletedList(force = false) {
  const now = Date.now();
  if (!force && deletedCacheAt && (now - deletedCacheAt < 2000)) return deletedCache;
  try {
    const r = await fetch('/sessions?includeDeleted=1', { cache: 'no-store' });
    if (!r.ok) return deletedCache;
    const j = await r.json();
    const agents = Array.isArray(j.agents) ? j.agents : [];
    const flattened = [];
    for (const a of agents) {
      const agentId = a.agentId || 'main';
      for (const item of (Array.isArray(a.deleted) ? a.deleted : [])) flattened.push({ ...item, agentId });
    }
    setDeletedCache(flattened); setDeletedCacheAt(now);
    return deletedCache;
  } catch { return deletedCache; }
}

export async function toggleDeletedPanel() {
  setDeletedPanelOpen(!deletedPanelOpen);
  const overlay = document.getElementById('deleted-overlay');
  overlay.style.display = deletedPanelOpen ? 'flex' : 'none';
  if (!deletedPanelOpen) return;
  await refreshDeletedList(true); renderDeletedPanel();
}

export function renderDeletedPanel() {
  const list = document.getElementById('deleted-list');
  const items = deletedCache || [];
  if (!items.length) { list.innerHTML = '<div class="mono">暂无已删除 session</div>'; return; }
  list.innerHTML = items.map((it) => {
    const agentId = it.agentId || 'main';
    const sid = it.sessionId || '';
    const t = it.deletedAt ? fmtTs(it.deletedAt) : '-';
    return `<div class="panel-row">
      <div class="row" style="gap:10px">
        <div class="badge">Agent</div><div class="mono">${escHtml(agentId)}</div>
        <div class="badge">Deleted</div><div class="mono">${sid}</div><div class="ts">${t}</div>
      </div>
      <div class="row" style="gap:8px">
        <button class="btn-link" onclick="openHistory('${makeKey(agentId, sid)}')">历史</button>
        <button class="btn-link" onclick="restoreSession('${agentId}', '${sid}')">恢复</button>
      </div>
    </div>`;
  }).join('');
}

// --- Step Pane ---
export function renderStepPane(key, interactions, isFullscreen) {
  const steps = Array.isArray(interactions) ? interactions : [];
  const max = isFullscreen ? 10 : 7;
  const view = steps.slice(0, max);
  const sel = Math.min(Math.max(0, Number(selectedStepIndexBySession.get(key) || 0)), Math.max(0, view.length - 1));
  const listHtml = view.length ? view.map((i, idx) => {
    let snippet = i.textPreview || i.content || '';
    if (typeof snippet !== 'string') snippet = JSON.stringify(snippet);
    snippet = snippet.replace(/\s+/g, ' ').trim();
    if (snippet.length > 80) snippet = snippet.slice(0, 80) + '…';
    const errStyle = i.isError ? 'background:rgba(200,50,50,.12);' : '';
    const errDot = i.isError ? '<span style="color:#f15e5e;margin-right:4px">✕</span>' : '';
    const dur = i.details?.durationMs != null ? `<span style="color:#7aa2d5;font-family:ui-monospace,monospace">${i.details.durationMs}ms</span>` : '-';
    return `<div class="list-row ${idx===sel?'selected':''}" style="${errStyle}" onclick="selectStep('${key}', ${idx})">
      <div class="cell-time">${fmtTimeHms(i.ts)}</div>
      <div class="cell-type">${errDot}${escHtml(i.type || '-')}</div>
      <div class="cell-tokens">${dur}</div>
      <div class="cell-snippet" title="${escHtml(i.textPreview || i.content || '')}">${escHtml(snippet || '-')}</div>
    </div>`;
  }).join('') : `<div class="mono" style="padding:10px">暂无步骤</div>`;

  const selectedStep = view[sel] || null;
  let stepDetailHtml = '<div class="mono">暂无详情</div>';
  if (selectedStep) {
    const fullText = extractTextFromFullContent(selectedStep.fullContent) || selectedStep.textPreview || selectedStep.content || '';
    const toolCalls = extractToolCallsFromFullContent(selectedStep.fullContent);
    const textBlock = fullText
      ? `<div class="detail-box" style="color:#e6eef8;max-height:220px;overflow:auto">${escHtml(fullText)}</div>`
      : `<div class="detail-box" style="color:#5c6b7f;font-style:italic;max-height:220px;overflow:auto">无文本内容</div>`;
    const toolBlock = toolCalls.length
      ? toolCalls.map(tc => `<div class="detail-box" style="color:#e6eef8;max-height:220px;overflow:auto"><b>${escHtml(tc.name)}</b>\n${escHtml(tryPrettyJson(tc.arguments))}</div>`).join('')
      : '';
    const errBadge = selectedStep.isError ? `<span class="badge" style="background:rgba(200,50,50,.2);border-color:#f15e5e;color:#ffb4b4">isError</span>` : '';
    const detailsMeta = selectedStep.details ? (() => {
      const d = selectedStep.details;
      const parts = [];
      if (d.exitCode != null) parts.push(`exitCode: ${d.exitCode}`);
      if (d.durationMs != null) parts.push(`duration: ${d.durationMs}ms`);
      if (d.status) parts.push(`status: ${d.status}`);
      return parts.length ? `<div class="detail-meta">${parts.map(p=>`<span>${escHtml(p)}</span>`).join('')}</div>` : '';
    })() : '';
    const cwdBadge = selectedStep.cwd ? `<span class="badge" title="${escHtml(selectedStep.cwd)}">cwd: ${escHtml(selectedStep.cwd.split('/').slice(-2).join('/'))}</span>` : '';
    const thinkBadge = selectedStep.thinkingLevel != null ? `<span class="badge">thinking: ${escHtml(selectedStep.thinkingLevel)}</span>` : '';
    stepDetailHtml = `<div class="detail-title">
      <span class="badge">${escHtml(selectedStep.type||'-')}</span>
      <span class="ts">${fmtTs(selectedStep.ts)}</span>
      ${selectedStep.resultToolName ? `<span class="badge">${escHtml(selectedStep.resultToolName)}</span>` : ''}
      ${errBadge}${cwdBadge}${thinkBadge}
    </div>${detailsMeta}${textBlock}${toolBlock}`;
  }

  const s = state.get(key) || {};
  const totalTokens = s.totalTokens || { input:0, output:0 };
  const fam = modelFamily(s.model || '');
  const modelRaw = s.model || '';
  const modelName = modelRaw ? modelRaw.split('/').pop() : '-';
  const modelTag = modelRaw ? `<span class="tag tag-${fam}" title="${escHtml(modelRaw)}">${escHtml(modelName)}</span>` : '';
  const err = s.errorMessage ? `<div class="mono" style="color:#ffb4b4">${escHtml(s.errorMessage)}</div>` : '';
  const toolArgs = s.toolArgs ? `<div class="detail-box" style="max-height:180px;overflow:auto">${escHtml(tryPrettyJson(s.toolArgs))}</div>` : '';
  const currentMsg = (extractTextFromFullContent(s.fullContent) || s.textPreview || '').trim();
  const currentMsgBlock = currentMsg
    ? `<div class="detail-box" style="color:#e6eef8;max-height:180px;overflow:auto">${escHtml(currentMsg)}</div>`
    : `<div class="detail-box" style="color:#5c6b7f;font-style:italic;max-height:180px;overflow:auto">当前步骤没有消息</div>`;
  const currentStep = getCurrentStepLabel(s);

  const latestApiCall = interactions.find(i => i && i.role === 'assistant' && i.usage);
  const latestUsage = latestApiCall?.usage || null;
  const ctxLen = latestUsage ? (latestUsage.input||0) + (latestUsage.cacheRead||0) + (latestUsage.cacheWrite||0) : 0;
  const ctxWindow = getContextWindow(s.model || '');
  const pct = Math.min(Math.round((ctxLen / ctxWindow) * 100), 200);
  const healthColor = pct <= 50 ? '#35c46a' : (pct <= 75 ? '#edb232' : (pct <= 90 ? '#f15e5e' : '#d66bff'));

  return `<div class="pane">
    <div class="pane-head"><div class="pane-title">消息与步骤</div><div class="row" style="gap:8px"><div class="pane-sub">${escHtml(view.length ? `最近 ${view.length} 条` : '')}</div><button class="btn-copy" onclick="copyStepDetail('${key}')">复制</button></div></div>
    <div class="pane-main" style="padding:10px;gap:10px">
      <div class="row" style="gap:8px">
        <div class="badge">${escHtml(s.role||'n/a')}</div><div class="badge">${escHtml(s.provider||'provider')}</div>${modelTag}
        <div class="badge" title="${(totalTokens.input||0).toLocaleString()+'/'+(totalTokens.output||0).toLocaleString()}">${fmtCompact((totalTokens.input||0)+(totalTokens.output||0))}</div>
        <div class="ts">${fmtTs(s.ts)}</div>
      </div>
      <div class="health"><div class="health-head"><span class="badge">上下文</span><span class="mono">${pct}%</span><span class="mono">${fmtCompact(ctxLen)} / ${fmtCompact(ctxWindow)}</span></div><div class="health-bar"><div class="health-fill" style="width:${pct}%;background:${healthColor}"></div></div></div>
      ${(() => {
        const tt = computeLatestTurnTiming(interactions);
        if (!tt || !tt.totalMs) return '';
        const lPct = (tt.llmMs / tt.totalMs * 100).toFixed(1);
        const tPct = (tt.toolMs / tt.totalMs * 100).toFixed(1);
        return `<div class="mini-timing"><div class="mini-timing-head"><span class="badge">最近一轮</span><span>${fmtDurShort(tt.totalMs)}</span><span class="llm-c">LLM ${fmtDurShort(tt.llmMs)}</span><span class="tool-c">Tool ${fmtDurShort(tt.toolMs)}</span><span>${tt.phases.length} phases</span></div><div class="mini-timing-bar"><div class="mt-llm" style="width:${lPct}%"></div><div class="mt-tool" style="width:${tPct}%"></div></div></div>`;
      })()}
      <div class="row" style="gap:8px"><div class="badge">当前步骤</div><div class="title">${escHtml(currentStep)}</div></div>
      ${currentMsgBlock}${err || ''}${toolArgs || ''}
      <div class="pane-list" data-scroll-id="step-list-${key}">${listHtml}</div>
      <div class="pane-detail" data-scroll-id="step-detail-${key}">${stepDetailHtml}</div>
    </div>
  </div>`;
}

// --- API Pane ---
export function renderApiPane(key, interactions, isFullscreen) {
  const all = Array.isArray(interactions) ? interactions : [];
  const apiOnly = all.filter(i => i && i.role === 'assistant' && i.model);
  const view = apiOnly.slice(0, 50);
  const sel = Math.min(Math.max(0, Number(selectedApiIndexBySession.get(key) || 0)), Math.max(0, view.length - 1));
  const selected = view[sel] || null;

  const listHtml = view.length ? view.map((i, idx) => {
    let snippet = i.textPreview || extractTextFromFullContent(i.fullContent) || i.content || '';
    snippet = String(snippet || '').replace(/\s+/g,' ').trim();
    if (snippet.length > 120) snippet = snippet.slice(0, 120) + '…';
    const tokenCtx = i.usage ? (i.usage.input||0) + (i.usage.cacheRead||0) + (i.usage.cacheWrite||0) : 0;
    const tokenOut = i.usage?.output || 0;
    const tokens = i.usage ? `${fmtCompact(tokenCtx)}→${fmtCompact(tokenOut)}` : '-';
    const tokensTitle = i.usage ? `in:${(i.usage.input||0).toLocaleString()} cR:${(i.usage.cacheRead||0).toLocaleString()} cW:${(i.usage.cacheWrite||0).toLocaleString()} out:${tokenOut.toLocaleString()}` : '';
    const fam = modelFamily(i.model || '');
    const modelRaw = i.model || '';
    const modelName = modelRaw ? modelRaw.split('/').pop() : '-';
    const modelTag = modelRaw ? `<span class="tag tag-${fam}" title="${escHtml(modelRaw)}">${escHtml(modelName)}</span>` : '-';
    return `<div class="list-row ${idx===sel?'selected':''}" onclick="selectApi('${key}', ${idx})">
      <div class="cell-time">${fmtTimeHms(i.ts)}</div>
      <div class="cell-type"><span class="badge">Bot</span>${modelTag}</div>
      <div class="cell-tokens" title="${escHtml(tokensTitle)}">${tokens}</div>
      <div class="cell-snippet" title="${escHtml(snippet)}">${escHtml(snippet || '-')}</div>
    </div>`;
  }).join('') : `<div class="mono" style="padding:10px">暂无 API 调用</div>`;

  let detailHtml = '<div class="mono">暂无详情</div>';
  if (selected) {
    const fam = modelFamily(selected.model || '');
    const modelRaw = selected.model || '';
    const modelName = modelRaw ? modelRaw.split('/').pop() : '-';
    const modelTag = modelRaw ? `<span class="tag tag-${fam}" title="${escHtml(modelRaw)}">${escHtml(modelName)}</span>` : '';
    const tokenIn = selected.usage?.input || 0;
    const tokenOut = selected.usage?.output || 0;
    const tokenCacheR = selected.usage?.cacheRead || 0;
    const tokenCacheW = selected.usage?.cacheWrite || 0;
    const tokenCtx = tokenIn + tokenCacheR + tokenCacheW;
    const tokens = selected.usage ? `ctx ${tokenCtx.toLocaleString()} → out ${tokenOut.toLocaleString()}` : '-';
    const provider = selected.provider || '';
    const stop = selected.stopReason ? `Stop: ${selected.stopReason}` : '';
    const err = selected.errorMessage ? `错误: ${selected.errorMessage}` : '';
    const inText = findNearestUserInput(all, selected.ts) || '';
    const inputBlock = inText
      ? `<div class="detail-box" style="color:#e6eef8;max-height:220px;overflow:auto">${escHtml(inText)}</div>`
      : `<div class="detail-box" style="color:#5c6b7f;font-style:italic;max-height:220px;overflow:auto">当前步骤没有消息</div>`;
    const outText = (buildAssistantOutputText(selected.fullContent, selected.textPreview) || '').trim();
    const outputBlock = outText
      ? `<div class="detail-box" style="color:#e6eef8;max-height:220px;overflow:auto">${escHtml(outText)}</div>`
      : `<div class="detail-box" style="color:#5c6b7f;font-style:italic;max-height:220px;overflow:auto">当前步骤没有消息</div>`;
    const costInfo = selected.usage?.cost ? (() => {
      const c = selected.usage.cost;
      const total = (c.input||0) + (c.output||0) + (c.cacheRead||0) + (c.cacheWrite||0);
      return total > 0 ? `$${total.toFixed(4)} (in:$${(c.input||0).toFixed(4)} out:$${(c.output||0).toFixed(4)})` : null;
    })() : null;
    const apiLabel = selected.api ? `<span class="badge">${escHtml(selected.api)}</span>` : '';
    detailHtml = `<div class="detail-title">
      <span class="badge">命令: Bot</span>${provider ? `<span class="badge">${escHtml(provider)}</span>` : ''}${modelTag}${apiLabel}
    </div>
    <div class="detail-meta">
      <span>时间: ${escHtml(fmtTs(selected.ts))}</span><span>${escHtml(tokens)}</span>
      ${(tokenCacheR > 0 || tokenCacheW > 0) ? `<span style="color:#7a90a8">缓存读/写: ${tokenCacheR.toLocaleString()}/${tokenCacheW.toLocaleString()}</span>` : ''}
      ${stop ? `<span>${escHtml(stop)}</span>` : ''}${err ? `<span style="color:#ffb4b4">${escHtml(err)}</span>` : ''}
      ${costInfo ? `<span style="color:#a5d6a7">费用: ${escHtml(costInfo)}</span>` : ''}
    </div>
    <div class="row" style="gap:8px;margin-top:10px"><div class="badge">入参</div></div>${inputBlock}
    <div class="row" style="gap:8px;margin-top:10px"><div class="badge">返回参数</div></div>${outputBlock}`;
  }

  return `<div class="pane">
    <div class="pane-head"><div class="pane-title">API 调用</div><div class="row" style="gap:8px"><div class="pane-sub">${escHtml(view.length ? `最近 ${view.length} 条` : '')}</div><button class="btn-copy" onclick="copyApiDetail('${key}')">复制</button></div></div>
    <div class="pane-main"><div class="pane-list" data-scroll-id="api-list-${key}">${listHtml}</div><div class="pane-detail" data-scroll-id="api-detail-${key}">${detailHtml}</div></div>
  </div>`;
}
