'use strict';

const {
  bootMcpSkillCatalogs,
  bootPlansRuntime,
  createFinishPlanRun,
  createPlansCreateFromText
} = require('../../src/main/mcp-plans-boot');

describe('bootMcpSkillCatalogs', () => {
  it('creates runtime, mcp catalog, and skill catalog once', () => {
    const listed = [{ id: 'a', enabled: true }];
    const mcpStore = {
      ensureMcpCredentialsStore: () => ({
        getSecretMeta: () => ({}),
        loadSecrets: () => ({ token: '', env: {} })
      }),
      listMcpServersForUi: () => listed,
      upsertMcpFromCatalog: (ud, payload) => payload
    };
    const createMcpRuntimeManager = vi.fn(() => ({ kind: 'runtime' }));
    class FakeMcpCatalog {
      constructor(opts) {
        this.opts = opts;
      }
    }
    class FakeSkillCatalog {
      constructor(opts) {
        this.opts = opts;
      }
    }
    const out = bootMcpSkillCatalogs({
      userData: '/tmp/ud',
      mcpStore,
      getLocalGateway: () => ({ getWorkspace: () => ({ workspacePath: '/ws' }) }),
      log: { info: () => {}, warn: () => {} },
      createMcpRuntimeManager,
      isMcpServerConfigured: () => true,
      mcpPackageStore: { ensureMcpNpmPackage: () => {} },
      McpCatalog: FakeMcpCatalog,
      SkillCatalog: FakeSkillCatalog,
      listInstalledCatalogIds: () => ['skill-1'],
      dieyunSkillsDir: () => '/skills'
    });
    expect(out.mcpRuntime).toEqual({ kind: 'runtime' });
    expect(out.mcpCatalog).toBeInstanceOf(FakeMcpCatalog);
    expect(out.skillCatalog).toBeInstanceOf(FakeSkillCatalog);
    expect(createMcpRuntimeManager).toHaveBeenCalledTimes(1);
    expect(out.mcpCatalog.opts.upsertInstalled({ id: 'from-catalog' })).toEqual({
      id: 'from-catalog'
    });

    const again = bootMcpSkillCatalogs({
      userData: '/tmp/ud',
      mcpStore,
      getLocalGateway: () => null,
      log: { info: () => {}, warn: () => {} },
      existingRuntime: out.mcpRuntime,
      existingMcpCatalog: out.mcpCatalog,
      existingSkillCatalog: out.skillCatalog,
      createMcpRuntimeManager,
      McpCatalog: FakeMcpCatalog,
      SkillCatalog: FakeSkillCatalog
    });
    expect(again.mcpRuntime).toBe(out.mcpRuntime);
    expect(createMcpRuntimeManager).toHaveBeenCalledTimes(1);
  });
});

