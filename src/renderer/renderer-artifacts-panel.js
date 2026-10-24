/* global window, document, sessionArtifacts, artifactsWorkspaceRoot, isSshWorkspacePath, escapeHtml, flatFileIconSvg, formatArtifactDiffHtml */
'use strict';

/**
 * 产物区（工作区面板第 10 页）：本会话 Agent 产出/修改过什么的索引视图。
 *
 * 单一来源约束：
 * - 数据只读 `sessionArtifacts`（trace 驱动的本会话产物桶），不新建采集、不新建持久化；
 * - 点击只调 `window.openArtifactFileAtLine`，预览器仍只有「文件」页那一套（Monaco 单实例）；
 * - 重绘时机挂在 `refreshArtifactsPaneViews`（与文件列表同一拍），不另起轮询。
 */

var productsLastSig = '';
var productsPanelActive = false;

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

function formatProductAge(ts, now) {
  const age = Math.max(0, now - (Number(ts) || 0));
  if (age < 60 * 1000) return '刚刚';
  if (age < 60 * 60 * 1000) return Math.floor(age / 60000) + ' 分钟前';
  if (age < 24 * 60 * 60 * 1000) return Math.floor(age / 3600000) + ' 小时前';
  return Math.floor(age / 86400000) + ' 天前';
}

/** 本会话产物条目（时间倒序）。不做磁盘存在性探测：那需要额外 RPC，且与「文件」页打开时的报错重复。 */
function productsPanelItems() {
  const src = typeof sessionArtifacts !== 'undefined' && Array.isArray(sessionArtifacts) ? sessionArtifacts : [];
  const out = [];
  for (const a of src) {
    if (!a || !a.path) continue;
    const ext = productExtOf(a.path);
    out.push({
      path: a.path,
      name: productNameOf(a.path),
      ts: Number(a.ts) || 0,
      diff: a.diff || null,
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
    escapeHtml(formatProductAge(item.ts, now)) +
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
 * 面板可见 → 首刷。**唯一入口**，由 `setSidePanelTab` 调用。
 * 启动时 `initSidePanel({silent:true})` 会恢复上次 tab，此时容器仍是 hidden：
 * 不挡掉就会在应用启动瞬间白跑一轮渲染。
 */
function onProductsPanelShown() {
  productsPanelActive = true;
  if (!isProductsPaneActive()) return;
  renderProductsPanel({ force: true });
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
}

if (typeof window !== 'undefined') {
  window.onProductsPanelShown = onProductsPanelShown;
  window.onProductsPanelHidden = onProductsPanelHidden;
  window.renderProductsPanel = renderProductsPanel;
  window.refreshProductsPanelIfActive = refreshProductsPanelIfActive;
}
