'use strict';

/**
 * 单轮 checkpoint 的「32 批上限」不能变成「安静地不再记录」。
 *
 * 约定（2026-10 改）：到 MAX_BATCHES_PER_TURN 时合并最老两个 checkpoint ——
 *   - 恢复点数量仍封顶 32，内存不涨；
 *   - 最老那个边界**还在**（id / round 沿用更早那批），只是粒度变粗；
 *   - 合并后的点绝不比原来退得更多（同路径取较早的 before）；
 *   - 被合并掉的旧 id 明确报错，而不是一句含糊的「不存在」。
 *
 * 为什么值得一条单测：这条上限只在「跑几十批工具」的长回合里触发，
 * 手测几乎碰不到；一旦退化成「静默不记录」，用户是在想回退时才发现没有恢复点。
 */

const assert = require('node:assert/strict');
const { createTurnUndoService } = require('../../src/undo/turn-undo-service');

const SESSION = 's-batches';
const TURN = 't-batches';

function newService() {
  // 不传 userDataPath → 不落盘，纯内存
  return createTurnUndoService();
}

async function seed(service, count) {
  for (let i = 1; i <= count; i += 1) {
    service.captureWrite({
      sessionId: SESSION,
      turnId: TURN,
      filePath: `f${i}.js`,
      beforeText: `old-${i}`
    });
    const r = service.captureBatchCheckpoint({ sessionId: SESSION, turnId: TURN, round: i });
    assert.equal(r.ok, true, `第 ${i} 批 checkpoint 应成功`);
  }
}

describe('turn-undo: checkpoint 批次上限', () => {
  it('未到上限时批次号单调递增、互不冲突', async () => {
    const svc = newService();
    await svc.beginTurn({ sessionId: SESSION, turnId: TURN });
    await seed(svc, 10);
    const record = svc.getRecord ? svc.getRecord(SESSION, TURN) : null;
    assert.ok(record, '应能取到回合记录');
    const ids = record.batches.map((b) => b.id);
    assert.deepEqual(ids, ['b0', 'b1', 'b2', 'b3', 'b4', 'b5', 'b6', 'b7', 'b8', 'b9', 'b10']);
    assert.equal(record.batches.every((b) => !b.mergedCount), true, '未到上限不应合并');
  });

  it('到上限后合并最老两个：数量仍为 32，最老边界保留', async () => {
    const svc = newService();
    await svc.beginTurn({ sessionId: SESSION, turnId: TURN });
    // beginTurn 自带 b0，再拍 31 批刚好 32 个
    await seed(svc, 31);
    let record = svc.getRecord(SESSION, TURN);
    assert.equal(record.batches.length, 32);
    assert.equal(record.batches[1].id, 'b1');

    // 第 32 批：触发合并，永不返回 skipped
    svc.captureWrite({ sessionId: SESSION, turnId: TURN, filePath: 'f32.js', beforeText: 'old-32' });
    const r = svc.captureBatchCheckpoint({ sessionId: SESSION, turnId: TURN, round: 32 });
    assert.equal(r.ok, true, '到上限后仍必须拍到 checkpoint');
    assert.notEqual(r.skipped, true);
    assert.equal(r.mergedBatches, 2, '应报告合并了两个批次');

    record = svc.getRecord(SESSION, TURN);
    assert.equal(record.batches.length, 32, '数量仍封顶 32');
    assert.equal(record.batches[0].id, 'b0', '最老边界沿用更早那批的 id');
    assert.equal(record.batches[0].round, 0, 'round 也沿用更早那批');
    assert.equal(record.batches[0].mergedCount, 2);
    assert.equal(record.batches[1].id, 'b2', 'b1 被并入 b0');
    assert.equal(r.batchId, 'b32', '新批次号继续往上走，不与既有 id 冲突');
    const ids = record.batches.map((b) => b.id);
    assert.equal(new Set(ids).size, ids.length, 'id 必须唯一');
  });

  it('合并后的恢复点取较早的 before，不会多退一步', async () => {
    const svc = newService();
    await svc.beginTurn({ sessionId: SESSION, turnId: TURN });
    await seed(svc, 31);
    svc.captureWrite({ sessionId: SESSION, turnId: TURN, filePath: 'f32.js', beforeText: 'old-32' });
    svc.captureBatchCheckpoint({ sessionId: SESSION, turnId: TURN, round: 32 });

    // b0 原本是回合起点（空），b1 含 f1。合并后：f1 取 b1 的 before（= 回合开始前的原文），
    // 而不是「恢复成不存在」——即退回 b0 的语义与合并前一致。
    const plan = svc.planRollbackBatch({ sessionId: SESSION, turnId: TURN, batchId: 'b0' });
    assert.equal(plan.ok, true);
    const byPath = new Map(plan.restore.map((x) => [x.path, x]));
    assert.equal(byPath.get('f1.js').before, 'old-1', '合并点保留最早那批的 before');
    assert.equal(byPath.get('f32.js').before, null, '更晚创建的文件在该点仍应被删除');

    // 较新的恢复点不受合并影响，仍是精确边界
    const late = svc.planRollbackBatch({ sessionId: SESSION, turnId: TURN, batchId: 'b31' });
    assert.equal(late.ok, true);
    const lateMap = new Map(late.restore.map((x) => [x.path, x]));
    assert.equal(lateMap.get('f31.js').before, 'old-31');
    assert.equal(lateMap.get('f32.js').before, null);
  });

  it('被合并掉的旧 id 明确报「已合并」，而不是含糊的「不存在」', async () => {
    const svc = newService();
    await svc.beginTurn({ sessionId: SESSION, turnId: TURN });
    await seed(svc, 31);
    svc.captureBatchCheckpoint({ sessionId: SESSION, turnId: TURN, round: 32 });

    const gone = svc.planRollbackBatch({ sessionId: SESSION, turnId: TURN, batchId: 'b1' });
    assert.equal(gone.ok, false);
    assert.match(gone.error, /合并/);

    const bogus = svc.planRollbackBatch({ sessionId: SESSION, turnId: TURN, batchId: 'b999' });
    assert.equal(bogus.ok, false);
    assert.match(bogus.error, /合并/);
  });

  it('整轮撤回始终可用（与批次数量无关）', async () => {
    const svc = newService();
    await svc.beginTurn({ sessionId: SESSION, turnId: TURN });
    await seed(svc, 40);
    const record = svc.getRecord(SESSION, TURN);
    assert.equal(record.batches.length, 32, '40 批之后仍封顶 32');
    assert.equal(record.batches[0].id, 'b0');
    // 回合级快照保留全部改动路径的前值：整轮撤回不依赖批次
    const keys = Object.keys(record.files).sort();
    assert.equal(keys.length, 40);
    assert.equal(record.files['f40.js'].before, 'old-40');
    assert.equal(record.rolledBack, false);
  });
});
