// Central state & localStorage persistence for Agent Monitor

export const state = new Map();
export const archived = new Set(JSON.parse(localStorage.getItem('agent_monitor_archived') || '[]'));
export let showArchived = false;
export function setShowArchived(v) { showArchived = v; }

export let channelViewActive = false;
export function setChannelViewActive(v) { channelViewActive = v; }
export let channelData = [];
export function setChannelData(v) { channelData = v; }
export let channelNicknames = {};
export function setChannelNicknames(v) { channelNicknames = v; }
export let editingNicknameKey = null;
export function setEditingNicknameKey(v) { editingNicknameKey = v; }

export const expandedSessions = new Set();
export const selectedStepIndexBySession = new Map();
export const selectedApiIndexBySession = new Map();

export let deletedPanelOpen = false;
export function setDeletedPanelOpen(v) { deletedPanelOpen = v; }
export let deletedCache = [];
export function setDeletedCache(v) { deletedCache = v; }
export let deletedCacheAt = 0;
export function setDeletedCacheAt(v) { deletedCacheAt = v; }

// --- LLM Capture state ---
export const llmCaptures = [];
export const llmCapturesFull = new Map();
export let llmCapturesPanelOpen = false;
export function setLlmCapturesPanelOpen(v) { llmCapturesPanelOpen = v; }
export let selectedCaptureId = null;
export function setSelectedCaptureId(v) { selectedCaptureId = v; }
export let llmCaptureDetailExpanded = new Set();
export function setLlmCaptureDetailExpanded(v) { llmCaptureDetailExpanded = v; }

// --- Topology View state ---
export let topologyViewActive = false;
export function setTopologyViewActive(v) { topologyViewActive = v; }
export let topologyData = null;
export function setTopologyData(v) { topologyData = v; }
export let topoNodes = [];
export function setTopoNodes(v) { topoNodes = v; }
export let topoEdges = [];
export function setTopoEdges(v) { topoEdges = v; }
export let topoSelectedNode = null;
export function setTopoSelectedNode(v) { topoSelectedNode = v; }
export let topoSidePanelTab = 'agent';
export function setTopoSidePanelTab(v) { topoSidePanelTab = v; }
export let topoPan = { x: 0, y: 0 };
export function setTopoPan(v) { topoPan = v; }
export let topoZoom = 1;
export function setTopoZoom(v) { topoZoom = v; }
export let topoHoverNode = null;
export function setTopoHoverNode(v) { topoHoverNode = v; }
export let topoDragging = null;
export function setTopoDragging(v) { topoDragging = v; }
export let topoPanStart = null;
export function setTopoPanStart(v) { topoPanStart = v; }
export let topoAnimFrame = null;
export function setTopoAnimFrame(v) { topoAnimFrame = v; }
export let topoPollingInterval = null;
export function setTopoPollingInterval(v) { topoPollingInterval = v; }
export let topoEdgeDebounce = null;
export function setTopoEdgeDebounce(v) { topoEdgeDebounce = v; }
export let topoTimeFilter = 'today';
export function setTopoTimeFilter(v) { topoTimeFilter = v; }

// --- Topology persistence (localStorage) ---
export const topoSavedPositions = JSON.parse(localStorage.getItem('topo_node_positions') || '{}');
export const topoCustomNames = JSON.parse(localStorage.getItem('topo_custom_names') || '{}');
export const topoHiddenSessions = new Set(JSON.parse(localStorage.getItem('topo_hidden_sessions') || '[]'));

export function _saveTopoPositions() { localStorage.setItem('topo_node_positions', JSON.stringify(topoSavedPositions)); }
export function _saveTopoNames() { localStorage.setItem('topo_custom_names', JSON.stringify(topoCustomNames)); }
export function _saveTopoHidden() { localStorage.setItem('topo_hidden_sessions', JSON.stringify([...topoHiddenSessions])); }
export function topoDisplayName(nodeId, fallback) { return topoCustomNames[nodeId] || fallback; }

export function saveArchived() {
  localStorage.setItem('agent_monitor_archived', JSON.stringify([...archived]));
}

export let autoDeleteSettingsCache = null;
export function setAutoDeleteSettingsCache(v) { autoDeleteSettingsCache = v; }

export let _renderScheduled = false;
export function set_renderScheduled(v) { _renderScheduled = v; }

export let systemChannelsExpanded = false;
export function setSystemChannelsExpanded(v) { systemChannelsExpanded = v; }