describe('plans helpers', () => {
  it('finishPlanRun updates store and notifies tray/window', async () => {
    const store = {
      updateRunResult: vi.fn(),
      get: (id) => ({ id, name: 'p', deliver: { sessionId: 's1' } })
    };
    const sends = [];
    const finish = createFinishPlanRun({
      getPlansStore: () => store,
      getLocalGateway: () => ({}),
      getTrayNotify: () => ({
        notifyScheduledPlanTray: vi.fn()
      }),
      getWindowTray: () => ({
        getMainWindow: () => ({
          webContents: { send: (ch, payload) => sends.push([ch, payload]) }
        })
      }),
      log: { info: () => {}, warn: () => {} },
      deliverPlanResult: async () => 'from-deliver'
    });
    const result = await finish({ id: '1', name: 'p' }, { ok: true, summary: 'done' });
    expect(store.updateRunResult).toHaveBeenCalled();
    expect(result.ok).toBe(true);
    expect(sends[0][0]).toBe('plans:ran');
  });

  it('bootPlansRuntime reloads scheduler and late-binds mcpRuntime', async () => {
    let mcpRuntime = null;
    const runPlan = vi.fn(async (ctx) => {
      expect(ctx.mcpRuntime).toEqual({ live: true });
      return { ok: true };
    });
    class FakeStore {
      constructor() {
        this._plans = [{ id: '1', name: 'n', enabled: false }];
        this.runStates = new Map();
      }
      list() {
        return this._plans;
      }
      updateRunResult() {}
      get(id) {
        return this._plans.find((p) => p.id === id);
      }
      beginRun(id, info) {
        this.runStates.set(id, { ...info });
        return this.runStates.get(id);
      }
      endRun(id) {
        return this.runStates.delete(id);
      }
      listRunning() {
        return [...this.runStates.entries()].map(([id, runState]) => ({
          plan: this.get(id),
          runState: { ...runState }
        }));
      }
    }
    class FakeScheduler {
      constructor(opts) {
        this.opts = opts;
        this.reloaded = 0;
      }
      reload() {
        this.reloaded += 1;
      }
    }
    const boot = bootPlansRuntime({
      userData: '/tmp/ud',
      getLocalGateway: () => ({ getWorkspace: () => ({ workspacePath: '/ws' }) }),
      getCoreBridge: () => null,
      getMcpRuntime: () => mcpRuntime,
      getWindowTray: () => null,
      createToolBridge: () => ({}),
      ensureMainCompactionAgent: () => ({}),
      getTokenBudget: () => 1000,
      getTrayNotify: () => null,
      log: { info: () => {}, warn: () => {} },
      PlansStore: FakeStore,
      PlansScheduler: FakeScheduler,
      runPlan
    });
    expect(boot.plansScheduler.reloaded).toBe(1);
    mcpRuntime = { live: true };
    await boot.plansScheduler.opts.runPlan({ id: '1', name: 'n' });
    expect(runPlan).toHaveBeenCalled();
  });

  it('启动恢复：为被进程杀掉而残留的运行边界补写中断回执', async () => {
    const appends = [];
    class FakeStore {
      constructor() {
        this._plans = [{ id: '1', name: 'n', enabled: true, deliver: { sessionId: 's1' } }];
        this.runStates = new Map();
      }
      list() {
        return this._plans;
      }
      updateRunResult() {}
      get(id) {
        return this._plans.find((p) => p.id === id);
      }
      beginRun(id, info) {
        this.runStates.set(id, { ...info });
        return this.runStates.get(id);
      }
      endRun(id) {
        return this.runStates.delete(id);
      }
      listRunning() {
        return [...this.runStates.entries()].map(([id, runState]) => ({
          plan: this.get(id),
          runState: { ...runState }
        }));
      }
    }
    class FakeScheduler {
      constructor(opts) {
        this.opts = opts;
      }
      reload() {}
    }
    const boot = bootPlansRuntime({
      userData: '/tmp/ud',
      getLocalGateway: () => ({
        getWorkspace: () => ({ workspacePath: '/ws' }),
        invokeRpc: async (method, params) => {
          if (method === 'memory.message_append') appends.push(params);
          return {};
        }
      }),
      getCoreBridge: () => null,
      getMcpRuntime: () => null,
      getWindowTray: () => null,
      createToolBridge: () => ({}),
      ensureMainCompactionAgent: () => ({}),
      getTokenBudget: () => 1000,
      getTrayNotify: () => null,
      log: { info: () => {}, warn: () => {} },
      PlansStore: FakeStore,
      PlansScheduler: FakeScheduler,
      runPlan: async () => ({ ok: true })
    });

    // 模拟「用户轮次已落库、随后进程被杀」留下的边界标记
    boot.plansStore.beginRun('1', { runId: 'plan-1-x', sessionId: 's1' });
    const recovered = await boot.recoverInterruptedRuns();

    expect(recovered).toBe(1);
    expect(appends.some((p) => p.role === 'assistant' && /中断/.test(String(p.content)))).toBe(true);
    // 边界已收束：下次启动不会重复补回执
    expect(boot.plansStore.listRunning()).toEqual([]);
  });

  it('createPlansCreateFromText upserts and reloads', async () => {
    const store = { upsert: vi.fn((p) => ({ ...p, id: 'x' })) };
    const scheduler = { reload: vi.fn() };
    const fn = createPlansCreateFromText({
      userData: '/tmp/ud',
      getPlansStore: () => store,
      getPlansScheduler: () => scheduler,
      getLocalGateway: () => null,
      parsePlanFromText: async () => ({ name: 'from-text' }),
      ensurePlanSession: async () => ({ plan: { id: 'no' } })
    });
    const out = await fn({ text: '每天跑' });
    expect(out.ok).toBe(true);
    expect(store.upsert).toHaveBeenCalled();
    expect(scheduler.reload).toHaveBeenCalled();
  });

  it('createPlansCreateFromText 透传结构化字段与模型路由，并把路由写进计划', async () => {
    const upserted = [];
    const store = {
      upsert: vi.fn((p) => {
        upserted.push(p);
        return { ...p, id: 'x' };
      })
    };
    const parse = vi.fn(async () => ({ name: 'from-text' }));
    const fn = createPlansCreateFromText({
      userData: '/tmp/ud',
      getPlansStore: () => store,
      getPlansScheduler: () => ({ reload: vi.fn() }),
      getLocalGateway: () => null,
      parsePlanFromText: parse,
      ensurePlanSession: async () => ({ plan: { id: 'no' } })
    });

    await fn({
      text: '每天 9 点跑',
      structured: { rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0', prompt: '跑一下' },
      modelRoute: 'custom:c1',
      model: 'my-text'
    });

    expect(parse).toHaveBeenCalledWith(
      '/tmp/ud',
      '每天 9 点跑',
      expect.objectContaining({ route: 'custom:c1', model: 'my-text' })
    );
    expect(upserted[0]).toEqual(
      expect.objectContaining({ modelRoute: 'custom:c1', model: 'my-text' })
    );
  });
});

describe('目标型计划（trigger=goal）运行闭环', () => {
  /** 内存版 PlansStore：只实现 boot 用到的方法，并记录调用序列 */
  function makeGoalStore(plan) {
    const state = { plan: JSON.parse(JSON.stringify(plan)), calls: [] };
    const store = {
      state,
      list: () => [state.plan],
      get: (id) => (state.plan.id === id ? { ...state.plan } : null),
      upsert: (p) => {
        state.plan = { ...state.plan, ...p };
        return { ...state.plan };
      },
      updateRunResult: (id, r) => state.calls.push(['updateRunResult', r]),
      beginRun: (id, info) => {
        state.plan.runState = { ...info, startedAt: new Date().toISOString() };
        return state.plan.runState;
      },
      endRun: () => {
        delete state.plan.runState;
      },
      listRunning: () =>
        state.plan.runState
          ? [{ plan: { ...state.plan }, runState: { ...state.plan.runState } }]
          : [],
      beginAttempt: () => {
        state.plan.attempt = (Number(state.plan.attempt) || 0) + 1;
        state.plan.nextRunAt = null;
        state.plan.attemptStartedAt = state.plan.attemptStartedAt || new Date().toISOString();
        state.calls.push(['beginAttempt']);
      },
      setBaseline: (id, b) => {
        state.plan.baseline = b;
        state.calls.push(['setBaseline', b]);
      },
      updateVerify: (id, v) => {
        state.plan.lastVerify = v;
        state.calls.push(['updateVerify', v]);
      },
      scheduleNextAttempt: (id, delayMs) => {
        state.plan.nextRunAt = new Date(Date.now() + delayMs).toISOString();
        state.calls.push(['scheduleNextAttempt', delayMs]);
      },
      setEnabled: (id, enabled) => {
        state.plan.enabled = enabled !== false;
        state.calls.push(['setEnabled', enabled]);
      },
      clearGoalRuntime: () => {}
    };
    return store;
  }

  function makeGoalGateway(execResults, appends) {
    let i = 0;
    const gateway = {
      execCalls: [],
      getWorkspace: () => ({ workspacePath: '/ws' }),
      invokeRpc: async (method, params) => {
        if (method === 'host.exec') {
          gateway.execCalls.push(params);
          const hit = execResults[Math.min(i, execResults.length - 1)];
          i += 1;
          return hit;
        }
        if (method === 'host.proc_kill') return { ok: true };
        if (method === 'memory.session_get') return { id: 's1' };
        if (method === 'memory.message_append') {
          appends.push(params);
          return {};
        }
        return {};
      }
    };
    return gateway;
  }

  function makeBoot(store, gateway, agentRun) {
    class FakeStore {
      constructor() {
        return store;
      }
    }
    class FakeScheduler {
      constructor(opts) {
        this.opts = opts;
      }
      reload() {}
    }
    return bootPlansRuntime({
      userData: '/tmp/ud',
      getLocalGateway: () => gateway,
      getCoreBridge: () => null,
      getMcpRuntime: () => null,
      getWindowTray: () => null,
      createToolBridge: () => ({}),
      ensureMainCompactionAgent: () => ({}),
      getTokenBudget: () => 1000,
      getTrayNotify: () => null,
      log: { info: () => {}, warn: () => {} },
      PlansStore: FakeStore,
      PlansScheduler: FakeScheduler,
      runPlan: agentRun
    });
  }

  function goalPlan(extra = {}) {
    return {
      id: 'g',
      name: '目标',
      enabled: true,
      trigger: 'goal',
      prompt: '把验收跑绿',
      goal: { verify: 'npm test', cwd: '' },
      budget: { maxAttempts: 0, maxWallMs: 0 },
      attempt: 0,
      attemptStartedAt: null,
      nextRunAt: null,
      baseline: null,
      lastVerify: null,
      deliver: { type: 'session', sessionId: 's1' },
      ...extra
    };
  }

  it('开工基线就绿（尺子无效）→ 不进入 agent 轮次，直接停用并说明', async () => {
    const appends = [];
    const store = makeGoalStore(goalPlan());
    const agentRun = vi.fn(async () => ({ ok: true }));
    const gw = makeGoalGateway([{ code: 0, stdout: 'all green' }], appends);
    const boot = makeBoot(store, gw, agentRun);

    await boot.plansScheduler.opts.runPlan(store.list()[0]);

    expect(agentRun).not.toHaveBeenCalled();
    expect(store.state.plan.baseline.red).toBe(false);
    expect(store.state.plan.enabled).toBe(false);
    const assistant = appends.filter((p) => p.role === 'assistant').map((p) => String(p.content));
    expect(assistant.some((c) => c.includes('目标未完成'))).toBe(true);
  });

  it('基线红 → 跑一轮 → 验收仍红 → 排下一轮（带退避）', async () => {
    const appends = [];
    const store = makeGoalStore(goalPlan());
    const agentRun = vi.fn(async () => ({ ok: true, summary: '改了点东西' }));
    const gw = makeGoalGateway(
      [
        { code: 1, stdout: 'FAIL baseline' },
        { code: 1, stdout: 'FAIL still' }
      ],
      appends
    );
    const boot = makeBoot(store, gw, agentRun);

    await boot.plansScheduler.opts.runPlan(store.list()[0]);

    expect(agentRun).toHaveBeenCalledTimes(1);
    expect(store.state.plan.baseline.red).toBe(true);
    expect(store.state.plan.attempt).toBe(1);
    expect(store.state.plan.lastVerify.ok).toBe(false);
    expect(store.state.plan.enabled).toBe(true);
    const scheduled = store.state.calls.filter((c) => c[0] === 'scheduleNextAttempt');
    expect(scheduled.length).toBe(1);
    expect(scheduled[0][1]).toBe(60000);
    // 验收只会通过 host.exec 跑，且不带 keepOnTimeout（避免留孤儿进程）
    expect(gw.execCalls.every((c) => c.keepOnTimeout === undefined)).toBe(true);
  });

  it('基线红 → 跑一轮 → 验收转绿 → 完成并停用', async () => {
    const appends = [];
    const store = makeGoalStore(goalPlan());
    const agentRun = vi.fn(async () => ({ ok: true }));
    const gw = makeGoalGateway([{ code: 1, stdout: 'FAIL' }, { code: 0, stdout: 'ok' }], appends);
    const boot = makeBoot(store, gw, agentRun);

    await boot.plansScheduler.opts.runPlan(store.list()[0]);

    expect(store.state.plan.lastVerify.ok).toBe(true);
    expect(store.state.plan.enabled).toBe(false);
    expect(store.state.calls.some((c) => c[0] === 'scheduleNextAttempt')).toBe(false);
    const assistant = appends.filter((p) => p.role === 'assistant').map((p) => String(p.content));
    expect(assistant.some((c) => c.includes('目标未完成'))).toBe(false);
  });

  it('验收被沙箱拒绝（夜间无人可批）→ 停用，不排下一轮', async () => {
    const appends = [];
    const store = makeGoalStore(goalPlan());
    const agentRun = vi.fn(async () => ({ ok: true }));
    const gw = makeGoalGateway([{ code: 1, stdout: 'FAIL' }], appends);
    const realInvoke = gw.invokeRpc;
    let execSeen = 0;
    gw.invokeRpc = async (method, params) => {
      if (method === 'host.exec') {
        execSeen += 1;
        // 基线那次正常返回红，验收那次被沙箱拒
        if (execSeen === 2) {
          const e = new Error('sandbox denied');
          e.code = 'SANDBOX_DENIED';
          throw e;
        }
      }
      return realInvoke(method, params);
    };
    const boot = makeBoot(store, gw, agentRun);

    await boot.plansScheduler.opts.runPlan(store.list()[0]);

    expect(store.state.plan.lastVerify.note).toBe('blocked-approval');
    expect(store.state.plan.enabled).toBe(false);
    expect(store.state.calls.some((c) => c[0] === 'scheduleNextAttempt')).toBe(false);
  });

  it('崩溃后恢复：补回执并排下一轮（轮次不重跑）', async () => {
    const appends = [];
    const store = makeGoalStore(goalPlan({ attempt: 1, attemptStartedAt: new Date().toISOString() }));
    const gw = makeGoalGateway([{ code: 1, stdout: 'FAIL' }], appends);
    const boot = makeBoot(store, gw, vi.fn());
    // 模拟「用户轮次已落库、随后进程被杀」
    boot.plansStore.beginRun('g', { runId: 'plan-g-1', sessionId: 's1' });

    const recovered = await boot.recoverInterruptedRuns();

    expect(recovered).toBe(1);
    const scheduled = store.state.calls.filter((c) => c[0] === 'scheduleNextAttempt');
    expect(scheduled.length).toBe(1);
    expect(scheduled[0][1]).toBeGreaterThan(0);
    expect(boot.plansStore.listRunning()).toEqual([]);
  });
});
