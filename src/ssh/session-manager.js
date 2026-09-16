'use strict';

const fs = require('fs');
const path = require('path');
const { Client } = require('ssh2');
const { normalizeRemotePath } = require('../workspace/target');
const { shellQuoteSingle } = require('./remote-path');

const SFTP_NO_SUCH_FILE = new Set([2, 11, 'ENOENT', 'NO_SUCH_FILE']);
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
  if (SFTP_NO_SUCH_FILE.has(code) || /no such file/i.test(raw)) {
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
  let connecting = null;
  /** @type {{ host: string, port: number, username: string } | null} */
  let identity = null;

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

  /** @type {import('ssh2').Client | null} */
  let pendingConn = null;
  /** @type {((err: Error) => void) | null} */
  let abortConnect = null;
  /** @type {Promise<void> | null} */
  let teardownPromise = null;

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
      const pending = pendingConn;
      const active = client;
      const abort = abortConnect;
      connecting = null;
      abortConnect = null;
      identity = null;
      sftp = null;
      pendingConn = null;
      client = null;

      if (abort) {
        try {
          abort(Object.assign(new Error('SSH 连接已取消'), { code: 'SSH_CONNECT_ABORTED' }));
        } catch {
          // ignore
        }
      }

      if (pending && pending !== active) {
        destroyConn(pending);
      }
      if (active) {
        await gracefulCloseConn(active);
      } else if (pending) {
        destroyConn(pending);
      }
    })().finally(() => {
      teardownPromise = null;
    });
    return teardownPromise;
  }

  function status() {
    return {
      connected: !!(client && sftp && identity),
      host: identity?.host || null,
      port: identity?.port || 22,
      username: identity?.username || null,
      authType: identity?.authType || null
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

  function connect(payload) {
    const h = String(payload?.host || '').trim();
    const u = String(payload?.username || '').trim();
    const p = Number(payload?.port) || 22;
    const authType = payload?.authType === 'key' ? 'key' : 'password';
    if (!h || !u) {
      return Promise.reject(Object.assign(new Error('主机与用户名必填'), { code: 'INVALID_SSH' }));
    }

    let privateKey = null;
    let passphrase = null;
    let password = null;

    if (authType === 'key') {
      const keyPath = String(payload?.privateKeyPath || '').trim();
      if (!keyPath) {
        return Promise.reject(Object.assign(new Error('请选择私钥文件'), { code: 'INVALID_SSH' }));
      }
      try {
        privateKey = fs.readFileSync(keyPath);
      } catch (e) {
        return Promise.reject(
          Object.assign(new Error('无法读取私钥文件：' + (e && e.message)), { code: 'INVALID_SSH' })
        );
      }
      passphrase = payload?.passphrase ? String(payload.passphrase) : undefined;
    } else {
      if (!payload?.password) {
        return Promise.reject(Object.assign(new Error('密码必填'), { code: 'INVALID_SSH' }));
      }
      password = String(payload.password);
    }

    return disconnect().then(() => {
      const conn = new Client();
      pendingConn = conn;
      const connectPromise = new Promise((resolve, reject) => {
        let settled = false;
        /** @type {Error | null} */
        let hostVerifyError = null;
        abortConnect = reject;
        const finish = (fn, value) => {
          if (settled) return;
          settled = true;
          abortConnect = null;
          if (pendingConn === conn) pendingConn = null;
          if (connecting === connectPromise) connecting = null;
          fn(value);
        };
        const fail = (err) => {
          if (settled) return;
          const raw =
            hostVerifyError ||
            (err && err.message === 'Host denied (verification failed)'
              ? Object.assign(new Error('SSH 主机验证失败'), { code: 'SSH_HOST_VERIFY_FAILED' })
              : err);
          hostVerifyError = null;
          finish(reject, normalizeConnectError(raw));
          setImmediate(() => destroyConn(conn));
        };

        conn.on('close', () => {
          if (!settled && pendingConn === conn) {
            fail(Object.assign(new Error('SSH 连接已关闭'), { code: 'SSH_CONNECT_CLOSED' }));
            return;
          }
          if (client === conn) {
            client = null;
            sftp = null;
            identity = null;
            try {
              if (typeof opts.onClose === 'function') opts.onClose();
            } catch {
              // ignore
            }
          }
          if (pendingConn === conn) pendingConn = null;
        });

        conn
          .on('ready', () => {
            if (pendingConn !== conn) {
              destroyConn(conn);
              return;
            }
            conn.sftp((err, sftpWrapper) => {
              if (pendingConn !== conn) {
                destroyConn(conn);
                return;
              }
              if (err) {
                fail(err);
                return;
              }
              client = conn;
              sftp = sftpWrapper;
              pendingConn = null;
              identity = { host: h, port: p, username: u, authType };
              finish(resolve, { ok: true, ...status() });
            });
          })
          .on('error', fail);

        /** @type {import('ssh2').ConnectConfig} */
        const connectOpts = {
          host: h,
          port: p,
          username: u,
          readyTimeout: 20000,
          keepaliveInterval: 10000,
          keepaliveCountMax: 3,
          hostVerifier: (fingerprint) => {
            try {
              verifyHost(h, p, fingerprint, { acceptNewHostKey: payload?.acceptNewHostKey === true });
              return true;
            } catch (e) {
              hostVerifyError = e;
              setImmediate(() => {
                if (!settled) fail(hostVerifyError);
              });
              return false;
            }
          }
        };
        if (authType === 'key') {
          connectOpts.privateKey = privateKey;
          if (passphrase) connectOpts.passphrase = passphrase;
        } else {
          connectOpts.password = password;
        }
        conn.connect(connectOpts);
      });
      connecting = connectPromise;
      return connectPromise;
    });
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

  function sftpReadFile(remotePath, maxBytes, offset = 0) {
    const start = Math.max(0, Number(offset) || 0);
    const limit = Math.max(1, Number(maxBytes) || 512 * 1024);
    return withSftp(
      (s) =>
        new Promise((resolve, reject) => {
          const chunks = [];
          const streamOpts = start > 0 ? { start } : undefined;
          const stream = s.createReadStream(remotePath, streamOpts);
          let read = 0;
          stream.on('data', (c) => {
            read += c.length;
            if (read <= limit) chunks.push(c);
          });
          stream.on('error', reject);
          stream.on('end', () => {
            const buf = Buffer.concat(chunks);
            resolve({ buf, truncated: read > limit, size: start + read });
          });
        })
    );
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

  function execRawOnce(wrapped, timeoutMs) {
    const { client: c } = assertConnected();
    const timeout = Math.min(180000, Math.max(1000, Number(timeoutMs) || 90000));
    return new Promise((resolve, reject) => {
      let settled = false;
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try {
          if (activeStream) activeStream.close();
        } catch {
          // ignore
        }
        reject(new Error(`远程命令超时（${timeout}ms）`));
      }, timeout);
      let activeStream = null;
      c.exec(wrapped, (err, stream) => {
        if (err) {
          clearTimeout(timer);
          reject(err);
          return;
        }
        activeStream = stream;
        stream
          .on('close', (code) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve({ code: code ?? 0, stdout, stderr });
          })
          .on('data', (d) => {
            stdout += d.toString();
          });
        stream.stderr.on('data', (d) => {
          stderr += d.toString();
        });
      });
    });
  }

  async function execRaw(wrapped, timeoutMs) {
    const run = async () => {
      const attempts = 4;
      let lastErr = null;
      for (let i = 0; i < attempts; i++) {
        try {
          return await execRawOnce(wrapped, timeoutMs);
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
          stream.on('data', (d) => onData(d.toString()));
          stream.stderr?.on('data', (d) => onData(d.toString()));
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
    sftpReaddir,
    sftpReadFile,
    sftpWriteFile,
    sftpMkdirp,
    sftpStat,
    exec,
    execScript,
    openShell,
    assertConnected,
    getClient,
    getSftp
  };
}

module.exports = {
  createSshSessionManager,
  sftpEntryIsDirectory,
  mapSftpDirEntries,
  formatSftpBrowseError
};
