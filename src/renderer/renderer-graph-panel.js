/* global window, document, $, gwState, gatewayCall, settings, saveSettings, openSidePanel, closeSettingsModal,
   currentSessionId, resolveSessionWorkspacePathForRpc, resolveSessionWorkspacePathSync,
   resolveWorkspaceRootForIndexPanels */
'use strict';

let graphPanelPollTimer = null;
/** @type {'off'|'idle'|'busy'} */
let graphPanelPollMode = 'off';
let graphWasIndexing = false;
let graphCompleteFollowUpTimer = null;

function formatGraphPanelIndexedAt(ts) {
  const n = Number(ts || 0);
  if (!n) return '从未构建';
  try {
    return new Date(n * 1000).toLocaleString();
  } catch {
    return String(n);
  }
}

function resolveGraphPanelWorkspaceRoot() {
  const sid =
    typeof currentSessionId !== 'undefined' && currentSessionId
      ? String(currentSessionId)
      : '';
  if (typeof resolveSessionWorkspacePathForRpc === 'function') {
    const p = resolveSessionWorkspacePathForRpc(sid || null);
    if (p) return String(p).trim();
  }
  if (typeof resolveSessionWorkspacePathSync === 'function' && sid) {
    const p = resolveSessionWorkspacePathSync(sid);
    if (p) return String(p).trim();
  }
  if (typeof window !== 'undefined' && window.activeViewSessionWorkspacePath) {
    return String(window.activeViewSessionWorkspacePath).trim();
  }
  return gwState && gwState.workspacePath ? String(gwState.workspacePath).trim() : '';
}

async function resolveGraphPanelWorkspaceRootAsync() {
  if (typeof resolveWorkspaceRootForIndexPanels === 'function') {
    return resolveWorkspaceRootForIndexPanels(
      typeof currentSessionId !== 'undefined' ? currentSessionId : null
    );
  }
  return resolveGraphPanelWorkspaceRoot();
}

function setGraphPanelText(id, text) {
  const el = $(id);
  if (el) el.textContent = text == null || text === '' ? '—' : String(text);
}

function isGraphPaneActive() {
  const panel = document.getElementById('artifacts-panel');
  if (!panel || panel.hidden || panel.classList.contains('is-panel-closing')) return false;
  const pane = document.querySelector('.side-panel-pane[data-side-pane="graph"]');
  return !!(pane && !pane.hidden);
}

function stopGraphPanelPoll() {
  if (graphPanelPollTimer) {
    window.clearInterval(graphPanelPollTimer);
    graphPanelPollTimer = null;
  }
  graphPanelPollMode = 'off';
}

function scheduleGraphPanelPoll(mode) {
  const ms = mode === 'busy' ? 2000 : 5000;
  if (graphPanelPollTimer && graphPanelPollMode === mode) return;
  stopGraphPanelPoll();
  graphPanelPollMode = mode;
  graphPanelPollTimer = window.setInterval(() => {
    refreshGraphPanelStatus().catch(() => {});
  }, ms);
}

function syncGraphAutoIncrementalCheckbox() {
  const autoCb = $('graph-auto-incremental');
  if (!autoCb) return;
  autoCb.checked = !!(settings && settings.graphAutoIncremental !== false);
}

function syncGraphRailBusy(busy, tip) {
  const rail = document.querySelector('.side-panel-rail-btn[data-side-tab="graph"]');
  if (!rail) return;
  const on = !!busy;
  rail.classList.toggle('is-busy', on);
  if (on) {
    const msg = tip || '构建中…';
    rail.title = `结构索引 · ${msg}`;
    rail.setAttribute('aria-label', `结构索引，${msg}`);
  } else {
    rail.title = '结构索引';
    rail.setAttribute('aria-label', '结构索引');
  }
}

