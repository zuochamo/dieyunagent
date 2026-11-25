'use strict';

/**
 * 信任判定 —— **入站唯一授权来源**（取代 P0 的共享配对码）。
 *
 * 三态：`allow`（清单里点过允许）→ 正常投递；`deny`（点过拒绝）→ 直接拒、不再打扰用户；
 * 不在清单 → 缓存这条来信 + 发一次 `trust-request` 让 UI 弹确认，**不落会话、不跑一轮**。
 *
 * 为什么这一层在协调器侧而不是服务层：授权决定「要不要写会话 / 要不要在这台机器上执行工具」，
 * 那是业务语义；服务层只负责把帧收下来。
 *
 * 从 `peer/coordinator.js` 的闭包里抽出（2026-11-21 第三刀，**纯搬移不改逻辑**）：
 * `pendingInbound` / `autoAllowed` 与本文件同生共死，宿主要什么显式传进来。
 */

/** 未确认机器最多缓存几条来信（等用户点「允许」期间）。 */
const PENDING_MAX = 5;

/**
 * @param {{
 *   store: any,
 *   log: (msg: string) => void,
 *   emit: (payload: object) => void,
 *   nowMs: () => number,
 *   dispatchEnvelope: (peer: object, env: object) => Promise<any>
 * }} host
 */
function createPeerTrust(host) {
  const { store, log, emit, nowMs, dispatchEnvelope } = host;
  // 「每台最多留几条来信」的唯一来源就是本文件的 PENDING_MAX
  const pendingMax = PENDING_MAX;

  /**
   * 未确认机器的来信：先扣在这里，等用户点「允许」再原样投递（不丢内容，也不替用户决定）。
   * 每台最多留 `pendingMax` 条，避免陌生人刷屏把内存吃掉。
   * @type {Map<string, Array<{ peer: object, env: object, at: number }>>}
   */
  const pendingInbound = new Map();
  /** `autoTrust` 下已经放行并记过日志的 peerId（每台只记一次，避免刷屏） */
  const autoAllowed = new Set();

  /**
   * 信任判定：**入站唯一授权来源**（取代 P0 的共享配对码）。
   *
   * - `allow`（清单里点过允许）→ 正常投递；
   * - `deny`（点过拒绝）→ 直接拒，不再打扰用户；
   * - 不在清单 → 缓存这条来信 + 发一次 `trust-request` 让 UI 弹确认，**不落会话、不跑一轮**。
   *
   * 为什么在协调器而不是服务层：授权决定决定「要不要写会话 / 要不要在这台机器上执行工具」，
   * 那是业务语义；服务层只负责把帧收下来。
   */
  function trustDecision(peer) {
    const peerId = String((peer && peer.peerId) || '');
    const status = store.trustStatus(peerId);
    if (status === 'allow') return 'allow';
    // deny 永远优先：自动信任只影响「还没表态的陌生对端」，不影响明确拒绝。
    if (status === 'deny') return 'deny';
    // 无人值守的机器（headless / systemd 服务）没有「确认对方」的按钮：
    // 这种情况下 `autoTrust` 打开，未表态的对端按放行处理 —— 否则每一台同事的 agent
    // 都会被静默扣在「待确认」里，而现场既没人会点确认，也没人知道有这件事。
    // 代价写清楚：这等于「同网段内，凡是跑这套协议、能连到我的人都可让我跑一轮」。
    // 所以：① 明确 deny 仍拦；② 每个新放行的 peerId 留一条日志与 trust-auto 事件，
    // 事后要收回就把它写进 trusted-peers.json 置 deny；③ 想更严就把 autoTurn 关掉。
    if (store.settings().autoTrust) {
      if (!autoAllowed.has(peerId)) {
        autoAllowed.add(peerId);
        const who = String((peer && peer.name) || '未命名');
        log(`[peer] autoTrust：放行未表态的对端 ${who} (${peerId})`);
        emit({ kind: 'trust-auto', peerId, name: who });
      }
      return 'allow';
    }
    return 'ask';
  }

  function pendingTrustList() {
    const out = [];
    for (const [peerId, items] of pendingInbound) {
      const last = items[items.length - 1];
      if (!last) continue;
      out.push({
        peerId,
        name: String((last.peer && last.peer.name) || ''),
        host: String((last.peer && last.peer.host) || ''),
        workspaceKey: String((last.peer && last.peer.workspace && last.peer.workspace.key) || ''),
        preview: String((last.env && last.env.text) || '').slice(0, 200),
        count: items.length,
        at: last.at
      });
    }
    return out.sort((a, b) => b.at - a.at);
  }

  function bufferUntrusted(peer, env) {
    const peerId = String(peer.peerId || '');
    const items = pendingInbound.get(peerId) || [];
    items.push({ peer, env, at: nowMs() });
    while (items.length > pendingMax) items.shift();
    pendingInbound.set(peerId, items);
    emit({
      kind: 'trust-request',
      peerId,
      peerName: String(peer.name || ''),
      host: String(peer.host || ''),
      preview: String(env.text || '').slice(0, 200),
      count: items.length
    });
  }

  /**
   * 记录一次决定。`allow` 时把缓存的来信按顺序补投（用户在弹窗里看到的那条不会白看）。
   * @param {string} peerId
   * @param {'allow'|'deny'} decision
   */
  async function trustPeer(peerId, decision) {
    const id = String(peerId || '').trim();
    if (!id) return { ok: false, error: 'MISSING_PEER' };
    if (decision !== 'allow' && decision !== 'deny') return { ok: false, error: 'BAD_DECISION' };
    const buffered = pendingInbound.get(id) || [];
    const name = buffered.length ? String((buffered[0].peer && buffered[0].peer.name) || '') : '';
    const entries = store.setTrust(id, decision, name);
    const flushed = decision === 'allow' ? buffered.length : 0;
    pendingInbound.delete(id);
    emit({ kind: 'trust-changed', peerId: id, decision, trusted: entries });
    if (decision === 'allow') {
      for (const item of buffered) {
        try {
          await dispatchEnvelope(item.peer, item.env);
        } catch (err) {
          log(`peer flush after trust failed: ${err && err.message ? err.message : err}`);
        }
      }
    }
    return { ok: true, data: { trusted: entries, flushed, pending: pendingTrustList() } };
  }

  /** 撤销/清除某台机器的决定：回到「不认识」，下次来信会重新确认。 */
  function untrustPeer(peerId) {
    const id = String(peerId || '').trim();
    if (!id) return { ok: false, error: 'MISSING_PEER' };
    const entries = store.setTrust(id, 'clear');
    emit({ kind: 'trust-changed', peerId: id, decision: 'clear', trusted: entries });
    return { ok: true, data: { trusted: entries } };
  }

  /** 关掉互通就别再攒陌生来信（`stop()` 用）：面板里的「待确认」一并消失，落盘的信任清单不动 */
  function clearPending() {
    pendingInbound.clear();
  }

  /** `autoTrust` 开关变化时清掉「已记过日志」的记忆（`setAutoTrust` 用），避免旧状态残留 */
  function resetAutoAllowed() {
    autoAllowed.clear();
  }

  return {
    trustDecision,
    pendingTrustList,
    bufferUntrusted,
    trustPeer,
    untrustPeer,
    clearPending,
    resetAutoAllowed
  };
}

module.exports = { createPeerTrust };
