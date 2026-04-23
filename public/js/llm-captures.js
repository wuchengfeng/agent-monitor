import { llmCaptures, llmCapturesFull, llmCapturesPanelOpen, setLlmCapturesPanelOpen,
  selectedCaptureId, setSelectedCaptureId, llmCaptureDetailExpanded, setLlmCaptureDetailExpanded } from './state.js';
import { fmtTimeHms, escHtml } from './utils.js';

export function handleLlmCaptureEvent(ev) {
  if (llmCaptures.some(c => c._id === ev.captureId)) return;
  llmCaptures.unshift({
    _id: ev.captureId, capturedAt: ev.capturedAt, model: ev.model,
    messageCount: ev.messageCount, toolCount: ev.toolCount,
    durationMs: ev.durationMs, requestSize: ev.requestSize, responseSize: ev.responseSize,
  });
  if (llmCaptures.length > 200) llmCaptures.pop();
  if (llmCapturesPanelOpen) renderLlmCapturesPanel();
}

export async function pollLlmCaptures() {
  try {
    const resp = await fetch('/api/llm-captures?limit=100');
    const list = await resp.json();
    for (const c of list) { if (!llmCaptures.some(x => x._id === c._id)) llmCaptures.push(c); }
    llmCaptures.sort((a, b) => (b._id || 0) - (a._id || 0));
  } catch {}
}

export async function fetchCaptureDetail(id) {
  if (llmCapturesFull.has(id)) return llmCapturesFull.get(id);
  try {
    const resp = await fetch(`/api/llm-capture/${id}`);
    const data = await resp.json();
    llmCapturesFull.set(id, data);
    if (llmCapturesFull.size > 50) { llmCapturesFull.delete(llmCapturesFull.keys().next().value); }
    return data;
  } catch { return null; }
}

export function toggleLlmCapturesPanel() {
  setLlmCapturesPanelOpen(!llmCapturesPanelOpen);
  document.getElementById('llm-captures-overlay').style.display = llmCapturesPanelOpen ? 'flex' : 'none';
  if (llmCapturesPanelOpen) pollLlmCaptures().then(() => renderLlmCapturesPanel());
}

export function selectCapture(id) {
  setSelectedCaptureId(id);
  setLlmCaptureDetailExpanded(new Set());
  fetchCaptureDetail(id).then(() => renderLlmCapturesPanel());
}

export function toggleCaptureSection(section) {
  if (llmCaptureDetailExpanded.has(section)) llmCaptureDetailExpanded.delete(section);
  else llmCaptureDetailExpanded.add(section);
  renderLlmCapturesPanel();
}

export function copyCaptureJson() {
  const data = llmCapturesFull.get(selectedCaptureId);
  if (data) navigator.clipboard.writeText(JSON.stringify(data.request, null, 2)).catch(() => {});
}

