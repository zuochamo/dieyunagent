/* global window, document, $ */
'use strict';

/**
 * 设置 → 扩展 → 共享记忆。
 *
 * 这一页只有「表单 + 状态文字」。服务器读写、建表、探活、召回、提炼全在 Main：
 * `src/memory-shared/service.js`（数据层唯一实现）、`agent/knowledge-maintainer.js`
 * （提炼提示词与模型调用）、`src/main/ipc/shared-memory.js`（IPC 转发）。
 *
 * 不做的事：不在 Renderer 判「算不算连上」，不在 Renderer 存口令（口令只走 preload
 * → Main → 系统加密文件，页面永远看不到明文）。
 */

const sharedMemoryState = {
  loading: false,
  saving: false,
  testing: false
};

const SHARED_MEMORY_REASON_TEXT = {
  disabled: '已关闭（开关没打开）',
  unconfigured: '未配置完整（主机 / 库名 / 账号 / 口令）',
  'no-password': '缺少口令',
  unreachable: '连不上数据库',
  unprobed: '尚未检测'
};

function sharedMemoryApi() {
  const api = window.diecloud;
  if (!api || typeof api.sharedMemoryStatus !== 'function') return null;
  return api;
}

function sharedMemoryHint(text, kind) {
  const el = $('shared-memory-hint');
  if (!el) return;
  el.textContent = text || '';
  // .save-hint 基态 opacity:0：只有 show / ok / warn 才可见（同 channels 页的口径）
  el.classList.remove('show', 'ok', 'warn');
  if (kind === 'ok') el.classList.add('ok');
  else if (kind === 'bad') el.classList.add('warn');
  else if (text) el.classList.add('show');
}

/**
 * 服务器版本串很长（`PostgreSQL 18.6 (Ubuntu …) on x86_64…, compiled by gcc …`），
 * 状态行只要「PostgreSQL 18.6」—— 全文会把一行撑成三行。
 */
function shortServerVersion(version) {
  const s = String(version || '').trim();
  if (!s) return 'PostgreSQL';
  const m = s.match(/PostgreSQL\s+[0-9]+(?:\.[0-9]+)?/i);
  return m ? m[0] : s.slice(0, 24);
}

/**
 * 探活失败原因 → 一句人话。
 * `disabled` / `unprobed` 不是故障（用户自己关的、或还没测过），调用方按中性提示处理，不报红。
 */
function probeReasonText(probe) {
  const p = probe || {};
  if (p.reason === 'unconfigured') return '配置不全（主机 / 库名 / 账号 / 口令）';
  if (p.reason === 'unreachable') return `连不上：${p.error || '未知原因'}`;
  if (p.reason === 'disabled') return '共享记忆已关闭';
  return p.error || SHARED_MEMORY_REASON_TEXT[p.reason] || '未知原因';
}

/** 状态行：一句话说清「现在开着没有、为什么」 */
function renderSharedMemoryStatus(status) {
  const statusEl = $('shared-memory-status');
  const detailEl = $('shared-memory-detail');
  if (!statusEl) return;
  const s = status || {};
  let text = '';
  if (s.active) {
    const vec = s.hasVector ? '向量召回' : '文本召回';
    text = `可用 · ${shortServerVersion(s.serverVersion)} · ${vec}`;
  } else {
    text = SHARED_MEMORY_REASON_TEXT[s.reason] || '不可用';
  }
  statusEl.textContent = text;
  statusEl.classList.remove('show', 'ok', 'warn');
  // 「关掉了」「还没测过」是中性状态：别用红字吓人，只有真故障才 warn
  if (s.active) statusEl.classList.add('ok');
  else if (s.reason !== 'disabled' && s.reason !== 'unprobed') statusEl.classList.add('warn');
  statusEl.classList.add('show');

  if (!detailEl) return;
  const parts = [];
  if (s.active) {
    parts.push(`本机节点 ${s.nodeId || '未知'}`);
    if (s.lastSyncAt) parts.push(`上次同步 ${new Date(s.lastSyncAt).toLocaleString()}`);
    parts.push(`召回上限 ${s.limits && s.limits.recallLimit ? s.limits.recallLimit : 5} 条`);
  } else if (s.lastError) {
    parts.push(String(s.lastError).slice(0, 240));
  }
  if (s.canEncrypt === false) parts.push('本机无法加密保存口令（系统密钥不可用），请先修复后再填口令');
  detailEl.textContent = parts.join(' · ');
}

