/* global window, document, sessionArtifacts, artifactsWorkspaceRoot, isSshWorkspacePath, escapeHtml, flatFileIconSvg, formatArtifactDiffHtml, gatewayCall, gwState, currentSessionId, getArtifactBucket, artifactRpcParams, joinArtifactPath, extractRemotePathFromSshUri */
'use strict';

/**
 * 产物区（工作区面板第 10 页）：本会话 Agent 产出/修改过什么的索引视图。
 *
 * 两个数据来源，缺一不可：
 * 1. `sessionArtifacts`（trace 驱动）：带 +/- diff，但只认 `fs_write_file` / `fs_edit`
 *    两个写工具 —— 脚本、截图、插件落盘的文件它看不见；
 * 2. 文件系统扫描（`artifact.list_files` + 会话时间窗）：问「这段窗口里盘上到底改过哪些文件」，
 *    `host_exec` 跑 python-docx / openpyxl、浏览器截图、下载的 docx/xlsx/png/html 全在这一侧。
 *
 * 只留第 1 个来源时，产物区会把「本会话产物」退化成「Agent 手写的代码和 md」——
 * 视图本身早就能分组展示文档/表格/图片（PRODUCT_EXT_GROUP），缺的一直是数据源。
 *
 * 单一来源约束：
 * - 点击只调 `window.openArtifactFileAtLine`，预览器仍只有「文件」页那一套（Monaco 单实例）；
 * - 重绘时机挂在 `refreshArtifactsPaneViews`（与文件列表同一拍），不另起轮询；
 * - 目录遍历与排除表在 `src/gateway/artifact-scan.js`，Renderer 不自己扫盘。
 */

var productsLastSig = '';
var productsPanelActive = false;

/** 会话时间窗内的文件系统扫描结果（trace 之外的产物来源） */
var productsScanFiles = [];
/** 上次扫描的「工作区根 + 会话」标识：变了就必须重扫，旧结果不能顶到新会话上 */
var productsScanKey = '';
var productsScanAt = 0;
var productsScanLoading = false;

/** 扫描节流：产物页可见时最多每 6 秒重扫一次（一次扫描 = 一趟目录遍历） */
var PRODUCTS_SCAN_MIN_INTERVAL_MS = 6000;
var PRODUCTS_SCAN_LIMIT = 200;
var PRODUCTS_SCAN_MAX_DEPTH = 4;

/** 类型分组顺序（按类型视图的展示顺序） */
var PRODUCT_GROUP_ORDER = ['doc', 'data', 'image', 'code', 'other'];

/** 扩展名 → 分组。html 归「文档」因为它走渲染预览而不是编辑器 */
var PRODUCT_EXT_GROUP = {
  doc: ['md', 'markdown', 'txt', 'rst', 'pdf', 'docx', 'doc', 'html', 'htm', 'pptx', 'ppt'],
  data: ['xlsx', 'xls', 'csv', 'tsv', 'json', 'xml', 'sql'],
  image: [
    'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'heic', 'avif', 'tif', 'tiff',
    'mp4', 'webm', 'mov', 'mp3', 'wav'
  ],
  code: [
    'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'py', 'rs', 'go', 'java', 'kt', 'c', 'h', 'cpp',
    'hpp', 'cs', 'php', 'rb', 'swift', 'sh', 'bash', 'css', 'scss', 'less', 'vue', 'svelte',
    'yml', 'yaml', 'toml', 'ini', 'cfg', 'bat', 'ps1', 'lua', 'dart'
  ]
};

function productGroupLabel(group) {
  if (group === 'doc') return '文档';
  if (group === 'data') return '表格';
  if (group === 'image') return '图片';
  if (group === 'code') return '代码';
  return '其他';
}

