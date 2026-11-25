/* globals describe, it, expect */
'use strict';

/**
 * 桌面侧 `session_set_workspace` 的执行体（Renderer 那一份）。
 *
 * 为什么要专门钉：这条工具的工作空间「真相」在渲染器（视图 + 会话绑定一起走
 * `applyLocalWorkspacePath`），而频道里同一个工具名由 Main 执行。两条实现一旦走散，
 * 就会出现「微信里换了、桌面没换」或「后台会话一换项目把用户正在看的目录也换掉」。
 *
 * 这里只验三件事（用真实脚本 + 注入全局，不 mock 自己的被测逻辑）：
 * A. 正常切换：调 setLocalWorkspace + 绑当前会话（bindCurrentSessionWorkspace）；
 * B. 传 "default" 时解绑（workspacePath 传 null）；
 * C. 工具属于后台会话（sessionId ≠ currentSessionId）时只改那条会话的绑定，不碰桌面视图。
 */

const fs = require('node:fs');
const path = require('node:path');

const SRC = path.join(__dirname, '..', '..', 'src', 'renderer', 'renderer-workspace-ssh.js');

function loadModule(overrides = {}) {
  const calls = [];
  const wsApi = {
    setLocalWorkspace: async (p) => {
      calls.push(['setLocalWorkspace', p]);
      return p ? { kind: 'local', workspacePath: p, displayPath: p } : { kind: 'local', workspacePath: null, displayPath: '' };
    },
    getWorkspace: async () => ({ kind: 'local', workspacePath: null, displayPath: '' }),
    ...(overrides.wsApi || {})
  };
  const bound = [];
  const source = fs.readFileSync(SRC, 'utf8');
  const factory = new Function(
    'window',
    'document',
    '$',
    'currentSessionId',
    'updateWorkspaceLabel',
    'invalidateWorkspaceArtifacts',
    'bindCurrentSessionWorkspace',
    'restartTerminalSession',
    'refreshWorkspaceScopedPanes',
    'renderArtifactsList',
    'refreshProductsPanelIfActive',
    'showAgentToast',
    'gatewayCall',
    `${source}
     return { applySessionWorkspaceFromTool, applyLocalWorkspacePath, pickLocalWorkspace };`
  );
  const window = {
    diecloud: wsApi,
    applySessionWorkspaceFromTool: null,
    // 候选匹配的纯函数（agent-bundle 在真实渲染器里注册为 DieyunWorkspaceCandidates）
    DieyunWorkspaceCandidates: require('../../src/agent/workspace-candidates'),
    ...(overrides.window || {})
  };
  const sessionRows = overrides.sessionRows || [
    { id: 's1', workspaceProjectPath: 'F:\\dieyundaizhang' },
    { id: 's2', workspaceProjectPath: 'F:\\dieyuntools' }
  ];
  const mod = factory(
    window,
    { querySelector: () => null },
    () => null,
    overrides.currentSessionId || 'sess-1',
    () => {},
    () => {},
    async (a, b) => {
      bound.push(b === undefined ? ['current', a] : [a, b]);
    },
    () => {},
    () => {},
    () => {},
    () => {},
    (t, b) => calls.push(['toast', t, b]),
    async (method, args) => {
      calls.push([method, args]);
      if (method === 'memory.sessions_list') return sessionRows;
      return { ok: true };
    }
  );
  return { mod, calls, bound, window };
}

/** 只取真正的「切空间」调用（会话列表查询是取候选，不算切换）。 */
function switchCalls(calls) {
  return calls.filter(([m]) => m === 'setLocalWorkspace');
}