function fillSharedMemoryForm(status) {
  const s = status || {};
  const enabledEl = $('shared-memory-enabled');
  const hostEl = $('shared-memory-host');
  const portEl = $('shared-memory-port');
  const dbEl = $('shared-memory-database');
  const userEl = $('shared-memory-user');
  const pwdHint = $('shared-memory-password-hint');
  if (enabledEl) enabledEl.checked = s.enabled !== false;
  if (hostEl) hostEl.value = s.host || '';
  if (portEl) portEl.value = s.port ? String(s.port) : '';
  if (dbEl) dbEl.value = s.database || '';
  if (userEl) userEl.value = s.user || '';
  // 口令永不回显：只提示「已存过」，留空 = 不改
  const pwdEl = $('shared-memory-password');
  if (pwdEl) pwdEl.value = '';
  if (pwdHint) pwdHint.hidden = !s.hasPassword;
}

/** 表单 → patch。口令留空不带（`undefined` = 不改），显式清空走 `password: ''` */
function readSharedMemoryPatch() {
  const patch = {
    enabled: !!($('shared-memory-enabled') && $('shared-memory-enabled').checked),
    host: ($('shared-memory-host') && $('shared-memory-host').value) || '',
    port: ($('shared-memory-port') && $('shared-memory-port').value) || '',
    database: ($('shared-memory-database') && $('shared-memory-database').value) || '',
    user: ($('shared-memory-user') && $('shared-memory-user').value) || ''
  };
  const pwdEl = $('shared-memory-password');
  const pwd = pwdEl ? String(pwdEl.value || '') : '';
  if (pwd) patch.password = pwd;
  return patch;
}

async function loadSharedMemoryStatus() {
  const api = sharedMemoryApi();
  if (!api) {
    renderSharedMemoryStatus({ reason: 'unconfigured', lastError: '共享记忆通道未就绪' });
    return null;
  }
  if (sharedMemoryState.loading) return null;
  sharedMemoryState.loading = true;
  try {
    const res = await api.sharedMemoryStatus();
    if (res && res.ok) {
      fillSharedMemoryForm(res);
      renderSharedMemoryStatus(res);
      sharedMemoryState.loaded = true;
      return res;
    }
    renderSharedMemoryStatus({ reason: 'disabled', lastError: (res && res.error) || '读取状态失败' });
    return null;
  } catch (e) {
    renderSharedMemoryStatus({ reason: 'disabled', lastError: (e && e.message) || String(e) });
    return null;
  } finally {
    sharedMemoryState.loading = false;
  }
}

async function saveSharedMemorySettings() {
  const api = sharedMemoryApi();
  if (!api || sharedMemoryState.saving) return;
  sharedMemoryState.saving = true;
  sharedMemoryHint('保存中…');
  try {
    const res = await api.sharedMemorySave(readSharedMemoryPatch());
    if (!res || !res.ok) {
      sharedMemoryHint((res && res.error) || '保存失败', 'bad');
      return;
    }
    if (res.status) {
      fillSharedMemoryForm(res.status);
      renderSharedMemoryStatus(res.status);
    }
    const probe = res.probe || {};
    if (probe.ok) sharedMemoryHint('已保存并连上', 'ok');
    else if (probe.reason === 'disabled') sharedMemoryHint('已保存（共享记忆已关闭）', '');
    else sharedMemoryHint(`已保存，但${probeReasonText(probe)}`, 'bad');
  } catch (e) {
    sharedMemoryHint((e && e.message) || String(e), 'bad');
  } finally {
    sharedMemoryState.saving = false;
  }
}

