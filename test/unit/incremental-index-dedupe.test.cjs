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

/**
 * `codebaseAutoIncremental` 默认关（重活，见 docs/INDEX-VALUE-REVIEW.md §R4），
 * 增量还要求「该工作区已有向量」才有新鲜度可言。测试里显式写入这两件前提。
 */
function enableCodebaseAuto(vectors = 10) {
  const fs = require('node:fs');
  fs.mkdirSync(ROOT, { recursive: true });
  fs.writeFileSync(
    path.join(ROOT, 'model-settings.json'),
    JSON.stringify({ codebaseAutoIncremental: true })
  );
  return vectors;
}

function makeOps(vectorCount = 10) {
  const starts = [];
  const payloads = [];
  return {
    starts,
    payloads,
    invokeRustCore: async (method, params) => {
      if (method === 'codebase.status') return { indexed: true, indexing: false, vectorCount };
      if (method === 'codebase.index.start') {
        starts.push(method);
        payloads.push(params || {});
        return {};
      }
      if (method === 'graph.status') return { indexed: true, indexing: false };
      if (method === 'graph.index.start') {
        starts.push(method);
        payloads.push(params || {});
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
    const ops = makeOps(enableCodebaseAuto());
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
    // 增量必须带上 `vectors: true`：它按文件删旧 chunk（连向量一起），不跟着补的话
    // 改过的文件从此只能靠子串召回，向量覆盖率一路下滑（这正是日志里承诺的「增量接管」）。
    const start = ops.payloads.find((p) => p.force === false);
    assert.equal(start && start.vectors, true, '已有向量的工作区增量应继续维护向量');
  });

  /**
   * 增量只维护「已经有初始索引」的工作区：`!indexed` 时必须原地停手（建库要跑 embedding，
   * 不能由保存路径代做），但**必须留下一条节流日志**——否则日志里 graph 在跑、codebase 全无，
   * 会被误判成「codebase 增量坏了」。
   */
  it('codebase：未建初始索引时不建库，只记一条节流日志', async () => {
    enableCodebaseAuto();
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
        if (method === 'codebase.status') return { indexed: false, indexing: false, vectorCount: 0 };
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

  /**
   * R2/R3 之后「已建 chunk 库但没有向量」是常态（向量改为显式建）。
   * 这种仓没有新鲜度要求，增量必须原地停手并留下可诊断的节流日志。
   */
  it('codebase：没有向量时不跑增量，只记一条节流日志', async () => {
    enableCodebaseAuto();
    const fs = require('node:fs');
    const dir = path.join(ROOT, 'no-vectors');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'e.js');
    fs.writeFileSync(file, 'const c = 3;\n');

    const logs = [];
    const starts = [];
    const sched = createCodebaseIncrementalScheduler({
      userDataPath: ROOT,
      getWorkspaceRoot: () => dir,
      isRemoteWorkspace: () => false,
      invokeRustCore: async (method) => {
        if (method === 'codebase.status') return { indexed: true, indexing: false, vectorCount: 0 };
        starts.push(method);
        return {};
      },
      log: (msg) => logs.push(msg),
      debounceMs: 60
    });

    sched.notifyFileSaved(file, dir);
    await sleep(200);

    assert.deepEqual(starts, [], '没有向量就没有新鲜度要求，不该跑增量');
    assert.equal(logs.filter((l) => l.includes('没有向量')).length, 1);
  });

  it('codebase：默认（未显式开启）不因保存触发增量', async () => {
    const fs = require('node:fs');
    const dir = path.join(ROOT, 'auto-off');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'f.js');
    fs.writeFileSync(file, 'const d = 4;\n');
    // 覆盖掉前面测试写入的开关
    fs.writeFileSync(path.join(ROOT, 'model-settings.json'), JSON.stringify({}));

    const starts = [];
    const sched = createCodebaseIncrementalScheduler({
      userDataPath: ROOT,
      getWorkspaceRoot: () => dir,
      isRemoteWorkspace: () => false,
      invokeRustCore: async (method) => {
        if (method === 'codebase.status') return { indexed: true, indexing: false, vectorCount: 99 };
        starts.push(method);
        return {};
      },
      debounceMs: 60
    });

    sched.notifyFileSaved(file, dir);
    await sleep(200);

    assert.deepEqual(starts, [], '默认关：保存不该拉起索引');
    enableCodebaseAuto(); // 还原给后续测试
  });

  it('codebase：索引正在跑时不再排队重试（重试风暴是加法反模式）', async () => {
    enableCodebaseAuto();
    const fs = require('node:fs');
    const dir = path.join(ROOT, 'busy');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'g.js');
    fs.writeFileSync(file, 'const e = 5;\n');

    const logs = [];
    const starts = [];
    const sched = createCodebaseIncrementalScheduler({
      userDataPath: ROOT,
      getWorkspaceRoot: () => dir,
      isRemoteWorkspace: () => false,
      invokeRustCore: async (method) => {
        if (method === 'codebase.status') return { indexed: true, indexing: true, vectorCount: 99 };
        starts.push(method);
        return {};
      },
      log: (msg) => logs.push(msg),
      debounceMs: 60
    });

    sched.notifyFileSaved(file, dir);
    await sleep(300);

    assert.deepEqual(starts, [], 'busy 时不排重试');
    assert.equal(logs.filter((l) => l.includes('索引正在运行')).length, 1);
  });
});
