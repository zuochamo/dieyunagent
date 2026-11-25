'use strict';

/**
 * 共享记忆（跨机 PostgreSQL）的纯函数口径。
 *
 * 这里锁的三件事都是「换台机器就会漂移」的地方：
 *  1. **召回只有一条语句**：向量与文本用 `COALESCE` 合流，维度不匹配的行自动退回文本分；
 *     没有 vector / 没有 pg_trgm 时只是表达式退化，不能变成第二套排序语义。
 *  2. **上传判定只有一处**：`isShareableKind` 与写 `.dieyun/memory.md` 共用，
 *     secret / private 永不出本机（共享库是局域网内所有机器共读）。
 *  3. **口令与其余字段解耦**：`password === undefined` = 不改，空串 = 清空（现网升级不会把口令抹掉）。
 */

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  buildRecallQuery,
  buildUpsertQuery,
  contentHash,
  normalizeContent,
  vectorLiteral
} = require('../../src/memory-shared/service');
const {
  createSharedMemoryStore,
  normalizeHost,
  DEFAULTS
} = require('../../src/memory-shared/settings');
const { isShareableKind, filterEntriesForFile } = require('../../src/agent/project-memory-file');
const { AGENT_LIMITS_DEFAULTS } = require('../../src/agent/agent-limits');

function fakeSafeStorage() {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (s) => Buffer.from(String(s), 'utf8'),
    decryptString: (b) => Buffer.from(b).toString('utf8')
  };
}

function tempUserData() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dieyun-shared-memory-'));
}

