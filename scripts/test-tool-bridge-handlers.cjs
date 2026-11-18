'use strict';

/**
 * 工具桥「执行体」直测：`tool-bridge-main.js#executeMainOnlyTool` 的 25 个 case。
 *
 * 为什么要有这个文件：这些 case 原先一行测试都没有（`scripts/` 全仓 0 引用），
 * 而它们承载的恰恰是「模型参数 → 域实现（ssh/actions、worktree/actions、plansStore、
 * session-goal、peer/coordinator、mcp/manage）→ 模型可见形状」的翻译层：
 * 翻译错了不会报错，只会让模型拿着错的东西继续干（少一个 remember 就永远连不上、
 * 少一个 force 就静默把租约断掉）。任何要动这块的改动，先让它绿。
 *
 * 依赖全部用**注入的假实现**（夹具与生产实现同接口），断言三件事：
 *   1. 参数翻译对不对（传下去的 payload 逐字段核对）；
 *   2. 形状转换对不对（返回给模型的字段）；
 *   3. 能力没装时是不是结构化错误（`*_UNAVAILABLE` + retryable:false），而不是抛异常。
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  createMainToolBridge,
  sanitizeToolResultForApi,
  isVisionImageReadRequest,
  fitVisionShotToBudget
} = require('../src/agent/tool-bridge-main');
const { getAgentLimits } = require('../src/agent/agent-limits');

const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'dieyun-bridge-handlers-'));
const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'dieyun-bridge-ws-'));

function ctx(extra = {}) {
  return { sessionId: 's-1', workspacePath, contextTierId: 'default', ...extra };
}

/**
 * 最小 Gateway 假体：只实现工具用到的 RPC，并把每次调用记下来（断言翻译层用）。
 * `session_goal_get` 返回 `{ goalJson }`，与 Rust 侧一致（见 goals/session-goal.js#loadGoal）。
 */
function makeGateway(opts = {}) {
  const calls = [];
  const goalJson = opts.goal ? JSON.stringify(opts.goal) : null;
  return {
    calls,
    methods: () => calls.map((c) => c.method),
    lastCall: (method) => calls.filter((c) => c.method === method).pop() || null,
    // 权限快照的真实形状（见 gateway/permissions-store.js）：摄像头默认关，测试按需显式开。
    getPermissions: () => opts.permissions || {},
    invokeRpc: async (method, params = {}) => {
      calls.push({ method, params });
      switch (method) {
        case 'memory.session_goal_get':
          return { goalJson };
        case 'memory.session_goal_put':
          return { ok: true };
        case 'memory.messages_search':
          return opts.messages || { results: [], mode: 'keyword' };
        case 'memory.compaction_folded':
          return opts.folded || { results: [] };
        case 'memory.long_recall':
          return opts.longRecall || { results: [] };
        case 'memory.long_status_set':
          return { ok: true };
        case 'fs.read_file':
          return opts.fileRead || { data: '' };
        default:
          return { ok: true };
      }
    },
    stop: async () => {}
  };
}

function makeBridge(overrides = {}) {
  const deps = { userDataPath, ...(overrides.deps || {}) };
  if (!deps.gateway) deps.gateway = overrides.gateway || makeGateway(overrides.gatewayOpts || {});
  return createMainToolBridge(deps);
}

