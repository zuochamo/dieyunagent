/* global document, window, $, showAgentToast, gatewayCall, currentSessionId, switchSession, loadChatFromGateway, refreshHistoryList, openConnectModal, closeConnectModal, isConnectModalOpen, activeConnectTabId, uiText */
'use strict';

/**
 * 内网 Agent 互通面板 + 「会话即对端通道」的发送路由。
 *
 * 分层（不要在这里做业务判定）：
 * - 能不能连、要不要自动跑一轮、租约给不给 → Main 的 `src/peer/coordinator.js`；
 * - 这里只做三件事：把状态画出来、把用户动作转成 IPC、把「当前会话是否绑定了对端」告诉发送路径。
 *
 * 会话语义（用户可见的心智模型）：
 * 一个**绑定到对端的会话** = 你与那台 agent 的对话线程。在这个会话里打字就是发给它，
 * 不消耗本机模型；对方的回复由 Main 落回同一个会话。
 */

const peerApi = window.diecloud || {};

/** @type {Record<string, string>} sessionId → peerId */
let peerLinksCache = {};
let peerEventBound = false;

function peerLinkForSession(sessionId) {
  const sid = String(sessionId || '');
  if (!sid) return '';
  return String(peerLinksCache[sid] || '');
}

/** 只缓存发送路径要用的绑定关系；面板显示每次都回源，避免「UI 与 Main 各存一份状态」。 */
function peerApplyStatus(status) {
  if (!status || typeof status !== 'object') return;
  if (status.links && typeof status.links === 'object') peerLinksCache = { ...status.links };
}

