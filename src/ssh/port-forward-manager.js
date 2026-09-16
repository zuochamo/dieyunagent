'use strict';

const { createSshTunnel, closeSshTunnel, probeForwardedHttp } = require('./tunnel');

/**
 * @param {{ log?: (msg: string) => void }} [opts]
 */
function createPortForwardManager(opts = {}) {
  const log = opts.log || (() => {});
  /** @type {Map<string, { server: import('net').Server, localHost: string, localPort: number, remoteHost: string, remotePort: number, hostKey: string, health: { channelErrors: number, lastChannelError: string } }>} */
  const forwards = new Map();
  let nextId = 1;

  /**
   * @param {ReturnType<import('./session-manager').createSshSessionManager>} sshManager
   * @param {{ localHost?: string, localPort?: number, remoteHost?: string, remotePort: number, hostKey?: string }} spec
   */
  async function addForward(sshManager, spec) {
    sshManager.assertConnected();
    const client = sshManager.getClient();
    const localHost = spec.localHost || '127.0.0.1';
    const remoteHost = spec.remoteHost || '127.0.0.1';
    const remotePort = Number(spec.remotePort);
    if (!remotePort) {
      throw Object.assign(new Error('remotePort 必填'), { code: 'INVALID_PORT_FORWARD' });
    }
    const requestedLocal = Number(spec.localPort) || 0;
    // 隧道创建/存活期间 SSH 可能断开：用 ref 记录状态，避免把已死的隧道登记进表
    const health = { channelErrors: 0, lastChannelError: '' };
    const ref = { id: '', dead: false };
    const server = await createSshTunnel(client, {
      localHost,
      localPort: requestedLocal,
      remoteHost,
      remotePort,
      isConnected: () => sshManager.status().connected,
      onDisconnect: () => {
        ref.dead = true;
        if (!ref.id) return;
        const gone = forwards.get(ref.id);
        forwards.delete(ref.id);
        if (gone) {
          log(
            `SSH 端口转发已失效并移除 (#${ref.id})：${localHost}:${gone.localPort} → ${remoteHost}:${remotePort}`
          );
        }
      },
      onChannelError: (err) => {
        health.channelErrors += 1;
        health.lastChannelError = err && err.message ? err.message : String(err);
        // 浏览器会持续重试，只记首次，避免刷爆日志
        if (health.channelErrors === 1) {
          log(`SSH 端口转发通道失败 ${remoteHost}:${remotePort}：${health.lastChannelError}`);
        }
      }
    });
    if (ref.dead) {
      await closeSshTunnel(server);
      throw Object.assign(new Error('SSH 连接在建立转发过程中断开'), { code: 'SSH_NOT_CONNECTED' });
    }
    const addr = server.address();
    const localPort = typeof addr === 'object' && addr ? addr.port : requestedLocal;
    const hostKey = spec.hostKey != null ? String(spec.hostKey) : '';
    const id = String(nextId++);
    ref.id = id;
    forwards.set(id, { server, localHost, localPort, remoteHost, remotePort, hostKey, health });
    log(`SSH 端口转发 ${localHost}:${localPort} → ${remoteHost}:${remotePort} (#${id})`);
    return { id, localHost, localPort, remoteHost, remotePort, hostKey };
  }

  /** 只有"本地端口不可用"才值得退到随机端口重试；其它错误直接抛，避免掩盖真因 */
  const LOCAL_BIND_ERROR_CODES = new Set(['EADDRINUSE', 'EACCES', 'EADDRNOTAVAIL']);

  /**
   * 命中同目标的存活转发；顺手清掉已死的——SSH 重连后旧隧道对新 client 无效，
   * 继续复用会永远无法自愈（每次连接都表现为浏览器 ERR_EMPTY_RESPONSE）。
   */
  function findLiveForward(hostKey, remoteHost, remotePort) {
    for (const [id, f] of [...forwards]) {
      if (f.hostKey !== hostKey || f.remoteHost !== remoteHost || f.remotePort !== remotePort) continue;
      if (f.server && f.server.listening) return { id, f };
      forwards.delete(id);
      log(`SSH 端口转发 (#${id}) 已失效，将重建`);
    }
    return null;
  }

  /**
   * 同一远端目标已有转发就复用，否则新建。
   * 优先占用与远端相同的本地端口（URL 里的端口号保持不变，页面内绝对地址与回调仍可用），
   * 该端口在本机被占用时退回随机端口，并把原因回传供调用方提示。
   *
   * @param {ReturnType<import('./session-manager').createSshSessionManager>} sshManager
   * @param {{ hostKey?: string, localPort?: number, remoteHost?: string, remotePort: number }} spec
   */
  async function findOrAddForward(sshManager, spec) {
    const hostKey = spec.hostKey != null ? String(spec.hostKey) : '';
    const remoteHost = spec.remoteHost || '127.0.0.1';
    const remotePort = Number(spec.remotePort);
    const live = findLiveForward(hostKey, remoteHost, remotePort);
    if (live) {
      return {
        id: live.id,
        localHost: live.f.localHost,
        localPort: live.f.localPort,
        remoteHost,
        remotePort,
        hostKey,
        reused: true
      };
    }
    const preferredLocalPort = Number(spec.localPort) || remotePort;
    try {
      const row = await addForward(sshManager, { ...spec, hostKey, remoteHost, remotePort, localPort: preferredLocalPort });
      return { ...row, reused: false };
    } catch (e) {
      const code = e && e.code ? String(e.code) : '';
      if (!preferredLocalPort || !LOCAL_BIND_ERROR_CODES.has(code)) throw e;
      try {
        const row = await addForward(sshManager, { ...spec, hostKey, remoteHost, remotePort, localPort: 0 });
        return {
          ...row,
          reused: false,
          localPortFallback: true,
          preferredLocalPortError: e && e.message ? e.message : String(e)
        };
      } catch (retryErr) {
        const err = new Error(
          `${retryErr && retryErr.message ? retryErr.message : String(retryErr)}` +
            `（本机 ${preferredLocalPort} 也不可用：${e && e.message ? e.message : String(e)}）`
        );
        err.code = (retryErr && retryErr.code) || code;
        throw err;
      }
    }
  }

  /** 单个转发的健康快照（诊断用）：是否存活 + 最近一次通道错误。 */
  function getForward(id) {
    const f = forwards.get(String(id));
    if (!f) return null;
    return {
      id: String(id),
      localHost: f.localHost,
      localPort: f.localPort,
      remoteHost: f.remoteHost,
      remotePort: f.remotePort,
      hostKey: f.hostKey || '',
      alive: !!(f.server && f.server.listening),
      channelErrors: f.health ? f.health.channelErrors : 0,
      lastChannelError: f.health ? f.health.lastChannelError : ''
    };
  }

  async function removeForward(id) {
    const f = forwards.get(String(id));
    if (!f) return { ok: false, error: '转发不存在' };
    await closeSshTunnel(f.server);
    forwards.delete(String(id));
    return { ok: true, id: String(id) };
  }

  async function removeAll() {
    const ids = [...forwards.keys()];
    for (const id of ids) {
      await removeForward(id);
    }
  }

  function listForwards() {
    return [...forwards.entries()].map(([id, f]) => ({
      id,
      localHost: f.localHost,
      localPort: f.localPort,
      remoteHost: f.remoteHost,
      remotePort: f.remotePort,
      hostKey: f.hostKey || '',
      alive: !!(f.server && f.server.listening)
    }));
  }

  /**
   * 诊断用：某个本地端口是否真的能拿到 HTTP 响应。
   * 只读探针，不影响既有转发；供"页面打不开"时区分「转发没建」和「远端没服务」。
   * @param {{ host?: string, port: number, timeoutMs?: number }} spec
   */
  function probeHttp(spec = {}) {
    return probeForwardedHttp(spec);
  }

  return { addForward, findOrAddForward, getForward, removeForward, removeAll, listForwards, probeHttp };
}

module.exports = { createPortForwardManager };
