/* global window, document */
var missingElementCache = new Map();

function $(id) {
  const cached = missingElementCache.get(id);
  if (cached) {
    const real = document.getElementById(id);
    if (real && real !== cached) {
      missingElementCache.delete(id);
      return real;
    }
    return cached;
  }
  const el = document.getElementById(id);
  if (el) return el;
  const fallback = document.createElement('div');
  fallback.id = id;
  fallback.hidden = true;
  fallback.style.display = 'none';
  missingElementCache.set(id, fallback);
  return fallback;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function flatFolderIconSvg(size) {
  const n = Number(size) || 16;
  return (
    '<svg viewBox="0 0 24 24" width="' +
    n +
    '" height="' +
    n +
    '" aria-hidden="true"><path d="M3.5 6.5h6l2 2h9v9.5h-17z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>'
  );
}

function flatFileIconSvg(size) {
  const n = Number(size) || 16;
  return (
    '<svg viewBox="0 0 24 24" width="' +
    n +
    '" height="' +
    n +
    '" aria-hidden="true"><path d="M8 4h7l3 3v13H8z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>' +
    '<path d="M15 4v4h4" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>'
  );
}

function flatDirUpIconSvg(size) {
  const n = Number(size) || 16;
  return (
    '<svg viewBox="0 0 24 24" width="' +
    n +
    '" height="' +
    n +
    '" aria-hidden="true"><path d="M15 6l-6 6 6 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>'
  );
}

function showOverlay(id, visible) {
  const overlay = $(id);
  if (overlay) overlay.hidden = !visible;
}

function parentRemotePath(remotePath) {
  const parts = String(remotePath || '/')
    .replace(/\/+$/, '')
    .split('/')
    .filter(Boolean);
  parts.pop();
  return parts.length ? '/' + parts.join('/') : '/';
}

/**
 * 出站图片 URL 的渲染器统一闸门（附件发送 / 出站消息清洗共用）。
 *
 * 判定规则（以实际字节为准、只放行上游支持的 png/jpeg/gif/webp）单一来源是
 * guardrails-shared.sanitizeImageUrlForApi，返回 '' 表示该图必须省略——带着
 * bmp/svg/坏 base64 出门，整轮请求会被上游 400 "unsupported image" 打回。
 *
 * agent-bundle 未重建而缺该 API 时退回原样放行（相当于改动前的行为），
 * 只告警不静默丢图，避免「所有图片都不发」这种更重的回归。
 */
function sanitizeOutboundImageUrl(url) {
  const raw = String(url || '');
  const shared = typeof window !== 'undefined' ? window.GuardrailsShared : null;
  if (shared && typeof shared.sanitizeImageUrlForApi === 'function') {
    return shared.sanitizeImageUrlForApi(raw);
  }
  // 拿不到共用闸门时必须「失败关闭」：带着未校验的图片出门，上游会以 HTTP 400
  // ".messages[N].image[0]: unsupported image" 打回整轮请求（含历史里重发的旧图）。
  // 少一张图 vs 整轮对话不可用，前者可接受；Main 侧（llm-stream-bridge → guardrails-shared）还有同一道闸兜底。
  console.warn('[renderer] GuardrailsShared 未加载，出站图片一律省略（需重建 agent-bundle）');
  return '';
}

/**
 * Electron renderer 不支持 window.prompt；用轻量对话框代替。
 * @returns {Promise<string|null>} null = 取消
 */
function showTextPrompt(title, defaultValue = '', opts = {}) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'settings-overlay text-prompt-overlay';
    const hint = opts.hint
      ? `<p class="field-hint text-prompt-hint">${escapeHtml(opts.hint).replace(/\n/g, '<br>')}</p>`
      : '';
    const fieldLabel = opts.fieldLabel != null ? String(opts.fieldLabel) : '输入';
    const fieldLabelHtml = fieldLabel
      ? `<span class="field-label">${escapeHtml(fieldLabel)}</span>`
      : '';
    overlay.innerHTML =
      '<div class="settings-dialog text-prompt-dialog" role="dialog" aria-modal="true">' +
      '<div class="settings-main">' +
      '<header class="settings-main-head">' +
      `<h2 class="settings-main-title">${escapeHtml(title || '输入')}</h2>` +
      '</header>' +
      '<div class="settings-main-body">' +
      hint +
      '<label class="field text-prompt-field">' +
      fieldLabelHtml +
      '<input type="text" class="text-prompt-input" spellcheck="false" autocomplete="off" />' +
      '</label>' +
      '<div class="ssh-connect-footer text-prompt-footer">' +
      '<div class="ssh-connect-actions">' +
      '<button type="button" class="primary-btn text-prompt-ok">确定</button>' +
      '<button type="button" class="ghost-btn text-prompt-cancel">取消</button>' +
      '</div></div></div></div></div>';
    document.body.appendChild(overlay);
    const input = overlay.querySelector('.text-prompt-input');
    const finish = (val) => {
      overlay.remove();
      resolve(val);
    };
    if (input) {
      input.value = String(defaultValue ?? '');
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          finish(input.value);
        } else if (e.key === 'Escape') {
          e.preventDefault();
          finish(null);
        }
      });
      setTimeout(() => {
        input.focus();
        input.select();
      }, 0);
    }
    overlay.querySelector('.text-prompt-ok')?.addEventListener('click', () => {
      finish(input ? input.value : '');
    });
    overlay.querySelector('.text-prompt-cancel')?.addEventListener('click', () => finish(null));
  });
}

