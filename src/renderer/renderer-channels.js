/* global window, document, $, escapeHtml, showAgentToast */
'use strict';

/**
 * 设置 → 频道（企业微信等外部入口）页。
 *
 * 这里只做「列表 + 表单 + 状态」；凭据加密、会话映射、长连接与 Agent 执行全在 Main：
 * `channels/store.js`（配置与凭据）、`channels/runtime.js`（连接与调度）、
 * `channels/agent-turn.js`（后台跑一轮）。Renderer 不接触 Secret 明文。
 *
 * API 走 `window.diecloud`（preload 暴露的同一个对象，全仓库统一），
 * 选目录复用既有 `pickFolder`，不为这一页再造一个对话框通道。
 */

const channelsState = {
  channels: [],
  canEncrypt: true,
  editingId: '',
  loading: false,
  saving: false,
  testing: false
};

function channelsApi() {
  const api = window.diecloud;
  if (!api || typeof api.channelsList !== 'function') return null;
  return api;
}

function channelStatusBadge(status) {
  switch (status) {
    case 'online':
      return { text: '在线', kind: 'ok' };
    case 'subscribed':
    case 'connecting':
      return { text: '连接中', kind: 'warn' };
    case 'error':
      return { text: '出错', kind: 'bad' };
    case 'disconnected':
      return { text: '已断开', kind: 'bad' };
    default:
      return { text: '未运行', kind: 'idle' };
  }
}

function channelsHint(text, kind) {
  const el = $('channels-hint');
  if (!el) return;
  el.textContent = text || '';
  // .save-hint 基态是 opacity:0，只有 .show / .ok / .warn 才可见（styles.css）：
  // 只写 dataset.kind 会让「已保存」「连接失败」这类提示彻底看不见。
  el.classList.remove('show', 'ok', 'warn');
  if (kind === 'ok') el.classList.add('ok');
  else if (kind === 'bad') el.classList.add('warn');
  else if (text) el.classList.add('show');
}

