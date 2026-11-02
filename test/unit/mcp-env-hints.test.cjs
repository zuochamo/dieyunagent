'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  getEnvHintDefs,
  getEnvHintNames,
  getEnvRequirement,
  isEnvSatisfied
} = require('../../src/mcp/env-hints');
const { getBuiltinMcpById } = require('../../src/mcp/registry');
const { isMcpServerConfigured, enrichMcpServerForUi } = require('../../src/mcp/server-config');
const { createMcpStore } = require('../../src/mcp/store');

/**
 * 假 safeStorage：'ENC:<keyId>:' 前缀 —— 与 credentials-store 的单测同一手法，
 * decryptString 对非本进程密文抛错，用来复现「换过 userData 后密钥不一致」。
 */
function fakeSafeStorage(keyId = 'A') {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (text) => Buffer.from(`ENC:${keyId}:${text}`, 'utf8'),
    decryptString: (buf) => {
      const raw = buf.toString('utf8');
      if (!raw.startsWith(`ENC:${keyId}:`)) throw new Error('decrypt failed');
      return raw.slice(`ENC:${keyId}:`.length);
    }
  };
}

function tempUserData() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dieyun-env-hints-'));
}

describe('env-hints：环境变量声明的唯一来源', () => {
  it('旧的单变量 envHint 等价于一条 required 条目（行为与改动前一致）', () => {
    const server = { envHint: 'BRAVE_API_KEY' };
    expect(getEnvHintDefs(server)).toEqual([
      { name: 'BRAVE_API_KEY', label: '', hint: '', required: true }
    ]);
    expect(getEnvRequirement(server)).toBe('all');
    expect(isEnvSatisfied(server, () => false)).toBe(false);
    expect(isEnvSatisfied(server, (name) => name === 'BRAVE_API_KEY')).toBe(true);
  });

  it('没声明任何环境变量的服务天然就位', () => {
    expect(getEnvHintNames({})).toEqual([]);
    expect(isEnvSatisfied({}, () => false)).toBe(true);
  });

  it('envHints 支持字符串与对象两种条目；非法变量名（含中文/空格/空）直接丢弃', () => {
    const defs = getEnvHintDefs({
      envHints: [
        'PLAIN_NAME',
        { name: 'WITH_LABEL', label: '带标签', hint: '形如 xxx', required: false },
        '',
        { name: '带中文' },
        'not a name',
        null,
        123
      ]
    });
    expect(defs.map((d) => d.name)).toEqual(['PLAIN_NAME', 'WITH_LABEL']);
    expect(defs[0].required).toBe(true);
    expect(defs[1]).toMatchObject({ label: '带标签', hint: '形如 xxx', required: false });
  });

  it('envHint 与 envHints 重名时以 envHints 那条为准（保留 label/hint），不重复出现', () => {
    const server = {
      envHint: 'DATABASE_URL',
      envHints: [{ name: 'DATABASE_URL', label: '主库' }, { name: 'MCP_DATABASE_URLS' }]
    };
    const defs = getEnvHintDefs(server);
    expect(defs.map((d) => d.name)).toEqual(['DATABASE_URL', 'MCP_DATABASE_URLS']);
    expect(defs[0].label).toBe('主库');
  });

  it('all 模式：required 的条目全都要有，required:false 的不拦', () => {
    const server = { envHints: [{ name: 'A' }, { name: 'B', required: false }] };
    expect(isEnvSatisfied(server, (name) => name === 'A')).toBe(true);
    expect(isEnvSatisfied(server, (name) => name === 'B')).toBe(false);
    expect(isEnvSatisfied(server, () => true)).toBe(true);
  });

  it('any 模式：条目互为替代，任意一个有值即算就位', () => {
    const server = { envHints: ['DATABASE_URL', 'MCP_DATABASE_URLS'], envRequirement: 'any' };
    expect(getEnvRequirement(server)).toBe('any');
    expect(isEnvSatisfied(server, (name) => name === 'DATABASE_URL')).toBe(true);
    expect(isEnvSatisfied(server, (name) => name === 'MCP_DATABASE_URLS')).toBe(true);
    expect(isEnvSatisfied(server, () => false)).toBe(false);
  });

  it('hasValue 抛异常时按「没有值」处理，不把异常冒给调用方', () => {
    const server = { envHint: 'X' };
    expect(
      isEnvSatisfied(server, () => {
        throw new Error('boom');
      })
    ).toBe(false);
  });
});

