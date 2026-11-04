/* globals describe, it, expect */
'use strict';

/**
 * SSH 侧栏面板的刷新口径（`renderer-workspace-ssh.js`）。
 *
 * 钉三件事，都是「点一下卡一下、数据过一会儿才出来」的直接成因：
 * A. 一次点击只跑一轮刷新：重叠调用合并成「跑完再来一次」，不往 SSH 连接里
 *    排两条 tail / 两份远端 git status（连接内 exec 是串行的，排两条就是慢一倍）；
 * B. 远端三块互不等待：会话副本那趟就算一直不返回，agent.log 与索引 Agent 状态也照样刷完；
 * C. 预览途中切了会话，旧会话的结果不许写进面板（否则「应用改动到主目录」会指错副本）。
 *
 * 用真实脚本 + 注入全局（同 `renderer-session-workspace-tool.test.cjs` 的做法），不 mock 被测逻辑。
 */

const fs = require('node:fs');
const path = require('node:path');

const SRC = path.join(__dirname, '..', '..', 'src', 'renderer', 'renderer-workspace-ssh.js');

function flush(times = 4) {
  let p = Promise.resolve();
  for (let i = 0; i < times; i++) p = p.then(() => new Promise((r) => setImmediate(r)));
  return p;
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function stubEl(initial = '') {
  return { textContent: initial, title: '', hidden: false, className: '' };
}

function loadModule(opts = {}) {
  const els = {
    'composer-workspace-menu': stubEl(''),
    'ssh-panel-conn': stubEl('未连接'),
    'ssh-panel-host': stubEl('—'),
    'ssh-panel-dir': stubEl('—'),
    'ssh-panel-meta': stubEl('未连接'),
    'ssh-panel-rg-status': stubEl('—'),
    'ssh-panel-rg-log': stubEl(''),
    'ssh-panel-wt-path': stubEl('—'),
    'ssh-panel-wt-pending': stubEl('—')
  };
  const actionEls = {
    'worktree-apply': { hidden: true },
    'ssh-reconnect': { hidden: false },
    'remote-gateway-retry': { hidden: false }
  };
  const pane = {
    hidden: false,
    classList: { add() {}, remove() {} },
    getAttribute: () => 'ssh'
  };
  const sid = { value: opts.sessionId || 'sess-A' };
  const counters = {
    log: 0,
    preview: 0,
    logInFlight: 0,
    previewInFlight: 0,
    maxLogInFlight: 0,
    maxPreviewInFlight: 0
  };
  /** @type {Array<{promise: Promise<any>, resolve: Function, reject: Function}>} */
  const previewQueue = [];
  let logGate = null;

  const documentStub = {
    querySelector(sel) {
      const m = /^\[data-ws-action="([^"]+)"\]$/.exec(sel);
      if (m) return actionEls[m[1]] || null;
      if (sel === '.side-panel-pane[data-side-pane="ssh"]') return pane;
      return null; // rail 按钮不存在：updateSshPanelVisibility 只看 pane
    },
    querySelectorAll() {
      return [];
    },
    getElementById(id) {
      return els[id] || null;
    }
  };

  const wsApi = {
    getWorkspace: async () => ({
      kind: 'ssh',
      workspacePath: '/r/.dieyun/worktrees/sess-A/main',
      displayPath: '/r',
      sshConnected: true,
      ssh: { host: 'h', port: 22, username: 'u', remotePath: '/r' }
    }),
    sshStatus: async () => ({ connected: true }),
    sshRemoteGatewayStatus: async () => ({
      sshBackend: 'remote-gateway',
      packExists: true,
      remoteGateway: { active: true, socketPath: '/home/u/.dieyun/remote-agent/run/agent.sock' }
    }),
    sshRemoteAgentLog: async () => {
      counters.log += 1;
      counters.logInFlight += 1;
      counters.maxLogInFlight = Math.max(counters.maxLogInFlight, counters.logInFlight);
      try {
        if (logGate) await logGate.promise;
        return { ok: true, log: 'boot ok', path: '~/.dieyun/remote-agent/logs/agent.log' };
      } finally {
        counters.logInFlight -= 1;
      }
    },
    worktreeRemotePreview: () => {
      counters.preview += 1;
      const d = deferred();
      counters.previewInFlight += 1;
      counters.maxPreviewInFlight = Math.max(counters.maxPreviewInFlight, counters.previewInFlight);
      previewQueue.push(d);
      return d.promise.finally(() => {
        counters.previewInFlight -= 1;
      });
    },
    ...(opts.wsApi || {})
  };

  const source = fs.readFileSync(SRC, 'utf8');
  const factory = new Function(
    'window',
    'document',
    '$',
    'currentSessionId',
    'getSidePanelTab',
    `${source}
     return { refreshWorkspaceMenuItems, refreshSessionWorktreePanel, sessionWorktreePanelState };`
  );
  const window = { diecloud: wsApi };
  const mod = factory(
    window,
    documentStub,
    (id) => els[id] || null,
    // toString 走可变值：测「预览途中切会话」需要真的改 currentSessionId
    { toString: () => sid.value },
    () => 'ssh'
  );
  return {
    mod,
    els,
    actionEls,
    pane,
    counters,
    sid,
    /** 让第 n 个（0 基）预览调用返回结果 */
    resolvePreview(index, value) {
      const d = previewQueue[index];
      if (!d) throw new Error(`没有第 ${index} 个 preview 调用`);
      d.resolve(value);
    },
    previewCalls: () => previewQueue.length,
    setLogGate(gate) {
      logGate = gate;
    }
  };
}

