'use strict';
/**
 * 准备区索引文案与建库触发（`src/renderer/renderer-agent-prep.js`）。
 *
 * 守的四件事（都是现场踩出来的）：
 * 1. **动词要分清**：`indexed=false` 是**首建**（这个根从来没建成过一次），`indexed=true`
 *    只是**刷新**。一律写「创建中」，用户会看到「面板上已建好、准备区却在创建」而当成 bug。
 * 2. **错误优先于进度**：`lastError` 有值就必须显示；旧实现要求 `!indexing && !indexed`，
 *    于是「一边失败一边重试」时错误被进度永久盖住，症状就是「永远创建中」。
 * 3. **文案要带主语**：远端会话的索引在它自己那份 worktree 里（另一份 `index.sqlite`），
 *    只写一句没有根名的状态，看不出是哪个项目的哪份库（2026-10-29 误判过一次）。
 * 4. **建库只 kick 一次**：建库是一次性慢事，不能由「每发一轮消息」反复发起；
 *    否则「建不完」会变成常态且对用户不可见。
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = path.join(__dirname, '..', '..', 'src', 'renderer', 'renderer-agent-prep.js');

function loadPrepApi() {
  const source = fs.readFileSync(SRC, 'utf8');
  const window = {};
  const factory = new Function('window', `${source}\n;return window;`);
  return factory(window);
}

const api = loadPrepApi();
const format = api.formatPrepIndexProgress;
const shortRoot = api.shortIndexRoot;

const WORKTREE = '/run/media/dieyunx/dieyunserver/dieyundaizhang/.dieyun/worktrees/sess-01032a90/main';

describe('准备区索引文案', () => {
  it('这个根从来没有过索引 → 首建，且带上根名（不是「创建中」这种没主语的词）', () => {
    const s = format({ indexed: false, indexing: true }, 'codebase', 'creating', WORKTREE);
    assert.match(s, /^后台首建 · dieyundaizhang/);
    assert.match(s, /本轮用 grep/);
    assert.doesNotMatch(s, /创建中|更新中|本次不等待/);
  });

  it('库里已有索引、只是在刷新 → 刷新（不是首建）', () => {
    const s = format({ indexed: true, indexing: true }, 'graph', 'creating', '/srv/repo');
    assert.match(s, /^后台刷新/);
    assert.doesNotMatch(s, /首建/);
  });

  it('错误优先于进度：一边跑一边报错，也要把错误说出来', () => {
    const s = format(
      { indexed: false, indexing: true, filesDone: 12, filesTotal: 222, lastError: 'embedding 401' },
      'codebase',
      'creating',
      '/srv/repo'
    );
    assert.match(s, /^索引失败：embedding 401/);
    assert.doesNotMatch(s, /12\/222/);
  });

  it('进度两种形态都带：有 total 用 done/total，只有 done 也能显示', () => {
    assert.match(
      format({ indexed: false, indexing: true, filesDone: 12, filesTotal: 222 }, 'codebase', 'creating', '/srv/repo'),
      / · 12\/222 文件/
    );
    assert.match(
      format({ indexed: true, indexing: true, filesDone: 7 }, 'graph', 'creating', '/srv/repo'),
      / · 7 文件/
    );
    assert.doesNotMatch(format({ indexed: true, indexing: true }, 'graph', 'creating', '/srv/repo'), /文件/);
  });

  it('「本轮刚发起」「未就绪未在跑」是两句话，都要给出可执行的下一步', () => {
    const started = format(null, 'codebase', 'started', '/srv/repo');
    assert.match(started, /^已发起后台首建/);
    assert.match(started, /本轮用 grep/);
    const idle = format({ indexed: false, indexing: false }, 'graph', 'idle', '/srv/repo');
    assert.match(idle, /未就绪且未在跑/);
    assert.match(idle, /重建/);
  });

  it('进度连续两轮没前进时说出来（否则「卡住」和「在建」长得一样）', () => {
    const st = { indexed: false, indexing: true, filesDone: 40, filesTotal: 900 };
    const first = format({ ...st }, 'codebase', 'creating', '/srv/stall');
    assert.doesNotMatch(first, /进度未前进/);
    const second = format({ ...st }, 'codebase', 'creating', '/srv/stall');
    assert.match(second, /进度未前进/);
  });
});

describe('索引根短名', () => {
  it('剥掉会话副本尾巴，保留项目名（与 UI / 会话身份同口径）', () => {
    assert.equal(shortRoot(WORKTREE), 'dieyundaizhang');
    assert.equal(shortRoot('ssh://192.168.31.62/srv/app/.dieyun/worktrees/sess-x/main'), 'app');
  });

  it('本地路径取末段目录名；空值不炸', () => {
    assert.equal(shortRoot('D:\\PixelOfficeMonitor'), 'PixelOfficeMonitor');
    assert.equal(shortRoot(''), '');
    assert.equal(shortRoot(null), '');
  });
});

describe('建库触发（prep 不再每轮发起）', () => {
  const isReadyNever = () => false;

  it('同一个索引根只 kick 一次，第 2、3 轮只读状态', async () => {
    const calls = [];
    const gatewayCall = async (method) => {
      calls.push(method);
      return { indexed: false, indexing: true, phase: 'walking', filesDone: 3, filesTotal: 100 };
    };
    const opts = { kind: 'codebase', workspacePath: '/srv/once', prepSid: 's1', gatewayCall, isReady: isReadyNever };
    const r1 = await api.ensurePrepIndexReady(opts);
    const r2 = await api.ensurePrepIndexReady(opts);
    const r3 = await api.ensurePrepIndexReady(opts);

    assert.equal(calls.filter((m) => m === 'codebase.index.start').length, 1, '建库只应发起一次');
    assert.equal(calls.filter((m) => m === 'codebase.status').length, 3, '每轮仍然只读一次状态');
    for (const r of [r1, r2, r3]) {
      assert.equal(r.ok, false);
      assert.equal(r.skipped, true);
      assert.match(r.error, /本轮用 grep/);
    }
  });

  it('已就绪时直接放行，不发起建库', async () => {
    const calls = [];
    const gatewayCall = async (method) => {
      calls.push(method);
      return { indexed: true, indexing: false, chunkCount: 42 };
    };
    const r = await api.ensurePrepIndexReady({
      kind: 'codebase',
      workspacePath: '/srv/ready',
      prepSid: 's2',
      gatewayCall,
      isReady: (st) => !!(st && st.indexed && !st.indexing && st.chunkCount > 0)
    });
    assert.equal(r.ok, true);
    assert.deepEqual(calls, ['codebase.status']);
  });

  it('状态查不到（SSH 瞬断）时不去 kick，只报可读原因', async () => {
    const calls = [];
    const gatewayCall = async (method) => {
      calls.push(method);
      throw new Error('SSH 连接已关闭');
    };
    const r = await api.ensurePrepIndexReady({
      kind: 'graph',
      workspacePath: '/srv/down',
      prepSid: 's3',
      gatewayCall,
      isReady: isReadyNever
    });
    assert.equal(r.ok, false);
    assert.equal(r.phase, 'unavailable');
    assert.match(r.error, /状态暂不可用/);
    assert.deepEqual(calls, ['graph.status'], '状态不可用时不许发起建库');
  });
});
