'use strict';

/**
 * undo 落盘层：元数据 + 内容块（去重）。
 *
 * 背景（issue/2026-11-07-smoothness-investigation.md）：单体 JSON 把「元数据」和「改前全文」
 * 混在一起，而每个 checkpoint batch 又整份复制一遍内容 —— 实测单会话 252MB，落盘是主线程上的
 * `JSON.stringify` + `writeFileSync`，一次 0.4~0.9s，用户感知为「偶发卡半秒」。
 *
 * 这里锁住三件不能退化的事：
 *   1. 同一份原文在磁盘上只落一份（去重），元数据里只留 32 hex 的引用；
 *   2. 写盘不再把原文塞进元数据 JSON（用体积断言防止悄悄退回单体格式）；
 *   3. 读回来必须一字不差（before 为 null 的「快照点不存在该文件」语义不能丢）。
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const {
  createTurnUndoService,
  enforceContentBudget,
  UNDO_CONTENT_BUDGET_CHARS
} = require('../../src/undo/turn-undo-service');

const SESSION = 's-store';
const TURN = 't-store';

function mkUserData() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'undo-store-'));
}

function sessionJsonPath(userData, sessionId = SESSION) {
  return path.join(userData, 'undo-sessions', `${sessionId}.json`);
}

function blobDir(userData, sessionId = SESSION) {
  return path.join(userData, 'undo-sessions', `${sessionId}.blobs`);
}

async function waitFor(predicate, label, timeoutMs = 5000) {
  const started = Date.now();
  for (;;) {
    if (await predicate()) return;
    if (Date.now() - started > timeoutMs) throw new Error(`超时未等到：${label}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** 轮询到「元数据文件存在且能解析」为止（落盘是异步的） */
async function waitForMeta(userData, sessionId = SESSION) {
  let parsed = null;
  await waitFor(
    () => {
      try {
        parsed = JSON.parse(fs.readFileSync(sessionJsonPath(userData, sessionId), 'utf8'));
        return true;
      } catch {
        return false;
      }
    },
    '会话元数据落盘'
  );
  return parsed;
}

function bigContent(tag, chars) {
  return `${tag}:${'x'.repeat(chars)}`;
}

/** 一个回合还留着多少内容字符（去重后）——用来断言「没被误伤」 */
function sessionCharsOf(record) {
  const seen = new Set();
  let n = 0;
  const add = (files) => {
    for (const meta of Object.values(files || {})) {
      const text = meta && typeof meta.before === 'string' ? meta.before : '';
      if (!text || seen.has(text)) continue;
      seen.add(text);
      n += text.length;
    }
  };
  add(record && record.files);
  for (const batch of (record && record.batches) || []) {
    if (batch && !batch.contentDropped) add(batch.files);
  }
  return n;
}