describe('共享记忆 · 召回语句', () => {
  it('有 vector：向量距离与文本相似度合流，维度不匹配退回文本分', () => {
    // 与生产调用点同形：`queryVec` 是**文本字面量**（`vectorLiteral()` 的产物），维度另有参数。
    // 曾经这里传的是数组，把「对字面量取 .length」的错误契约锁死了（线上向量通道永远不生效）。
    const { sql, params } = buildRecallQuery({
      hasVector: true,
      hasTrgm: true,
      queryVec: vectorLiteral([0.1, 0.2, 0.3]),
      queryVecDim: 3,
      queryText: '部署脚本',
      scopes: [],
      limit: 5
    });
    assert.match(sql, /<=>/, '向量距离运算符');
    assert.match(sql, /embedding_dim/, '维度对不上就不走向量');
    assert.match(sql, /COALESCE/, '一条语句两种排序来源');
    assert.match(sql, /similarity\(m\.content, \$2\)/, '文本相似度用查询文本参数');
    assert.match(sql, /m\.status = 'active'/, '只召回有效条目');
    assert.strictEqual(params[0], '[0.100000,0.200000,0.300000]', '向量以文本字面量传参');
    assert.strictEqual(params[1], '部署脚本');
    assert.strictEqual(params[2], 3, '维度取 queryVecDim，不是字面量长度');
    assert.strictEqual(params[4], 5, 'limit 在最末');
  });

  it('维度参数绝不能等于向量字面量的字符数（否则 embedding_dim = $3 永不成真）', () => {
    const vec = new Array(1024).fill(0.5);
    const literal = vectorLiteral(vec);
    const { params } = buildRecallQuery({
      hasVector: true,
      hasTrgm: true,
      queryVec: literal,
      queryVecDim: vec.length,
      queryText: 'q',
      scopes: [],
      limit: 5
    });
    assert.strictEqual(params[2], 1024);
    assert.notStrictEqual(params[2], literal.length, '字符数与维度不是一回事');
  });

  it('有 vector 但这一轮没有向量：语句不变，查询向量为 null 时全部退回文本分', () => {
    const { sql, params } = buildRecallQuery({
      hasVector: true,
      hasTrgm: true,
      queryVec: null,
      queryVecDim: null,
      queryText: 'abc',
      scopes: [],
      limit: 3
    });
    assert.match(sql, /\$1::text IS NOT NULL/);
    assert.strictEqual(params[0], null);
    assert.strictEqual(params[2], null);
  });

  it('没有 vector 扩展：SQL 里不能出现 ::vector（否则 PG 直接报类型不存在）', () => {
    const { sql, params } = buildRecallQuery({
      hasVector: false,
      hasTrgm: true,
      queryText: 'abc',
      scopes: ['project'],
      limit: 4
    });
    assert.ok(!sql.includes('vector'), '不得出现 vector 类型转换');
    assert.match(sql, /similarity\(m\.content, \$1\)/);
    assert.match(sql, /ORDER BY \(1 - /);
    assert.deepStrictEqual(params, ['abc', ['project'], 4]);
  });

  it('没有 pg_trgm：相似度退化为 0，排序仍按同一套（重要度兜底）', () => {
    const { sql } = buildRecallQuery({
      hasVector: false,
      hasTrgm: false,
      queryText: 'abc',
      scopes: [],
      limit: 2
    });
    assert.ok(!sql.includes('similarity('), '不得调用不存在的函数');
    assert.match(sql, /m\.importance DESC/);
  });
});

describe('共享记忆 · 写入语句', () => {
  const row = {
    content: '部署脚本用 pnpm',
    hash: 'h1',
    source: 'auto_consolidation',
    scope: 'global',
    importance: 0.7
  };

  it('有 pgvector：带 embedding 列与 ::vector 转型', () => {
    const { sql, params } = buildUpsertQuery(true, row, {
      vec: vectorLiteral([0.1, 0.2]),
      model: 'bge-m3',
      dim: 2,
      nodeId: 'n1'
    });
    assert.match(sql, /embedding/);
    assert.match(sql, /\$7::vector/);
    assert.match(sql, /ON CONFLICT \(content_hash\) DO UPDATE/);
    assert.strictEqual(params[6], '[0.100000,0.200000]');
    assert.strictEqual(params[8], 2);
  });

  it('没有 pgvector：语句里不出现 embedding 列（列根本不存在），合并口径不变', () => {
    const { sql, params } = buildUpsertQuery(false, row, { nodeId: 'n1' });
    assert.ok(!sql.includes('embedding'), '不得引用不存在的列');
    assert.match(sql, /ON CONFLICT \(content_hash\) DO UPDATE/);
    assert.match(sql, /GREATEST\(shared_memory\.importance/);
    assert.deepStrictEqual(params, [row.content, 'h1', 'auto_consolidation', 'global', 'n1', 0.7]);
  });
});

describe('共享记忆 · 正文归一与去重', () => {
  it('空白折叠后同一句话 hash 相同（跨机去重的唯一依据）', () => {
    assert.strictEqual(normalizeContent('  部署  脚本\n用 pnpm  '), '部署 脚本 用 pnpm');
    assert.strictEqual(contentHash('a  b'), contentHash(' a b '));
    assert.notStrictEqual(contentHash('a b'), contentHash('a c'));
  });

  it('向量字面量是 pgvector 能吃的文本', () => {
    assert.strictEqual(vectorLiteral([0.5, 1]), '[0.500000,1.000000]');
  });
});

describe('共享记忆 · 上传边界（与项目记忆同一判定）', () => {
  it('secret / private 永不出本机', () => {
    assert.strictEqual(isShareableKind('secret'), false);
    assert.strictEqual(isShareableKind('PRIVATE'), false);
    assert.strictEqual(isShareableKind('normal'), true);
    assert.strictEqual(isShareableKind(''), true);
  });

  it('写文件与上传共用同一套过滤结果', () => {
    const { kept, dropped } = filterEntriesForFile([
      { content: '构建用 pnpm build', kind: 'normal' },
      { content: '服务器口令 123456', kind: 'secret' },
      { content: '私人日程', kind: 'private' }
    ]);
    assert.deepStrictEqual(kept, ['构建用 pnpm build']);
    assert.strictEqual(dropped, 2);
  });

  it('机制预算都在 agent-limits（不在页面里写死）', () => {
    assert.ok(AGENT_LIMITS_DEFAULTS.sharedMemoryRecallLimit > 0);
    assert.ok(AGENT_LIMITS_DEFAULTS.sharedMemoryMinScoreSemantic > AGENT_LIMITS_DEFAULTS.sharedMemoryMinScoreKeyword);
    assert.ok(AGENT_LIMITS_DEFAULTS.sharedMemoryConsolidateIntervalMs >= 60 * 60 * 1000);
  });
});

describe('共享记忆 · 配置与口令', () => {
  it('默认开启，且默认值就是内网约定', () => {
    const store = createSharedMemoryStore({ userDataPath: tempUserData(), safeStorage: fakeSafeStorage() });
    const s = store.getSettings();
    assert.strictEqual(s.enabled, true, '安装即开启');
    assert.strictEqual(s.host, DEFAULTS.host);
    assert.strictEqual(s.hasPassword, false);
    assert.strictEqual(s.configured, false, '没口令 = 未配置 = 不参与任何读写');
  });

  it('粘贴整条 DSN 也能取出主机', () => {
    assert.strictEqual(normalizeHost('postgresql://u:p@10.0.0.5:5432/db'), '10.0.0.5');
    assert.strictEqual(normalizeHost('10.0.0.6'), '10.0.0.6');
    assert.strictEqual(normalizeHost('  10.0.0.7:6432/db '), '10.0.0.7');
  });

  it('password 不传 = 保留原口令；空串 = 清空', () => {
    const dir = tempUserData();
    const store = createSharedMemoryStore({ userDataPath: dir, safeStorage: fakeSafeStorage() });
    store.saveSettings({ password: 'secret-1' });
    assert.strictEqual(store.getSettings().hasPassword, true);
    assert.strictEqual(store.getSettings().configured, true);

    store.saveSettings({ host: '192.168.31.63' });
    assert.strictEqual(store.getSettings().hasPassword, true, '改主机不该抹掉口令');
    assert.strictEqual(store.getConnection().password, 'secret-1', '运行时拿得到明文');

    store.saveSettings({ password: '' });
    assert.strictEqual(store.getSettings().hasPassword, false);
    assert.strictEqual(store.getSettings().configured, false);

    const raw = fs.readFileSync(store.filePath, 'utf8');
    assert.ok(!raw.includes('secret-1'), '文件里不得出现明文口令');
  });

  it('关掉开关后 configured 仍可为真，但状态是 disabled', () => {
    const dir = tempUserData();
    const store = createSharedMemoryStore({ userDataPath: dir, safeStorage: fakeSafeStorage() });
    store.saveSettings({ password: 'secret-2', enabled: false });
    const s = store.getSettings();
    assert.strictEqual(s.enabled, false);
    assert.strictEqual(s.configured, true);
  });
});

describe('共享记忆 · 注入块（阈值逐行按通道取）', () => {
  const { fetchSharedMemoryBlock } = require('../../src/agent/system-prompt-prep');
  const LIM = {
    SHARED_MEMORY_LIMIT: 5,
    SHARED_MEMORY_MIN_SEMANTIC: 0.32,
    SHARED_MEMORY_MIN_KEYWORD: 0.12,
    SHARED_MEMORY_BLOCK_MAX_CHARS: 1600
  };

  /**
   * 一批里既有向量行（`injectScore = 1 - 余弦距离`）又有 trigram 兜底行（`similarity()`）。
   * 两者都是 [0,1] 的有界相似度，但 trigram 的天花板随长度比下降：拿批级 mode 一刀切会让
   * 兜底行永远过不了 0.32，等于「有向量就没文本兜底」。
   */
  it('向量行用语义阈值，trigram 行用关键词阈值（同一批里各按各的）', async () => {
    const sm = {
      active: () => true,
      recall: async () => ({
        ok: true,
        mode: 'semantic',
        results: [
          { id: 1, content: '向量命中行', kind: 'normal', mode: 'semantic', score: 0.9, injectScore: 0.9 },
          { id: 2, content: '文本兜底行', kind: 'normal', mode: 'keyword', score: 0.2, injectScore: 0.2 },
          { id: 3, content: '向量低分行', kind: 'normal', mode: 'semantic', score: 0.1, injectScore: 0.1 },
          { id: 4, content: '文本太低行', kind: 'normal', mode: 'keyword', score: 0.05, injectScore: 0.05 }
        ]
      })
    };
    const block = await fetchSharedMemoryBlock({ userQuery: '构建怎么跑' }, { sharedMemory: sm }, LIM, {});
    assert.match(block, /向量命中行/, '语义高分行要注入');
    assert.match(block, /文本兜底行/, 'trigram 行过了关键词线就该进（兜底不被语义阈值杀掉）');
    assert.ok(!block.includes('向量低分行'), '语义低分行不该注入');
    assert.ok(!block.includes('文本太低行'), '关键词太低行不该注入');
    assert.match(block, /【共享记忆 · 局域网其他机器沉淀/);
  });

  /**
   * 判定只读 `injectScore`（与本地记忆同名同义），不读 `score`：
   * 两个字段一旦各有各的读法，「该不该注入」就会分成两份口径。
   */
  it('判定只看 injectScore：score 再高、injectScore 不够也不注入', async () => {
    const sm = {
      active: () => true,
      recall: async () => ({
        ok: true,
        mode: 'semantic',
        results: [
          { id: 1, content: '分数虚高行', kind: 'normal', mode: 'semantic', score: 0.99, injectScore: 0.1 }
        ]
      })
    };
    const block = await fetchSharedMemoryBlock({ userQuery: '构建怎么跑' }, { sharedMemory: sm }, LIM, {});
    assert.strictEqual(block, '', '判 injectScore 而不是 score');
  });

  it('secret / private 永不进注入块；非语义模式标注为关键词召回', async () => {
    const sm = {
      active: () => true,
      recall: async () => ({
        ok: true,
        mode: 'keyword',
        results: [
          { id: 9, content: '数据库口令 abc', kind: 'secret', mode: 'keyword', score: 0.9, injectScore: 0.9 },
          { id: 10, content: '构建用 pnpm', kind: 'normal', mode: 'keyword', score: 0.5, injectScore: 0.5 }
        ]
      })
    };
    const block = await fetchSharedMemoryBlock({ userQuery: '构建' }, { sharedMemory: sm }, LIM, {});
    assert.ok(!block.includes('数据库口令'), 'secret 不得注入');
    assert.match(block, /构建用 pnpm/);
    assert.match(block, /关键词召回/);
  });

  it('服务不可用 / 没有 query 时不注入（也不抛错）', async () => {
    const off = { active: () => false, recall: async () => ({ ok: false, results: [] }) };
    assert.strictEqual(await fetchSharedMemoryBlock({ userQuery: 'x' }, { sharedMemory: off }, LIM, {}), '');
    const on = { active: () => true, recall: async () => ({ ok: true, results: [] }) };
    assert.strictEqual(await fetchSharedMemoryBlock({}, { sharedMemory: on }, LIM, {}), '');
    assert.strictEqual(await fetchSharedMemoryBlock({ userQuery: 'x' }, {}, LIM, {}), '');
  });
});

// 真机冒烟：只有显式给出口令才跑（仓库里不放任何口令）。
//   DIEYUN_PG_SMOKE=1 DIEYUN_PG_PASSWORD=... npx vitest run test/unit/shared-memory.test.cjs
const LIVE = process.env.DIEYUN_PG_SMOKE === '1' && !!process.env.DIEYUN_PG_PASSWORD;

describe.skipIf(!LIVE)('共享记忆 · 真机连通（live smoke）', () => {
  it('探活 + 建表 + 一条上传/召回闭环', async () => {
    const { createSharedMemoryService } = require('../../src/memory-shared/service');
    const dir = tempUserData();
    const svc = createSharedMemoryService({
      userDataPath: dir,
      safeStorage: fakeSafeStorage(),
      nodeId: 'smoke-node',
      hostname: 'smoke-node',
      clientVersion: '0.0.0-smoke'
    });
    svc.saveSettings({
      host: process.env.DIEYUN_PG_HOST || DEFAULTS.host,
      database: process.env.DIEYUN_PG_DATABASE || DEFAULTS.database,
      user: process.env.DIEYUN_PG_USER || DEFAULTS.user,
      password: process.env.DIEYUN_PG_PASSWORD
    });
    const probe = await svc.probe();
    assert.strictEqual(probe.ok, true, `探活失败：${probe.error || probe.reason}`);
    assert.strictEqual(svc.active(), true);

    const marker = `smoke-${Date.now()}`;
    const up = await svc.mirrorItems([{ content: `共享记忆冒烟 ${marker}`, kind: 'normal', importance: 0.4 }]);
    assert.strictEqual(up.ok, true, `上传失败：${up.error || up.reason}`);
    const res = await svc.recall(`共享记忆冒烟 ${marker}`, { limit: 5 });
    assert.ok(res && Array.isArray(res.results), '召回要有结果数组');
    assert.ok(
      res.results.some((r) => String(r.content || '').includes(marker)),
      '刚上传的条目应能被召回'
    );
    svc.dispose();
  });

  it('提炼锁：抢到 → 候选 → 合并落库 → 释放后能再抢', async () => {
    const { createSharedMemoryService } = require('../../src/memory-shared/service');
    const svc = createSharedMemoryService({
      userDataPath: tempUserData(),
      safeStorage: fakeSafeStorage(),
      nodeId: 'smoke-node',
      hostname: 'smoke-node',
      clientVersion: '0.0.0-smoke'
    });
    svc.saveSettings({ password: process.env.DIEYUN_PG_PASSWORD });
    assert.strictEqual((await svc.probe()).ok, true);

    const stamp = Date.now();
    // 两条同义 + 一条独立，模拟「多台机器各写一份」
    const up = await svc.mirrorItems([
      { content: `提炼冒烟 A ${stamp} 构建用 pnpm build`, kind: 'normal', importance: 0.6 },
      { content: `提炼冒烟 B ${stamp} 构建用 pnpm build`, kind: 'normal', importance: 0.6 },
      { content: `提炼冒烟 C ${stamp} 端口约定 8080`, kind: 'normal', importance: 0.6 }
    ]);
    assert.strictEqual(up.ok, true, `上传失败：${up.error || up.reason}`);

    const claim = await svc.claimConsolidation('test', { minIntervalMs: 0 });
    assert.ok(claim, '首次应抢到提炼权');
    try {
      const rows = await svc.listConsolidationCandidates(claim);
      assert.ok(Array.isArray(rows) && rows.length >= 1, '应有候选');
      const targets = rows.filter((r) => String(r.content).includes(String(stamp)));
      assert.ok(targets.length >= 3, `候选应含本次上传的 3 条，实际 ${targets.length}`);

      const applied = await svc.applyConsolidation(claim, {
        mergedIds: targets.slice(0, 2).map((r) => r.id),
        created: [{ content: `提炼冒烟合并 ${stamp} 构建用 pnpm build`, kind: 'normal', scope: 'global', importance: 4 }]
      });
      assert.strictEqual(applied.marked, 2, '两条被合并');
      assert.ok(applied.inserted >= 1, '合并结果要入库');

      // 被合并的行不能再出现在召回结果里
      const after = await svc.recall(`提炼冒烟 ${stamp}`, { limit: 20 });
      const ids = new Set((after.results || []).map((r) => Number(r.id)));
      for (const r of targets.slice(0, 2)) assert.ok(!ids.has(Number(r.id)), '合并掉的行不该再被召回');
    } finally {
      await svc.releaseConsolidation(claim, { scanned: 0 });
    }

    const again = await svc.claimConsolidation('test', { minIntervalMs: 0 });
    assert.ok(again, '释放后应能再次抢到（锁没漏）');
    await svc.releaseConsolidation(again, {});

    // 冷却期口径：上次刚完成，6 小时窗口内不得再抢
    const cooled = await svc.claimConsolidation('test', { minIntervalMs: 6 * 60 * 60 * 1000 });
    assert.strictEqual(cooled, null, '冷却期内应拒绝');
    svc.dispose();
  });
});