const PREVIEW_A = {
  ok: true,
  wtPath: '/r/.dieyun/worktrees/sess-A/main',
  branch: 'dieyun/agent-sess-aaaa-main',
  files: [{ code: 'M', path: 'src/a.js' }]
};
const PREVIEW_B = {
  ok: true,
  wtPath: '/r/.dieyun/worktrees/sess-B/main',
  branch: 'dieyun/agent-sess-bbbb-main',
  files: [
    { code: 'M', path: 'src/b.js' },
    { code: 'A', path: 'src/c.js' }
  ]
};

describe('renderer/SSH 侧栏面板刷新', () => {
  it('重叠刷新合并成一轮 + 一次尾随，远端不并发（exec 在连接内串行）', async () => {
    const h = loadModule();
    const p1 = h.mod.refreshWorkspaceMenuItems();
    const p2 = h.mod.refreshWorkspaceMenuItems();
    // 重叠调用拿到同一轮，而不是再排一轮
    expect(p2).toBe(p1);
    await flush();
    expect(h.counters.preview).toBe(1);
    expect(h.counters.log).toBe(1);
    // 本地行先画：还没等远端返回就已经有值
    expect(h.els['ssh-panel-conn'].textContent).toBe('已连接');
    expect(h.els['ssh-panel-host'].textContent).toBe('u@h:22');
    expect(h.els['ssh-panel-wt-pending'].textContent).toBe('读取中…');

    h.resolvePreview(0, PREVIEW_A);
    await p1;
    await flush();
    // 被合并掉的那次在跑完后补一轮
    expect(h.counters.preview).toBe(2);
    expect(h.counters.maxPreviewInFlight).toBe(1);
    expect(h.counters.maxLogInFlight).toBe(1);

    h.resolvePreview(1, PREVIEW_A);
    await flush(6);
    expect(h.els['ssh-panel-wt-path'].textContent).toBe('sess-A/main');
    expect(h.els['ssh-panel-wt-pending'].textContent).toBe('1 个文件');
    expect(h.actionEls['worktree-apply'].hidden).toBe(false);
  });

  it('会话副本一趟不返回，也不挡 agent.log / 索引 Agent 状态', async () => {
    const h = loadModule();
    const gate = deferred();
    h.setLogGate(gate);
    const p = h.mod.refreshWorkspaceMenuItems();
    await flush();
    // 预览一直挂着，日志也没回：但索引 Agent 状态是本地 IPC，必须已经画出来
    expect(h.counters.preview).toBe(1);
    expect(h.els['ssh-panel-rg-status'].textContent).toContain('已启动');
    gate.resolve();
    await flush();
    expect(h.els['ssh-panel-rg-log'].textContent).toBe('boot ok');
    h.resolvePreview(0, PREVIEW_A);
    await p;
  });

  it('预览途中切了会话：旧结果不写进面板，按新会话重读', async () => {
    const h = loadModule({ sessionId: 'sess-A' });
    const first = h.mod.refreshSessionWorktreePanel(true);
    await flush();
    expect(h.counters.preview).toBe(1);

    // 切到 B：旧值清空，且不并发再发一趟
    h.sid.value = 'sess-B';
    await h.mod.refreshSessionWorktreePanel(true);
    expect(h.counters.preview).toBe(1);
    expect(h.els['ssh-panel-wt-path'].textContent).toBe('—');

    // A 的结果姗姗来迟：不许写成当前会话的副本
    h.resolvePreview(0, PREVIEW_A);
    await first;
    await flush();
    expect(h.els['ssh-panel-wt-path'].textContent).toBe('—');
    expect(h.actionEls['worktree-apply'].hidden).toBe(true);
    // 尾随一轮按 B 重读
    expect(h.counters.preview).toBe(2);

    h.resolvePreview(1, PREVIEW_B);
    await flush(6);
    expect(h.els['ssh-panel-wt-path'].textContent).toBe('sess-B/main');
    expect(h.els['ssh-panel-wt-pending'].textContent).toBe('2 个文件');
    expect(h.actionEls['worktree-apply'].hidden).toBe(false);
  });

  it('读不到副本状态时收起「应用改动」按钮（前提无法验证就不给动作）', async () => {
    const h = loadModule();
    const p = h.mod.refreshSessionWorktreePanel(true);
    await flush();
    h.resolvePreview(0, { ok: true, wtPath: '/r/.dieyun/worktrees/sess-A/main', files: [{ code: 'M', path: 'a' }] });
    await p;
    await flush();
    expect(h.actionEls['worktree-apply'].hidden).toBe(false);

    const p2 = h.mod.refreshSessionWorktreePanel(true);
    await flush();
    h.resolvePreview(1, { ok: false, code: 'ssh_not_connected', error: 'SSH 未连接', files: [] });
    await p2;
    await flush();
    expect(h.actionEls['worktree-apply'].hidden).toBe(true);
  });
});
