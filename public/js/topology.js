import {
  topologyData, setTopologyData, topoNodes, setTopoNodes, topoEdges, setTopoEdges,
  topoSelectedNode, setTopoSelectedNode, topoSidePanelTab, setTopoSidePanelTab,
  topoPan, setTopoPan, topoZoom, setTopoZoom, topoHoverNode, setTopoHoverNode,
  topoDragging, setTopoDragging, topoPanStart, setTopoPanStart,
  topoAnimFrame, setTopoAnimFrame, topoPollingInterval, setTopoPollingInterval,
  topoEdgeDebounce, setTopoEdgeDebounce, topologyViewActive, setTopologyViewActive,
  topoTimeFilter, setTopoTimeFilter,
  topoSavedPositions, _saveTopoPositions, topoCustomNames, _saveTopoNames,
  topoHiddenSessions, _saveTopoHidden, topoDisplayName,
  showArchived, archived, channelViewActive, setChannelViewActive,
} from './state.js';
import { hexToRgb, formatCompactTokens, agentTagClass, escHtml } from './utils.js';

const AGENT_COLORS = {
  main: { fill: '#1a3a66', stroke: '#3a78ff', text: '#a9c7ff' },
  nanbosirui: { fill: '#1a4a33', stroke: '#4caf50', text: '#a5d6a7' },
  nanbosuikesi: { fill: '#3d1a55', stroke: '#9c27b0', text: '#e1bee7' },
  _default: { fill: '#2a2a2a', stroke: '#777', text: '#bbb' },
};
export function agentColor(id) { return AGENT_COLORS[id] || AGENT_COLORS._default; }

const CHANNEL_COLORS = {
  feishu: '#4a6fa5', yach: '#3a78ff', telegram: '#2196f3', slack: '#e91e63',
  webchat: '#26a69a', openai: '#10a37f', heartbeat: '#ff7043', subagent: '#9c27b0',
  main: '#546e7a', _default: '#455a64',
};
export function sessionNodeColor(ch) { return CHANNEL_COLORS[ch] || CHANNEL_COLORS._default; }

function topoTimeCutoff() {
  const now = Date.now();
  const d = new Date();
  switch (topoTimeFilter) {
    case 'today': { d.setHours(0, 0, 0, 0); return d.getTime(); }
    case '3d': return now - 3 * 86400000;
    case '7d': return now - 7 * 86400000;
    case '30d': return now - 30 * 86400000;
    default: return 0;
  }
}

export function changeTopoTimeFilter(v) {
  setTopoTimeFilter(v);
  document.querySelectorAll('.topo-time-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.filter === v);
  });
  computeTopologyLayout();
  renderTopoCanvas();
}

export async function pollTopology() {
  try {
    const r = await fetch('/api/topology', { cache: 'no-store' });
    if (!r.ok) return;
    setTopologyData(await r.json());
    computeTopologyLayout();
    if (topologyViewActive) renderTopoCanvas();
  } catch {}
}

export function computeTopologyLayout() {
  if (!topologyData) return;
  const { agents, contacts, contactEdges, agentEdges, agentEdgeSessions, subagents, systemSummary } = topologyData;
  const canvas = document.getElementById('topo-canvas');
  if (!canvas) return;
  const W = canvas.width / (window.devicePixelRatio || 1);
  const H = canvas.height / (window.devicePixelRatio || 1);
  const nodes = [];
  const nodeMap = new Map();

  // Time filter cutoff
  const cutoff = topoTimeCutoff();
  const sessionVisible = (s) => !topoHiddenSessions.has(s.id) && (!cutoff || (s.lastActiveTs && s.lastActiveTs >= cutoff));

  // Pre-compute which contacts have at least one visible session
  const contactVisibleCount = new Map();
  for (const ce of contactEdges) {
    const visible = (ce.sessions || []).filter(sessionVisible).length;
    contactVisibleCount.set(ce.contactId, (contactVisibleCount.get(ce.contactId) || 0) + visible);
  }

  const persons = contacts.filter(c => c.type === 'person' && (contactVisibleCount.get(c.id) || 0) > 0);
  const groups = contacts.filter(c => c.type === 'group' && (contactVisibleCount.get(c.id) || 0) > 0);

  const colPerson = W * 0.08;
  const colAgent = W * 0.52;
  const colGroup = W * 0.92;

  // Agent nodes (center column)
  const sortedAgents = [...agents].sort((a, b) => b.activeSessionCount - a.activeSessionCount || a.id.localeCompare(b.id));
  const agentSpacing = Math.max(90, (H - 80) / Math.max(sortedAgents.length, 1));
  const agentStartY = Math.max(50, (H - (sortedAgents.length - 1) * agentSpacing) / 2);
  sortedAgents.forEach((ag, i) => {
    const c = agentColor(ag.id);
    nodes.push({
      id: `agent:${ag.id}`, type: 'agent',
      x: colAgent, y: agentStartY + i * agentSpacing,
      r: 34, color: c.fill, stroke: c.stroke, textColor: c.text,
      label: topoDisplayName(`agent:${ag.id}`, ag.id), data: ag, column: 'agent',
    });
    nodeMap.set(`agent:${ag.id}`, nodes[nodes.length - 1]);
  });

  // Person nodes (left column)
  const personEdgeCount = (p) => contactEdges.filter(e => e.contactId === p.id).length;
  const sortedPersons = [...persons].sort((a, b) => personEdgeCount(b) - personEdgeCount(a));
  const personSpacing = Math.max(60, (H - 80) / Math.max(sortedPersons.length, 1));
  const personStartY = Math.max(40, (H - (sortedPersons.length - 1) * personSpacing) / 2);
  sortedPersons.forEach((c, i) => {
    const ch = c.channel || 'yach';
    nodes.push({
      id: c.id, type: 'contact', contactType: 'person',
      x: colPerson, y: personStartY + i * personSpacing,
      r: 22, color: CHANNEL_COLORS[ch] || '#455a64', stroke: '#3a5a80', textColor: '#cfe3ff',
      label: topoDisplayName(c.id, c.label), data: c, column: 'person',
    });
    nodeMap.set(c.id, nodes[nodes.length - 1]);
  });

  // Group nodes (right column)
  const groupEdgeCount = (g) => contactEdges.filter(e => e.contactId === g.id).length;
  const sortedGroups = [...groups].sort((a, b) => groupEdgeCount(b) - groupEdgeCount(a));
  const groupSpacing = Math.max(70, (H - 80) / Math.max(sortedGroups.length, 1));
  const groupStartY = Math.max(40, (H - (sortedGroups.length - 1) * groupSpacing) / 2);
  sortedGroups.forEach((c, i) => {
    const ch = c.channel || 'yach';
    nodes.push({
      id: c.id, type: 'contact', contactType: 'group',
      x: colGroup, y: groupStartY + i * groupSpacing,
      r: 24, color: CHANNEL_COLORS[ch] || '#455a64', stroke: '#3a5a80', textColor: '#cfe3ff',
      label: topoDisplayName(c.id, c.label), data: c, column: 'group',
    });
    nodeMap.set(c.id, nodes[nodes.length - 1]);
  });

  // System cluster node
  const totalSystem = Object.values(systemSummary || {}).reduce((a, b) => a + b, 0);
  if (totalSystem > 0) {
    const sysNode = {
      id: 'system:cluster', type: 'system',
      x: colAgent, y: H - 35,
      r: 16, color: '#2a2a2a', stroke: '#555', textColor: '#888',
      label: `系统 (${totalSystem})`, data: systemSummary, column: 'system',
    };
    nodes.push(sysNode);
    nodeMap.set(sysNode.id, sysNode);
  }

  // Subagent nodes — placed near their parent session (or parent agent as fallback)
  const subagentList = [];
  // Defer placement until after session nodes exist — collect first
  const pendingSubagents = [];
  if (subagents) {
    for (const [aid, subs] of Object.entries(subagents)) {
      const parentAgent = nodeMap.get(`agent:${aid}`);
      if (!parentAgent) continue;
      const visibleSubs = subs.filter(sessionVisible);
      for (const sub of visibleSubs) {
        pendingSubagents.push({ sub, aid, parentAgent });
      }
    }
  }

  // Vertical overlap prevention within columns
  const columns = { person: [], group: [], agent: [] };
  for (const n of nodes) { if (columns[n.column]) columns[n.column].push(n); }
  for (let iter = 0; iter < 60; iter++) {
    for (const col of Object.values(columns)) {
      col.sort((a, b) => a.y - b.y);
      for (let i = 0; i < col.length - 1; i++) {
        const a = col[i], b = col[i + 1];
        const minDist = a.r + b.r + 14;
        const dy = b.y - a.y;
        if (dy < minDist) {
          const push = (minDist - dy) * 0.55;
          a.y -= push; b.y += push;
        }
      }
      for (const n of col) { n.y = Math.max(n.r + 10, Math.min(H - n.r - 10, n.y)); }
    }
  }

  // Session nodes along contact→agent lines
  // Collect all session token counts for relative sizing
  const allSessionTokens = [];
  for (const ce of contactEdges) {
    for (const s of (ce.sessions || [])) {
      if (!sessionVisible(s)) continue;
      const tok = s.tokens ? (s.tokens.input || 0) + (s.tokens.output || 0) : 0;
      allSessionTokens.push(tok);
    }
  }
  const maxTok = Math.max(1, ...allSessionTokens);

  for (const ce of contactEdges) {
    const srcNode = nodeMap.get(ce.contactId);
    const tgtNode = nodeMap.get(`agent:${ce.agentId}`);
    if (!srcNode || !tgtNode) continue;
    const sessions = (ce.sessions || []).filter(sessionVisible);
    const count = sessions.length;
    const edgeDx = tgtNode.x - srcNode.x;
    const edgeDy = tgtNode.y - srcNode.y;
    const edgeLen = Math.sqrt(edgeDx * edgeDx + edgeDy * edgeDy) || 1;
    const perpX = -edgeDy / edgeLen;
    const perpY = edgeDx / edgeLen;
    sessions.forEach((sess, i) => {
      const t = 0.5;
      const perpOffset = count > 1 ? (i - (count - 1) / 2) * 32 : 0;
      const x = srcNode.x + edgeDx * t + perpX * perpOffset;
      const y = srcNode.y + edgeDy * t + perpY * perpOffset;
      const ch = ce.channel || 'yach';
      const chColor = CHANNEL_COLORS[ch] || '#455a64';
      const tok = sess.tokens ? (sess.tokens.input || 0) + (sess.tokens.output || 0) : 0;
      const ratio = Math.sqrt(tok / maxTok);
      const r = 12 + ratio * 14;
      const sNode = {
        id: `session:${sess.id}`, type: 'session',
        x, y, r,
        color: chColor, stroke: sess.isActive ? chColor : '#444', textColor: '#a8b3bf',
        label: topoDisplayName(`session:${sess.id}`, sess.label || sess.id.slice(0, 6)),
        data: { ...sess, contactId: ce.contactId, agentId: ce.agentId, channel: ce.channel, chatType: ce.chatType },
        contactNodeId: ce.contactId, agentNodeId: `agent:${ce.agentId}`,
        column: 'session',
      };
      nodes.push(sNode);
      nodeMap.set(sNode.id, sNode);
    });
  }

  // Place subagent nodes now that session nodes exist
  pendingSubagents.forEach((p, idx) => {
    const { sub, aid, parentAgent } = p;
    const parentSession = sub.parentSessionId ? nodeMap.get(`session:${sub.parentSessionId}`) : null;
    const anchor = parentSession || parentAgent;
    const offsetX = parentSession ? 60 : 80;
    const offsetY = (idx - (pendingSubagents.length - 1) / 2) * 36;
    const tok = sub.tokens ? (sub.tokens.input || 0) + (sub.tokens.output || 0) : 0;
    const r = 8 + Math.min(Math.sqrt(tok / 1000) * 4, 10);
    const sNode = {
      id: `subagent:${sub.id}`, type: 'subagent',
      x: anchor.x + offsetX, y: anchor.y + offsetY,
      r, color: '#9c27b0', stroke: sub.isActive ? '#ce93d8' : '#6a1b9a', textColor: '#e1bee7',
      label: topoDisplayName(`subagent:${sub.id}`, sub.label || sub.id.slice(0, 8)),
      data: { ...sub, agentId: aid }, parentAgentId: `agent:${aid}`,
      parentSessionNodeId: parentSession ? parentSession.id : null,
      column: 'subagent',
    };
    nodes.push(sNode);
    nodeMap.set(sNode.id, sNode);
    subagentList.push(sNode);
  });

  // Restore saved positions
  for (const n of nodes) {
    const saved = topoSavedPositions[n.id];
    if (saved) { n.x = saved.x; n.y = saved.y; }
  }

  // Session + subagent overlap prevention
  const sessionNodes = nodes.filter(n => n.type === 'session' || n.type === 'subagent');
  for (let iter = 0; iter < 50; iter++) {
    for (let i = 0; i < sessionNodes.length; i++) {
      if (topoSavedPositions[sessionNodes[i].id]) continue;
      for (let j = i + 1; j < sessionNodes.length; j++) {
        const a = sessionNodes[i], b = sessionNodes[j];
        let dx = b.x - a.x, dy = b.y - a.y;
        const dist = Math.sqrt(dx * dx + dy * dy) || 0.1;
        const minDist = a.r + b.r + 10;
        if (dist < minDist) {
          if (dist < 1) { dx = (Math.random() - 0.5) * 2; dy = (Math.random() - 0.5) * 2; }
          const push = (minDist - dist) / dist * 0.5;
          if (!topoSavedPositions[a.id]) { a.x -= dx * push; a.y -= dy * push; }
          if (!topoSavedPositions[b.id]) { b.x += dx * push; b.y += dy * push; }
        }
      }
    }
  }
  // Also check sessions against column nodes (contacts, agents)
  const colNodes = nodes.filter(n => n.type === 'contact' || n.type === 'agent');
  for (let iter = 0; iter < 20; iter++) {
    for (const sn of sessionNodes) {
      if (topoSavedPositions[sn.id]) continue;
      for (const cn of colNodes) {
        let dx = sn.x - cn.x, dy = sn.y - cn.y;
        const dist = Math.sqrt(dx * dx + dy * dy) || 0.1;
        const minDist = sn.r + cn.r + 6;
        if (dist < minDist) {
          if (dist < 1) { dx = 1; dy = 0; }
          const push = (minDist - dist) / dist * 0.6;
          sn.x += dx * push; sn.y += dy * push;
        }
      }
    }
  }

  // Build layout edges
  const layoutEdges = [];

  for (const ce of contactEdges) {
    const srcNode = nodeMap.get(ce.contactId);
    const tgtNode = nodeMap.get(`agent:${ce.agentId}`);
    if (!srcNode || !tgtNode) continue;
    const sessions = (ce.sessions || []).filter(sessionVisible);
    const ch = ce.channel || 'yach';
    const chColor = CHANNEL_COLORS[ch] || '#455a64';
    if (sessions.length === 0) {
      continue;
    } else {
      for (const s of sessions) {
        const sn = nodeMap.get(`session:${s.id}`);
        if (!sn) continue;
        layoutEdges.push({
          source: srcNode, target: sn,
          type: 'contact-line', color: chColor, thickness: 1.2,
          label: ch, isActive: ce.isActive, data: ce,
        });
        layoutEdges.push({
          source: sn, target: tgtNode,
          type: 'contact-line', color: chColor, thickness: 1.2,
          label: '', isActive: ce.isActive, data: ce,
        });
      }
    }
  }

  // Agent↔Agent edges (skip pairs that have agentEdgeSessions — those get session nodes instead)
  const agentSessionPairs = new Set();
  if (agentEdgeSessions) {
    for (const aes of agentEdgeSessions) {
      agentSessionPairs.add(`${aes.sourceAgent}:${aes.targetAgent}`);
    }
  }
  for (const ae of agentEdges) {
    const srcNode = nodeMap.get(`agent:${ae.sourceAgent}`);
    const tgtNode = nodeMap.get(`agent:${ae.targetAgent}`);
    if (!srcNode || !tgtNode || srcNode === tgtNode) continue;
    // Skip 'send' edges that have explicit session nodes
    if (ae.type === 'send' && agentSessionPairs.has(`${ae.sourceAgent}:${ae.targetAgent}`)) continue;
    let color = '#3a78ff';
    if (ae.type === 'spawn' || ae.type === 'spawn-result') color = '#9c27b0';
    if (ae.meta && ae.meta.status === 'error') color = '#f44336';
    if (ae.meta && ae.meta.status === 'forbidden') color = '#ff9800';
    layoutEdges.push({
      source: srcNode, target: tgtNode,
      type: ae.type, color, thickness: 2,
      label: ae.type === 'spawn' ? 'spawn' : ae.type === 'send' ? 'send' : ae.type === 'send-incoming' ? 'recv' : ae.type,
      isActive: false, dashed: true, data: ae,
    });
  }

  // Agent-edge session nodes (inter-agent communication sessions)
  if (agentEdgeSessions && agentEdgeSessions.length) {
    // Group by sourceAgent:targetAgent pair for offset calculation
    const pairGroups = new Map();
    for (const aes of agentEdgeSessions) {
      const pairKey = `${aes.sourceAgent}:${aes.targetAgent}`;
      if (!pairGroups.has(pairKey)) pairGroups.set(pairKey, []);
      pairGroups.get(pairKey).push(aes);
    }
    for (const [pairKey, sessions] of pairGroups) {
      const [srcAgentId, tgtAgentId] = pairKey.split(':');
      const srcNode = nodeMap.get(`agent:${srcAgentId}`);
      const tgtNode = nodeMap.get(`agent:${tgtAgentId}`);
      if (!srcNode || !tgtNode || srcNode === tgtNode) continue;
      const edgeDx = tgtNode.x - srcNode.x;
      const edgeDy = tgtNode.y - srcNode.y;
      const edgeLen = Math.sqrt(edgeDx * edgeDx + edgeDy * edgeDy) || 1;
      const perpX = -edgeDy / edgeLen;
      const perpY = edgeDx / edgeLen;
      const count = sessions.length;
      sessions.forEach((aes, i) => {
        const t = 0.5;
        const perpOffset = count > 1 ? (i - (count - 1) / 2) * 28 : 0;
        const x = srcNode.x + edgeDx * t + perpX * perpOffset;
        const y = srcNode.y + edgeDy * t + perpY * perpOffset;
        const color = aes.edgeType === 'spawn' ? '#9c27b0' : '#3a78ff';
        const tok = aes.tokens ? (aes.tokens.input || 0) + (aes.tokens.output || 0) : 0;
        const r = 10 + Math.min(Math.sqrt(tok / 1000) * 3, 8);
        const sNode = {
          id: `agent-session:${aes.id}`, type: 'agent-session',
          x, y, r,
          color, stroke: aes.isActive ? color : '#444', textColor: '#a8b3bf',
          label: topoDisplayName(`agent-session:${aes.id}`, aes.messagePreview ? aes.messagePreview.slice(0, 20) : `${srcAgentId}→${tgtAgentId}`),
          data: aes,
          sourceAgentNodeId: `agent:${srcAgentId}`,
          targetAgentNodeId: `agent:${tgtAgentId}`,
          column: 'agent-session',
        };
        nodes.push(sNode);
        nodeMap.set(sNode.id, sNode);
        // Edges: source agent → session node → target agent
        layoutEdges.push({
          source: srcNode, target: sNode,
          type: 'agent-session-line', color, thickness: 1.5,
          label: '', isActive: aes.isActive, dashed: true, data: aes,
        });
        layoutEdges.push({
          source: sNode, target: tgtNode,
          type: 'agent-session-line', color, thickness: 1.5,
          label: aes.edgeType || 'send', isActive: aes.isActive, dashed: true, data: aes,
        });
      });
    }
  }

  // Subagent edges: parent session → subagent (or agent → subagent as fallback)
  for (const sn of subagentList) {
    const parentSession = sn.parentSessionNodeId ? nodeMap.get(sn.parentSessionNodeId) : null;
    const parentNode = parentSession || nodeMap.get(sn.parentAgentId);
    if (!parentNode) continue;
    layoutEdges.push({
      source: parentNode, target: sn,
      type: 'subagent', color: '#9c27b0', thickness: 1.5,
      label: 'spawn', isActive: sn.data && sn.data.isActive, dashed: true, data: sn.data,
    });
  }

  setTopoNodes(nodes);
  setTopoEdges(layoutEdges);
}

