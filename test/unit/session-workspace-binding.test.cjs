'use strict';

/**
 * 会话工作空间绑定：外部频道（手机桥 / 企微转接器）跑任务时不许跑错目录、也不许被桌面改写。
 *
 * 复现的事故（issues/2026-10-30-agent-channel-and-workspace-binding.md 问题 2）：
 * `task.submit` 让 Renderer 把自己的视图切到外部会话时，`currentSessionId` 先行指向新会话，
 * 而 `activeViewSessionWorkspacePath` 还是上一个（桌面）会话的路径。旧实现只看
 * 「sid === currentSessionId 相等」就把视图路径当成该会话的绑定 —— 于是
 *   1) 本轮 Agent 跑在桌面目录；2) 该错值经 send 流程写回会话行（2 秒轮询看到翻转）。
 *
 * 这里钉住三件事：
 * A. `resolveSessionWorkspacePathSync` 只认「视图路径属于这个会话」的那一份（视图对）；
 * B. 会话自己的绑定（缓存/落库值）永远优先于视图；
 * C. `applySessionWorkspace` 在没有可信 hint 时读库，并把视图对更新为目标会话；
 * D. `task.submit` 的 `workspacePath`：显式声明即可落库（能纠正存量会话），
 *    未声明时按「提交这一刻」的桌面工作空间钉住，绝不覆盖已有绑定。
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const COMPOSER_SRC = path.join(__dirname, '..', '..', 'src', 'renderer', 'renderer-composer.js');
const SKILLS_UI_SRC = path.join(__dirname, '..', '..', 'src', 'renderer', 'renderer-skills-ui.js');

const DESKTOP_SID = 'sess-desktop';
const DESKTOP_WS = 'F:\\定时任务\\指标汇总报告';
const WECOM_SID = 'sess-wecom';
const WECOM_WS = 'F:\\微信Agent对话';

/**
 * 用 `new Function` 加载 renderer-composer.js（纯浏览器脚本，没有 module.exports），
 * 只注入它真正会摸到的全局。
 */
function loadComposer(overrides = {}) {
  const win = overrides.window || {
    diecloud: {
      setActiveSessionWorkspace: async () => ({ ok: true }),
      getWorkspace: async () => ({ kind: 'local', workspacePath: null })
    }
  };
  const labelCalls = [];
  const rpcCalls = [];
  const sessionGetRows = overrides.sessionGetRows || {};
  const gatewayCall =
    overrides.gatewayCall ||
    (async (method, params) => {
      rpcCalls.push([method, params]);
      if (method === 'memory.session_get') {
        const row = sessionGetRows[params && params.sessionId];
        if (!row) throw new Error('no session');
        return row;
      }
      return { ok: true };
    });
  const source = fs.readFileSync(COMPOSER_SRC, 'utf8');
  const factory = new Function(
    'window',
    'gwState',
    'gatewayCall',
    'currentSessionId',
    'sessionActiveRuns',
    'updateWorkspaceLabel',
    'refreshHistoryList',
    'isActiveSessionSwitch',
    'invalidateWorkspaceArtifacts',
    `${source}
    return {
      rememberActiveViewSessionWorkspace,
      rememberSessionWorkspacePath,
      resolveSessionWorkspacePath,
      resolveSessionWorkspacePathSync,
      applySessionWorkspace,
      bindCurrentSessionWorkspace
    };`
  );
  const api = factory(
    win,
    overrides.gwState || { authed: true },
    gatewayCall,
    overrides.currentSessionId === undefined ? DESKTOP_SID : overrides.currentSessionId,
    new Map(),
    (ws) => labelCalls.push(ws),
    async () => {},
    () => true,
    () => {}
  );
  return { ...api, win, labelCalls, rpcCalls };
}

describe('会话工作空间：视图路径只属于它显示的那个会话', () => {
  it('切到外部会话时，不再把桌面会话的视图路径当成它的绑定', () => {
    const c = loadComposer();
    // 桌面正在显示 DESKTOP_WS，currentSessionId 已经指向外部会话（切换中的真实瞬时状态）
    c.rememberActiveViewSessionWorkspace(DESKTOP_SID, DESKTOP_WS, 'local');
    c.win.activeViewSessionWorkspacePath === DESKTOP_WS;

    // 旧实现在这里返回 DESKTOP_WS（事故根因）
    assert.equal(c.resolveSessionWorkspacePathSync(WECOM_SID), null);
    // 视图会话自己仍然命中
    assert.equal(c.resolveSessionWorkspacePathSync(DESKTOP_SID), DESKTOP_WS);
  });

  it('会话自己的绑定优先于视图', () => {
    const c = loadComposer();
    c.rememberActiveViewSessionWorkspace(DESKTOP_SID, DESKTOP_WS, 'local');
    c.rememberSessionWorkspacePath(WECOM_SID, WECOM_WS);
    assert.equal(c.resolveSessionWorkspacePathSync(WECOM_SID), WECOM_WS);
  });

  it('视图没有归属会话时（清空）不提供任何回退', () => {
    const c = loadComposer();
    c.rememberActiveViewSessionWorkspace(null, DESKTOP_WS, 'local');
    assert.equal(c.resolveSessionWorkspacePathSync(DESKTOP_SID), null);
  });
});

