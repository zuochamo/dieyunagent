'use strict';

/**
 * 租约（`file` / `task` 互斥）—— **唯一语义所在**。
 *
 * 语义：本机想改某个文件 / 接某个任务时，先向在线对端广播一条 claim；谁都没有宣称占用才算拿到。
 * 建议式租约 —— 对端没答/网络断就按「没有人占用」继续，不排队、不重试、不设全局锁（见
 * docs/PEER-MESH-PLAN.md）。`ownClaims` 是本机持有的，`peerClaims` 是对端宣称的（带 30 分钟保留）。
 *
 * 从 `peer/coordinator.js` 的闭包里抽出（2026-11-21 第二刀，**纯搬移不改逻辑**）：
 * 两个 Map 与裁剪定时器跟着搬进来，宿主要什么显式传进来 —— 租约不再能偷看入站/信任状态。
 */

const { ENVELOPE_TYPE, CLAIM_KIND, normalizeClaim } = require('./wire');

/**
 * @param {{
 *   identity: () => { peerId: string, name: string },
 *   emit: (payload: object) => void,
 *   limitInt: (key: string, fallback: number) => number,
 *   peersList: () => any[],
 *   getClient: () => any,
 *   registerPeerFromHandshake: (peer: object) => void,
 *   nowMs: () => number,
 *   claimKey: (kind: string, key: string) => string,
 *   claimsKeepMs: number
 * }} host
 */
