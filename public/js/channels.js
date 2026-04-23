import {
  state, channelData, setChannelData, channelNicknames, setChannelNicknames,
  editingNicknameKey, setEditingNicknameKey, channelViewActive, setChannelViewActive,
  systemChannelsExpanded, setSystemChannelsExpanded, topologyViewActive, setTopologyViewActive,
} from './state.js';
import { escHtml, fmtTs, fmtCompact, makeKey, channelIcon, isSystemChannel, agentTagClass } from './utils.js';
import { updateTopoToggleBtn, stopTopoLoop } from './topology.js';

export async function loadNicknames() {
  try {
    const r = await fetch('/api/channel-nicknames', { cache: 'no-store' });
    if (r.ok) setChannelNicknames(await r.json());
  } catch {}
}

function nicknameKey(channel, chatType, senderId) {
  return `${channel}:${chatType}:${senderId}`;
}

function getNickname(channel, chatType, senderId) {
  return channelNicknames[nicknameKey(channel, chatType, senderId)] || null;
}

export async function saveNickname(channel, chatType, senderId, nickname) {
  const key = nicknameKey(channel, chatType, senderId);
  try {
    const r = await fetch('/api/channel-nicknames', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key, nickname }),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || r.statusText);
    setChannelNicknames(j.nicknames);
    setEditingNicknameKey(null);
    const { render } = await import('./render.js');
    render();
  } catch (e) {
    alert(`保存失败：${String(e && e.message || e)}`);
  }
}

export function startEditNickname(channel, chatType, senderId) {
  setEditingNicknameKey(nicknameKey(channel, chatType, senderId));
  renderChannels();
  requestAnimationFrame(() => {
    const el = document.getElementById('active-nickname-input');
    if (el) { el.focus(); el.select(); }
  });
}

export function cancelEditNickname() {
  setEditingNicknameKey(null);
  import('./render.js').then(m => m.render());
}

export async function pollChannels() {
  try {
    const r = await fetch('/api/channels', { cache: 'no-store' });
    if (!r.ok) return;
    const j = await r.json();
    if (Array.isArray(j.channels)) setChannelData(j.channels);
    if (channelViewActive && !editingNicknameKey) {
      const { render } = await import('./render.js');
      render();
    }
  } catch {}
}

export function toggleChannelView() {
  setChannelViewActive(!channelViewActive);
  if (channelViewActive) { setTopologyViewActive(false); updateTopoToggleBtn(); stopTopoLoop(); }
  const btn = document.getElementById('btn-channel-view');
  if (btn) btn.textContent = channelViewActive ? '会话视图' : '频道视图';
  import('./render.js').then(m => m.render());
}

