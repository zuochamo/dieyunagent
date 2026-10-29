'use strict';

/**
 * ProxyJump（跳板机）链路。
 *
 * ssh2 没有 `ProxyJump` 这个概念，只能手工串：每条边先在前一跳上开
 * `forwardOut`（direct-tcpip channel），把拿到的流当下一跳/目标的 `sock`。
 * 这段逻辑必须集中在一处 —— 隧道/端口转发/重连都各自手搓一遍串接是这类
 * 代码最常见的走形方式。
 *
 * 职责边界：本文件不决定「谁认证什么」（那是 connect-payload + session-manager），
 * 只负责「把 N 跳串起来，失败时把这轮已建立的连接全部拆掉」。
 */

/** 在已建立的连接上打开一条到下一跳的 TCP 通道。 */
function forwardSocket(client, host, port) {
  return new Promise((resolve, reject) => {
    try {
      client.forwardOut('127.0.0.1', 0, host, port, (err, stream) => {
        if (err || !stream) {
          reject(
            Object.assign(new Error(`跳板转发失败（→ ${host}:${port}）：${(err && err.message) || '无通道'}`), {
              code: 'SSH_JUMP_FORWARD_FAILED',
              jumpHost: host,
              jumpPort: port,
              cause: err
            })
          );
          return;
        }
        resolve(stream);
      });
    } catch (e) {
      reject(e);
    }
  });
}

function closeQuietly(client) {
  if (!client) return;
  try {
    client.removeAllListeners && client.removeAllListeners('error');
    client.on && client.on('error', () => {});
    client.end && client.end();
    client.destroy && client.destroy();
  } catch {
    // ignore
  }
}

/**
 * 依次连上每个跳板，返回最后一个跳板的连接与一个统一 dispose。
 *
 * `connectHop(hop, sock)` 由调用方提供（它知道认证与主机校验怎么做）；
 * `sock` 为 null 表示这是第一跳（直连）。
 *
 * @param {{
 *   hops: Array<{host: string, port: number, username: string}>,
 *   connectHop: (hop: any, sock: any) => Promise<any>,
 *   log?: (msg: string) => void
 * }} opts
 * @returns {Promise<{lastClient: any, hopClients: any[], dispose: () => void}>}
 */
async function createJumpChain(opts) {
  const hops = Array.isArray(opts.hops) ? opts.hops : [];
  const connectHop = opts.connectHop;
  const log = opts.log || (() => {});
  const hopClients = [];

  const dispose = () => {
    for (const c of [...hopClients].reverse()) closeQuietly(c);
    hopClients.length = 0;
  };

  if (!hops.length) return { lastClient: null, hopClients, dispose };
  if (typeof connectHop !== 'function') throw new Error('createJumpChain 需要 connectHop');

  let prev = null;
  for (const hop of hops) {
    let sock = null;
    let client;
    try {
      // forward 失败也要走同一个出口：它失败时上一跳的连接一样要拆，不然泄漏一条活的 SSH
      sock = prev ? await forwardSocket(prev, hop.host, hop.port) : null;
      client = await connectHop(hop, sock);
    } catch (e) {
      // 这一跳没连上：已建立的上一跳连接必须拆掉，否则泄漏一条活的 SSH
      try {
        sock && sock.close && sock.close();
      } catch {
        // ignore
      }
      dispose();
      throw e;
    }
    hopClients.push(client);
    log(`跳板已连接 ${hop.username ? `${hop.username}@` : ''}${hop.host}:${hop.port}`);
    prev = client;
  }
  return { lastClient: prev, hopClients, dispose };
}

module.exports = { createJumpChain, forwardSocket };
