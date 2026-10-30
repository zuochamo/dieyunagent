'use strict';

const { createWecomChannelClient } = require('./wecom-client');

/**
 * 频道运行时：把「企微线」接到「Agent 一轮对话」之间的所有粘合逻辑。
 *
 * 这里只管**调度**，不碰 Agent 内部：
 *   - 每条频道一条长连接（`wecom-client.js`），启停与连接状态对外可查；
 *   - 会话键（群 chatid / 单聊 single:userid）→ Agent 会话的映射归频道所有（`store.js` 持久化）；
 *   - 同一会话串行：上一条还在跑就直接回「上一条还在处理」（与 v1 外挂版同一行为，不排队不串台）；
 *   - 流式回执节流：企微限 30 条/分钟/会话，按 flush 间隔刷同一 stream.id；
 *   - 超时（默认 900s）中止并回话；会话被删（SESSION_NOT_FOUND）时清映射重建一次。
 *
 * 「跑一轮」由调用方注入（`runTurn`），因为真正的 Agent 装配在 `agent-turn.js`：
 * 这样调度逻辑可以脱离 Rust core 单测。
 */

const REPLY = {
  startedText: '已收到，正在处理…',
  busyText: '上一条还在处理中，请等它跑完再发。',
  emptyText: '消息内容为空。',
  unsupportedText: '这条消息的类型暂不支持（支持文字、语音、图片、文件）。',
  timeoutText: '（任务超时，已中止）',
  failedText: '处理失败，详情见桌面端「设置 → 频道」日志。',
  flushIntervalMs: 2200,
  maxChars: 3300,
  taskTimeoutMs: 900_000
};

function clip(text, max = REPLY.maxChars) {
  const s = String(text == null ? '' : text);
  if (s.length <= max) return s;
  return `${s.slice(0, max)}\n\n…（内容过长已截断，完整内容在桌面端会话里）`;
}

/**
 * 流式往企微刷同一个 stream.id 的接收器。
 * `push(fullText)` 只更新「最新全文」，真正的发送由节流器决定 —— 企微按条数限流，
 * 每来一个 token 发一帧会立刻被限。
 */
function createThrottledSink({ reply, log, intervalMs = REPLY.flushIntervalMs }) {
  let latest = '';
  let sent = '';
  let timer = null;
  let finished = false;

  function flush(force) {
    if (finished) return;
    if (!latest) return;
    if (!force && latest === sent) return;
    const ok = reply.stream(clip(latest), false);
    if (!ok) log('[channels] 流式帧发送失败（连接可能已断）');
    sent = latest;
  }

  function start() {
    if (timer) return;
    timer = setInterval(() => flush(false), intervalMs);
    if (typeof timer.unref === 'function') timer.unref();
  }

  function stopTimer() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  return {
    start,
    push(text) {
      latest = String(text == null ? '' : text);
    },
    current() {
      return latest;
    },
    final(text) {
      if (text != null) latest = String(text);
      stopTimer();
      if (finished) return;
      finished = true;
      const ok = reply.stream(clip(latest || '（本轮没有输出）'), true);
      if (!ok) log('[channels] 收尾帧发送失败');
    },
    /** 中途插一条独立提示并结束（超时 / 出错） */
    fail(text) {
      stopTimer();
      if (finished) return;
      finished = true;
      const body = latest ? `${clip(latest)}\n\n${text}` : text;
      reply.stream(clip(body), true);
    },
    abort() {
      stopTimer();
      finished = true;
    }
  };
}

/**
 * @param {{
 *   store: object,
 *   log?: (msg: string) => void,
 *   runTurn: (ctx: { channelId: string, conversationKey: string, sessionId: string, text: string, attachments: Array<{kind: 'image'|'file', url: string, name?: string}>, sink: object, signal: AbortSignal, onSession: (sessionId: string) => void }) => Promise<{ sessionId: string, text: string }>
 * }} opts
 */
