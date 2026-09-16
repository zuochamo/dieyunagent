/* global navigator, document, $, closeAllMenus, closeSettingsModal, closeSettingsSkillsPage, closeExecuteModal, closeHelpModal, showAgentToast */
const mobileApi = window.diecloud || {};

async function refreshMobileConnectInfo() {
  const status = $('mobile-connect-status');
  const qr = $('mobile-connect-qr');
  const urlInput = $('mobile-connect-url');
  const hint = $('mobile-connect-hint');
  if (status) status.textContent = '正在读取连接信息…';
  if (hint) {
    hint.textContent = '';
    hint.classList.remove('ok', 'warn', 'show');
  }
  if (!mobileApi.getMobileInfo) {
    if (status) status.textContent = '当前版本未提供手机连接接口';
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
        ? `内网服务已启动 · 端口 ${info.port || 17331}`
        : '手机连接服务已启动，但未找到可用内网地址';
    }
  } catch (e) {
    if (status) status.textContent = `读取失败：${e.message || e}`;
    if (qr) qr.removeAttribute('src');
    if (urlInput) urlInput.value = '';
  }
}

function openMobileConnectModal() {
  const overlay = $('mobile-connect-overlay');
  if (!overlay) return;
  closeAllMenus();
  closeSettingsModal();
  closeSettingsSkillsPage();
  closeExecuteModal();
  closeHelpModal();
  overlay.hidden = false;
  refreshMobileConnectInfo().catch(() => {});
}

function closeMobileConnectModal() {
  const overlay = $('mobile-connect-overlay');
  if (overlay) overlay.hidden = true;
}

function setMobileConnectHint(text, ok) {
  const hint = $('mobile-connect-hint');
  if (!hint) return;
  hint.textContent = text || '';
  hint.classList.toggle('ok', ok === true);
  hint.classList.toggle('warn', ok === false);
  hint.classList.toggle('show', !!text);
}

async function copyTextToClipboard(text) {
  const t = String(text || '');
  let copied = false;
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
  try {
    copied = document.execCommand('copy');
  } catch {
    copied = false;
  }
  ta.remove();
  if (!copied && navigator.clipboard && navigator.clipboard.writeText) {
    await navigator.clipboard.writeText(t);
    copied = true;
  }
  if (!copied) throw new Error('clipboard unavailable');
}

async function copyMobileConnectUrl() {
  const input = $('mobile-connect-url');
  const url = input ? input.value.trim() : '';
  if (!url) {
    setMobileConnectHint('暂无可复制链接', false);
    if (typeof showAgentToast === 'function') {
      showAgentToast('复制失败', '没有可复制的连接地址', { variant: 'error' });
    }
    return;
  }
  try {
    await copyTextToClipboard(url);
    if (input && typeof input.select === 'function') input.select();
    setMobileConnectHint('已复制连接地址', true);
    if (typeof showAgentToast === 'function') {
      showAgentToast('已复制', url, { variant: 'success' });
    }
  } catch (e) {
    setMobileConnectHint(`复制失败：${e.message || e}`, false);
    if (typeof showAgentToast === 'function') {
      showAgentToast('复制失败', '无法写入剪贴板', { variant: 'error' });
    }
  }
}

function isMobileConnectModalOpen() {
  const overlay = $('mobile-connect-overlay');
  return overlay && !overlay.hidden;
}

const menuMobileTrigger = $('menu-mobile-trigger');
if (menuMobileTrigger) {
  menuMobileTrigger.addEventListener('click', (e) => {
    e.stopPropagation();
    openMobileConnectModal();
  });
}

const mobileConnectOverlay = $('mobile-connect-overlay');
if (mobileConnectOverlay) {
  mobileConnectOverlay.addEventListener('click', (e) => {
    if (e.target === mobileConnectOverlay) closeMobileConnectModal();
  });
}

$('mobile-connect-close')?.addEventListener('click', closeMobileConnectModal);
$('mobile-connect-refresh')?.addEventListener('click', () => {
  refreshMobileConnectInfo().catch(() => {});
});
$('mobile-connect-copy')?.addEventListener('click', () => {
  copyMobileConnectUrl().catch(() => {});
});
