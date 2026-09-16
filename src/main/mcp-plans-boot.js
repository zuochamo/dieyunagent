'use strict';
// @ts-check

/**
 * MCP runtime/catalogs and scheduled-plans assembly (called from app.whenReady).
 * Factories are injectable for unit tests; production uses the real modules.
 */

const path = require('path');
const { McpCatalog } = require('../mcp/catalog');
const { SkillCatalog, listInstalledCatalogIds } = require('../skills/catalog');
const { createMcpRuntimeManager } = require('../mcp/runtime-manager');
const { isMcpServerConfigured } = require('../mcp/server-config');
const mcpPackageStore = require('../mcp/package-store');
const { resolveBundledMcpLaunch } = require('../mcp/bundled-launch');
const {
  OPEN_API_MCP_IDS,
  getDieyunOpenApiEnvFromDeploy,
  mergeMcpServerSecrets
} = require('../mcp/open-api-deploy-env');
const { PlansStore } = require('../plans/store');
const { PlansScheduler } = require('../plans/scheduler');
const { runPlan } = require('../plans/runner');
const { ensurePlanSession } = require('../plans/plan-session');
const { deliverPlanResult } = require('../plans/deliver');
const { parsePlanFromText } = require('../plans/parser');
const { dieyunSkillsDir } = require('../agent-home');

/**
 * @typedef {object} McpPlansLog
 * @property {(msg: string, ...rest: unknown[]) => void} info
 * @property {(msg: string, ...rest: unknown[]) => void} warn
 */

/**
 * @param {object} deps
 * @param {string} deps.userData
 * @param {ReturnType<typeof import('../mcp/store').createMcpStore>} deps.mcpStore
 * @param {() => { getWorkspace?: () => { workspacePath?: string } } | null} deps.getLocalGateway
 * @param {McpPlansLog} deps.log
 * @param {object | null} [deps.existingRuntime]
 * @param {object | null} [deps.existingMcpCatalog]
 * @param {object | null} [deps.existingSkillCatalog]
 * @param {typeof createMcpRuntimeManager} [deps.createMcpRuntimeManager]
 * @param {typeof isMcpServerConfigured} [deps.isMcpServerConfigured]
 * @param {{ ensureMcpNpmPackage: Function }} [deps.mcpPackageStore]
 * @param {typeof McpCatalog} [deps.McpCatalog]
 * @param {typeof SkillCatalog} [deps.SkillCatalog]
 * @param {typeof listInstalledCatalogIds} [deps.listInstalledCatalogIds]
 * @param {() => string} [deps.dieyunSkillsDir]
 */
