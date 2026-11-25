'use strict';

/**
 * 回归（2026-11-19 审计 P0-7）：`host_exec` 的命令正文也要受 worktree 写作用域约束。
 * `resolveExecCwdScoped` 只收口了 `cwd`；命令里的绝对路径会直接写到主工作区，
 * 绕过副本隔离与「变更」面板。这里只做一条**可解释的窄检查**：命令里出现主工作区根 → 拒。
 *
 * 两条「反过来会误伤自己」的边界（2026-11-21 修）：
 * 1. 本地 worktree 就建在主工作区里（`<ws>/.dieyun/worktrees/<runId>/<role>`），
 *    副本自己的绝对路径天然带主工作区前缀，不能拒；
 * 2. 按路径段边界匹配，`C:\ws\app` 不能命中 `C:\ws\app-data\...`。
 *
 * 另外拒绝必须是**摊平的错误信封**（`{ error, errorCode, retryable }`）：tool-harness 只认
 * `ok === false` / `error`，包一层 `{ denied: {…} }` 会让这次调用被记成成功、模型也看不到错误码。
 */

const path = require('path');
const {
  findMainWorkspacePathInCommand,
  delegateAgentToolViaGateway
} = require('../../src/agent/delegate-tool-gateway');

describe('worker 写作用域：命令正文里的主工作区路径', () => {
  const mainRoot = path.resolve('C:/ws/demo');
  const ownRoot = path.join(mainRoot, '.dieyun', 'worktrees', 'run-1', 'A');

  it('命中主工作区绝对路径（两种斜杠形态）', () => {
    expect(
      findMainWorkspacePathInCommand(`sed -i s/a/b/ ${mainRoot}\\src\\a.js`, mainRoot, ownRoot)
    ).not.toBe('');
    expect(
      findMainWorkspacePathInCommand(
        `cp x ${mainRoot.replace(/\\/g, '/')}/src/a.js`,
        mainRoot,
        ownRoot
      )
    ).not.toBe('');
  });

  it('大小写不敏感（Windows 路径常见）', () => {
    expect(
      findMainWorkspacePathInCommand(`del ${mainRoot.toUpperCase()}\\tmp.txt`, mainRoot, ownRoot)
    ).not.toBe('');
  });

  it('相对路径不误伤', () => {
    expect(findMainWorkspacePathInCommand('node scripts/build.js', mainRoot, ownRoot)).toBe('');
    expect(findMainWorkspacePathInCommand('npm test', mainRoot, ownRoot)).toBe('');
  });

  it('副本自己的绝对路径不误伤（副本就在主工作区里）', () => {
    expect(
      findMainWorkspacePathInCommand(`node ${ownRoot}\\scripts\\build.js`, mainRoot, ownRoot)
    ).toBe('');
    expect(findMainWorkspacePathInCommand(`git -C ${ownRoot} status`, mainRoot, ownRoot)).toBe('');
    expect(
      findMainWorkspacePathInCommand(
        `node ${ownRoot.replace(/\\/g, '/')}/scripts/build.js`,
        mainRoot,
        ownRoot
      )
    ).toBe('');
  });

  it('同一命令里既写副本又写主工作区别处 → 仍然拒', () => {
    expect(
      findMainWorkspacePathInCommand(
        `cp ${ownRoot}\\out.js ${mainRoot}\\src\\out.js`,
        mainRoot,
        ownRoot
      )
    ).not.toBe('');
  });

  it('同前缀的兄弟目录不算主工作区', () => {
    expect(findMainWorkspacePathInCommand(`ls ${mainRoot}-data\\x`, mainRoot, ownRoot)).toBe('');
    expect(findMainWorkspacePathInCommand(`ls ${mainRoot}data\\x`, mainRoot, ownRoot)).toBe('');
  });

  it('空命令 / 空根安全', () => {
    expect(findMainWorkspacePathInCommand('', mainRoot, ownRoot)).toBe('');
    expect(findMainWorkspacePathInCommand('ls', '', ownRoot)).toBe('');
  });
});

describe('worker 写作用域：host_exec 拒绝的形状', () => {
  const ws = path.resolve('C:/ws/demo');
  const wt = path.join(ws, '.dieyun', 'worktrees', 'run-1', 'A');
  const ctx = { workspacePath: ws, worktreePath: wt };

  it('命中主工作区路径时返回摊平错误信封，且不下发 RPC', async () => {
    const calls = [];
    const gateway = {
      invokeRpc: async (method, params) => {
        calls.push({ method, params });
        return { ok: true };
      }
    };
    const res = await delegateAgentToolViaGateway(
      gateway,
      'host_exec',
      { command: `sed -i s/a/b/ ${ws}\\src\\a.js` },
      ctx
    );
    expect(res && res.denied).toBeUndefined();
    expect(res.errorCode).toBe('WORKER_SCOPE_DENIED');
    expect(res.retryable).toBe(false);
    expect(String(res.error || '')).toContain('主工作区');
    expect(calls.length).toBe(0);
  });

  it('引用副本自己的绝对路径时放行到 RPC', async () => {
    const calls = [];
    const gateway = {
      invokeRpc: async (method, params) => {
        calls.push({ method, params });
        return { ok: true };
      }
    };
    const res = await delegateAgentToolViaGateway(
      gateway,
      'host_exec',
      { command: `node ${wt}\\scripts\\build.js` },
      ctx
    );
    expect(res && res.errorCode).toBeUndefined();
    expect(calls.length).toBe(1);
    expect(calls[0].method).toBe('host.exec');
  });
});
