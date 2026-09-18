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
  // 少一张图 vs 整轮对话不可用，前者可接受；Main 侧 llm-proxy 还有同一道闸兜底。
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
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) finish(null);
    });
  });
}

window.showTextPrompt = showTextPrompt;
window.showOverlay = showOverlay;
window.parentRemotePath = parentRemotePath;
window.escapeHtml = escapeHtml;

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
