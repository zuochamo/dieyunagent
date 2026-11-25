'use strict';

const fs = require('fs');
const path = require('path');
const { Client } = require('ssh2');
const { normalizeRemotePath } = require('../workspace/target');
const { shellQuoteSingle } = require('./remote-path');
const { attachExecSettlement } = require('../exec-settlement');
const { EXEC_OUTPUT_MAX_CHARS, clampExecTimeoutMs } = require('../exec-limits');
const { readLimitedFromStream } = require('./read-limited');
const { buildAuthPlan, createAuthState, createOrderedAuthHandler, detectAgentSocket } = require('./auth-methods');
const { createJumpChain, forwardSocket } = require('./proxy-jump');
const { isPathMissingError } = require('../gateway/path-policy');

const SFTP_PERMISSION = new Set([3, 'EACCES', 'EPERM', 'PERMISSION_DENIED']);

function sftpEntryIsDirectory(ent) {
  const mode = ent && ent.attrs != null ? Number(ent.attrs.mode) : NaN;
  if (Number.isFinite(mode) && mode > 0) return (mode & 0o170000) === 0o040000;
  const ln = ent && typeof ent.longname === 'string' ? ent.longname : '';
  return ln.charAt(0) === 'd';
}

function mapSftpDirEntries(list) {
  return (list || [])
    .filter((e) => e && e.filename && e.filename !== '.' && e.filename !== '..')
    .map((e) => ({
      name: e.filename,
      isDirectory: sftpEntryIsDirectory(e),
      size: (e.attrs && e.attrs.size) || 0,
      mtimeMs: ((e.attrs && e.attrs.mtime) || 0) * 1000
    }))
    .sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
}

function formatSftpBrowseError(err, remotePath) {
  const dir = remotePath || '/';
  const code = err && (err.code != null ? err.code : err.status);
  const raw = String((err && err.message) || err || '');
  let msg;
  // 「不存在」的判据只有一份（`gateway/path-policy.isPathMissingError`，含 SFTP 的 2 / 11）
  if (isPathMissingError(err)) {
    msg = `远程目录不存在：${dir}`;
  } else if (SFTP_PERMISSION.has(code) || /permission denied/i.test(raw)) {
    msg = `没有权限列出目录：${dir}。可手动输入家目录路径后回车`;
  } else if (/SSH 未连接/i.test(raw)) {
    msg = raw;
  } else {
    msg = `无法列出 ${dir}：${raw || 'SFTP 错误'}`;
  }
  const out = new Error(msg);
  out.code = (err && err.code) || 'SFTP_BROWSE_FAILED';
  out.cause = err;
  return out;
}

/**
 * @param {{ userDataPath?: string, log?: (msg: string) => void }} opts
 */
