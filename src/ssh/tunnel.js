'use strict';

const net = require('net');

function bindSshClientLifecycle(client, onDisconnected) {
  if (!client || typeof client.on !== 'function' || typeof onDisconnected !== 'function') {
    return () => {};
  }
  const handler = () => onDisconnected();
  client.on('close', handler);
  client.on('end', handler);
  client.on('error', handler);
  return () => {
    try {
      client.removeListener('close', handler);
      client.removeListener('end', handler);
      client.removeListener('error', handler);
    } catch {
      // ignore
    }
  };
}

/**
 * Listen locally and forward each TCP connection through SSH forwardOut.
 * @param {import('ssh2').Client} client
 * @param {{ localHost?: string, localPort: number, remoteHost?: string, remotePort: number, isConnected?: () => boolean, onDisconnect?: () => void, onChannelError?: (err: unknown) => void }} opts
 */
function createSshTunnel(client, opts) {
  const localHost = opts.localHost || '127.0.0.1';
  const localPort = Number(opts.localPort);
  const remoteHost = opts.remoteHost || '127.0.0.1';
  const remotePort = Number(opts.remotePort);
  const isConnected =
    typeof opts.isConnected === 'function' ? opts.isConnected : () => !!client;
  const onDisconnect = typeof opts.onDisconnect === 'function' ? opts.onDisconnect : null;
  const onChannelError = typeof opts.onChannelError === 'function' ? opts.onChannelError : null;
  // localPort 允许为 0：交给 OS 分配空闲端口（随机端口转发），仅在缺省/非法时才拒绝
  const hasLocalPort = Number.isFinite(localPort) && localPort >= 0;
  if (!client || !hasLocalPort || !remotePort) {
    return Promise.reject(new Error('SSH 隧道参数无效'));
  }

  return new Promise((resolve, reject) => {
    let sshAlive = true;
    /** @type {import('net').Server | null} */
    let server = null;

    const markDisconnected = () => {
      if (!sshAlive) return;
      sshAlive = false;
      if (server) {
        try {
          server.close();
        } catch {
          // ignore
        }
      }
      if (onDisconnect) {
        try {
          onDisconnect();
        } catch {
          // ignore
        }
      }
    };

    const unbindClient = bindSshClientLifecycle(client, markDisconnected);

    server = net.createServer((socket) => {
      if (!sshAlive || !isConnected()) {
        socket.destroy();
        return;
      }
      try {
        client.forwardOut('127.0.0.1', 0, remoteHost, remotePort, (err, stream) => {
          if (err || !stream) {
            // 通道打不开（远端没监听/被拒）时浏览器只会看到"连上又被关闭"
            // （ERR_EMPTY_RESPONSE），把真实原因抛给上层记录，否则无从排查
            if (onChannelError) {
              try {
                onChannelError(err || new Error('forwardOut 未返回通道'));
              } catch {
                // ignore
              }
            }
            socket.destroy();
            return;
          }
          socket.pipe(stream);
          stream.pipe(socket);
          socket.on('error', () => {
            try {
              stream.close();
            } catch {
              // ignore
            }
          });
          stream.on('error', () => {
            try {
              socket.destroy();
            } catch {
              // ignore
            }
          });
          socket.on('close', () => {
            try {
              stream.close();
            } catch {
              // ignore
            }
          });
          stream.on('close', () => {
            try {
              socket.destroy();
            } catch {
              // ignore
            }
          });
        });
      } catch {
        socket.destroy();
        markDisconnected();
      }
    });

    server.on('close', () => {
      sshAlive = false;
      unbindClient();
    });

    server.on('error', (err) => {
      unbindClient();
      reject(err);
    });

    server.listen(localPort, localHost, () => resolve(server));
  });
}

/**
 * 诊断用的一次性 HTTP 探针：本地转发端口到底能不能拿到响应。
 * 命中任一字节即算通（记下 HTTP 状态码）；连接被对端直接关闭记为 empty_response
 * —— 这在"隧道通、但远端该端口没有服务/不是 HTTP 服务"时才会出现。
 *
 * @param {{ host?: string, port: number, timeoutMs?: number }} opts
 * @returns {Promise<{ ok: boolean, status?: number, bytes?: number, error?: string }>}
 */
function probeForwardedHttp(opts = {}) {
  const host = opts.host || '127.0.0.1';
  const port = Number(opts.port);
  const timeoutMs = Math.min(5000, Math.max(200, Number(opts.timeoutMs) || 1200));
  return new Promise((resolve) => {
    if (!port) {
      resolve({ ok: false, error: 'no_port' });
      return;
    }
    let settled = false;
    let bytes = 0;
    let status = 0;
    let head = '';
    // done 会清掉 timer，先声明再赋值，避免 TDZ 隐患
    let timer = null;
    const socket = net.connect({ host, port });
    const done = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      try {
        socket.destroy();
      } catch {
        // ignore
      }
      resolve(result);
    };
    timer = setTimeout(() => done({ ok: false, error: 'timeout', bytes }), timeoutMs);
    socket.on('connect', () => {
      try {
        socket.write(
          `GET / HTTP/1.0\r\nHost: ${host}:${port}\r\nUser-Agent: dieyun-preview-probe\r\n\r\n`
        );
      } catch {
        done({ ok: false, error: 'empty_response', bytes });
      }
    });
    socket.on('data', (chunk) => {
      bytes += chunk.length;
      if (!status) {
        head += chunk.toString('latin1');
        const m = /^HTTP\/\d\.\d (\d{3})/.exec(head);
        if (m) status = Number(m[1]);
      }
      done({ ok: true, status: status || undefined, bytes });
    });
    socket.on('error', (e) => done({ ok: false, error: (e && e.code) || String(e) }));
    socket.on('close', () => done({ ok: false, error: 'empty_response', bytes }));
  });
}

function closeSshTunnel(server) {
  if (!server) return Promise.resolve();
  return new Promise((resolve) => {
    try {
      server.close(() => resolve());
    } catch {
      resolve();
    }
  });
}

module.exports = { createSshTunnel, closeSshTunnel, probeForwardedHttp };