function renderChannelRow(entry, container) {
  const { agentId, sessionId, channel, chatType, senderId, senderLabel, accountId, updatedAt } = entry;
  const icon = channelIcon(channel);
  const stateKey = makeKey(agentId, sessionId || '');
  const live = sessionId ? state.get(stateKey) : null;
  const lastTs = live ? (live.lastTs || updatedAt) : updatedAt;
  const lastMsg = live ? (
    live.textPreview
      ? String(live.textPreview).replace(/\s+/g, ' ').trim().slice(0, 80)
      : (live.toolName ? `工具: ${live.toolName}` : '')
  ) : '';
  const tokens = live?.totalTokens ? fmtCompact((live.totalTokens.input||0)+(live.totalTokens.output||0)) : '-';
  const isActive = live && live.updatedAt && (Date.now() - live.updatedAt < 8000);
  const activeDot = isActive ? '<span style="display:inline-block;width:7px;height:7px;border-radius:50%;background:#35c46a;margin-right:4px;flex-shrink:0"></span>' : '';

  const chatTypeBadge = chatType === 'direct'
    ? `<span class="badge" style="border-color:#234a86;background:rgba(58,120,255,.12);color:#a9c7ff">私聊</span>`
    : chatType === 'group'
      ? `<span class="badge" style="border-color:#3a5a3a;background:rgba(76,175,80,.12);color:#a5d6a7">群聊</span>`
      : `<span class="badge">${escHtml(chatType)}</span>`;

  const nickname = getNickname(channel, chatType, senderId);
  const nkKey = nicknameKey(channel, chatType, senderId);
  const isEditingNk = editingNicknameKey === nkKey;
  const displayName = nickname || senderLabel || senderId;
  const rawId = senderLabel || senderId;

  let nameCell;
  if (isEditingNk) {
    nameCell = `
      <div class="row" style="gap:4px;min-width:0;flex-wrap:nowrap">
        ${activeDot}
        <input id="active-nickname-input" type="text" value="${escHtml(nickname || '')}" placeholder="${escHtml(rawId)}"
          style="flex:1;min-width:0;background:#0b0f14;border:1px solid #3a78ff;color:#e6eef8;border-radius:4px;padding:2px 6px;font-size:12px;font-family:inherit"
          onkeydown="if(event.key==='Enter'){saveNickname('${escHtml(channel)}','${escHtml(chatType)}','${escHtml(senderId)}',this.value)}else if(event.key==='Escape'){cancelEditNickname()}" />
        <button class="btn-link" style="padding:2px 6px" onclick="saveNickname('${escHtml(channel)}','${escHtml(chatType)}','${escHtml(senderId)}',document.getElementById('active-nickname-input').value)">✓</button>
        <button class="btn-archive" style="padding:2px 6px" onclick="cancelEditNickname()">✕</button>
      </div>`;
  } else {
    nameCell = `
      <div class="row" style="gap:5px;min-width:0;flex-wrap:nowrap">
        ${activeDot}
        <span class="mono" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;${nickname ? 'color:#cfe3ff;font-weight:600' : ''}" title="${escHtml(rawId)}">${escHtml(displayName)}</span>
        ${nickname ? `<span class="mono" style="color:#5c6b7f;font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${escHtml(rawId)}">${escHtml(rawId.length > 12 ? rawId.slice(0,12)+'…' : rawId)}</span>` : ''}
        <button class="btn-archive" style="padding:1px 5px;font-size:11px;flex-shrink:0" title="编辑备注" onclick="startEditNickname('${escHtml(channel)}','${escHtml(chatType)}','${escHtml(senderId)}')">✏</button>
      </div>`;
  }

  const row = document.createElement('div');
  row.className = 'ch-row';
  row.innerHTML = `
    <span style="font-size:15px;text-align:center">${icon}</span>
    ${nameCell}
    <div class="row" style="gap:5px;flex-wrap:nowrap">
      <span class="${agentTagClass(agentId)}">${escHtml(agentId)}</span>
      ${chatTypeBadge}
    </div>
    <span class="badge" title="总 token" style="justify-self:center">${tokens}</span>
    <div class="cell-snippet" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${escHtml(lastMsg)}">${escHtml(lastMsg || '—')}</div>
    <span class="ts" style="white-space:nowrap">${lastTs ? fmtTs(lastTs) : '-'}</span>
    <div class="row" style="gap:5px;flex-wrap:nowrap">
      ${sessionId ? `<button class="btn-link" onclick="location.href='/activity?agent=${encodeURIComponent(agentId)}&sid=${encodeURIComponent(sessionId)}&from=channel'">历史</button>` : ''}
      ${sessionId ? `<button class="btn-copy" onclick="copySessionDetail('${escHtml(makeKey(agentId, sessionId))}')">复制</button>` : ''}
    </div>
  `;
  container.appendChild(row);
}

export function renderChannels() {
  const grid = document.getElementById('grid');
  const prevScroll = grid.scrollTop;
  grid.innerHTML = '';

  if (!channelData.length) {
    grid.innerHTML = '<div class="mono" style="padding:20px">暂无频道数据，等待 sessions.json 加载…</div>';
    return;
  }

  const sorted = [...channelData].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  const normal = sorted.filter(e => !isSystemChannel(e));
  const system = sorted.filter(e => isSystemChannel(e));

  const normalBlock = document.createElement('div');
  normalBlock.style.cssText = 'border:1px solid #1c2834;border-radius:10px;background:#0e1621;overflow:hidden';
  for (const entry of normal) {
    renderChannelRow(entry, normalBlock);
  }
  if (normal.length === 0) {
    normalBlock.innerHTML = '<div class="mono" style="padding:16px;color:#5c6b7f">暂无对话</div>';
  }
  grid.appendChild(normalBlock);

  if (system.length > 0) {
    const sysWrap = document.createElement('div');
    sysWrap.style.cssText = 'margin-top:4px';

    const sysHead = document.createElement('div');
    sysHead.className = 'ch-section-head';
    sysHead.innerHTML = `<span style="transition:transform .2s;transform:rotate(${systemChannelsExpanded ? '90' : '0'}deg)">▶</span> 系统 / 测试 <span class="badge" style="font-weight:400">${system.length}</span>`;
    sysHead.onclick = () => { setSystemChannelsExpanded(!systemChannelsExpanded); renderChannels(); };
    sysWrap.appendChild(sysHead);

    if (systemChannelsExpanded) {
      const sysBlock = document.createElement('div');
      sysBlock.style.cssText = 'border:1px solid #1c2834;border-radius:10px;background:#0e1621;overflow:hidden;opacity:.7';
      for (const entry of system) {
        renderChannelRow(entry, sysBlock);
      }
      sysWrap.appendChild(sysBlock);
    }
    grid.appendChild(sysWrap);
  }

  grid.scrollTop = prevScroll;
}