function createSshSessionManager(opts = {}) {
  const log = opts.log || (() => {});
  const knownHostsPath = opts.userDataPath
    ? path.join(opts.userDataPath, 'ssh-known-hosts.json')
    : null;

  /** @type {import('ssh2').Client | null} */
  let client = null;
  /** @type {import('ssh2').SFTPWrapper | null} */
  let sftp = null;
  /** @type {{ host: string, hostname?: string, port: number, username: string, authType?: string, viaJump?: string[] } | null} */
  let identity = null;
  /**
   * 远程 HOME 缓存：路径白名单（`<HOME>/.dieyun/workspace` 兜底根）是**同步**判定的
   * （resolveRemotePath 不 async），所以连接建立后探测一次并缓存，见 primeHomeDir()。
   */
  let cachedHomeDir = '';
  /** @type {Promise<string> | null} */
  let homePrimePromise = null;

  function loadKnownHosts() {
    if (!knownHostsPath) return {};
    try {
      return JSON.parse(fs.readFileSync(knownHostsPath, 'utf8'));
    } catch {
      return {};
    }
  }

  function saveKnownHost(host, port, fingerprint) {
    if (!knownHostsPath || !fingerprint) return;
    try {
      const key = `${host}:${port || 22}`;
      const map = loadKnownHosts();
      map[key] = fingerprint;
      fs.mkdirSync(path.dirname(knownHostsPath), { recursive: true });
      fs.writeFileSync(knownHostsPath, JSON.stringify(map, null, 2), 'utf8');
    } catch (e) {
      log('ssh known_hosts save: ' + (e && e.message));
    }
  }

  function normalizeFingerprint(fingerprint) {
    if (fingerprint == null) return '';
    if (Buffer.isBuffer(fingerprint)) return fingerprint.toString('hex').toLowerCase();
    return String(fingerprint)
      .trim()
      .replace(/^SHA256:/i, '')
      .replace(/:/g, '')
      .toLowerCase();
  }

  function verifyHost(host, port, fingerprint, opts = {}) {
    const fp = normalizeFingerprint(fingerprint);
    if (!fp) return;
    const key = `${host}:${port || 22}`;
    const map = loadKnownHosts();
    const saved = map[key] ? normalizeFingerprint(map[key]) : '';
    if (saved && saved !== fp) {
      if (opts.acceptNewHostKey === true) {
        saveKnownHost(host, port, fp);
        return;
      }
      const err = new Error('SSH 主机密钥已变更，请确认服务器身份后重连');
      err.code = 'SSH_HOST_KEY_MISMATCH';
      err.fingerprint = fp;
      err.savedFingerprint = saved;
      err.host = host;
      err.port = port || 22;
      throw err;
    }
    if (!saved && opts.acceptNewHostKey !== true) {
      const err = new Error('首次连接该 SSH 主机，请确认主机指纹');
      err.code = 'SSH_HOST_KEY_UNKNOWN';
      err.fingerprint = fp;
      err.host = host;
      err.port = port || 22;
      throw err;
    }
    saveKnownHost(host, port, fp);
  }

  /** 正在建立中的连接（含跳板每一跳），abort 时统一销毁 */
  const pendingConns = new Set();
  /** @type {((err: Error) => void) | null} */
  let abortConnect = null;
  /** @type {{dispose: () => void} | null} */
  let jumpChain = null;
  /** @type {Promise<void> | null} */
  let teardownPromise = null;
  /**
   * 在途的连接尝试（单一入口去重）：同一个意图只跑一次。
   * @type {{ key: string, promise: Promise<any>, abort: () => void } | null}
   */
  let connectInFlight = null;

  function normalizeConnectError(err) {
    if (!err) return err;
    const msg = String(err.message || err);
    if (msg === 'Connection lost before handshake') {
      return Object.assign(
        new Error(
          'SSH 握手失败：服务器在建立连接前断开了。请检查主机地址、端口、防火墙及 sshd 服务是否正常。'
        ),
        { code: 'SSH_HANDSHAKE_LOST' }
      );
    }
    if (/timed out|timeout/i.test(msg)) {
      return Object.assign(new Error('SSH 连接超时，请检查网络或主机是否可达'), { code: 'SSH_CONNECT_TIMEOUT' });
    }
    if (/ECONNREFUSED/i.test(msg)) {
      return Object.assign(new Error('SSH 连接被拒绝，请确认端口与 sshd 服务'), { code: 'SSH_CONN_REFUSED' });
    }
    if (/ENOTFOUND|EAI_AGAIN/i.test(msg)) {
      return Object.assign(new Error('无法解析主机地址，请检查主机名或 DNS'), { code: 'SSH_HOST_UNREACHABLE' });
    }
    if (/EHOSTUNREACH|ENETUNREACH/i.test(msg)) {
      return Object.assign(new Error('网络不可达，请检查路由或 VPN'), { code: 'SSH_HOST_UNREACHABLE' });
    }
    return err;
  }

  function destroyConn(conn) {
    if (!conn) return;
    try {
      conn.removeAllListeners();
      conn.on('error', () => {});
      conn.destroy();
    } catch {
      // ignore
    }
  }

  function gracefulCloseConn(conn) {
    return new Promise((resolve) => {
      if (!conn) {
        resolve();
        return;
      }
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        destroyConn(conn);
        resolve();
      };
      conn.on('error', () => {});
      conn.once('close', finish);
      try {
        conn.end();
      } catch {
        finish();
        return;
      }
      setTimeout(finish, 1000);
    });
  }

  function disconnect() {
    if (teardownPromise) return teardownPromise;
    teardownPromise = (async () => {
      const active = client;
      const abort = abortConnect;
      const chain = jumpChain;
      abortConnect = null;
      identity = null;
      sftp = null;
      client = null;
      jumpChain = null;
      // 换主机/重连后旧 HOME 不再适用，避免兜底根指向上一个会话
      cachedHomeDir = '';

      if (abort) {
        try {
          abort(Object.assign(new Error('SSH 连接已取消'), { code: 'SSH_CONNECT_ABORTED' }));
        } catch {
          // ignore
        }
      }

      // 在飞的每一跳（含目标）都要收掉，否则 cancel 会留下活的 SSH 连接
      for (const conn of [...pendingConns]) {
        destroyConn(conn);
      }
      pendingConns.clear();

      if (active) {
        await gracefulCloseConn(active);
      }
      if (chain) chain.dispose();
    })().finally(() => {
      teardownPromise = null;
    });
    return teardownPromise;
  }

  function status() {
    return {
      connected: !!(client && sftp && identity),
      host: identity?.host || null,
      hostname: identity?.hostname || null,
      port: identity?.port || 22,
      username: identity?.username || null,
      authType: identity?.authType || null,
      viaJump: identity?.viaJump || []
    };
  }

  function assertConnected() {
    if (!client || !sftp || !identity) {
      const err = new Error('SSH 未连接，请在工作空间菜单中连接远程主机');
      err.code = 'SSH_NOT_CONNECTED';
      throw err;
    }
    return { client, sftp, identity };
  }

  function withSftp(fn) {
    const { sftp: s } = assertConnected();
    return fn(s);
  }

  /** 一次连接尝试的取消令牌：每个 await 之后都能判断「这次还算不算数」。 */
  function createAbortToken() {
    let aborted = false;
    let rejectOnce = null;
    const promise = new Promise((_, reject) => {
      rejectOnce = reject;
    });
    promise.catch(() => {}); // 没人 race 它时不留 unhandled rejection
    return {
      get aborted() {
        return aborted;
      },
      ensure() {
        if (aborted) {
          throw Object.assign(new Error('SSH 连接已取消'), { code: 'SSH_CONNECT_ABORTED' });
        }
      },
      abort(err) {
        if (aborted) return;
        aborted = true;
        rejectOnce(err || Object.assign(new Error('SSH 连接已取消'), { code: 'SSH_CONNECT_ABORTED' }));
      },
      race(p) {
        return Promise.race([p, promise]);
      }
    };
  }

  /**
   * 读私钥文件：显式路径 + config 里的 IdentityFile，按顺序全读进来。
   * 多把钥匙 = 多条 publickey 尝试（OpenSSH 行为），而不是只试第一把。
   */
  function readPrivateKeys(spec) {
    const paths = [];
    const push = (p) => {
      const v = String(p || '').trim();
      if (v && !paths.includes(v)) paths.push(v);
    };
    push(spec.privateKeyPath);
    for (const f of spec.identityFiles || []) push(f);
    const keys = [];
    let lastErr = null;
    for (const p of paths) {
      try {
        keys.push({ key: fs.readFileSync(p), passphrase: spec.passphrase || undefined, path: p });
      } catch (e) {
        lastErr = e;
      }
    }
    return { keys, lastErr, paths };
  }

  /** 服务器问了密码答不了的问题（验证码/多问）时，把真实原因带出来。 */
  function withAuthHint(err, state) {
    const prompts = (state && state.unanswerablePrompts) || [];
    const isAuthFailure = /authentication/i.test(String((err && err.message) || ''));
    if (!prompts.length || !isAuthFailure) return err;
    return Object.assign(
      new Error(
        `服务器要求交互式认证（${prompts.join(' / ')}）。本客户端无法代答验证码或多次提问，` +
          '请改用 ssh-agent 或公钥免密登录。'
      ),
      { code: 'SSH_NEEDS_INTERACTIVE_PROMPT', prompts, cause: err }
    );
  }

  function openSftp(conn) {
    return new Promise((resolve, reject) => {
      conn.sftp((err, wrapper) => (err ? reject(err) : resolve(wrapper)));
    });
  }

  /**
   * 建一条 SSH 连接（单跳）。`sock` 非空时走它做传输（= 跳板链的下一跳）。
   * @param {{host:string, hostname:string, port:number, username:string, authType:string, password?:string, privateKeyPath?:string, passphrase?:string, identityFiles?:string[], agentSocket?:string}} spec
   * @param {import('stream').Duplex | null} sock
   * @param {boolean} acceptNewHostKey
   */
  function connectOne(spec, sock, acceptNewHostKey) {
    const methods = Array.isArray(spec.methods) && spec.methods.length ? spec.methods : [spec.authType];
    const allowAgent = methods.includes('agent');
    const allowKey = methods.includes('key');
    const allowPassword = methods.includes('password');

    const keyRes = allowKey ? readPrivateKeys(spec) : { keys: [], lastErr: null, paths: [] };
    if (allowKey && !keyRes.keys.length) {
      const detail = keyRes.paths.length
        ? (keyRes.lastErr && keyRes.lastErr.message) || '无法读取'
        : '未指定私钥文件';
      return Promise.reject(
        Object.assign(new Error(`无法读取私钥文件（${spec.hostname}）：${detail}`), { code: 'INVALID_SSH' })
      );
    }
    const agentSocket = allowAgent ? String(spec.agentSocket || detectAgentSocket() || '') : '';
    if (allowAgent && !agentSocket) {
      return Promise.reject(
        Object.assign(
          new Error(
            '未检测到 ssh-agent（SSH_AUTH_SOCK / Windows OpenSSH 命名管道）。' +
              '请先启动 ssh-agent 并 ssh-add，或改用私钥 / 密码登录。'
          ),
          { code: 'SSH_AGENT_UNAVAILABLE' }
        )
      );
    }
    const plan = buildAuthPlan({
      agentSocket,
      privateKeys: keyRes.keys,
      password: allowPassword && spec.password ? String(spec.password) : ''
    });
    if (!plan.length) {
      return Promise.reject(
        Object.assign(new Error('没有可用的认证方式：agent / 私钥 / 密码 都为空'), {
          code: 'SSH_NO_AUTH_METHOD'
        })
      );
    }
    const state = createAuthState();

    return new Promise((resolve, reject) => {
      const conn = new Client();
      pendingConns.add(conn);
      let settled = false;
      /** @type {Error | null} */
      let verifyError = null;
      const settle = (fn, value) => {
        if (settled) return;
        settled = true;
        pendingConns.delete(conn);
        fn(value);
      };
      const fail = (err) => {
        settle(reject, normalizeConnectError(withAuthHint(verifyError || err, state)));
        verifyError = null;
        setImmediate(() => destroyConn(conn));
      };

      conn.on('close', () => {
        if (!settled) {
          fail(Object.assign(new Error('SSH 连接已关闭'), { code: 'SSH_CONNECT_CLOSED' }));
        }
      });
      conn.on('error', fail);
      conn.once('ready', () => settle(resolve, conn));

      /** @type {import('ssh2').ConnectConfig} */
      const connectOpts = {
        host: spec.hostname,
        port: spec.port,
        username: spec.username,
        readyTimeout: 20000,
        keepaliveInterval: 10000,
        keepaliveCountMax: 3,
        hostVerifier: (fingerprint) => {
          try {
            // known_hosts 按**实际地址**记账（别名只是入口），换别名不该重新信任一次
            verifyHost(spec.hostname, spec.port, fingerprint, { acceptNewHostKey });
            return true;
          } catch (e) {
            verifyError = e;
            return false;
          }
        },
        authHandler: createOrderedAuthHandler({ username: spec.username, plan, state })
      };
      if (sock) connectOpts.sock = sock;
      try {
        conn.connect(connectOpts);
      } catch (e) {
        fail(e);
      }
    });
  }

  /** 跳板每一跳的连接参数：私钥来自该跳在 config 里的 IdentityFile，否则靠 agent。 */
  function hopSpec(hop, agentSocket) {
    const hasKey = !!String(hop.privateKeyPath || '').trim() || !!(hop.identityFiles || []).length;
    const methods = [];
    if (agentSocket) methods.push('agent');
    if (hasKey) methods.push('key');
    return {
      host: hop.host,
      hostname: String(hop.hostname || hop.host),
      port: Number(hop.port) || 22,
      username: String(hop.username || ''),
      authType: methods[0] || 'none',
      methods,
      password: '',
      privateKeyPath: String(hop.privateKeyPath || ''),
      passphrase: String(hop.passphrase || ''),
      identityFiles: Array.isArray(hop.identityFiles) ? hop.identityFiles : [],
      agentSocket
    };
  }

  function connect(payload) {
    const p = payload || {};
    const displayHost = String(p.host || '').trim();
    const hostname = String(p.hostname || p.host || '').trim();
    const username = String(p.username || '').trim();
    const port = Number(p.port) || 22;
    if (!hostname || !username) {
      return Promise.reject(Object.assign(new Error('主机与用户名必填'), { code: 'INVALID_SSH' }));
    }
    const authType =
      p.authType === 'key' || p.authType === 'agent' || p.authType === 'password' ? p.authType : 'password';
    // 有候选链就按链走（connect-payload 的产物）；老调用方只有 authType，就退化成一个方法的链
    const methods = Array.isArray(p.methods) && p.methods.length ? p.methods.slice() : [authType];
    const acceptNewHostKey = p.acceptNewHostKey === true;
    const targetSpec = {
      host: displayHost || hostname,
      hostname,
      port,
      username,
      authType,
      methods,
      password: p.password ? String(p.password) : '',
      privateKeyPath: String(p.privateKeyPath || ''),
      passphrase: p.passphrase ? String(p.passphrase) : '',
      identityFiles: Array.isArray(p.identityFiles) ? p.identityFiles : [],
      agentSocket: String(p.agentSocket || '')
    };
    const hops = Array.isArray(p.jumps) ? p.jumps : [];

    /**
     * 同一个连接意图的并发调用只跑一次。
     *
     * `connect()` 第一件事是 `disconnect()`：两路并发（例如工作区激活与自动重连同时到）
     * 会互相把对方刚建好的连接拆掉，先完成的那路留下一条没人认领的孤儿连接。
     * 意图**不同**时才作废旧的那次 —— 那是用户真的换了目标。
     */
    const intentKey = [
      username,
      hostname,
      port,
      authType,
      methods.join(','),
      targetSpec.privateKeyPath,
      targetSpec.identityFiles.join(','),
      hops.map((h) => `${h.hostname || h.host}:${h.port || 22}`).join('>')
    ].join('|');
    if (connectInFlight && connectInFlight.key === intentKey) return connectInFlight.promise;

    const token = createAbortToken();
    if (connectInFlight) {
      // 换了目标：让上一次自己收尾，别让它回来把新连接顶掉
      try {
        connectInFlight.abort();
      } catch {
        // ignore
      }
    }

    const promise = disconnect().then(() => {
      const run = async () => {
        let chain = null;
        /** 已建好但还没交给 `client` 的连接：中途失败必须由这里销毁，否则谁都不认领它 */
        let unclaimedConn = null;
        try {
          let sock = null;
          if (hops.length) {
            chain = await token.race(
              createJumpChain({
                hops: hops.map((h) => hopSpec(h, targetSpec.agentSocket)),
                connectHop: (hop, hopSock) => {
                  if (hop.authType === 'none') {
                    throw Object.assign(
                      new Error(
                        `跳板机 ${hop.hostname} 没有可用认证：请在 ~/.ssh/config 为它配置 IdentityFile，` +
                          '或先启动 ssh-agent（不支持用密码登录跳板机）'
                      ),
                      { code: 'SSH_JUMP_NO_AUTH' }
                    );
                  }
                  return connectOne(hop, hopSock, acceptNewHostKey);
                },
                log
              })
            );
            token.ensure();
            jumpChain = chain;
            sock = await token.race(forwardSocket(chain.lastClient, hostname, port));
            token.ensure();
          }

          const conn = await token.race(connectOne(targetSpec, sock, acceptNewHostKey));
          unclaimedConn = conn;
          token.ensure();
          const sftpWrapper = await token.race(openSftp(conn));
          token.ensure();

          client = conn;
          unclaimedConn = null;
          sftp = sftpWrapper;
          identity = {
            host: targetSpec.host,
            hostname,
            port,
            username,
            authType,
            viaJump: hops.map((h) => String(h.hostname || h.host))
          };
          conn.on('close', () => {
            if (client !== conn) return;
            client = null;
            sftp = null;
            identity = null;
            const dead = jumpChain;
            jumpChain = null;
            if (dead) dead.dispose();
            try {
              if (typeof opts.onClose === 'function') opts.onClose();
            } catch {
              // ignore
            }
          });
          // 预探测远程 HOME（不阻塞连接返回）：兜底根 <HOME>/.dieyun/workspace
          // 需要它才能进白名单，探测失败的第一次调用会退化为仅工作空间根。
          void primeHomeDir();
          return { ok: true, ...status() };
        } catch (e) {
          // 这次尝试失败/被取消：只收自己建立的那份，别影响别人
          if (unclaimedConn) {
            // connectOne 一 ready 就把它从 pendingConns 里摘了，此时它既不是 `client`
            // 也不在 pendingConns —— 不在这里销毁就没人能关掉它（keepalive 会一直发）
            await gracefulCloseConn(unclaimedConn);
          }
          if (chain) {
            if (jumpChain === chain) jumpChain = null;
            chain.dispose();
          }
          throw e;
        }
      };

      return run().finally(() => {
        abortConnect = null;
      });
    });

    const record = { key: intentKey, promise, abort: () => token.abort() };
    connectInFlight = record;
    // 必须在 disconnect() 之后挂：disconnect 的同步段会摘走并 abort 当前的 abortConnect
    // （那是上一次尝试的作废钩子），提前挂会被它当成旧的立刻取消掉。
    abortConnect = (err) => token.abort(err);
    const clearInFlight = () => {
      if (connectInFlight === record) connectInFlight = null;
    };
    promise.then(clearInFlight, clearInFlight);
    return promise;
  }

  function sftpReaddir(remotePath) {
    return withSftp(
      (s) =>
        new Promise((resolve, reject) => {
          s.readdir(remotePath, (err, list) => {
            if (err) reject(err);
            else resolve(list || []);
          });
        })
    );
  }

  async function browse(remotePath) {
    assertConnected();
    const dir = normalizeRemotePath(remotePath || '/');
    try {
      const list = await sftpReaddir(dir);
      return { ok: true, path: dir, entries: mapSftpDirEntries(list) };
    } catch (err) {
      throw formatSftpBrowseError(err, dir);
    }
  }

  function sftpRealpath(remotePath) {
    return withSftp(
      (s) =>
        new Promise((resolve, reject) => {
          s.realpath(remotePath || '.', (err, abs) => {
            if (err) reject(err);
            else resolve(abs || '');
          });
        })
    );
  }

  async function resolveHomeDir() {
    assertConnected();
    try {
      const abs = String((await sftpRealpath('.')) || '').trim();
      if (abs) return normalizeRemotePath(abs);
    } catch {
      // some servers reject realpath('.')
    }
    try {
      const r = await exec('echo $HOME', null, 5000, { loginShell: false });
      const home = String(r.stdout || '').trim();
      if (home) return normalizeRemotePath(home);
    } catch {
      // ignore
    }
    return '/';
  }

  /** 身份快照：探测期间可能断线/换主机，回来时用它确认结果仍属于当前连接。 */
  function identityKey() {
    return identity ? `${identity.host}:${identity.port}:${identity.username}` : '';
  }

  /**
   * 连接建立后一次性探测远程 HOME 并缓存，供**同步**的路径白名单使用
   * （见 remote-path.remoteAllowedRoots / gateway/remote-fs）。失败静默：拿不到就
   * 退化为「仅工作空间根」，不影响其它功能。
   */
  function primeHomeDir() {
    if (cachedHomeDir) return Promise.resolve(cachedHomeDir);
    if (homePrimePromise) return homePrimePromise;
    const snapshot = identityKey();
    homePrimePromise = resolveHomeDir()
      .then((home) => {
        if (snapshot && snapshot === identityKey() && home && home !== '/') {
          cachedHomeDir = home;
        }
        return cachedHomeDir;
      })
      .catch(() => cachedHomeDir)
      .finally(() => {
        homePrimePromise = null;
      });
    return homePrimePromise;
  }

  /** 同步读缓存（未探测到返回 ''，调用方退化为仅工作空间根）。 */
  function getHomeDir() {
    return cachedHomeDir;
  }

  function sftpReadFile(remotePath, maxBytes, offset = 0) {
    const start = Math.max(0, Number(offset) || 0);
    const limit = Math.max(1, Number(maxBytes) || 512 * 1024);
    return withSftp((s) => {
      // 精确切到 limit 字节并立刻停流（read-limited 里有注释说明为什么不能「累加后整块丢」）
      const stream = s.createReadStream(remotePath, start > 0 ? { start } : undefined);
      return readLimitedFromStream(stream, limit).then(({ buf, read, truncated }) => ({
        buf,
        truncated,
        size: start + read
      }));
    });
  }

  function sftpWriteFile(remotePath, buf) {
    return withSftp(
      (s) =>
        new Promise((resolve, reject) => {
          const stream = s.createWriteStream(remotePath);
          stream.on('error', reject);
          stream.on('close', () => resolve());
          stream.end(buf);
        })
    );
  }

  function sftpRename(remotePath, newRemotePath) {
    return withSftp(
      (s) =>
        new Promise((resolve, reject) => {
          s.rename(remotePath, newRemotePath, (err) => {
            if (err) reject(err);
            else resolve();
          });
        })
    );
  }

  function sftpUnlink(remotePath) {
    return withSftp(
      (s) =>
        new Promise((resolve, reject) => {
          s.unlink(remotePath, (err) => {
            if (err) reject(err);
            else resolve();
          });
        })
    );
  }

  function sftpMkdirp(remotePath) {
    const parts = normalizeRemotePath(remotePath).split('/').filter(Boolean);
    let cur = '';
    const step = (i) => {
      if (i >= parts.length) return Promise.resolve();
      cur += `/${parts[i]}`;
      return withSftp(
        (s) =>
          new Promise((resolve, reject) => {
            s.mkdir(cur, (err) => {
              if (err && err.code !== 4) reject(err);
              else resolve();
            });
          })
      ).then(() => step(i + 1));
    };
    return step(0);
  }

  function sftpStat(remotePath) {
    return withSftp(
      (s) =>
        new Promise((resolve, reject) => {
          s.stat(remotePath, (err, st) => {
            if (err) reject(err);
            else resolve(st);
          });
        })
    );
  }

  function wrapLoginShell(command, cwdSafe) {
    const inner = cwdSafe
      ? `cd ${shellQuoteSingle(cwdSafe)} && ${command}`
      : command;
    return `bash -lc ${shellQuoteSingle(inner)}`;
  }

  function wrapBashScript(command, cwdSafe) {
    const inner = cwdSafe ? `cd ${shellQuoteSingle(cwdSafe)} && ${command}` : command;
    const b64 = Buffer.from(inner, 'utf8').toString('base64');
    return `bash -c 'echo ${b64} | base64 -d | bash'`;
  }

  function isChannelOpenError(err) {
    const msg = String((err && err.message) || err || '');
    return /Channel open failure/i.test(msg);
  }

  /** Serialize exec channels — concurrent c.exec races cause "Channel open failure" on some sshd. */
  let execChain = Promise.resolve();

  function execRawOnce(wrapped, timeoutMs, opts = {}) {
    const { client: c } = assertConnected();
    const timeout = clampExecTimeoutMs(timeoutMs);
    return new Promise((resolve, reject) => {
      let settled = false;
      let activeStream = null;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try {
          if (activeStream) activeStream.close();
        } catch {
          // ignore
        }
        reject(
          Object.assign(new Error(`远程命令超时（${timeout}ms）`), {
            // 不声明 code 会塌成 EXCEPTION：远程占全部调用的 84%，超时是最常见的失败，
            // 模型必须能区分「超时」和「命令本身报错」，否则只能盲目重试。
            code: 'SSH_EXEC_TIMEOUT',
            retryable: false,
            suggestedFix:
              `远程命令超过 ${timeout}ms 仍未结束（不是「没启动」：整条命令链还在前台跑，` +
              '常见于命令自己没退出、或父进程在等子进程）。要后台常驻请用 detached=true；' +
              '要长输出请缩小范围（head -n / tail -n / -m 条数）。不要在同一条命令上重复重试。'
          })
        );
      }, timeout);
      c.exec(wrapped, (err, stream) => {
        // 超时（或已被取消）之后 ssh2 仍可能把 channel 交回来：那条命令**已经在远端跑起来了**，
        // 这里既不挂监听也不留 channel —— 否则「已经报给模型失败」的命令还在后台往内存里堆输出。
        if (settled) {
          try {
            if (stream) stream.close();
          } catch {
            // ignore
          }
          return;
        }
        if (err) {
          settled = true;
          clearTimeout(timer);
          reject(err);
          return;
        }
        activeStream = stream;
        // 管道上传（sftp 子系统被禁的降级路径）：命令已就绪，把本地流灌进远端 stdin。
        // stream.end() 由 attachExecSettlement 在收尾时触发（stdin 写完先 end）。
        if (opts.stdin && typeof opts.stdin.pipe === 'function') {
          opts.stdin.pipe(stream);
        }
        // 何时算结束只看 exec-settlement（channel close 会被后台进程继承的输出管道拖住）
        attachExecSettlement(
          { out: stream, err: stream.stderr, life: stream },
          {
            accumulate: true,
            maxChars: EXEC_OUTPUT_MAX_CHARS,
            // 后台进程仍握着管道 → 关掉 channel，别让它在内存里继续堆输出。
            // 实测 sshd 不会因为非 PTY 会话的 channel close 去杀后台进程。
            onSettle: (settledBy) => {
              if (settledBy !== 'exit') return;
              try {
                stream.close();
              } catch {
                // ignore
              }
            }
          }
        ).then(
          (r) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (r.settledBy === 'exit') {
              log('ssh exec: 已按 exit-status 收尾（后台进程仍持有输出管道，未等 channel close）');
            }
            if (r.code == null) {
              // 「没收到 exit-status」和「退出码是 0」是两件事。以前这里把 null 补成 0，
              // 于是一条连接断在命令中途的命令会带着半截输出被当成成功 —— 上层看到空
              // stdout 就报「工作区干净 / 没有匹配」。宁可报「不知道」，也不能假装知道。
              reject(
                Object.assign(new Error('远程命令通道已关闭，但没有收到 exit-status（无法判断是否执行成功）'), {
                  code: 'SSH_EXEC_UNKNOWN_STATUS',
                  settledBy: r.settledBy,
                  stdout: r.stdout,
                  stderr: r.stderr,
                  truncated: r.truncated === true,
                  droppedChars: r.droppedChars,
                  // 写操作可能已经生效，盲目重跑比不跑更危险
                  retryable: false,
                  suggestedFix:
                    '结果未知，不代表没执行：先去远端确认实际状态（文件在不在 / 进程跑没跑 / 输出有没有副作用），' +
                    '再决定是否需要重跑。'
                })
              );
              return;
            }
            resolve({
              code: r.code,
              settledBy: r.settledBy,
              stdout: r.stdout,
              stderr: r.stderr,
              truncated: r.truncated === true,
              droppedChars: r.droppedChars
            });
          },
          (e) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            reject(e);
          }
        );
      });
    });
  }

  async function execRaw(wrapped, timeoutMs, opts = {}) {
    const run = async () => {
      const attempts = opts.stdin ? 1 : 4;
      let lastErr = null;
      for (let i = 0; i < attempts; i++) {
        try {
          return await execRawOnce(wrapped, timeoutMs, opts);
        } catch (err) {
          lastErr = err;
          if (!isChannelOpenError(err) || i >= attempts - 1) throw err;
          await new Promise((res) => setTimeout(res, 250 * (i + 1)));
        }
      }
      throw lastErr;
    };
    const next = execChain.then(run, run);
    execChain = next.catch(() => {});
    return next;
  }

  /**
   * @param {string} command
   * @param {string | null} cwd
   * @param {number} [timeoutMs]
   * @param {{ loginShell?: boolean, bashScript?: boolean }} [opts]
   */
  async function exec(command, cwd, timeoutMs, opts = {}) {
    const cwdSafe = cwd ? normalizeRemotePath(cwd) : null;
    let wrapped;
    if (opts.bashScript) {
      wrapped = wrapBashScript(command, cwdSafe);
    } else if (opts.loginShell === false) {
      wrapped = cwdSafe ? `cd ${shellQuoteSingle(cwdSafe)} && ${command}` : command;
    } else {
      wrapped = wrapLoginShell(command, cwdSafe);
    }
    return execRaw(wrapped, timeoutMs);
  }

  /** 远程复合 shell 脚本（避免 bash -lc 嵌套引号问题） */
  async function execScript(command, timeoutMs) {
    return exec(command, null, timeoutMs, { bashScript: true });
  }

  /**
   * 把本地流灌进远端命令的 stdin（sftp 被禁时的管道上传降级路径，唯一实现）。
   * 命令必须形如 `cat > <path>`；结束以远端 exit-status 为准。
   * 只跑一次不重试：上传中途重试会在远端留下半截文件，必须由调用方整包重来。
   * @param {string} command
   * @param {import('stream').Readable} stdin
   * @param {number} timeoutMs
   */
  async function execStdin(command, stdin, timeoutMs) {
    return execRaw(command, timeoutMs, { stdin });
  }

  function openShell(opts = {}) {
    const { client: c } = assertConnected();
    const cwdSafe = opts.cwd ? normalizeRemotePath(opts.cwd) : null;
    const onData = typeof opts.onData === 'function' ? opts.onData : () => {};
    const onExit = typeof opts.onExit === 'function' ? opts.onExit : () => {};
    const cols = Number(opts.cols) || 120;
    const rows = Number(opts.rows) || 30;
    const term = opts.term || 'xterm-color';
    const launch = cwdSafe
      ? `bash -lc ${shellQuoteSingle(`cd ${shellQuoteSingle(cwdSafe)} && exec bash -l`)}`
      : 'bash -l';
    return new Promise((resolve, reject) => {
      c.exec(
        launch,
        { pty: { rows, cols, term } },
        (err, stream) => {
          if (err) {
            reject(err);
            return;
          }
          let exited = false;
          // 远端 shell 输出是 UTF-8；按块 toString() 会把被数据块切开的汉字解成 U+FFFD，
          // 所以用带 stream 的解码器跨块续接（ssh2 给的是 Buffer）
          const decodeUtf8Stream = () => {
            const decoder = new TextDecoder('utf-8');
            return (chunk) => (typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true }));
          };
          const decodeOut = decodeUtf8Stream();
          stream.on('data', (d) => onData(decodeOut(d)));
          if (stream.stderr) {
            const decodeErr = decodeUtf8Stream();
            stream.stderr.on('data', (d) => onData(decodeErr(d)));
          }
          stream.on('close', (code) => {
            if (exited) return;
            exited = true;
            onExit(code ?? null);
          });
          resolve({
            write: (data) => {
              try {
                stream.write(String(data || ''));
              } catch {
                // ignore
              }
            },
            kill: () => {
              try {
                stream.close();
              } catch {
                // ignore
              }
            },
            shell: 'bash -l',
            cwd: cwdSafe || '/',
            remote: true
          });
        }
      );
    });
  }

  function getClient() {
    return assertConnected().client;
  }

  function getSftp() {
    return assertConnected().sftp;
  }

  return {
    connect,
    disconnect,
    status,
    browse,
    resolveHomeDir,
    primeHomeDir,
    getHomeDir,
    sftpReaddir,
    sftpReadFile,
    sftpWriteFile,
    sftpRename,
    sftpUnlink,
    sftpMkdirp,
    sftpStat,
    exec,
    execScript,
    execStdin,
    openShell,
    assertConnected,
    getClient,
    getSftp
  };
}

module.exports = {
  createSshSessionManager,
  sftpEntryIsDirectory
};
