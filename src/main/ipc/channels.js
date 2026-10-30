'use strict';

// @ts-check
/**
 * 频道（企业微信等外部入口）的 IPC（Renderer ↔ Main）。
 *
 * 形状与其它 IPC 一致：`{ ok: true, ... }` / `{ ok: false, error }`。
 * **不在这里做业务判定**：凭据怎么存、条目怎么改、连接什么时候起停，分别在
 * `channels/store.js` 与 `channels/runtime.js`；这里只做参数整形 + 调用 + 结果透传。
 *
 * 为什么不复用手机内网桥的 `task.submit`：那条路的语义是「驱动桌面上正在看的会话」，
 * 会切走用户的桌面对话（见 issue/2026-10-30-agent-channel-and-workspace-binding.md 问题 3）。
 * 频道任务在 Main 后台跑，与桌面视图完全无关。
 */

/**
 * @param {{
 *   ipcMain: import('electron').IpcMain,
 *   getChannelStore: () => any,
 *   getChannelRuntime: () => any,
 *   log?: (msg: string) => void
 * }} ctx
 */
function registerChannelIpc(ctx) {
  const { ipcMain } = ctx;
  const log = typeof ctx.log === 'function' ? ctx.log : () => {};

  function store() {
    return ctx.getChannelStore ? ctx.getChannelStore() : null;
  }

  function runtime() {
    return ctx.getChannelRuntime ? ctx.getChannelRuntime() : null;
  }

  function unavailable() {
    return { ok: false, error: '频道运行时未就绪', errorCode: 'CHANNELS_UNAVAILABLE' };
  }

  function snapshot() {
    const s = store();
    const r = runtime();
    if (!s) return { channels: [], statuses: [] };
    const statuses = r ? r.statuses() : [];
    const byId = new Map(statuses.map((x) => [x.channelId, x]));
    return {
      channels: s.listChannels().map((c) => ({
        ...c,
        status: byId.get(c.id) ? byId.get(c.id).state : 'stopped',
        lastError: byId.get(c.id) ? byId.get(c.id).lastError || '' : '',
        busyConversations: byId.get(c.id) ? byId.get(c.id).busyConversations || 0 : 0
      })),
      statuses
    };
  }

  /**
   * 配置变更后立刻生效。
   *
   * 只有「会影响长连接」的改动才断线重连（启停 / 换 botId / 换 Secret）：改个名字、改句
   * 欢迎语就断一次连接，会打断正在跑的那一轮，还会把用户丢在微信里的「已收到，正在处理…」。
   */
  function applyChannelState(id, opts = {}) {
    const r = runtime();
    const s = store();
    if (!r || !s) return;
    const channel = s.getChannel(id);
    if (!channel || !channel.enabled || !channel.hasSecret) {
      r.stopChannel(id);
      return;
    }
    if (!opts.connectionChanged && r.isRunning(id)) return;
    r.stopChannel(id);
    r.startChannel(id);
  }

  function wrap(fn) {
    return async (_evt, payload) => {
      try {
        if (!store()) return unavailable();
        return await fn(payload && typeof payload === 'object' ? payload : {});
      } catch (err) {
        const e = /** @type {any} */ (err);
        log(`[channels] IPC 失败：${e && e.message}`);
        return { ok: false, error: (e && e.message) || String(err), errorCode: e && e.code ? e.code : undefined };
      }
    };
  }

  ipcMain.handle(
    'channels:list',
    wrap(async () => {
      const s = store();
      return { ok: true, ...snapshot(), canEncrypt: s.canEncrypt() };
    })
  );

  ipcMain.handle(
    'channels:create',
    wrap(async (payload) => {
      const created = store().createChannel({
        name: payload.name,
        botId: payload.botId,
        secret: payload.secret,
        workspacePath: payload.workspacePath,
        welcomeText: payload.welcomeText
      });
      applyChannelState(created.id);
      return { ok: true, channel: created, ...snapshot() };
    })
  );

  ipcMain.handle(
    'channels:update',
    wrap(async (payload) => {
      const id = String(payload.id || '');
      const before = store().getChannel(id);
      const updated = store().updateChannel(id, {
        name: payload.name,
        botId: payload.botId,
        secret: payload.secret,
        workspacePath: payload.workspacePath,
        welcomeText: payload.welcomeText,
        enabled: payload.enabled
      });
      const botIdChanged =
        !!before &&
        payload.botId != null &&
        String(payload.botId).trim() !== String(before.botId || '');
      const enabledChanged = !!before && payload.enabled != null && !!payload.enabled !== !!before.enabled;
      applyChannelState(id, {
        // 传了非空 secret = 真的换了凭据（留空表示「不改」）
        connectionChanged: !before || !!payload.secret || botIdChanged || enabledChanged
      });
      return { ok: true, channel: updated, ...snapshot() };
    })
  );

  ipcMain.handle(
    'channels:delete',
    wrap(async (payload) => {
      const id = String(payload.id || '');
      const r = runtime();
      if (r) r.stopChannel(id);
      const res = store().deleteChannel(id);
      if (!res.ok) return { ok: false, error: '频道不存在', errorCode: 'CHANNEL_NOT_FOUND' };
      return { ok: true, ...snapshot() };
    })
  );

  ipcMain.handle(
    'channels:set-enabled',
    wrap(async (payload) => {
      const id = String(payload.id || '');
      const before = store().getChannel(id);
      const updated = store().updateChannel(id, { enabled: !!payload.enabled });
      applyChannelState(id, { connectionChanged: !before || !!payload.enabled !== !!before.enabled });
      return { ok: true, channel: updated, ...snapshot() };
    })
  );

  /**
   * 连通性自检（等价 `bridge.py --check`）：可以测已保存的频道，也可以测「还没保存的凭据」，
   * 让用户在保存前就知道 Secret 对不对。
   */
  ipcMain.handle(
    'channels:test',
    wrap(async (payload) => {
      const { probeWecomCredentials } = require('../../channels/wecom-client');
      const id = String(payload.id || '');
      let botId = String(payload.botId || '').trim();
      let secret = String(payload.secret || '').trim();
      const stored = id ? store().getChannelSecrets(id) : null;
      if ((!botId || !secret) && stored) {
        botId = botId || stored.botId;
        secret = secret || stored.secret;
      }
      const r = runtime();
      const live = id && r ? r.statusOf(id) : null;
      // 服务端同一 bot 只允许一条长连接：频道在线时再探测一条，等于把线上连接顶掉
      // （然后我们自己的重连又把探测顶回去，两边互顶、消息两头丢）。凭据没变就直接采信。
      const sameCreds =
        !!stored &&
        String(stored.botId || '') === botId &&
        String(stored.secret || '') === secret;
      if (live && live.connected && sameCreds) {
        return {
          ok: true,
          reused: true,
          errcode: 0,
          note: '该频道当前在线，凭据已在用（复用现有长连接，未另开探测连接）'
        };
      }
      if (live && live.busyConversations > 0) {
        return {
          ok: false,
          errorCode: 'CHANNEL_BUSY',
          error: '该频道正在处理消息，等这一轮跑完再测连接（现在就测会打断它）'
        };
      }
      // 需要真探测：先摘掉线上连接，测完恢复，避免两条连接互顶
      const wasRunning = !!(id && r && r.isRunning(id));
      if (wasRunning) r.stopChannel(id);
      try {
        const result = await probeWecomCredentials({ botId, secret });
        return { ok: !!result.ok, ...result };
      } finally {
        if (wasRunning) {
          try {
            r.startChannel(id);
          } catch (e) {
            log(`[channels] 探测后恢复连接失败：${e && e.message}`);
          }
        }
      }
    })
  );

  /** 主动推送自检：日报/巡检「能不能直推微信」一试便知（帧形状不对时服务端会打回 errcode） */
  ipcMain.handle(
    'channels:test-push',
    wrap(async (payload) => {
      const r = runtime();
      if (!r) return unavailable();
      const id = String(payload.id || '');
      const conversationKey = String(payload.conversationKey || '').trim();
      if (!conversationKey) {
        return { ok: false, error: '请填写推送目标（群 chatid 或 single:<userid>）', errorCode: 'INVALID_PARAMS' };
      }
      const res = await r.pushText(id, conversationKey, String(payload.text || '叠云 Agent 推送测试'));
      return res.ok ? { ok: true, ack: res.ack, note: res.note } : { ok: false, error: res.error, errorCode: res.errorCode };
    })
  );
}

module.exports = { registerChannelIpc };
