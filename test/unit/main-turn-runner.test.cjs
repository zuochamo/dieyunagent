/* globals describe, it, expect, beforeEach, afterEach */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  runMainTurn,
  resolveTurnModel,
  buildTurnSnapshot,
  userError
} = require('../../src/agent/main-turn-runner');

function tmpUserData() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mt-runner-'));
  return dir;
}

/** 记录 RPC 调用；会话/历史类返回最小值 */
function makeGateway(sink, extra = {}) {
  return {
    getPermissions: () => ({ sandboxMode: 'workspace-write' }),
    invokeRpc: async (method, args) => {
      sink.push([method, args]);
      if (method === 'memory.messages_recent') return [];
      if (method === 'codebase.status') return { indexed: false };
      return { ok: true };
    },
    ...extra
  };
}

describe('agent/main-turn-runner', () => {
  let userData;

  beforeEach(() => {
    userData = tmpUserData();
  });

  afterEach(() => {
    try {
      fs.rmSync(userData, { recursive: true, force: true });
    } catch {
      // 临时目录清理失败不影响判定
    }
  });

  it('会话未就绪时直接拒绝：调用方必须先建会话', async () => {
    await expect(
      runMainTurn({ userData, gateway: makeGateway([]), coreBridge: { isReady: () => true }, sessionId: '' })
    ).rejects.toThrow(/会话未就绪/);
  });

  it('core 未就绪：文案可直出给用户（userSafe），且不写任何账本', async () => {
    const calls = [];
    await expect(
      runMainTurn({
        userData,
        gateway: makeGateway(calls),
        coreBridge: { isReady: () => false },
        sessionId: 's-1',
        userText: 'hi'
      })
    ).rejects.toThrow(/dieyun-core 未就绪/);
    expect(calls).toHaveLength(0);
  });

  it('缺模型配置时在写用户轮次之前失败：不留半条没有回复的轮次', async () => {
    const calls = [];
    const err = await runMainTurn({
      userData,
      gateway: makeGateway(calls),
      coreBridge: { isReady: () => true },
      sessionId: 's-1',
      userText: 'hi'
    }).catch((e) => e);
    expect(err.message).toMatch(/未配置 API Key/);
    expect(err.userSafe).toBe(true);
    // 失败的只有 codebase/权限探测之外的写入：一条 message_append 都不该有
    expect(calls.filter(([m]) => m === 'memory.message_append')).toHaveLength(0);
  });

  it('Gateway 不可用时不假装跑过一轮', async () => {
    await expect(
      runMainTurn({ userData, gateway: null, coreBridge: { isReady: () => true }, sessionId: 's-1' })
    ).rejects.toThrow(/Gateway 未就绪/);
  });

  it('resolveTurnModel：没有可用供应商模型时明确报错（不静默兜底）', () => {
    expect(() => resolveTurnModel({ userData })).toThrow(/未配置 API Key/);
  });

  it('buildTurnSnapshot：无编辑器上下文，工作空间类型按本地/远端判定', async () => {
    const calls = [];
    const local = await buildTurnSnapshot({
      gateway: makeGateway(calls),
      sessionId: 's-1',
      workspacePath: '/srv/repo',
      userQuery: 'hi'
    });
    expect(local.workspaceInfo).toEqual({ workspacePath: '/srv/repo', kind: 'local' });
    expect(local.includeEditor).toBe(false);
    expect(local.editor).toEqual({ hasActiveFile: false, hasSelection: false, hasArtifact: false });
    expect(local.indexOk).toBe(false);

    const remote = await buildTurnSnapshot({
      gateway: makeGateway(calls),
      sessionId: 's-1',
      workspacePath: 'ssh:/srv/repo',
      userQuery: 'hi'
    });
    expect(remote.workspaceInfo.kind).toBe('ssh');
  });

  it('userError 标记 userSafe：调用方据此决定能不能把文案原样发给用户', () => {
    expect(userError('x').userSafe).toBe(true);
    expect(new Error('x').userSafe).toBeUndefined();
  });
});
