/* global window, document, $, gwState, gatewayCall, settings, saveSettings, currentSessionId,
   resolveSessionWorkspacePathForRpc, resolveSessionWorkspacePathSync,
   resolveWorkspaceRootForIndexPanels */
'use strict';

let codebasePanelPollTimer = null;
/** @type {'off'|'idle'|'busy'} */
let codebasePanelPollMode = 'off';
let codebaseWasIndexing = false;
let codebaseCompleteFollowUpTimer = null;

function formatCodebaseIndexedAt(ts) {
  const n = Number(ts || 0);
  if (!n) return '从未构建';
  try {
    return new Date(n * 1000).toLocaleString();
  } catch {
    return String(n);
  }
}

function resolveCodebaseWorkspaceRoot() {
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

async function resolveCodebaseWorkspaceRootAsync() {
  if (typeof resolveWorkspaceRootForIndexPanels === 'function') {
    return resolveWorkspaceRootForIndexPanels(
      typeof currentSessionId !== 'undefined' ? currentSessionId : null
    );
  }
  return resolveCodebaseWorkspaceRoot();
}

function isCodebasePaneActive() {
  const panel = document.getElementById('artifacts-panel');
  if (!panel || panel.hidden || panel.classList.contains('is-panel-closing')) return false;
  const pane = document.querySelector('.side-panel-pane[data-side-pane="codebase"]');
  return !!(pane && !pane.hidden);
}

function setCodebasePanelText(id, text) {
  const el = $(id);
  if (el) el.textContent = text == null || text === '' ? '—' : String(text);
}

function stopCodebasePanelPoll() {
  if (codebasePanelPollTimer) {
    window.clearInterval(codebasePanelPollTimer);
    codebasePanelPollTimer = null;
  }
  codebasePanelPollMode = 'off';
}

function scheduleCodebasePanelPoll(mode) {
  const ms = mode === 'busy' ? 2000 : 5000;
  if (codebasePanelPollTimer && codebasePanelPollMode === mode) return;
  stopCodebasePanelPoll();
  codebasePanelPollMode = mode;
  codebasePanelPollTimer = window.setInterval(() => {
    refreshCodebasePanelStatus().catch(() => {});
  }, ms);
}

function syncCodebaseAutoIncrementalCheckbox() {
  const autoCb = $('codebase-auto-incremental');
  if (!autoCb) return;
  autoCb.checked = !!(settings && settings.codebaseAutoIncremental !== false);
}

function syncCodebaseRailBusy(busy, tip) {
  const rail = document.querySelector('.side-panel-rail-btn[data-side-tab="codebase"]');
  if (!rail) return;
  const on = !!busy;
  rail.classList.toggle('is-busy', on);
  if (on) {
    const msg = tip || '构建中…';
    rail.title = `代码索引 · ${msg}`;
    rail.setAttribute('aria-label', `代码索引，${msg}`);
  } else {
    rail.title = '代码索引';
    rail.setAttribute('aria-label', '代码索引');
  }
}

async function refreshCodebasePanelStatus() {
  const summary = $('codebase-panel-summary');
  const rebuildBtn = $('codebase-panel-rebuild');
  const root = await resolveCodebaseWorkspaceRootAsync();
  if (!root) {
    if (summary) summary.textContent = '未选工作区';
    setCodebasePanelText('cb-stat-state', '请先选择工作空间');
    setCodebasePanelText('cb-stat-files', '—');
    setCodebasePanelText('cb-stat-chunks', '—');
    setCodebasePanelText('cb-stat-vectors', '—');
    setCodebasePanelText('cb-stat-embedding', '—');
    setCodebasePanelText('cb-stat-updated', '—');
    setCodebasePanelText('cb-stat-progress', '—');
    if (rebuildBtn) rebuildBtn.disabled = true;
    syncCodebaseRailBusy(false);
    stopCodebasePanelPoll();
    codebaseWasIndexing = false;
    return;
  }
  if (rebuildBtn) rebuildBtn.disabled = false;
  try {
    const st = await gatewayCall('codebase.status', { workspaceRoot: root });
    const indexing = !!(st && st.indexing);
    const indexed = !!(st && st.indexed);
    let state = '未建立';
    if (indexing) state = '构建中…';
    else if (indexed) state = Number(st.chunkCount) > 0 ? '已就绪（可检索）' : '已建库（无可检索片段）';
    if (st && st.lastError) state = `失败：${String(st.lastError).slice(0, 80)}`;

    setCodebasePanelText('cb-stat-state', state);
    setCodebasePanelText('cb-stat-files', String(st.fileCount ?? 0));
    setCodebasePanelText('cb-stat-chunks', String(st.chunkCount ?? 0));
    setCodebasePanelText(
      'cb-stat-vectors',
      st.vectorCount ? `${st.vectorCount}（语义搜索）` : '0（仅关键词）'
    );
    setCodebasePanelText(
      'cb-stat-embedding',
      st.embeddingModel || (st.vectorCount ? '—' : '未启用 / 未写入')
    );
    setCodebasePanelText('cb-stat-updated', formatCodebaseIndexedAt(st.indexedAt));

    const phase = String(st.phase || '').trim();
    const done = Number(st.filesDone) || 0;
    const total = Number(st.filesTotal) || 0;
    let progress = '—';
    if (indexing || phase) {
      const label =
        phase === 'walking'
          ? '扫描'
          : phase === 'chunking'
            ? '切分'
            : phase === 'embedding'
              ? '向量'
              : phase === 'finishing'
                ? '写入'
                : phase || '进行中';
      progress = total > 0 ? `${label} ${done}/${total}` : label;
    }
    setCodebasePanelText('cb-stat-progress', progress);
    if (summary) {
      summary.textContent = indexing
        ? progress !== '—'
          ? progress
          : '构建中'
        : indexed
          ? `${st.chunkCount || 0} chunks`
          : '未建立';
    }

    const justFinished = codebaseWasIndexing && !indexing;
    codebaseWasIndexing = indexing;
    syncCodebaseRailBusy(indexing, progress !== '—' ? progress : '构建中…');

    // 面板关闭时仍可 busy 轮询，供侧栏图标动画；空闲则停
    if (!isCodebasePaneActive()) {
      if (indexing) scheduleCodebasePanelPoll('busy');
      else stopCodebasePanelPoll();
      return;
    }
    if (indexing) {
      scheduleCodebasePanelPoll('busy');
    } else {
      if (justFinished) {
        if (codebaseCompleteFollowUpTimer) window.clearTimeout(codebaseCompleteFollowUpTimer);
        codebaseCompleteFollowUpTimer = window.setTimeout(() => {
          codebaseCompleteFollowUpTimer = null;
          if (isCodebasePaneActive()) refreshCodebasePanelStatus().catch(() => {});
        }, 1500);
      }
      scheduleCodebasePanelPoll('idle');
    }
  } catch (err) {
    setCodebasePanelText('cb-stat-state', `读取失败：${err && err.message ? err.message : err}`);
    if (summary) summary.textContent = '读取失败';
    syncCodebaseRailBusy(false);
    codebaseWasIndexing = false;
    if (isCodebasePaneActive()) scheduleCodebasePanelPoll('idle');
    else stopCodebasePanelPoll();
  }
}

async function rebuildCodebasePanelIndex() {
  const root = await resolveCodebaseWorkspaceRootAsync();
  const btn = $('codebase-panel-rebuild');
  if (!root) return;
  if (btn) btn.disabled = true;
  setCodebasePanelText('cb-stat-state', '正在重建…');
  try {
    await gatewayCall(
      'codebase.index.start',
      { workspaceRoot: root, force: true, skipIfReady: false },
      { timeoutMs: 60000 }
    );
  } catch (err) {
    setCodebasePanelText('cb-stat-state', `启动失败：${err && err.message ? err.message : err}`);
  } finally {
    if (btn) btn.disabled = false;
    await refreshCodebasePanelStatus();
  }
}

function renderCodebaseSearchHits(data) {
  const box = $('codebase-panel-results');
  if (!box) return;
  const results = data && Array.isArray(data.results) ? data.results : [];
  if (!results.length) {
    box.innerHTML = `<p class="artifacts-empty">${
      data && data.needsIndex ? '尚未建立可检索索引' : '无命中'
    }</p>`;
    return;
  }
  const mode = data.vectorSearch ? '语义+关键词' : '关键词';
  const items = results
    .slice(0, 12)
    .map((hit) => {
      const path = String(hit.path || '').replace(/</g, '&lt;');
      const snip = String(hit.snippet || '')
        .replace(/</g, '&lt;')
        .slice(0, 220);
      const lines = `${hit.startLine || '?'}–${hit.endLine || '?'}`;
      const score = Number(hit.score);
      const scoreText = Number.isFinite(score) ? score.toFixed(3) : '';
      return `<article class="codebase-hit">
        <header class="codebase-hit-path">${path} <span class="codebase-hit-meta">L${lines}${
          scoreText ? ` · ${scoreText}` : ''
        }</span></header>
        <pre class="codebase-hit-snip">${snip}</pre>
      </article>`;
    })
    .join('');
  box.innerHTML = `<p class="codebase-search-meta">模式：${mode} · ${results.length} 条</p>${items}`;
}

async function runCodebasePanelSearch() {
  const root = await resolveCodebaseWorkspaceRootAsync();
  const input = $('codebase-panel-query');
  const box = $('codebase-panel-results');
  const q = input ? String(input.value || '').trim() : '';
  if (!root) {
    if (box) box.innerHTML = '<p class="artifacts-empty">请先选择工作空间</p>';
    return;
  }
  if (!q) {
    if (box) box.innerHTML = '<p class="artifacts-empty">请输入搜索词</p>';
    return;
  }
  if (box) box.innerHTML = '<p class="artifacts-empty">搜索中…</p>';
  try {
    const data = await gatewayCall(
      'codebase.search',
      { workspaceRoot: root, query: q, limit: 10, autoIndex: false },
      { timeoutMs: 60000 }
    );
    renderCodebaseSearchHits(data);
  } catch (err) {
    if (box) {
      box.innerHTML = `<p class="artifacts-empty">搜索失败：${
        err && err.message ? err.message : err
      }</p>`;
    }
  }
}

function onCodebasePanelShown() {
  syncCodebaseAutoIncrementalCheckbox();
  refreshCodebasePanelStatus().catch(() => {});
}

function onCodebasePanelHidden() {
  // 后台仍在建索引时保留 busy 轮询，侧栏图标继续动
  if (!codebaseWasIndexing) stopCodebasePanelPoll();
  if (codebaseCompleteFollowUpTimer) {
    window.clearTimeout(codebaseCompleteFollowUpTimer);
    codebaseCompleteFollowUpTimer = null;
  }
}

function initCodebasePanel() {
  syncCodebaseAutoIncrementalCheckbox();
  const autoCb = $('codebase-auto-incremental');
  if (autoCb && !autoCb.dataset.bound) {
    autoCb.dataset.bound = '1';
    autoCb.addEventListener('change', () => {
      if (!settings) return;
      settings.codebaseAutoIncremental = autoCb.checked;
      if (typeof saveSettings === 'function') saveSettings(settings);
    });
  }
  $('codebase-panel-refresh')?.addEventListener('click', () => {
    refreshCodebasePanelStatus().catch(() => {});
  });
  $('codebase-panel-rebuild')?.addEventListener('click', () => {
    rebuildCodebasePanelIndex().catch(() => {});
  });
  $('codebase-panel-search-btn')?.addEventListener('click', () => {
    runCodebasePanelSearch().catch(() => {});
  });
  $('codebase-panel-query')?.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') {
      ev.preventDefault();
      runCodebasePanelSearch().catch(() => {});
    }
  });
}

window.initCodebasePanel = initCodebasePanel;
window.onCodebasePanelShown = onCodebasePanelShown;
window.onCodebasePanelHidden = onCodebasePanelHidden;
window.refreshCodebasePanelStatus = refreshCodebasePanelStatus;
