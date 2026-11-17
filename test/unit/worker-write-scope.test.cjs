'use strict';

/**
 * planner 并行 worker 的写作用域（`createWorkerWriteScope` / delegate 路径映射）。
 *
 * 这条边界是「多路写入子 Agent 能并行」的前提：没有它，模型用主工作区绝对路径
 * （system prompt 里写的就是它）就能绕过 worktree，等于两路同时改同一份文件。
 */

const path = require('path');
const {
  delegateAgentToolViaGateway,
  createWorkerWriteScope
} = require('../../src/agent/delegate-tool-gateway');

const WS = path.resolve(path.sep, 'ws');
const WT = path.join(WS, '.dieyun', 'worktrees', 'run1', 'A');

function fakeGateway() {
  const calls = [];
  return {
    calls,
    invokeRpc: async (method, params) => {
      calls.push({ method, params });
      return { ok: true };
    }
  };
}

function ctx(extra = {}) {
  return { workspacePath: WS, worktreePath: WT, sessionId: 's1', ...extra };
}

describe('worker 写作用域 · createWorkerWriteScope', () => {
  it('没有 worktreePath 时不启用作用域（普通对话 / 只读勘察 / 远端会话行为不变）', () => {
    expect(createWorkerWriteScope(WS, '')).toBeNull();
    expect(createWorkerWriteScope('ssh://host/srv/app', '')).toBeNull();
    // 远端工作区即便误传了 worktreePath 也不启用：本机 path.resolve 解析 POSIX 路径会得到假路径
    expect(createWorkerWriteScope('ssh://host/srv/app', '/srv/app/.wt')).toBeNull();
    // worktree 与工作区同一个目录（= 没有隔离）也不启用
    expect(createWorkerWriteScope(WS, WS)).toBeNull();
  });

  it('worktree 内原样、主工作区内重映射、两者之外拒绝', () => {
    const scope = createWorkerWriteScope(WS, WT);
    expect(scope).not.toBeNull();

    const insideWt = path.join(WT, 'src', 'a.js');
    expect(scope.map(insideWt)).toEqual({ path: insideWt });

    const insideWs = path.join(WS, 'src', 'a.js');
    expect(scope.map(insideWs)).toEqual({ path: path.join(WT, 'src', 'a.js') });

    const outside = path.resolve(path.sep, 'somewhere', 'else', 'a.js');
    const denied = scope.map(outside);
    expect(denied.denied.errorCode).toBe('WORKER_SCOPE_DENIED');
    expect(denied.denied.retryable).toBe(false);
    expect(String(denied.denied.error)).toContain(WT);
  });
});

