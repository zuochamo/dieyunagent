'use strict';

/**
 * Phase 5 smoke: extracted gateway handlers + live LocalGateway RPC.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { createTestLocalGateway } = require('./lib/test-gateway-harness.cjs');
const { createExtractedHandlers } = require('../src/gateway/handlers');

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assert failed');
}

async function testHandlerFactories() {
  const fakeDeps = {
    perms: { webFetch: true, sqlRead: false, browserAutomation: true },
    requireRustCore: async (method, params) => ({ ok: true, method, params }),
    projectMemoryScope: () => 'proj:test',
    sqlSvc: {
      getStatus: () => ({ enabled: false }),
      setConfig: () => ({}),
      testConnection: async () => ({ ok: true }),
      listDatabases: async () => [],
      listTables: async () => [],
      query: async () => ({ rows: [] })
    },
    assertHostEnabled: () => {},
    assertSqlEnabled: () => {
      const e = new Error('SQL disabled');
      e.code = 'SQL_READ_DISABLED';
      throw e;
    },
    assertWebFetchEnabled: () => {},
    webFetch: {
      fetchWithRedirects: async () => ({ text: 'ok' }),
      webSearch: async () => ({ results: [] })
    },
    ctx: {},
    syncRemoteIndexCoreConfig: async () => ({ ok: true }),
    waitRemoteIndexCoreReady: async () => ({ hasCore: true }),
    resolveCodebaseContext: () => ({ kind: 'local', rootKey: '/tmp' }),
    REMOTE_INDEX_PREP_TIMEOUT_MS: 45000
  };

  const h = createExtractedHandlers(fakeDeps);
  const keys = [
    'permissions.get',
    'memory.touch_session',
    'agent.state_get',
    'sql.config_get',
    'web.fetch',
    'speech.transcribe',
    'index.remote_sync_configure',
    'index.remote_wait_ready',
    'plugins.list',
    'codebase.status',
    'graph.status',
    'fs.stat',
    'host.environment',
    'browser.status',
    'undo.can_rollback',
    'artifact.list_files'
  ];
  for (const k of keys) assert(typeof h[k] === 'function', `missing ${k}`);

  assert((await h['permissions.get']()).webFetch === true, 'perms');
  assert((await h['memory.project_scope']({})).scope === 'proj:test', 'project scope');
  assert((await h['agent.state_get']({ sessionId: 's1' })).method === 'agent.state_get', 'agent');
  assert((await h['sql.config_get']()).enabled === false, 'sql');
  assert((await h['index.remote_sync_configure']()).ok === true, 'index');
  assert((await h['index.remote_wait_ready']({})).skipped === true, 'remote wait local skip');

  const { isRemoteAgentHealableError } = require('../src/gateway/handlers/index-remote');
  assert(isRemoteAgentHealableError({ code: 'REMOTE_AGENT_UNAVAILABLE', message: 'x' }), 'healable code');
  assert(isRemoteAgentHealableError(new Error('Remote Agent 连接已关闭')), 'healable msg');
  assert(!isRemoteAgentHealableError({ code: 'REMOTE_INDEX_CORE_MISSING', message: 'no bin' }), 'not healable missing core');
  assert(
    !isRemoteAgentHealableError({ code: 'REMOTE_INDEX_UNAVAILABLE', message: '启动失败' }),
    'core start fail not healable'
  );

  let noHealCalls = 0;
  const noHealDeps = {
    ...fakeDeps,
    resolveCodebaseContext: () => ({ kind: 'remote', remotePath: '/tmp/proj', rootKey: 'ssh:x' }),
    waitRemoteIndexCoreReady: async () => {
      const e = new Error('远程 dieyun-core 启动失败：GLIBC_2.38 not found');
      e.code = 'REMOTE_INDEX_UNAVAILABLE';
      throw e;
    },
    healRemoteAgentTransport: async () => {
      noHealCalls += 1;
      return { ok: true, steps: ['ensure_gateway'] };
    }
  };
  const hNoHeal = createExtractedHandlers(noHealDeps);
  const coreFail = await hNoHeal['index.remote_wait_ready']({ workspaceRoot: 'ssh://u@h/tmp/proj' });
  assert(coreFail.ok === false && noHealCalls === 0, 'core crash must not SSH-heal');

  let healCalls = 0;
  const healDeps = {
    ...fakeDeps,
    resolveCodebaseContext: () => ({ kind: 'remote', remotePath: '/tmp/proj', rootKey: 'ssh:x' }),
    waitRemoteIndexCoreReady: async () => {
      if (healCalls === 0) {
        const e = new Error('Remote Agent 连接已关闭');
        e.code = 'REMOTE_AGENT_UNAVAILABLE';
        throw e;
      }
      return { hasCore: true, indexDbPath: '/tmp/idx' };
    },
    healRemoteAgentTransport: async () => {
      healCalls += 1;
      return { ok: true, steps: ['ensure_gateway'] };
    }
  };
  const h2 = createExtractedHandlers(healDeps);
  const healed = await h2['index.remote_wait_ready']({ workspaceRoot: 'ssh://u@h/tmp/proj' });
  assert(healed.ok === true && healed.healed === true && healCalls === 1, 'prep heal retries wait');
  console.log('ok handler factories (permissions/memory/agent/sql/web/speech/index)');
}

async function testLiveGatewayRpc() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dieyun-p5-'));
  const { gateway, stop } = createTestLocalGateway(tmp);
  try {
    const perms = await gateway.invokeRpc('permissions.get', {});
    assert(perms && typeof perms === 'object', 'live permissions.get');
    const scope = await gateway.invokeRpc('memory.project_scope', { workspacePath: tmp });
    assert(scope && scope.scope, 'live memory.project_scope');
    console.log('ok live gateway RPC (permissions + memory.project_scope)');
  } finally {
    await stop();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

async function testMainIpcModules() {
  const { registerEarlyMainIpc, registerMainIpc, registerLateMainIpc } = require('../src/main/register-ipc');
  assert(typeof registerEarlyMainIpc === 'function', 'registerEarlyMainIpc');
  assert(typeof registerMainIpc === 'function', 'registerMainIpc');
  assert(typeof registerLateMainIpc === 'function', 'registerLateMainIpc');
  const ipc = require('../src/main/ipc/deploy');
  assert(typeof ipc.registerDeployIpc === 'function', 'registerDeployIpc');
  const { registerWorkspaceRemoteIpc } = require('../src/main/ipc/workspace-remote');
  assert(typeof registerWorkspaceRemoteIpc === 'function', 'registerWorkspaceRemoteIpc');
  console.log('ok main IPC modules load');
}

async function main() {
  await testHandlerFactories();
  await testLiveGatewayRpc();
  await testMainIpcModules();
  console.log('\nphase5-handlers-smoke: ALL OK');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