async function main() {
  // ─────────────────────────── ssh ───────────────────────────
  {
    const bridge = makeBridge({ deps: { sshActions: null } });
    const r = await bridge.executeAgentTool('ssh', { action: 'list' }, ctx());
    assert.strictEqual(r.ok, false, 'ssh 未装配时 ok=false');
    assert.strictEqual(r.errorCode, 'SSH_UNAVAILABLE', 'ssh 未装配时给结构化错误码');
  }
  {
    const calls = [];
    const sshActions = {
      listTargets: () => ({
        connected: true,
        host: 'prod',
        configAliases: [{ alias: 'prod' }],
        note: 'connect 用 profile'
      }),
      status: () => ({ connected: false }),
      home: async () => ({ ok: true, home: '/home/me' }),
      browse: async (p) => ({ entries: [{ name: 'a' }], listedPath: p }),
      useWorkspace: (p) => {
        calls.push(['useWorkspace', p]);
        return { kind: 'ssh', remotePath: p };
      },
      connect: async (p) => {
        calls.push(['connect', p]);
        if (p.host === 'hostkey') {
          return { ok: false, connected: false, needHostKeyTrust: true, fingerprint: 'SHA256:abc', host: 'h', username: 'u' };
        }
        return { ok: true, resolved: { host: 'h', username: 'u' }, credentialsWarning: '' };
      },
      disconnect: async (o) => {
        calls.push(['disconnect', o]);
        return { ok: true, forced: !!o.force };
      },
      portForwardAdd: async (p) => {
        calls.push(['pfAdd', p]);
        return { ok: true, forward: { id: 'f-1' } };
      },
      portForwardRemove: async (p) => {
        calls.push(['pfRemove', p]);
        return { ok: true };
      },
      portForwardList: () => ({ ok: true, forwards: [{ id: 'f-1' }] })
    };
    const bridge = makeBridge({ deps: { sshActions } });

    const list = await bridge.executeAgentTool('ssh', { action: 'list' }, ctx());
    assert.strictEqual(list.ok, true, 'ssh list ok');
    assert.strictEqual(list.configAliases.length, 1, 'ssh list 透传别名');

    // connect 必须带 remember/useSaved：少了这两项，connect-payload 不会去凭据库取密码。
    await bridge.executeAgentTool('ssh', { action: 'connect', profile: 'prod' }, ctx());
    const conn = calls.find((c) => c[0] === 'connect')[1];
    assert.strictEqual(conn.remember, true, 'ssh connect 必须 remember:true');
    assert.strictEqual(conn.useSaved, true, 'ssh connect 必须 useSaved:true');
    assert.strictEqual(conn.host, 'prod', 'ssh connect profile 走 host');
    assert.strictEqual(conn.acceptNewHostKey, false, 'ssh connect 默认不替人信任指纹');

    // 首次连接：指纹必须留在 error/suggestedFix 里（信封会收窄字段），且不可重试。
    const trust = await bridge.executeAgentTool('ssh', { action: 'connect', host: 'hostkey' }, ctx());
    assert.strictEqual(trust.ok, false, 'hostkey 未信任 → 失败');
    assert.strictEqual(trust.errorCode, 'SSH_HOST_KEY_UNTRUSTED', 'hostkey 未信任 → 专用错误码');
    assert.ok(String(trust.error).includes('SHA256:abc'), '指纹必须能到模型眼前');
    assert.strictEqual(trust.retryable, false, 'hostkey 未信任不可自动重试（要问人）');

    const uw = await bridge.executeAgentTool('ssh', { action: 'use_workspace', remotePath: '/srv/app' }, ctx());
    assert.strictEqual(calls.filter((c) => c[0] === 'useWorkspace').pop()[1], '/srv/app', 'use_workspace 透传路径');
    assert.ok(String(uw.note || '').includes('远端'), 'use_workspace 要说清后续 fs 作用于远端');

    const pfAdd = await bridge.executeAgentTool(
      'ssh',
      { action: 'port_forward', forwardAction: 'add', remotePort: 5432, localPort: 0 },
      ctx()
    );
    assert.strictEqual(pfAdd.ok, true, 'port_forward add ok');
    assert.deepStrictEqual(
      { localPort: calls.filter((c) => c[0] === 'pfAdd').pop()[1].localPort },
      { localPort: 0 },
      '本地端口 0（自动分配）必须原样传下去'
    );

    const pfList = await bridge.executeAgentTool('ssh', { action: 'port_forward' }, ctx());
    assert.strictEqual(pfList.forwards.length, 1, 'port_forward 默认 list');

    const disc = await bridge.executeAgentTool('ssh', { action: 'disconnect', force: true }, ctx());
    assert.strictEqual(calls.filter((c) => c[0] === 'disconnect').pop()[1].force, true, 'disconnect 透传 force');
    assert.strictEqual(disc.ok, true, 'disconnect ok');

    const home = await bridge.executeAgentTool('ssh', { action: 'home' }, ctx());
    assert.strictEqual(home.home, '/home/me', 'ssh home 透传');

    // 校验关卡先于执行：缺 remotePath 时不该调到 useWorkspace。
    const before = calls.length;
    const bad = await bridge.executeAgentTool('ssh', { action: 'use_workspace' }, ctx());
    assert.strictEqual(bad.ok, false, 'use_workspace 缺 remotePath → 失败');
    assert.strictEqual(calls.length, before, '校验不通过时不得进入执行体');
  }

  // ───────────────────────── worktree ─────────────────────────
  {
    const bridge = makeBridge({ deps: { worktreeActions: null } });
    const r = await bridge.executeAgentTool('worktree', { action: 'list' }, ctx());
    assert.strictEqual(r.errorCode, 'WORKTREE_UNAVAILABLE', 'worktree 未装配 → 结构化错误');
  }
  {
    const seen = {};
    const worktreeActions = {
      list: async () => ({ worktrees: [{ path: 'wt-1' }] }),
      listManaged: async () => ({ runs: [{ runId: 'r1' }] }),
      create: async (o) => {
        seen.create = o;
        return { ok: true, path: 'wt-new' };
      },
      remove: async (o) => {
        seen.remove = o;
        return { ok: true };
      },
      previewRun: async (o) => {
        seen.preview = o;
        return { ok: true, changes: [] };
      },
      applyRun: async (o) => {
        seen.apply = o;
        return { ok: true, applied: 1 };
      },
      cleanupRun: async (o) => {
        seen.cleanup = o;
        return { ok: true };
      },
      pruneBranches: async (o) => {
        seen.prune = o;
        return { ok: true, pruned: 2 };
      }
    };
    const bridge = makeBridge({ deps: { worktreeActions } });

    await bridge.executeAgentTool('worktree', { action: 'create', runId: 'r1', roleId: 'fixer' }, ctx());
    assert.deepStrictEqual(seen.create, { runId: 'r1', roleId: 'fixer', baseRef: undefined }, 'create 只传 runId/roleId/baseRef');

    await bridge.executeAgentTool('worktree', { action: 'apply_run', runId: 'r1', paths: ['a.js'] }, ctx());
    assert.strictEqual(seen.apply.forceConflict, false, 'apply_run 默认不强制覆盖冲突');
    assert.strictEqual(seen.apply.allowOverwriteMainDirty, false, 'apply_run 默认不覆盖主区改动');
    assert.deepStrictEqual(seen.apply.paths, ['a.js'], 'apply_run 透传 paths');

    await bridge.executeAgentTool('worktree', { action: 'cleanup_run', runId: 'r1' }, ctx());
    assert.strictEqual(seen.cleanup.archive, true, 'cleanup_run 默认先存档');
    assert.strictEqual(seen.cleanup.deleteBranches, false, 'cleanup_run 默认不删分支');

    // prune 的 keep 必须从参数来（省略 = 0 = 全删已合并分支），不能被 schema 外的字段顶掉。
    await bridge.executeAgentTool('worktree', { action: 'prune', keep: 5 }, ctx());
    assert.strictEqual(seen.prune.keep, 5, 'prune 透传 keep');

    const noPath = await bridge.executeAgentTool('worktree', { action: 'remove' }, ctx());
    assert.strictEqual(noPath.ok, false, 'worktree remove 缺 path → 失败');
    assert.strictEqual(noPath.errorCode, 'MISSING_PATH', 'worktree remove 缺 path → MISSING_PATH（缺路径类字段统一这个码）');
  }

  // ───────────────────────── goal（会话目标）─────────────────────────
  {
    const bridge = makeBridge({});
    const r = await bridge.executeAgentTool('goal_start', { objective: 'x' }, ctx({ sessionId: '' }));
    assert.strictEqual(r.errorCode, 'NO_SESSION', 'goal_start 没有会话上下文 → NO_SESSION');
  }
  {
    const gw = makeGateway();
    const bridge = makeBridge({ gateway: gw });
    const r = await bridge.executeAgentTool(
      'goal_start',
      { objective: '把登录页改完', checks: [{ command: 'npm test' }] },
      ctx()
    );
    assert.strictEqual(r.ok, true, 'goal_start ok');
    assert.strictEqual(r.created, true, 'goal_start created');
    assert.deepStrictEqual(r.checks, ['npm test'], 'checks 以命令串回给模型');
    const put = gw.lastCall('memory.session_goal_put');
    assert.ok(put, 'goal_start 必须落库一次');
    const blob = JSON.parse(put.params.goalJson);
    assert.strictEqual(blob.goal.cwd, workspacePath, 'cwd 缺省取会话工作空间');
    assert.strictEqual(blob.status, 'active', '新目标 status=active');
  }
  {
    // 已在跑的目标：不能重开（一个会话只有一个），要把现有目标回给模型。
    const gw = makeGateway({
      goal: {
        goal: { objective: '旧目标', checks: [{ command: 'npm test' }], todos: [], cwd: '' },
        status: 'active',
        attempt: 3,
        evidence: [],
        claims: [],
        startedAt: new Date().toISOString()
      }
    });
    const bridge = makeBridge({ gateway: gw });
    const r = await bridge.executeAgentTool('goal_start', { objective: '新目标' }, ctx());
    assert.strictEqual(r.ok, true, '已有进行中目标时仍 ok');
    assert.strictEqual(r.created, false, '不重开');
    assert.strictEqual(r.existing, true, '标记 existing');
    assert.strictEqual(r.attempt, 3, '轮次来自现有目标');
  }
  {
    // 计划目标轮里不许起会话目标（否则每轮注入两条互相矛盾的「本轮目标」）。
    const bridge = makeBridge({});
    const r = await bridge.executeAgentTool('goal_start', { objective: 'x' }, ctx({ planId: 'p-1' }));
    assert.strictEqual(r.errorCode, 'PLAN_GOAL_READONLY', '计划目标轮里 goal_start 被拒');
  }
  {
    // goal_finish：声明了检查却没有任何事实 → 打回，且把事实回灌给模型。
    const gw = makeGateway({
      goal: {
        goal: { objective: '跑通构建', checks: [{ command: 'npm run build' }], todos: [], cwd: '' },
        status: 'active',
        attempt: 2,
        evidence: [],
        claims: [],
        startedAt: new Date().toISOString()
      }
    });
    const bridge = makeBridge({ gateway: gw });
    const rejected = await bridge.executeAgentTool('goal_finish', { outcome: 'complete' }, ctx());
    assert.strictEqual(rejected.ok, true, 'goal_finish 本身不报错（是判定结果）');
    assert.strictEqual(rejected.accepted, false, '没有事实支撑的完成申请必须被打回');
    assert.ok(rejected.reason && rejected.facts, '打回要带原因与事实');
    assert.ok(gw.lastCall('memory.session_goal_put'), '主张必须落库（可追溯）');
  }
  {
    // 计划目标轮里 goal_update 只更新会话目标：计划目标的验收面在「自动化」里，这里必须拒。
    const bridge = makeBridge({
      deps: {
        plansStore: {
          get: (id) => ({ id, attempt: 1, goal: { objective: '计划目标', checks: [], cwd: '' }, evidence: [], claims: [] })
        }
      }
    });
    const r = await bridge.executeAgentTool('goal_update', { todos: [{ text: 'a', done: true }] }, ctx({ planId: 'p-1' }));
    assert.strictEqual(r.errorCode, 'PLAN_GOAL_READONLY', '计划目标轮里 goal_update 只更新会话目标 → 拒');
  }

  // ───────────────────────── plan ─────────────────────────
  {
    const bridge = makeBridge({ deps: { plansStore: null, plansCreateFromText: null } });
    assert.strictEqual((await bridge.executeAgentTool('plan_list', {}, ctx())).error, '计划 API 不可用');
    assert.strictEqual((await bridge.executeAgentTool('plan_create', { prompt: 'x' }, ctx())).error, '计划 API 不可用');
  }
  {
    const created = [];
    const plansStore = {
      plans: [
        {
          id: 'p1',
          name: '每日巡检',
          enabled: true,
          trigger: 'goal',
          goal: { objective: '巡检', checks: [{ command: 'npm test' }], cwd: '/w' },
          attempt: 2,
          outcome: null,
          evidence: [{ command: 'npm test', ok: false, exitCode: 1, at: '2026-11-17T00:00:00Z' }],
          model: 'm1',
          modelRoute: 'r1',
          deliver: { sessionId: 's-9' },
          workspace: '/w'
        }
      ],
      list: () => plansStore.plans,
      get: (id) => plansStore.plans.find((p) => p.id === id) || null,
      delete: (id) => created.push(['delete', id]),
      recordClaim: (...a) => created.push(['recordClaim', ...a]),
      setOutcome: (...a) => created.push(['setOutcome', ...a])
    };
    const bridge = makeBridge({
      deps: {
        plansStore,
        plansCreateFromText: async (o) => {
          created.push(['create', o]);
          return { plan: { id: 'p2', name: '新计划', trigger: 'goal', goal: { checks: [{ command: 'npm run build' }] } } };
        }
      }
    });

    const list = await bridge.executeAgentTool('plan_list', {}, ctx());
    assert.strictEqual(list.plans.length, 1, 'plan_list 列出计划');
    assert.deepStrictEqual(list.plans[0].goal.checks, ['npm test'], '目标型计划报声明检查');
    assert.strictEqual(list.plans[0].lastCheck.ok, false, '报最后一条事实');
    assert.strictEqual(list.plans[0].sessionId, 's-9', '报投递会话');

    const createRes = await bridge.executeAgentTool(
      'plan_create',
      { description: '巡检一次', todos: ['看日志', '跑测试'], rrule: 'FREQ=DAILY' },
      ctx()
    );
    const createCall = created.find((c) => c[0] === 'create')[1];
    assert.ok(createCall.text.includes('1. 看日志'), 'TODO 要编号进 text');
    assert.strictEqual(createCall.structured.rrule, 'FREQ=DAILY', '结构化排期直传（不喂 LLM 解析）');
    assert.strictEqual(createRes.ok, true, 'plan_create ok');
    assert.ok(String(createRes.message).includes('npm run build'), '目标型计划要报声明检查');

    const run = await bridge.executeAgentTool('plan_run', { id: 'p1' }, ctx());
    assert.strictEqual(run.errorCode, 'PLANS_UNAVAILABLE', '没有调度器时 plan_run 明确说不可用');

    const del = await bridge.executeAgentTool('plan_delete', { id: 'p1' }, ctx());
    assert.strictEqual(del.deleted, 'p1', 'plan_delete 回删除的 id');
  }
  {
    const triggered = [];
    const plansStore = { get: (id) => ({ id, name: 'n' }) };
    const bridge = makeBridge({
      deps: {
        plansStore,
        getPlansScheduler: () => ({ runNow: async (id) => triggered.push(id), reload: () => {} })
      }
    });
    const r = await bridge.executeAgentTool('plan_run', { id: 'p1' }, ctx());
    assert.strictEqual(r.ok, true, 'plan_run 触发即返回');
    assert.strictEqual(r.triggered, true, '标记 triggered');
  }

  // ─────────────────── memory / session_recall ───────────────────
  {
    const gw = makeGateway({
      messages: { mode: 'keyword', results: [{ sessionId: 's-2', title: 'T', role: 'user', createdAt: 1, snippet: 'x' }] },
      folded: { results: [{ sessionId: 's-2', createdAt: 2, chars: 99, snippet: 'y' }] }
    });
    const bridge = makeBridge({ gateway: gw, gatewayOpts: {} });
    const r = await bridge.executeAgentTool('session_recall', { query: '登录', folded: true }, ctx());
    assert.strictEqual(r.ok, true, 'session_recall ok');
    assert.strictEqual(r.total, 2, '消息 + 折叠摘要都计入 total');
    assert.deepStrictEqual(r.results.map((x) => x.kind), ['message', 'folded'], '两类结果都标 kind');
    const search = gw.lastCall('memory.messages_search');
    assert.strictEqual(search.params.workspacePath, workspacePath, 'scope=workspace 时圈定工作空间');
    assert.strictEqual(search.params.sessionId, undefined, 'scope=workspace 时不带 sessionId');

    const empty = await bridge.executeAgentTool('session_recall', { query: '  ' }, ctx());
    assert.ok(empty.error, 'session_recall 缺 query → 报错');
  }
  {
    const gw = makeGateway({ longRecall: { results: [{ id: 7, kind: 'normal', importance: 3, score: 0.9, content: '记得' }] } });
    const bridge = makeBridge({ gateway: gw });
    const r = await bridge.executeAgentTool('memory_recall', { query: '偏好' }, ctx());
    assert.strictEqual(r.total, 1, 'memory_recall 命中一条');
    assert.strictEqual(r.results[0].id, 7, '带 id 的条目可交给 memory_forget');

    const forget = await bridge.executeAgentTool('memory_forget', { memoryIds: [7] }, ctx());
    assert.strictEqual(forget.ok, true, 'memory_forget ok');
    assert.deepStrictEqual(forget.archived, [7], '软归档回传 id');
    const statusCall = gw.lastCall('memory.long_status_set');
    assert.strictEqual(statusCall.params.status, 'archived', '归档用 archived 状态（可恢复）');

    const none = await bridge.executeAgentTool('memory_forget', {}, ctx());
    assert.ok(none.error, 'memory_forget 缺 id → 报错');
  }

  // ───────────────────────── peer ─────────────────────────
  {
    const bridge = makeBridge({ deps: { peerCoordinator: null } });
    assert.strictEqual((await bridge.executeAgentTool('peer_list', {}, ctx())).errorCode, 'PEER_UNAVAILABLE');
    assert.strictEqual((await bridge.executeAgentTool('peer_send', { peer: 'a', text: 'x' }, ctx())).errorCode, 'PEER_UNAVAILABLE');
  }
  {
    const peerCoordinator = {
      peers: () => [
        { name: 'DIEYUN11', peerId: 'peer_1', role: 'dev', host: '10.0.0.5', port: 1234, sameWorkspace: true, lastSeenAt: Date.now(), claims: [{ kind: 'file', key: 'a.js', note: '', expiresAt: Date.now() + 60000 }] }
      ],
      status: () => ({ peerId: 'me', name: '本机', role: 'dev', trusted: [], rooms: [{ roomId: 'r-1', title: '一起改', members: ['peer_1'], status: 'open' }] }),
      claim: async () => ({ ok: false, error: 'CLAIM_CONFLICT', holders: [{ peerId: 'peer_1', peerName: 'DIEYUN11', kind: 'file', key: 'a.js', note: '' }] }),
      sendToPeer: async (o) => ({ ok: true, delivered: [{ name: o.peer }] }),
      sendToRoom: async () => ({ ok: false, error: 'ROOM_CLOSED', failed: [] })
    };
    const bridge = makeBridge({ deps: { peerCoordinator } });

    const list = await bridge.executeAgentTool('peer_list', {}, ctx());
    assert.strictEqual(list.ok, true, 'peer_list ok');
    assert.strictEqual(list.peers[0].sameProject, true, 'sameWorkspace → sameProject');
    assert.strictEqual(list.peers[0].address, '10.0.0.5:1234', '地址由 host:port 拼');
    assert.strictEqual(list.rooms[0].members[0], 'DIEYUN11', '房间成员显示名字而不是 id');

    const conflict = await bridge.executeAgentTool('peer_claim', { action: 'claim', kind: 'file', key: 'a.js' }, ctx());
    assert.strictEqual(conflict.ok, false, '租约冲突 → 失败');
    assert.strictEqual(conflict.errorCode, 'CLAIM_CONFLICT', '冲突错误码直传');
    assert.ok(conflict.diagnostics && conflict.diagnostics.holders.length === 1, '持有者走 diagnostics（信封会收窄其它字段）');

    const missing = await bridge.executeAgentTool('peer_send', { text: 'hi' }, ctx());
    assert.strictEqual(missing.errorCode, 'MISSING_ARG', '缺对端 → MISSING_ARG');
    assert.ok(Array.isArray(missing.diagnostics.peers), '把在线对端列给模型');

    const room = await bridge.executeAgentTool('peer_send', { roomId: 'r-1', text: 'hi' }, ctx());
    assert.strictEqual(room.ok, false, '房间已关 → 失败');
    assert.ok(String(room.error).includes('房间'), '房间关闭要用人话解释');
  }

  // ─────────────────── skill / camera / mcp ───────────────────
  {
    const bridge = makeBridge({});
    assert.ok((await bridge.executeAgentTool('skill_create', { name: 'x' }, ctx())).error, '没有 createUserSkill → 报不可用');
    const noDir = await bridge.executeAgentTool('skill_delete', {}, ctx());
    assert.strictEqual(noDir.errorCode, 'MISSING_PATH', 'skill_delete 缺 dir → MISSING_PATH（缺路径类字段统一这个码）');

    // 摄像头默认关：没授权时连「有没有手机桥」都不该泄露，先给 PERMISSION_DENIED。
    const camDenied = await bridge.executeAgentTool('camera_look', {}, ctx());
    assert.strictEqual(camDenied.errorCode, 'PERMISSION_DENIED', '摄像头默认关 → 权限关卡先拦');
    const bridgeCam = makeBridge({ gateway: makeGateway({ permissions: { camera: true } }) });
    const cam = await bridgeCam.executeAgentTool('camera_look', {}, ctx());
    assert.strictEqual(cam.errorCode, 'CAMERA_UNAVAILABLE', '授权了但没有手机桥 → CAMERA_UNAVAILABLE');
  }
  {
    const bridge = makeBridge({
      gateway: makeGateway({ permissions: { desktopCamera: true } }),
      deps: {
        desktopCameraSource: {
          capture: async (o) => ({ ok: true, maxEdge: o.maxEdge, timeoutMs: o.timeoutMs, device: o.device })
        }
      }
    });
    const limits = getAgentLimits(userDataPath, 'default');
    const shot = await bridge.executeAgentTool(
      'desktop_camera_look',
      {},
      ctx({ senses: { eyes: true, cameraDevice: 'OBSBOT' } })
    );
    assert.strictEqual(shot.maxEdge, limits.desktopCameraShotMaxEdge, '本机摄像头长边来自 agent-limits');
    assert.strictEqual(shot.timeoutMs, limits.desktopCameraCaptureTimeoutMs, '超时来自 agent-limits');
    assert.strictEqual(shot.device, 'OBSBOT', '心跳轮选的设备经 senses 传下去');
  }
  {
    const bridge = makeBridge({ deps: { mcpManager: null, mcpRuntime: null } });
    const manage = await bridge.executeAgentTool('mcp_manage', { action: 'list' }, ctx());
    assert.strictEqual(manage.errorCode, 'MCP_UNAVAILABLE', 'mcp_manage 未装配 → MCP_UNAVAILABLE');
    const schema = await bridge.executeAgentTool('mcp_tool_schema', { agentName: 'x' }, ctx());
    assert.strictEqual(schema.errorCode, 'MCP_UNAVAILABLE', 'mcp_tool_schema 未装配 → MCP_UNAVAILABLE');
  }
  {
    let seenOpts = null;
    const bridge = makeBridge({
      deps: {
        mcpManager: {
          applyToolRequest: async (a, o) => {
            seenOpts = { a, o };
            return { ok: true, action: a.action };
          }
        }
      }
    });
    const r = await bridge.executeAgentTool('mcp_manage', { action: 'list' }, ctx());
    assert.strictEqual(r.ok, true, 'mcp_manage 转给 manager');
    // 没有窗口（频道 / headless 轮次）时必须传 null：让 manager 明确回「界面未就绪」，不假装弹过。
    assert.strictEqual(seenOpts.o.notifyCredentialRequest, null, '没有 webContents 时不装凭据弹窗通道');
  }

  // ─────────────────── 出站净化（本轮补测的重灾区）───────────────────
  {
    const shot = { ok: true, base64: 'AAAA', width: 10, height: 10, note: 'n' };
    const stripped = sanitizeToolResultForApi('browser_screenshot', { ...shot });
    assert.strictEqual(stripped.base64, undefined, '截图 base64 必须剥掉');
    assert.strictEqual(stripped.width, 10, '尺寸要保留（模型据此判断画面）');

    const cam = sanitizeToolResultForApi('camera_look', { ok: true, base64: 'BBBB', mime: 'image/jpeg' });
    assert.strictEqual(cam.base64, undefined, '摄像头画面不落模型上下文');

    const computer = sanitizeToolResultForApi('computer', {
      ok: true,
      base64: 'CCCC',
      action: { type: 'click', x: 10, y: 20 },
      applied: true,
      changed: true,
      stable: true,
      timedOut: false,
      typed: 3
    });
    assert.strictEqual(computer.base64, undefined, 'computer 截图同样剥掉');
    assert.strictEqual(computer.base64Omitted, true, '必须显式告诉模型「图被剥掉了」');
    assert.strictEqual(computer.base64Length, 4, '剥掉后给出原长度（可核对没截断）');
    assert.deepStrictEqual(
      { applied: computer.applied, changed: computer.changed, stable: computer.stable, timedOut: computer.timedOut, typed: computer.typed },
      { applied: true, changed: true, stable: true, timedOut: false, typed: 3 },
      'computer 的行为字段必须全部保留（少一个模型下一步就判断错）'
    );
    assert.deepStrictEqual(computer.action, { type: 'click', x: 10, y: 20 }, '动作本身要保留（模型据此衔接下一步）');
    // applied 只认布尔 true：「动作是否真的执行过」不能拿字符串/数组冒充。
    assert.strictEqual(
      sanitizeToolResultForApi('computer', { base64: 'DD', applied: 'yes' }).applied,
      undefined,
      'applied 只接受 true'
    );

    // browser_snapshot / observe 的内联 6000 字符截断（与 tool-output-spill 是两回事）
    const snap = sanitizeToolResultForApi('browser_snapshot', { ok: true, textPreview: 'x'.repeat(7000) });
    assert.strictEqual(snap.textPreview.length, 6001, 'snapshot 预览超 6000 截断并加省略号');

    // 有 outputFile 时不截断（已落盘，模型可去读文件）
    const snap2 = sanitizeToolResultForApi('browser_snapshot', {
      ok: true,
      outputFile: '.dieyun/tool-output/x.log',
      textPreview: 'y'.repeat(7000)
    });
    assert.strictEqual(snap2.textPreview.length, 7000, '已落盘时不截断预览');

    const plain = { ok: true, stdout: 'x' };
    assert.deepStrictEqual(sanitizeToolResultForApi('host_exec', { ...plain }), plain, '普通工具结果原样返回');
    assert.strictEqual(sanitizeToolResultForApi('host_exec', null), null, 'null 原样返回');
  }

  // ─────────────────── 视觉判定 / 预算（导出供测试，原先零引用）───────────────────
  {
    assert.strictEqual(
      isVisionImageReadRequest('fs_read_file', { filePath: 'a.png', encoding: 'base64' }),
      true,
      '整文件 base64 读图 = 视觉请求'
    );
    assert.strictEqual(
      isVisionImageReadRequest('fs_read_file', { filePath: 'a.png', encoding: 'base64', offset: 10 }),
      false,
      '带 offset 是分块续读，不是视觉请求'
    );
    assert.strictEqual(isVisionImageReadRequest('fs_read_file', { filePath: 'a.png' }), false, '非 base64 不是视觉请求');
    assert.strictEqual(isVisionImageReadRequest('browser_screenshot', { encoding: 'base64' }), false, '只认 fs_read_file');

    // 预算内不重编码（返回 null = 原图可直接用）；超预算才缩。
    const small = { base64: 'A'.repeat(64), mediaType: 'image/png', width: 320, height: 200 };
    // 注意 limit 名：`resolveVisionLimits` 只认 visionShotMaxEdge / visionMaxBase64Chars，
    // 写错名字会让两个上限都回落默认值 —— 那样这条断言恒真，缩图分支等于零覆盖。
    const visionLimits = { visionShotMaxEdge: 1600, visionMaxBase64Chars: 100000 };
    assert.strictEqual(fitVisionShotToBudget(small, visionLimits), null, '预算内不重编码');
    // 注意：null 有两种语义（预算内直通 / 缩不了交回原图），所以不能反着断言「必须缩图」；
    // 夹具里是假 base64（解码必然失败），断言具体返回值只会变成恒真/恒假。
  }

  {
    // 回归：注册表若用裸对象查表，模型发一个叫 `toString` / `constructor` 的「工具」时，
    // 会直接执行 Object.prototype 上的函数并把 `[object Object]` 当工具结果返回。
    const bridge = makeBridge({});
    for (const evil of ['toString', 'constructor', 'valueOf', '__proto__']) {
      const r = await bridge.executeAgentTool(evil, {}, ctx());
      assert.ok(
        r == null || typeof r === 'object' || typeof r === 'string',
        `${evil}: 必须走正常失败/未知工具路径，不能返回函数`
      );
      assert.notStrictEqual(r, '[object Object]', `${evil} 不能被当成 handler 执行`);
    }
  }

  // ─────────── 注册表完整性（拆 switch 后新增的结构不变量）───────────
  {
    const { createMainToolHandlers } = require('../src/agent/main-tools');
    const catalog = require('../src/agent/tool-catalog');
    const names = Object.keys(createMainToolHandlers({})).sort();
    const expected = [
      'agents_md_propose',
      'camera_look',
      'desktop_camera_look',
      'desktop_camera_ptz',
      'goal_check',
      'goal_finish',
      'goal_start',
      'goal_update',
      'mcp_manage',
      'mcp_tool_schema',
      'memory_forget',
      'memory_recall',
      'peer_claim',
      'peer_list',
      'peer_send',
      'plan_cancel',
      'plan_create',
      'plan_delete',
      'plan_list',
      'plan_run',
      'session_recall',
      'skill_create',
      'skill_delete',
      'ssh',
      'worktree'
    ].sort();
    assert.deepStrictEqual(names, expected, 'Main 专属工具的注册表必须正好是这 25 个（多一个少一个都是事故）');
    // goal_* 不在 ALL_STATIC_TOOLS 里（那是「静态全局表」）：它由 renderer-tool-defs 常驻下发、
    // 目标型计划另给一份。所以这里按「静态表 ∪ 目标工具」判成员，仍然能抓到名字打错。
    const known = new Map();
    for (const t of catalog.ALL_STATIC_TOOLS) known.set(t.function.name, t);
    for (const t of catalog.GOAL_TOOLS) known.set(t.function.name, t);
    known.set(catalog.GOAL_START_TOOL.function.name, catalog.GOAL_START_TOOL);
    known.set(catalog.GOAL_UPDATE_TOOL.function.name, catalog.GOAL_UPDATE_TOOL);
    for (const n of names) {
      assert.ok(known.has(n), `注册表里的 ${n} 必须在 catalog 里存在（否则模型永远调不到）`);
    }
  }

  // ─────────── 拆分前零覆盖、拆分后必须守住的路径 ───────────
  {
    // mcp_tool_schema(query)：召回不可用时退到子串匹配（宁可粗排，也不能「有工具却找不到」）
    const bridge = makeBridge({
      deps: {
        mcpRuntime: {
          listAgentTools: async () => ({
            tools: [
              { agentName: 'mcp_pg__query', serverId: 'pg', toolName: 'query', description: '跑一条 SQL', inputSchema: { type: 'object', properties: { sql: { type: 'string' } } } },
              { agentName: 'mcp_fs__read', serverId: 'fs', toolName: 'read', description: '读文件', inputSchema: { type: 'object', properties: {} } }
            ]
          })
        }
      }
    });
    const r = await bridge.executeAgentTool('mcp_tool_schema', { query: 'SQL' }, ctx());
    assert.strictEqual(r.ok, true, 'mcp_tool_schema(query) ok');
    assert.strictEqual(r.matched[0].agentName, 'mcp_pg__query', '命中项直接给可调用的 agentName');
    assert.ok(r.matched[0].inputSchema, '带精简 schema（没有它模型没法调用）');
  }
  {
    // goal_check：把声明检查的命令跑掉，并把事实落库
    const gw = makeGateway({
      goal: {
        goal: { objective: '跑通构建', checks: [{ command: 'npm run build' }], todos: [], cwd: '' },
        status: 'active',
        attempt: 1,
        evidence: [],
        claims: [],
        startedAt: new Date().toISOString()
      }
    });
    // host_exec 走 gateway：给一个成功的假结果
    gw.invokeRpc = (method, params) => {
      gw.calls.push({ method, params });
      if (method === 'memory.session_goal_get') {
        return Promise.resolve({
          goalJson: JSON.stringify({
            goal: { objective: '跑通构建', checks: [{ command: 'npm run build' }], todos: [], cwd: '' },
            status: 'active',
            attempt: 1,
            evidence: [],
            claims: [],
            startedAt: new Date().toISOString()
          })
        });
      }
      if (method === 'host.exec') {
        // host.exec 的退出码字段是 `code`（见 plans/goal-run.js#runGoalCheck），不是 exitCode
        return Promise.resolve({ ok: true, code: 0, stdout: 'built', stderr: '', command: params.command });
      }
      return Promise.resolve({ ok: true });
    };
    const bridge = makeBridge({ gateway: gw });
    const r = await bridge.executeAgentTool('goal_check', { check_id: 'npm run build' }, ctx());
    assert.strictEqual(r.ok, true, 'goal_check 跑完检查');
    assert.strictEqual(r.passed, true, '退出码 0 → 通过');
    assert.ok(r.fact, '必须给模型一行可引用的检查事实');
    assert.ok(String(gw.methods().join(',')).includes('memory.session_goal_put'), '检查事实必须落库');
  }
  {
    // plan_cancel：取消要直传调度器，不能自己判
    const cancelled = [];
    const bridge = makeBridge({ deps: { cancelPlanRun: (id) => { cancelled.push(id); return { ok: true }; } } });
    const r = await bridge.executeAgentTool('plan_cancel', { id: 'p1' }, ctx());
    assert.strictEqual(r.ok, true, 'plan_cancel ok');
    assert.deepStrictEqual(cancelled, ['p1'], '取消计划直传 id');
  }
  {
    // skill_create：建完必须通知技能目录变化（否则设置页与工具表不刷新）
    const changed = [];
    const bridge = makeBridge({
      deps: {
        createUserSkill: async (ud, ws, draft) => ({
          name: draft.name,
          dir: '/skills/' + draft.name,
          skillPath: '/skills/' + draft.name + '/SKILL.md'
        }),
        onSkillsChanged: (x) => changed.push(x)
      }
    });
    const r = await bridge.executeAgentTool('skill_create', { name: 'demo', description: 'd', content: 'c' }, ctx());
    assert.strictEqual(r.ok, true, 'skill_create ok');
    assert.strictEqual(changed.length, 1, '创建后必须通知技能变化');
  }
  {
    // peer_send 成功路径：回执要带「等没等到答复」
    const bridge = makeBridge({
      deps: {
        peerCoordinator: {
          peers: () => [],
          sendToPeer: async (o) => ({ ok: true, peer: { name: o.peer }, reply: '收到', timeout: false })
        }
      }
    });
    const r = await bridge.executeAgentTool('peer_send', { peer: 'DIEYUN11', text: 'hi', expectReply: true }, ctx());
    assert.strictEqual(r.ok, true, 'peer_send ok');
    assert.strictEqual(r.delivered, true, '投递成功');
    assert.strictEqual(r.reply, '收到', '带回对方答复');
    assert.strictEqual(r.waitedForReply, true, '如实标明等过答复');
  }
  {
    // agents_md_propose：缺参数时要给结构化拒绝，而不是抛异常（拆分时最容易漏掉这条单行 case）
    const bridge = makeBridge({});
    const r = await bridge.executeAgentTool('agents_md_propose', {}, ctx());
    assert.ok(r && (r.error || r.ok === false), 'agents_md_propose 至少给出结论而不是抛错');
  }

  console.log('ok tool-bridge handlers test');
}

main().catch((err) => {
  console.error('tool-bridge handlers test failed:', err && err.message ? err.message : err);
  process.exitCode = 1;
});
