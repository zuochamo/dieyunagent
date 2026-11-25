'use strict';

/**
 * 「哪台机器」只认**调用作用域**，不认视图作用域 —— handler 层的回归。
 *
 * 背景（2026-11-21 审查 P0）：`fs.read_symbol` / `lsp.*` 这 5 处以前读的是
 * `ctx.getWorkspaceTarget()`，那是**视图**（当前桌面在看哪个目录），而 `rpc.js` 的
 * `resolveCallWorkspaceTarget()` 才认「这次调用属于哪个会话 / 哪个 run」。
 * 两者在并行会话或显式传 sessionId 的频道/计划轮里可以不一样 —— 于是会出现
 * 「按视图判成本机 → 套本机白名单 / 不连远端 LSP，而真正读文件却走远端」。
 *
 * 这里不测具体分支结果，只钉住一条：**视图说本机、调用说 SSH 时，必须按 SSH 走。**
 */

const assert = require('node:assert/strict');
const { createFsHandlers } = require('../../src/gateway/handlers/fs');

const VIEW_LOCAL = { getWorkspaceTarget: () => ({ kind: 'local', path: '/view-dir' }) };
const CALL_SSH = () => ({ kind: 'ssh', remotePath: '/srv/app' });

function makeHandlers({ view, call }) {
  return createFsHandlers({
    perms: { hostControl: true, fsRead: true },
    ctx: view,
    resolveCallWorkspaceTarget: call,
    cwdForCall: () => '/srv/app',
    defaultCwd: '/srv/app',
    normalizeFilePathInput: (p) => String(p || ''),
    assertAllowedPath: (p) => p,
    readRootsForCall: () => ['/srv/app'],
    writeRootsForCall: () => [],
    resolveHostSidecarLocalPath: () => null,
    sidecarReadOpts: () => ({}),
    readSidecarFileAt: async () => null,
    listSidecarDirAt: async () => [],
    getRemoteFs: () => ({ readFile: async () => 'function foo() {\n  return 1;\n}\n' }),
    getRemoteAgentInfo: () => null,
    getRemoteAgentClient: () => ({ call: async () => ({ ok: true }) }),
    invokeIndexCore: async () => ({ results: [] }),
    resolveCodebaseContext: () => ({ rootHash: 'x' }),
    invokeRustCore: async () => null,
    readAllowedTextFile: async () => ({ data: 'function foo() {\n  return 1;\n}\n', path: '/srv/app/a.js' }),
    grepWorkspace: async () => ({ ok: true, matches: [], source: 'rg' }),
    globWorkspace: async () => ({ ok: true, files: [], source: 'rg' })
  });
}

describe('handler 的「哪台机器」取调用作用域', () => {
  it('视图=本机、调用=SSH → 按 SSH 处理（不套本机白名单）', async () => {
    const handlers = makeHandlers({ view: VIEW_LOCAL, call: CALL_SSH });
    const res = await handlers['fs.read_symbol']({ filePath: 'a.js', name: 'not_a_real_symbol' });
    // 找不到符号时的 degraded 标记就是「这条路是远端」的事实来源
    assert.equal(res.ok, false);
    assert.equal(res.degraded, true, '调用作用域是 SSH 时必须按远端降级语义回报');
  });

  it('视图=SSH、调用=本机 → 按本机处理（degraded 不为 true）', async () => {
    const handlers = makeHandlers({
      view: { getWorkspaceTarget: () => ({ kind: 'ssh', remotePath: '/view-ssh' }) },
      call: () => ({ kind: 'local', path: '/srv/app' })
    });
    const res = await handlers['fs.read_symbol']({ filePath: 'a.js', name: 'not_a_real_symbol' });
    assert.equal(res.ok, false);
    assert.notEqual(res.degraded, true, '调用作用域是本机时不许用远端的降级语义');
  });
});
