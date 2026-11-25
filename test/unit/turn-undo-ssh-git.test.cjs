'use strict';
/**
 * SSH 会话里「撤回本轮改动」必须真的把代码撤回（2026-11-25 实测事故的回归夹具）。
 *
 * 事故现场（用户名下 `dieyundaizhang` 工程，远端 per-session worktree）：
 * 一轮 55 次 `host_exec` + 18 次 fs 编辑之后点撤回，界面说「已恢复 7 个文件」，
 * 设计原封不动 —— 因为撤回快照只记「fs 工具写之前读到的原文」，shell 改的文件
 * 要么没有「改前」，要么被记成「改过之后」的内容。
 *
 * 修法（`src/undo/git-tree-rollback.js`）：回合开始 `git stash create` 拿「回合开始树」，
 * 撤回时按 `git diff --name-status <tree>` 逐条回滚，再复核一遍；复核不干净就报错、
 * 不提交撤回。这里用假远端（SFTP + 假 git）钉住四条：
 *   1) 只被 shell 改过的文件也能撤回；
 *   2) 回合中新建的文件撤回后消失；
 *   3) 不是 git 仓库时，撤回不许假成功（要给出 warning）；
 *   4) 复核还有残留 → ok:false + 明确报错，不提交。
 */
const assert = require('node:assert/strict');
const os = require('node:os');

const { createRpcHandlers } = require('../../src/gateway/rpc');
const { createTurnUndoService } = require('../../src/undo/turn-undo-service');
const { buildSshUri } = require('../../src/workspace/target');
const { parseNameStatus } = require('../../src/git/turn-tree');

const ROOT = '/srv/app';