function escapeChannelText(v) {
  const s = String(v == null ? '' : v);
  if (typeof escapeHtml === 'function') return escapeHtml(s);
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function renderChannelsList() {
  const host = $('channels-list');
  if (!host) return;
  if (!channelsState.channels.length) {
    host.innerHTML = '<p class="channels-empty">还没有频道。点「添加频道」填一条企业微信机器人的 Bot ID 与 Secret。</p>';
    syncChannelsPushOptions();
    return;
  }
  host.innerHTML = channelsState.channels
    .map((c) => {
      const badge = channelStatusBadge(c.status);
      const meta = [
        `Bot ${escapeChannelText(c.botId || '—')}`,
        `工作空间 ${escapeChannelText(c.workspacePath || '默认工作空间')}`,
        c.conversationCount ? `${c.conversationCount} 个会话` : '尚无会话'
      ].join(' · ');
      return `
      <div class="channels-row" data-channel-id="${escapeChannelText(c.id)}">
        <div class="channels-row-main">
          <div class="channels-row-title">
            <span class="channels-row-name">${escapeChannelText(c.name || '未命名频道')}</span>
            <span class="channels-badge channels-badge-${badge.kind}">${badge.text}</span>
            ${c.enabled ? '' : '<span class="channels-badge">已停用</span>'}
            ${c.busyConversations ? `<span class="channels-badge channels-badge-warn">${c.busyConversations} 个会话在跑</span>` : ''}
          </div>
          <span class="channels-row-meta">${meta}</span>
          ${c.lastError ? `<span class="channels-row-error">${escapeChannelText(c.lastError)}</span>` : ''}
        </div>
        <div class="channels-row-actions">
          <button type="button" class="ghost-btn" data-ch-action="${c.enabled ? 'disable' : 'enable'}">${c.enabled ? '停用' : '启用'}</button>
          <button type="button" class="ghost-btn" data-ch-action="edit">编辑</button>
          <button type="button" class="ghost-btn danger-btn" data-ch-action="delete">删除</button>
        </div>
      </div>`;
    })
    .join('');
  // 事件委托：卡片是重绘出来的，逐张绑定会在下次刷新后失效
  host.querySelectorAll('[data-ch-action]').forEach((el) => {
    el.addEventListener('click', () => onChannelRowAction(el));
  });
  syncChannelsPushOptions();
}

function findChannel(id) {
  return channelsState.channels.find((c) => c.id === id) || null;
}

async function onChannelRowAction(el) {
  const row = el.closest('.channels-row');
  const id = row ? row.dataset.channelId : '';
  const channel = findChannel(id);
  const api = channelsApi();
  if (!channel || !api) return;
  const action = el.dataset.chAction;
  if (action === 'enable' || action === 'disable') {
    const res = await api.channelsSetEnabled(id, action === 'enable');
    applyChannelsResult(res, action === 'enable' ? '已启用' : '已停用');
    return;
  }
  if (action === 'edit') {
    showChannelsEditor(channel);
    return;
  }
  if (action === 'delete') {
    const ok = typeof window.confirm === 'function' ? window.confirm(`删除频道「${channel.name}」？会话映射会一起删掉。`) : true;
    if (!ok) return;
    const res = await api.channelsDelete(id);
    // 删掉的正好是正在编辑的那条：收起编辑器，否则表单里躺着一个已不存在的 id，
    // 再点保存会静默新建一条同名频道（用户以为「编辑」成功了）。
    if (channelsState.editingId === id) hideChannelsEditor();
    applyChannelsResult(res, '已删除');
  }
}

function applyChannelsResult(res, successText) {
  if (res && res.ok) {
    if (Array.isArray(res.channels)) {
      channelsState.channels = res.channels;
      if (typeof res.canEncrypt === 'boolean') channelsState.canEncrypt = res.canEncrypt;
      renderChannelsList();
    }
    channelsHint(successText || '', 'ok');
    if (successText && typeof showAgentToast === 'function') showAgentToast(successText);
    return;
  }
  const msg = (res && res.error) || '操作失败';
  channelsHint(msg, 'bad');
  if (typeof showAgentToast === 'function') showAgentToast(msg);
}

function showChannelsEditor(channel) {
  const editor = $('channels-editor');
  if (!editor) return;
  channelsState.editingId = channel ? channel.id : '';
  editor.hidden = false;
  const title = $('channels-editor-title');
  if (title) title.textContent = channel ? `编辑频道 · ${channel.name || ''}` : '添加频道';
  if ($('channel-name')) $('channel-name').value = channel ? channel.name || '' : '';
  if ($('channel-bot-id')) $('channel-bot-id').value = channel ? channel.botId || '' : '';
  if ($('channel-secret')) $('channel-secret').value = '';
  if ($('channel-workspace')) $('channel-workspace').value = channel ? channel.workspacePath || '' : '';
  if ($('channel-welcome')) $('channel-welcome').value = channel ? channel.welcomeText || '' : '';
  const secretHint = $('channel-secret-hint');
  if (secretHint) secretHint.hidden = !(channel && channel.hasSecret);
  channelsHint('', '');
  editor.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

function hideChannelsEditor() {
  const editor = $('channels-editor');
  if (editor) editor.hidden = true;
  channelsState.editingId = '';
}

function channelsFormPayload() {
  const payload = {
    name: $('channel-name') ? $('channel-name').value.trim() : '',
    botId: $('channel-bot-id') ? $('channel-bot-id').value.trim() : '',
    workspacePath: $('channel-workspace') ? $('channel-workspace').value.trim() : '',
    welcomeText: $('channel-welcome') ? $('channel-welcome').value.trim() : ''
  };
  const secret = $('channel-secret') ? $('channel-secret').value.trim() : '';
  // 编辑时留空 = 不修改（Secret 不回显，无法预填）
  if (secret || !channelsState.editingId) payload.secret = secret;
  if (channelsState.editingId) payload.id = channelsState.editingId;
  return payload;
}

async function saveChannelForm() {
  const api = channelsApi();
  if (!api) {
    channelsHint('频道接口不可用（preload 未就绪）', 'bad');
    return;
  }
  // 双击 = 两条 IPC 并发：新建时会出现两条同名频道（各开一条长连接，互相顶）
  if (channelsState.saving) return;
  const payload = channelsFormPayload();
  if (!payload.name) {
    channelsHint('名称必填', 'bad');
    return;
  }
  if (!payload.botId) {
    channelsHint('Bot ID 必填', 'bad');
    return;
  }
  if (!channelsState.editingId && !payload.secret) {
    channelsHint('Secret 必填', 'bad');
    return;
  }
  channelsHint('保存中…', '');
  channelsState.saving = true;
  let res = null;
  try {
    res = channelsState.editingId ? await api.channelsUpdate(payload) : await api.channelsCreate(payload);
  } finally {
    channelsState.saving = false;
  }
  if (res && res.ok) hideChannelsEditor();
  applyChannelsResult(res, '已保存，凭据已加密存入本机');
}

async function testChannelForm() {
  const api = channelsApi();
  if (!api) return;
  if (channelsState.testing) return;
  const payload = channelsFormPayload();
  channelsState.testing = true;
  channelsHint('正在连接企业微信…', '');
  let res = null;
  try {
    res = await api.channelsTest({
      id: channelsState.editingId || undefined,
      botId: payload.botId,
      secret: payload.secret
    });
  } finally {
    channelsState.testing = false;
  }
  if (res && res.ok) {
    channelsHint((res && res.note) || '连接成功，凭据可用', 'ok');
    return;
  }
  const detail = res && (res.errmsg || res.error) ? `：${res.errmsg || res.error}` : '';
  channelsHint(`连接失败${detail}`, 'bad');
}

function syncChannelsPushOptions() {
  const sel = $('channels-push-channel');
  if (!sel) return;
  const keep = sel.value;
  // 必须留一个空占位项：否则下拉框「看起来选了第一条」，点推送却报「先选一条频道」
  const rows = channelsState.channels.map(
    (c) =>
      `<option value="${escapeChannelText(c.id)}">${escapeChannelText(c.name || c.id)}${
        c.enabled ? '' : '（已停用）'
      }</option>`
  );
  sel.innerHTML = rows.length
    ? `<option value="">选择频道…</option>${rows.join('')}`
    : '<option value="">（还没有频道）</option>';
  sel.value = keep && channelsState.channels.some((c) => c.id === keep) ? keep : '';
}

async function sendChannelTestPush() {
  const api = channelsApi();
  if (!api) return;
  const id = $('channels-push-channel') ? $('channels-push-channel').value : '';
  const target = $('channels-push-target') ? $('channels-push-target').value.trim() : '';
  if (!id || !target) {
    channelsHint('先选一条频道并填写推送目标', 'bad');
    return;
  }
  channelsHint('推送中…', '');
  const res = await api.channelsTestPush({ id, conversationKey: target, text: '叠云 Agent 推送测试' });
  if (res && res.ok) channelsHint((res && res.note) || '已推送（服务端已受理）', 'ok');
  else channelsHint(`推送失败：${(res && res.error) || '未知原因'}`, 'bad');
}

async function loadChannels(opts = {}) {
  const api = channelsApi();
  const host = $('channels-list');
  if (!api) {
    if (host) host.innerHTML = '<p class="channels-empty">频道接口不可用（preload 未就绪），重启客户端后重试。</p>';
    return;
  }
  if (channelsState.loading) return;
  channelsState.loading = true;
  try {
    const res = await api.channelsList();
    if (res && res.ok) {
      channelsState.channels = Array.isArray(res.channels) ? res.channels : [];
      channelsState.canEncrypt = res.canEncrypt !== false;
      renderChannelsList();
      if (!channelsState.canEncrypt) {
        channelsHint('当前系统无法加密保存凭据（safeStorage 不可用），频道无法保存 Secret', 'bad');
      } else if (!opts.quiet) {
        channelsHint('', '');
      }
    } else if (!opts.quiet) {
      channelsHint((res && res.error) || '加载失败', 'bad');
    }
  } finally {
    channelsState.loading = false;
  }
}

async function pickChannelWorkspace() {
  const api = channelsApi();
  if (!api || typeof api.pickFolder !== 'function') {
    channelsHint('选目录不可用（preload 未就绪）', 'bad');
    return;
  }
  let dir = '';
  try {
    dir = await api.pickFolder();
  } catch (e) {
    channelsHint(`打开目录选择失败：${(e && e.message) || e}`, 'bad');
    return;
  }
  if (dir && $('channel-workspace')) {
    $('channel-workspace').value = dir;
    channelsHint('', '');
  }
}

let channelsSettingsInited = false;

function initChannelsSettings() {
  // 幂等：设置页反复切换会让 addEventListener 叠加（一次点击保存两遍 = 两条同长连接互顶）
  if (channelsSettingsInited) return;
  channelsSettingsInited = true;
  const addBtn = $('channels-add-btn');
  if (addBtn) addBtn.addEventListener('click', () => showChannelsEditor(null));
  const refreshBtn = $('channels-refresh-btn');
  if (refreshBtn) refreshBtn.addEventListener('click', () => loadChannels());
  const saveBtn = $('channels-save-btn');
  if (saveBtn) saveBtn.addEventListener('click', () => saveChannelForm());
  const cancelBtn = $('channels-cancel-btn');
  if (cancelBtn) cancelBtn.addEventListener('click', () => hideChannelsEditor());
  const testBtn = $('channels-test-btn');
  if (testBtn) testBtn.addEventListener('click', () => testChannelForm());
  const pickBtn = $('channel-workspace-pick');
  if (pickBtn) pickBtn.addEventListener('click', () => pickChannelWorkspace());
  const pushBtn = $('channels-push-btn');
  if (pushBtn) pushBtn.addEventListener('click', () => sendChannelTestPush());
}

/** 打开设置 → 频道页时由 settings shell 调用 */
window.onChannelsSettingsTabShown = function onChannelsSettingsTabShown() {
  loadChannels().catch(() => {});
};

window.renderChannelsSettings = () => loadChannels();
