'use strict';

/**
 * 凭据库的两件事：
 *
 *  1. 落盘文件按 0600 收紧（同机其他用户不该看到「谁登录过哪台机器」）；
 *  2. 「用户名留空 + 用已保存凭据」要真能找到自己 —— profile 键含用户名，原来查到的是
 *     空用户名那一格，`saved.username` 永远是 undefined，整条 `if (!username)` 分支是死的。
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createSshCredentialsStore } = require('../../src/ssh/credentials-store');
const { resolveConnectPayload } = require('../../src/ssh/connect-payload');

/** safeStorage 替身：base64「加密」，只为验证读写链路。 */
const fakeSafeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from(String(s), 'utf8'),
  decryptString: (buf) => Buffer.from(buf).toString('utf8')
};

function withStore(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dy-creds-'));
  const store = createSshCredentialsStore({ userDataPath: dir, safeStorage: fakeSafeStorage });
  return Promise.resolve(fn(store, dir)).finally(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });
}

describe('凭据库文件权限', () => {
  it('落盘是 0600（不是 umask 给的 0644）', async () => {
    if (process.platform === 'win32') return; // Windows 的 chmod 语义不同，跳过
    await withStore((store, dir) => {
      store.saveProfile({ host: 'h', port: 22, username: 'u', remember: true, password: 'pw' });
      const mode = fs.statSync(path.join(dir, 'ssh-profiles.json')).mode & 0o777;
      assert.equal(mode, 0o600, `期望 0600，实际 ${mode.toString(8)}`);
    });
  });

  it('历史文件是 0644 时再次写入会被收紧', async () => {
    if (process.platform === 'win32') return;
    await withStore((store, dir) => {
      const file = path.join(dir, 'ssh-profiles.json');
      fs.writeFileSync(file, '{}', { mode: 0o644 });
      try {
        fs.chmodSync(file, 0o644);
      } catch {
        // ignore
      }
      store.saveProfile({ host: 'h', port: 22, username: 'u', remember: true, password: 'pw' });
      assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    });
  });
});

describe('用户名留空时按 host:port 找到已存凭据', () => {
  it('findSavedProfileForHost 返回用户名与密钥', async () => {
    await withStore((store) => {
      store.saveProfile({ host: 'box', port: 22, username: 'alice', remember: true, password: 'p1' });
      const found = store.findSavedProfileForHost('box', 22);
      assert.equal(found.username, 'alice');
      assert.equal(found.password, 'p1');
    });
  });

  it('同一主机多个用户名时取最近保存的那条', async () => {
    await withStore((store) => {
      store.saveProfile({ host: 'box', port: 22, username: 'old', remember: true, password: 'p-old' });
      store.saveProfile({ host: 'box', port: 22, username: 'new', remember: true, password: 'p-new' });
      assert.equal(store.findSavedProfileForHost('box', 22).username, 'new');
    });
  });

  it('端口不同不串用', async () => {
    await withStore((store) => {
      store.saveProfile({ host: 'box', port: 2222, username: 'alice', remember: true, password: 'p' });
      assert.equal(store.findSavedProfileForHost('box', 22), null);
    });
  });

  it('buildConnectPayload：用户名留空 + useSaved → 用户名从已存记录补上', async () => {
    await withStore((store) => {
      store.saveProfile({ host: 'box', port: 22, username: 'alice', remember: true, password: 'p1' });
      const built = resolveConnectPayload(
        { host: 'box', port: 22, useSaved: true },
        { credentialsStore: store, agentSocket: '', sshConfigBlocks: [] }
      );
      assert.equal(built.username, 'alice', '以前这条分支永远拿不到用户名 → 直接 INVALID_SSH');
      assert.equal(built.password, 'p1');
      assert.equal(built.hostname, 'box');
    });
  });
});