async function testSharedMemoryConnection() {
  const api = sharedMemoryApi();
  if (!api || sharedMemoryState.testing) return;
  sharedMemoryState.testing = true;
  sharedMemoryHint('连接中…');
  try {
    const res = await api.sharedMemoryTest(readSharedMemoryPatch());
    if (res && res.ok) {
      const vec = res.hasVector ? '向量召回可用' : '无 vector 扩展，走文本召回';
      sharedMemoryHint(`连上了 · ${shortServerVersion(res.serverVersion)} · ${vec}`, 'ok');
    } else {
      const reason = res && res.reason;
      const text = (res && res.error) || (reason && SHARED_MEMORY_REASON_TEXT[reason]) || '连接失败';
      sharedMemoryHint(text, 'bad');
    }
  } catch (e) {
    sharedMemoryHint((e && e.message) || String(e), 'bad');
  } finally {
    sharedMemoryState.testing = false;
  }
}

async function reprobeSharedMemory() {
  const api = sharedMemoryApi();
  if (!api) return;
  sharedMemoryHint('检测中…');
  try {
    const res = await api.sharedMemoryProbe();
    if (res && res.status) renderSharedMemoryStatus(res.status);
    const probe = (res && res.probe) || {};
    if (probe.ok) sharedMemoryHint('已连上', 'ok');
    else if (probe.reason === 'disabled') sharedMemoryHint('共享记忆已关闭（开关没打开）', '');
    else sharedMemoryHint(probeReasonText(probe), 'bad');
  } catch (e) {
    sharedMemoryHint((e && e.message) || String(e), 'bad');
  }
}

async function consolidateSharedMemoryNow() {
  const api = sharedMemoryApi();
  if (!api) return;
  sharedMemoryHint('提炼中…');
  try {
    const res = await api.sharedMemoryConsolidate();
    if (res && res.ok) {
      sharedMemoryHint(`已提炼：候选 ${res.scanned || 0} · 合并 ${res.merged || 0} · 新增 ${res.created || 0}`, 'ok');
      await loadSharedMemoryStatus();
    } else if (res && res.reason === 'locked_or_cooldown') {
      sharedMemoryHint('别的机器刚提炼过（6 小时内不重复），本次跳过', '');
    } else if (res && res.reason === 'inactive') {
      sharedMemoryHint('共享记忆当前不可用', 'bad');
    } else {
      sharedMemoryHint((res && res.error) || '提炼失败', 'bad');
    }
  } catch (e) {
    sharedMemoryHint((e && e.message) || String(e), 'bad');
  }
}

function bindSharedMemoryPage() {
  const saveBtn = $('shared-memory-save');
  if (saveBtn && !saveBtn.dataset.bound) {
    saveBtn.dataset.bound = '1';
    saveBtn.addEventListener('click', () => {
      saveSharedMemorySettings();
    });
  }
  const testBtn = $('shared-memory-test');
  if (testBtn && !testBtn.dataset.bound) {
    testBtn.dataset.bound = '1';
    testBtn.addEventListener('click', () => {
      testSharedMemoryConnection();
    });
  }
  const refreshBtn = $('shared-memory-refresh');
  if (refreshBtn && !refreshBtn.dataset.bound) {
    refreshBtn.dataset.bound = '1';
    refreshBtn.addEventListener('click', () => {
      reprobeSharedMemory();
    });
  }
  const consolidateBtn = $('shared-memory-consolidate');
  if (consolidateBtn && !consolidateBtn.dataset.bound) {
    consolidateBtn.dataset.bound = '1';
    consolidateBtn.addEventListener('click', () => {
      consolidateSharedMemoryNow();
    });
  }
}

/** 设置页切到「共享记忆」时调用（`settings-shell.js` 的页签分发） */
window.onSharedMemorySettingsTabShown = function onSharedMemorySettingsTabShown() {
  bindSharedMemoryPage();
  loadSharedMemoryStatus();
};

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bindSharedMemoryPage);
} else {
  bindSharedMemoryPage();
}
