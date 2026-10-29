'use strict';

// @ts-check
/**
 * 内网 peer 协调器（**互通语义的唯一实现**）。
 *
 * 分层：
 * ```
 * store      身份 / 信任清单 / 会话绑定 / 手工对端 / 开关
 * discovery  UDP 宣告（谁在、在哪个端口、同一个项目吗）
 * server     WS 入站（握手只换身份，投递由信任清单决定）
 * client     WS 出站（一次请求一次连接）
 * coordinator ← 本文件：要不要落会话、要不要自动跑一轮、租约给不给、回复怎么回传
 * ```
 *
 * 为什么业务判定全在这一层：
 * - 「自动跑一轮」是**烧 token** 的动作，必须有跳数 / 每小时预算 / 去重三道闸，闸只在这里；
 * - 服务层只认身份与信任，不认语义；客户端只负责收发（传输），不认语义；
 * - 分成三层各判一半，就会出现「A 认为已经回过、B 认为没收到」这种对不上账的情况。
 *
 * 刻意不做的事：
 * - 不做「按关键词判断要不要回」——回不回只看 `hops`、预算、开关与对方是否要求回复；
 * - 不引入持久化消息队列：连不上就如实告诉调用方（工具结果里带 `peer_unreachable`），
 *   让 agent 自己决定要不要重试或改走别的方式。加一层离线队列等于再造一个 MQ，且会让人
 *   误以为消息一定送达；
 * - 不硬拦写入：租约是**建议式**约束（用户明确选的），真正的隔离仍是 worktree + git。
 */

const { EventEmitter } = require('events');
const { createPeerStore } = require('./store');
const { createPeerDiscovery } = require('./discovery');
const { createPeerServer } = require('./server');
const { createPeerClient } = require('./client');
const { workspaceInfoFor } = require('./workspace-key');
const {
  ENVELOPE_TYPE,
  CLAIM_KIND,
  normalizeClaim,
  normalizeClaims
} = require('./wire');

const INBOUND_SEEN_MAX = 512;
const PEER_CLAIMS_KEEP_MS = 30 * 60 * 1000;
/** 未确认机器最多缓存几条来信（等用户点「允许」期间）。 */
const PEER_PENDING_MAX = 5;

function nowMs() {
  return Date.now();
}

function claimKey(kind, key) {
  return `${kind}:${key}`;
}

/**
 * @param {object} deps
 * @param {string} deps.userDataPath
 * @param {() => { workspacePath?: string }} deps.getWorkspace
 * @param {(method: string, params?: object) => Promise<any>} deps.rpc  Gateway RPC（memory.*）
 * @param {(task: object) => Promise<any>} deps.submitTask                        触发一轮（AgentService）
 * @param {(event: object) => void} [deps.onEvent]
 * @param {() => object} [deps.limits]
 * @param {(msg: string) => void} [deps.log]
 */