function createPeerLeases(host) {
  const {
    identity,
    emit,
    limitInt,
    peersList,
    getClient,
    registerPeerFromHandshake,
    nowMs,
    claimKey,
    claimsKeepMs
  } = host;

  /** @type {Map<string, any>} 本机持有的租约（key = kind:key） */
  const ownClaims = new Map();
  /** @type {Map<string, { claims: any[], at: number }>} 对端宣称的租约（key = peerId） */
  const peerClaims = new Map();
  let claimTimer = null;

  function pruneClaims() {
    const now = nowMs();
    for (const [key, claim] of ownClaims) {
      if (claim.expiresAt <= now) ownClaims.delete(key);
    }
    for (const [peerId, entry] of peerClaims) {
      if (now - entry.at > claimsKeepMs) {
        peerClaims.delete(peerId);
        continue;
      }
      const alive = entry.claims.filter((c) => c.expiresAt > now);
      if (alive.length !== entry.claims.length) {
        peerClaims.set(peerId, { claims: alive, at: entry.at });
      }
    }
  }

  function ownClaimList() {
    pruneClaims();
    return [...ownClaims.values()];
  }

  function allClaims() {
    pruneClaims();
    const out = [];
    const seen = new Set();
    for (const c of ownClaims.values()) {
      seen.add(claimKey(c.kind, c.key));
      out.push(c);
    }
    for (const entry of peerClaims.values()) {
      for (const c of entry.claims) {
        const k = claimKey(c.kind, c.key);
        if (seen.has(k)) continue;
        seen.add(k);
        out.push(c);
      }
    }
    return out;
  }

  function conflictsFor(kind, key, excludePeerId) {
    const k = claimKey(kind, key);
    return allClaims().filter(
      (c) => claimKey(c.kind, c.key) === k && c.peerId && c.peerId !== excludePeerId
    );
  }

  function handleClaim(peer, env) {
    const claim = normalizeClaim({ ...(env.claim || {}), peerId: peer.peerId, peerName: peer.name }, limitInt('peerClaimTtlMs', 900000));
    if (!claim.key) return { ok: false, error: 'BAD_CLAIM' };
    const conflicting = conflictsFor(claim.kind, claim.key, peer.peerId);
    if (conflicting.length) {
      return { ok: false, error: 'CLAIM_CONFLICT', data: { holders: conflicting } };
    }
    const entry = peerClaims.get(peer.peerId) || { claims: [], at: nowMs() };
    const next = entry.claims.filter((c) => claimKey(c.kind, c.key) !== claimKey(claim.kind, claim.key));
    next.push(claim);
    peerClaims.set(peer.peerId, { claims: next, at: nowMs() });
    emit({ kind: 'claims-changed', claims: allClaims() });
    return { ok: true, data: { granted: true } };
  }

  function handleRelease(peer, env) {
    const claim = normalizeClaim({ ...(env.claim || {}), peerId: peer.peerId, peerName: peer.name });
    const entry = peerClaims.get(peer.peerId);
    if (entry && claim.key) {
      entry.claims = entry.claims.filter((c) => claimKey(c.kind, c.key) !== claimKey(claim.kind, claim.key));
      peerClaims.set(peer.peerId, { claims: entry.claims, at: nowMs() });
      emit({ kind: 'claims-changed', claims: allClaims() });
    }
    return { ok: true };
  }

  async function broadcastClaim(claim) {
    const peers = peersList().filter((p) => p.host && p.port);
    if (!peers.length) return { ok: true, holders: [] };
    const waitMs = Math.max(300, limitInt('peerClaimWaitMs', 1500));
    const attempts = peers.map(async (peer) => {
      const r = await getClient().send({
        host: peer.host,
        port: peer.port,
        type: ENVELOPE_TYPE.CLAIM,
        text: '',
        claim
      });
      if (r.peer) registerPeerFromHandshake({ ...r.peer, host: peer.host, port: peer.port });
      if (!r.ok && r.error === 'CLAIM_CONFLICT') {
        const holders = r.data && Array.isArray(r.data.holders) ? r.data.holders : [];
        return holders.length ? holders : [{ peerId: peer.peerId, peerName: peer.name, kind: claim.kind, key: claim.key }];
      }
      return null;
    });
    const settled = await Promise.race([
      Promise.all(attempts),
      new Promise((resolve) => setTimeout(() => resolve([]), waitMs))
    ]);
    const holders = (Array.isArray(settled) ? settled : []).filter(Boolean).flat();
    return { ok: holders.length === 0, holders };
  }

  /**
   * @param {object} input
   * @param {'acquire'|'release'|'list'} input.action
   * @param {'file'|'task'} [input.kind]
   * @param {string} [input.key]
   * @param {string} [input.note]
   * @param {string} [input.sessionId]
   */
  async function claim(input) {
    const i = input || /** @type {any} */ ({});
    const action = String(i.action || 'list');
    if (action === 'list') return { ok: true, claims: allClaims() };
    const kind = i.kind === CLAIM_KIND.TASK ? CLAIM_KIND.TASK : CLAIM_KIND.FILE;
    const key = String(i.key || '').trim();
    if (!key) return { ok: false, error: 'KEY_REQUIRED' };

    if (action === 'release') {
      const k = claimKey(kind, key);
      const own = ownClaims.get(k);
      ownClaims.delete(k);
      const peers = peersList().filter((p) => p.host && p.port);
      await Promise.all(
        peers.map((peer) =>
          getClient().send({
            host: peer.host,
            port: peer.port,
            type: ENVELOPE_TYPE.RELEASE,
            text: '',
            claim: own || { kind, key }
          })
        )
      );
      emit({ kind: 'claims-changed', claims: allClaims() });
      return { ok: true, released: { kind, key } };
    }

    const existing = ownClaims.get(claimKey(kind, key));
    if (existing) return { ok: true, claim: existing, renewed: true };

    const known = conflictsFor(kind, key, identity().peerId);
    if (known.length) return { ok: false, error: 'CLAIM_CONFLICT', holders: known };

    const ttl = limitInt('peerClaimTtlMs', 900000);
    const mine = normalizeClaim(
      {
        kind,
        key,
        peerId: identity().peerId,
        peerName: identity().name,
        sessionId: String(i.sessionId || ''),
        note: String(i.note || ''),
        createdAt: nowMs(),
        expiresAt: nowMs() + ttl
      },
      ttl
    );
    const broadcast = await broadcastClaim(mine);
    if (!broadcast.ok) return { ok: false, error: 'CLAIM_CONFLICT', holders: broadcast.holders };
    ownClaims.set(claimKey(kind, key), mine);
    emit({ kind: 'claims-changed', claims: allClaims() });
    return { ok: true, claim: mine };
  }

  /** 对端宣称的租约（`peersList` 拼在线列表要用；原来它直接摸 Map） */
  function claimsOf(peerId) {
    const entry = peerClaims.get(peerId);
    return (entry && entry.claims) || [];
  }

  /** 握手学到的对端带上 claims 时写进来（原来 `registerPeerFromHandshake` 直接摸 Map） */
  function setPeerClaims(peerId, claims) {
    if (!peerId) return;
    peerClaims.set(peerId, { claims, at: nowMs() });
  }

  /** 过期租约的定期清理（原来是 `start()` 里的一段 setInterval） */
  function startPruneTimer() {
    stopPruneTimer();
    claimTimer = setInterval(() => {
      pruneClaims();
      emit({ kind: 'claims-changed', claims: allClaims() });
    }, 60 * 1000);
    if (claimTimer && typeof claimTimer.unref === 'function') claimTimer.unref();
  }

  function stopPruneTimer() {
    if (claimTimer) clearInterval(claimTimer);
    claimTimer = null;
  }

  return {
    pruneClaims,
    ownClaimList,
    allClaims,
    conflictsFor,
    claimsOf,
    setPeerClaims,
    handleClaim,
    handleRelease,
    broadcastClaim,
    claim,
    startPruneTimer,
    stopPruneTimer
  };
}

module.exports = { createPeerLeases };