function peerEscape(text) {
  const s = String(text == null ? '' : text);
  if (typeof escapeHtml === 'function') return escapeHtml(s);
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function peerFormatAge(ms) {
  const sec = Math.max(0, Math.round(Number(ms || 0) / 1000));
  if (sec < 60) return peerText('peer_age_seconds', '%d 秒前', sec);
  const min = Math.round(sec / 60);
  if (min < 60) return peerText('peer_age_minutes', '%d 分钟前', min);
  return peerText('peer_age_hours', '%d 小时前', Math.round(min / 60));
}

/**
 * 面板文案：键在 `renderer-i18n.js`，fallback 与中文原文一致（缺键时显示 fallback，不会出现空串）。
 * `%s` / `%d` 按顺序替换，与 `renderer-chat-history.js` 的 `remove_folder_confirm` 用法一致。
 */
function peerText(key, fallback, ...args) {
  let s = typeof uiText === 'function' ? uiText(key, fallback) : fallback;
  for (const arg of args) s = s.replace(/%[sd]/, String(arg));
  return s;
}

/**
 * 一台机器一行（**唯一列表**）。
 *
 * 三份数据合并成一份：`peers`（在线）+ `pendingTrust`（被拦下的来信）+ `trusted`（已确认但可能离线）。
 * 为什么不拆成三个列表：同一台机器会同时出现在「待确认」和「在线」里，用户看到两条一样的东西，
 * 还得自己判断该点哪个按钮。合并后一台机器只有一行、一组动作，紧急的排在上面。
 */
function peerRowsFor(status) {
  const peers = Array.isArray(status && status.peers) ? status.peers : [];
  const pending = Array.isArray(status && status.pendingTrust) ? status.pendingTrust : [];
  const trusted = Array.isArray(status && status.trusted) ? status.trusted : [];
  /** @type {Map<string, any>} */
  const byId = new Map();

  for (const p of peers) {
    byId.set(p.peerId, {
      peerId: p.peerId,
      name: p.name || p.peerId,
      host: String(p.host || ''),
      port: Number(p.port) || 0,
      lastSeenAt: Number(p.lastSeenAt) || 0,
      sameWorkspace: !!p.sameWorkspace,
      claims: Array.isArray(p.claims) ? p.claims : [],
      trust: String(p.trust || ''),
      online: true,
      pending: null
    });
  }
  for (const req of pending) {
    const count = Number(req.count) || 1;
    const preview = String(req.preview || '');
    const row = byId.get(req.peerId);
    if (row) row.pending = { count, preview };
    else
      byId.set(req.peerId, {
        peerId: req.peerId,
        name: req.name || req.peerId,
        host: String(req.host || ''),
        port: 0,
        lastSeenAt: Number(req.at) || 0,
        sameWorkspace: false,
        claims: [],
        trust: '',
        online: false,
        pending: { count, preview }
      });
  }
  for (const item of trusted) {
    const row = byId.get(item.peerId);
    if (row) {
      if (!row.trust) row.trust = String(item.status || '');
    } else {
      // 已确认过、现在不在线：仍要能看见并撤销，否则「记住过谁」无从查起
      byId.set(item.peerId, {
        peerId: item.peerId,
        name: item.name || item.peerId,
        host: '',
        port: 0,
        lastSeenAt: Number(item.at) || 0,
        sameWorkspace: false,
        claims: [],
        trust: String(item.status || ''),
        online: false,
        pending: null
      });
    }
  }

  const rank = (row) => {
    if (row.pending) return 0; // 等用户决定的排最前
    if (row.online && row.trust === 'allow') return 1;
    if (row.online) return 2;
    if (row.trust === 'allow') return 3;
    return 4;
  };
  return [...byId.values()].sort(
    (a, b) =>
      rank(a) - rank(b) ||
      Number(b.sameWorkspace) - Number(a.sameWorkspace) ||
      String(a.name).localeCompare(String(b.name), 'zh')
  );
}

function renderPeerList(status) {
  const host = $('peer-list');
  if (!host) return;
  const rows = peerRowsFor(status);
  if (!rows.length) {
    // 关着的时候要指路，否则一片空白用户不知道下一步点哪
    host.innerHTML = status && status.enabled
      ? `<div class="peer-empty">${peerEscape(peerText('peer_empty_online', '没有发现其他在线 Agent。确认对方也开着叠云、在同一内网。'))}</div>`
      : `<div class="peer-empty">${peerEscape(peerText('peer_empty_disabled', '内网互通已关闭。勾选下面的「启用内网互通」，同项目的同事才能找到你。'))}</div>`;
    return;
  }
  host.innerHTML = rows
    .map((row) => {
      const badges = [];
      if (row.sameWorkspace) badges.push(`<span class="peer-badge peer-badge-same">${peerEscape(peerText('peer_badge_same', '同一项目'))}</span>`);
      if (row.pending) badges.push(`<span class="peer-badge peer-badge-pending">${peerEscape(peerText('peer_badge_pending', '待确认 %d 条', row.pending.count))}</span>`);
      else if (row.trust === 'deny') badges.push(`<span class="peer-badge peer-badge-denied">${peerEscape(peerText('peer_badge_denied', '已拒绝'))}</span>`);
      else if (row.trust !== 'allow') badges.push(`<span class="peer-badge peer-badge-unknown">${peerEscape(peerText('peer_badge_unknown', '未确认'))}</span>`);
      if (!row.online) badges.push(`<span class="peer-badge peer-badge-offline">${peerEscape(peerText('peer_badge_offline', '离线'))}</span>`);

      const addr = row.online
        ? `${row.host || peerText('peer_addr_unknown', '未知地址')}${row.port ? `:${row.port}` : ''} · ${peerFormatAge(Date.now() - row.lastSeenAt)}`
        : '';

      // 第二行：待确认时显示被拦下的来信，否则显示对方声明的租约（没声明就整行省掉）
      let detail = '';
      if (row.pending && row.pending.preview) {
        detail = `<div class="peer-row-detail peer-row-preview">${peerEscape(row.pending.preview.slice(0, 120))}</div>`;
      } else if (row.trust === 'allow' && row.claims.length) {
        detail =
          `<div class="peer-row-detail">` +
          row.claims
            .map(
              (c) =>
                `<span class="peer-claim">${peerEscape(
                  c.kind === 'task' ? peerText('peer_claim_task', '任务') : peerText('peer_claim_file', '文件')
                )} · ${peerEscape(c.key)}</span>`
            )
            .join('') +
          `</div>`;
      }

      const id = peerEscape(row.peerId);
      const denyBtn = `<button type="button" class="ghost-btn peer-trust-deny-btn" data-peer-id="${id}">${peerEscape(peerText('peer_btn_deny', '拒绝'))}</button>`;
      const allowBtn = `<button type="button" class="ghost-btn peer-cta peer-trust-allow-btn" data-peer-id="${id}">${peerEscape(peerText('peer_btn_allow', '允许'))}</button>`;
      const openBtn = `<button type="button" class="ghost-btn peer-open-btn" data-peer-id="${id}">${peerEscape(peerText('peer_btn_open', '发消息'))}</button>`;
      const revokeBtn = `<button type="button" class="ghost-btn peer-sub-btn peer-trust-clear-btn" data-peer-id="${id}">${peerEscape(peerText('peer_btn_revoke', '撤销'))}</button>`;
      const buttons = [];
      if (row.pending) {
        buttons.push(denyBtn);
        buttons.push(allowBtn);
      } else if (row.trust === 'allow') {
        if (row.online) buttons.push(openBtn);
        buttons.push(revokeBtn);
      } else if (row.trust === 'deny') {
        buttons.push(
          `<button type="button" class="ghost-btn peer-trust-clear-btn" data-peer-id="${id}">${peerEscape(peerText('peer_btn_revoke_deny', '撤销拒绝'))}</button>`
        );
      } else {
        buttons.push(`<button type="button" class="ghost-btn peer-allow-btn" data-peer-id="${id}">${peerEscape(peerText('peer_btn_allow', '允许'))}</button>`);
        if (row.online) buttons.push(openBtn);
      }

      const cls = ['peer-row-item'];
      if (!detail) cls.push('peer-row-slim');
      if (row.pending) cls.push('peer-row-pending');
      return (
        `<div class="${cls.join(' ')}" data-peer-id="${id}">` +
        `<div class="peer-row-main">` +
        `<span class="peer-name">${peerEscape(row.name)}</span>${badges.join('')}` +
        (addr ? `<span class="peer-addr">${peerEscape(addr)}</span>` : '') +
        `</div>` +
        detail +
        `<div class="peer-row-actions">${buttons.join('')}</div>` +
        `</div>`
      );
    })
    .join('');
}

async function refreshPeerPanel() {
  const statusEl = $('peer-status');
  const listEl = $('peer-list');
  if (!peerApi.peerStatus) {
    if (statusEl) statusEl.textContent = peerText('peer_api_missing', '当前版本未提供内网互通接口');
    if (listEl) listEl.innerHTML = '';
    return;
  }
  try {
    const res = await peerApi.peerStatus();
    if (!res || !res.ok) {
      if (statusEl) {
        statusEl.textContent = peerText(
          'peer_load_failed',
          '读取失败：%s',
          (res && res.error) || peerText('peer_unknown_error', '未知错误')
        );
      }
      return;
    }
    const status = res.status || {};
    peerApplyStatus(status);
    const nameInput = $('peer-name');
    if (nameInput) nameInput.value = status.name || '';
    const enabledBox = $('peer-enabled');
    if (enabledBox) enabledBox.checked = !!status.enabled;
    const autoBox = $('peer-auto-turn');
    // 默认开（与 Main 的 `peer/store.js` 默认一致）；用户显式关掉才是关：只有 false 才不勾
    if (autoBox) autoBox.checked = status.autoTurn !== false;
    const dot = $('peer-dot');
    if (dot) dot.className = `peer-dot ${status.enabled ? 'peer-dot-on' : 'peer-dot-off'}`;
    if (statusEl) {
      const allowed = Array.isArray(status.trusted) ? status.trusted.filter((t) => t.status === 'allow').length : 0;
      statusEl.textContent = status.enabled
        ? peerText('peer_status_on', '已启用 · 端口 %s · 已确认 %d 台', status.port || '-', allowed)
        : peerText('peer_status_off', '已关闭（不监听、不宣告）');
    }
    renderPeerList(status);
    renderPeerSessionRow(status);
  } catch (e) {
    if (statusEl) statusEl.textContent = peerText('peer_load_failed', '读取失败：%s', (e && e.message) || e);
  }
}

// ---- 首次来信确认弹窗（面板没开也要能弹出来，否则消息就被静默拦掉了） ----

/** @type {Array<{ peerId: string, name: string, preview: string, count: number }>} */
let peerTrustQueue = [];

function peerTrustCurrent() {
  return peerTrustQueue.length ? peerTrustQueue[0] : null;
}

function renderPeerTrustPrompt() {
  const overlay = $('peer-trust-overlay');
  if (!overlay) return;
  const req = peerTrustCurrent();
  if (!req) {
    overlay.hidden = true;
    return;
  }
  const lead = $('peer-trust-lead');
  const preview = $('peer-trust-preview');
  if (lead) lead.textContent = peerText('peer_trust_lead', '%s 想与你的 agent 互通。', req.name || req.peerId);
  if (preview) {
    preview.textContent = String(req.preview || '').slice(0, 240);
    preview.hidden = !req.preview;
  }
  overlay.hidden = false;
}

function enqueuePeerTrustRequest(req) {
  const peerId = String((req && req.peerId) || '');
  if (!peerId) return;
  const existing = peerTrustQueue.find((x) => x.peerId === peerId);
  if (existing) {
    existing.preview = String((req && req.preview) || existing.preview || '');
    existing.count = Number(req && req.count) || existing.count;
    return;
  }
  peerTrustQueue.push({
    peerId,
    name: String((req && req.peerName) || (req && req.name) || ''),
    preview: String((req && req.preview) || ''),
    count: Number(req && req.count) || 1
  });
  renderPeerTrustPrompt();
}

/** 「先不看」：只把当前这条从弹窗队列里去掉，请求仍留在面板「待确认」里。 */
function dismissPeerTrustPrompt() {
  peerTrustQueue = peerTrustQueue.slice(1);
  renderPeerTrustPrompt();
  refreshPeerPanel().catch(() => {});
}

function isPeerTrustPromptOpen() {
  const el = $('peer-trust-overlay');
  return !!(el && !el.hidden);
}

async function decidePeerTrust(peerId, decision) {
  const id = String(peerId || '');
  if (!id) return;
  try {
    const res = decision === 'allow' ? await peerApi.peerTrust(id, 'allow') : await peerApi.peerTrust(id, 'deny');
    // 这条已经决定了：从弹窗队列移除，还有下一条就继续弹
    peerTrustQueue = peerTrustQueue.filter((x) => x.peerId !== id);
    renderPeerTrustPrompt();
    if (typeof showAgentToast === 'function') {
      if (!res || !res.ok) {
        showAgentToast(
          peerText('peer_toast_save_failed', '保存失败'),
          String((res && (res.message || res.error)) || peerText('peer_unknown_error', '未知错误')),
          { variant: 'error' }
        );
      } else if (decision === 'allow') {
        showAgentToast(
          peerText('peer_toast_allowed', '已允许'),
          res.flushed
            ? peerText('peer_toast_allowed_flushed', '%d 条来信已投递到它的会话', res.flushed)
            : peerText('peer_toast_allowed_hint', '对方之后发来的消息会投递到它的会话'),
          { variant: 'success' }
        );
      }
    }
    await refreshPeerPanel();
  } catch (e) {
    if (typeof showAgentToast === 'function') {
      showAgentToast(peerText('peer_toast_action_failed', '操作失败'), String((e && e.message) || e), { variant: 'error' });
    }
  }
}

async function clearPeerTrust(peerId) {
  const id = String(peerId || '');
  if (!id || !peerApi.peerUntrust) return;
  try {
    await peerApi.peerUntrust(id);
    await refreshPeerPanel();
    if (typeof showAgentToast === 'function') {
      showAgentToast(
        peerText('peer_toast_revoked', '已撤销'),
        peerText('peer_toast_revoked_hint', '对方下次来信会重新弹确认'),
        { variant: 'success' }
      );
    }
  } catch (e) {
    if (typeof showAgentToast === 'function') {
      showAgentToast(peerText('peer_toast_revoke_failed', '撤销失败'), String((e && e.message) || e), { variant: 'error' });
    }
  }
}

/** 当前会话是否绑定了对端 —— 必须让人看得见、也解得开（否则这个会话永远发不出去）。 */
function renderPeerSessionRow(status) {
  const row = $('peer-session-row');
  const info = $('peer-session-info');
  if (!row || !info) return;
  const sessionId = String(currentSessionId || '');
  const peerId = peerLinkForSession(sessionId);
  if (!sessionId || !peerId) {
    row.hidden = true;
    return;
  }
  const peers = Array.isArray(status && status.peers) ? status.peers : [];
  const found = peers.find((p) => p.peerId === peerId);
  info.textContent = peerText(
    'peer_session_bound',
    '当前会话已绑定对端：%s（在这里发的内容会直接发给它）',
    (found && found.name) || peerId
  );
  row.hidden = false;
}

/** 打开「连接」对话框并停在 Agent 互通标签页（外壳与标签切换在 renderer-connect.js）。 */
function openPeerModal() {
  openConnectModal('peer');
}

function closePeerModal() {
  closeConnectModal();
}

async function openPeerChat(peerId) {
  if (!peerApi.peerOpenSession) throw new Error('接口不可用');
  const res = await peerApi.peerOpenSession(peerId);
  if (!res || !res.ok) throw new Error((res && res.error) || 'PEER_OPEN_FAILED');
  const sessionId = String(res.sessionId || '');
  if (sessionId && typeof refreshHistoryList === 'function') {
    try {
      await refreshHistoryList();
    } catch {
      // 列表刷新失败不影响切会话
    }
  }
  if (sessionId && typeof switchSession === 'function') {
    await switchSession(sessionId);
  }
  if (sessionId) {
    peerLinksCache[sessionId] = String(peerId);
    if (typeof showAgentToast === 'function') {
      showAgentToast(
        peerText('peer_toast_opened', '已打开对话'),
        peerText('peer_toast_opened_hint', '在这个会话里输入的内容会直接发给对方 agent'),
        { variant: 'success' }
      );
    }
  }
  closePeerModal();
  return sessionId;
}

/**
 * 会话发送路由：**只有**「当前会话已绑定对端」且**不是**外部触发（agent-service / peer 回调）时才接管。
 *
 * 为什么必须排除外部触发：对端来信会经 agentService 落到同一个会话里跑一轮，
 * 那一轮如果不排除，就会把「对方的原话」当成回复再发回去 —— 两边互相弹皮球。
 *
 * @returns {Promise<boolean>} true = 已按对端消息处理（调用方不要再走本地 agent）
 */
async function routePeerSessionSend(text, options) {
  const opts = options || {};
  if (opts.agentServiceRequestId || opts.source === 'peer' || opts.source === 'agent-service' || opts.source === 'plan') {
    return false;
  }
  if (!peerApi.peerSendSession) return false;
  const sessionId = String(currentSessionId || '');
  if (!sessionId) return false;
  if (!peerLinkForSession(sessionId)) return false;
  return sendPeerSessionText(text, sessionId);
}

async function sendPeerSessionText(text, sessionIdOverride) {
  const body = String(text || '').trim();
  const sessionId = String(sessionIdOverride || currentSessionId || '');
  if (!body || !sessionId) return false;
  try {
    // 先落库再由面板重绘：与会话历史的唯一来源保持一致，不在 Renderer 手搓气泡。
    await gatewayCall('memory.message_append', { sessionId, role: 'user', content: body });
    const res = await peerApi.peerSendSession({ sessionId, text: body });
    if (!res || !res.ok) {
      const code = String((res && res.error) || peerText('peer_toast_send_failed', '发送失败'));
      const why =
        code === 'PEER_NOT_LINKED'
          ? peerText('peer_why_not_linked', '这个会话没有绑定对端 agent')
          : code === 'NOT_TRUSTED'
            ? peerText('peer_why_not_trusted', '对方还没确认这台机器；它点一次「允许」后，这条会补投过去')
            : code === 'PEER_UNREACHABLE'
              ? peerText('peer_why_unreachable', '连不上对方（不在线，或防火墙挡住了 peer 端口）')
              : code;
      if (typeof showAgentToast === 'function') {
        showAgentToast(peerText('peer_toast_undelivered', '未送达'), why, { variant: 'error' });
      }
      return true;
    }
    if (sessionId === String(currentSessionId || '')) {
      try {
        // 刚 append 过一条，缓存必然过期：强制回源，别让用户看到「自己发的话没出现」
        await loadChatFromGateway(null, sessionId, { forceRefresh: true });
      } catch {
        // 重绘失败不影响已送达的消息
      }
    }
    if (typeof refreshHistoryList === 'function') refreshHistoryList().catch(() => {});
    return true;
  } catch (e) {
    // 落库失败最常见的一种：这条会话在库里已经不存在了（历史被清、库被回退）。
    // 死链由 Main 侧 `ensureSessionForPeer` 负责解绑重建，这里只如实告诉用户下一步。
    const why =
      e && e.code === 'SESSION_NOT_FOUND'
        ? peerText(
            'peer_why_session_gone',
            '这个会话在本地记忆库里已经不存在了；从「连接 → Agent 互通」重新打开对话即可继续'
          )
        : String((e && e.message) || e);
    if (typeof showAgentToast === 'function') {
      showAgentToast(peerText('peer_toast_send_failed', '发送失败'), why, { variant: 'error' });
    }
    return true;
  }
}

function bindPeerUi() {
  // 开关（菜单图标、关闭按钮、点背景关闭）都在「连接」外壳里，这里只绑标签页自己的控件。
  $('peer-refresh')?.addEventListener('click', () => {
    (peerApi.peerRefresh ? peerApi.peerRefresh() : Promise.resolve())
      .catch(() => {})
      .finally(() => refreshPeerPanel().catch(() => {}));
  });
  $('peer-save-name')?.addEventListener('click', async () => {
    const value = String(($('peer-name') || {}).value || '').trim();
    if (!value) return;
    try {
      await peerApi.peerSetName(value);
      await refreshPeerPanel();
      if (typeof showAgentToast === 'function') {
        showAgentToast(
          peerText('peer_toast_name_saved', '已保存'),
          peerText('peer_toast_name_saved_hint', '其他 agent 会看到「%s」', value),
          { variant: 'success' }
        );
      }
    } catch (e) {
      if (typeof showAgentToast === 'function') {
        showAgentToast(peerText('peer_toast_save_failed', '保存失败'), String((e && e.message) || e), { variant: 'error' });
      }
    }
  });
  $('peer-enabled')?.addEventListener('change', async (e) => {
    const checked = !!(e.target && e.target.checked);
    try {
      await peerApi.peerSetEnabled(checked);
      await refreshPeerPanel();
    } catch (err) {
      if (typeof showAgentToast === 'function') {
        showAgentToast(peerText('peer_toast_toggle_failed', '切换失败'), String((err && err.message) || err), { variant: 'error' });
      }
    }
  });
  $('peer-auto-turn')?.addEventListener('change', async (e) => {
    const checked = !!(e.target && e.target.checked);
    try {
      await peerApi.peerSetAutoTurn(checked);
      await refreshPeerPanel();
    } catch (err) {
      if (typeof showAgentToast === 'function') {
        showAgentToast(peerText('peer_toast_toggle_failed', '切换失败'), String((err && err.message) || err), { variant: 'error' });
      }
    }
  });
  $('peer-session-unlink')?.addEventListener('click', async () => {
    const sessionId = String(currentSessionId || '');
    if (!sessionId) return;
    try {
      await peerApi.peerUnlinkSession(sessionId);
      delete peerLinksCache[sessionId];
      await refreshPeerPanel();
      if (typeof showAgentToast === 'function') {
        showAgentToast(
          peerText('peer_toast_unlinked', '已解除绑定'),
          peerText('peer_toast_unlinked_hint', '这个会话恢复成本机 agent 的普通会话'),
          { variant: 'success' }
        );
      }
    } catch (e) {
      if (typeof showAgentToast === 'function') {
        showAgentToast(peerText('peer_toast_unlink_failed', '解除失败'), String((e && e.message) || e), { variant: 'error' });
      }
    }
  });
  // 列表每次重绘，所以用一次事件委托覆盖所有行内动作（允许 / 拒绝 / 撤销 / 发消息）
  $('peer-list')?.addEventListener('click', (e) => {
    const target = /** @type {HTMLElement | null} */ (e.target);
    const btn = target && target.closest ? target.closest('button') : null;
    if (!btn) return;
    const peerId = btn.getAttribute('data-peer-id') || '';
    if (!peerId) return;
    if (btn.classList.contains('peer-trust-allow-btn') || btn.classList.contains('peer-allow-btn')) {
      decidePeerTrust(peerId, 'allow').catch(() => {});
    } else if (btn.classList.contains('peer-trust-deny-btn')) {
      decidePeerTrust(peerId, 'deny').catch(() => {});
    } else if (btn.classList.contains('peer-trust-clear-btn')) {
      clearPeerTrust(peerId).catch(() => {});
    } else if (btn.classList.contains('peer-open-btn')) {
      openPeerChat(peerId).catch((err) =>
        showAgentToast(peerText('peer_toast_open_failed', '打开失败'), String((err && err.message) || err), { variant: 'error' })
      );
    }
  });
  $('peer-trust-allow')?.addEventListener('click', () => {
    const req = peerTrustCurrent();
    if (req) decidePeerTrust(req.peerId, 'allow').catch(() => {});
  });
  $('peer-trust-deny')?.addEventListener('click', () => {
    const req = peerTrustCurrent();
    if (req) decidePeerTrust(req.peerId, 'deny').catch(() => {});
  });
  $('peer-trust-close')?.addEventListener('click', () => {
    // 关掉弹窗只是「这条先放着」，请求仍在面板「待确认」里等着
    dismissPeerTrustPrompt();
  });

  // 语言切换：静态文案由 data-i18n 重刷，这里补面板里**动态生成**的部分（状态行、列表、绑定行、确认弹窗）。
  window.addEventListener('dieyun:language-change', () => {
    if (isConnectModalOpen() && activeConnectTabId() === 'peer') refreshPeerPanel().catch(() => {});
    renderPeerTrustPrompt();
  });

  if (!peerEventBound && peerApi.onPeerEvent) {
    peerEventBound = true;
    peerApi.onPeerEvent((event) => {
      const kind = event && event.kind ? String(event.kind) : '';
      if (kind === 'links-changed' && event.links) {
        peerLinksCache = { ...event.links };
        return;
      }
      if (kind === 'inbound') {
        if (typeof showAgentToast === 'function') {
          showAgentToast(
            peerText('peer_inbound_from', '%s 来信', event.peerName || peerText('peer_inbound_default', '内网 Agent')),
            String(event.text || '').slice(0, 120),
            { variant: 'info' }
          );
        }
        if (event.sessionId && String(event.sessionId) === String(currentSessionId || '')) {
          loadChatFromGateway(null, event.sessionId, { forceRefresh: true }).catch(() => {});
        }
        return;
      }
      if (kind === 'reply-stored' && event.sessionId && String(event.sessionId) === String(currentSessionId || '')) {
        loadChatFromGateway(null, event.sessionId, { forceRefresh: true }).catch(() => {});
        return;
      }
      if (kind === 'trust-request') {
        // 首次来信：无论面板开没开都要让人看见，否则消息就被无声拦掉了
        enqueuePeerTrustRequest(event);
        if (isConnectModalOpen() && activeConnectTabId() === 'peer') refreshPeerPanel().catch(() => {});
        return;
      }
      const visible = isConnectModalOpen() && activeConnectTabId() === 'peer';
      if (visible && (kind === 'peers-changed' || kind === 'started' || kind === 'claims-changed' || kind === 'trust-changed')) {
        refreshPeerPanel().catch(() => {});
      }
    });
  }
}

function peerBoot() {
  bindPeerUi();
  // 启动时静默拉一次：发送路径需要 links 缓存来判断「当前会话是不是对端会话」。
  if (!peerApi.peerStatus) return;
  peerApi
    .peerStatus()
    .then((res) => {
      if (!res || !res.ok) return;
      peerApplyStatus(res.status);
      // 面板没开时被拦下的来信，启动后仍要让人看见
      const pending = res.status && Array.isArray(res.status.pendingTrust) ? res.status.pendingTrust : [];
      for (const item of pending) {
        enqueuePeerTrustRequest({ peerId: item.peerId, peerName: item.name, preview: item.preview, count: item.count });
      }
    })
    .catch(() => {});
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', peerBoot, { once: true });
  else peerBoot();
}

if (typeof window !== 'undefined') {
  window.peerLinkForSession = peerLinkForSession;
  window.openPeerModal = openPeerModal;
  window.refreshPeerPanel = refreshPeerPanel;
  window.isPeerTrustPromptOpen = isPeerTrustPromptOpen;
  window.dismissPeerTrustPrompt = dismissPeerTrustPrompt;
}