export function renderLlmCapturesPanel() {
  const listEl = document.getElementById('llm-captures-list');
  const detailEl = document.getElementById('llm-captures-detail');
  if (!listEl) return;

  listEl.innerHTML = llmCaptures.length ? llmCaptures.map(c => {
    const sel = c._id === selectedCaptureId ? 'selected' : '';
    const t = fmtTimeHms(c.capturedAt);
    const sizeKB = Math.round((c.requestSize || 0) / 1024);
    const model = (c.model||'?').split('/').pop();
    const dur = c.durationMs ? (c.durationMs/1000).toFixed(1)+'s' : '';
    return `<div class="list-row llm-cap-row ${sel}" onclick="selectCapture(${c._id})" style="grid-template-columns:56px 1fr;gap:6px;align-items:center;padding:8px 10px">
      <div class="cell-time">${t}</div>
      <div style="overflow:hidden;white-space:nowrap;text-overflow:ellipsis;font-size:11px">
        <span class="tag tag-other" style="font-size:10px">${escHtml(model)}</span>
        <span class="mono" style="opacity:.7">${c.messageCount||0}m ${c.toolCount||0}t ${sizeKB}KB ${dur}</span>
      </div>
    </div>`;
  }).join('') : '<div class="mono" style="padding:10px">暂无 LLM 请求捕获。请确保 mitmproxy 已启动。</div>';

  if (!detailEl) return;
  const capture = llmCapturesFull.get(selectedCaptureId);
  if (!capture) { detailEl.innerHTML = '<div class="mono" style="padding:10px">点击左侧列表查看详情</div>'; return; }

  const req = capture.request || {};
  const messages = req.messages || [];
  const tools = req.tools || [];
  const resp = capture.response || {};

  const params = ['model','temperature','max_tokens','max_completion_tokens','top_p','stream','stop','frequency_penalty','presence_penalty']
    .filter(k => req[k] !== undefined)
    .map(k => `<span class="badge">${k}: ${JSON.stringify(req[k])}</span>`)
    .join(' ');

  const sysMessages = messages.filter(m => m.role === 'system' || m.role === 'developer');
  const sysExpanded = llmCaptureDetailExpanded.has('system');
  const sysContent = sysMessages.map(m => typeof m.content === 'string' ? m.content : JSON.stringify(m.content)).join('\n---\n');
  const sysSection = sysMessages.length ? `
    <div style="margin-top:10px">
      <div class="row" style="gap:8px;cursor:pointer" onclick="toggleCaptureSection('system')">
        <div class="badge" style="background:#2b1a00;border-color:#5c3a00;color:#ffcc80">System Prompt</div>
        <span class="mono">${sysContent.length.toLocaleString()} chars</span>
        <span class="mono">${sysExpanded ? '▼' : '▶'}</span>
      </div>
      ${sysExpanded ? `<div class="detail-box" style="max-height:400px;overflow:auto">${escHtml(sysContent)}</div>` : ''}
    </div>` : '';

  const convMessages = messages.filter(m => m.role !== 'system' && m.role !== 'developer');
  const msgsExpanded = llmCaptureDetailExpanded.has('messages');
  let msgsInner = '';
  if (msgsExpanded) {
    const roleColors = {user:'#234a86',assistant:'#1b6b4e',tool:'#5e2a86'};
    msgsInner = '<div style="margin-top:6px">' + convMessages.map(function(m, i) {
      var msgKey = 'msg_' + i;
      var msgExpanded = llmCaptureDetailExpanded.has(msgKey);
      var contentStr = typeof m.content === 'string' ? m.content : JSON.stringify(m.content, null, 2);
      var preview = contentStr.replace(/\s+/g, ' ').slice(0, 100);
      var rc = roleColors[m.role] || '#2c3c4d';
      var tcInfo = m.tool_calls ? ' [' + m.tool_calls.map(function(tc){ return tc.function && tc.function.name || tc.name || '?'; }).join(', ') + ']' : '';
      var detailBox = msgExpanded
        ? '<div class="detail-box" style="max-height:300px;overflow:auto">' + escHtml(contentStr) + (m.tool_calls ? '\n\n--- Tool Calls ---\n' + escHtml(JSON.stringify(m.tool_calls, null, 2)) : '') + '</div>'
        : '';
      return '<div style="margin-bottom:4px">'
        + '<div class="row" style="gap:6px;cursor:pointer" onclick="toggleCaptureSection(\'' + msgKey + '\')">'
        + '<span class="badge" style="border-color:' + rc + ';min-width:60px">' + escHtml(m.role) + '</span>'
        + '<span class="mono" style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + escHtml(preview) + escHtml(tcInfo) + '</span>'
        + '<span class="mono">' + (msgExpanded ? '▼' : '▶') + '</span>'
        + '</div>'
        + detailBox
        + '</div>';
    }).join('') + '</div>';
  }
  const msgsSection = `
    <div style="margin-top:10px">
      <div class="row" style="gap:8px;cursor:pointer" onclick="toggleCaptureSection('messages')">
        <div class="badge" style="background:#0a1a2e;border-color:#234a86;color:#a9c7ff">Messages (${convMessages.length})</div>
        <span class="mono">${msgsExpanded ? '▼' : '▶'}</span>
      </div>
      ${msgsInner}
    </div>`;

  const toolsExpanded = llmCaptureDetailExpanded.has('tools');
  const toolsSection = tools.length ? `
    <div style="margin-top:10px">
      <div class="row" style="gap:8px;cursor:pointer" onclick="toggleCaptureSection('tools')">
        <div class="badge" style="background:#1a0a2e;border-color:#5e2a86;color:#e1bee7">Tools (${tools.length})</div>
        <span class="mono">${toolsExpanded ? '▼' : '▶'}</span>
      </div>
      ${toolsExpanded ? `<div class="detail-box" style="max-height:400px;overflow:auto">${escHtml(JSON.stringify(tools, null, 2))}</div>` : ''}
    </div>` : '';

  const respExpanded = llmCaptureDetailExpanded.has('response');
  const usageStr = resp.usage ? `in:${(resp.usage.prompt_tokens||resp.usage.input||0).toLocaleString()} out:${(resp.usage.completion_tokens||resp.usage.output||0).toLocaleString()}` : '';
  const respSection = `
    <div style="margin-top:10px">
      <div class="row" style="gap:8px;cursor:pointer" onclick="toggleCaptureSection('response')">
        <div class="badge" style="background:#0a2e1a;border-color:#1b6b4e;color:#a5d6a7">Response</div>
        <span class="mono">${usageStr}</span>
        <span class="mono">${capture.durationMs || 0}ms</span>
        <span class="mono">${respExpanded ? '▼' : '▶'}</span>
      </div>
      ${respExpanded ? `<div class="detail-box" style="max-height:300px;overflow:auto">${escHtml(JSON.stringify(resp, null, 2))}</div>` : ''}
    </div>`;

  detailEl.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px">
      <div class="row" style="gap:6px;flex-wrap:wrap">${params}</div>
      <button class="btn-copy" onclick="copyCaptureJson()">复制请求 JSON</button>
    </div>
    ${sysSection}
    ${msgsSection}
    ${toolsSection}
    ${respSection}
  `;
}