describe('worker 写作用域 · 工具委托真的按它走', () => {
  it('fs_write_file 写主工作区绝对路径 → 落到 worktree 的同名相对路径', async () => {
    const gw = fakeGateway();
    const target = path.join(WS, 'src', 'a.js');
    await delegateAgentToolViaGateway(gw, 'fs_write_file', { filePath: target, content: 'x' }, ctx());
    expect(gw.calls[0].method).toBe('fs.write_file');
    expect(gw.calls[0].params.filePath).toBe(path.join(WT, 'src', 'a.js'));
  });

  it('fs_edit 的相对路径按 worktree 解析（模型写 workspace 相对路径也正确隔离）', async () => {
    const gw = fakeGateway();
    await delegateAgentToolViaGateway(
      gw,
      'fs_edit',
      { filePath: 'src/b.js', oldString: 'a', newString: 'b' },
      ctx()
    );
    expect(gw.calls[0].method).toBe('fs.edit_file');
    expect(gw.calls[0].params.filePath).toBe(path.join(WT, 'src', 'b.js'));
  });

  it('fs_write_file 目标在工作区之外 → 结构化拒绝，且不发起 RPC', async () => {
    const gw = fakeGateway();
    const outside = path.resolve(path.sep, 'somewhere', 'else.txt');
    const res = await delegateAgentToolViaGateway(
      gw,
      'fs_write_file',
      { filePath: outside, content: 'x' },
      ctx()
    );
    expect(res.errorCode).toBe('WORKER_SCOPE_DENIED');
    expect(gw.calls).toHaveLength(0);
  });

  it('host_exec 的绝对 cwd 同样收口（否则 cd 到主工作区即可绕过）', async () => {
    const gw = fakeGateway();
    await delegateAgentToolViaGateway(
      gw,
      'host_exec',
      { command: 'npm test', cwd: path.join(WS, 'pkg') },
      ctx()
    );
    expect(gw.calls[0].method).toBe('host.exec');
    expect(gw.calls[0].params.cwd).toBe(path.join(WT, 'pkg'));
  });

  it('浏览器落盘路径（screenshot filePath）也要落到 worktree', async () => {
    const gw = fakeGateway();
    await delegateAgentToolViaGateway(
      gw,
      'browser_screenshot',
      { filePath: path.join(WS, 'shot.png') },
      ctx()
    );
    expect(gw.calls[0].params.filePath).toBe(path.join(WT, 'shot.png'));
  });

  it('没有 worktreePath 时一切照旧（读写的路径不被改写）', async () => {
    const gw = fakeGateway();
    const target = path.join(WS, 'src', 'a.js');
    await delegateAgentToolViaGateway(
      gw,
      'fs_write_file',
      { filePath: target, content: 'x' },
      { workspacePath: WS, sessionId: 's1' }
    );
    expect(gw.calls[0].params.filePath).toBe(target);
  });
});

describe('worker 写作用域 · 写完必须能读回来（副本有就读副本）', () => {
  const fs = require('fs');
  const os = require('os');
  let root = '';
  let ws = '';
  let wt = '';

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'dieyun-worker-scope-'));
    ws = path.join(root, 'ws');
    wt = path.join(ws, '.dieyun', 'worktrees', 'run1', 'A');
    fs.mkdirSync(path.join(ws, 'src'), { recursive: true });
    fs.mkdirSync(path.join(wt, 'src'), { recursive: true });
  });

  afterEach(() => {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      /* 临时目录清理失败不影响断言 */
    }
  });

  it('副本里有的文件 → 读副本（否则「写完再读」会看到旧内容，模型会无限重试）', async () => {
    fs.writeFileSync(path.join(ws, 'src', 'a.js'), '主工作区的旧内容');
    fs.writeFileSync(path.join(wt, 'src', 'a.js'), '副本里的新内容');
    const gw = fakeGateway();
    await delegateAgentToolViaGateway(
      gw,
      'fs_read_file',
      { filePath: path.join(ws, 'src', 'a.js') },
      { workspacePath: ws, worktreePath: wt, sessionId: 's1' }
    );
    expect(gw.calls[0].method).toBe('fs.read_file');
    expect(gw.calls[0].params.filePath).toBe(path.join(wt, 'src', 'a.js'));
  });

  it('副本里没有的文件（未跟踪 / 构建产物）→ 读主工作区那一份', async () => {
    fs.writeFileSync(path.join(ws, 'src', 'vendor.js'), '只在主工作区');
    const gw = fakeGateway();
    await delegateAgentToolViaGateway(
      gw,
      'fs_read_file',
      { filePath: path.join(ws, 'src', 'vendor.js') },
      { workspacePath: ws, worktreePath: wt, sessionId: 's1' }
    );
    expect(gw.calls[0].params.filePath).toBe(path.join(ws, 'src', 'vendor.js'));
  });

  it('host_exec 的相对 cwd 也落到副本（不处理会被 Gateway 按主工作区解析）', async () => {
    const gw = fakeGateway();
    await delegateAgentToolViaGateway(
      gw,
      'host_exec',
      { command: 'npm test', cwd: 'src' },
      { workspacePath: ws, worktreePath: wt, sessionId: 's1' }
    );
    expect(gw.calls[0].method).toBe('host.exec');
    expect(gw.calls[0].params.cwd).toBe(path.join(wt, 'src'));
  });
});