describe('applySessionWorkspace：读库得到会话自己的绑定，并更新视图对', () => {
  it('缓存未命中时按会话行落地，标签带上 sessionId', async () => {
    let labelPayload = null;
    const c = loadComposer({
      sessionGetRows: { [WECOM_SID]: { id: WECOM_SID, workspacePath: WECOM_WS } }
    });
    c.win.activeViewSessionWorkspacePath = DESKTOP_WS;
    c.win.activeViewSessionWorkspaceSessionId = DESKTOP_SID;
    c.win.diecloud.getWorkspace = async () => ({ kind: 'local', workspacePath: WECOM_WS });
    c.rememberActiveViewSessionWorkspace(DESKTOP_SID, DESKTOP_WS, 'local');

    const r = await c.applySessionWorkspace(WECOM_SID, {
      skipDefaultEditor: true
      // 关键：切换时不再传「上一个会话的视图路径」当已知绑定（旧代码在 performSwitchSession
      // 里把 resolveSessionWorkspacePathSync 的结果当 hint 传下来，那正是碰巧命中的旧路径）
    });
    assert.equal(r.sameWorkspace, false);
    labelPayload = c.labelCalls[c.labelCalls.length - 1];
    assert.equal(labelPayload.sessionId, WECOM_SID);
    assert.equal(labelPayload.workspacePath, WECOM_WS);
    assert.equal(c.resolveSessionWorkspacePathSync(WECOM_SID), WECOM_WS);
  });

  it('缓存里已有该会话的绑定就不再查库（渲染端不重复打断主进程）', async () => {
    const c = loadComposer({
      sessionGetRows: { [WECOM_SID]: { id: WECOM_SID, workspacePath: WECOM_WS } }
    });
    c.rememberSessionWorkspacePath(WECOM_SID, WECOM_WS);
    await c.applySessionWorkspace(WECOM_SID, { skipDefaultEditor: true });
    const gets = c.rpcCalls.filter(([m]) => m === 'memory.session_get');
    assert.equal(gets.length, 0);
    assert.equal(c.resolveSessionWorkspacePathSync(WECOM_SID), WECOM_WS);
  });
});

describe('updateWorkspaceLabel：视图路径与会话 id 必须成对写', () => {
  /** 只取这一个函数（skills-ui 整份脚本依赖 grid UI 的全局，单测里没必要全量加载） */
  function extractFunction(source, name) {
    const start = source.indexOf(`function ${name}(`);
    assert.ok(start >= 0, `${name} 存在于源码`);
    const open = source.indexOf('{', start);
    let depth = 0;
    for (let i = open; i < source.length; i += 1) {
      if (source[i] === '{') depth += 1;
      else if (source[i] === '}') {
        depth -= 1;
        if (depth === 0) return source.slice(start, i + 1);
      }
    }
    throw new Error(`${name} 括号不闭合`);
  }

  function loadLabel() {
    const pairWrites = [];
    const win = {
      diecloud: {},
      rememberActiveViewSessionWorkspace: (sid, ws, kind) => pairWrites.push([sid, ws, kind])
    };
    const fnSource = extractFunction(fs.readFileSync(SKILLS_UI_SRC, 'utf8'), 'updateWorkspaceLabel');
    const factory = new Function(
      'window',
      'document',
      '$',
      'currentSessionId',
      'updateSshPanelVisibility',
      'touchAgentsMdForWorkspace',
      'refreshWorkspaceMutateHint',
      `${fnSource}
      return { updateWorkspaceLabel };`
    );
    const api = factory(
      win,
      { querySelector: () => null },
      () => null,
      DESKTOP_SID,
      () => {},
      () => {},
      () => {}
    );
    return { ...api, pairWrites };
  }

  it('默认落到当前视图会话', () => {
    const l = loadLabel();
    l.updateWorkspaceLabel({ kind: 'local', workspacePath: DESKTOP_WS });
    assert.deepEqual(l.pairWrites[0], [DESKTOP_SID, DESKTOP_WS, 'local']);
  });

  it('按会话刷新时以传入的 sessionId 为准（不是此刻的 currentSessionId）', () => {
    const l = loadLabel();
    l.updateWorkspaceLabel({ sessionId: WECOM_SID, kind: 'local', workspacePath: WECOM_WS });
    assert.deepEqual(l.pairWrites[0], [WECOM_SID, WECOM_WS, 'local']);
  });

  it('清空工作空间时视图不再代表任何会话', () => {
    const l = loadLabel();
    l.updateWorkspaceLabel({ workspacePath: null });
    assert.deepEqual(l.pairWrites[0], [DESKTOP_SID, null, null]);
  });
});