function isProductsPaneActive() {
  const pane = document.querySelector('.side-panel-pane[data-side-pane="artifacts"]');
  if (!pane || pane.hidden) return false;
  // 还要看外层容器：`setSidePanelTab` 会先把 pane 置为可见再回调 onProductsPanelShown，
  // 而启动恢复上次 tab 时 `#artifacts-panel` 本身仍是 hidden —— 只看 pane.hidden
  // 会把「面板没开」误判成「可见」，白跑一轮渲染。
  const panel = document.getElementById('artifacts-panel');
  return !!(panel && !panel.hidden);
}

/** 扩展名（小写、不含点）；无扩展名返回空串 */
function productExtOf(filePath) {
  const s = String(filePath || '');
  const base = s.slice(Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\')) + 1);
  const i = base.lastIndexOf('.');
  return i > 0 ? base.slice(i + 1).toLowerCase() : '';
}

function productNameOf(filePath) {
  const s = String(filePath || '');
  const parts = s.split(/[\\/]/);
  return parts[parts.length - 1] || s;
}

function productGroupOf(ext) {
  for (const g of PRODUCT_GROUP_ORDER) {
    const list = PRODUCT_EXT_GROUP[g];
    if (list && list.indexOf(ext) >= 0) return g;
  }
  return 'other';
}

/**
 * 绝对化：trace 里的路径可能是模型写的相对路径（`report.md`），扫描结果是绝对路径；
 * 两者不归一就会被当成两个文件各占一行。
 */
function productAbsPath(filePath) {
  const p = String(filePath || '').trim();
  if (!p) return p;
  if (/^ssh:/i.test(p)) return p;
  if (/^[a-zA-Z]:[\\/]/.test(p) || /^[\\/]/.test(p)) return p;
  const root = productWorkspaceRoot();
  if (!root) return p;
  if (/^ssh:/i.test(root)) {
    // 远程工作区：相对路径按远程根拼成 posix 路径（与 gateway 的解析口径一致）
    const remoteRoot =
      typeof extractRemotePathFromSshUri === 'function' ? extractRemotePathFromSshUri(root) : '';
    if (!remoteRoot) return p;
    return remoteRoot.replace(/\/+$/, '') + '/' + p.replace(/^[\\/]+/, '').replace(/\\/g, '/');
  }
  if (typeof joinArtifactPath === 'function') return joinArtifactPath(root, p);
  return String(root).replace(/[\\/]+$/, '') + (root.includes('\\') ? '\\' : '/') + p.replace(/^[\\/]+/, '');
}

/** 去重键：绝对化 + 统一分隔符 + 小写（Windows 大小写不敏感） */
function productPathKey(filePath) {
  const abs = productAbsPath(filePath);
  return abs ? abs.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase() : '';
}

/**
 * 本会话产物条目（时间倒序）：trace 产物（带 diff）+ 会话窗口内盘上变过的文件。
 *
 * 不做磁盘存在性探测：那需要额外 RPC，且与「文件」页打开时的报错重复。
 */
function productsPanelItems() {
  const merged = new Map();
  function upsert(filePath, row) {
    const abs = productAbsPath(filePath);
    const key = productPathKey(abs);
    if (!key) return;
    const prev = merged.get(key);
    if (!prev) {
      merged.set(key, {
        path: abs,
        ts: Number(row.ts) || 0,
        diff: row.diff || null,
        source: row.source
      });
      return;
    }
    if ((Number(row.ts) || 0) > prev.ts) prev.ts = Number(row.ts) || 0;
    // trace 侧的 diff 是唯一来源：扫描只知道「变了」，不知道变了几行
    if (row.diff && !prev.diff) prev.diff = row.diff;
    if (row.source === 'trace') prev.source = 'trace';
  }

  const traced =
    typeof sessionArtifacts !== 'undefined' && Array.isArray(sessionArtifacts) ? sessionArtifacts : [];
  for (const a of traced) {
    if (!a || !a.path) continue;
    upsert(a.path, { ts: a.ts, diff: a.diff || null, source: 'trace' });
  }
  for (const f of productsScanFiles) {
    if (!f || !f.path) continue;
    upsert(f.path, { ts: f.ts, diff: null, source: 'fs' });
  }

  const out = [];
  for (const row of merged.values()) {
    const ext = productExtOf(row.path);
    out.push({
      path: row.path,
      name: productNameOf(row.path),
      ts: row.ts,
      diff: row.diff,
      source: row.source,
      ext,
      group: productGroupOf(ext),
      label: ext ? ext.slice(0, 4).toUpperCase() : 'FILE'
    });
  }
  out.sort(function (x, y) {
    return y.ts - x.ts;
  });
  return out;
}

function paintProductsSummary(items) {
  const el = document.getElementById('products-panel-summary');
  if (!el) return;
  if (!items.length) {
    el.textContent = '0 项';
    el.title = '';
    return;
  }
  const counts = { doc: 0, data: 0, image: 0, code: 0, other: 0 };
  for (const p of items) counts[p.group] = (counts[p.group] || 0) + 1;
  const parts = [];
  if (counts.image) parts.push('图 ' + counts.image);
  if (counts.doc) parts.push('文档 ' + counts.doc);
  if (counts.data) parts.push('表格 ' + counts.data);
  if (counts.code) parts.push('代码 ' + counts.code);
  if (counts.other) parts.push('其他 ' + counts.other);
  // 头部空间有限：只显示总数，类型分布挂 title（窄面板下不被截半句）
  el.textContent = items.length + ' 项';
  el.title = items.length + ' 项 · ' + parts.join(' ');
}

/** 会话窗口起点（产物区「本会话」的时间下界）；拿不到就退化成不设窗口 */
function productsScanSinceMs() {
  if (typeof getArtifactBucket !== 'function') return 0;
  const bucket = getArtifactBucket(undefined, false);
  const since = bucket && Number(bucket.sinceTs);
  return Number.isFinite(since) && since > 0 ? since : 0;
}

/** 扫描标识：换工作区或换会话都必须重扫，否则旧结果会顶到新上下文上 */
function productsScanIdentity() {
  return (
    productWorkspaceRoot() +
    '#' +
    String(typeof currentSessionId !== 'undefined' && currentSessionId ? currentSessionId : '')
  );
}

/**
 * 向文件系统追问「本会话窗口里改过哪些文件」。
 *
 * 这是产物区唯一会走磁盘的来源，因此：
 * - 只在产物页可见时跑（由 onProductsPanelShown / refreshProductsPanelIfActive 触发）；
 * - 按 PRODUCTS_SCAN_MIN_INTERVAL_MS 节流，思考流那 80ms 一拍的刷新不会变成扫盘风暴；
 * - 失败静默保留上一次结果：扫描是补充来源，trace 来源仍在，产物页不会因此变空。
 */
async function refreshProductsScan(force) {
  if (productsScanLoading) return;
  if (typeof gatewayCall !== 'function') return;
  if (typeof gwState === 'undefined' || !gwState || !gwState.authed) return;
  const root = productWorkspaceRoot();
  if (!root) {
    productsScanFiles = [];
    return;
  }
  const key = productsScanIdentity();
  const now = Date.now();
  if (!force && key === productsScanKey && now - productsScanAt < PRODUCTS_SCAN_MIN_INTERVAL_MS) return;

  // 换会话 / 换工作区：先丢掉旧结果，别让上一个上下文的产物在新列表里停一会儿
  if (key !== productsScanKey) {
    productsScanFiles = [];
    productsScanKey = key;
  }
  productsScanLoading = true;
  try {
    const base = {
      dirPath: root,
      limit: PRODUCTS_SCAN_LIMIT,
      maxDepth: PRODUCTS_SCAN_MAX_DEPTH,
      sinceMs: productsScanSinceMs()
    };
    const params = typeof artifactRpcParams === 'function' ? await artifactRpcParams(base) : base;
    const res = await gatewayCall('artifact.list_files', params);
    const files = res && Array.isArray(res.files) ? res.files : [];
    productsScanFiles = files
      .map(function (f) {
        return { path: String((f && f.path) || ''), ts: Number(f && f.mtimeMs) || 0 };
      })
      .filter(function (f) {
        return !!f.path;
      });
  } catch {
    // 扫描只是补充来源：SSH 掉线 / 目录不可读时保持上一次结果，trace 来源照常显示
  } finally {
    productsScanLoading = false;
    productsScanAt = Date.now();
  }
  renderProductsPanel({ force: true });
}

/** 工作区被换掉 / 会话产物整体作废时调用：扫描结果与窗口一起失效 */
function resetProductsScan() {
  productsScanFiles = [];
  productsScanKey = '';
  productsScanAt = 0;
  productsLastSig = '';
}

/** 当前产物区所属工作区根（与文件面板同源，不另记一份工作区状态） */
function productWorkspaceRoot() {
  const viewPath =
    typeof window !== 'undefined' && window.activeViewSessionWorkspacePath
      ? String(window.activeViewSessionWorkspacePath)
      : '';
  if (viewPath) return viewPath;
  return typeof artifactsWorkspaceRoot !== 'undefined' ? String(artifactsWorkspaceRoot || '') : '';
}

/** SSH 工作区：路径是远端的，本地既定位不了也不该给可点的视觉暗示 */
function productWorkspaceIsSsh() {
  const root = productWorkspaceRoot();
  if (!root) return false;
  if (typeof isSshWorkspacePath === 'function') return !!isSshWorkspacePath(root);
  return /^ssh:/i.test(root);
}

/** 相对工作区路径（更短、更好读）；裁不掉（如远端 URI）就原样返回 */
function productDisplayPath(filePath) {
  const p = String(filePath || '');
  const root = productWorkspaceRoot();
  if (!root || /^ssh:/i.test(root)) return p;
  const norm = function (s) {
    return String(s || '')
      .replace(/\\/g, '/')
      .replace(/\/+$/, '');
  };
  const r = norm(root);
  const n = norm(p);
  if (!r) return p;
  // Windows 盘符大小写不一致是常态，比较用 lowercase，取值仍用原串
  if (n.toLowerCase() === r.toLowerCase()) return '.';
  if (n.toLowerCase().indexOf(r.toLowerCase() + '/') === 0) return n.slice(r.length + 1);
  return p;
}

function buildProductRow(item, now) {
  const el = document.createElement('div');
  el.className = 'artifacts-file-item products-item';
  el.title = item.path;
  if (item.ext) el.setAttribute('data-product-ext', item.ext);
  const isSsh = productWorkspaceIsSsh();
  const shownPath = productDisplayPath(item.path);
  const diffHtml = item.diff ? formatArtifactDiffHtml({ added: item.diff.added, removed: item.diff.removed }) : '';
  el.innerHTML =
    '<span class="artifacts-file-icon">' +
    flatFileIconSvg(16) +
    '</span><span class="products-item-main">' +
    '<span class="products-item-line">' +
    '<span class="artifacts-file-name">' +
    escapeHtml(item.name) +
    '</span><span class="products-item-type">' +
    escapeHtml(item.label) +
    '</span><span class="products-item-gap"></span>' +
    diffHtml +
    '<span class="products-item-age">' +
    escapeHtml(fmtRelAgo(item.ts, { fallback: 'none', now })) +
    '</span></span>' +
    '<span class="products-item-path' +
    (isSsh ? '' : ' is-clickable') +
    '">' +
    escapeHtml(shownPath) +
    '</span></span>';
  el.addEventListener('click', function () {
    openProductItem(item.path);
  });
  if (isSsh) {
    // 远端路径本地定位不了：点路径不触发打开（整行其余区域仍可预览）
    const pathEl = el.querySelector('.products-item-path');
    if (pathEl) {
      pathEl.addEventListener('click', function (ev) {
        ev.stopPropagation();
      });
    }
  }
  return el;
}

/** 打开产物：复用文件面板的打开入口（含切换 tab / Monaco / 权威路径解析） */
function openProductItem(filePath) {
  const fp = String(filePath || '').trim();
  if (!fp) return;
  if (typeof window.openArtifactFileAtLine === 'function') {
    void window.openArtifactFileAtLine(fp);
    return;
  }
  if (typeof window.setSidePanelTab === 'function') window.setSidePanelTab('files');
}

function appendProductsGroup(list, title, items, now) {
  const head = document.createElement('div');
  head.className = 'products-group-head';
  head.textContent = title;
  list.appendChild(head);
  for (const it of items) list.appendChild(buildProductRow(it, now));
}

function renderProductsPanel(opts) {
  const list = document.getElementById('products-list');
  if (!list) return;
  if (opts && opts.force) productsLastSig = '';

  const items = productsPanelItems();
  const now = Date.now();
  paintProductsSummary(items);

  // 签名必须含工作区根：同一批产物换个工作区后，相对路径与「可点」判定都会变，
  // 只按 path@ts:diff 去重会让本页一直显示旧根下的路径（文件页已按新根刷新）。
  const sig =
    productWorkspaceRoot() +
    '#' +
    items
      .map(function (p) {
        return p.path + '@' + p.ts + ':' + (p.diff && p.diff.added) + '/' + (p.diff && p.diff.removed);
      })
      .join('|');
  if (sig === productsLastSig && list.childElementCount > 0) return;
  productsLastSig = sig;

  const prevScrollTop = list.scrollTop;
  list.replaceChildren();

  if (!items.length) {
    list.innerHTML =
      '<div class="products-empty">' +
      '<div class="products-empty-title">本会话还没有产物</div>' +
      '<div class="products-empty-hint">Agent 生成或修改的文件会自动出现在这里</div>' +
      '</div>';
    return;
  }

  // 固定按类型分组；组内保持时间倒序（productsPanelItems 已排序）
  for (const g of PRODUCT_GROUP_ORDER) {
    const rows = items.filter(function (p) {
      return p.group === g;
    });
    if (rows.length) appendProductsGroup(list, productGroupLabel(g), rows, now);
  }

  list.scrollTop = prevScrollTop;
}

/**
 * 面板可见 → 首刷 + 重扫。**唯一入口**，由 `setSidePanelTab` 调用。
 * 启动时 `initSidePanel({silent:true})` 会恢复上次 tab，此时容器仍是 hidden：
 * 不挡掉就会在应用启动瞬间白跑一轮渲染（与一趟目录遍历）。
 */
function onProductsPanelShown() {
  productsPanelActive = true;
  if (!isProductsPaneActive()) return;
  renderProductsPanel({ force: true });
  void refreshProductsScan(true);
}

function onProductsPanelHidden() {
  productsPanelActive = false;
}

/** 数据更新跟随：由 refreshArtifactsPaneViews 在同一拍调用，避免各 pane 各扫一遍 */
function refreshProductsPanelIfActive() {
  if (!productsPanelActive) return;
  if (typeof isSidePanelOpen === 'function' && !isSidePanelOpen()) return;
  if (!isProductsPaneActive()) return;
  renderProductsPanel();
  // 脚本 / 截图落盘的产物没有 trace 事件可得，只能按节流重扫（见 refreshProductsScan）
  void refreshProductsScan(false);
}

if (typeof window !== 'undefined') {
  window.onProductsPanelShown = onProductsPanelShown;
  window.onProductsPanelHidden = onProductsPanelHidden;
  window.renderProductsPanel = renderProductsPanel;
  window.refreshProductsPanelIfActive = refreshProductsPanelIfActive;
  window.refreshProductsScan = refreshProductsScan;
  window.resetProductsScan = resetProductsScan;
}
