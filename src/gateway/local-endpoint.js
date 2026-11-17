'use strict';

/**
 * 本地 Gateway 端点的**唯一来源**（监听端与 Node 侧客户端都读这里）。
 *
 * 默认不占 TCP 端口：
 * - POSIX：`<userData>/gateway.sock`（AF_UNIX，目录 0700 / socket 0600）
 * - Windows：`\\.\pipe\dieyun-gateway-<userData 摘要>`（命名管道，权限交给管道默认 ACL，
 *   **不要**抄 UN*X 的 0600 语义 —— 两者不是一套模型）
 *
 * 安全边界因此是**文件系统权限**，不再需要 `gateway-token.txt` 当门禁。
 * TCP + token 只在显式设置 `DIECLOUD_GATEWAY_PORT` 时保留（调试 / 外部工具 / 端口转发）。
 *
 * 桌面 Renderer **不走这里**：Chromium 连不了 socket / 命名管道，它经 Main IPC 调
 * `gateway.invokeRpc`（见 `preload.js#gatewayRpc`）。这条路留给「另一个本机进程想驱动
 * 同一个 Gateway」的场景（例如 `scripts/verify-index-effectiveness.cjs`）。
 */

const fs = require('fs');
const net = require('net');
const path = require('path');
const crypto = require('crypto');

const SOCKET_FILE = 'gateway.sock';
const PIPE_PREFIX = 'dieyun-gateway-';

/** @typedef {{ transport: 'unix'|'pipe'|'tcp', path?: string, host?: string, port?: number }} LocalGatewayEndpoint */

function unixSocketPath(userDataPath) {
  return path.join(String(userDataPath), SOCKET_FILE);
}

/** 命名管道名按 userData 摘要派生：同一份数据目录 = 同一个管道，不同 userData 互不干扰。 */
function pipePath(userDataPath) {
  const key = crypto
    .createHash('sha256')
    .update(path.resolve(String(userDataPath)).toLowerCase())
    .digest('hex')
    .slice(0, 16);
  return `\\\\.\\pipe\\${PIPE_PREFIX}${key}`;
}

/**
 * @param {{ userDataPath: string, env?: NodeJS.ProcessEnv, platform?: NodeJS.Platform }} opts
 * @returns {LocalGatewayEndpoint}
 */
function resolveLocalGatewayEndpoint(opts = {}) {
  const env = opts.env || process.env;
  const platform = opts.platform || process.platform;
  const port = Number(env.DIECLOUD_GATEWAY_PORT) || 0;
  if (port > 0) return { transport: 'tcp', host: '127.0.0.1', port };
  const userDataPath = String(opts.userDataPath || '');
  if (!userDataPath) throw new Error('resolveLocalGatewayEndpoint 需要 userDataPath');
  if (platform === 'win32') return { transport: 'pipe', path: pipePath(userDataPath) };
  return { transport: 'unix', path: unixSocketPath(userDataPath) };
}

/** 人类可读的一行（日志 / 状态标签）。 */
function describeLocalGatewayEndpoint(endpoint) {
  if (!endpoint) return '未启动';
  if (endpoint.transport === 'tcp') return `ws://${endpoint.host}:${endpoint.port}`;
  if (endpoint.transport === 'pipe') return `pipe:${endpoint.path}`;
  if (endpoint.transport === 'unix') return `unix:${endpoint.path}`;
  return String(endpoint.transport);
}

/**
 * `ws` 客户端连私有端点的 `createConnection`：ws 只认 URL，所以给一个假 host，
 * 真正的连接由这里交给 `net`（与 `gateway/remote-agent-client.js` 同一手法）。
 * TCP 端点返回 null，调用方按普通 URL 连即可。
 */
function createConnectionForEndpoint(endpoint, opts = {}) {
  if (!endpoint || endpoint.transport === 'tcp') return null;
  const target = endpoint.path;
  return () => net.connect({ path: target, ...(opts.timeoutMs ? { timeout: opts.timeoutMs } : {}) });
}

/** ws 客户端的假 URL（真连接走 createConnectionForEndpoint）。 */
function webSocketUrlForEndpoint(endpoint) {
  if (endpoint && endpoint.transport === 'tcp') return `ws://${endpoint.host}:${endpoint.port}`;
  return 'ws://dieyun-gateway/';
}

/** 端点当前是否已有监听（POSIX 用 connect 探测：文件存在不等于有人在听）。 */
function isEndpointListening(endpoint, timeoutMs = 300) {
  return new Promise((resolve) => {
    const conn = createConnectionForEndpoint(endpoint);
    if (!conn) {
      const sock = net.connect({ host: endpoint.host, port: endpoint.port });
      const done = (v) => {
        sock.destroy();
        resolve(v);
      };
      sock.once('connect', () => done(true));
      sock.once('error', () => done(false));
      sock.setTimeout(timeoutMs, () => done(false));
      return;
    }
    const sock = conn();
    const done = (v) => {
      sock.destroy();
      resolve(v);
    };
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
    sock.setTimeout(timeoutMs, () => done(false));
  });
}

/** POSIX socket 文件存在但没人听 = 上次进程崩溃留下的残留，监听前必须清掉。 */
function removeStaleUnixSocket(endpoint) {
  if (!endpoint || endpoint.transport !== 'unix') return false;
  try {
    if (!fs.existsSync(endpoint.path)) return false;
    fs.unlinkSync(endpoint.path);
    return true;
  } catch {
    return false;
  }
}

/** 目录只给当前用户（socket 的权限只保护「能不能连」，目录权限保护「能不能替换」）。 */
function prepareSocketDir(endpoint) {
  if (!endpoint || endpoint.transport !== 'unix') return;
  const dir = path.dirname(endpoint.path);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    // 非 POSIX 权限模型 / 无权限：交给 listen 失败去报
  }
}

function restrictSocketFile(endpoint) {
  if (!endpoint || endpoint.transport !== 'unix') return;
  try {
    fs.chmodSync(endpoint.path, 0o600);
  } catch {
    // ignore
  }
}

module.exports = {
  SOCKET_FILE,
  resolveLocalGatewayEndpoint,
  describeLocalGatewayEndpoint,
  createConnectionForEndpoint,
  webSocketUrlForEndpoint,
  isEndpointListening,
  removeStaleUnixSocket,
  prepareSocketDir,
  restrictSocketFile,
  unixSocketPath,
  pipePath
};