describe('turn-undo-store: 元数据与内容分离', () => {
  it('同一份原文只落一个内容块，元数据里不留原文', async () => {
    const userData = mkUserData();
    const svc = createTurnUndoService({ userDataPath: userData });
    await svc.beginTurn({ sessionId: SESSION, turnId: TURN, workspaceKind: 'snapshot' });

    // 20 个文件，内容各不相同；每个文件都被 5 个 batch 重复引用（正是线上的形态）
    const before = {};
    for (let i = 0; i < 20; i += 1) {
      before[`src/f${i}.js`] = bigContent(`orig-${i}`, 4000);
      svc.captureWrite({ sessionId: SESSION, turnId: TURN, filePath: `src/f${i}.js`, beforeText: before[`src/f${i}.js`] });
    }
    for (let b = 1; b <= 5; b += 1) {
      svc.captureBatchCheckpoint({ sessionId: SESSION, turnId: TURN, round: b });
    }

    const meta = await waitForMeta(userData);
    assert.equal(meta.version, 2, '应写成 v2（内容块分离）格式');

    const metaText = fs.readFileSync(sessionJsonPath(userData), 'utf8');
    assert.equal(
      metaText.includes('xxxxx'),
      false,
      '元数据里不该出现原文（出现即说明退化回单体 JSON）'
    );
    // 20 份原文 × 4000 字符 ≈ 80KB；元数据只该是引用，体积必须远小于它
    assert.ok(metaText.length < 40 * 1024, `元数据应远小于内容体积，实测 ${metaText.length} 字节`);

    const blobs = await fsp.readdir(blobDir(userData));
    assert.equal(blobs.length, 20, `20 份唯一内容应只落 20 个块，实测 ${blobs.length}`);
  });

  it('读回来一字不差：record.files 与每个 batch 的 before 都能还原', async () => {
    const userData = mkUserData();
    const svc = createTurnUndoService({ userDataPath: userData });
    await svc.beginTurn({ sessionId: SESSION, turnId: TURN, workspaceKind: 'snapshot' });
    svc.captureWrite({ sessionId: SESSION, turnId: TURN, filePath: 'a.js', beforeText: 'old-a' });
    svc.captureWrite({ sessionId: SESSION, turnId: TURN, filePath: 'b.js', beforeText: null });
    svc.captureBatchCheckpoint({ sessionId: SESSION, turnId: TURN, round: 1 });
    svc.captureWrite({ sessionId: SESSION, turnId: TURN, filePath: 'a.js', beforeText: 'old-a' });
    svc.captureBatchCheckpoint({ sessionId: SESSION, turnId: TURN, round: 2 });
    svc.finalizeTurn({ sessionId: SESSION, turnId: TURN });
    await waitForMeta(userData);

    const reloaded = createTurnUndoService({ userDataPath: userData });
    const record = reloaded.getRecord(SESSION, TURN);
    assert.ok(record, '应能从磁盘读回回合记录');
    assert.equal(record.finalized, true);
    assert.equal(record.files['a.js'].before, 'old-a');
    assert.equal(record.files['b.js'].before, null, '快照点不存在的文件必须仍是 null（撤回=删除）');
    assert.ok(record.batches.length >= 2);
    for (const batch of record.batches) {
      assert.equal(batch.contentDropped, undefined, '未超预算时不应丢内容');
      if (batch.files['a.js']) assert.equal(batch.files['a.js'].before, 'old-a');
    }
    // 整轮撤回计划可用，且取到的是原始内容
    const plan = reloaded.planRollback({ sessionId: SESSION, turnId: TURN });
    assert.equal(plan.ok, true);
    const byPath = new Map(plan.restore.map((r) => [r.path, r.before]));
    assert.equal(byPath.get('a.js'), 'old-a');
    assert.equal(byPath.get('b.js'), null);
  });

  it('trimStack 丢掉的回合，其内容块会被回收（不留孤儿）', async () => {
    const userData = mkUserData();
    const svc = createTurnUndoService({ userDataPath: userData });
    for (let i = 0; i < 8; i += 1) {
      const turnId = `t-${i}`;
      await svc.beginTurn({ sessionId: SESSION, turnId, workspaceKind: 'snapshot' });
      svc.captureWrite({ sessionId: SESSION, turnId, filePath: `only-${i}.js`, beforeText: bigContent(`v${i}`, 500) });
      svc.finalizeTurn({ sessionId: SESSION, turnId });
    }
    // 最后一次写盘之后再等一轮，确保 prune 跑过
    await waitForMeta(userData);
    await waitFor(async () => {
      const names = await fsp.readdir(blobDir(userData));
      return names.length <= 5;
    }, '孤儿内容块回收（栈只留 5 轮）');
  });

  it('v1 老文件（before 内联）仍可读，下次写入自动升级成 v2', async () => {
    const userData = mkUserData();
    const dir = path.join(userData, 'undo-sessions');
    fs.mkdirSync(dir, { recursive: true });
    const legacy = {
      version: 1,
      activeTurnId: TURN,
      stack: [TURN],
      records: {
        [TURN]: {
          turnId: TURN,
          sessionId: SESSION,
          mode: 'agent',
          strategy: 'snapshot',
          workspaceKind: 'local',
          files: { 'old.js': { before: 'legacy-content', encoding: 'utf8' } },
          batches: [{ id: 'b0', round: 0, createdAt: 1, files: { 'old.js': { before: 'legacy-content', encoding: 'utf8' } } }],
          planApplied: false,
          rolledBack: false,
          finalized: true,
          createdAt: 1
        }
      }
    };
    fs.writeFileSync(sessionJsonPath(userData), JSON.stringify(legacy), 'utf8');

    const svc = createTurnUndoService({ userDataPath: userData });
    const record = svc.getRecord(SESSION, TURN);
    assert.equal(record.files['old.js'].before, 'legacy-content', 'v1 内联内容必须读得回来');

    // 任何一次写入都应把它升级成 v2
    svc.markTurnTouched({ sessionId: SESSION, turnId: TURN, paths: ['old.js'] });
    await waitForMeta(userData);
    await waitFor(async () => {
      const text = fs.readFileSync(sessionJsonPath(userData), 'utf8');
      return JSON.parse(text).version === 2 && !text.includes('legacy-content');
    }, 'v1 升级成 v2（原文移出元数据）');
  });
});

