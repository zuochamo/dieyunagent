/* global window, document, $, gwState, gatewayCall, showAgentToast,
   currentSessionId, resolveSessionWorkspacePathForRpc, resolveSessionWorkspacePathSync,
   compactPlainText, CTX_LIMITS, generateWikiKnowledgeBase, renderMarkdownWithMermaid,
   isSidePanelOpen, getSidePanelTab */
'use strict';

const WIKI_DISPLAY_SLUG = 'knowledge-base';

let wikiPanelGenerating = false;
/** @type {string} */
let wikiPanelProgressMsg = '';
/** @type {string} */
let wikiStreamBuffer = '';
/** @type {{ wrap: HTMLElement, textEl: HTMLElement, caret: HTMLElement }|null} */
let wikiStreamUi = null;
/** @type {AbortController|null} */
let wikiGenAbort = null;
/** @type {ReturnType<typeof setInterval>|null} */
let wikiWaitTimer = null;
/** 当前展示用的 Markdown 原文（供下载） */
let wikiPanelBody = '';
/** wikiPanelBody / 流式预览所属工作区，换会话时必须对照，避免显示串台 */
let wikiLoadedWorkspacePath = '';
/** 正在生成的目标工作区（可与当前侧栏工作区不同） */
let wikiGeneratingWorkspacePath = '';
/** @type {number} */
let wikiLoadGen = 0;

const WIKI_GEN_TIMEOUT_MS = 5 * 60 * 1000;

function clearWikiWaitTimer() {
  if (wikiWaitTimer) {
    clearInterval(wikiWaitTimer);
    wikiWaitTimer = null;
  }
}

