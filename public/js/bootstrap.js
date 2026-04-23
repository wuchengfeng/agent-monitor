import { topologyViewActive, topoEdgeDebounce, setTopoEdgeDebounce, setTopoSidePanelTab } from './state.js';
import { render, upsert, pollSnapshot } from './render.js';
import { handleLlmCaptureEvent, toggleLlmCapturesPanel, selectCapture, toggleCaptureSection, copyCaptureJson, pollLlmCaptures, renderLlmCapturesPanel } from './llm-captures.js';
import {
  toggleArchive, toggleDetails, toggleShowArchived,
  copySessionDetail, copyStepDetail, copyApiDetail,
  selectStep, selectApi,
  loadAutoDeleteSettings, openAutoDeleteSettings, closeAutoDeleteSettings, renderAutoDeleteSettings, saveAutoDeleteSettings,
  openHistory, softDeleteSession, restoreSession, refreshDeletedList, toggleDeletedPanel, renderDeletedPanel,
} from './sessions.js';
import {
  pollTopology, computeTopologyLayout, renderTopoCanvas, resizeTopoCanvas,
  toggleTopologyView, updateTopoToggleBtn, startTopoLoop, stopTopoLoop,
  renderTopoSidePanel, resetTopology, topoZoomIn, topoZoomOut,
  hideSession, restoreHiddenSession, restoreAllHiddenSessions,
  topoSelectAgent, topoSelectContact, _topoRefreshTimeline, topoCloseSession,
} from './topology.js';
import { toggleChannelView, pollChannels, loadNicknames, saveNickname, startEditNickname, cancelEditNickname } from './channels.js';

// Expose functions globally for inline onclick handlers
Object.assign(window, {
  // Sessions
  toggleArchive, toggleDetails, toggleShowArchived,
  copySessionDetail, copyStepDetail, copyApiDetail,
  selectStep, selectApi,
  openHistory, softDeleteSession, restoreSession,
  refreshDeletedList, toggleDeletedPanel, renderDeletedPanel,
  // Auto-delete settings
  loadAutoDeleteSettings, openAutoDeleteSettings, closeAutoDeleteSettings, renderAutoDeleteSettings, saveAutoDeleteSettings,
  // LLM captures
  toggleLlmCapturesPanel, selectCapture, toggleCaptureSection, copyCaptureJson, pollLlmCaptures, renderLlmCapturesPanel,
  // Topology
  toggleTopologyView, renderTopoSidePanel, resetTopology, topoZoomIn, topoZoomOut,
  pollTopology, computeTopologyLayout, renderTopoCanvas,
  hideSession, restoreHiddenSession, restoreAllHiddenSessions,
  topoSelectAgent, topoSelectContact, setTopoSidePanelTab, _topoRefreshTimeline, topoCloseSession,
  // Channels
  toggleChannelView, saveNickname, startEditNickname, cancelEditNickname,
  // Render
  render,
});

window.addEventListener('DOMContentLoaded', () => {
  const urlParams = new URLSearchParams(location.search);
  const startView = urlParams.get('view');
  if (startView === 'channel') { toggleChannelView(); }
  else if (startView === 'topology') { toggleTopologyView(); }
  if (startView) history.replaceState(null, '', '/');

  pollSnapshot();
  setInterval(pollSnapshot, 15000);

  pollChannels();
  setInterval(pollChannels, 5000);
  loadNicknames();

  refreshDeletedList(true).then(() => render());
  setInterval(() => refreshDeletedList(false).then(() => render()), 5000);

  const es = new EventSource('/events');
  es.onmessage = (ev) => {
    try {
      const e = JSON.parse(ev.data);
      if (e.type === 'llm-capture') {
        handleLlmCaptureEvent(e);
      } else if (e.type === 'bridge-event') {
        /* handled by /bridge.html */
      } else if (e.type === 'topology-edge') {
        if (topologyViewActive) {
          clearTimeout(topoEdgeDebounce);
          setTopoEdgeDebounce(setTimeout(pollTopology, 2000));
        }
      } else {
        upsert(e, false);
      }
    } catch {}
  };
  es.onerror = () => {};

  window.addEventListener('resize', () => {
    if (topologyViewActive) { resizeTopoCanvas(); }
    render();
  });
});