describe('task.submit 的工作空间参数（Main / agent-service）', () => {
  const { AgentService } = require('../../src/agent/service');

  function makeService({ rows = {}, desktopWorkspace = null } = {}) {
    const calls = [];
    const gateway = {
      getWorkspace: () => ({ workspacePath: desktopWorkspace }),
      invokeRpc: async (method, params) => {
        calls.push([method, params]);
        if (method === 'memory.session_get') {
          return rows[params.sessionId] || null;
        }
        if (method === 'memory.session_create') {
          return { id: 'sess-new' };
        }
        return { ok: true };
      }
    };
    const svc = new AgentService({ gateway });
    svc.setDesktopExecutor(() => {});
    return { svc, calls };
  }

  it('显式 workspacePath：新建会话时写进 session_create（不再硬编码 null）', async () => {
    const { svc, calls } = makeService({ desktopWorkspace: DESKTOP_WS });
    const r = await svc.submitTask({ text: '你好', workspacePath: WECOM_WS, title: '微信' });
    assert.equal(r.sessionId, 'sess-new');
    const create = calls.find(([m]) => m === 'memory.session_create');
    assert.equal(create[1].workspacePath, WECOM_WS);
  });

  it('显式 workspacePath：存量会话被纠正成声明值', async () => {
    const { svc, calls } = makeService({
      rows: { [WECOM_SID]: { id: WECOM_SID, workspacePath: DESKTOP_WS } }
    });
    await svc.submitTask({ text: '你好', sessionId: WECOM_SID, workspacePath: WECOM_WS });
    const set = calls.find(([m]) => m === 'memory.session_workspace_set');
    assert.deepEqual(set[1], { sessionId: WECOM_SID, workspacePath: WECOM_WS });
  });

  it('显式 workspacePath 与已有绑定等价（大小写/斜杠不同）时不重复写', async () => {
    const { svc, calls } = makeService({
      rows: { [WECOM_SID]: { id: WECOM_SID, workspacePath: 'F:\\微信Agent对话' } }
    });
    await svc.submitTask({ text: '你好', sessionId: WECOM_SID, workspacePath: 'f:/微信Agent对话/' });
    assert.equal(calls.filter(([m]) => m === 'memory.session_workspace_set').length, 0);
  });

  it('未声明 workspacePath：按提交这一刻的桌面工作空间钉住未绑定会话', async () => {
    const { svc, calls } = makeService({
      rows: { [WECOM_SID]: { id: WECOM_SID, workspacePath: null } },
      desktopWorkspace: DESKTOP_WS
    });
    await svc.submitTask({ text: '你好', sessionId: WECOM_SID });
    const set = calls.find(([m]) => m === 'memory.session_workspace_set');
    assert.deepEqual(set[1], { sessionId: WECOM_SID, workspacePath: DESKTOP_WS });
  });

  it('未声明 workspacePath：不覆盖会话已有的绑定（桌面切目录不许拽走外部会话）', async () => {
    const { svc, calls } = makeService({
      rows: { [WECOM_SID]: { id: WECOM_SID, workspacePath: WECOM_WS } },
      desktopWorkspace: DESKTOP_WS
    });
    await svc.submitTask({ text: '你好', sessionId: WECOM_SID });
    assert.equal(calls.filter(([m]) => m === 'memory.session_workspace_set').length, 0);
  });

  it('未声明 workspacePath 且桌面没有工作空间：不写任何绑定', async () => {
    const { svc, calls } = makeService({
      rows: { [WECOM_SID]: { id: WECOM_SID, workspacePath: null } },
      desktopWorkspace: null
    });
    await svc.submitTask({ text: '你好', sessionId: WECOM_SID });
    assert.equal(calls.filter(([m]) => m === 'memory.session_workspace_set').length, 0);
  });
});