async function refreshGraphPanelStatus() {
  const summary = $('graph-panel-summary');
  const rebuildBtn = $('graph-panel-rebuild');
  const noteEl = $('graph-panel-workspace-note');
  const root = await resolveGraphPanelWorkspaceRootAsync();
  if (!root) {
    if (summary) summary.textContent = '未选工作区';
    setGraphPanelText('gr-stat-state', '请先选择工作空间');
    ['gr-stat-files', 'gr-stat-edges', 'gr-stat-symbols', 'gr-stat-calls', 'gr-stat-vectors', 'gr-stat-updated', 'gr-stat-progress'].forEach(
      (id) => setGraphPanelText(id, '—')
    );
    if (noteEl) noteEl.textContent = '';
    if (rebuildBtn) rebuildBtn.disabled = true;
    syncGraphRailBusy(false);
    stopGraphPanelPoll();
    graphWasIndexing = false;
    return;
  }
  if (rebuildBtn) rebuildBtn.disabled = false;
  if (noteEl) {
    noteEl.textContent = /^ssh:\/\//i.test(root)
      ? `工作区：${root}（远程项目内 .dieyun，需 Remote Agent 含 Linux dieyun-core）`
      : `工作区：${root}`;
  }
  try {
    const st = await gatewayCall('graph.status', { workspaceRoot: root });
    const indexing = !!(st && st.indexing);
    const indexed = !!(st && st.indexed);
    let state = '未建立';
    if (indexing) state = '构建中…';
    else if (indexed) {
      state =
        Number(st.symbolCount) > 0 || Number(st.edgeCount) > 0
          ? '已就绪（可查依赖/符号）'
          : '已建库（暂无符号/依赖）';
    }
    if (st && st.lastError) state = `失败：${String(st.lastError).slice(0, 80)}`;

    setGraphPanelText('gr-stat-state', state);
    setGraphPanelText('gr-stat-files', String(st.fileCount ?? 0));
    setGraphPanelText('gr-stat-edges', String(st.edgeCount ?? 0));
    setGraphPanelText('gr-stat-symbols', String(st.symbolCount ?? 0));
    setGraphPanelText('gr-stat-calls', String(st.callCount ?? 0));
    setGraphPanelText(
      'gr-stat-vectors',
      st.symbolVectorCount ? `${st.symbolVectorCount}（语义找符号）` : '0'
    );
    setGraphPanelText('gr-stat-updated', formatGraphPanelIndexedAt(st.indexedAt));

    const phase = String(st.phase || '').trim();
    const done = Number(st.filesDone) || 0;
    const total = Number(st.filesTotal) || 0;
    let progress = '—';
    if (indexing || phase) {
      const label =
        phase === 'walking'
          ? '扫描'
          : phase === 'parsing'
            ? '解析'
            : phase === 'finishing'
              ? '写入'
              : phase || '进行中';
      progress = total > 0 ? `${label} ${done}/${total}` : label;
    }
    setGraphPanelText('gr-stat-progress', progress);
    if (summary) {
      summary.textContent = indexing
        ? progress !== '—'
          ? progress
          : '构建中'
        : indexed
          ? `${st.symbolCount || 0} 符号`
          : '未建立';
    }

    const justFinished = graphWasIndexing && !indexing;
    graphWasIndexing = indexing;
    syncGraphRailBusy(indexing, progress !== '—' ? progress : '构建中…');

    if (!isGraphPaneActive()) {
      if (indexing) scheduleGraphPanelPoll('busy');
      else stopGraphPanelPoll();
      return;
    }
    if (indexing) {
      scheduleGraphPanelPoll('busy');
    } else {
      if (justFinished) {
        if (graphCompleteFollowUpTimer) window.clearTimeout(graphCompleteFollowUpTimer);
        graphCompleteFollowUpTimer = window.setTimeout(() => {
          graphCompleteFollowUpTimer = null;
          if (isGraphPaneActive()) refreshGraphPanelStatus().catch(() => {});
        }, 1500);
      }
      scheduleGraphPanelPoll('idle');
    }
  } catch (err) {
    setGraphPanelText('gr-stat-state', `读取失败：${err && err.message ? err.message : err}`);
    if (summary) summary.textContent = '读取失败';
    syncGraphRailBusy(false);
    graphWasIndexing = false;
    // 超时后继续慢轮询，避免面板永久停在失败态
    if (isGraphPaneActive()) scheduleGraphPanelPoll('idle');
    else stopGraphPanelPoll();
  }
}

async function rebuildGraphPanelIndex() {
  const root = await resolveGraphPanelWorkspaceRootAsync();
  const btn = $('graph-panel-rebuild');
  if (!root) return;
  if (btn) btn.disabled = true;
  setGraphPanelText('gr-stat-state', '正在重建…');
  try {
    await gatewayCall(
      'graph.index.start',
      { workspaceRoot: root, force: true, skipIfReady: false },
      { timeoutMs: 60000 }
    );
  } catch (err) {
    setGraphPanelText('gr-stat-state', `启动失败：${err && err.message ? err.message : err}`);
  } finally {
    if (btn) btn.disabled = false;
    await refreshGraphPanelStatus();
  }
}

