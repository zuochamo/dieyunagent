'use strict';
/**
 * 「记住登录信息」是连接的副产物：它失败不许把已经建好的连接判成失败。
 *
 * 现场：私钥认证 + 没填 passphrase（passphrase 本来就可选）、系统钥匙串不可用
 * （safeStorage 加密失败）—— 这两种情况下 saveProfile 抛错，用户看到的是
 * 「连接失败」，实际 SSH 已经连上了。
 */
const assert = require('node:assert/strict');

const { registerWorkspaceRemoteIpc } = require('../../src/main/ipc/workspace-remote');

/** 只注册 ssh:connect 需要的依赖，其余用不到的就不给 */
function makeCtx({ connect, saveProfile, clearProfile }) {
  const handlers = new Map();
  const warnings = [];
  const ipcMain = { handle: (name, fn) => handlers.set(name, fn) };
  registerWorkspaceRemoteIpc({
    ipcMain,
    getSshSessionManager: () => ({ connect }),
    getSshCredentialsStore: () => ({ saveProfile, clearProfile }),
    resolveSshConnectSessionStatus: (p, result) => ({ connected: result && result.ok !== false })
  });
  return { handlers, warnings };
}

const CONNECT_OK = async () => ({ ok: true, connected: true });

describe('ssh:connect 的凭据保存必须 best-effort', () => {
  let consoleWarn;
  beforeEach(() => {
    consoleWarn = console.warn;
    console.warn = () => {};
  });
  afterEach(() => {
    console.warn = consoleWarn;
  });

  it('saveProfile 抛错时连接仍然成功，并把警告带回去', async () => {
    const { handlers } = makeCtx({
      connect: CONNECT_OK,
      saveProfile: () => {
        throw new Error('safeStorage 不可用');
      },
      clearProfile: () => {}
    });
    const res = await handlers.get('ssh:connect')(null, {
      host: 'h',
      port: 22,
      username: 'u',
      password: 'p',
      remember: true
    });
    assert.equal(res.connected, true, 'SSH 已连上，不许因为存密码失败就报失败');
    assert.equal(res.credentialsWarning, 'safeStorage 不可用');
  });

  it('clearProfile 抛错时也不许破坏连接结果', async () => {
    const { handlers } = makeCtx({
      connect: CONNECT_OK,
      saveProfile: () => {},
      clearProfile: () => {
        throw new Error('磁盘满');
      }
    });
    const res = await handlers.get('ssh:connect')(null, {
      host: 'h',
      port: 22,
      username: 'u',
      password: 'p',
      remember: false
    });
    assert.equal(res.connected, true);
    assert.equal(res.credentialsWarning, '磁盘满');
  });

  it('正常保存时没有警告', async () => {
    let saved = null;
    const { handlers } = makeCtx({
      connect: CONNECT_OK,
      saveProfile: (p) => {
        saved = p;
      },
      clearProfile: () => {}
    });
    const res = await handlers.get('ssh:connect')(null, {
      host: 'h',
      port: 22,
      username: 'u',
      password: 'p',
      remember: true
    });
    assert.equal(res.connected, true);
    assert.equal(res.credentialsWarning, '');
    assert.equal(saved && saved.host, 'h');
  });

  it('连接本身失败时照旧抛出（不许被降级掩盖）', async () => {
    const { handlers } = makeCtx({
      connect: async () => {
        throw new Error('认证失败');
      },
      saveProfile: () => {},
      clearProfile: () => {}
    });
    await assert.rejects(
      () => handlers.get('ssh:connect')(null, { host: 'h', username: 'u', password: 'p' }),
      /认证失败/
    );
  });
});
