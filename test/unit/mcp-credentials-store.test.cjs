'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { createMcpCredentialsStore } = require('../../src/mcp/credentials-store');
const { isMcpServerConfigured } = require('../../src/mcp/server-config');

/**
 * 假 safeStorage：用 'ENC:' 前缀区分「本进程写出的密文」。
 * decryptString 对非本进程密文抛错 —— 复现"换了 userData/profile 后密钥不一致"的场景。
 */
function fakeSafeStorage({ keyId }) {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (text) => Buffer.from(`ENC:${keyId}:${text}`, 'utf8'),
    decryptString: (buf) => {
      const raw = buf.toString('utf8');
      if (!raw.startsWith(`ENC:${keyId}:`)) {
        throw new Error('Error while decrypting the ciphertext provided to safeStorage.decryptString.');
      }
      return raw.slice(`ENC:${keyId}:`.length);
    }
  };
}

function tempUserData() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dieyun-secrets-test-'));
}

describe('mcp credentials store', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('可解密的凭据才算已配置', () => {
    const userDataPath = tempUserData();
    const store = createMcpCredentialsStore({
      safeStorage: fakeSafeStorage({ keyId: 'A' }),
      userDataPath
    });
    store.saveSecrets('mcp-postgres', { env: { DATABASE_URL: 'postgresql://u@h/db' } });

    const meta = store.getSecretMeta('mcp-postgres');
    expect(meta.envKeys).toEqual(['DATABASE_URL']);
    expect(meta.hasEnv).toBe(true);
    expect(meta.undecryptable).toEqual([]);
    expect(store.loadSecrets('mcp-postgres').env.DATABASE_URL).toBe('postgresql://u@h/db');

    expect(
      isMcpServerConfigured(
        { id: 'mcp-postgres', command: 'npx', envHint: 'DATABASE_URL' },
        { getSecretMeta: (id) => store.getSecretMeta(id) }
      )
    ).toBe(true);
  });

  it('密文解不开时不得表现为已配置，并报出 undecryptable', () => {
    const userDataPath = tempUserData();
    const writer = createMcpCredentialsStore({
      safeStorage: fakeSafeStorage({ keyId: 'A' }),
      userDataPath
    });
    writer.saveSecrets('mcp-postgres', { env: { DATABASE_URL: 'postgresql://u@h/db' } });

    // 换密钥后读：写入时用的密钥已不可用（真实事故：密文与 safeStorage 密钥不匹配）
    const reader = createMcpCredentialsStore({
      safeStorage: fakeSafeStorage({ keyId: 'B' }),
      userDataPath
    });
    const meta = reader.getSecretMeta('mcp-postgres');
    expect(meta.envKeys).toEqual([]);
    expect(meta.hasEnv).toBe(false);
    expect(meta.undecryptable).toEqual(['DATABASE_URL']);
    expect(reader.loadSecrets('mcp-postgres').env).toEqual({});

    const server = { id: 'mcp-postgres', command: 'npx', envHint: 'DATABASE_URL' };
    const deps = { getSecretMeta: (id) => reader.getSecretMeta(id) };
    expect(isMcpServerConfigured(server, deps)).toBe(false);
    expect(console.warn).toHaveBeenCalled();
  });

  it('远程服务的 token 同理：解不开就不算已配置', () => {
    const userDataPath = tempUserData();
    const writer = createMcpCredentialsStore({
      safeStorage: fakeSafeStorage({ keyId: 'A' }),
      userDataPath
    });
    writer.saveSecrets('mcp-remote', { token: 'sk-secret' });

    const reader = createMcpCredentialsStore({
      safeStorage: fakeSafeStorage({ keyId: 'B' }),
      userDataPath
    });
    const meta = reader.getSecretMeta('mcp-remote');
    expect(meta.hasToken).toBe(false);
    expect(meta.undecryptable).toEqual(['token']);

    const server = { id: 'mcp-remote', remoteUrl: 'https://example.com/mcp', authRequired: true };
    expect(isMcpServerConfigured(server, { getSecretMeta: (id) => reader.getSecretMeta(id) })).toBe(
      false
    );
  });
});