/**
 * 代码片段向量的一致性文案（唯一一份）。
 *
 * 判定由 core 给出（库里实际写入的签名 vs 当前设置），这里只负责措辞 —— `stale` 为真时
 * 语义检索会静默退化成子串匹配，所以要提示重建。
 *
 * `chunks` 是 chunk 总数：向量数少于 chunk 数说明增量重建过文件却没带向量，那部分内容
 * 只能靠子串通道召回 —— 这条以前显示成「与当前设置一致」，等于把"半残"说成"正常"。
 * @param {{count?: number, chunks?: number, stale?: boolean, enabled?: boolean}} info
 * @returns {string}
 */
function describeVectorSync(info) {
  const count = Number(info && info.count) || 0;
  const chunks = Number(info && info.chunks) || 0;
  if (count <= 0) return '未写入向量';
  if (info && info.stale) return '⚠ 与当前设置不一致，建议重建';
  if (info && info.enabled === false) return '当前未启用向量（库内为旧数据）';
  if (chunks > count) return `⚠ 仅覆盖 ${count}/${chunks} 段，建议重建补齐`;
  return '与当前设置一致';
}

/* ------------------------------------------------------------------ *
 * 时间 / 字节 / 进度条：**界面文案的唯一来源**
 *
 * 这几类文案原先散在 8 个文件里各写一份（7 个「相对时间」、2 个进度条、2 个字节数），
 * 同一句「5 分钟前」有四种取整口径，改一处忘七处。现在只在这里实现，调用点只挑口径：
 *
 *   fmtClock(ts)               14:35               气泡底部、体征事件行
 *   fmtMonthDayClock(iso)      03-14 14:35         目标面板收尾时间
 *   fmtRelShort(ts)            刚刚/5m/3h/2d/3/14  会话列表（宽度最紧）
 *   fmtRelAgo(ts, opts)        刚刚/5 分钟前/…      git 历史、产物列表
 *   fmtDateTime(ts)            本地完整时间         副本、设置页
 *   fmtBar(pct, width)         ████▒▒▒▒▒▒▒▒ 40%     部署/更新进度
 *   fmtBytes(n)                1.2 KB / 3.4 MB      下载量、副本占用
 *
 * 口径差异是**故意保留**的（列表要短、git 历史要「前」），但每一档只有一份实现。
 * ------------------------------------------------------------------ */

/** 两位补零（时间文案共用，避免每处再写一遍 padStart）。 */
function fmtPad2(v) {
  return String(v).padStart(2, '0');
}

/** 时钟 `14:35`；没有时间戳返回空串（调用点自己决定要不要兜底成「现在」）。 */
function fmtClock(ts) {
  const n = Number(ts || 0);
  if (!n) return '';
  const d = new Date(n);
  if (Number.isNaN(d.getTime())) return '';
  return `${fmtPad2(d.getHours())}:${fmtPad2(d.getMinutes())}`;
}

/** 月日 + 时钟 `03-14 14:35`（只服务「哪一晚做完的」这一件事，短到不挤占面板头）。 */
function fmtMonthDayClock(value) {
  if (!value) return '';
  const t = Date.parse(String(value));
  if (!Number.isFinite(t)) return '';
  const d = new Date(t);
  return `${fmtPad2(d.getMonth() + 1)}-${fmtPad2(d.getDate())} ${fmtPad2(d.getHours())}:${fmtPad2(d.getMinutes())}`;
}

/** 短相对：`刚刚 / 5m / 3h / 2d / 3/14 / 2024/3/14`（会话列表用，宽度最紧）。 */
function fmtRelShort(ts) {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '';
  const diff = Math.max(0, Date.now() - d.getTime());
  const min = Math.round(diff / 60000);
  if (min < 1) return typeof t === 'function' ? t('history_time_now') : '刚刚';
  if (min < 60) return `${min}m`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h`;
  const day = Math.round(hr / 24);
  if (day < 7) return `${day}d`;
  const today = new Date();
  if (d.getFullYear() === today.getFullYear()) {
    return d.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });
  }
  return d.toLocaleDateString('zh-CN', { year: 'numeric', month: 'numeric', day: 'numeric' });
}

/**
 * 长相对：`刚刚 / N 分钟前 / N 小时前 / N 天前`。
 *
 * @param {number} ts 毫秒时间戳
 * @param {{fallback?: 'date'|'none', fallbackDays?: number, now?: number, empty?: string}} [opts]
 *   `fallback:'date'`：超过 `fallbackDays`（默认 7）回落到 `YYYY-MM-DD`（git 历史用）；
 *   `fallback:'none'`：一直按天累计（产物列表用）；
 *   `now`：只给测试注入固定的「现在」；`empty`：没有时间戳时返回什么（默认空串）。
 */
function fmtRelAgo(ts, opts) {
  const o = opts || {};
  const value = Number(ts) || 0;
  if (!value) return o.empty == null ? '' : String(o.empty);
  const now = Number(o.now) || Date.now();
  const diff = Math.max(0, now - value);
  if (diff < 60 * 1000) return '刚刚';
  const min = Math.floor(diff / 60000);
  if (min < 60) return `${min} 分钟前`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} 小时前`;
  const days = Math.floor(hr / 24);
  const fallbackDays = o.fallbackDays == null ? 7 : Number(o.fallbackDays);
  if (o.fallback === 'date' && days >= fallbackDays) {
    const d = new Date(value);
    return `${d.getFullYear()}-${fmtPad2(d.getMonth() + 1)}-${fmtPad2(d.getDate())}`;
  }
  return `${days} 天前`;
}