function bootMcpSkillCatalogs(deps) {
  const userData = deps.userData;
  const mcpStore = deps.mcpStore;
  const getLocalGateway = deps.getLocalGateway;
  const log = deps.log;
  const createRuntime = deps.createMcpRuntimeManager || createMcpRuntimeManager;
  const configured = deps.isMcpServerConfigured || isMcpServerConfigured;
  const pkgStore = deps.mcpPackageStore || mcpPackageStore;
  const Catalog = deps.McpCatalog || McpCatalog;
  const Skills = deps.SkillCatalog || SkillCatalog;
  const listIds = deps.listInstalledCatalogIds || listInstalledCatalogIds;
  const skillsDir = deps.dieyunSkillsDir || dieyunSkillsDir;

  try {
    const { app } = require('electron');
    if (app && !app.isPackaged) {
      const store = mcpStore.loadMcpStore(userData);
      let changed = false;
      for (const mcpId of OPEN_API_MCP_IDS) {
        const service = String(mcpId).replace(/^mcp-/, '');
        const deployEnv = getDieyunOpenApiEnvFromDeploy({ serviceId: service });
        const hasKey = Object.keys(deployEnv).some(
          (k) => k.endsWith('_API_KEY') && String(deployEnv[k] || '').trim()
        );
        if (hasKey && !Object.prototype.hasOwnProperty.call(store.enabled || {}, mcpId)) {
          store.enabled = store.enabled || {};
          store.enabled[mcpId] = true;
          changed = true;
          log.info(`开发模式：已启用预装 MCP ${mcpId}（凭据来自 deploy.local.json）`);
        }
      }
      if (changed) mcpStore.saveMcpStore(userData, store);
    }
  } catch {
    // 非 Electron / 测试环境
  }

  let mcpRuntime = deps.existingRuntime || null;
  if (!mcpRuntime) {
    mcpRuntime = createRuntime(
      () => {
        const creds = mcpStore.ensureMcpCredentialsStore(userData);
        return mcpStore.listMcpServersForUi(userData).filter((server) => {
          return (
            server.enabled &&
            configured(server, { getSecretMeta: (id) => creds.getSecretMeta(id) })
          );
        });
      },
      {
        catalogPath: path.join(userData, 'mcp-tools-catalog.json'),
        getServerSecrets: (id) => {
          const raw = mcpStore.ensureMcpCredentialsStore(userData).loadSecrets(id);
          return mergeMcpServerSecrets(id, raw);
        },
        getWorkspacePath: () => {
          try {
            const gw = getLocalGateway();
            return gw && gw.getWorkspace ? gw.getWorkspace().workspacePath || '' : '';
          } catch {
            return '';
          }
        },
        ensureLocalPackage: async (server) => {
          try {
            const bundled = resolveBundledMcpLaunch(server);
            if (bundled) return { server: bundled, bundled: true };
          } catch (err) {
            if (err && err.code === 'BUNDLED_MCP_MISSING') throw err;
          }
          return pkgStore.ensureMcpNpmPackage({
            userDataPath: userData,
            server
          });
        }
      }
    );
  }

  let mcpCatalog = deps.existingMcpCatalog || null;
  if (!mcpCatalog) {
    mcpCatalog = new Catalog({
      userDataPath: userData,
      log: (msg) => log.warn(msg),
      listInstalled: () => mcpStore.listMcpServersForUi(userData),
      upsertInstalled: (payload) => {
        return mcpStore.upsertMcpFromCatalog(userData, payload);
      }
    });
  }

  let skillCatalog = deps.existingSkillCatalog || null;
  if (!skillCatalog) {
    skillCatalog = new Skills({
      userDataPath: userData,
      log: (msg) => log.warn(msg),
      listInstalled: () => listIds(skillsDir())
    });
  }

  return { mcpRuntime, mcpCatalog, skillCatalog };
}

/**
 * @param {object} deps
 * @param {() => object | null} deps.getPlansStore
 * @param {() => { plugins?: { dispatchHook: Function } } | null} deps.getLocalGateway
 * @param {() => { notifyScheduledPlanTray: Function } | null} deps.getTrayNotify
 * @param {() => { getMainWindow?: () => { webContents?: { send: Function } } | null } | null} deps.getWindowTray
 * @param {McpPlansLog} deps.log
 * @param {typeof deliverPlanResult} [deps.deliverPlanResult]
 */
function createFinishPlanRun(deps) {
  const deliver = deps.deliverPlanResult || deliverPlanResult;
  return async function finishPlanRun(plan, result) {
    const plansStore = deps.getPlansStore();
    if (!plan || !plansStore) return result;
    plansStore.updateRunResult(plan.id, result);
    let sessionId = result && result.sessionId ? String(result.sessionId) : null;
    const localGateway = deps.getLocalGateway();
    if (!sessionId) {
      try {
        sessionId = await deliver(localGateway, plan, result);
      } catch (e) {
        deps.log.warn('计划投递会话失败:', e && e.message);
      }
    }
    const fresh = plansStore.get(plan.id) || plan;
    const payload = {
      planId: fresh.id,
      planName: fresh.name,
      sessionId: sessionId || (fresh.deliver && fresh.deliver.sessionId) || null,
      ok: !!(result && result.ok),
      summary: result && result.summary ? String(result.summary) : '',
      error: result && result.error ? String(result.error) : ''
    };
    const trayNotify = deps.getTrayNotify && deps.getTrayNotify();
    if (trayNotify) trayNotify.notifyScheduledPlanTray(fresh, result);
    if (localGateway && localGateway.plugins) {
      void localGateway.plugins.dispatchHook('onPlanRan', payload);
    }
    const windowTray = deps.getWindowTray && deps.getWindowTray();
    const win = windowTray && windowTray.getMainWindow ? windowTray.getMainWindow() : null;
    if (win && win.webContents) {
      win.webContents.send('plans:ran', payload);
    }
    return result;
  };
}