function createChannelRuntime(opts) {
  const store = opts.store;
  const log = typeof opts.log === 'function' ? opts.log : () => {};
  const runTurn = opts.runTurn;
  if (typeof runTurn !== 'function') throw new Error('频道运行时缺少 runTurn');

  /** 长连接态（每条启用的频道一条） */
  /** @type {Map<string, { client: any }>} */
  const running = new Map();

  /**
   * 会话串行态：键是人（会话键），不是连接。
   * 与 `running` 分开存，是因为「这条消息要不要跑」只取决于会话，连接只负责把帧发回去。
   */
  /** @type {Map<string, Map<string, { task: Promise<any>, controller: AbortController }>>} */
  const chains = new Map();

  function chainsFor(channelId) {
    let map = chains.get(channelId);
    if (!map) {
      map = new Map();
      chains.set(channelId, map);
    }
    return map;
  }

  function statuses() {
    const out = [];
    for (const [channelId, entry] of running) {
      const channel = store.getChannel(channelId);
      out.push({
        channelId,
        name: channel ? channel.name : '',
        enabled: channel ? channel.enabled : false,
        ...entry.client.getStatus(),
        busyConversations: (chains.get(channelId) || new Map()).size
      });
    }
    return out;
  }

  function statusOf(channelId) {
    return statuses().find((s) => s.channelId === channelId) || null;
  }

  function isRunning(channelId) {
    return running.has(channelId);
  }

  function handleEvent(channelId, { eventtype, reply }) {
    // 目前只有进入会话的欢迎语有意义；欢迎语留空就不打扰用户
    if (eventtype === 'enter_chat') {
      const channel = store.getChannel(channelId);
      const welcome = channel && channel.welcomeText ? String(channel.welcomeText) : '';
      if (welcome) reply.welcome(welcome);
    }
  }

  async function runOnce(channelId, { conversationKey, text, attachments, sink, signal }) {
    const mapped = store.getConversationSession(channelId, conversationKey);
    let sessionId = mapped;
    const ctx = {
      channelId,
      conversationKey,
      sessionId,
      text,
      attachments: attachments || [],
      sink,
      signal,
      onSession: (sid) => {
        const next = String(sid || '');
        if (!next || next === sessionId) return;
        sessionId = next;
        store.setConversationSession(channelId, conversationKey, next);
      }
    };
    try {
      const result = await runTurn(ctx);
      if (result && result.sessionId && result.sessionId !== sessionId) {
        store.setConversationSession(channelId, conversationKey, result.sessionId);
      }
      // 刷新这条映射的活跃时间：会话映射按 updatedAt 裁剪，只有新建时才写会让常用群先被裁掉
      if (typeof store.touchConversation === 'function') {
        try {
          store.touchConversation(channelId, conversationKey);
        } catch {
          // 记账失败不影响本轮回复
        }
      }
      return result || {};
    } catch (e) {
      const message = (e && e.message) || String(e);
      // 会话被用户在桌面端删掉：清映射，用空 sessionId 重建一次（v1 同一行为）
      const code = String((e && e.code) || '');
      if (sessionId && (code === 'SESSION_NOT_FOUND' || message.includes('SESSION_NOT_FOUND'))) {
        log(`[channels] ${channelId} 会话 ${sessionId} 已不存在，重建后重试`);
        store.clearConversationSession(channelId, conversationKey);
        ctx.sessionId = '';
        const retry = await runTurn({ ...ctx, sessionId: '' });
        if (retry && retry.sessionId) store.setConversationSession(channelId, conversationKey, retry.sessionId);
        return retry || {};
      }
      throw e;
    }
  }

  async function handleMessage(channelId, { body: _body, conversationKey, normalized, reply }) {
    const started = Date.now();
    const text = String((normalized && normalized.text) || '').trim();
    const images = (normalized && Array.isArray(normalized.images) ? normalized.images : []).slice(0, 4);
    const file = normalized && normalized.file ? normalized.file : null;
    const attachments = images
      .map((url) => ({ kind: 'image', url }))
      .concat(file && file.url ? [{ kind: 'file', url: file.url, name: file.name || '' }] : []);

    if (!text && !attachments.length) {
      reply.final(REPLY.unsupportedText);
      return;
    }

    // 频道必须存在（凭据里的工作空间等配置都来自它）；连接状态由调用方保证
    const channel = store.getChannel(channelId);
    if (!channel) {
      reply.final('频道不存在。');
      return;
    }
    const pending = chainsFor(channelId);
    // 同一会话串行：忙就明确告知，不排队（排队会让用户以为消息丢了）
    if (pending.has(conversationKey)) {
      reply.final(REPLY.busyText);
      return;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => {
      log(`[channels] ${channelId} 任务超时（${REPLY.taskTimeoutMs}ms），中止`);
      controller.abort();
    }, REPLY.taskTimeoutMs);
    if (typeof timeout.unref === 'function') timeout.unref();

    const sink = createThrottledSink({ reply, log });
    sink.start();
    reply.stream(REPLY.startedText, false);

    const task = (async () => {
      try {
        const result = await runOnce(channelId, {
          conversationKey,
          text,
          attachments,
          sink,
          signal: controller.signal
        });
        const delivered = result && result.text != null ? String(result.text) : sink.current();
        if (controller.signal.aborted) {
          sink.fail(REPLY.timeoutText);
        } else {
          sink.final(delivered);
        }
        log(
          `[channels] ${channelId} 会话=${result && result.sessionId ? result.sessionId : '?'} key=${conversationKey} ` +
            `用时=${Math.round((Date.now() - started) / 1000)}s 字数=${delivered.length}`
        );
      } catch (e) {
        const message = (e && e.message) || String(e);
        log(`[channels] ${channelId} 处理失败：${message}`);
        if (controller.signal.aborted) sink.fail(REPLY.timeoutText);
        // 细节可能带内部路径 / RPC / 堆栈：只有明确标了 userSafe 的才原样发给微信
        else sink.fail(e && e.userSafe ? `处理失败：${clip(message, 200)}` : REPLY.failedText);
      } finally {
        clearTimeout(timeout);
        pending.delete(conversationKey);
      }
    })();
    // 存的是 { task, controller }：停频道/停进程时靠 controller 真正中止在跑的轮次
    pending.set(conversationKey, { task, controller });
    // 返回本轮任务：长连接回调不 await（不能堵住 socket），测试与自检可以直接等它
    return task;
  }

  function startChannel(channelId) {
    const id = String(channelId || '').trim();
    if (!id || running.has(id)) return null;
    const channel = store.getChannel(id);
    if (!channel || !channel.enabled) return null;
    const secrets = store.getChannelSecrets(id);
    if (!secrets || !secrets.botId || !secrets.secret) {
      log(`[channels] ${id} 缺少可用凭据，跳过启动`);
      return null;
    }
    const client = createWecomChannelClient({
      channelId: id,
      botId: secrets.botId,
      secret: secrets.secret,
      log,
      onStatus: (status) => log(`[channels] ${id} 状态 ${status.state}${status.detail ? ` · ${status.detail}` : ''}`),
      onMessage: (payload) => {
        handleMessage(id, payload).catch((e) => log(`[channels] ${id} 消息处理异常：${e && e.message}`));
      },
      onEvent: (payload) => handleEvent(id, payload)
    });
    running.set(id, { client });
    client.start();
    return client.getStatus();
  }

  /**
   * 停频道时把在跑的轮次一起中止。
   *
   * 不中止的话，那一轮会在已经断掉的连接上继续跑满 900s：继续吃 token、继续往账本写
   * assistant 消息，而用户那头永远停在「已收到，正在处理…」。
   */
  function abortChannelTurns(id) {
    const pendingMap = chains.get(id);
    if (!pendingMap) return 0;
    let aborted = 0;
    for (const [key, entry] of Array.from(pendingMap.entries())) {
      try {
        if (entry && entry.controller) entry.controller.abort();
        aborted += 1;
      } catch {
        // ignore
      }
      pendingMap.delete(key);
    }
    return aborted;
  }

  function stopChannel(channelId) {
    const id = String(channelId || '').trim();
    // 先中止在跑的轮次：判据是「这条频道要停」，与连不连接得上无关
    const aborted = abortChannelTurns(id);
    const entry = running.get(id);
    if (entry) {
      entry.client.stop();
      running.delete(id);
    }
    chains.delete(id);
    return !!entry || aborted > 0;
  }

  function startEnabled() {
    for (const channel of store.listChannels()) {
      if (channel.enabled && channel.hasSecret) startChannel(channel.id);
    }
  }

  function stopAll() {
    for (const id of Array.from(running.keys())) stopChannel(id);
  }

  /**
   * 主动推送：日报 / 巡检结果直推（不等用户先说话）。
   *
   * 返回「服务端到底受理没」：企微对 `aibot_send_msg` 会回 errcode，回执超时只说「没等到
   * 回执」（部分版本不回 ack），不当成失败。以前这里只看 `ws.send` 有没有抛，目标填错了
   * 也报成功 —— 设置页点「测试推送」永远是假绿灯。
   */
  async function pushText(channelId, conversationKey, text) {
    const entry = running.get(String(channelId || '').trim());
    if (!entry) return { ok: false, error: 'CHANNEL_NOT_RUNNING' };
    const res = await entry.client.sendProactiveText(conversationKey, clip(text));
    if (res && res.ok) {
      return res.ack === 'timeout'
        ? { ok: true, ack: 'timeout', note: '已发出，5s 内没等到服务端回执（该机器人版本可能不回 ack）' }
        : { ok: true, ack: 'ok' };
    }
    if (res && res.ack === 'rejected') {
      return {
        ok: false,
        error: `服务端拒绝：errcode=${res.errcode} ${res.errmsg || ''}`.trim(),
        errorCode: 'SERVER_REJECTED',
        errcode: res.errcode
      };
    }
    return { ok: false, error: (res && res.error) || 'SEND_FAILED' };
  }

  return {
    REPLY,
    startChannel,
    stopChannel,
    startEnabled,
    stopAll,
    isRunning,
    statuses,
    statusOf,
    pushText,
    handleMessage
  };
}

module.exports = { createChannelRuntime, createThrottledSink, clip, REPLY };
