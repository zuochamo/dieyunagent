/* global window, document, gatewayCall, indexPanelRpcParams */

'use strict';

// 「索引」面板外壳：代码片段索引（codebase.*）与结构索引（graph.*）现在共用
// 同一个侧栏入口与同一块 DOM。这里只做**组合**：
//   - 状态刷新 / 重建 / 命中渲染的实现仍在 renderer-codebase-panel.js 与
//     renderer-graph-panel.js（各自单一来源），本文件不复制任何一份；
//   - 唯一新增职责是「一个搜索框同时查两路」和「rail busy 的合成态」——
//     后者必须集中，否则两个面板的 refresh 会互相把对方的 busy 清掉。
// 为什么不把两块并成一个 Rust 索引：两者产物、更新代价、查询语义都不同
// （见 docs/INDEX-VALUE-REVIEW.md），合并的只是界面。

const INDEX_PANEL_TAB = 'index';

function indexPanelEl(id) {
  return document.getElementById(id);
}

function setIndexPanelBox(id, html) {
  const box = indexPanelEl(id);
  if (box) box.innerHTML = html;
}

function escapeIndexPanelText(s) {
  return String(s == null ? '' : s).replace(/</g, '&lt;');
}

/**
 * 试搜用的工作区：复用代码索引侧已有的解析（它已经是「当前会话工作区」的
 * 唯一来源），缺失时才退回结构索引侧的实现。
 */
async function resolveIndexPanelRoot() {
  if (typeof window.resolveCodebaseWorkspaceRootAsync === 'function') {
    return window.resolveCodebaseWorkspaceRootAsync();
  }
  if (typeof window.resolveGraphPanelWorkspaceRootAsync === 'function') {
    return window.resolveGraphPanelWorkspaceRootAsync();
  }
  return '';
}

/**
 * 一个输入框查两路：片段（子串/语义，回答「在哪」）与符号（按名匹配，回答
 * 「定义在哪」）。两路互相独立 —— 一路不可用（如未建向量、未建结构）不影响另一路。
 */
async function runIndexPanelSearch() {
  const input = indexPanelEl('index-panel-query');
  const q = input ? String(input.value || '').trim() : '';
  const root = await resolveIndexPanelRoot();
  if (!root) {
    setIndexPanelBox('codebase-panel-results', '<p class="artifacts-empty">请先选择工作空间</p>');
    setIndexPanelBox('graph-panel-results', '<p class="artifacts-empty">请先选择工作空间</p>');
    return;
  }
  if (!q) {
    setIndexPanelBox('codebase-panel-results', '<p class="artifacts-empty">请输入搜索词</p>');
    setIndexPanelBox('graph-panel-results', '<p class="artifacts-empty">请输入搜索词</p>');
    return;
  }
  setIndexPanelBox('codebase-panel-results', '<p class="artifacts-empty">搜索中…</p>');
  setIndexPanelBox('graph-panel-results', '<p class="artifacts-empty">查找中…</p>');

  // 两路查询都要带会话作用域（同 renderer-gateway.js:indexPanelRpcParams）：少了它，
  // SSH 工作区会查到本机 core 的空键上，试搜永远「尚未建立可检索索引」。
  const [chunks, symbols] = await Promise.all([
    gatewayCall(
      'codebase.search',
      indexPanelRpcParams(root, { query: q, limit: 10 }),
      { timeoutMs: 60000 }
    ).then(
      (data) => ({ ok: true, data }),
      (err) => ({ ok: false, err })
    ),
    gatewayCall(
      'graph.symbol_search',
      indexPanelRpcParams(root, { query: q, limit: 12, autoIndex: false }),
      { timeoutMs: 60000 }
    ).then(
      (data) => ({ ok: true, data }),
      (err) => ({ ok: false, err })
    )
  ]);

  if (chunks.ok && typeof window.renderCodebaseSearchHits === 'function') {
    window.renderCodebaseSearchHits(chunks.data);
  } else {
    const msg = chunks.ok ? '无命中' : chunks.err && chunks.err.message ? chunks.err.message : chunks.err;
    setIndexPanelBox(
      'codebase-panel-results',
      `<p class="artifacts-empty">片段通道不可用：${escapeIndexPanelText(msg)}（可先「重建片段」）</p>`
    );
  }

  if (symbols.ok && typeof window.renderGraphSymbolHits === 'function') {
    window.renderGraphSymbolHits(symbols.data);
  } else {
    const msg = symbols.ok
      ? '无命中符号'
      : symbols.err && symbols.err.message
        ? symbols.err.message
        : symbols.err;
    setIndexPanelBox(
      'graph-panel-results',
      `<p class="artifacts-empty">符号通道不可用：${escapeIndexPanelText(msg)}（可先「重建结构」）</p>`
    );
  }
}

/**
 * rail 图标的 busy 态是「任一索引在跑」的合成结果。两个面板各自只写
 * `data-busy-codebase` / `data-busy-graph`，合成只在这里做一次。
 */
function applyIndexRailBusy() {
  const rail = document.querySelector('.side-panel-rail-btn[data-side-tab="index"]');
  if (!rail) return;
  const on = rail.dataset.busyCodebase === '1' || rail.dataset.busyGraph === '1';
  rail.classList.toggle('is-busy', on);
  rail.title = on ? '索引 · 构建中…' : '索引';
  rail.setAttribute('aria-label', on ? '索引，构建中' : '索引');
}

function onIndexPanelShown() {
  if (typeof window.onCodebasePanelShown === 'function') window.onCodebasePanelShown();
  if (typeof window.onGraphPanelShown === 'function') window.onGraphPanelShown();
}

function onIndexPanelHidden() {
  if (typeof window.onCodebasePanelHidden === 'function') window.onCodebasePanelHidden();
  if (typeof window.onGraphPanelHidden === 'function') window.onGraphPanelHidden();
}

function initIndexPanel() {
  const btn = indexPanelEl('index-panel-search-btn');
  if (btn && !btn.dataset.bound) {
    btn.dataset.bound = '1';
    btn.addEventListener('click', () => {
      runIndexPanelSearch().catch(() => {});
    });
  }
  const input = indexPanelEl('index-panel-query');
  if (input && !input.dataset.bound) {
    input.dataset.bound = '1';
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') {
        ev.preventDefault();
        runIndexPanelSearch().catch(() => {});
      }
    });
  }
  // 「刷新」是两侧共用按钮：代码索引侧已绑了自己的刷新，这里补上结构索引的。
  const refresh = indexPanelEl('codebase-panel-refresh');
  if (refresh && !refresh.dataset.boundIndexRefresh) {
    refresh.dataset.boundIndexRefresh = '1';
    refresh.addEventListener('click', () => {
      if (typeof window.refreshGraphPanelStatus === 'function') {
        window.refreshGraphPanelStatus().catch(() => {});
      }
    });
  }
  applyIndexRailBusy();
}

window.INDEX_PANEL_TAB = INDEX_PANEL_TAB;
window.initIndexPanel = initIndexPanel;
window.onIndexPanelShown = onIndexPanelShown;
window.onIndexPanelHidden = onIndexPanelHidden;
window.applyIndexRailBusy = applyIndexRailBusy;
window.runIndexPanelSearch = runIndexPanelSearch;