function createPeerCoordinator(deps) {
  const d = deps || /** @type {any} */ ({});
  const log = typeof d.log === 'function' ? d.log : () => {};
  const emitter = new EventEmitter();
  const store = createPeerStore(d.userDataPath);

  let server = null;
  let discovery = null;
  let client = null;
  let started = false;
  let boundPort = 0;

  /** @type {Map<string, ReturnType<typeof normalizeClaim>>} */
  const ownClaims = new Map();
  /** @type {Map<string, { claims: ReturnType<typeof normalizeClaim>[], at: number }>} */
  const peerClaims = new Map();
  /** 握手学到的对端（UDP 被挡时的反向通路；key = peerId） */
  /** @type {Map<string, { peerId: string, name: string, host: string, port: number, workspaceKey: string, at: number }>} */
  const learnedPeers = new Map();
  /** @type {Map<string, { peerId: string, host: string, port: number, env: object, sessionId: string, at: number }>} */
  const pendingTurns = new Map();
  /** @type {Map<string, number[]>} */
  const turnBudget = new Map();
  /** @type {Set<string>} */
  const seenInbound = new Set();
  /** @type {Map<string, { text: string }>} */
  const turnText = new Map();
  /**
   * 未确认机器的来信：先扣在这里，等用户点「允许」再原样投递（不丢内容，也不替用户决定）。
   * 每台最多留 `PEER_PENDING_MAX` 条，避免陌生人刷屏把内存吃掉。
   * @type {Map<string, Array<{ peer: object, env: object, at: number }>>}
   */
  const pendingInbound = new Map();
  let claimTimer = null;

  function limits() {
    const l = typeof d.limits === 'function' ? d.limits() : d.limits;
    return l && typeof l === 'object' ? l : {};
  }

  function limitInt(key, fallback) {
    const v = Number(limits()[key]);
    return Number.isFinite(v) ? v : fallback;
  }

  function workspaceInfo() {
    let wsPath = '';
    try {
      const ws = d.getWorkspace ? d.getWorkspace() : null;
      wsPath = ws && ws.workspacePath ? String(ws.workspacePath) : '';
    } catch {
      wsPath = '';
    }
    return workspaceInfoFor(wsPath);
  }

  function identity() {
    return store.identity();
  }

  function emit(event) {
    try {
      emitter.emit('event', event);
    } catch {
      // ignore
    }
    try {
      if (typeof d.onEvent === 'function') d.onEvent(event);
    } catch {
      // ignore
    }
  }

  function pruneClaims() {
    const now = nowMs();
    for (const [key, claim] of ownClaims) {
      if (claim.expiresAt <= now) ownClaims.delete(key);
    }
    for (const [peerId, entry] of peerClaims) {
      if (now - entry.at > PEER_CLAIMS_KEEP_MS) {
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

  /**
   * 在线对端 = 三个来源合并（同一条目只出现一次）：
   * 1. UDP 宣告（最可靠，带端口与项目 key）；
   * 2. 握手学到的（反向通路：UDP 被防火墙挡住时仍然可用）；
   * 3. 本机服务端当前挂着的入站连接。
   */
  function peersList() {
    const myId = identity().peerId;
    const ws = workspaceInfo();
    /** @type {Map<string, any>} */
    const byAddress = new Map();

    const push = (entry) => {
      if (!entry || !entry.peerId || entry.peerId === myId) return;
      const key = entry.host && entry.port ? `${entry.host}:${entry.port}` : `peer:${entry.peerId}`;
      const prev = byAddress.get(key);
      const merged = {
        peerId: entry.peerId,
        name: entry.name || (prev && prev.name) || `${entry.host}:${entry.port}`,
        host: entry.host || (prev && prev.host) || '',
        port: Number(entry.port) || (prev && prev.port) || 0,
        source: entry.source || (prev && prev.source) || 'lan',
        workspaceKey: entry.workspaceKey || (prev && prev.workspaceKey) || '',
        lastSeenAt: Math.max(Number(entry.at) || 0, (prev && prev.lastSeenAt) || 0),
        claims: peerClaims.get(entry.peerId)?.claims || (prev && prev.claims) || []
      };
      merged.sameWorkspace = !!(ws.key && merged.workspaceKey && merged.workspaceKey === ws.key);
      // 这台机器我这边是否已确认（'allow' / 'deny' / '' = 还没确认）：UI 据此显示徽标与动作
      merged.trust = store.trustStatus(merged.peerId);
      byAddress.set(key, merged);
    };

    for (const entry of discovery ? discovery.list() : []) push(entry);
    for (const entry of learnedPeers.values()) push(entry);
    if (server) {
      for (const peer of server.connections().values()) {
        push({ ...peer, source: 'inbound', at: peer.at });
      }
    }

    return [...byAddress.values()].sort(
      (a, b) => Number(b.sameWorkspace) - Number(a.sameWorkspace) || String(a.name).localeCompare(String(b.name), 'zh')
    );
  }

  function findPeer(ref) {
    const needle = String(ref || '').trim();
    if (!needle) return null;
    const list = peersList();
    return (
      list.find((p) => p.peerId === needle) ||
      list.find((p) => `${p.host}:${p.port}` === needle) ||
      list.find((p) => p.name === needle) ||
      list.find((p) => p.name && p.name.toLowerCase() === needle.toLowerCase()) ||
      null
    );
  }

  function rememberInbound(id) {
    if (!id) return false;
    if (seenInbound.has(id)) return true;
    seenInbound.add(id);
    if (seenInbound.size > INBOUND_SEEN_MAX) {
      const first = seenInbound.values().next().value;
      if (first) seenInbound.delete(first);
    }
    return false;
  }

  function budgetAllows(peerId) {
    const windowMs = limitInt('peerTurnBudgetWindowMs', 60 * 60 * 1000);
    const cap = limitInt('peerTurnBudgetPerHour', 12);
    if (cap <= 0) return false;
    const now = nowMs();
    const hits = (turnBudget.get(peerId) || []).filter((t) => now - t < windowMs);
    turnBudget.set(peerId, hits);
    return hits.length < cap;
  }

  function noteTurnSpent(peerId) {
    const hits = turnBudget.get(peerId) || [];
    hits.push(nowMs());
    turnBudget.set(peerId, hits);
  }

  async function createSessionForPeer(peerName) {
    const title = `与 ${peerName || '内网 Agent'} 的对话`;
    const created = await d.rpc('memory.session_create', { title, workspacePath: null });
    if (!created || !created.id) throw new Error('创建会话失败');
    return String(created.id);
  }

  /**
   * 「这个会话还在不在」**只能问 Rust 的 `sessions` 表**（唯一真相）。
   *
   * `session-links.json` 只是「哪个会话属于哪个对端」的缓存：库被回退、会话被删、
   * 或者用户清掉历史之后，它里面会留下死 id。拿死 id 去写消息，SQLite 只会回
   * `FOREIGN KEY constraint failed`（用户在面板上看到的就是「发送失败」+ 这串英文），
   * 而且这条绑定会一直是死的 —— 每次「打开对话」都返回同一个写不进消息的会话。
   */
  async function sessionAlive(sessionId) {
    const row = await d.rpc('memory.session_get', { sessionId });
    return !!(row && row.id);
  }

  /** 会话绑定：一个对端一个会话（同项目时便于把「谁说了什么」放在一起看）。 */
  async function ensureSessionForPeer(peerId, peerName, preferredSessionId) {
    let linksChanged = false;
    const flush = () => {
      if (linksChanged) emit({ kind: 'links-changed', links: store.links() });
      linksChanged = false;
    };
    const preferred = String(preferredSessionId || '').trim();
    const candidates = [preferred, ...store.sessionsForPeer(peerId)].filter(
      (id, i, arr) => id && arr.indexOf(id) === i
    );
    // 1) 库里已经没有的会话链接一律解绑：死 id 留着只会让「打开对话」永远指向写不进消息的会话
    const aliveIds = [];
    for (const sessionId of candidates) {
      if (await sessionAlive(sessionId)) {
        aliveIds.push(sessionId);
      } else if (store.peerForSession(sessionId)) {
        store.unlinkSession(sessionId);
        linksChanged = true;
      }
    }
    // 2) 选第一条能用的（别的对端的绑定不动，另建一条）
    for (const sessionId of aliveIds) {
      const bound = store.peerForSession(sessionId);
      if (bound && bound !== peerId) continue;
      if (bound !== peerId) {
        store.linkSession(sessionId, peerId);
        linksChanged = true;
      }
      flush();
      return sessionId;
    }
    flush();
    const sessionId = await createSessionForPeer(peerName);
    store.linkSession(sessionId, peerId);
    linksChanged = true;
    flush();
    return sessionId;
  }

  async function appendInbound(sessionId, content) {
    await d.rpc('memory.message_append', {
      sessionId,
      role: 'user',
      content,
      reasoning: null
    });
  }

  /**
   * 投递给本机会话的正文。**结构化抬头**（不是关键词判断）：模型据此知道
   * 「谁在跟我说话、几跳了、怎么回」。正文原样保留，不加工对方的措辞。
   */
  function inboundText(peer, env, sessionId) {
    const hops = Number(env.hops) || 0;
    const head = [
      `【内网 Agent 来信 · ${peer.name || peer.peerId}】`,
      `来源 peerId：${peer.peerId}${sessionId ? `；对端会话：${env.from.sessionId || '-'}` : ''}；跳数：${hops}`
    ].join('\n');
    const tail = '（你的最终回复会原样回传给对方；需要继续追问可直接再发 peer_send。）';
    return `${head}\n\n${env.text || ''}\n\n${tail}`;
  }

  async function handleMessage(peer, env) {
    const settings = store.settings();
    const peerId = peer.peerId;
    const hops = Number(env.hops) || 0;
    const maxHops = limitInt('peerMaxHops', 4);
    const sessionId = await ensureSessionForPeer(peerId, peer.name, env.to.sessionId);
    emit({ kind: 'inbound', peerId, peerName: peer.name, sessionId, text: env.text, at: nowMs() });

    const canAutoTurn =
      settings.enabled && settings.autoTurn && hops < maxHops && budgetAllows(peerId);

    if (!canAutoTurn) {
      await appendInbound(sessionId, inboundText(peer, env, sessionId));
      emit({
        kind: 'inbound-stored',
        peerId,
        sessionId,
        reason: hops >= maxHops ? 'hops_exhausted' : settings.autoTurn ? 'budget_exhausted' : 'auto_turn_off'
      });
      return { ok: true, data: { delivered: true, autoTurn: false, sessionId } };
    }

    noteTurnSpent(peerId);
    const result = await d.submitTask({
      text: inboundText(peer, env, sessionId),
      sessionId,
      source: 'peer'
    });
    const requestId = result && result.requestId ? String(result.requestId) : '';
    if (requestId) {
      pendingTurns.set(requestId, {
        peerId,
        host: peer.host || '',
        port: Number(peer.port) || 0,
        env,
        sessionId,
        at: nowMs()
      });
      turnText.set(requestId, { text: '' });
    }
    return { ok: true, data: { delivered: true, autoTurn: true, sessionId, requestId } };
  }

  async function handleReply(peer, env) {
    const sessionId = await ensureSessionForPeer(peer.peerId, peer.name, env.to.sessionId);
    const body = `【${peer.name || peer.peerId} 的回复】\n\n${env.text || ''}`;
    await appendInbound(sessionId, body);
    emit({ kind: 'reply-stored', peerId: peer.peerId, sessionId, text: env.text || '' });
    return { ok: true, data: { sessionId } };
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
    if (status === 'deny') return 'deny';
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
    while (items.length > PEER_PENDING_MAX) items.shift();
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

  async function dispatchEnvelope(peer, env) {
    if (env.type === ENVELOPE_TYPE.CLAIM) return handleClaim(peer, env);
    if (env.type === ENVELOPE_TYPE.RELEASE) return handleRelease(peer, env);
    if (env.type === ENVELOPE_TYPE.CLAIM_REPLY) {
      return { ok: true, data: { decision: env.decision || null } };
    }
    if (env.type === ENVELOPE_TYPE.REPLY) return handleReply(peer, env);
    return handleMessage(peer, env);
  }

  /** 服务层入口：所有入站信封的唯一业务分派（含授权判定）。 */
  async function onEnvelope(peer, env) {
    if (rememberInbound(env.id)) return { ok: true, data: { duplicate: true } };
    const decision = trustDecision(peer);
    if (decision !== 'allow') {
      if (decision === 'ask') bufferUntrusted(peer, env);
      return {
        ok: false,
        error: 'NOT_TRUSTED',
        data: { decision, pending: decision === 'ask' }
      };
    }
    return dispatchEnvelope(peer, env);
  }

  // ---- 出站 ----------------------------------------------------------------

  function registerPeerFromHandshake(peer) {
    if (!peer || !peer.peerId) return;
    const claims = normalizeClaims(peer.claims, limitInt('peerClaimTtlMs', 900000));
    peerClaims.set(peer.peerId, { claims, at: nowMs() });
    const host = String(peer.host || '').replace(/^::ffff:/, '');
    const port = Number(peer.port) || 0;
    if (host && port) {
      learnedPeers.set(peer.peerId, {
        peerId: peer.peerId,
        name: String(peer.name || ''),
        host,
        port,
        workspaceKey: String((peer.workspace && peer.workspace.key) || ''),
        at: nowMs()
      });
    }
  }

  /**
   * 发消息给对端。
   * @param {object} input
   * @param {string} [input.peer]         peerId / 名称 / host:port
   * @param {string} [input.host]
   * @param {number} [input.port]
   * @param {string} input.text
   * @param {string} [input.sessionId]    本地会话（用于把对端回复落到同一会话）
   * @param {boolean} [input.expectReply]
   * @param {number} [input.timeoutMs]
   * @param {string} [input.type]
   * @param {number} [input.hops]
   */
  async function sendToPeer(input) {
    const i = input || /** @type {any} */ ({});
    if (!started) return { ok: false, error: 'PEER_DISABLED' };
    let host = String(i.host || '').trim();
    let port = Number(i.port) || 0;
    let peerName = '';
    let peerId = '';
    if (!host || !port) {
      const found = findPeer(i.peer);
      if (!found || !found.host || !found.port) return { ok: false, error: 'PEER_NOT_FOUND' };
      host = found.host;
      port = found.port;
      peerName = found.name;
      peerId = found.peerId;
    }
    const text = String(i.text || '');
    if (!text.trim()) return { ok: false, error: 'EMPTY_TEXT' };
    const maxChars = limitInt('peerMaxMessageChars', 8000);
    if (text.length > maxChars) {
      return { ok: false, error: 'TEXT_TOO_LONG', maxChars };
    }

    const sessionId = String(i.sessionId || '').trim();
    if (peerId && sessionId) store.linkSession(sessionId, peerId);

    const result = await client.send({
      host,
      port,
      type: i.type || ENVELOPE_TYPE.MESSAGE,
      text,
      fromSessionId: sessionId,
      toSessionId: '',
      hops: Number.isFinite(Number(i.hops)) ? Number(i.hops) + 1 : 1,
      expectReply: !!i.expectReply,
      replyTimeoutMs: Number(i.timeoutMs) || limitInt('peerReplyTimeoutMs', 120000)
    });
    if (result.peer) registerPeerFromHandshake({ ...result.peer, host, port });
    const normalized = normalizeSendResult(result, `${host}:${port}`);
    emit({
      kind: 'sent',
      peer: peerName || peerId || `${host}:${port}`,
      ok: normalized.ok,
      error: normalized.error || null,
      sessionId
    });
    return normalized;
  }

  /**
   * 传输层错误统一成稳定错误码（**唯一口径**）。
   *
   * 为什么必须归一：socket 直接吐 `ECONNREFUSED` / `ETIMEDOUT` 这类平台串，调用方（工具层、
   * IPC、UI）只能靠猜；猜错就会把「对方刚关机」当成「参数写错了」而不重试。
   * 这里把「连不上 / 超时」统一成 `PEER_UNREACHABLE`，其余保持 `PEER_SEND_FAILED`。
   */
  function normalizeSendResult(result, address) {
    if (!result || result.ok) return result;
    const raw = String(result.error || '');
    const unreachable = /ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH|ETIMEDOUT|EAI_AGAIN|TIMEOUT|socket hang up/i.test(
      raw
    );
    // NOT_TRUSTED = 对方还没确认我（对方会弹一次确认）；不是网络问题，也不要重试轰炸
    const code = raw === 'NOT_TRUSTED' ? 'NOT_TRUSTED' : unreachable ? 'PEER_UNREACHABLE' : raw || 'PEER_SEND_FAILED';
    return {
      ...result,
      ok: false,
      // 保留原始串，便于排查（归一化不是掩盖）
      error: code,
      errorCode: code,
      detail: raw || undefined,
      address: address || undefined,
      retryable: code === 'PEER_UNREACHABLE'
    };
  }

  /** 会话里发消息：只对「已绑定 peer 的会话」生效，未绑定返回 PEER_NOT_LINKED。 */
  async function sendFromSession(sessionId, text) {
    const sid = String(sessionId || '').trim();
    const peerId = store.peerForSession(sid);
    if (!peerId) return { ok: false, error: 'PEER_NOT_LINKED' };
    return sendToPeer({ peer: peerId, text, sessionId: sid });
  }

  // ---- 租约 ----------------------------------------------------------------

  async function broadcastClaim(claim) {
    const peers = peersList().filter((p) => p.host && p.port);
    if (!peers.length) return { ok: true, holders: [] };
    const waitMs = Math.max(300, limitInt('peerClaimWaitMs', 1500));
    const attempts = peers.map(async (peer) => {
      const r = await client.send({
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
          client.send({
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

  // ---- 生命周期 ------------------------------------------------------------

  /** 由 Main 在「本轮 agent 跑完」时调用：把最终回复回传给触发方。 */
  async function noteTurnCompleted(requestId, payload) {
    const rid = String(requestId || '');
    if (!rid) return;
    const pending = pendingTurns.get(rid);
    if (!pending) return;
    pendingTurns.delete(rid);
    const accumulated = (turnText.get(rid) || { text: '' }).text;
    turnText.delete(rid);
    const p = payload || {};
    const text = String(accumulated || p.summary || '').trim();
    if (!text) {
      log(`peer turn ${rid} finished with empty reply; nothing to send back`);
      return;
    }
    const reply = await client.send({
      host: pending.host,
      port: pending.port,
      type: ENVELOPE_TYPE.REPLY,
      text: text.slice(0, limitInt('peerMaxMessageChars', 8000)),
      inReplyTo: pending.env.id,
      fromSessionId: pending.sessionId,
      toSessionId: pending.env.from.sessionId || '',
      hops: (Number(pending.env.hops) || 0) + 1
    });
    emit({
      kind: 'reply-sent',
      peerId: pending.peerId,
      ok: !!reply.ok,
      error: reply.error || null,
      sessionId: pending.sessionId
    });
  }

  /** 由 Main 在收到 `task.progress` 时调用：攒住正文，供回传使用（summary 只有 400 字）。 */
  function noteTurnProgress(requestId, payload) {
    const rid = String(requestId || '');
    if (!rid || !pendingTurns.has(rid)) return;
    const stream = payload && typeof payload.streamContent === 'string' ? payload.streamContent : '';
    if (!stream) return;
    turnText.set(rid, { text: stream });
  }

  function status() {
    const settings = store.settings();
    const id = identity();
    const ws = workspaceInfo();
    return {
      enabled: started,
      autoTurn: settings.autoTurn,
      peerId: id.peerId,
      name: id.name,
      port: boundPort,
      discoveryPort: limitInt('peerDiscoveryPort', 17341),
      workspace: ws,
      // 授权模型：信任清单（allow/deny）+ 待确认请求；没有共享配对码可展示了
      trusted: store.trustEntries(),
      pendingTrust: pendingTrustList(),
      peers: peersList(),
      claims: allClaims(),
      links: store.links()
    };
  }

  async function start() {
    if (started) return status();
    const settings = store.settings();
    if (!settings.enabled) {
      log('peer disabled by settings');
      return status();
    }
    client = createPeerClient({
      getPeerId: () => identity().peerId,
      getName: () => identity().name,
      getWorkspace: () => workspaceInfo(),
      getClaims: () => ownClaimList(),
      getPort: () => boundPort,
      maxTextChars: limitInt('peerMaxMessageChars', 8000),
      maxTtlMs: limitInt('peerClaimTtlMs', 900000),
      connectTimeoutMs: limitInt('peerSendTimeoutMs', 20000),
      log
    });
    server = createPeerServer({
      peerId: identity().peerId,
      getName: () => identity().name,
      getWorkspace: () => workspaceInfo(),
      // 只给信任过的机器看租约快照（我在改哪些文件）
      isTrusted: (peerId) => store.isTrusted(peerId),
      getClaims: () => ownClaimList(),
      onEnvelope,
      portBase: limitInt('peerPortBase', 17350),
      portTryCount: limitInt('peerPortTryCount', 11),
      maxTextChars: limitInt('peerMaxMessageChars', 8000),
      maxTtlMs: limitInt('peerClaimTtlMs', 900000),
      log
    });
    const bound = await server.start();
    boundPort = bound.ok ? bound.port : 0;

    discovery = createPeerDiscovery({
      peerId: identity().peerId,
      name: identity().name,
      port: boundPort,
      workspaceKey: workspaceInfo().key,
      discoveryPort: limitInt('peerDiscoveryPort', 17341),
      intervalMs: limitInt('peerDiscoveryIntervalMs', 30000),
      ttlMs: limitInt('peerPresenceTtlMs', 90000),
      staticPeers: store.staticPeers(),
      log
    });
    discovery.on('peer', (entry) => emit({ kind: 'peers-changed', peers: peersList(), added: entry.peerId }));
    discovery.on('gone', (entry) => emit({ kind: 'peers-changed', peers: peersList(), gone: entry.peerId }));
    discovery.start();

    claimTimer = setInterval(() => {
      pruneClaims();
      emit({ kind: 'claims-changed', claims: allClaims() });
    }, 60 * 1000);
    if (claimTimer && typeof claimTimer.unref === 'function') claimTimer.unref();

    started = true;
    emit({ kind: 'started', status: status() });
    return status();
  }

  function stop() {
    started = false;
    if (claimTimer) clearInterval(claimTimer);
    claimTimer = null;
    if (discovery) discovery.stop();
    if (server) server.stop();
    discovery = null;
    server = null;
    boundPort = 0;
    pendingTurns.clear();
    turnText.clear();
    // 关掉互通就不再攒陌生来信（面板里的「待确认」也一并消失；信任清单是落盘的，不受影响）
    pendingInbound.clear();
    emit({ kind: 'stopped' });
  }

  async function restart() {
    stop();
    return start();
  }

  function setEnabled(enabled) {
    const next = store.setSettings({ enabled: !!enabled });
    if (next.enabled) void start();
    else stop();
    return next;
  }

  function setAutoTurn(enabled) {
    return store.setSettings({ autoTurn: !!enabled });
  }

  function setName(name) {
    const next = store.setName(name);
    if (started && discovery) {
      discovery.stop();
      discovery = null;
      void restart();
    }
    return next;
  }

  function refresh() {
    if (discovery) discovery.poke();
    return peersList();
  }

  return {
    // 生命周期
    start,
    stop,
    restart,
    // 状态
    status,
    peers: peersList,
    findPeer,
    claims: allClaims,
    linkForSession: (sessionId) => store.peerForSession(sessionId),
    links: () => store.links(),
    linkSession: (sessionId, peerId) => {
      const next = store.linkSession(sessionId, peerId);
      emit({ kind: 'links-changed', links: next });
      return next;
    },
    unlinkSession: (sessionId) => {
      const next = store.unlinkSession(sessionId);
      emit({ kind: 'links-changed', links: next });
      return next;
    },
    // 通讯
    sendToPeer,
    sendFromSession,
    openSessionForPeer: (peerId, peerName) => ensureSessionForPeer(peerId, peerName, ''),
    claim,
    // 配置
    setName,
    setEnabled,
    setAutoTurn,
    // 授权（取代共享配对码）：允许 / 拒绝 / 撤销
    trustPeer,
    untrustPeer,
    trustList: () => ({ trusted: store.trustEntries(), pending: pendingTrustList() }),
    staticPeers: () => store.staticPeers(),
    setStaticPeers: (peers) => {
      const next = store.setStaticPeers(peers);
      if (started) void restart();
      return next;
    },
    refresh,
    // 回合联动（Main 调用）
    noteTurnCompleted,
    noteTurnProgress,
    // 事件
    on: emitter.on.bind(emitter),
    off: emitter.off.bind(emitter)
  };
}

module.exports = { createPeerCoordinator };
