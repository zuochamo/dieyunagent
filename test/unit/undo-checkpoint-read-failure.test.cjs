'use strict';
/**
 * 检查点快照的旁路读：「读不到」绝不能退化成「文件原本不存在」（撤回时删文件）。
 *
 * 背景：撤回侧对 `before == null` 走的是**删除文件**分支（`gateway/rpc.js:restoreUndoFile`）。
 * `fs.write_file` 那条捕获路径在 DEFENSIVE-CODE-AUDIT §2.2 已修（读失败即判这次写失败），
 * 但 `undo.capture_batch` 的检查点快照（`readUndoTrackedPathNow`）一直还在吞错：
 *   - `fs.stat` 任何失败 → `before: null`
 *   - 非普通文件（目录）→ `before: null`
 *   - 兜底 catch → `before = meta.before ?? null`
 * 于是「恢复到此检查点」会把文件删掉。这里钉住三条：
 *   1) 确实不存在（ENOENT）→ 仍然记 null（那一时刻文件就是不存在，撤回=删除是对的）；
 *   2) 存在但读不出来（目录 / EISDIR）→ 明确失败（RPC reject，UNDO_SNAPSHOT_UNAVAILABLE），
 *      不生成「会把文件删掉」的快照；
 *   3) 会话根在 `writableRoots` 之外时也要能进快照（白名单口径与恢复侧一致，
 *      否则「快照读被拒、恢复却能写」，读失败又落成 null）。
 */
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { createRpcHandlers } = require('../../src/gateway/rpc');
const { createTurnUndoService } = require('../../src/undo/turn-undo-service');

const SID = 's-checkpoint';
const TID = 't-checkpoint';

function makeCtx({ root, writableRoots, svc }) {
  const target = { kind: 'local', path: root };
  return {
    allowedReadRoots: [root],
    writableRoots: writableRoots || [root],
    permissions: { hostControl: true, fsRead: true, fsWrite: true, shellExec: true },
    defaultCwd: root,
    userDataPath: null,
    turnUndo: svc,
    getWorkspaceTarget: () => target,
    getSessionWorkspaceTarget: () => target,
    sandbox: { context: () => ({}), guard: async () => null, grantedWriteRoots: () => [] }
  };
}

async function setup(opts = {}) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'undo-ckpt-'));
  const svc = createTurnUndoService();
  const bundle = createRpcHandlers(makeCtx({ root, writableRoots: opts.writableRoots, svc }));
  const h = bundle.handlers;
  const call = (fn) => bundle.runWithCallContext({ runWorkspaceRoot: root, sessionId: SID }, fn);
  await call(() =>
    h['undo.turn_begin']({ sessionId: SID, turnId: TID, workspaceKind: 'local', workspaceRoot: root })
  );
  /** 最后一批 checkpoint 里某个路径记下的「改前内容」 */
  const lastBatchBefore = (rel) => {
    const record = svc.getRecord(SID, TID);
    const batches = record.batches || [];
    const last = batches[batches.length - 1];
    const meta = last && last.files ? last.files[rel] : null;
    return meta ? meta.before : undefined;
  };
  return { root, h, call, cleanup: () => fsp.rm(root, { recursive: true, force: true }), lastBatchBefore };
}

/** 通过真实的 fs.write_file 链路登记一条「改前内容」 */
async function seedWrite(h, call, root, rel, before, after) {
  await fsp.writeFile(path.join(root, rel), before, 'utf8');
  await call(() =>
    h['fs.write_file']({
      filePath: path.join(root, rel),
      data: after,
      encoding: 'utf8',
      undoSessionId: SID,
      undoTurnId: TID
    })
  );
}

describe('检查点快照：读不到 ≠ 不存在', () => {
  it('文件确实不存在（ENOENT）→ 仍记 before=null（该时刻不存在，撤回=删除）', async () => {
    const { root, h, call, cleanup, lastBatchBefore } = await setup();
    try {
      await seedWrite(h, call, root, 'a.js', 'old-a', 'new-a');
      // 把文件删掉再拍检查点：这一刻它确实不存在
      await fsp.unlink(path.join(root, 'a.js'));
      const r = await call(() =>
        h['undo.capture_batch']({ sessionId: SID, turnId: TID, round: 1, touchPaths: [path.join(root, 'a.js')] })
      );
      assert.equal(r.ok, true);
      assert.equal(lastBatchBefore('a.js'), null, '确实不存在的路径，检查点就该记 null');
    } finally {
      await cleanup();
    }
  });

  it('存在但是目录（读不出原文）→ 明确失败，不产出会把文件删掉的快照', async () => {
    const { root, h, call, cleanup } = await setup();
    try {
      await seedWrite(h, call, root, 'a.js', 'old-a', 'new-a');
      // 文件被换成了目录（EISDIR）：这是「读不到」，不是「不存在」
      await fsp.unlink(path.join(root, 'a.js'));
      await fsp.mkdir(path.join(root, 'a.js'), { recursive: true });
      await assert.rejects(
        () =>
          call(() =>
            h['undo.capture_batch']({
              sessionId: SID,
              turnId: TID,
              round: 1,
              touchPaths: [path.join(root, 'a.js')]
            })
          ),
        (err) => {
          assert.equal(err.code, 'UNDO_SNAPSHOT_UNAVAILABLE');
          return true;
        }
      );
    } finally {
      await cleanup();
    }
  });

  it('会话根不在 writableRoots 里时也能进快照（白名单口径与恢复侧一致）', async () => {
    const elsewhere = await fsp.mkdtemp(path.join(os.tmpdir(), 'undo-other-'));
    // 关键：writableRoots 故意不含会话根
    const { root, h, call, cleanup, lastBatchBefore } = await setup({ writableRoots: [elsewhere] });
    try {
      await seedWrite(h, call, root, 'b.js', 'old-b', 'new-b');
      const r = await call(() =>
        h['undo.capture_batch']({ sessionId: SID, turnId: TID, round: 1, touchPaths: [path.join(root, 'b.js')] })
      );
      assert.equal(r.ok, true, '会话根内的路径不该因为构造期白名单而读不到');
      assert.equal(lastBatchBefore('b.js'), 'new-b', '检查点记的是「此刻磁盘上的原文」');
    } finally {
      await cleanup();
      await fsp.rm(elsewhere, { recursive: true, force: true });
    }
  });
});
