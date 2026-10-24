'use strict';
/**
 * 增量索引去抖：一次保存有「工具主动上报 + watcher」两个来源，
 * 窗口必须把两者合并成一次索引（审计：main.log 里 `(save)` 成对出现，3.2s / 1.2s 双峰）。
 *
 * scheduler 的 `invokeRustCore` 是注入的，这里用假实现验证：
 * 窗口内的第二次通知只重置计时器，不产生第二次 `graph.index.start`。
 */
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');

const { createGraphIncrementalScheduler } = require('../../src/graph/graph-incremental-scheduler.js');
const { createCodebaseIncrementalScheduler } = require('../../src/index/codebase-incremental-scheduler.js');

const ROOT = path.resolve(os.tmpdir(), 'dieyun-index-dedupe-test');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function makeOps() {
  const starts = [];
  return {
    starts,
    invokeRustCore: async (method) => {
      if (method === 'codebase.status') return { indexed: true, indexing: false };
      if (method === 'codebase.index.start') {
        starts.push(method);
        return {};
      }
      if (method === 'graph.status') return { indexed: true, indexing: false };
      if (method === 'graph.index.start') {
        starts.push(method);
        return {};
      }
      return null;
    }
  };
}

describe('增量索引去抖', () => {
  it('graph：窗口内两次 notifyFileSaved 只跑一次索引', async () => {
    const ops = makeOps();
    const sched = createGraphIncrementalScheduler({
      userDataPath: ROOT,
      getWorkspaceRoot: () => ROOT,
      isRemoteWorkspace: () => false,
      invokeRustCore: ops.invokeRustCore,
      debounceMs: 80
    });
    const file = path.join(ROOT, 'a.js');
    sched.notifyFileSaved(file, ROOT); // 工具主动上报
    await sleep(20);
    sched.notifyFileSaved(file, ROOT); // watcher 看到同一笔写入
    await sleep(400);
    assert.deepEqual(ops.starts, ['graph.index.start'], '同一笔保存只该触发一次图索引');
  });

  it('graph：窗口外的下一次保存照常触发', async () => {
    const ops = makeOps();
    const sched = createGraphIncrementalScheduler({
      userDataPath: ROOT,
      getWorkspaceRoot: () => ROOT,
      isRemoteWorkspace: () => false,
      invokeRustCore: ops.invokeRustCore,
      debounceMs: 80
    });
    const file = path.join(ROOT, 'b.js');
    sched.notifyFileSaved(file, ROOT);
    await sleep(400);
    sched.notifyFileSaved(file, ROOT);
    await sleep(400);
    assert.equal(ops.starts.length, 2);
  });

  it('非源码扩展名不触发索引（去抖不改变来源过滤）', async () => {
    const ops = makeOps();
    const sched = createGraphIncrementalScheduler({
      userDataPath: ROOT,
      getWorkspaceRoot: () => ROOT,
      isRemoteWorkspace: () => false,
      invokeRustCore: ops.invokeRustCore,
      debounceMs: 80
    });
    sched.notifyFileSaved(path.join(ROOT, 'logo.png'), ROOT);
    await sleep(400);
    assert.deepEqual(ops.starts, []);
  });

  it('codebase：窗口内两次 notifyFileSaved 只跑一次索引', async () => {
    const ops = makeOps();
    const sched = createCodebaseIncrementalScheduler({
      userDataPath: ROOT,
      getWorkspaceRoot: () => ROOT,
      isRemoteWorkspace: () => false,
      invokeRustCore: ops.invokeRustCore,
      debounceMs: 80
    });
    // codebase 侧会嗅探文件内容判断是否二进制，先落一个真实文本文件
    const fs = require('node:fs');
    fs.mkdirSync(ROOT, { recursive: true });
    const file = path.join(ROOT, 'c.js');
    fs.writeFileSync(file, 'const a = 1;\n');
    sched.notifyFileSaved(file, ROOT);
    await sleep(20);
    sched.notifyFileSaved(file, ROOT);
    await sleep(400);
    assert.deepEqual(ops.starts, ['codebase.index.start']);
  });

  /**
   * 增量只维护「已经有初始索引」的工作区：`!indexed` 时必须原地停手（建库要跑 embedding，
   * 不能由保存路径代做），但**必须留下一条节流日志**——否则日志里 graph 在跑、codebase 全无，
   * 会被误判成「codebase 增量坏了」。
   */
  it('codebase：未建初始索引时不建库，只记一条节流日志', async () => {
    const fs = require('node:fs');
    const dir = path.join(ROOT, 'no-index');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'd.js');
    fs.writeFileSync(file, 'const b = 2;\n');

    const logs = [];
    const starts = [];
    const sched = createCodebaseIncrementalScheduler({
      userDataPath: ROOT,
      getWorkspaceRoot: () => dir,
      isRemoteWorkspace: () => false,
      invokeRustCore: async (method) => {
        if (method === 'codebase.status') return { indexed: false, indexing: false };
        starts.push(method);
        return {};
      },
      log: (msg) => logs.push(msg),
      debounceMs: 60
    });

    sched.notifyFileSaved(file, dir);
    await sleep(200);
    sched.notifyFileSaved(file, dir);
    await sleep(200);

    assert.deepEqual(starts, [], '未建索引时不该偷偷建库');
    assert.equal(
      logs.filter((l) => l.includes('incremental index idle')).length,
      1,
      '10 分钟节流窗口内只记一条'
    );
  });
});