describe('mcp-postgres 的多库声明', () => {
  const server = getBuiltinMcpById('mcp-postgres');
  const savedDbUrl = process.env.DATABASE_URL;
  const savedMulti = process.env.MCP_DATABASE_URLS;

  beforeEach(() => {
    // isMcpServerConfigured 会回落到 process.env，测试里先清干净再断言
    delete process.env.DATABASE_URL;
    delete process.env.MCP_DATABASE_URLS;
  });

  afterEach(() => {
    if (savedDbUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = savedDbUrl;
    if (savedMulti === undefined) delete process.env.MCP_DATABASE_URLS;
    else process.env.MCP_DATABASE_URLS = savedMulti;
  });

  it('声明了单库串与多库串两条，且互为替代（any）——这就是「填不进第二个变量」的修复点', () => {
    expect(getEnvHintNames(server)).toEqual(['DATABASE_URL', 'MCP_DATABASE_URLS']);
    expect(getEnvRequirement(server)).toBe('any');
  });

  it('只配多库串也算配置完成；两者都没有则判未配置', () => {
    expect(
      isMcpServerConfigured(server, { getSecretMeta: () => ({ envKeys: ['MCP_DATABASE_URLS'] }) })
    ).toBe(true);
    expect(
      isMcpServerConfigured(server, { getSecretMeta: () => ({ envKeys: ['DATABASE_URL'] }) })
    ).toBe(true);
    expect(isMcpServerConfigured(server, { getSecretMeta: () => ({ envKeys: [] }) })).toBe(false);
  });

  it('enrich 暴露逐项状态，供配置页渲染多个输入框', () => {
    const view = enrichMcpServerForUi(server, {
      getSecretMeta: () => ({ envKeys: ['DATABASE_URL'], undecryptable: [] })
    });
    expect(view.envHintNames).toEqual(['DATABASE_URL', 'MCP_DATABASE_URLS']);
    expect(view.envRequirement).toBe('any');
    expect(view.envHints.map((def) => [def.name, def.saved])).toEqual([
      ['DATABASE_URL', true],
      ['MCP_DATABASE_URLS', false]
    ]);
    // 声明里带上了 label / 填写说明，UI 直接展示
    expect(view.envHints[0].label).toContain('主库');
    expect(view.envHints[1].hint).toContain('分号');
  });
});

describe('配置页保存多个环境变量', () => {
  // isMcpServerConfigured 会回落到 process.env（部署注入路径），测试里先清干净再断言
  const savedToken = process.env.GITHUB_PERSONAL_ACCESS_TOKEN;
  const savedDbUrl = process.env.DATABASE_URL;
  const savedMulti = process.env.MCP_DATABASE_URLS;

  beforeEach(() => {
    delete process.env.GITHUB_PERSONAL_ACCESS_TOKEN;
    delete process.env.DATABASE_URL;
    delete process.env.MCP_DATABASE_URLS;
  });

  afterEach(() => {
    if (savedToken === undefined) delete process.env.GITHUB_PERSONAL_ACCESS_TOKEN;
    else process.env.GITHUB_PERSONAL_ACCESS_TOKEN = savedToken;
    if (savedDbUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = savedDbUrl;
    if (savedMulti === undefined) delete process.env.MCP_DATABASE_URLS;
    else process.env.MCP_DATABASE_URLS = savedMulti;
  });

  it('envValues 逐项加密落库，读取时逐项标为已就位、明文不落盘', () => {
    const userDataPath = tempUserData();
    const store = createMcpStore({ safeStorage: fakeSafeStorage('A') });
    store.updateMcpServerConfig(userDataPath, {
      id: 'mcp-postgres',
      envValues: {
        DATABASE_URL: 'postgresql://root:pw@192.168.31.62:5432/dieyun_biz?sslmode=disable',
        MCP_DATABASE_URLS:
          'dz=postgresql://role_dz:pw@192.168.31.62:5432/daizhang?sslmode=disable'
      }
    });

    const cfg = store.getMcpServerConfigForUi(userDataPath, 'mcp-postgres');
    expect(cfg.envHintNames).toEqual(['DATABASE_URL', 'MCP_DATABASE_URLS']);
    expect(cfg.envHints.map((def) => def.saved)).toEqual([true, true]);
    expect(cfg.hasEnvValue).toBe(true);
    expect(cfg.configured).toBe(true);

    const raw = fs.readFileSync(path.join(userDataPath, 'mcp-secrets.json'), 'utf8');
    expect(raw).not.toContain('role_dz');
    expect(raw).not.toContain('dieyun_biz');
  });

  it('只提交其中一个变量时，另一个保持未就位（不误判整服务已配置好）', () => {
    const userDataPath = tempUserData();
    const store = createMcpStore({ safeStorage: fakeSafeStorage('A') });
    store.updateMcpServerConfig(userDataPath, {
      id: 'mcp-postgres',
      envValues: { MCP_DATABASE_URLS: 'dz=postgresql://u:p@h/db' }
    });
    const cfg = store.getMcpServerConfigForUi(userDataPath, 'mcp-postgres');
    expect(cfg.envHints.map((def) => def.saved)).toEqual([false, true]);
    expect(cfg.configured).toBe(true);
  });

  it('未声明的变量名被拒绝 —— 多变量入口不能变成任意 env 注入路径', () => {
    const userDataPath = tempUserData();
    const store = createMcpStore({ safeStorage: fakeSafeStorage('A') });
    expect(() =>
      store.updateMcpServerConfig(userDataPath, {
        id: 'mcp-postgres',
        envValues: { PATH: '/tmp/evil' }
      })
    ).toThrow(/未声明/);
    expect(() =>
      store.updateMcpServerConfig(userDataPath, {
        id: 'mcp-postgres',
        envValues: { DATABASE_URL: 'ok', LD_PRELOAD: '/tmp/x.so' }
      })
    ).toThrow(/未声明/);
    // 整批拒绝：合法的那条也不许落库（否则「报错但部分生效」更难排查）
    const cfg = store.getMcpServerConfigForUi(userDataPath, 'mcp-postgres');
    expect(cfg.envHints.map((def) => def.saved)).toEqual([false, false]);
  });

  it('payload.envHint 不能给白名单开口子（变量名只由服务声明决定）', () => {
    const userDataPath = tempUserData();
    const store = createMcpStore({ safeStorage: fakeSafeStorage('A') });

    // 曾有的实现把 payload.envHint 并进 allowedNames，于是下面两条都能落库
    expect(() =>
      store.updateMcpServerConfig(userDataPath, {
        id: 'mcp-postgres',
        envHint: 'PATH',
        envValues: { PATH: '/tmp/evil' }
      })
    ).toThrow(/未声明/);
    expect(() =>
      store.updateMcpServerConfig(userDataPath, {
        id: 'mcp-postgres',
        envHint: 'LD_PRELOAD',
        envValues: { DATABASE_URL: 'ok://x', LD_PRELOAD: '/tmp/x.so' }
      })
    ).toThrow(/未声明/);

    // 旧单值字段同样不接受渲染层指定键名：落到声明的第一个变量，payload.envHint 只被忽略
    store.updateMcpServerConfig(userDataPath, {
      id: 'mcp-postgres',
      envHint: 'EVIL_VAR',
      envValue: 'x'
    });
    const cfg = store.getMcpServerConfigForUi(userDataPath, 'mcp-postgres');
    expect(cfg.envHints.map((def) => [def.name, def.saved])).toEqual([
      ['DATABASE_URL', true],
      ['MCP_DATABASE_URLS', false]
    ]);
    expect(fs.readFileSync(path.join(userDataPath, 'mcp-secrets.json'), 'utf8')).not.toContain(
      'EVIL_VAR'
    );
  });

  it('旧的单值字段 envValue 仍落到第一个声明的变量（兼容旧渲染层 / 旧调用方）', () => {
    const userDataPath = tempUserData();
    const store = createMcpStore({ safeStorage: fakeSafeStorage('A') });
    store.updateMcpServerConfig(userDataPath, {
      id: 'mcp-postgres',
      envValue: 'postgresql://root:pw@192.168.31.62:5432/dieyun_biz'
    });
    const cfg = store.getMcpServerConfigForUi(userDataPath, 'mcp-postgres');
    expect(cfg.envHints.map((def) => def.saved)).toEqual([true, false]);
    expect(cfg.envHint).toBe('DATABASE_URL');
  });

  it('单变量服务（原 GitHub 形态）行为不变：仍只有一个输入项，且未填即未配置', () => {
    const userDataPath = tempUserData();
    const store = createMcpStore({ safeStorage: fakeSafeStorage('A') });
    // mcp-github 已不再预装（2026-11 发版决策），单变量语义改由自定义服务覆盖 —— 断言的行为不变。
    store.upsertMcpFromCatalog(userDataPath, {
      id: 'gh-like',
      name: 'GH-like',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-github'],
      envHint: 'GITHUB_PERSONAL_ACCESS_TOKEN'
    });
    const cfg = store.getMcpServerConfigForUi(userDataPath, 'gh-like');
    expect(cfg.envHintNames).toEqual(['GITHUB_PERSONAL_ACCESS_TOKEN']);
    expect(cfg.envRequirement).toBe('all');
    expect(cfg.configured).toBe(false);

    store.updateMcpServerConfig(userDataPath, {
      id: 'gh-like',
      envValue: 'ghp_fake_token_value'
    });
    const after = store.getMcpServerConfigForUi(userDataPath, 'gh-like');
    expect(after.envHints.map((def) => def.saved)).toEqual([true]);
    expect(after.configured).toBe(true);
  });
});