function renderGraphSymbolHits(data) {
  const box = $('graph-panel-results');
  if (!box) return;
  const results = data && Array.isArray(data.results) ? data.results : [];
  if (!results.length) {
    box.innerHTML = '<p class="artifacts-empty">无命中符号</p>';
    return;
  }
  const mode = data.vectorSearch ? '语义+名称' : '名称匹配';
  const items = results
    .slice(0, 16)
    .map((hit) => {
      const path = String(hit.path || '').replace(/</g, '&lt;');
      const name = String(hit.name || hit.qualifiedName || '').replace(/</g, '&lt;');
      const kind = String(hit.kind || 'symbol').replace(/</g, '&lt;');
      const lines = `${hit.startLine || '?'}–${hit.endLine || '?'}`;
      const qn =
        hit.qualifiedName && hit.qualifiedName !== hit.name
          ? String(hit.qualifiedName).replace(/</g, '&lt;')
          : '';
      return `<article class="codebase-hit">
        <header class="codebase-hit-path">${kind} <strong>${name}</strong>
          <span class="codebase-hit-meta">${path} · L${lines}</span>
        </header>
        ${qn ? `<pre class="codebase-hit-snip">${qn}</pre>` : ''}
      </article>`;
    })
    .join('');
  box.innerHTML = `<p class="codebase-search-meta">模式：${mode} · ${results.length} 条</p>${items}`;
}

async function runGraphPanelSymbolSearch() {
  const root = await resolveGraphPanelWorkspaceRootAsync();
  const input = $('graph-panel-query');
  const box = $('graph-panel-results');
  const q = input ? String(input.value || '').trim() : '';
  if (!root) {
    if (box) box.innerHTML = '<p class="artifacts-empty">请先选择工作空间</p>';
    return;
  }
  if (!q) {
    if (box) box.innerHTML = '<p class="artifacts-empty">请输入符号名</p>';
    return;
  }
  if (box) box.innerHTML = '<p class="artifacts-empty">查找中…</p>';
  try {
    const data = await gatewayCall(
      'graph.symbol_search',
      { workspaceRoot: root, query: q, limit: 12, autoIndex: false },
      { timeoutMs: 60000 }
    );
    renderGraphSymbolHits(data);
  } catch (err) {
    if (box) {
      box.innerHTML = `<p class="artifacts-empty">查找失败：${
        err && err.message ? err.message : err
      }</p>`;
    }
  }
}

function onGraphPanelShown() {
  syncGraphAutoIncrementalCheckbox();
  refreshGraphPanelStatus().catch(() => {});
}

function onGraphPanelHidden() {
  // 后台仍在建索引时保留 busy 轮询，侧栏图标继续动
  if (!graphWasIndexing) stopGraphPanelPoll();
  if (graphCompleteFollowUpTimer) {
    window.clearTimeout(graphCompleteFollowUpTimer);
    graphCompleteFollowUpTimer = null;
  }
}

function openGraphSidePanel() {
  if (typeof openSidePanel === 'function') {
    openSidePanel({ tab: 'graph' });
  } else if (typeof window.openSidePanel === 'function') {
    window.openSidePanel({ tab: 'graph' });
  }
  onGraphPanelShown();
}

function initGraphPanel() {
  syncGraphAutoIncrementalCheckbox();
  const autoCb = $('graph-auto-incremental');
  if (autoCb && !autoCb.dataset.bound) {
    autoCb.dataset.bound = '1';
    autoCb.addEventListener('change', () => {
      if (!settings) return;
      settings.graphAutoIncremental = autoCb.checked;
      if (typeof saveSettings === 'function') saveSettings(settings);
    });
  }
  $('graph-panel-refresh')?.addEventListener('click', () => {
    refreshGraphPanelStatus().catch(() => {});
  });
  $('graph-panel-rebuild')?.addEventListener('click', () => {
    rebuildGraphPanelIndex().catch(() => {});
  });
  $('graph-panel-search-btn')?.addEventListener('click', () => {
    runGraphPanelSymbolSearch().catch(() => {});
  });
  $('graph-panel-query')?.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') {
      ev.preventDefault();
      runGraphPanelSymbolSearch().catch(() => {});
    }
  });
}

/** 兼容旧设置入口：结构索引已迁到侧栏 */
function initGraphIndexSettings() {
  // no-op：控件在侧栏，由 initGraphPanel 绑定
}

function onGraphSettingsTabShown() {
  if (typeof closeSettingsModal === 'function') closeSettingsModal();
  else if (typeof window.closeSettingsModal === 'function') window.closeSettingsModal();
  openGraphSidePanel();
}

window.initGraphPanel = initGraphPanel;
window.onGraphPanelShown = onGraphPanelShown;
window.onGraphPanelHidden = onGraphPanelHidden;
window.refreshGraphPanelStatus = refreshGraphPanelStatus;
window.initGraphIndexSettings = initGraphIndexSettings;
window.onGraphSettingsTabShown = onGraphSettingsTabShown;
window.refreshGraphIndexStatus = refreshGraphPanelStatus;
window.openGraphSidePanel = openGraphSidePanel;
