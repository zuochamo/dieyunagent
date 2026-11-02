/* global window, document, $, gwState, gatewayCall, settings, saveSettings, currentSessionId,
   resolveSessionWorkspacePathForRpc, resolveSessionWorkspacePathSync,
   resolveWorkspaceRootForIndexPanels, describeVectorSync, indexPanelRpcParams */
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
  // 两个索引已合并在同一个「索引」面板里（data-side-pane="index"）
  const pane = document.querySelector('.side-panel-pane[data-side-pane="index"]');
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
  // 默认关（重活：chunk + FTS + embedding），只有显式打开才跑；见 docs/INDEX-VALUE-REVIEW.md §R4
  autoCb.checked = !!(settings && settings.codebaseAutoIncremental === true);
  // 语义检索意图：打开后每次建库都带向量（唯一可行的触发方式，见
  // docs/SSH-INDEX-COLD-START-PLAN.md §0.5 —— 面板手点「建向量」在 SSH 每会话一份库时等于没有）
  const semanticCb = $('index-semantic-search');
  if (semanticCb) semanticCb.checked = !!(settings && settings.indexSemanticSearch === true);
}

function syncCodebaseRailBusy(busy) {
  const rail = document.querySelector('.side-panel-rail-btn[data-side-tab="index"]');
  if (!rail) return;
  // rail 现在是「索引」共用入口：两个索引各自只标记自己那半，合成状态
  // （is-busy / title）由 renderer-index-panel.js:applyIndexRailBusy 唯一决定，
  // 否则两边 refresh 会互相把对方的 busy 清掉。
  rail.dataset.busyCodebase = busy ? '1' : '';
  if (typeof window.applyIndexRailBusy === 'function') window.applyIndexRailBusy();
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
    setCodebasePanelText('cb-stat-embedding-dims', '—');
    setCodebasePanelText('cb-stat-embedding-sync', '—');
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
    // 作用域（sessionId + runWorkspaceRoot）必须带：不带就是查本机 core 的另一个键，
    // 见 renderer-gateway.js:indexPanelRpcParams。
    const st = await gatewayCall('codebase.status', indexPanelRpcParams(root));
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
      st.vectorCount ? `${st.vectorCount}（语义搜索）` : '0（子串检索）'
    );
    // 上一次建库的向量来源分布：打开「语义检索（向量）」后要能看出复用到底生效没有，
    // 否则「每会话重算整仓」和「命中跨 worktree 缓存」在界面上长得一模一样。
    // 复用口径见 crates/dieyun-core/src/index/vector_cache.rs。
    const vectorsReused = Number(st.vectorsReused) || 0;
    const vectorsEmbedded = Number(st.vectorsEmbedded) || 0;
    setCodebasePanelText(
      'cb-stat-vector-source',
      vectorsReused === 0 && vectorsEmbedded === 0
        ? '—'
        : `复用 ${vectorsReused} / 新算 ${vectorsEmbedded}`
    );
    // 向量元信息：模型/维度是**库里实际写入**的值，一致性由 core 比对当前设置得出
    setCodebasePanelText('cb-stat-embedding', st.embeddingModel || '—');
    setCodebasePanelText(
      'cb-stat-embedding-dims',
      Number(st.embeddingDims) > 0 ? String(st.embeddingDims) : '—'
    );
    setCodebasePanelText(
      'cb-stat-embedding-sync',
      describeVectorSync({
        count: st.vectorCount,
        chunks: st.chunkCount,
        stale: st.embeddingStale,
        enabled: st.embeddingEnabled,
      })
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

async function rebuildCodebasePanelIndex(opts = {}) {
  const root = await resolveCodebaseWorkspaceRootAsync();
  const btn = $(opts.vectors ? 'codebase-panel-vectors' : 'codebase-panel-rebuild');
  if (!root) return;
  if (btn) btn.disabled = true;
  // 「建向量」走增量（force:false）：core 只补缺向量的 chunk，签名变了才整库重算。
  // 以前这里一律 force:true —— 为了补几个改过的文件也要把整库重新切块 + 重新 embedding，
  // 于是没人愿意点，向量覆盖率就一直掉。全量重切是「重建片段」按钮的职责。
  const force = opts.vectors ? false : true;
  setCodebasePanelText('cb-stat-state', opts.vectors ? '正在补齐向量…' : '正在重建…');
  try {
    await gatewayCall(
      'codebase.index.start',
      indexPanelRpcParams(root, { force, skipIfReady: false, vectors: !!opts.vectors }),
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
  const mode = data.vectorSearch ? '语义+子串' : '子串';
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
  const semanticCb = $('index-semantic-search');
  if (semanticCb && !semanticCb.dataset.bound) {
    semanticCb.dataset.bound = '1';
    semanticCb.addEventListener('change', () => {
      if (!settings) return;
      settings.indexSemanticSearch = semanticCb.checked;
      if (typeof saveSettings === 'function') saveSettings(settings);
      // 打开后立刻在**当前**工作区补一次向量（新意图对已建过库的工作区也要生效），
      // 走的是与面板「建向量」同一条路径：增量补齐缺向量的 chunk。
      if (semanticCb.checked) rebuildCodebasePanelIndex({ vectors: true }).catch(() => {});
    });
  }
  $('codebase-panel-refresh')?.addEventListener('click', () => {
    refreshCodebasePanelStatus().catch(() => {});
  });
  $('codebase-panel-rebuild')?.addEventListener('click', () => {
    rebuildCodebasePanelIndex().catch(() => {});
  });
  // 向量是显式 opt-in：只有点这个按钮才让 core 跑 embedding
  $('codebase-panel-vectors')?.addEventListener('click', () => {
    rebuildCodebasePanelIndex({ vectors: true }).catch(() => {});
  });
  // 「试搜」入口已合并到统一的索引搜索框，见 renderer-index-panel.js
}

window.initCodebasePanel = initCodebasePanel;
window.onCodebasePanelShown = onCodebasePanelShown;
window.onCodebasePanelHidden = onCodebasePanelHidden;
window.refreshCodebasePanelStatus = refreshCodebasePanelStatus;
// 片段命中的渲染唯一实现（统一搜索框复用；勿在别处再写一份）
window.renderCodebaseSearchHits = renderCodebaseSearchHits;
// 工作区解析的唯一来源（统一搜索框与「刷新」共用）
window.resolveCodebaseWorkspaceRootAsync = resolveCodebaseWorkspaceRootAsync;
