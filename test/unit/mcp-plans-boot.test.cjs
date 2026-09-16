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
    const hooks = [];
    const finish = createFinishPlanRun({
      getPlansStore: () => store,
      getLocalGateway: () => ({
        plugins: { dispatchHook: (n, p) => hooks.push([n, p]) }
      }),
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
    expect(hooks[0][0]).toBe('onPlanRan');
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
      }
      list() {
        return this._plans;
      }
      updateRunResult() {}
      get(id) {
        return this._plans.find((p) => p.id === id);
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
});