/**
 * @param {object} deps
 * @param {string} deps.userData
 * @param {() => object | null} deps.getLocalGateway
 * @param {() => object | null} deps.getCoreBridge
 * @param {() => object | null} deps.getMcpRuntime
 * @param {() => object | null} deps.getWindowTray
 * @param {(webContents?: object | null) => object} deps.createToolBridge
 * @param {() => object} deps.ensureMainCompactionAgent
 * @param {(model?: string) => number} deps.getTokenBudget
 * @param {() => object | null} deps.getTrayNotify
 * @param {McpPlansLog} deps.log
 * @param {typeof PlansStore} [deps.PlansStore]
 * @param {typeof PlansScheduler} [deps.PlansScheduler]
 * @param {typeof runPlan} [deps.runPlan]
 * @param {typeof deliverPlanResult} [deps.deliverPlanResult]
 */
function bootPlansRuntime(deps) {
  const Store = deps.PlansStore || PlansStore;
  const Scheduler = deps.PlansScheduler || PlansScheduler;
  const run = deps.runPlan || runPlan;
  const userData = deps.userData;
  const log = deps.log;

  const plansStore = new Store(userData);
  const finishPlanRun = createFinishPlanRun({
    getPlansStore: () => plansStore,
    getLocalGateway: deps.getLocalGateway,
    getTrayNotify: deps.getTrayNotify,
    getWindowTray: deps.getWindowTray,
    log,
    deliverPlanResult: deps.deliverPlanResult
  });

  const plansScheduler = new Scheduler({
    getPlans: () => plansStore.list(),
    runPlan: async (plan) => {
      log.info(`计划开始: ${plan.name}`);
      let result;
      const gw = deps.getLocalGateway();
      const planCtx = {
        userData,
        workspacePath: gw && gw.getWorkspace ? gw.getWorkspace().workspacePath : null,
        gateway: gw,
        plansStore,
        coreBridge: deps.getCoreBridge(),
        mcpRuntime: deps.getMcpRuntime(),
        createToolBridge: (webContents) => {
          const tray = deps.getWindowTray && deps.getWindowTray();
          const win = tray && tray.getMainWindow ? tray.getMainWindow() : null;
          return deps.createToolBridge(webContents || (win ? win.webContents : null));
        },
        compactionAgent: deps.ensureMainCompactionAgent(),
        getTokenBudget: deps.getTokenBudget,
        webContents: (() => {
          const tray = deps.getWindowTray && deps.getWindowTray();
          const win = tray && tray.getMainWindow ? tray.getMainWindow() : null;
          return win ? win.webContents : null;
        })(),
        log: (m) => log.info(m)
      };
      try {
        result = await run(planCtx, plan);
      } catch (e) {
        result = { ok: false, error: (e && e.message) || String(e) };
      }
      finishPlanRun(plan, result).catch((e) => log.warn('计划收尾失败:', e && e.message));
      log.info(`计划结束: ${plan.name}`, result.ok ? 'ok' : String(result.error || ''));
      return result;
    },
    log: (m) => log.info(m)
  });
  plansScheduler.reload();
  return { plansStore, plansScheduler, finishPlanRun };
}

/**
 * @param {object} deps
 * @param {string} deps.userData
 * @param {() => { upsert: Function, get?: Function } | null} deps.getPlansStore
 * @param {() => { reload: Function } | null} deps.getPlansScheduler
 * @param {() => object | null} deps.getLocalGateway
 * @param {typeof parsePlanFromText} [deps.parsePlanFromText]
 * @param {typeof ensurePlanSession} [deps.ensurePlanSession]
 */
function createPlansCreateFromText(deps) {
  const parse = deps.parsePlanFromText || parsePlanFromText;
  const ensureSession = deps.ensurePlanSession || ensurePlanSession;
  return async function plansCreateFromText(payload) {
    const plansStore = deps.getPlansStore();
    if (!plansStore) throw new Error('计划存储未就绪');
    const text = payload && payload.text != null ? String(payload.text) : '';
    if (!text.trim()) throw new Error('请提供计划描述');
    const plan = await parse(deps.userData, text, {
      skillIds: payload && payload.skillIds ? payload.skillIds : []
    });
    let saved = plansStore.upsert(plan);
    const localGateway = deps.getLocalGateway();
    if (localGateway) {
      saved = (await ensureSession(localGateway, plansStore, saved)).plan;
    }
    const plansScheduler = deps.getPlansScheduler();
    if (plansScheduler) plansScheduler.reload();
    return { ok: true, plan: saved };
  };
}

module.exports = {
  bootMcpSkillCatalogs,
  bootPlansRuntime,
  createFinishPlanRun,
  createPlansCreateFromText
};