/** 本地完整时间（副本 / 设置页用）；没有时间戳返回空串，调用点自己补 `—`。 */
function fmtDateTime(ts) {
  const t = Number(ts) || 0;
  if (!t) return '';
  const d = new Date(t);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString();
}

/** 文本进度条：`████▒▒▒▒▒▒▒▒ 40%`（宽度只影响填充字符数，百分比一律四舍五入并夹在 0-100）。 */
function fmtBar(percent, width) {
  const w = Math.max(1, Math.round(Number(width) || 14));
  const p = Math.max(0, Math.min(100, Math.round(Number(percent) || 0)));
  const filled = Math.round((p / 100) * w);
  return `${'█'.repeat(filled)}${'▒'.repeat(Math.max(0, w - filled))} ${p}%`;
}

/** 字节数：`1.2 KB` / `3.4 MB` / `1.20 GB`；非法或负数返回空串（调用点自己决定要不要显示）。 */
function fmtBytes(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v < 0) return '';
  if (v < 1024) return `${Math.round(v)} B`;
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`;
  if (v < 1024 * 1024 * 1024) return `${(v / (1024 * 1024)).toFixed(1)} MB`;
  return `${(v / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/**
 * 写剪贴板的**唯一实现**（气泡「复制」与手机连接页「复制地址」共用）。
 *
 * 顺序是固定的，别按调用点各写一份：
 * 1. 先走 `navigator.clipboard.writeText` —— 不创建临时节点，不抢焦点；
 * 2. 失败才降级「临时 textarea + execCommand」—— 这条会短暂抢焦点，
 *    所以**必须把焦点交还**：textarea 被 remove() 后焦点落到 body，
 *    输入框就「丢失光标」、用户接着敲字不进 composer。
 *
 * 2026-11-21 之前这里有两份实现且顺序相反（手机那份 textarea 优先、不交还焦点），
 * 点一次「复制连接地址」之后光标就掉出输入框。
 *
 * @param {string} text
 * @returns {Promise<boolean>} 是否复制成功（不抛错，调用点自己决定怎么提示）
 */
async function writeClipboardText(text) {
  const t = String(text == null ? '' : text);
  if (!t) return false;
  if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
    try {
      await navigator.clipboard.writeText(t);
      return true;
    } catch {
      // 落到下面的降级路径
    }
  }
  const prevActive = document.activeElement;
  const ta = document.createElement('textarea');
  ta.value = t;
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.left = '-9999px';
  ta.style.top = '0';
  document.body.appendChild(ta);
  ta.focus();
  ta.select();
  ta.setSelectionRange(0, t.length);
  let copied = false;
  try {
    copied = document.execCommand('copy');
  } catch {
    copied = false;
  }
  ta.remove();
  if (prevActive && prevActive.isConnected && typeof prevActive.focus === 'function') {
    try {
      prevActive.focus({ preventScroll: true });
    } catch {
      // 焦点交还失败不影响复制结果
    }
  }
  return !!copied;
}

window.showTextPrompt = showTextPrompt;
window.showOverlay = showOverlay;
window.parentRemotePath = parentRemotePath;
window.describeVectorSync = describeVectorSync;
window.writeClipboardText = writeClipboardText;
window.escapeHtml = escapeHtml;
window.fmtClock = fmtClock;
window.fmtMonthDayClock = fmtMonthDayClock;
window.fmtRelShort = fmtRelShort;
window.fmtRelAgo = fmtRelAgo;
window.fmtDateTime = fmtDateTime;
window.fmtBar = fmtBar;
window.fmtBytes = fmtBytes;

window.addEventListener('error', (event) => {
  const chat = document.getElementById('chat-list');
  if (!chat) return;
  const msg = event?.error?.stack || event?.message || '未知渲染错误';
  if (!chat.dataset.renderErrorShown) {
    chat.dataset.renderErrorShown = '1';
    chat.innerHTML = `<div class="bubble assistant error"><pre>${String(msg)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')}</pre></div>`;
  }
});