/** git 侧命令的单引号解包（与 `git-target` 的 gitShellQuote 对称） */
function unquote(token) {
  const s = String(token || '');
  if (s.length >= 2 && s.startsWith("'") && s.endsWith("'")) {
    return s.slice(1, -1).replace(/'\\''/g, "'");
  }
  return s;
}

function splitArgs(command) {
  const out = [];
  const re = /'((?:[^']|'\\'')*)'/g;
  let m;
  while ((m = re.exec(command))) out.push(m[1].replace(/'\\''/g, "'"));
  return out;
}

/**
 * 假远端：文件走 SFTP 表，git 命令由 `gitRepo` 决定（非仓库时 `rev-parse --git-dir` 失败）。
 * `tree` = 回合开始时的工作区内容（`git stash create` 那一棵树）；不在 `tree` 里的路径
 * 一律当未跟踪（与真实 git 一致：`git diff` 看不见未跟踪文件，只有 `ls-files --others` 能）。
 */
function makeWorld({ gitRepo = true, tree = {}, failCheckout = [] } = {}) {
  const wt = new Map(Object.entries(tree));
  const sshUriPath = ROOT;
  let stashTaken = null;
  let head = 'headsha';
  /** 调用计数（回归夹具用：回合开始树只许建一次） */
  const calls = { stashCreate: 0, lsFiles: 0 };

  const untrackedNow = () => [...wt.keys()].filter((p) => !Object.prototype.hasOwnProperty.call(tree, p));

  /** 与真实 git 一致：`--name-status -z` 输出 `<status>\0<path>\0`，路径不做 C-quote。 */
  const diffSince = (sha) => {
    const base = sha === stashTaken ? tree : tree; // 本夹具只用一个树
    // 只比 tracked（tree 里有登记的）路径：未跟踪由 ls-files 那条路负责
    const recs = [];
    for (const p of Object.keys(base).sort()) {
      const inWt = wt.has(p);
      if (inWt) {
        if (base[p] !== wt.get(p)) recs.push(`M\0${p}`);
      } else {
        recs.push(`D\0${p}`);
      }
    }
    return recs.length ? `${recs.join('\0')}\0` : '';
  };

  const git = (args) => {
    const [cmd, ...rest] = args;
    if (!gitRepo) {
      return { code: 128, stdout: '', stderr: 'fatal: not a git repository' };
    }
    if (cmd === 'rev-parse') {
      if (rest[0] === '--git-dir') return { code: 0, stdout: '.git\n', stderr: '' };
      if (rest[0] === 'HEAD') return { code: 0, stdout: `${head}\n`, stderr: '' };
      return { code: 0, stdout: '', stderr: '' };
    }
    if (cmd === 'stash' && rest[0] === 'create') {
      calls.stashCreate += 1;
      stashTaken = 'stashsha';
      return { code: 0, stdout: Object.keys(tree).length ? 'stashsha\n' : '\n', stderr: '' };
    }
    if (cmd === 'ls-files') {
      // `git ls-files --others --exclude-standard -z`
      calls.lsFiles += 1;
      return { code: 0, stdout: untrackedNow().map((p) => `${p}\0`).join(''), stderr: '' };
    }
    if (cmd === 'status') return { code: 0, stdout: '## main\0', stderr: '' };
    if (cmd === 'diff') return { code: 0, stdout: diffSince(rest[rest.length - 1]), stderr: '' };
    if (cmd === 'checkout') {
      const treeish = rest[0];
      const p = rest[rest.length - 1];
      if (failCheckout.includes(p)) return { code: 1, stdout: '', stderr: `checkout failed: ${p}` };
      if (treeish !== stashTaken || !Object.prototype.hasOwnProperty.call(tree, p)) {
        return { code: 1, stdout: '', stderr: `pathspec '${p}' did not match` };
      }
      wt.set(p, tree[p]);
      return { code: 0, stdout: '', stderr: '' };
    }
    if (cmd === 'rm') return { code: 0, stdout: '', stderr: '' };
    return { code: 0, stdout: '', stderr: '' };
  };

  const ssh = {
    status: () => ({ connected: true, host: 'h', port: 22, username: 'u' }),
    getHomeDir: () => '/home/u',
    exec: async (command) => {
      const s = String(command);
      if (s.startsWith('git ')) {
        const res = git(splitArgs(s));
        return { code: res.code, stdout: res.stdout, stderr: res.stderr };
      }
      if (s.startsWith('rm -f -- ')) {
        wt.delete(unquote(s.slice('rm -f -- '.length)));
        return { code: 0, stdout: '', stderr: '' };
      }
      if (s.startsWith('test -e ')) {
        return { code: wt.has(unquote(s.slice('test -e '.length))) ? 0 : 1, stdout: '', stderr: '' };
      }
      return { code: 0, stdout: '', stderr: '' };
    },
    sftpStat: async (p) => {
      if (!wt.has(p)) throw Object.assign(new Error('No such file'), { code: 2 });
      return { mode: 0o100644, size: Buffer.byteLength(wt.get(p)) };
    },
    sftpReadFile: async (p) => {
      if (!wt.has(p)) throw Object.assign(new Error('No such file'), { code: 2 });
      return { buf: Buffer.from(wt.get(p), 'utf8'), truncated: false };
    },
    sftpWriteFile: async (p, buf) => {
      wt.set(p, buf.toString('utf8'));
      return { ok: true };
    },
    sftpMkdirp: async () => ({ ok: true }),
    sftpReaddir: async () => []
  };

  const target = { kind: 'ssh', host: 'h', port: 22, username: 'u', remotePath: sshUriPath };
  const ctx = {
    allowedReadRoots: [os.tmpdir()],
    writableRoots: [os.tmpdir()],
    permissions: { hostControl: true, fsRead: true, fsWrite: true, shellExec: true },
    defaultCwd: os.tmpdir(),
    userDataPath: null,
    turnUndo: createTurnUndoService(),
    ssh,
    getWorkspaceTarget: () => target,
    getSessionWorkspaceTarget: () => target,
    isSshTargetConnected: () => true,
    isSshWorkspaceConnected: () => true,
    getSshManagerForTarget: () => ssh,
    getRemoteAgentInfo: () => null,
    sandbox: { context: () => ({}), guard: async () => null, grantedWriteRoots: () => [] }
  };
  return {
    ctx,
    wt,
    ssh,
    sshUri: buildSshUri(target),
    /** 模拟「本轮把改动提交了」：HEAD 换一个 sha */
    commitDuringTurn: () => {
      head = 'committed-sha';
    },
    /** 诊断计数：`stash create` / `ls-files` 只在回合开始各跑一次（capture_batch 不许再跑） */
    counters: () => ({ ...calls })
  };
}

async function startTurn(world, sid, tid) {
  const bundle = createRpcHandlers(world.ctx);
  const h = bundle.handlers;
  const call = (fn) => bundle.runWithCallContext({ runWorkspaceRoot: world.sshUri, sessionId: sid }, fn);
  const begin = await call(() =>
    h['undo.turn_begin']({
      sessionId: sid,
      turnId: tid,
      mode: 'agent',
      workspaceKind: 'ssh',
      workspaceRoot: ROOT,
      runWorkspaceRoot: world.sshUri
    })
  );
  return { h, call, begin };
}

describe('撤回：SSH 会话里 shell 改的文件必须能撤回', () => {
  it('只被 shell 改过的文件（host_exec / sed -i）撤回后回到回合开始的内容', async () => {
    const world = makeWorld({ tree: { 'src/a.js': 'old-a', 'src/b.js': 'old-b' } });
    const { h, call, begin } = await startTurn(world, 's1', 't1');
    assert.equal(begin.strategy, 'git');
    assert.equal(begin.gitStashSha, 'stashsha', '回合开始树必须被记下来');

    // 模型用 shell 改文件：完全不经过 fs 工具 → 快照里没有任何「改前内容」
    world.wt.set('src/a.js', 'shell-new-a');

    await call(() => h['undo.capture_batch']({ sessionId: 's1', turnId: 't1', round: 1, fullSnapshot: true }));
    await call(() => h['undo.turn_finalize']({ sessionId: 's1', turnId: 't1' }));

    const rb = await call(() => h['undo.rollback']({ sessionId: 's1', turnId: 't1' }));
    assert.equal(rb.ok, true, `撤回应成功：${JSON.stringify(rb.errors)}`);
    assert.equal(rb.committed, true);
    assert.equal(world.wt.get('src/a.js'), 'old-a', 'shell 改的内容必须被撤回');
    assert.equal(world.wt.get('src/b.js'), 'old-b');
    assert.deepEqual(rb.uncovered, []);
  });

  it('回合中新建的文件（含 shell 建的未跟踪文件）撤回后消失', async () => {
    const world = makeWorld({ tree: { 'src/a.js': 'old-a' } });
    const { h, call } = await startTurn(world, 's2', 't2');
    world.wt.set('packages/probe/x.ts', 'made-in-turn');
    await call(() => h['undo.capture_batch']({ sessionId: 's2', turnId: 't2', round: 1, fullSnapshot: true }));
    await call(() => h['undo.turn_finalize']({ sessionId: 's2', turnId: 't2' }));

    const rb = await call(() => h['undo.rollback']({ sessionId: 's2', turnId: 't2' }));
    assert.equal(rb.ok, true, JSON.stringify(rb.errors));
    assert.equal(world.wt.has('packages/probe/x.ts'), false, '回合中新建的文件必须被删掉');
    assert.equal(world.wt.get('src/a.js'), 'old-a');
  });

  it('回合开始时本来就有的未跟踪文件：撤回不许删', async () => {
    const world = makeWorld({ tree: { 'src/a.js': 'old-a' } });
    // 回合开始前就存在的未跟踪文件（用户自己未提交的稿子）
    world.wt.set('notes/draft.md', 'user-draft');
    const { h, call } = await startTurn(world, 's5', 't5');
    world.wt.set('notes/draft.md', 'user-draft-edited');
    await call(() => h['undo.capture_batch']({ sessionId: 's5', turnId: 't5', round: 1, fullSnapshot: true }));
    await call(() => h['undo.turn_finalize']({ sessionId: 's5', turnId: 't5' }));

    const rb = await call(() => h['undo.rollback']({ sessionId: 's5', turnId: 't5' }));
    assert.equal(rb.ok, true, JSON.stringify(rb.errors));
    assert.equal(world.wt.get('notes/draft.md'), 'user-draft-edited', '本来就在的未跟踪文件不许被删');
  });

  it('非 ASCII / 带空格的路径也必须能撤回（`-z` 口径）', async () => {
    const world = makeWorld({ tree: { '文档/中文 说明.md': 'old-doc' } });
    const { h, call } = await startTurn(world, 's6', 't6');
    world.wt.set('文档/中文 说明.md', 'shell-new-doc');
    await call(() => h['undo.capture_batch']({ sessionId: 's6', turnId: 't6', round: 1, fullSnapshot: true }));
    await call(() => h['undo.turn_finalize']({ sessionId: 's6', turnId: 't6' }));

    const rb = await call(() => h['undo.rollback']({ sessionId: 's6', turnId: 't6' }));
    assert.equal(rb.ok, true, JSON.stringify(rb.errors));
    assert.equal(world.wt.get('文档/中文 说明.md'), 'old-doc', '中文/空格文件名不许因为 C-quote 而撤不回');
  });

  it('回合中把改动提交了（HEAD 变了）→ 明确说「提交里的改动没撤回」', async () => {
    const world = makeWorld({ tree: { 'src/a.js': 'old-a' } });
    const { h, call } = await startTurn(world, 's7', 't7');
    world.wt.set('src/a.js', 'committed-new-a');
    world.commitDuringTurn(); // 模型 host_exec 里 git commit 了：工作区 == 新 HEAD
    await call(() => h['undo.capture_batch']({ sessionId: 's7', turnId: 't7', round: 1, fullSnapshot: true }));
    await call(() => h['undo.turn_finalize']({ sessionId: 's7', turnId: 't7' }));

    const rb = await call(() => h['undo.rollback']({ sessionId: 's7', turnId: 't7' }));
    assert.match(rb.warning || '', /HEAD 变过/, '提交过的改动没被撤回必须说出来');
  });

  it('回合开始树只在 turn_begin 建一次：每批 capture_batch 不许再跑 stash create / ls-files', async () => {
    const world = makeWorld({ tree: { 'src/a.js': 'old-a' } });
    const { h, call } = await startTurn(world, 's8', 't8');
    assert.equal(world.counters().stashCreate, 1);
    assert.equal(world.counters().lsFiles, 1);
    for (let round = 1; round <= 3; round += 1) {
      world.wt.set(`src/f${round}.js`, 'x');
      // capture_batch 只补脏文件内容（git 策略下直接跳过），不该再建树
      await call(() => h['undo.capture_batch']({ sessionId: 's8', turnId: 't8', round }));
    }
    assert.equal(world.counters().stashCreate, 1, 'capture_batch 又跑了一次 stash create（会堆积不可达 commit）');
    assert.equal(world.counters().lsFiles, 1, 'capture_batch 又跑了一次 ls-files');
  });

  it('复核还有残留 → ok:false、明确报错、不提交撤回（可重试）', async () => {
    const world = makeWorld({
      tree: { 'src/a.js': 'old-a' },
      failCheckout: ['src/a.js']
    });
    const { h, call } = await startTurn(world, 's3', 't3');
    world.wt.set('src/a.js', 'shell-new-a');
    await call(() => h['undo.capture_batch']({ sessionId: 's3', turnId: 't3', round: 1, fullSnapshot: true }));
    await call(() => h['undo.turn_finalize']({ sessionId: 's3', turnId: 't3' }));

    const rb = await call(() => h['undo.rollback']({ sessionId: 's3', turnId: 't3' }));
    assert.equal(rb.ok, false, '没撤回干净就不许报成功');
    assert.equal(rb.committed, false, '没撤回干净就不许提交（提交了就没法重试）');
    assert.equal(world.wt.get('src/a.js'), 'shell-new-a');
    assert.deepEqual(rb.uncovered, ['src/a.js']);
    assert.match(rb.errors.map((e) => e.error).join(' '), /未能还原|checkout failed/);
  });

  it('不是 git 仓库 + 本轮用过 shell → 撤回不假成功，给出 warning', async () => {
    const world = makeWorld({ gitRepo: false, tree: {} });
    const { h, call, begin } = await startTurn(world, 's4', 't4');
    assert.equal(begin.strategy, 'snapshot');
    assert.equal(begin.gitStashSha, null);

    // fs 工具写（这里有真实的「改前内容」）
    world.wt.set('src/a.js', 'old-a');
    await call(() =>
      h['fs.write_file']({
        filePath: `${ROOT}/src/a.js`,
        data: 'fs-new-a',
        encoding: 'utf8',
        undoSessionId: 's4',
        undoTurnId: 't4'
      })
    );
    // shell 写（快照记不到）
    world.wt.set('src/b.js', 'shell-new-b');
    await call(() => h['undo.capture_batch']({ sessionId: 's4', turnId: 't4', round: 1, fullSnapshot: true }));
    await call(() => h['undo.turn_finalize']({ sessionId: 's4', turnId: 't4' }));

    const rb = await call(() => h['undo.rollback']({ sessionId: 's4', turnId: 't4' }));
    assert.equal(rb.ok, true);
    assert.equal(world.wt.get('src/a.js'), 'old-a', 'fs 工具的改动照旧能撤回');
    assert.match(rb.warning || '', /shell 命令/, 'shell 改动覆盖不到时必须明说');
  });
});

describe('回合开始树只在回合开始捕获（capture_batch 不许重复建）', () => {
  it('captureRemoteGitWorkingBaseline 默认不建树；带 turnStartState 才建', async () => {
    const { captureRemoteGitWorkingBaseline } = require('../../src/git/remote-baseline-capture');
    const world = makeWorld({ tree: { 'src/a.js': 'old-a' } });

    const plain = await captureRemoteGitWorkingBaseline(world.ssh, ROOT);
    assert.equal(plain.isGitRepo, true);
    assert.equal(plain.stashSha, '', '不带 turnStartState 时不该建树（capture_batch 每批都会调这个函数）');
    assert.equal(world.counters().stashCreate, 0);
    assert.equal(world.counters().lsFiles, 0);

    const start = await captureRemoteGitWorkingBaseline(world.ssh, ROOT, { turnStartState: true });
    assert.equal(start.stashSha, 'stashsha');
    assert.equal(world.counters().stashCreate, 1);
    assert.equal(world.counters().lsFiles, 1);
  });
});

describe('git diff --name-status -z 解析', () => {
  it('按 NUL 成对解析，中文 / 空格路径原样保留，并拒绝越界路径', () => {
    const payload = 'M\0src/a.js\0A\0new file.ts\0D\0文档/中文 说明.md\0M\0../escape.js\0';
    assert.deepEqual(parseNameStatus(payload), [
      { status: 'M', path: 'src/a.js' },
      { status: 'A', path: 'new file.ts' },
      { status: 'D', path: '文档/中文 说明.md' }
    ]);
  });

  it('C-quote 过的路径（没带 -z 的老数据）不会被误当成合法路径', () => {
    // 真实 git 不带 -z 时输出 `"\344\270\255..."`：这种串交给 checkout 必然匹配不到，
    // 所以解析层只接 NUL 口径 —— 这条用例防止有人把 `-z` 去掉。
    assert.deepEqual(parseNameStatus('M\t"\\344\\270\\255.js"\n'), []);
  });
});
