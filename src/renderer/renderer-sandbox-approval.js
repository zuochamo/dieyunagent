/* global window, document, $, showAgentToast */
'use strict';

/**
 * 沙箱越界审批卡片（Main → Renderer）。
 *
 * 设计要点：
 * - **必须回包**：Main 侧等不到回包就按「拒绝」处理（fail-closed），所以无论用户点哪个按钮、
 *   还是卡片被关掉，都要发回一个 decision。
 * - **说清楚三件事**：当前档位、这条操作要干什么、允许之后的影响范围（本会话同类不再问）。
 * - 不在这里做判定：判定在 Gateway `sandbox-policy.js`，这里只负责「问」和「答」。
 */

const SANDBOX_CATEGORY_LABEL = {
  write: '写文件',
  network: '联网',
  read: '读取',
  dangerous: '高危操作',
  'os-control': '电脑控制'
};

const SANDBOX_MODE_LABEL = {
  'read-only': '只读',
  'workspace-write': '工作区内可写',
  'danger-full-access': '完全放开'
};

function sandboxApprovalHost() {
  return document.getElementById('sandbox-approval-host');
}

/**
 * 回包 + 反馈。
 *
 * 关键：Main 那边可能**已经超时**（人离开超过 2 分钟）。以前这里发完包就不管，Main 返回
 * `false`，界面上什么都不显示 —— 用户看到的就是「点了允许没反应」。现在把 Main 的结论
 * 显式告诉用户：批准记住了（下次同类直接放行）、还是已过期（这次得重新执行）。
 */
async function closeSandboxApprovalCard(requestId, decision) {
  const host = sandboxApprovalHost();
  const card = host && host.querySelector(`[data-sandbox-request="${requestId}"]`);
  if (card) card.remove();
  if (host && !host.querySelector('.sandbox-approval-card')) host.classList.remove('show');

  const api = window.diecloud || {};
  if (!api.sandboxApprovalResult) return;

  let res;
  try {
    res = await api.sandboxApprovalResult({ requestId, decision });
  } catch (e) {
    if (typeof showAgentToast === 'function') {
      showAgentToast('确认失败', `回包没送到：${(e && e.message) || e}`, { variant: 'error' });
    }
    return;
  }

  if (typeof showAgentToast !== 'function') return;
  if (!res || res.delivered === 'live') return;

  if (res.delivered === 'late' && res.granted) {
    showAgentToast('已记住这次批准', '本次执行已经结束，所以这一步不会再跑；下次同类操作在这个位置会直接放行。', {
      variant: 'success',
      duration: 6000
    });
    return;
  }
  if (res.delivered === 'late' && res.ok) {
    showAgentToast('已拒绝', '本次执行已经结束；下次同类操作仍会重新问你。', { variant: 'warn', duration: 6000 });
    return;
  }
  showAgentToast(
    '这条确认已过期',
    res.reason || '超过有效时间了，请让 Agent 重新执行一次（下次点快一点就行）。',
    { variant: 'warn', duration: 6000 }
  );
}

/**
 * 从界面摘掉一张卡片（会话切换 / 清空时用）。
 *
 * 不再因为「Main 侧超时」而调用：超时后卡片要留着，用户回来点「允许」仍然能把批准记下来。
 */
function dismissSandboxApprovalCard(requestId) {
  const host = sandboxApprovalHost();
  if (!host) return;
  const card = host.querySelector(`[data-sandbox-request="${requestId}"]`);
  if (card) card.remove();
  if (!host.querySelector('.sandbox-approval-card')) host.classList.remove('show');
}

function buildSandboxApprovalCard(payload) {
  const requestId = String(payload.requestId || '');
  const mode = String(payload.mode || 'workspace-write');
  const category = String(payload.category || 'write');
  const card = document.createElement('div');
  card.className = 'sandbox-approval-card';
  card.dataset.sandboxRequest = requestId;

  const title = document.createElement('div');
  title.className = 'sandbox-approval-title';
  title.textContent = `Agent 想执行一次${SANDBOX_CATEGORY_LABEL[category] || '越界'}操作`;
  card.appendChild(title);

  const meta = document.createElement('div');
  meta.className = 'sandbox-approval-meta';
  meta.textContent = `当前档位：${SANDBOX_MODE_LABEL[mode] || mode}${payload.tool ? ` · 工具：${payload.tool}` : ''}`;
  card.appendChild(meta);

  if (payload.reason) {
    const reason = document.createElement('div');
    reason.className = 'sandbox-approval-reason';
    reason.textContent = payload.reason;
    card.appendChild(reason);
  }

  if (payload.detail) {
    const detail = document.createElement('pre');
    detail.className = 'sandbox-approval-detail';
    detail.textContent = String(payload.detail).slice(0, 600);
    card.appendChild(detail);
  }

  const note = document.createElement('div');
  note.className = 'sandbox-approval-note';
  note.textContent =
    `允许后，本会话内对该位置的同类「${SANDBOX_CATEGORY_LABEL[category] || category}」操作不再询问；拒绝则本次操作不执行。` +
    '如果你回来得晚（超过 2 分钟），这次执行已经结束 —— 但点「允许」仍会记住本会话对该位置的授权。';
  card.appendChild(note);

  const actions = document.createElement('div');
  actions.className = 'sandbox-approval-actions';

  const allow = document.createElement('button');
  allow.type = 'button';
  allow.className = 'sandbox-approval-btn primary';
  allow.textContent = '允许（本会话）';
  allow.addEventListener('click', () => closeSandboxApprovalCard(requestId, { granted: true }));

  const deny = document.createElement('button');
  deny.type = 'button';
  deny.className = 'sandbox-approval-btn';
  deny.textContent = '拒绝';
  deny.addEventListener('click', () =>
    closeSandboxApprovalCard(requestId, { granted: false, reason: '用户拒绝' })
  );

  actions.appendChild(allow);
  actions.appendChild(deny);
  card.appendChild(actions);
  return card;
}

function showSandboxApproval(payload) {
  const host = sandboxApprovalHost();
  if (!host) {
    // 没有容器 = 没人能回答：立刻拒绝，别让 Main 干等到超时
    const api = window.diecloud || {};
    if (api.sandboxApprovalResult) {
      void api.sandboxApprovalResult({
        requestId: payload && payload.requestId,
        decision: { granted: false, reason: '界面不可用' }
      });
    }
    return;
  }
  host.classList.add('show');
  host.appendChild(buildSandboxApprovalCard(payload || {}));
}

function initSandboxApprovalUI() {
  const api = window.diecloud || {};
  // 不再订阅「已超时作废」：超时后卡片要留在界面上，让用户还能点「允许」把授权记下来。
  if (!api.onSandboxApproval) return;
  api.onSandboxApproval((payload) => showSandboxApproval(payload));
}

if (typeof window !== 'undefined') {
  window.showSandboxApproval = showSandboxApproval;
  window.dismissSandboxApprovalCard = dismissSandboxApprovalCard;
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initSandboxApprovalUI, { once: true });
  } else {
    initSandboxApprovalUI();
  }
}
