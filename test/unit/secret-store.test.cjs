'use strict';

/**
 * `src/secret-store.js`：三份凭据存储（频道 / MCP / SSH）共用的一份实现。
 *
 * 这份单测锁的是**安全与失败语义**，不是某个 store 的字段形状：
 * 1. 加解密不可用时抛 `CREDENTIALS_ENCRYPT_UNAVAILABLE`，绝不回退明文；
 * 2. 靠 log 决定「解密失败」是否吭声（MCP 有自己的一次性告警，频道要进日志）；
 * 3. 坏文件按调用方的 `onCorrupt` 决定当空还是抛（频道「静默当空」等于下一次保存
 *    把用户所有配置覆盖掉，必须是抛）；
 * 4. 落盘一律 0600 + 原子写（MCP 此前是 umask 默认权限，是这次收敛修掉的真实缺陷）。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  createSecretStore,
  ENCRYPT_UNAVAILABLE_CODE,
  CORRUPT_CODE: SECRET_STORE_CORRUPT
} = require('../../src/secret-store');

function fakeSafeStorage(available = true) {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (s) => Buffer.from(`enc:${s}`, 'utf8'),
    decryptString: (buf) => {
      const t = buf.toString('utf8');
      if (!t.startsWith('enc:')) throw new Error('bad ciphertext');
      return t.slice(4);
    }
  };
}

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dieyun-secret-'));
}

describe('secret-store', () => {
  test('没有 safeStorage / 不可用 → canEncrypt false，且加密时抛 CREDENTIALS_ENCRYPT_UNAVAILABLE', () => {
    const dir = tmpDir();
    const box = createSecretStore({ userDataPath: dir, fileName: 'x.json' });
    expect(box.canEncrypt()).toBe(false);
    let err = null;
    try {
      box.encryptSecret('secret');
    } catch (e) {
      err = e;
    }
    expect(err && err.code).toBe(ENCRYPT_UNAVAILABLE_CODE);

    const off = createSecretStore({
      userDataPath: dir,
      fileName: 'x.json',
      safeStorage: fakeSafeStorage(false)
    });
    expect(off.canEncrypt()).toBe(false);
  });

  test('加密不可用时的报错文案可由调用方定制（三个 store 各自的说法不变）', () => {
    const box = createSecretStore({
      userDataPath: tmpDir(),
      fileName: 'x.json',
      encryptUnavailableMessage: '当前系统无法加密存储 MCP 凭据'
    });
    expect(() => box.encryptSecret('secret')).toThrow('当前系统无法加密存储 MCP 凭据');
  });

  test('空串不加密（存空 = 清除，不该落一条密文）', () => {
    const box = createSecretStore({
      userDataPath: tmpDir(),
      fileName: 'x.json',
      safeStorage: fakeSafeStorage()
    });
    expect(box.encryptSecret('')).toBe('');
  });

  test('加解密往返；密文解不开返回空串且只在给了 log 时吭声', () => {
    const logs = [];
    const box = createSecretStore({
      userDataPath: tmpDir(),
      fileName: 'x.json',
      safeStorage: fakeSafeStorage(),
      log: (m) => logs.push(m),
      label: 'channels'
    });
    const enc = box.encryptSecret('tok-123');
    expect(enc).not.toBe('tok-123');
    expect(box.decryptSecret(enc)).toBe('tok-123');

    const bogus = Buffer.from('not-encrypted').toString('base64');
    expect(box.decryptSecret(bogus)).toBe('');
    expect(logs.length).toBe(1);
    expect(logs[0]).toContain('[channels]');
    expect(logs[0]).toContain('无法解密');

    // MCP 侧本来就不传 log：解密失败必须静默返回空串（它自己有一次性的 warnUndecryptable）
    const quiet = createSecretStore({
      userDataPath: tmpDir(),
      fileName: 'x.json',
      safeStorage: fakeSafeStorage()
    });
    expect(quiet.decryptSecret(bogus)).toBe('');
  });

  test('文件不存在返回 null（空态），与"解析失败"区分开', () => {
    const box = createSecretStore({ userDataPath: tmpDir(), fileName: 'none.json' });
    expect(box.readJson()).toBe(null);
  });

  test("onCorrupt: 'empty' → 坏文件返回 null", () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'bad.json'), '{ not json', 'utf8');
    const box = createSecretStore({ userDataPath: dir, fileName: 'bad.json', onCorrupt: 'empty' });
    expect(box.readJson()).toBe(null);
  });

  test("onCorrupt: 'throw' → 抛调用方指定的 code（频道配置不许静默当空）", () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'bad.json'), '{ not json', 'utf8');
    const box = createSecretStore({
      userDataPath: dir,
      fileName: 'bad.json',
      onCorrupt: 'throw',
      corruptCode: 'CHANNEL_STORE_CORRUPT'
    });
    let err = null;
    try {
      box.readJson();
    } catch (e) {
      err = e;
    }
    expect(err && err.code).toBe('CHANNEL_STORE_CORRUPT');
    expect(String(err.message)).toContain('解析失败');
  });

  test('写盘：自动建目录、内容可读回、不留临时文件', () => {
    const dir = path.join(tmpDir(), 'nested', 'deeper');
    const box = createSecretStore({ userDataPath: dir, fileName: 'x.json' });
    box.writeJson({ a: { tokenEnc: 'zz' } });
    expect(box.readJson()).toEqual({ a: { tokenEnc: 'zz' } });
    const leftovers = fs.readdirSync(dir).filter((f) => f.includes('.tmp'));
    expect(leftovers).toEqual([]);
  });

  test('写盘是 0600（不是 umask 给的 0644），已存在的 0644 也会被收紧', () => {
    if (process.platform === 'win32') return; // Windows 的 chmod 语义不同
    const dir = tmpDir();
    const box = createSecretStore({ userDataPath: dir, fileName: 'x.json' });
    box.writeJson({ a: 1 });
    expect(fs.statSync(box.filePath).mode & 0o777).toBe(0o600);

    const file = path.join(dir, 'y.json');
    fs.writeFileSync(file, '{}', { mode: 0o644 });
    fs.chmodSync(file, 0o644);
    const box2 = createSecretStore({ userDataPath: dir, fileName: 'y.json' });
    box2.writeJson({ b: 2 });
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  test('MCP 侧从此也是 0600（收敛前 mcp-secrets.json 是 umask 默认）', () => {
    if (process.platform === 'win32') return;
    const { createMcpCredentialsStore } = require('../../src/mcp/credentials-store');
    const dir = tmpDir();
    const store = createMcpCredentialsStore({ userDataPath: dir, safeStorage: fakeSafeStorage() });
    store.saveSecrets('srv-1', { token: 'tok-abc' });
    const mode = fs.statSync(path.join(dir, 'mcp-secrets.json')).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  describe('损坏态：读坏了就拒绝写，只能显式备份重建', () => {
    test('读到坏文件后写入被拒（否则一次保存就把其余条目抹掉）', () => {
      const dir = tmpDir();
      const file = path.join(dir, 'x.json');
      fs.writeFileSync(file, '{ "a": { "tokenEnc": "zz"', 'utf8'); // 半截写入
      const box = createSecretStore({ userDataPath: dir, fileName: 'x.json', onCorrupt: 'empty' });
      expect(box.readJson()).toBe(null);
      expect(box.getHealth()).toMatchObject({ corrupt: true });
      expect(box.getHealth().message).toContain('解析失败');
      let err = null;
      try {
        box.writeJson({ b: {} });
      } catch (e) {
        err = e;
      }
      expect(err && err.code).toBe('SECRET_STORE_CORRUPT');
      expect(String(err.message)).toContain('备份并重建');
      // 原文件一个字节都不许动
      expect(fs.readFileSync(file, 'utf8')).toBe('{ "a": { "tokenEnc": "zz"');
    });

    test('resetCorruptFile 改名备份（不删）并解除损坏态，之后可正常写', () => {
      const dir = tmpDir();
      const box = createSecretStore({ userDataPath: dir, fileName: 'x.json', onCorrupt: 'empty' });
      fs.writeFileSync(box.filePath, 'not json at all', 'utf8');
      expect(box.readJson()).toBe(null);
      const r = box.resetCorruptFile();
      expect(r.moved).toBe(true);
      expect(fs.existsSync(r.backupPath)).toBe(true);
      expect(fs.readFileSync(r.backupPath, 'utf8')).toBe('not json at all');
      expect(box.getHealth().corrupt).toBe(false);
      box.writeJson({ ok: 1 });
      expect(box.readJson()).toEqual({ ok: 1 });
    });

    test('文件不存在时 resetCorruptFile 什么也不做', () => {
      const box = createSecretStore({ userDataPath: tmpDir(), fileName: 'none.json' });
      expect(box.resetCorruptFile()).toEqual({ moved: false, backupPath: '' });
    });
  });

  describe('MCP / SSH：坏文件要能被设置页问出来', () => {
    test('MCP：健康度报告损坏，保存被拒，重建后恢复正常', () => {
      const { createMcpCredentialsStore } = require('../../src/mcp/credentials-store');
      const dir = tmpDir();
      const store = createMcpCredentialsStore({ userDataPath: dir, safeStorage: fakeSafeStorage() });
      store.saveSecrets('srv-1', { token: 'tok-abc' });

      expect(store.readStoreHealth().corrupt).toBe(false);
      fs.writeFileSync(path.join(dir, 'mcp-secrets.json'), '[[[', 'utf8');
      const health = store.readStoreHealth();
      expect(health.corrupt).toBe(true);
      expect(health.filePath).toContain('mcp-secrets.json');

      let err = null;
      try {
        store.saveSecrets('srv-2', { token: 'another' });
      } catch (e) {
        err = e;
      }
      expect(err && err.code).toBe('SECRET_STORE_CORRUPT');

      expect(store.resetStore().moved).toBe(true);
      expect(store.readStoreHealth().corrupt).toBe(false);
      store.saveSecrets('srv-2', { token: 'another' });
      expect(store.loadSecrets('srv-2').token).toBe('another');
    });

    test('SSH：健康度报告损坏，保存被拒，重建后恢复正常', () => {
      const { createSshCredentialsStore } = require('../../src/ssh/credentials-store');
      const dir = tmpDir();
      const store = createSshCredentialsStore({ userDataPath: dir, safeStorage: fakeSafeStorage() });
      store.saveProfile({ host: 'h1', port: 22, username: 'u', password: 'pw', remember: true });
      expect(store.readStoreHealth().corrupt).toBe(false);

      fs.writeFileSync(path.join(dir, 'ssh-profiles.json'), '{oops', 'utf8');
      expect(store.readStoreHealth().corrupt).toBe(true);
      let err = null;
      try {
        store.saveProfile({ host: 'h2', port: 22, username: 'u', password: 'pw', remember: true });
      } catch (e) {
        err = e;
      }
      expect(err && err.code).toBe('SECRET_STORE_CORRUPT');

      expect(store.resetStore().moved).toBe(true);
      store.saveProfile({ host: 'h2', port: 22, username: 'u', password: 'pw2', remember: true });
      expect(store.loadConnectSecrets('h2', 22, 'u').password).toBe('pw2');
    });
  });

  describe('损坏标记落盘：重启后不依赖「先读到坏文件」', () => {
    const FLAG_NAME = 'x.json.corrupt.json';

    test('读到坏文件会落标记，新实例（模拟重启）不必读也能报损坏并拒绝写', () => {
      const dir = tmpDir();
      const first = createSecretStore({ userDataPath: dir, fileName: 'x.json', onCorrupt: 'empty' });
      fs.writeFileSync(first.filePath, '{ "a": ', 'utf8'); // 半截写入
      expect(first.readJson()).toBe(null);
      expect(fs.existsSync(path.join(dir, FLAG_NAME))).toBe(true);

      // 重启：全新实例，一次都没读过业务文件
      const restarted = createSecretStore({ userDataPath: dir, fileName: 'x.json', onCorrupt: 'empty' });
      const health = restarted.getHealth();
      expect(health.corrupt).toBe(true);
      expect(health.message).toContain('解析失败');
      let err = null;
      try {
        restarted.writeJson({ b: {} });
      } catch (e) {
        err = e;
      }
      expect(err && err.code).toBe(SECRET_STORE_CORRUPT);
    });

    test('标记过期（文件被外部修好）：先真读一次，清标记后照常写入', () => {
      const dir = tmpDir();
      fs.writeFileSync(path.join(dir, FLAG_NAME), JSON.stringify({ message: '旧的损坏信息' }), 'utf8');
      fs.writeFileSync(path.join(dir, 'x.json'), JSON.stringify({ a: { tokenEnc: 'ok' } }), 'utf8');

      const box = createSecretStore({ userDataPath: dir, fileName: 'x.json', onCorrupt: 'empty' });
      expect(box.getHealth().corrupt).toBe(true); // 标记还在，先报坏
      // 保存时发现文件其实能解析 → 清标记继续写，不把用户永久锁在「已损坏」里
      expect(() => box.writeJson({ a: { tokenEnc: 'new' } })).not.toThrow();
      expect(box.readJson()).toEqual({ a: { tokenEnc: 'new' } });
      expect(fs.existsSync(path.join(dir, FLAG_NAME))).toBe(false);
      expect(box.getHealth().corrupt).toBe(false);
    });

    test('读到正常文件 / 文件被删掉时，过期标记都会清掉', () => {
      const dir = tmpDir();
      const box = createSecretStore({ userDataPath: dir, fileName: 'x.json', onCorrupt: 'empty' });
      const flag = path.join(dir, FLAG_NAME);

      fs.writeFileSync(box.filePath, '{bad', 'utf8');
      expect(box.readJson()).toBe(null);
      expect(fs.existsSync(flag)).toBe(true);
      fs.writeFileSync(box.filePath, '{"ok":1}', 'utf8');
      expect(box.readJson()).toEqual({ ok: 1 });
      expect(fs.existsSync(flag)).toBe(false);

      // 再来一次，这次是「文件直接没了」
      fs.writeFileSync(box.filePath, '{bad', 'utf8');
      expect(box.readJson()).toBe(null);
      expect(fs.existsSync(flag)).toBe(true);
      fs.unlinkSync(box.filePath);
      expect(box.readJson()).toBe(null);
      expect(fs.existsSync(flag)).toBe(false);
    });

    test('备份重建后标记一并清掉', () => {
      const dir = tmpDir();
      const box = createSecretStore({ userDataPath: dir, fileName: 'x.json', onCorrupt: 'empty' });
      fs.writeFileSync(box.filePath, 'nope', 'utf8');
      box.readJson();
      const flag = path.join(dir, FLAG_NAME);
      expect(fs.existsSync(flag)).toBe(true);
      expect(box.resetCorruptFile().moved).toBe(true);
      expect(fs.existsSync(flag)).toBe(false);
      expect(createSecretStore({ userDataPath: dir, fileName: 'x.json' }).getHealth().corrupt).toBe(false);
    });

    test('标记写不进去只降级（不影响读路径，也不抛）', () => {
      const dir = tmpDir();
      const logs = [];
      const box = createSecretStore({
        userDataPath: dir,
        fileName: 'x.json',
        onCorrupt: 'empty',
        log: (m) => logs.push(m)
      });
      // 把标记路径占成目录：原子写的 rename 一定失败
      fs.mkdirSync(path.join(dir, FLAG_NAME));
      fs.writeFileSync(box.filePath, '{oops', 'utf8');
      expect(box.readJson()).toBe(null); // 读路径不受影响
      expect(box.getHealth().corrupt).toBe(true); // 内存里仍然知道
      expect(logs.some((m) => m.includes('无法写入损坏标记'))).toBe(true);
    });
  });
});