describe('renderer/applySessionWorkspaceFromTool（桌面换工作空间）', () => {
  it('切到指定目录：设视图 + 绑当前会话', async () => {
    const { mod, calls, bound } = loadModule();
    const res = await mod.applySessionWorkspaceFromTool({ workspace: 'F:\\dieyundaizhang' });
    expect(res.ok).toBe(true);
    expect(res.workspacePath).toBe('F:\\dieyundaizhang');
    expect(switchCalls(calls)).toEqual([['setLocalWorkspace', 'F:\\dieyundaizhang']]);
    expect(bound).toEqual([['current', 'F:\\dieyundaizhang']]);
    // 必须说清「本轮上下文还是旧目录的」，否则模型会在同一轮继续用错目录
    expect(res.note).toContain('下一轮');
  });

  it('传 default 回到默认工作空间（解绑，不写空串路径）', async () => {
    const { mod, calls, bound } = loadModule();
    const res = await mod.applySessionWorkspaceFromTool({ workspace: 'default' });
    expect(res.ok).toBe(true);
    expect(switchCalls(calls)).toEqual([['setLocalWorkspace', null]]);
    expect(bound).toEqual([['current', null]]);
  });

  it('空参数不切换，返回候选清单（模型不知道有哪些项目时先看这个）', async () => {
    const { mod, calls } = loadModule();
    const res = await mod.applySessionWorkspaceFromTool({});
    expect(res.ok).toBe(false);
    expect(switchCalls(calls)).toEqual([]);
    expect(res.error).toContain('dieyundaizhang');
    expect(res.error).toContain('default');
  });

  it('只给项目名也能切（目录名唯一即认）', async () => {
    const { mod, calls, bound } = loadModule();
    const res = await mod.applySessionWorkspaceFromTool({ workspace: 'dieyuntools' });
    expect(res.ok).toBe(true);
    expect(res.workspacePath).toBe('F:\\dieyuntools');
    expect(switchCalls(calls)).toEqual([['setLocalWorkspace', 'F:\\dieyuntools']]);
    expect(bound).toEqual([['current', 'F:\\dieyuntools']]);
  });

  it('项目名匹配到多个时要求指明，不乱猜', async () => {
    const { mod, calls } = loadModule({
      sessionRows: [
        { id: 'a', workspaceProjectPath: 'F:\\dieyun' },
        { id: 'b', workspaceProjectPath: 'F:\\dieyun-server' }
      ]
    });
    // 「dieyun」精确命中目录名，仍按精确走；用子串才有歧义
    const res = await mod.applySessionWorkspaceFromTool({ workspace: 'diey' });
    expect(res.ok).toBe(false);
    expect(res.error).toContain('多个项目');
    expect(res.error).toContain('dieyun-server');
    expect(switchCalls(calls)).toEqual([]);
  });

  it('找不到的项目名给出候选，不硬切', async () => {
    const { mod, calls } = loadModule();
    const res = await mod.applySessionWorkspaceFromTool({ workspace: '没这个项目' });
    expect(res.ok).toBe(false);
    expect(res.error).toContain('找不到工作空间');
    expect(res.error).toContain('dieyundaizhang');
    expect(switchCalls(calls)).toEqual([]);
  });

  it('后台会话：只绑那条会话，不动桌面视图', async () => {
    const { mod, calls, bound } = loadModule({ currentSessionId: 'sess-desktop' });
    const res = await mod.applySessionWorkspaceFromTool({
      workspace: 'F:\\dieyuntools',
      sessionId: 'sess-background'
    });
    expect(res.ok).toBe(true);
    expect(switchCalls(calls)).toEqual([]);
    expect(bound).toEqual([['sess-background', 'F:\\dieyuntools']]);
  });

  it('当前对话有远程任务在跑时拒绝切换（不让视图与账本各说一套）', async () => {
    const { mod, calls, window } = loadModule();
    window.currentSessionHasActiveRemoteRun = () => true;
    const res = await mod.applySessionWorkspaceFromTool({ workspace: 'F:\\dieyuntools' });
    expect(res.ok).toBe(false);
    expect(res.error).toContain('远程任务');
    expect(switchCalls(calls)).toEqual([]);
  });
});