export function renderTopoCanvas() {
  const canvas = document.getElementById('topo-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const W = canvas.width / dpr;
  const H = canvas.height / dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  ctx.save();
  ctx.translate(topoPan.x, topoPan.y);
  ctx.scale(topoZoom, topoZoom);

  // Build highlight set from selected node
  const hlNodes = new Set();
  const hlEdges = new Set();
  if (topoSelectedNode) {
    const sel = topoSelectedNode;
    if (sel.type === 'session') {
      const sn = topoNodes.find(n => n.id === sel.id);
      if (sn) {
        hlNodes.add(sn.id);
        if (sn.contactNodeId) hlNodes.add(sn.contactNodeId);
        if (sn.agentNodeId) hlNodes.add(sn.agentNodeId);
        // Also highlight subagents spawned from this session
        for (const n of topoNodes) {
          if (n.type === 'subagent' && n.parentSessionNodeId === sn.id) hlNodes.add(n.id);
        }
      }
    } else if (sel.type === 'contact') {
      hlNodes.add(sel.id);
      for (const n of topoNodes) {
        if (n.type === 'session' && n.contactNodeId === sel.id) {
          hlNodes.add(n.id);
          if (n.agentNodeId) hlNodes.add(n.agentNodeId);
        }
      }
    } else if (sel.type === 'agent') {
      hlNodes.add(sel.id);
      for (const n of topoNodes) {
        if (n.type === 'session' && n.agentNodeId === sel.id) {
          hlNodes.add(n.id);
          if (n.contactNodeId) hlNodes.add(n.contactNodeId);
        }
        if (n.type === 'subagent' && n.parentAgentId === sel.id) hlNodes.add(n.id);
      }
    } else if (sel.type === 'subagent') {
      hlNodes.add(sel.id);
      const sn = topoNodes.find(n => n.id === topoSelectedNode.id);
      if (sn) {
        if (sn.parentAgentId) hlNodes.add(sn.parentAgentId);
        if (sn.parentSessionNodeId) hlNodes.add(sn.parentSessionNodeId);
      }
    } else if (sel.type === 'agent-session') {
      hlNodes.add(sel.id);
      const sn = topoNodes.find(n => n.id === sel.id);
      if (sn) {
        if (sn.sourceAgentNodeId) hlNodes.add(sn.sourceAgentNodeId);
        if (sn.targetAgentNodeId) hlNodes.add(sn.targetAgentNodeId);
      }
    }
    for (const e of topoEdges) {
      if (hlNodes.has(e.source.id) && hlNodes.has(e.target.id)) hlEdges.add(e);
    }
  }
  const hasHighlight = hlNodes.size > 0;

  // Contact-line edges
  for (const e of topoEdges) {
    if (e.type === 'contact-line') {
      const sx = e.source.x, sy = e.source.y;
      const tx = e.target.x, ty = e.target.y;
      const isHl = hlEdges.has(e);
      ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(tx, ty);
      if (isHl) {
        ctx.save();
        ctx.shadowColor = e.color; ctx.shadowBlur = 10;
        ctx.strokeStyle = e.color; ctx.lineWidth = 2.5;
        ctx.setLineDash([]); ctx.stroke();
        ctx.restore();
      } else {
        ctx.strokeStyle = hasHighlight
          ? `rgba(${hexToRgb(e.color)}, 0.08)`
          : e.isActive ? `rgba(${hexToRgb(e.color)}, 0.5)` : `rgba(${hexToRgb(e.color)}, 0.2)`;
        ctx.lineWidth = e.thickness || 1.2;
        ctx.setLineDash([]); ctx.stroke();
      }
      if (e.label) {
        const mx = (sx + tx) / 2, my = (sy + ty) / 2;
        ctx.font = '9px -apple-system, sans-serif';
        ctx.fillStyle = isHl ? 'rgba(200,220,240,.8)' : 'rgba(200,220,240,.45)';
        ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
        ctx.fillText(e.label, mx, my - 3);
      }
    }
  }

  // Agent-session-line edges (straight, dashed)
  for (const e of topoEdges) {
    if (e.type !== 'agent-session-line') continue;
    const sx = e.source.x, sy = e.source.y;
    const tx = e.target.x, ty = e.target.y;
    const isHl = hlEdges.has(e);
    ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(tx, ty);
    if (isHl) {
      ctx.save();
      ctx.shadowColor = e.color; ctx.shadowBlur = 10;
      ctx.strokeStyle = e.color; ctx.lineWidth = 2;
      ctx.setLineDash([6, 4]); ctx.stroke(); ctx.setLineDash([]);
      ctx.restore();
    } else {
      ctx.strokeStyle = hasHighlight
        ? `rgba(${hexToRgb(e.color)}, 0.08)`
        : e.isActive ? `rgba(${hexToRgb(e.color)}, 0.5)` : `rgba(${hexToRgb(e.color)}, 0.2)`;
      ctx.lineWidth = e.thickness || 1.5;
      ctx.setLineDash([6, 4]); ctx.stroke(); ctx.setLineDash([]);
    }
    if (e.label) {
      const mx = (sx + tx) / 2, my = (sy + ty) / 2;
      ctx.font = '9px -apple-system, sans-serif';
      ctx.fillStyle = isHl ? 'rgba(200,220,240,.8)' : 'rgba(200,220,240,.45)';
      ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
      ctx.fillText(e.label, mx, my - 3);
    }
  }

  // Agent↔agent curved edges with arrowheads
  for (const e of topoEdges) {
    if (e.type === 'contact-line' || e.type === 'agent-session-line') continue;
    const sx = e.source.x, sy = e.source.y;
    const tx = e.target.x, ty = e.target.y;
    const mx = (sx + tx) / 2, my = (sy + ty) / 2;
    const ddx = tx - sx, ddy = ty - sy;
    const len = Math.sqrt(ddx * ddx + ddy * ddy) || 1;
    const nx = -ddy / len, ny = ddx / len;
    const cpx = mx + nx * len * 0.25, cpy = my + ny * len * 0.25;
    ctx.beginPath(); ctx.moveTo(sx, sy); ctx.quadraticCurveTo(cpx, cpy, tx, ty);
    ctx.strokeStyle = e.color; ctx.lineWidth = e.thickness || 2;
    ctx.setLineDash(e.dashed ? [6, 4] : []); ctx.stroke(); ctx.setLineDash([]);
    const t = 0.85;
    const ax = (1-t)*(1-t)*sx + 2*(1-t)*t*cpx + t*t*tx;
    const ay = (1-t)*(1-t)*sy + 2*(1-t)*t*cpy + t*t*ty;
    const adx = tx - ax, ady = ty - ay;
    const aLen = Math.sqrt(adx*adx + ady*ady) || 1;
    const ux = adx / aLen, uy = ady / aLen;
    ctx.beginPath();
    ctx.moveTo(tx - e.target.r * ux, ty - e.target.r * uy);
    ctx.lineTo(tx - (e.target.r + 8) * ux - 4 * (-uy), ty - (e.target.r + 8) * uy - 4 * ux);
    ctx.lineTo(tx - (e.target.r + 8) * ux + 4 * (-uy), ty - (e.target.r + 8) * uy + 4 * ux);
    ctx.closePath(); ctx.fillStyle = e.color; ctx.fill();
    ctx.font = '10px -apple-system, sans-serif';
    ctx.fillStyle = 'rgba(200,220,240,.6)';
    ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
    ctx.fillText(e.label || e.type, cpx, cpy - 6);
  }

  // Draw nodes
  const now = Date.now();
  for (const n of topoNodes) {
    const isSelected = topoSelectedNode && topoSelectedNode.id === n.id;
    const isHovered = topoHoverNode && topoHoverNode.id === n.id;
    const isHl = hlNodes.has(n.id);
    const isDim = hasHighlight && !isHl;

    if (n.type === 'session') {
      const recentMs = 30 * 60 * 1000;
      const shouldPulse = n.data && n.data.lastActiveTs && (now - n.data.lastActiveTs < recentMs);
      if (isHl && !isSelected) {
        ctx.save(); ctx.shadowColor = n.color; ctx.shadowBlur = 14;
        ctx.beginPath(); ctx.arc(n.x, n.y, n.r + 2, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(${hexToRgb(n.color)}, 0.35)`; ctx.fill();
        ctx.restore();
      }
      if (shouldPulse && !isDim) {
        const ageMs = now - n.data.lastActiveTs;
        const isFresh = ageMs < 5 * 60 * 1000;
        const speed = isFresh ? 500 : 1200;
        const pulse = Math.sin(now / speed) * 0.5 + 0.5;
        const glowR = n.r + 6 + pulse * 8;
        const glowColor = isFresh ? '0,230,118' : '255,183,77';
        ctx.save();
        ctx.shadowColor = `rgba(${glowColor},0.8)`; ctx.shadowBlur = 12 + pulse * 10;
        ctx.beginPath(); ctx.arc(n.x, n.y, glowR, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(${glowColor}, ${0.08 + pulse * 0.18})`; ctx.fill();
        ctx.restore();
        ctx.beginPath(); ctx.arc(n.x, n.y, n.r + 3 + pulse * 3, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(${glowColor}, ${0.3 + pulse * 0.5})`; ctx.lineWidth = 1.5; ctx.stroke();
      }
      ctx.globalAlpha = isDim ? 0.2 : 1;
      ctx.beginPath(); ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2);
      ctx.fillStyle = shouldPulse ? n.color : `rgba(${hexToRgb(n.color)}, 0.4)`;
      ctx.fill();
      ctx.strokeStyle = isSelected ? '#fff' : isHl ? '#ddd' : isHovered ? '#ccc' : n.stroke;
      ctx.lineWidth = isSelected ? 2 : isHl ? 1.8 : isHovered ? 1.5 : 0.8;
      ctx.stroke();
      const tok = n.data && n.data.tokens ? n.data.tokens.input + n.data.tokens.output : 0;
      if (n.r >= 16 && tok > 0) {
        const fs = Math.max(8, Math.min(11, n.r * 0.65));
        ctx.font = `${fs}px -apple-system, sans-serif`;
        ctx.fillStyle = 'rgba(255,255,255,0.85)'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(formatCompactTokens(tok), n.x, n.y);
      }
      if (isHovered || isSelected || isHl) {
        ctx.font = '10px -apple-system, sans-serif';
        ctx.fillStyle = '#cfe3ff'; ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
        ctx.fillText(n.label, n.x, n.y - n.r - 4);
      }
      ctx.globalAlpha = 1;
      continue;
    }

    if (n.type === 'agent-session') {
      ctx.globalAlpha = isDim ? 0.2 : 1;
      // Dashed-border diamond shape
      const dr = n.r;
      ctx.beginPath();
      ctx.moveTo(n.x, n.y - dr);
      ctx.lineTo(n.x + dr, n.y);
      ctx.lineTo(n.x, n.y + dr);
      ctx.lineTo(n.x - dr, n.y);
      ctx.closePath();
      ctx.fillStyle = isHl ? `rgba(${hexToRgb(n.color)}, 0.4)` : `rgba(${hexToRgb(n.color)}, 0.2)`;
      ctx.fill();
      ctx.strokeStyle = isSelected ? '#fff' : isHl ? '#ddd' : isHovered ? '#ccc' : n.stroke;
      ctx.lineWidth = isSelected ? 2 : isHl ? 1.8 : isHovered ? 1.5 : 1;
      ctx.setLineDash([3, 2]); ctx.stroke(); ctx.setLineDash([]);
      // Token count label
      const tok = n.data && n.data.tokens ? (n.data.tokens.input || 0) + (n.data.tokens.output || 0) : 0;
      if (tok > 0 && n.r >= 12) {
        const fs = Math.max(7, Math.min(10, n.r * 0.6));
        ctx.font = `${fs}px -apple-system, sans-serif`;
        ctx.fillStyle = 'rgba(255,255,255,0.85)'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(formatCompactTokens(tok), n.x, n.y);
      }
      // Label on hover/select
      if (isHovered || isSelected || isHl) {
        ctx.font = '9px -apple-system, sans-serif';
        ctx.fillStyle = '#cfe3ff'; ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
        const lb = n.data && n.data.edgeType ? n.data.edgeType : 'send';
        ctx.fillText(`${lb}`, n.x, n.y - n.r - 3);
      }
      ctx.globalAlpha = 1;
      continue;
    }

    if (n.type === 'system') {
      ctx.globalAlpha = isDim ? 0.2 : 1;
      ctx.beginPath(); ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2);
      ctx.fillStyle = n.color; ctx.fill();
      ctx.strokeStyle = isSelected ? '#fff' : n.stroke; ctx.lineWidth = 1; ctx.stroke();
      ctx.font = '9px -apple-system, sans-serif';
      ctx.fillStyle = n.textColor; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('SYS', n.x, n.y);
      ctx.fillStyle = '#666'; ctx.textBaseline = 'top';
      ctx.fillText(n.label, n.x, n.y + n.r + 4);
      ctx.globalAlpha = 1;
      continue;
    }

    if (n.type === 'subagent') {
      if (isHl && !isSelected) {
        ctx.save(); ctx.shadowColor = '#9c27b0'; ctx.shadowBlur = 14;
      }
      ctx.globalAlpha = isDim ? 0.2 : 1;
      // Hexagon shape for subagent
      const sides = 6, r = n.r;
      ctx.beginPath();
      for (let s = 0; s < sides; s++) {
        const angle = (Math.PI / 3) * s - Math.PI / 2;
        const px = n.x + r * Math.cos(angle), py = n.y + r * Math.sin(angle);
        s === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
      }
      ctx.closePath();
      ctx.fillStyle = isHl ? 'rgba(156,39,176,0.35)' : 'rgba(156,39,176,0.18)'; ctx.fill();
      ctx.strokeStyle = isSelected ? '#fff' : isHl ? '#e1bee7' : isHovered ? '#ce93d8' : n.stroke;
      ctx.lineWidth = isSelected ? 2 : 1.2; ctx.stroke();
      if (isHl && !isSelected) ctx.restore();
      ctx.font = '8px -apple-system, sans-serif';
      ctx.fillStyle = isDim ? 'rgba(225,190,231,0.3)' : n.textColor;
      ctx.textAlign = 'center'; ctx.textBaseline = 'top';
      const sl = n.label.length > 14 ? n.label.slice(0, 13) + '..' : n.label;
      ctx.fillText(sl, n.x, n.y + n.r + 3);
      ctx.globalAlpha = 1;
      continue;
    }

    if (n.type === 'contact' && n.contactType === 'group') {
      if (isHl && !isSelected) {
        ctx.save(); ctx.shadowColor = n.color; ctx.shadowBlur = 16;
      }
      ctx.globalAlpha = isDim ? 0.2 : 1;
      ctx.font = '10px -apple-system, sans-serif';
      const textW = ctx.measureText(n.label).width;
      const w = Math.max(n.r * 2.4, textW + 20), h = n.r * 1.6, rx = 6;
      n._boxW = w; n._boxH = h;
      ctx.beginPath();
      ctx.moveTo(n.x - w/2 + rx, n.y - h/2);
      ctx.lineTo(n.x + w/2 - rx, n.y - h/2);
      ctx.quadraticCurveTo(n.x + w/2, n.y - h/2, n.x + w/2, n.y - h/2 + rx);
      ctx.lineTo(n.x + w/2, n.y + h/2 - rx);
      ctx.quadraticCurveTo(n.x + w/2, n.y + h/2, n.x + w/2 - rx, n.y + h/2);
      ctx.lineTo(n.x - w/2 + rx, n.y + h/2);
      ctx.quadraticCurveTo(n.x - w/2, n.y + h/2, n.x - w/2, n.y + h/2 - rx);
      ctx.lineTo(n.x - w/2, n.y - h/2 + rx);
      ctx.quadraticCurveTo(n.x - w/2, n.y - h/2, n.x - w/2 + rx, n.y - h/2);
      ctx.closePath();
      ctx.fillStyle = isHl ? `rgba(${hexToRgb(n.color)}, 0.35)` : `rgba(${hexToRgb(n.color)}, 0.2)`; ctx.fill();
      ctx.strokeStyle = isSelected ? '#fff' : isHl ? '#ddd' : isHovered ? '#aaa' : n.color;
      ctx.lineWidth = isSelected ? 2.5 : isHl ? 2.2 : isHovered ? 2 : 1.2; ctx.stroke();
      if (isHl && !isSelected) ctx.restore();
      ctx.fillStyle = isDim ? `rgba(${hexToRgb(n.textColor)}, 0.3)` : n.textColor;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(n.label, n.x, n.y);
      ctx.font = '9px -apple-system, sans-serif';
      ctx.fillStyle = isDim ? 'rgba(136,136,136,0.3)' : '#888'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
      ctx.fillText(`${n.data.sessionCount}s`, n.x + w/2 + 6, n.y);
      ctx.globalAlpha = 1;
      continue;
    }

    if (n.type === 'contact' && n.contactType === 'person') {
      if (isHl && !isSelected) {
        ctx.save(); ctx.shadowColor = n.color; ctx.shadowBlur = 16;
      }
      ctx.globalAlpha = isDim ? 0.2 : 1;
      ctx.beginPath(); ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2);
      ctx.fillStyle = isHl ? `rgba(${hexToRgb(n.color)}, 0.35)` : `rgba(${hexToRgb(n.color)}, 0.2)`; ctx.fill();
      ctx.strokeStyle = isSelected ? '#fff' : isHl ? '#ddd' : isHovered ? '#aaa' : n.color;
      ctx.lineWidth = isSelected ? 2.5 : isHl ? 2.2 : isHovered ? 2 : 1.2; ctx.stroke();
      if (isHl && !isSelected) ctx.restore();
      const firstChar = n.label.charAt(0);
      ctx.font = 'bold 16px -apple-system, sans-serif';
      ctx.fillStyle = isDim ? `rgba(${hexToRgb(n.textColor)}, 0.3)` : n.textColor;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(firstChar, n.x, n.y);
      ctx.font = '11px -apple-system, sans-serif';
      ctx.fillStyle = isDim ? 'rgba(207,227,255,0.2)' : '#cfe3ff'; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
      ctx.fillText(n.label, n.x - n.r - 8, n.y);
      ctx.globalAlpha = 1;
      continue;
    }

    if (n.type === 'agent') {
      if (isHl && !isSelected) {
        ctx.save(); ctx.shadowColor = n.stroke; ctx.shadowBlur = 18;
      }
      ctx.globalAlpha = isDim ? 0.2 : 1;
      ctx.beginPath(); ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2);
      ctx.fillStyle = n.color; ctx.fill();
      ctx.strokeStyle = isSelected ? '#fff' : isHl ? '#ddd' : isHovered ? '#aaa' : n.stroke;
      ctx.lineWidth = isSelected ? 2.5 : isHl ? 2.5 : isHovered ? 2 : 1.2; ctx.stroke();
      if (isHl && !isSelected) ctx.restore();
      ctx.font = 'bold 13px -apple-system, sans-serif';
      ctx.fillStyle = isDim ? `rgba(${hexToRgb(n.textColor)}, 0.3)` : n.textColor;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(n.label, n.x, n.y);
      ctx.font = '10px -apple-system, sans-serif';
      ctx.fillStyle = isDim ? 'rgba(200,220,240,.15)' : 'rgba(200,220,240,.5)'; ctx.textBaseline = 'top';
      ctx.textAlign = 'center';
      ctx.fillText(`${n.data.activeSessionCount || 0}s`, n.x, n.y + n.r + 4);
      const totalTok = n.data.totalTokens ? n.data.totalTokens.input + n.data.totalTokens.output : 0;
      if (totalTok > 0) ctx.fillText(formatCompactTokens(totalTok), n.x, n.y + n.r + 16);
      if (n.data.status === 'active') {
        ctx.beginPath(); ctx.arc(n.x + n.r - 4, n.y - n.r + 4, 5, 0, Math.PI * 2);
        ctx.fillStyle = '#4caf50'; ctx.fill();
        ctx.strokeStyle = '#0e1621'; ctx.lineWidth = 2; ctx.stroke();
      }
      ctx.globalAlpha = 1;
      continue;
    }
  }

  // Hidden sessions indicator
  if (topoHiddenSessions.size > 0) {
    ctx.font = '10px -apple-system, sans-serif';
    ctx.fillStyle = 'rgba(200,200,200,.4)'; ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
    ctx.fillText(`${topoHiddenSessions.size} hidden sessions`, 10, H - 10);
  }

  ctx.restore();
}

export function _setTopoTabForNodeType(type) {
  if (type === 'agent') setTopoSidePanelTab('agent');
  else if (type === 'contact') setTopoSidePanelTab('contact');
  else setTopoSidePanelTab('session');
  document.querySelectorAll('.topo-tab').forEach((t, i) => {
    t.classList.toggle('active', (topoSidePanelTab === 'agent' && i === 0) || (topoSidePanelTab === 'contact' && i === 1) || (topoSidePanelTab === 'session' && i === 2));
  });
}

function startTopoAnimation() {
  if (topoAnimFrame) return;
  function loop() {
    if (!topologyViewActive) { setTopoAnimFrame(null); return; }
    renderTopoCanvas();
    setTopoAnimFrame(requestAnimationFrame(loop));
  }
  setTopoAnimFrame(requestAnimationFrame(loop));
}

export function topoHitTest(mx, my) {
  const x = (mx - topoPan.x) / topoZoom;
  const y = (my - topoPan.y) / topoZoom;
  for (let i = topoNodes.length - 1; i >= 0; i--) {
    const n = topoNodes[i];
    if (n.type === 'contact' && n.contactType === 'group') {
      const w = n._boxW || n.r * 2.4, h = n._boxH || n.r * 1.6;
      if (x >= n.x - w/2 - 4 && x <= n.x + w/2 + 4 && y >= n.y - h/2 - 4 && y <= n.y + h/2 + 4) return n;
    } else {
      const dx = x - n.x, dy = y - n.y;
      if (dx * dx + dy * dy <= (n.r + 4) * (n.r + 4)) return n;
    }
  }
  return null;
}

export function setupTopoCanvasEvents() {
  const canvas = document.getElementById('topo-canvas');
  if (!canvas || canvas._topoEventsAttached) return;
  canvas._topoEventsAttached = true;

  canvas.addEventListener('mousedown', (e) => {
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;
    const hit = topoHitTest(mx, my);
    if (hit) {
      setTopoDragging({ node: hit, offsetX: (mx - topoPan.x) / topoZoom - hit.x, offsetY: (my - topoPan.y) / topoZoom - hit.y, startX: e.clientX, startY: e.clientY });
    } else {
      setTopoPanStart({ x: topoPan.x, y: topoPan.y, mx: e.clientX, my: e.clientY });
    }
  });

  canvas.addEventListener('mousemove', (e) => {
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;
    if (topoDragging) {
      topoDragging.node.x = (mx - topoPan.x) / topoZoom - topoDragging.offsetX;
      topoDragging.node.y = (my - topoPan.y) / topoZoom - topoDragging.offsetY;
      return;
    }
    if (topoPanStart) {
      topoPan.x = topoPanStart.x + (e.clientX - topoPanStart.mx);
      topoPan.y = topoPanStart.y + (e.clientY - topoPanStart.my);
      return;
    }
    const hit = topoHitTest(mx, my);
    setTopoHoverNode(hit);
    canvas.style.cursor = hit ? 'pointer' : 'grab';
  });

  canvas.addEventListener('mouseup', (e) => {
    if (topoDragging) {
      const moved = Math.abs(e.clientX - topoDragging.startX) + Math.abs(e.clientY - topoDragging.startY);
      const clickedNode = topoDragging.node;
      // BUG FIX #2: Save position on drag
      if (moved > 5) {
        topoSavedPositions[clickedNode.id] = { x: clickedNode.x, y: clickedNode.y };
        _saveTopoPositions();
      }
      setTopoDragging(null);
      if (moved <= 5) {
        setTopoSelectedNode({ type: clickedNode.type, id: clickedNode.id });
        _setTopoTabForNodeType(clickedNode.type);
        renderTopoSidePanel();
      }
      return;
    }
    if (topoPanStart) {
      const moved = Math.abs(e.clientX - topoPanStart.mx) + Math.abs(e.clientY - topoPanStart.my);
      setTopoPanStart(null);
      if (moved > 5) return;
    }
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;
    const hit = topoHitTest(mx, my);
    if (hit) {
      setTopoSelectedNode({ type: hit.type, id: hit.id });
      _setTopoTabForNodeType(hit.type);
      renderTopoSidePanel();
    } else {
      setTopoSelectedNode(null);
      renderTopoSidePanel();
    }
  });

  canvas.addEventListener('mouseleave', () => {
    setTopoDragging(null);
    setTopoPanStart(null);
    setTopoHoverNode(null);
  });

  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;
    const delta = e.deltaY > 0 ? 0.9 : 1.1;
    const newZoom = Math.max(0.3, Math.min(3.0, topoZoom * delta));
    topoPan.x = mx - (mx - topoPan.x) * (newZoom / topoZoom);
    topoPan.y = my - (my - topoPan.y) * (newZoom / topoZoom);
    setTopoZoom(newZoom);
  }, { passive: false });

  // BUG FIX #3: Double-click custom naming
  canvas.addEventListener('dblclick', (e) => {
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;
    const hit = topoHitTest(mx, my);
    if (!hit) return;
    const current = topoCustomNames[hit.id] || '';
    const name = prompt(`自定义名称 (${hit.id}):`, current);
    if (name === null) return;
    if (name.trim()) {
      topoCustomNames[hit.id] = name.trim();
    } else {
      delete topoCustomNames[hit.id];
    }
    _saveTopoNames();
    if (topologyData) { computeTopologyLayout(); renderTopoCanvas(); }
    renderTopoSidePanel();
  });
}

export function resizeTopoCanvas() {
  const wrap = document.getElementById('topo-canvas-wrap');
  const canvas = document.getElementById('topo-canvas');
  if (!wrap || !canvas) return;
  const dpr = window.devicePixelRatio || 1;
  const w = wrap.clientWidth;
  const h = wrap.clientHeight;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  canvas.style.width = w + 'px';
  canvas.style.height = h + 'px';
  if (topologyData) { computeTopologyLayout(); renderTopoCanvas(); }
}

// BUG FIX #4: Reset clears saved positions
export function topoZoomIn() { setTopoZoom(Math.min(3, topoZoom * 1.2)); }
export function topoZoomOut() { setTopoZoom(Math.max(0.3, topoZoom / 1.2)); }

export function resetTopology() {
  setTopoPan({ x: 0, y: 0 });
  setTopoZoom(1);
  for (const k of Object.keys(topoSavedPositions)) delete topoSavedPositions[k];
  _saveTopoPositions();
  if (topologyData) { computeTopologyLayout(); renderTopoCanvas(); }
}

export async function topoResetSession(agentId, sessionId) {
  if (!confirm(`确定要重置此 Session 吗？\n\n${sessionId}\n\nJSONL 文件将被重命名备份，sessions.json 映射将被移除。\n该 Session 下次收到消息时会自动创建新会话。`)) return;
  try {
    const r = await fetch('/session-reset', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentId, sessionId }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { alert(`重置失败：${j.error || r.statusText}`); return; }
    topoHiddenSessions.add(sessionId);
    _saveTopoHidden();
    setTopoSelectedNode(null);
    _sessionTimelineCache.delete(`${agentId}:${sessionId}`);
    pollTopology();
  } catch (e) { alert(`重置失败：${String(e && e.message || e)}`); }
}

export async function topoCloseSession(agentId, sessionId) {
  if (!confirm(`确定要关闭此 Session 吗？\n\n${sessionId}\n\n文件将被软删除，可在「已删除」面板恢复。`)) return;
  try {
    const r = await fetch(`/session-delete?agent=${encodeURIComponent(agentId)}&sid=${encodeURIComponent(sessionId)}`, { method: 'POST' });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { alert(`关闭失败：${j.error || r.statusText}`); return; }
    topoHiddenSessions.add(sessionId);
    _saveTopoHidden();
    setTopoSelectedNode(null);
    _sessionTimelineCache.delete(`${agentId}:${sessionId}`);
    pollTopology();
  } catch (e) { alert(`关闭失败：${String(e && e.message || e)}`); }
}

export function hideSession(sessionId) {
  topoHiddenSessions.add(sessionId);
  _saveTopoHidden();
  if (topologyData) { computeTopologyLayout(); renderTopoCanvas(); }
  renderTopoSidePanel();
}

// BUG FIX #6: Restore hidden session
export function restoreHiddenSession(sessionId) {
  topoHiddenSessions.delete(sessionId);
  _saveTopoHidden();
  if (topologyData) { computeTopologyLayout(); renderTopoCanvas(); }
  renderTopoSidePanel();
}

export function restoreAllHiddenSessions() {
  topoHiddenSessions.clear();
  _saveTopoHidden();
  if (topologyData) { computeTopologyLayout(); renderTopoCanvas(); }
  renderTopoSidePanel();
}

export function renderTopologyView() {
  const grid = document.getElementById('grid');
  if (!document.getElementById('topo-wrapper')) {
    grid.innerHTML = `
      <div id="topo-wrapper">
        <div id="topo-canvas-wrap">
          <canvas id="topo-canvas"></canvas>
          <div class="topo-controls">
            <button onclick="topoZoomIn()" title="放大">+</button>
            <button onclick="topoZoomOut()" title="缩小">-</button>
            <button onclick="resetTopology()" title="重置">R</button>
          </div>
          <div class="topo-time-filter">
            <button class="topo-time-btn ${topoTimeFilter==='today'?'active':''}" data-filter="today" onclick="changeTopoTimeFilter('today')">今天</button>
            <button class="topo-time-btn ${topoTimeFilter==='3d'?'active':''}" data-filter="3d" onclick="changeTopoTimeFilter('3d')">3天</button>
            <button class="topo-time-btn ${topoTimeFilter==='7d'?'active':''}" data-filter="7d" onclick="changeTopoTimeFilter('7d')">7天</button>
            <button class="topo-time-btn ${topoTimeFilter==='30d'?'active':''}" data-filter="30d" onclick="changeTopoTimeFilter('30d')">30天</button>
            <button class="topo-time-btn ${topoTimeFilter==='all'?'active':''}" data-filter="all" onclick="changeTopoTimeFilter('all')">全部</button>
          </div>
          <div class="topo-legend">
            <div class="topo-legend-row"><div class="topo-legend-circle" style="background:rgba(58,120,255,.2);border:1px solid #3a78ff;width:14px;height:14px"></div> 人物</div>
            <div class="topo-legend-row"><div style="width:14px;height:10px;border-radius:3px;background:rgba(58,120,255,.2);border:1px solid #3a78ff"></div> 群聊</div>
            <div class="topo-legend-row"><div class="topo-legend-circle" style="background:#1a3a66;border:1px solid #3a78ff"></div> Agent</div>
            <div class="topo-legend-row"><div class="topo-legend-line" style="background:#3a78ff"></div> yach</div>
            <div class="topo-legend-row"><div class="topo-legend-line" style="background:#4a6fa5"></div> feishu</div>
            <div class="topo-legend-row"><div class="topo-legend-line" style="background:#9c27b0;border-style:dashed"></div> spawn/send</div>
          </div>
        </div>
        <div id="topo-side">
          <div class="topo-tabs">
            <div class="topo-tab ${topoSidePanelTab==='agent'?'active':''}" onclick="setTopoSidePanelTab('agent');document.querySelectorAll('.topo-tab').forEach((t,i)=>{t.classList.toggle('active',i===0)});renderTopoSidePanel()">Agent</div>
            <div class="topo-tab ${topoSidePanelTab==='contact'?'active':''}" onclick="setTopoSidePanelTab('contact');document.querySelectorAll('.topo-tab').forEach((t,i)=>{t.classList.toggle('active',i===1)});renderTopoSidePanel()">联系人</div>
            <div class="topo-tab ${topoSidePanelTab==='session'?'active':''}" onclick="setTopoSidePanelTab('session');document.querySelectorAll('.topo-tab').forEach((t,i)=>{t.classList.toggle('active',i===2)});renderTopoSidePanel()">Session</div>
          </div>
          <div id="topo-panel"><div class="mono" style="padding:20px;color:#7aa2d5">点击节点查看详情</div></div>
        </div>
      </div>`;
    requestAnimationFrame(() => {
      resizeTopoCanvas();
      setupTopoCanvasEvents();
      if (topologyData) { computeTopologyLayout(); renderTopoCanvas(); }
    });
  }
  const btnToggle = document.getElementById('btn-toggle-archived');
  if (btnToggle) btnToggle.textContent = showArchived ? '隐藏归档' : `显示归档 (${archived.size})`;
}

export function renderTopoSidePanel() {
  const panel = document.getElementById('topo-panel');
  if (!panel) return;
  if (!topoSelectedNode) {
    panel.innerHTML = '<div class="mono" style="padding:20px;color:#7aa2d5">点击节点查看详情</div>';
    return;
  }
  // Session nodes bypass tabs — show full detail directly
  if (topoSelectedNode.type === 'session') {
    renderSessionFullDetail(panel);
    return;
  }
  // Subagent nodes — show compact detail
  if (topoSelectedNode.type === 'subagent') {
    renderSubagentDetail(panel);
    return;
  }
  // Agent-session nodes — show inter-agent communication detail
  if (topoSelectedNode.type === 'agent-session') {
    renderAgentSessionDetail(panel);
    return;
  }
  if (topoSidePanelTab === 'agent') {
    renderTopoAgentPanel(panel);
  } else if (topoSidePanelTab === 'contact') {
    renderTopoContactPanel(panel);
  } else {
    renderTopoSessionPanel(panel);
  }
}

function renderTopoContactPanel(panel) {
  if (!topologyData || !topoSelectedNode) { panel.innerHTML = '<div class="mono" style="padding:20px;color:#7aa2d5">点击联系人节点查看详情</div>'; return; }
  let contactId = null;
  if (topoSelectedNode.type === 'contact') contactId = topoSelectedNode.id;
  if (!contactId) { panel.innerHTML = '<div class="mono" style="padding:20px;color:#7aa2d5">点击联系人节点查看详情</div>'; return; }
  const contact = topologyData.contacts.find(c => c.id === contactId);
  if (!contact) { panel.innerHTML = '<div class="mono" style="padding:20px">未找到联系人</div>'; return; }

  const edges = topologyData.contactEdges.filter(e => e.contactId === contactId);
  const totalTokensIn = edges.reduce((s, e) => s + e.tokens.input, 0);
  const totalTokensOut = edges.reduce((s, e) => s + e.tokens.output, 0);
  // BUG FIX #1: sessionIds → sessions
  const totalSessions = edges.reduce((s, e) => s + (e.sessions || []).length, 0);
  const activeEdges = edges.filter(e => e.isActive);
  const chColor = CHANNEL_COLORS[contact.channel] || '#455a64';

  let html = `<div class="topo-section">
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;flex-wrap:wrap">
      <div class="badge" style="border-color:${chColor};color:${chColor};font-size:13px;padding:3px 8px">${contact.type === 'group' ? '群' : '人'} ${escHtml(contact.label)}</div>
      <div class="badge" style="border-color:${chColor};color:${chColor}">${escHtml(contact.channel)}</div>
      ${activeEdges.length > 0 ? '<div class="badge" style="border-color:#4caf50;color:#a5d6a7">active</div>' : ''}
    </div>
    <div class="mono" style="font-size:10px;color:#455a64">${escHtml(contactId)}</div>
  </div>`;

  html += `<div class="topo-section"><div class="topo-section-title">概览</div><div class="topo-kv">`;
  html += `<div class="topo-kv-label">总会话</div><div class="topo-kv-value">${totalSessions}</div>`;
  html += `<div class="topo-kv-label">对话 Agent</div><div class="topo-kv-value">${edges.length}</div>`;
  html += `<div class="topo-kv-label">活跃连接</div><div class="topo-kv-value" style="color:${activeEdges.length ? '#4caf50' : '#888'}">${activeEdges.length}</div>`;
  html += `<div class="topo-kv-label">Tokens In</div><div class="topo-kv-value">${formatCompactTokens(totalTokensIn)}</div>`;
  html += `<div class="topo-kv-label">Tokens Out</div><div class="topo-kv-value">${formatCompactTokens(totalTokensOut)}</div>`;
  html += `<div class="topo-kv-label">Total</div><div class="topo-kv-value">${formatCompactTokens(totalTokensIn + totalTokensOut)}</div>`;
  html += `</div></div>`;

  html += `<div class="topo-section"><div class="topo-section-title">对话的 Agent (${edges.length})</div><div class="topo-session-list">`;
  for (const e of edges) {
    const c = agentColor(e.agentId);
    const tok = e.tokens.input + e.tokens.output;
    html += `<div class="topo-session-row" onclick="topoSelectAgent('${escHtml(e.agentId)}')">
      <div class="topo-dot" style="background:${e.isActive ? '#4caf50' : '#555'}"></div>
      <span class="badge ${agentTagClass(e.agentId).replace('agent-tag ','')} agent-tag" style="font-size:11px">${escHtml(e.agentId)}</span>
      <span style="color:#7aa2d5;font-size:10px;margin-left:auto">${escHtml(e.channel)} × ${(e.sessions || []).length}</span>
      <span style="color:#4caf50;font-size:10px">${formatCompactTokens(tok)}</span>
    </div>`;
  }
  html += `</div></div>`;

  panel.innerHTML = html;
}

function renderTopoAgentPanel(panel) {
  if (!topologyData || !topoSelectedNode) { panel.innerHTML = '<div class="mono" style="padding:20px;color:#7aa2d5">点击 Agent 节点查看详情</div>'; return; }
  let agentId = null;
  if (topoSelectedNode.type === 'agent') {
    agentId = topoSelectedNode.id.replace('agent:', '');
  } else if (topoSelectedNode.type === 'contact') {
    const firstEdge = topologyData.contactEdges.find(e => e.contactId === topoSelectedNode.id);
    if (firstEdge) agentId = firstEdge.agentId;
  }
  if (!agentId) { panel.innerHTML = '<div class="mono" style="padding:20px">未找到 Agent</div>'; return; }

  const ag = topologyData.agents.find(a => a.id === agentId);
  const agContactEdges = topologyData.contactEdges.filter(e => e.agentId === agentId);
  const agAgentEdges = topologyData.agentEdges.filter(e => e.sourceAgent === agentId || e.targetAgent === agentId);
  const sendOut = agAgentEdges.filter(e => e.sourceAgent === agentId && e.type === 'send');
  const sendIn = agAgentEdges.filter(e => e.targetAgent === agentId && e.type === 'send-incoming');
  const spawns = agAgentEdges.filter(e => e.sourceAgent === agentId && e.type === 'spawn');

  let html = `<div class="topo-section">
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:10px">
      <div class="badge ${agentTagClass(agentId).replace('agent-tag ','')} agent-tag" style="font-size:14px;padding:4px 10px">${escHtml(agentId)}</div>
      <div class="badge" style="border-color:${ag && ag.status === 'active' ? '#4caf50' : '#555'};color:${ag && ag.status === 'active' ? '#a5d6a7' : '#888'}">${ag ? ag.status : 'unknown'}</div>
    </div>
  </div>`;

  html += `<div class="topo-section"><div class="topo-section-title">概览</div><div class="topo-kv">`;
  html += `<div class="topo-kv-label">Sessions</div><div class="topo-kv-value">${ag ? ag.activeSessionCount : 0} active / ${ag ? ag.sessionCount : 0} total</div>`;
  if (ag && ag.totalTokens) {
    const total = ag.totalTokens.input + ag.totalTokens.output;
    html += `<div class="topo-kv-label">Tokens</div><div class="topo-kv-value">${formatCompactTokens(ag.totalTokens.input)} in / ${formatCompactTokens(ag.totalTokens.output)} out (${formatCompactTokens(total)} total)</div>`;
  }
  html += `<div class="topo-kv-label">联系人</div><div class="topo-kv-value">${agContactEdges.length}</div>`;
  html += `<div class="topo-kv-label">Send 发出</div><div class="topo-kv-value">${sendOut.length}</div>`;
  html += `<div class="topo-kv-label">Send 收到</div><div class="topo-kv-value">${sendIn.length}</div>`;
  html += `<div class="topo-kv-label">Spawn</div><div class="topo-kv-value">${spawns.length}</div>`;
  html += `</div></div>`;

  if (agContactEdges.length) {
    html += `<div class="topo-section"><div class="topo-section-title">联系人 (${agContactEdges.length})</div><div class="topo-session-list">`;
    for (const ce of agContactEdges) {
      const contact = topologyData.contacts.find(c => c.id === ce.contactId);
      if (!contact) continue;
      const tok = ce.tokens.input + ce.tokens.output;
      // BUG FIX #1: sessionIds → sessions
      html += `<div class="topo-session-row" onclick="topoSelectContact('${escHtml(ce.contactId)}')">
        <div class="topo-dot" style="background:${ce.isActive ? '#4caf50' : '#555'}"></div>
        <span style="color:#cfe3ff">${contact.type === 'group' ? '群 ' : ''}${escHtml(contact.label)}</span>
        <span style="color:#7aa2d5;font-size:10px;margin-left:auto">${escHtml(ce.channel)} × ${(ce.sessions || []).length}</span>
        <span style="color:#4caf50;font-size:10px">${formatCompactTokens(tok)}</span>
      </div>`;
    }
    html += `</div></div>`;
  }

  const channels = [...new Set(agContactEdges.map(e => e.channel))];
  if (channels.length) {
    html += `<div class="topo-section"><div class="topo-section-title">频道</div><div style="display:flex;flex-wrap:wrap;gap:4px">`;
    for (const ch of channels) {
      html += `<div class="badge" style="border-color:${sessionNodeColor(ch)};color:${sessionNodeColor(ch)}">${escHtml(ch)}</div>`;
    }
    html += `</div></div>`;
  }

  if (agAgentEdges.length) {
    html += `<div class="topo-section"><div class="topo-section-title">Agent 间关系 (${agAgentEdges.length})</div><div class="topo-edge-list">`;
    for (const e of agAgentEdges.slice(-15)) {
      const dir = e.sourceAgent === agentId ? '→' : '←';
      const other = e.sourceAgent === agentId ? (e.targetAgent || '?') : (e.sourceAgent || '?');
      const typeLabel = e.type === 'spawn' ? 'spawn' : e.type === 'spawn-result' ? 'result' : e.type === 'send-incoming' ? 'recv' : 'send';
      const status = e.meta && e.meta.status ? ` [${e.meta.status}]` : '';
      html += `<div class="topo-edge-row">${typeLabel} ${dir} <span style="color:${agentColor(other).text}">${escHtml(other)}</span>${status}</div>`;
    }
    html += `</div></div>`;
  }

  panel.innerHTML = html;
}

let _sessionTimelineCache = new Map();

function fmtTimelineDur(ms) {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60000).toFixed(1)}m`;
}

function fmtTimelineTs(ts) {
  try {
    const d = new Date(typeof ts === 'number' ? ts : Date.parse(ts));
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${mm}-${dd} ${d.toLocaleTimeString()}.${String(d.getMilliseconds()).padStart(3, '0')}`;
  } catch { return String(ts); }
}

function renderTimelineEvent(e) {
  const roleColors = {
    user: { border: '#4caf50', bg: 'rgba(76,175,80,.08)', label: 'User', labelColor: '#a5d6a7' },
    assistant: { border: '#3a78ff', bg: 'rgba(58,120,255,.06)', label: 'Bot', labelColor: '#a9c7ff' },
    toolResult: { border: '#e88b4d', bg: 'rgba(232,139,77,.06)', label: 'Tool', labelColor: '#f5c6a0' },
    system: { border: '#555', bg: 'rgba(85,85,85,.06)', label: 'System', labelColor: '#999' },
  };
  const rc = roleColors[e.role] || roleColors.system;
  const isToolCall = !!e.toolName;
  if (isToolCall) { rc.border = '#e91e63'; rc.label = 'ToolCall'; rc.labelColor = '#f48fb1'; }
  if (e.type === 'thinking_level_change') { rc.label = 'Think'; rc.labelColor = '#ce93d8'; rc.border = '#9c27b0'; }
  if (e.type === 'session') { rc.label = 'Session'; rc.labelColor = '#90a4ae'; rc.border = '#607d8b'; }

  let content = '';
  if (e.type === 'thinking_level_change' && e.thinkingLevel) {
    content = `<div style="font-size:11px;color:#ce93d8">thinking → <b>${escHtml(e.thinkingLevel)}</b></div>`;
  }
  if (e.type === 'session' && e.cwd) {
    content = `<div style="font-size:11px;color:#90a4ae;font-family:monospace">${escHtml(e.cwd)}</div>`;
  }
  if (e.textPreview) {
    const text = String(e.textPreview).trim();
    content = `<div style="font-size:12px;line-height:1.5;color:#dce3ea;white-space:pre-wrap;max-height:200px;overflow:auto">${escHtml(text.length > 600 ? text.slice(0, 600) + '…' : text)}</div>`;
  }
  if (isToolCall) {
    content += `<div style="margin-top:4px;padding:4px 6px;background:#0b0f14;border:1px solid #242f3d;border-radius:4px;font-size:11px;font-family:monospace;color:#7aa2d5">🛠 ${escHtml(e.toolName)}${e.toolArgs ? `<div style="color:#a8b3bf;margin-top:2px;max-height:120px;overflow:auto;white-space:pre-wrap">${escHtml(String(e.toolArgs).slice(0, 400))}</div>` : ''}</div>`;
  }
  if (e.role === 'toolResult' && e.resultToolName) {
    content += `<div style="font-size:11px;color:#e88b4d">↩ ${escHtml(e.resultToolName)}${e.isError ? ' <span style="color:#ef5350">[ERROR]</span>' : ''}</div>`;
  }
  if (e.errorMessage) {
    content += `<div style="font-size:11px;color:#ef5350;margin-top:2px">${escHtml(e.errorMessage)}</div>`;
  }
  if (!content && e.type && e.type !== 'message') {
    content = `<div style="font-size:11px;color:#6c7883;font-style:italic">${escHtml(e.type)}${e.customType ? ` · ${escHtml(e.customType)}` : ''}</div>`;
  }

  let usageHtml = '';
  if (e.usage) {
    const inp = e.usage.input || 0;
    const out = e.usage.output || 0;
    if (inp || out) usageHtml = `<span style="color:#536270;font-size:10px">${formatCompactTokens(inp)}/${formatCompactTokens(out)}</span>`;
  }

  return `<div style="border-left:3px solid ${rc.border};background:${rc.bg};border-radius:0 4px 4px 0;padding:6px 8px;margin-bottom:2px">
    <div style="display:flex;align-items:center;gap:6px;margin-bottom:${content ? '4px' : '0'}">
      <span style="font-size:10px;font-weight:600;color:${rc.labelColor};min-width:44px">${rc.label}</span>
      <span style="font-size:10px;color:#6c7883">${e.ts ? fmtTimelineTs(e.ts) : ''}</span>
      ${e.model ? `<span style="font-size:9px;color:#ce9178">${escHtml(e.model)}</span>` : ''}
      <span style="flex:1"></span>
      ${usageHtml}
    </div>
    ${content}
  </div>`;
}

function renderSubagentDetail(panel) {
  if (!topoSelectedNode || topoSelectedNode.type !== 'subagent') {
    panel.innerHTML = '<div class="mono" style="padding:20px;color:#7aa2d5">点击 Subagent 查看详情</div>'; return;
  }
  const sn = topoNodes.find(n => n.id === topoSelectedNode.id);
  if (!sn || !sn.data) { panel.innerHTML = '<div class="mono" style="padding:20px">未找到 Subagent</div>'; return; }
  const d = sn.data;
  const totalTok = d.tokens ? (d.tokens.input || 0) + (d.tokens.output || 0) : 0;
  const parentAgent = topologyData.agents.find(a => a.id === d.agentId);

  let html = `<div style="padding:8px 12px">
    <div class="row" style="gap:6px;flex-wrap:wrap;margin-bottom:6px">
      <span class="badge" style="border-color:#9c27b0;color:#ce93d8">Subagent</span>
      <span class="badge" style="border-color:${d.isActive ? '#35c46a' : '#555'};color:${d.isActive ? '#a5d6a7' : '#888'}">${d.isActive ? 'active' : 'ended'}</span>
      ${parentAgent ? `<span class="${agentTagClass(d.agentId)}">${escHtml(d.agentId)}</span>` : ''}
      <span class="badge">${formatCompactTokens(totalTok)}</span>
    </div>
    <div class="mono" style="font-size:10px;color:#546e7a;margin-bottom:4px">${escHtml(d.id)}</div>
    ${d.label ? `<div style="font-size:12px;color:#cfe3ff;margin-bottom:8px;line-height:1.4">${escHtml(d.label)}</div>` : ''}
  </div>`;

  // Action buttons
  html += `<div class="topo-section" style="display:flex;gap:6px;flex-wrap:wrap;padding:4px 12px">`;
  if (d.agentId && d.id) {
    html += `<button class="btn-link" style="font-size:11px" onclick="window.open('/activity?agent=${encodeURIComponent(d.agentId)}&sid=${encodeURIComponent(d.id)}','_blank')">新窗口打开</button>`;
    html += `<button class="btn-danger" style="font-size:11px" onclick="topoCloseSession('${escHtml(d.agentId)}','${escHtml(d.id)}')">关闭</button>`;
  }
  html += `<button class="btn-archive" style="font-size:11px" onclick="hideSession('${escHtml(d.id || '')}')">隐藏</button>`;
  html += `</div>`;

  // Timeline
  html += `<div id="topo-session-timeline" style="margin-top:4px;padding:0 12px"><div class="mono" style="padding:12px;color:#7aa2d5;font-size:11px">加载时间轴…</div></div>`;
  panel.innerHTML = html;

  if (d.agentId && d.id) {
    const cacheKey = `${d.agentId}:${d.id}`;
    const cached = _sessionTimelineCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < 30000) {
      _renderTimelineInto(cached.items);
    } else {
      fetch(`/api/session-history?agent=${encodeURIComponent(d.agentId)}&sid=${encodeURIComponent(d.id)}&limit=200`, { cache: 'no-store' })
        .then(r => r.ok ? r.json() : null)
        .then(j => {
          if (!j || !Array.isArray(j.items)) {
            const el = document.getElementById('topo-session-timeline');
            if (el) el.innerHTML = '<div class="mono" style="padding:12px;color:#ef5350;font-size:11px">无法加载时间轴数据</div>';
            return;
          }
          _sessionTimelineCache.set(cacheKey, { items: j.items, ts: Date.now() });
          _renderTimelineInto(j.items);
        })
        .catch(() => {
          const el = document.getElementById('topo-session-timeline');
          if (el) el.innerHTML = '<div class="mono" style="padding:12px;color:#ef5350;font-size:11px">加载失败</div>';
        });
    }
  }
}

function renderAgentSessionDetail(panel) {
  if (!topoSelectedNode || topoSelectedNode.type !== 'agent-session') {
    panel.innerHTML = '<div class="mono" style="padding:20px;color:#7aa2d5">点击 Agent 间通信节点查看详情</div>'; return;
  }
  const sn = topoNodes.find(n => n.id === topoSelectedNode.id);
  if (!sn || !sn.data) { panel.innerHTML = '<div class="mono" style="padding:20px">未找到通信记录</div>'; return; }
  const d = sn.data;
  const totalTok = d.tokens ? (d.tokens.input || 0) + (d.tokens.output || 0) : 0;
  const edgeColor = d.edgeType === 'spawn' ? '#9c27b0' : '#3a78ff';

  let html = `<div style="padding:8px 12px">
    <div class="row" style="gap:6px;flex-wrap:wrap;margin-bottom:6px">
      <span class="badge" style="border-color:${edgeColor};color:${edgeColor};font-size:13px;padding:3px 8px">Agent 通信</span>
      <span class="badge" style="border-color:${d.isActive ? '#4caf50' : '#555'};color:${d.isActive ? '#a5d6a7' : '#888'}">${d.isActive ? 'active' : 'idle'}</span>
      <span class="badge" style="border-color:${edgeColor};color:${edgeColor}">${escHtml(d.edgeType || 'send')}</span>
    </div>
    <div style="display:flex;align-items:center;gap:6px;margin-bottom:6px">
      <span class="${agentTagClass(d.sourceAgent)}" style="cursor:pointer" onclick="topoSelectAgent('${escHtml(d.sourceAgent)}')">${escHtml(d.sourceAgent)}</span>
      <span style="color:#7aa2d5;font-size:14px">→</span>
      <span class="${agentTagClass(d.targetAgent)}" style="cursor:pointer" onclick="topoSelectAgent('${escHtml(d.targetAgent)}')">${escHtml(d.targetAgent)}</span>
    </div>
    ${d.tokens ? `<div style="font-size:11px;color:#4caf50;margin-bottom:4px">${formatCompactTokens(totalTok)} tokens</div>` : ''}
    ${d.messagePreview ? `<div style="font-size:11px;color:#a8b3bf;margin-bottom:4px;line-height:1.4;max-height:60px;overflow:auto;white-space:pre-wrap">${escHtml(d.messagePreview)}</div>` : ''}
    ${d.status ? `<div style="font-size:10px;color:#6c7883">状态: ${escHtml(d.status)}</div>` : ''}
    ${d.ts ? `<div style="font-size:10px;color:#6c7883">${fmtTimelineTs(d.ts)}</div>` : ''}
  </div>`;

  // Action buttons
  html += `<div class="topo-section" style="display:flex;gap:6px;flex-wrap:wrap;padding:4px 12px">`;
  if (d.sourceAgent && d.sourceSessionId) {
    html += `<button class="btn-link" style="font-size:11px" onclick="window.open('/activity?agent=${encodeURIComponent(d.sourceAgent)}&sid=${encodeURIComponent(d.sourceSessionId)}','_blank')">发送方会话</button>`;
  }
  if (d.targetAgent && d.targetSessionId) {
    html += `<button class="btn-link" style="font-size:11px" onclick="window.open('/activity?agent=${encodeURIComponent(d.targetAgent)}&sid=${encodeURIComponent(d.targetSessionId)}','_blank')">接收方会话</button>`;
  }
  html += `</div>`;

  // Source session timeline
  html += `<div style="padding:4px 12px"><div style="font-size:11px;color:#7aa2d5;font-weight:600;margin-bottom:4px">发送方时间轴 (${escHtml(d.sourceAgent)})</div></div>`;
  html += `<div id="topo-session-timeline" style="margin-top:0;padding:0 12px"><div class="mono" style="padding:12px;color:#7aa2d5;font-size:11px">加载时间轴…</div></div>`;

  // Target session timeline container
  if (d.targetAgent && d.targetSessionId) {
    html += `<div style="padding:8px 12px 4px"><div style="font-size:11px;color:#7aa2d5;font-weight:600;margin-bottom:4px">接收方时间轴 (${escHtml(d.targetAgent)})</div></div>`;
    html += `<div id="topo-target-timeline" style="margin-top:0;padding:0 12px"><div class="mono" style="padding:12px;color:#7aa2d5;font-size:11px">加载时间轴…</div></div>`;
  }

  panel.innerHTML = html;

  // Load source session timeline
  if (d.sourceAgent && d.sourceSessionId) {
    const cacheKey = `${d.sourceAgent}:${d.sourceSessionId}`;
    const cached = _sessionTimelineCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < 30000) {
      _renderTimelineInto(cached.items);
    } else {
      fetch(`/api/session-history?agent=${encodeURIComponent(d.sourceAgent)}&sid=${encodeURIComponent(d.sourceSessionId)}&limit=200`, { cache: 'no-store' })
        .then(r => r.ok ? r.json() : null)
        .then(j => {
          if (!j || !Array.isArray(j.items)) {
            const el = document.getElementById('topo-session-timeline');
            if (el) el.innerHTML = '<div class="mono" style="padding:12px;color:#ef5350;font-size:11px">无法加载时间轴数据</div>';
            return;
          }
          _sessionTimelineCache.set(cacheKey, { items: j.items, ts: Date.now() });
          _renderTimelineInto(j.items);
        })
        .catch(() => {
          const el = document.getElementById('topo-session-timeline');
          if (el) el.innerHTML = '<div class="mono" style="padding:12px;color:#ef5350;font-size:11px">加载失败</div>';
        });
    }
  }

  // Load target session timeline
  if (d.targetAgent && d.targetSessionId) {
    const cacheKey = `${d.targetAgent}:${d.targetSessionId}`;
    const cached = _sessionTimelineCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < 30000) {
      _renderTargetTimelineInto(cached.items);
    } else {
      fetch(`/api/session-history?agent=${encodeURIComponent(d.targetAgent)}&sid=${encodeURIComponent(d.targetSessionId)}&limit=200`, { cache: 'no-store' })
        .then(r => r.ok ? r.json() : null)
        .then(j => {
          if (!j || !Array.isArray(j.items)) {
            const el = document.getElementById('topo-target-timeline');
            if (el) el.innerHTML = '<div class="mono" style="padding:12px;color:#ef5350;font-size:11px">无法加载</div>';
            return;
          }
          _sessionTimelineCache.set(cacheKey, { items: j.items, ts: Date.now() });
          _renderTargetTimelineInto(j.items);
        })
        .catch(() => {
          const el = document.getElementById('topo-target-timeline');
          if (el) el.innerHTML = '<div class="mono" style="padding:12px;color:#ef5350;font-size:11px">加载失败</div>';
        });
    }
  }
}

function _renderTargetTimelineInto(items) {
  const el = document.getElementById('topo-target-timeline');
  if (!el) return;
  if (!items.length) {
    el.innerHTML = '<div class="mono" style="padding:12px;color:#7aa2d5;font-size:11px">暂无事件</div>';
    return;
  }
  const sorted = [...items].sort((a, b) => {
    const ta = typeof a.ts === 'number' ? a.ts : new Date(a.ts).getTime();
    const tb = typeof b.ts === 'number' ? b.ts : new Date(b.ts).getTime();
    return tb - ta;
  });
  let html = `<div style="font-size:11px;color:#6c7883;margin-bottom:6px">${items.length} events</div>`;
  for (const e of sorted) {
    html += renderTimelineEvent(e);
  }
  el.innerHTML = html;
}

function renderSessionFullDetail(panel) {
  if (!topologyData || !topoSelectedNode) { panel.innerHTML = '<div class="mono" style="padding:20px;color:#7aa2d5">点击 Session 查看详情</div>'; return; }
  const sNode = topoNodes.find(n => n.id === topoSelectedNode.id);
  if (!sNode || !sNode.data) { panel.innerHTML = '<div class="mono" style="padding:20px">未找到 Session</div>'; return; }
  const d = sNode.data;
  const totalTok = d.tokens ? d.tokens.input + d.tokens.output : 0;
  const chColor = CHANNEL_COLORS[d.channel] || '#455a64';

  const contact = topologyData.contacts.find(c => c.id === d.contactId);
  const agent = topologyData.agents.find(a => a.id === d.agentId);
  const contactEdge = topologyData.contactEdges.find(e => e.contactId === d.contactId && e.agentId === d.agentId);

  let html = '';

  // --- Compact header ---
  html += `<div class="topo-section" style="padding-bottom:6px">
    <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
      <div class="badge" style="border-color:${chColor};color:${chColor};font-size:13px;padding:3px 8px">Session</div>
      <div class="badge" style="border-color:${d.isActive?'#4caf50':'#555'};color:${d.isActive?'#a5d6a7':'#888'}">${d.isActive ? 'active' : 'idle'}</div>
      ${agent ? `<span class="badge ${agentTagClass(d.agentId).replace('agent-tag ','')} agent-tag" style="font-size:11px;cursor:pointer" onclick="topoSelectAgent('${escHtml(d.agentId)}')">${escHtml(d.agentId)}</span>` : ''}
      ${d.tokens ? `<span style="color:#4caf50;font-size:11px;font-weight:600">${formatCompactTokens(totalTok)}</span>` : ''}
    </div>
    <div class="mono" style="font-size:10px;color:#546e7a;margin-top:4px">${escHtml(d.id)}</div>
    ${contact ? `<div style="font-size:11px;color:#7aa2d5;margin-top:3px;cursor:pointer" onclick="topoSelectContact('${escHtml(d.contactId)}')">${contact.type === 'group' ? '群 ' : ''}${escHtml(contact.label)} · ${escHtml(d.channel || '')} · ${escHtml(d.chatType || '')}</div>` : ''}
  </div>`;

  // --- Action buttons ---
  html += `<div class="topo-section" style="display:flex;gap:6px;flex-wrap:wrap;padding:4px 0">`;
  if (d.agentId && d.id) {
    html += `<button class="btn-link" style="font-size:11px" onclick="window.open('/activity?agent=${encodeURIComponent(d.agentId)}&sid=${encodeURIComponent(d.id)}','_blank')">新窗口打开</button>`;
    html += `<button class="btn-danger" style="font-size:11px" onclick="topoCloseSession('${escHtml(d.agentId)}','${escHtml(d.id)}')">关闭 Session</button>`;
    html += `<button class="btn-archive" style="font-size:11px;border-color:#b57d20;color:#f5c842" onclick="topoResetSession('${escHtml(d.agentId)}','${escHtml(d.id)}')">重置 Session</button>`;
  }
  html += `<button class="btn-archive" style="font-size:11px" onclick="hideSession('${escHtml(d.id || '')}')">隐藏</button>`;
  html += `</div>`;

  // --- Timeline container (loads async) ---
  html += `<div id="topo-session-timeline" style="margin-top:4px"><div class="mono" style="padding:12px;color:#7aa2d5;font-size:11px">加载时间轴…</div></div>`;

  // Hidden sessions restore UI
  if (topoHiddenSessions.size > 0) {
    html += `<div class="topo-section" style="margin-top:16px;border-top:1px solid #1c2834;padding-top:10px">
      <div class="topo-section-title">已隐藏 Sessions (${topoHiddenSessions.size})</div>
      <div style="display:flex;flex-direction:column;gap:4px">`;
    for (const sid of topoHiddenSessions) {
      html += `<div style="display:flex;align-items:center;gap:6px;font-size:11px">
        <span class="mono" style="color:#7aa2d5;flex:1;overflow:hidden;text-overflow:ellipsis">${escHtml(sid)}</span>
        <button class="btn-link" style="padding:1px 6px;font-size:10px" onclick="restoreHiddenSession('${escHtml(sid)}')">恢复</button>
      </div>`;
    }
    html += `</div>
      <button class="btn-link" style="margin-top:6px;font-size:11px" onclick="restoreAllHiddenSessions()">恢复全部</button>
    </div>`;
  }

  panel.innerHTML = html;

  // Fetch and render timeline
  if (d.agentId && d.id) {
    const cacheKey = `${d.agentId}:${d.id}`;
    const cached = _sessionTimelineCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < 30000) {
      _renderTimelineInto(cached.items);
    } else {
      fetch(`/api/session-history?agent=${encodeURIComponent(d.agentId)}&sid=${encodeURIComponent(d.id)}&limit=200`, { cache: 'no-store' })
        .then(r => r.ok ? r.json() : null)
        .then(j => {
          if (!j || !Array.isArray(j.items)) {
            const el = document.getElementById('topo-session-timeline');
            if (el) el.innerHTML = '<div class="mono" style="padding:12px;color:#ef5350;font-size:11px">无法加载时间轴数据</div>';
            return;
          }
          _sessionTimelineCache.set(cacheKey, { items: j.items, ts: Date.now() });
          _renderTimelineInto(j.items);
        })
        .catch(() => {
          const el = document.getElementById('topo-session-timeline');
          if (el) el.innerHTML = '<div class="mono" style="padding:12px;color:#ef5350;font-size:11px">加载失败</div>';
        });
    }
  }
}

function _renderTimelineInto(items) {
  const el = document.getElementById('topo-session-timeline');
  if (!el) return;
  if (!items.length) {
    el.innerHTML = '<div class="mono" style="padding:12px;color:#7aa2d5;font-size:11px">暂无事件</div>';
    return;
  }
  const sorted = [...items].sort((a, b) => {
    const ta = typeof a.ts === 'number' ? a.ts : new Date(a.ts).getTime();
    const tb = typeof b.ts === 'number' ? b.ts : new Date(b.ts).getTime();
    return tb - ta;
  });
  let html = `<div style="font-size:11px;color:#6c7883;margin-bottom:6px;display:flex;justify-content:space-between;align-items:center">
    <span>时间轴 (${items.length} events)</span>
    <button class="btn-link" style="font-size:10px;padding:1px 6px" onclick="_topoRefreshTimeline()">刷新</button>
  </div>`;
  for (const e of sorted) {
    html += renderTimelineEvent(e);
  }
  el.innerHTML = html;
}

export function _topoRefreshTimeline() {
  if (!topoSelectedNode) return;
  const sNode = topoNodes.find(n => n.id === topoSelectedNode.id);
  if (!sNode || !sNode.data) return;
  const d = sNode.data;

  if (topoSelectedNode.type === 'agent-session') {
    // Refresh source timeline
    if (d.sourceAgent && d.sourceSessionId) {
      const cacheKey = `${d.sourceAgent}:${d.sourceSessionId}`;
      _sessionTimelineCache.delete(cacheKey);
      const el = document.getElementById('topo-session-timeline');
      if (el) el.innerHTML = '<div class="mono" style="padding:12px;color:#7aa2d5;font-size:11px">加载中…</div>';
      fetch(`/api/session-history?agent=${encodeURIComponent(d.sourceAgent)}&sid=${encodeURIComponent(d.sourceSessionId)}&limit=200`, { cache: 'no-store' })
        .then(r => r.ok ? r.json() : null)
        .then(j => {
          if (!j || !Array.isArray(j.items)) { if (el) el.innerHTML = '<div class="mono" style="padding:12px;color:#ef5350;font-size:11px">无法加载</div>'; return; }
          _sessionTimelineCache.set(cacheKey, { items: j.items, ts: Date.now() });
          _renderTimelineInto(j.items);
        })
        .catch(() => { if (el) el.innerHTML = '<div class="mono" style="padding:12px;color:#ef5350;font-size:11px">加载失败</div>'; });
    }
    // Refresh target timeline
    if (d.targetAgent && d.targetSessionId) {
      const cacheKey = `${d.targetAgent}:${d.targetSessionId}`;
      _sessionTimelineCache.delete(cacheKey);
      const el = document.getElementById('topo-target-timeline');
      if (el) el.innerHTML = '<div class="mono" style="padding:12px;color:#7aa2d5;font-size:11px">加载中…</div>';
      fetch(`/api/session-history?agent=${encodeURIComponent(d.targetAgent)}&sid=${encodeURIComponent(d.targetSessionId)}&limit=200`, { cache: 'no-store' })
        .then(r => r.ok ? r.json() : null)
        .then(j => {
          if (!j || !Array.isArray(j.items)) { if (el) el.innerHTML = '<div class="mono" style="padding:12px;color:#ef5350;font-size:11px">无法加载</div>'; return; }
          _sessionTimelineCache.set(cacheKey, { items: j.items, ts: Date.now() });
          _renderTargetTimelineInto(j.items);
        })
        .catch(() => { if (el) el.innerHTML = '<div class="mono" style="padding:12px;color:#ef5350;font-size:11px">加载失败</div>'; });
    }
    return;
  }

  if (topoSelectedNode.type !== 'session' && topoSelectedNode.type !== 'subagent') return;
  if (!d.agentId || !d.id) return;
  const cacheKey = `${d.agentId}:${d.id}`;
  _sessionTimelineCache.delete(cacheKey);
  const el = document.getElementById('topo-session-timeline');
  if (el) el.innerHTML = '<div class="mono" style="padding:12px;color:#7aa2d5;font-size:11px">加载中…</div>';
  fetch(`/api/session-history?agent=${encodeURIComponent(d.agentId)}&sid=${encodeURIComponent(d.id)}&limit=200`, { cache: 'no-store' })
    .then(r => r.ok ? r.json() : null)
    .then(j => {
      if (!j || !Array.isArray(j.items)) {
        if (el) el.innerHTML = '<div class="mono" style="padding:12px;color:#ef5350;font-size:11px">无法加载</div>';
        return;
      }
      _sessionTimelineCache.set(cacheKey, { items: j.items, ts: Date.now() });
      _renderTimelineInto(j.items);
    })
    .catch(() => {
      if (el) el.innerHTML = '<div class="mono" style="padding:12px;color:#ef5350;font-size:11px">加载失败</div>';
    });
}

function renderTopoSessionPanel(panel) {
  if (!topologyData || !topoSelectedNode) { panel.innerHTML = '<div class="mono" style="padding:20px;color:#7aa2d5">点击边线或节点查看 Session 详情</div>'; return; }
  let html = '';

  if (topoSelectedNode.type === 'contact') {
    const contactId = topoSelectedNode.id;
    const contact = topologyData.contacts.find(c => c.id === contactId);
    const edges = topologyData.contactEdges.filter(e => e.contactId === contactId);
    if (!contact || !edges.length) { panel.innerHTML = '<div class="mono" style="padding:20px;color:#7aa2d5">无 Session 数据</div>'; return; }

    html += `<div class="topo-section"><div class="topo-section-title">${escHtml(contact.label)} 的所有 Sessions</div></div>`;
    for (const e of edges) {
      // BUG FIX #1: sessionIds → sessions
      const sessions = e.sessions || [];
      html += `<div class="topo-section" style="margin-bottom:10px;padding:8px;border:1px solid #1c2834;border-radius:8px;background:#0b0f14">`;
      html += `<div style="display:flex;align-items:center;gap:6px;margin-bottom:6px">
        <span class="badge ${agentTagClass(e.agentId).replace('agent-tag ','')} agent-tag">${escHtml(e.agentId)}</span>
        <span style="color:#7aa2d5;font-size:11px">${escHtml(e.channel)} (${escHtml(e.chatType)})</span>
        <span style="margin-left:auto;color:${e.isActive ? '#4caf50' : '#555'};font-size:10px">${e.isActive ? 'active' : 'idle'}</span>
      </div>`;
      html += `<div class="topo-kv" style="font-size:11px">
        <div class="topo-kv-label">Sessions</div><div class="topo-kv-value">${sessions.length}</div>
        <div class="topo-kv-label">Tokens</div><div class="topo-kv-value">${formatCompactTokens(e.tokens.input)} in / ${formatCompactTokens(e.tokens.output)} out</div>
      </div>`;
      html += `<div style="margin-top:6px">`;
      for (const s of sessions.slice(0, 10)) {
        html += `<div class="mono" style="font-size:10px;color:#546e7a;padding:2px 0">${escHtml(s.id)}</div>`;
      }
      if (sessions.length > 10) html += `<div class="mono" style="font-size:10px;color:#444">...${sessions.length - 10} more</div>`;
      html += `</div></div>`;
    }
  } else if (topoSelectedNode.type === 'agent') {
    const agentId = topoSelectedNode.id.replace('agent:', '');
    const edges = topologyData.contactEdges.filter(e => e.agentId === agentId);
    html += `<div class="topo-section"><div class="topo-section-title">${escHtml(agentId)} 的 Sessions</div></div>`;
    for (const e of edges) {
      const contact = topologyData.contacts.find(c => c.id === e.contactId);
      const tok = e.tokens.input + e.tokens.output;
      // BUG FIX #1: sessionIds → sessions
      html += `<div class="topo-session-row" onclick="topoSelectContact('${escHtml(e.contactId)}')">
        <div class="topo-dot" style="background:${e.isActive ? '#4caf50' : '#555'}"></div>
        <span style="color:#cfe3ff">${contact ? escHtml(contact.label) : escHtml(e.contactId)}</span>
        <span style="color:#7aa2d5;font-size:10px;margin-left:auto">${escHtml(e.channel)} × ${(e.sessions || []).length}</span>
        <span style="color:#4caf50;font-size:10px">${formatCompactTokens(tok)}</span>
      </div>`;
    }
  } else if (topoSelectedNode.type === 'system') {
    const sys = topologyData.systemSummary || {};
    html += `<div class="topo-section"><div class="topo-section-title">系统 Sessions</div><div class="topo-kv">`;
    for (const [k, v] of Object.entries(sys)) {
      html += `<div class="topo-kv-label">${escHtml(k)}</div><div class="topo-kv-value">${v}</div>`;
    }
    html += `</div></div>`;
  } else {
    html = '<div class="mono" style="padding:20px;color:#7aa2d5">点击节点查看 Session 详情</div>';
  }

  // BUG FIX #6: Hidden sessions restore UI
  if (topoHiddenSessions.size > 0) {
    html += `<div class="topo-section" style="margin-top:16px;border-top:1px solid #1c2834;padding-top:10px">
      <div class="topo-section-title">已隐藏 Sessions (${topoHiddenSessions.size})</div>
      <div style="display:flex;flex-direction:column;gap:4px">`;
    for (const sid of topoHiddenSessions) {
      html += `<div style="display:flex;align-items:center;gap:6px;font-size:11px">
        <span class="mono" style="color:#7aa2d5;flex:1;overflow:hidden;text-overflow:ellipsis">${escHtml(sid)}</span>
        <button class="btn-link" style="padding:1px 6px;font-size:10px" onclick="restoreHiddenSession('${escHtml(sid)}')">恢复</button>
      </div>`;
    }
    html += `</div>
      <button class="btn-link" style="margin-top:6px;font-size:11px" onclick="restoreAllHiddenSessions()">恢复全部</button>
    </div>`;
  }

  panel.innerHTML = html;
}

// Helper onclick functions for side panel navigation
export function topoSelectAgent(agentId) {
  setTopoSelectedNode({ type: 'agent', id: `agent:${agentId}` });
  setTopoSidePanelTab('agent');
  document.querySelectorAll('.topo-tab').forEach((t, i) => { t.classList.toggle('active', i === 0); });
  renderTopoSidePanel();
}

export function topoSelectContact(contactId) {
  setTopoSelectedNode({ type: 'contact', id: contactId });
  setTopoSidePanelTab('contact');
  document.querySelectorAll('.topo-tab').forEach((t, i) => { t.classList.toggle('active', i === 1); });
  renderTopoSidePanel();
}

export function toggleTopologyView() {
  setTopologyViewActive(!topologyViewActive);
  if (topologyViewActive) { setChannelViewActive(false); const cb = document.getElementById('btn-channel-view'); if (cb) cb.textContent = '频道视图'; }
  updateTopoToggleBtn();
  if (topologyViewActive) { startTopoLoop(); pollTopology(); }
  else { stopTopoLoop(); }
  // import render dynamically to avoid circular dependency at module evaluation
  import('./render.js').then(m => m.render());
}

export function updateTopoToggleBtn() {
  const btn = document.getElementById('btn-topology-view');
  if (btn) btn.textContent = topologyViewActive ? '会话视图' : '拓扑视图';
}

export function startTopoLoop() {
  stopTopoLoop();
  setTopoPollingInterval(setInterval(pollTopology, 10000));
  startTopoAnimation();
}

export function stopTopoLoop() {
  if (topoPollingInterval) { clearInterval(topoPollingInterval); setTopoPollingInterval(null); }
  if (topoAnimFrame) { cancelAnimationFrame(topoAnimFrame); setTopoAnimFrame(null); }
}