describe('turn-undo-service: 内容预算', () => {
  function budgetState(...records) {
    return { records: new Map(records.map((r) => [r.turnId, r])), activeTurnId: null };
  }

  it('超预算时先丢最老回合的内容，并明确报「不可用」', async () => {
    const svc = createTurnUndoService(); // 纯内存（不落盘）
    await svc.beginTurn({ sessionId: SESSION, turnId: 't-old', workspaceKind: 'snapshot' });
    svc.captureWrite({ sessionId: SESSION, turnId: 't-old', filePath: 'old.js', beforeText: bigContent('old', 4000) });
    svc.captureBatchCheckpoint({ sessionId: SESSION, turnId: 't-old', round: 1 });
    svc.finalizeTurn({ sessionId: SESSION, turnId: 't-old' });
    await svc.beginTurn({ sessionId: SESSION, turnId: 't-new', workspaceKind: 'snapshot' });
    svc.captureWrite({ sessionId: SESSION, turnId: 't-new', filePath: 'new.js', beforeText: bigContent('new', 4000) });
    svc.captureBatchCheckpoint({ sessionId: SESSION, turnId: 't-new', round: 1 });

    const oldRecord = svc.getRecord(SESSION, 't-old');
    const newRecord = svc.getRecord(SESSION, 't-new');
    const oldBatch = oldRecord.batches.find((b) => Object.keys(b.files || {}).length);

    const result = enforceContentBudget(budgetState(oldRecord, newRecord), 5000);
    assert.equal(result.droppedRecords, 1, '应丢掉最老回合的 record.files');
    assert.equal(result.droppedBatches > 0, true, '也应丢掉它的 checkpoint 内容');
    assert.equal(oldRecord.contentDropped, true);
    assert.equal(oldBatch.contentDropped, true);
    assert.deepEqual(oldBatch.files, {});
    assert.equal(sessionCharsOf(newRecord) > 4000, true, '最新一轮的内容不受影响');

    const plan = svc.planRollbackBatch({ sessionId: SESSION, turnId: 't-old', batchId: oldBatch.id });
    assert.equal(plan.ok, false);
    assert.match(plan.error, /体积预算/);
  });

  it('内容被更新的回合共用时，丢掉老回合省不下任何东西 —— 不白丢功能', async () => {
    const svc = createTurnUndoService();
    const shared = bigContent('shared', 4000);
    await svc.beginTurn({ sessionId: SESSION, turnId: 't-old', workspaceKind: 'snapshot' });
    svc.captureWrite({ sessionId: SESSION, turnId: 't-old', filePath: 's.js', beforeText: shared });
    svc.captureBatchCheckpoint({ sessionId: SESSION, turnId: 't-old', round: 1 });
    svc.finalizeTurn({ sessionId: SESSION, turnId: 't-old' });
    await svc.beginTurn({ sessionId: SESSION, turnId: 't-new', workspaceKind: 'snapshot' });
    svc.captureWrite({ sessionId: SESSION, turnId: 't-new', filePath: 's.js', beforeText: shared });
    svc.captureBatchCheckpoint({ sessionId: SESSION, turnId: 't-new', round: 1 });

    const oldRecord = svc.getRecord(SESSION, 't-old');
    const newRecord = svc.getRecord(SESSION, 't-new');
    const result = enforceContentBudget(budgetState(oldRecord, newRecord), 1);
    assert.deepEqual(result, { droppedBatches: 0, droppedRecords: 0 }, '省不下就别丢');
    assert.equal(oldRecord.contentDropped, undefined);
  });

  it('最新一轮的 record.files 永不丢：预算再小，整轮撤回仍然可用', async () => {
    const svc = createTurnUndoService();
    await svc.beginTurn({ sessionId: SESSION, turnId: TURN, workspaceKind: 'snapshot' });
    svc.captureWrite({ sessionId: SESSION, turnId: TURN, filePath: 'keep.js', beforeText: bigContent('keep', 2000) });
    svc.captureBatchCheckpoint({ sessionId: SESSION, turnId: TURN, round: 1 });
    const record = svc.getRecord(SESSION, TURN);

    // 回合结束后 activeTurnId 会清空 —— 但「最新一轮」仍必须保住（能整轮撤回的就是它）
    svc.finalizeTurn({ sessionId: SESSION, turnId: TURN });
    const result = enforceContentBudget(budgetState(record), 1);
    assert.deepEqual(result, { droppedBatches: 0, droppedRecords: 0 });
    assert.equal(record.contentDropped, undefined);
    const plan = svc.planRollback({ sessionId: SESSION, turnId: TURN });
    assert.equal(plan.ok, true, '整轮撤回必须仍然可用');
    assert.equal(plan.restore.find((r) => r.path === 'keep.js').before, bigContent('keep', 2000));
  });

  it('预算默认值足以容纳正常回合（不误伤）', async () => {
    const svc = createTurnUndoService();
    await svc.beginTurn({ sessionId: SESSION, turnId: TURN, workspaceKind: 'snapshot' });
    for (let i = 0; i < 30; i += 1) {
      svc.captureWrite({ sessionId: SESSION, turnId: TURN, filePath: `n${i}.js`, beforeText: bigContent(`n${i}`, 2000) });
    }
    for (let b = 1; b <= 8; b += 1) svc.captureBatchCheckpoint({ sessionId: SESSION, turnId: TURN, round: b });
    const record = svc.getRecord(SESSION, TURN);
    const result = enforceContentBudget(budgetState(record), UNDO_CONTENT_BUDGET_CHARS);
    assert.deepEqual(result, { droppedBatches: 0, droppedRecords: 0 });
  });
});
