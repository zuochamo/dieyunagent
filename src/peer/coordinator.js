// @ts-check
'use strict';

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
const { createPeerRooms } = require('./rooms');
const { createPeerLeases } = require('./leases');
const { createPeerTrust } = require('./trust');
const { createPeerOutbound } = require('./outbound');
const {
  ENVELOPE_TYPE
} = require('./wire');

const INBOUND_SEEN_MAX = 512;
const PEER_CLAIMS_KEEP_MS = 30 * 60 * 1000;

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

  /** @type {Map<string, { peerId: string, host: string, port: number, env: object, sessionId: string, at: number }>} */
  const pendingTurns = new Map();
  /** @type {Map<string, number[]>} */
  const turnBudget = new Map();
  /** @type {Set<string>} */
  const seenInbound = new Set();
  /** @type {Map<string, { text: string }>} */
  const turnText = new Map();

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
        // 工作身份（对方自称的角色）：只做显示，绝不参与信任判定
        role: entry.role || (prev && prev.role) || '',
        host: entry.host || (prev && prev.host) || '',
        port: Number(entry.port) || (prev && prev.port) || 0,
        source: entry.source || (prev && prev.source) || 'lan',
        workspaceKey: entry.workspaceKey || (prev && prev.workspaceKey) || '',
        lastSeenAt: Math.max(Number(entry.at) || 0, (prev && prev.lastSeenAt) || 0),
        claims: leases.claimsOf(entry.peerId) || (prev && prev.claims) || []
      };
      merged.sameWorkspace = !!(ws.key && merged.workspaceKey && merged.workspaceKey === ws.key);
      // 这台机器我这边是否已确认（'allow' / 'deny' / '' = 还没确认）：UI 据此显示徽标与动作
      merged.trust = store.trustStatus(merged.peerId);
      byAddress.set(key, merged);
    };

    for (const entry of discovery ? discovery.list() : []) push(entry);
    for (const entry of outbound.learnedList()) push(entry);
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

  /**
   * 绑定变化的**唯一出口**：`links`（绑定关系，发送路由用）与 `chatSessions`
   * （哪些会话是通道自己的对话，历史列表归堆用）永远一起送 —— 少送一份，界面就只更新一半。
   */
  function emitLinksChanged() {
    emit({ kind: 'links-changed', links: store.links(), chatSessions: store.chatSessions() });
  }

  /** 会话绑定：一个对端一个会话（同项目时便于把「谁说了什么」放在一起看）。 */
  async function ensureSessionForPeer(peerId, peerName, preferredSessionId) {
    let linksChanged = false;
    const flush = () => {
      if (linksChanged) emitLinksChanged();
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
    // 这条会话是**通道为这个对端新建的**：历史列表据此把它归到「Bot 对话」那层
    // （`links` 只说明「绑了哪台」，被接管的本机任务会话也满足，不能当判据，见 store.chatSessions）
    store.markChatSession(sessionId);
    linksChanged = true;
    flush();
    return sessionId;
  }

  // 房间（agent 聊天室）的语义在 `peer/rooms.js`（2026-11-21 纯搬移）：
  // 只把这 9 个宿主能力显式传进去，房间不再靠「同一个闭包里什么都够得着」。
  const rooms = createPeerRooms({
    store,
    rpc: (method, params) => d.rpc(method, params),
    findPeer,
    sendToPeer: (input) => outbound.sendToPeer(input),
    emit,
    nowMs,
    workspaceInfo,
    limitInt,
    isStarted: () => started
  });
  const {
    roomsList,
    createRoom,
    closeRoom,
    sendToRoom,
    roomTimeline,
    appendInbound,
    inboundText
  } = rooms;

  // 租约（file/task 互斥）的语义在 `peer/leases.js`（2026-11-21 第二刀，纯搬移）：
  // 两个 Map 与裁剪定时器跟着搬走；宿主要什么显式给（`getClient` 惰性取，start 之前是 null）。
  const leases = createPeerLeases({
    identity,
    emit,
    limitInt,
    peersList,
    getClient: () => client,
    registerPeerFromHandshake: (peer) => outbound.registerPeerFromHandshake(peer),
    nowMs,
    claimKey,
    claimsKeepMs: PEER_CLAIMS_KEEP_MS
  });
  const {
    ownClaimList,
    allClaims,
    handleClaim,
    handleRelease,
    claim
  } = leases;

  // 信任判定（入站唯一授权来源）在 `peer/trust.js`（2026-11-21 第三刀，纯搬移）：
  // 待确认来信与 autoTrust 记忆跟着搬走；`dispatchEnvelope` 作为回调传进去（allow 后要补投）。
  const trust = createPeerTrust({
    store,
    log,
    emit,
    nowMs,
    dispatchEnvelope: (peer, env) => dispatchEnvelope(peer, env)
  });
  const { trustDecision, pendingTrustList, bufferUntrusted, trustPeer, untrustPeer } = trust;

  // 出站发送在 `peer/outbound.js`（2026-11-21 第四刀，纯搬移）：
  // 握手学到的对端与「等答复」表跟着搬走；`setPeerClaims` 来自租约（握手带回 claims 时写入）。
  const outbound = createPeerOutbound({
    store,
    emit,
    limitInt,
    findPeer,
    isStarted: () => started,
    getClient: () => client,
    setPeerClaims: (peerId, claims) => leases.setPeerClaims(peerId, claims),
    nowMs
  });
  const { sendToPeer, sendFromSession } = outbound;


  async function handleMessage(peer, env) {
    const settings = store.settings();
    const peerId = peer.peerId;
    const hops = Number(env.hops) || 0;
    const maxHops = limitInt('peerMaxHops', 4);
    // 房间：**只有本机也有这个房间时**才可能判出「已结束」——房间是本机视图，
    // 对端发来的 roomId 在本机查不到就按普通来信处理（不猜、不补建）。
    const roomId = String(env.roomId || '').trim();
    const room = roomId ? store.roomById(roomId) : null;
    // 只认「对方确实是这个房间成员」的房间。roomId 是对方写进信封的字符串，
    // 不校验成员的话，任何一个已确认的机器都能给自带来信贴上别人的房间名，
    // 甚至借「已结束」让我们这一轮不自动跑。
    const roomForPeer = room && room.members.includes(peerId) ? room : null;
    const roomClosed = !!(roomForPeer && roomForPeer.status === 'closed');
    const roomTitle = roomForPeer ? roomForPeer.title : '';
    const sessionId = await ensureSessionForPeer(peerId, peer.name, env.to.sessionId);
    emit({
      kind: 'inbound',
      peerId,
      peerName: peer.name,
      sessionId,
      text: env.text,
      roomId: roomForPeer ? roomId : null,
      at: nowMs()
    });

    const canAutoTurn =
      settings.enabled && settings.autoTurn && !roomClosed && hops < maxHops && budgetAllows(peerId);

    if (!canAutoTurn) {
      await appendInbound(sessionId, inboundText(peer, env, sessionId, roomTitle));
      emit({
        kind: 'inbound-stored',
        peerId,
        sessionId,
        roomId: roomForPeer ? roomId : null,
        reason: roomClosed
          ? 'room_closed'
          : hops >= maxHops
            ? 'hops_exhausted'
            : settings.autoTurn
              ? 'budget_exhausted'
              : 'auto_turn_off'
      });
      return { ok: true, data: { delivered: true, autoTurn: false, sessionId } };
    }

    noteTurnSpent(peerId);
    const result = await d.submitTask({
      text: inboundText(peer, env, sessionId, roomTitle),
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
    // 有人在 `peer_send(expectReply)` 上等这条答复：按 inReplyTo 认领（会话里那份照旧留着）
    outbound.resolveReply(env.inReplyTo, env.text);
    emit({ kind: 'reply-stored', peerId: peer.peerId, sessionId, text: env.text || '' });
    return { ok: true, data: { sessionId } };
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
      // 授权默认值（未表态对端是否放行）：桌面 false（人确认），headless 首次启动落成 true
      autoTrust: settings.autoTrust,
      peerId: id.peerId,
      name: id.name,
      // 本机工作身份（自称的角色）：显示用，别的机器看到的就是它
      role: id.role,
      port: boundPort,
      discoveryPort: limitInt('peerDiscoveryPort', 17341),
      workspace: ws,
      // 授权模型：信任清单（allow/deny）+ 待确认请求；没有共享配对码可展示了
      trusted: store.trustEntries(),
      pendingTrust: pendingTrustList(),
      peers: peersList(),
      claims: allClaims(),
      links: store.links(),
      // 哪些会话是**通道自己的对话**（与 links 分列，见 store.chatSessions）：
      // 历史列表按它在左侧单开一层「Bot 对话」，被接管的本机任务会话不跟着搬家
      chatSessions: store.chatSessions(),
      rooms: roomsList()
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
      getRole: () => identity().role,
      getWorkspace: () => workspaceInfo(),
      getClaims: () => ownClaimList(),
      getPort: () => boundPort,
      connectTimeoutMs: limitInt('peerSendTimeoutMs', 20000),
      log
    });
    server = createPeerServer({
      peerId: identity().peerId,
      getName: () => identity().name,
      getRole: () => identity().role,
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
      role: identity().role,
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

    leases.startPruneTimer();

    started = true;
    emit({ kind: 'started', status: status() });
    return status();
  }

  function stop() {
    started = false;
    leases.stopPruneTimer();
    if (discovery) discovery.stop();
    if (server) server.stop();
    discovery = null;
    server = null;
    boundPort = 0;
    pendingTurns.clear();
    turnText.clear();
    // 关掉互通就不再攒陌生来信（面板里的「待确认」也一并消失；信任清单是落盘的，不受影响）
    trust.clearPending();
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

  /**
   * 授权默认值：`true` = 未表态的对端直接放行（无人值守的机器用，见 trustDecision 的注释）；
   * `false` = 由人确认（桌面默认）。明确 deny 两种模式下都拦。
   */
  function setAutoTrust(enabled) {
    trust.resetAutoAllowed();
    return store.setSettings({ autoTrust: !!enabled });
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

  /**
   * 设工作身份（自称的角色）。与改名同理：重启一次发现与监听，
   * 让对端下次握手/宣告就拿到新身份（旧连接会自然失效）。
   */
  function setRole(role) {
    const next = store.setRole(role);
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
      emitLinksChanged();
      return next;
    },
    unlinkSession: (sessionId) => {
      const next = store.unlinkSession(sessionId);
      emitLinksChanged();
      return next;
    },
    // 通讯
    sendToPeer,
    sendFromSession,
    openSessionForPeer: async (peerId, peerName) => {
      const sessionId = await ensureSessionForPeer(peerId, peerName, '');
      // 点「发消息」= 用户把这条会话当**与这台对端的对话**打开：标进 chatSessions。
      // 老版本留下的通道会话（当时没有这个字段）也正是在这一步被认回来的。
      store.markChatSession(sessionId);
      emitLinksChanged();
      return sessionId;
    },
    claim,
    // 房间（agent 聊天室）：一次任务一个，成员是 peerId
    rooms: roomsList,
    createRoom,
    closeRoom,
    sendToRoom,
    roomTimeline,
    // 配置
    setName,
    setRole,
    setEnabled,
    setAutoTurn,
    setAutoTrust,
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
