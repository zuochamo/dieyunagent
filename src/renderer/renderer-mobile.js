/* global navigator, document, window, $, showAgentToast, uiText */
const mobileApi = window.diecloud || {};

/** 连接面板文案统一走 i18n（键见 renderer-i18n.js）；缺键时回落到中文原文。 */
function mobileText(key, fallback, ...args) {
  let s = typeof uiText === 'function' ? uiText(key, fallback) : fallback;
  for (const arg of args) s = s.replace(/%[sd]/, String(arg));
  return s;
}

async function refreshMobileConnectInfo() {
  const status = $('mobile-connect-status');
  const qr = $('mobile-connect-qr');
  const urlInput = $('mobile-connect-url');
  const hint = $('mobile-connect-hint');
  if (status) status.textContent = mobileText('connect_reading', '正在读取连接信息…');
  if (hint) {
    hint.textContent = '';
    hint.classList.remove('ok', 'warn', 'show');
  }
  if (!mobileApi.getMobileInfo) {
    if (status) status.textContent = mobileText('mobile_api_missing', '当前版本未提供手机连接接口');
    if (qr) qr.removeAttribute('src');
    if (urlInput) urlInput.value = '';
    return;
  }
  try {
    const info = await mobileApi.getMobileInfo();
    const url = info && (info.primaryUrl || (info.urls && info.urls[0])) ? info.primaryUrl || info.urls[0] : '';
    if (urlInput) urlInput.value = url || '';
    if (qr) {
      if (info && info.qrDataUrl) qr.src = info.qrDataUrl;
      else qr.removeAttribute('src');
    }
    if (status) {
      status.textContent = url
        ? mobileText('mobile_ready', '内网服务已启动 · 端口 %s', info.port || 17331)
        : mobileText('mobile_no_lan', '手机连接服务已启动，但未找到可用内网地址');
    }
  } catch (e) {
    if (status) status.textContent = mobileText('mobile_load_failed', '读取失败：%s', e.message || e);
    if (qr) qr.removeAttribute('src');
    if (urlInput) urlInput.value = '';
  }
}

function setMobileConnectHint(text, ok) {
  const hint = $('mobile-connect-hint');
  if (!hint) return;
  hint.textContent = text || '';
  hint.classList.toggle('ok', ok === true);
  hint.classList.toggle('warn', ok === false);
  hint.classList.toggle('show', !!text);
}

/**
 * 写剪贴板的唯一实现在 `renderer-utils.js#writeClipboardText`（异步 API 优先 + 交还焦点）。
 * 这里以前自己写了一份且顺序相反：textarea 优先、且从不交还焦点 ——
 * 点一次「复制连接地址」，光标就掉出输入框，接着敲字不进 composer。
 */
async function copyTextToClipboard(text) {
  const copied = await writeClipboardText(text);
  if (!copied) throw new Error('clipboard unavailable');
}

async function copyMobileConnectUrl() {
  const input = $('mobile-connect-url');
  const url = input ? input.value.trim() : '';
  if (!url) {
    setMobileConnectHint(mobileText('mobile_hint_no_link', '暂无可复制链接'), false);
    if (typeof showAgentToast === 'function') {
      showAgentToast(
        mobileText('mobile_copy_failed_title', '复制失败'),
        mobileText('mobile_copy_no_link', '没有可复制的连接地址'),
        { variant: 'error' }
      );
    }
    return;
  }
  try {
    await copyTextToClipboard(url);
    if (input && typeof input.select === 'function') input.select();
    setMobileConnectHint(mobileText('mobile_hint_copied', '已复制连接地址'), true);
    if (typeof showAgentToast === 'function') {
      showAgentToast(mobileText('mobile_copied_title', '已复制'), url, { variant: 'success' });
    }
  } catch (e) {
    setMobileConnectHint(mobileText('mobile_hint_copy_failed', '复制失败：%s', e.message || e), false);
    if (typeof showAgentToast === 'function') {
      showAgentToast(
        mobileText('mobile_copy_failed_title', '复制失败'),
        mobileText('mobile_clipboard_failed', '无法写入剪贴板'),
        { variant: 'error' }
      );
    }
  }
}

$('mobile-connect-refresh')?.addEventListener('click', () => {
  refreshMobileConnectInfo().catch(() => {});
});
$('mobile-connect-copy')?.addEventListener('click', () => {
  copyMobileConnectUrl().catch(() => {});
});

// 语言切换：静态文案由 data-i18n 重刷；状态行是动态生成的，按可见性重取一次。
window.addEventListener('dieyun:language-change', () => {
  const pane = $('connect-pane-mobile');
  if (pane && !pane.hidden) refreshMobileConnectInfo().catch(() => {});
});