function normWikiWorkspaceKey(p) {
  return String(p || '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/\/+$/, '')
    .toLowerCase();
}

function sameWikiWorkspace(a, b) {
  const na = normWikiWorkspaceKey(a);
  const nb = normWikiWorkspaceKey(b);
  return !!(na && nb && na === nb);
}

function wikiRpcScope(workspacePath) {
  const root = String(workspacePath || '').trim();
  if (!root) return {};
  return { workspacePath: root, runWorkspaceRoot: root };
}

function resolveWikiPanelWorkspacePath() {
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

function clearWikiPanelDisplayCache() {
  wikiPanelBody = '';
  wikiStreamBuffer = '';
  wikiLoadedWorkspacePath = '';
  wikiStreamUi = null;
}

function setWikiPanelStatus(text) {
  wikiPanelProgressMsg = text || '';
  const el = $('wiki-panel-status');
  if (el) el.textContent = wikiPanelProgressMsg;
  syncWikiRailBusy();
}

function syncWikiRailBusy() {
  const rail = document.querySelector('.side-panel-rail-btn[data-side-tab="wiki"]');
  if (!rail) return;
  const busy = wikiPanelGenerating;
  rail.classList.toggle('is-busy', busy);
  if (busy) {
    const tip = wikiPanelProgressMsg || '生成中…';
    rail.title = `Wiki · ${tip}`;
    rail.setAttribute('aria-label', `Wiki，${tip}`);
  } else {
    rail.title = 'Wiki';
    rail.setAttribute('aria-label', 'Wiki');
  }
}

function setWikiGenerateBusy(busy) {
  wikiPanelGenerating = !!busy;
  const btn = $('wiki-panel-generate');
  if (btn) {
    // 生成中可点「取消」，不要 disabled 卡死
    btn.disabled = false;
    btn.textContent = busy ? '取消' : '生成';
    btn.title = busy ? '取消本次生成' : 'AI 扫描项目并生成知识库';
  }
  syncWikiRailBusy();
}

function showWikiWaiting(msg) {
  const ui = ensureWikiStreamUi();
  if (!ui) return;
  if (!wikiStreamBuffer) {
    ui.textEl.textContent = String(msg || '等候模型输出…');
  }
}

function showWikiEmpty(msg) {
  const preview = $('wiki-panel-preview');
  if (!preview) return;
  wikiStreamUi = null;
  wikiPanelBody = '';
  syncWikiDownloadEnabled();
  preview.replaceChildren();
  const empty = document.createElement('p');
  empty.className = 'artifacts-empty';
  empty.textContent = msg || '点击「生成」，由 AI 扫描项目并生成文档';
  preview.appendChild(empty);
}

function syncWikiDownloadEnabled() {
  const btn = $('wiki-panel-download');
  if (!btn) return;
  const has =
    !!(wikiPanelBody && wikiPanelBody.trim()) ||
    !!(wikiStreamBuffer && wikiStreamBuffer.trim());
  btn.disabled = !has;
}

function ensureWikiStreamUi() {
  const preview = $('wiki-panel-preview');
  if (!preview) return null;
  if (wikiStreamUi && preview.contains(wikiStreamUi.wrap)) return wikiStreamUi;
  preview.replaceChildren();
  const wrap = document.createElement('div');
  wrap.className = 'wiki-md-view wiki-md-streaming';
  const textEl = document.createElement('span');
  textEl.className = 'wiki-stream-text';
  const caret = document.createElement('span');
  caret.className = 'wiki-stream-caret';
  caret.setAttribute('aria-hidden', 'true');
  wrap.appendChild(textEl);
  wrap.appendChild(caret);
  preview.appendChild(wrap);
  wikiStreamUi = { wrap, textEl, caret };
  return wikiStreamUi;
}

function updateWikiStreamPreview(text) {
  wikiStreamBuffer = String(text || '');
  syncWikiDownloadEnabled();
  const ui = ensureWikiStreamUi();
  if (!ui) return;
  ui.textEl.textContent = wikiStreamBuffer;
  const preview = $('wiki-panel-preview');
  if (preview) preview.scrollTop = preview.scrollHeight;
}

function endWikiStreamUi() {
  if (wikiStreamUi) {
    try {
      wikiStreamUi.caret?.remove();
      wikiStreamUi.wrap?.classList.remove('wiki-md-streaming');
    } catch {
      // ignore
    }
  }
  wikiStreamUi = null;
}

async function renderWikiPreview(body) {
  const preview = $('wiki-panel-preview');
  if (!preview) return;
  endWikiStreamUi();
  wikiPanelBody = String(body || '');
  syncWikiDownloadEnabled();
  if (!wikiPanelBody.trim()) {
    showWikiEmpty();
    return;
  }
  if (typeof renderMarkdownWithMermaid === 'function') {
    await renderMarkdownWithMermaid(preview, wikiPanelBody);
  } else {
    preview.textContent = wikiPanelBody;
  }
}

function wikiDownloadFilename(md) {
  const first = String(md || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.startsWith('# '));
  let name = first ? first.replace(/^#\s+/, '').trim() : WIKI_DISPLAY_SLUG;
  name = name
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '')
    .replace(/\s+/g, '-')
    .slice(0, 80);
  if (!name) name = WIKI_DISPLAY_SLUG;
  return name.toLowerCase().endsWith('.md') ? name : `${name}.md`;
}

async function downloadWikiMarkdown() {
  const root = resolveWikiPanelWorkspacePath();
  let body = '';
  if (sameWikiWorkspace(wikiLoadedWorkspacePath, root)) {
    body = (wikiPanelBody && wikiPanelBody.trim()) || (wikiStreamBuffer && wikiStreamBuffer.trim()) || '';
  }
  if (!body) {
    if (root && gwState && gwState.authed) {
      try {
        const page = await gatewayCall('wiki.read', {
          ...wikiRpcScope(root),
          slug: WIKI_DISPLAY_SLUG
        });
        body = page && page.body != null ? String(page.body).trim() : '';
        if (body) {
          wikiPanelBody = body;
          wikiLoadedWorkspacePath = root;
          syncWikiDownloadEnabled();
        }
      } catch {
        // fall through
      }
    }
  }
  if (!body) {
    if (typeof showAgentToast === 'function') {
      showAgentToast('无可下载内容', '请先生成知识库', { variant: 'warn' });
    }
    return;
  }
  const filename = wikiDownloadFilename(body);
  const blob = new Blob([body], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  }
  if (typeof showAgentToast === 'function') {
    showAgentToast('已下载', filename, { variant: 'info' });
  }
}

async function loadWikiDisplayPage() {
  const root = resolveWikiPanelWorkspacePath();
  const loadId = ++wikiLoadGen;
  if (!root || !gwState || !gwState.authed) {
    clearWikiPanelDisplayCache();
    showWikiEmpty('请先打开工作空间');
    return;
  }
  try {
    const page = await gatewayCall('wiki.read', {
      ...wikiRpcScope(root),
      slug: WIKI_DISPLAY_SLUG
    });
    if (loadId !== wikiLoadGen) return;
    if (!sameWikiWorkspace(root, resolveWikiPanelWorkspacePath())) return;
    wikiLoadedWorkspacePath = root;
    await renderWikiPreview(page && page.body != null ? String(page.body) : '');
  } catch {
    if (loadId !== wikiLoadGen) return;
    if (!sameWikiWorkspace(root, resolveWikiPanelWorkspacePath())) return;
    wikiLoadedWorkspacePath = root;
    showWikiEmpty();
  }
}

async function generateWikiPage() {
  const root = resolveWikiPanelWorkspacePath();
  if (!root) {
    if (typeof showAgentToast === 'function') {
      showAgentToast('未选工作区', '请先打开工作空间', { variant: 'warn' });
    }
    return;
  }
  if (wikiPanelGenerating) {
    if (wikiGenAbort) {
      try {
        wikiGenAbort.abort();
      } catch {
        // ignore
      }
      setWikiPanelStatus('正在取消…');
    }
    return;
  }

  const gen =
    typeof generateWikiKnowledgeBase === 'function'
      ? generateWikiKnowledgeBase
      : typeof window.generateWikiKnowledgeBase === 'function'
        ? window.generateWikiKnowledgeBase
        : null;
  if (!gen) {
    if (typeof showAgentToast === 'function') {
      showAgentToast('生成不可用', '知识库生成模块未加载', { variant: 'warn' });
    }
    return;
  }

  wikiGenAbort = new AbortController();
  const abort = wikiGenAbort;
  const killTimer = setTimeout(() => {
    try {
      abort.abort();
    } catch {
      // ignore
    }
  }, WIKI_GEN_TIMEOUT_MS);

  setWikiGenerateBusy(true);
  wikiGeneratingWorkspacePath = root;
  wikiLoadedWorkspacePath = root;
  setWikiPanelStatus('扫描项目…');
  wikiStreamBuffer = '';
  showWikiWaiting('正在扫描项目…');
  let waitedSec = 0;
  clearWikiWaitTimer();
  wikiWaitTimer = setInterval(() => {
    if (!wikiPanelGenerating || wikiStreamBuffer) {
      clearWikiWaitTimer();
      return;
    }
    waitedSec += 5;
    setWikiPanelStatus(`模型生成文档… 已等待 ${waitedSec}s`);
    showWikiWaiting(
      `正在请求模型（已等 ${waitedSec}s）…\n首包到达前可能较慢；超过约 5 分钟会自动取消。\n可点「取消」中止。`
    );
  }, 5000);

  try {
    const result = await gen(root, {
      signal: abort.signal,
      onProgress: (msg) => {
        if (!sameWikiWorkspace(wikiGeneratingWorkspacePath, resolveWikiPanelWorkspacePath())) return;
        setWikiPanelStatus(String(msg || ''));
        if (/模型生成|补全架构|扫描|写入/.test(String(msg || '')) && !wikiStreamBuffer) {
          showWikiWaiting(String(msg || '等候模型输出…'));
        }
      },
      onStream: (text) => {
        if (!wikiPanelGenerating) return;
        if (!sameWikiWorkspace(wikiGeneratingWorkspacePath, resolveWikiPanelWorkspacePath())) return;
        const t = String(text || '');
        if (!t) {
          showWikiWaiting('等候模型输出…');
          return;
        }
        clearWikiWaitTimer();
        updateWikiStreamPreview(t);
      }
    });
    const body =
      result && result.body != null
        ? String(result.body)
        : wikiStreamBuffer;
    if (sameWikiWorkspace(root, resolveWikiPanelWorkspacePath())) {
      wikiLoadedWorkspacePath = root;
      if (body.trim()) await renderWikiPreview(body);
      else await loadWikiDisplayPage();
      setWikiPanelStatus('已生成');
    }
    wikiStreamBuffer = '';
    if (typeof showAgentToast === 'function') {
      showAgentToast('知识库已生成', '已写入 .dieyun/wiki', { variant: 'info' });
    }
  } catch (err) {
    const aborted =
      (err && (err.name === 'AbortError' || err.code === 'ABORT_ERR')) ||
      (abort && abort.signal.aborted);
    const stillViewing = sameWikiWorkspace(root, resolveWikiPanelWorkspacePath());
    if (stillViewing) setWikiPanelStatus(aborted ? '已取消' : '');
    if (stillViewing && wikiStreamBuffer.trim()) {
      wikiLoadedWorkspacePath = root;
      updateWikiStreamPreview(wikiStreamBuffer);
      endWikiStreamUi();
    } else if (stillViewing && aborted) {
      showWikiEmpty('已取消生成');
    }
    if (typeof showAgentToast === 'function') {
      showAgentToast(
        aborted ? '已取消' : '生成失败',
        aborted
          ? 'Wiki 生成已中止'
          : err && err.message
            ? err.message
            : String(err),
        { variant: 'warn' }
      );
    }
  } finally {
    clearTimeout(killTimer);
    clearWikiWaitTimer();
    if (wikiGenAbort === abort) wikiGenAbort = null;
    if (sameWikiWorkspace(wikiGeneratingWorkspacePath, root)) {
      wikiGeneratingWorkspacePath = '';
    }
    setWikiGenerateBusy(false);
  }
}

function onWikiPanelShown() {
  const root = resolveWikiPanelWorkspacePath();

  // 仅当「正在为本工作区生成」时复用流式 UI；否则立即切到当前工作区内容
  if (wikiPanelGenerating && sameWikiWorkspace(wikiGeneratingWorkspacePath, root)) {
    setWikiPanelStatus(wikiPanelProgressMsg || '生成中…');
    setWikiGenerateBusy(true);
    if (wikiStreamBuffer) updateWikiStreamPreview(wikiStreamBuffer);
    else showWikiWaiting(wikiPanelProgressMsg || '等候模型输出…');
    return;
  }

  // 取消后未落盘的半成品：仅同工作区保留，避免串到别的工作区
  if (
    wikiStreamBuffer.trim() &&
    !wikiPanelBody.trim() &&
    sameWikiWorkspace(wikiLoadedWorkspacePath || wikiGeneratingWorkspacePath, root)
  ) {
    updateWikiStreamPreview(wikiStreamBuffer);
    endWikiStreamUi();
    return;
  }

  if (wikiPanelBody.trim() && sameWikiWorkspace(wikiLoadedWorkspacePath, root)) {
    void renderWikiPreview(wikiPanelBody);
    return;
  }

  // 工作区已变或尚无缓存 → 重新读当前工作区
  clearWikiPanelDisplayCache();
  void loadWikiDisplayPage();
}

/** 会话/工作区切换后：侧栏打开 Wiki 则立刻刷新；否则丢弃错工作区缓存 */
function refreshWikiPanelIfNeeded() {
  const root = resolveWikiPanelWorkspacePath();
  const open = typeof isSidePanelOpen === 'function' && isSidePanelOpen();
  const tab = typeof getSidePanelTab === 'function' ? getSidePanelTab() : '';
  if (open && tab === 'wiki') {
    onWikiPanelShown();
    return;
  }
  if (
    wikiLoadedWorkspacePath &&
    root &&
    !sameWikiWorkspace(wikiLoadedWorkspacePath, root) &&
    !(wikiPanelGenerating && sameWikiWorkspace(wikiGeneratingWorkspacePath, root))
  ) {
    clearWikiPanelDisplayCache();
  }
}

function initWikiPanelUI() {
  $('wiki-panel-generate')?.addEventListener('click', () => {
    void generateWikiPage();
  });
  $('wiki-panel-download')?.addEventListener('click', () => {
    void downloadWikiMarkdown();
  });
  syncWikiDownloadEnabled();
}

/**
 * 侧栏检索用：标题 + 短摘要。对话不再自动注入 Wiki。
 */
async function fetchWikiCatalog(userQuery, workspacePath) {
  if (!gwState || !gwState.authed || !workspacePath) return '';
  const limit =
    typeof CTX_LIMITS !== 'undefined' && CTX_LIMITS.WIKI_RECALL_LIMIT
      ? CTX_LIMITS.WIKI_RECALL_LIMIT
      : 8;
  const summaryMax =
    typeof CTX_LIMITS !== 'undefined' && CTX_LIMITS.WIKI_SUMMARY_MAX
      ? CTX_LIMITS.WIKI_SUMMARY_MAX
      : 120;
  try {
    const recall = await gatewayCall(
      'wiki.recall',
      {
        ...wikiRpcScope(workspacePath),
        query: String(userQuery || '').trim(),
        limit
      },
      { timeoutMs: 8000 }
    );
    const rows = recall && Array.isArray(recall.results) ? recall.results : [];
    if (!rows.length) return '';
    const compact =
      typeof compactPlainText === 'function'
        ? compactPlainText
        : (s, n) => String(s || '').slice(0, n);
    const lines = rows.map((row) => {
      const summary = compact(row.summary || '', summaryMax);
      return `- ${row.title || row.slug}${summary ? `：${summary}` : ''}\n  路径：${row.path || `.dieyun/wiki/${row.slug}.md`}`;
    });
    return (
      `【项目 Wiki】\n` +
      `工作空间：${workspacePath}\n` +
      `相关约定见下列页面；需要正文时用 fs_read_file 读取路径。与用户最新输入冲突时以用户为准。\n` +
      `${lines.join('\n')}`
    );
  } catch {
    return '';
  }
}

window.onWikiPanelShown = onWikiPanelShown;
window.refreshWikiPanelIfNeeded = refreshWikiPanelIfNeeded;
window.initWikiPanelUI = initWikiPanelUI;
window.fetchWikiCatalog = fetchWikiCatalog;
window.WIKI_DISPLAY_SLUG = WIKI_DISPLAY_SLUG;

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initWikiPanelUI);
  } else {
    initWikiPanelUI();
  }
}
