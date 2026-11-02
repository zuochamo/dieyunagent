'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { createMcpStore } = require('../src/mcp/store');
const { createMcpManager, toStoreRequest } = require('../src/mcp/manage');
const { isMcpServerToolName } = require('../src/mcp/tool-name');

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assert failed');
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dieyun-mcp-store-'));
const store = createMcpStore({
  safeStorage: {
    isEncryptionAvailable: () => false
  }
});

/** 可加解密的最小 safeStorage 替身：远端服务的 token 必须能真正落盘才算「已配置」 */
function fakeSafeStorage() {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (s) => Buffer.from(String(s), 'utf8'),
    decryptString: (buf) => Buffer.from(buf).toString('utf8')
  };
}

async function main() {
  const listed = store.addMcpServer(tmp, {
    id: 'custom-echo',
    name: 'Echo',
    description: 'test',
    command: 'npx',
    args: ['-y', 'demo-mcp']
  });
  assert(listed.some((s) => s.id === 'custom-echo' && s.builtin === false), 'custom listed');

  let threw = false;
  try {
    store.addMcpServer(tmp, { id: 'custom-echo', name: 'Dup', command: 'npx' });
  } catch (e) {
    threw = /已存在/.test(e.message);
  }
  assert(threw, 'duplicate id rejected');

  const cfg = store.getMcpServerConfigForUi(tmp, 'custom-echo');
  assert(cfg.command === 'npx', 'config command');
  assert(cfg.packageName === 'demo-mcp' || cfg.args.includes('demo-mcp'), 'npm meta from args');

  const afterDelete = store.deleteMcpServer(tmp, 'custom-echo');
  assert(!afterDelete.some((s) => s.id === 'custom-echo'), 'deleted custom');

  const repair = await store.repairMcpEnvironment(tmp, { repairKind: 'npm-cache-busy' });
  assert(repair.ok === false, 'unsupported repair');

  await remoteAndManagerChecks();
  mcpToolNamePredicateChecks();

  console.log('test-mcp-store.cjs ok');
}

/**
 * 远端（streamable-http）服务 + mcp_manage 的整条链路：
 * 建条目 → 未配 token 不算已配置 → 写 token 后已配置 → 启停 → 删除，且每次变更只重挂一次。
 */
async function remoteAndManagerChecks() {
  const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'dieyun-mcp-manage-'));
  const remoteStore = createMcpStore({ safeStorage: fakeSafeStorage() });
  try {
    const installed = remoteStore.upsertMcpFromCatalog(tmp2, {
      id: 'daizhang',
      name: '叠云代账',
      description: 'test',
      transportKind: 'remote',
      remoteUrl: 'http://127.0.0.1:3011/api/open-api/mcp',
      remoteTransport: 'streamable-http',
      authHeaderName: 'X-API-Key',
      authRequired: true
    });
    assert(installed.action === 'install', 'remote install action');
    const remote = installed.list.find((s) => s.id === 'daizhang');
    assert(remote && remote.transportKind === 'remote', 'remote transport kind');
    assert(remote.authHeaderName === 'X-API-Key', 'custom auth header kept');
    assert(remote.configured === false, 'remote without token is not configured');

    let denied = false;
    try {
      remoteStore.setMcpServerEnabled(tmp2, { id: 'daizhang', enabled: true });
    } catch (e) {
      denied = /完成配置/.test(e.message);
    }
    assert(denied, 'enable refused until configured');

    let missing = false;
    try {
      remoteStore.setMcpServerEnabled(tmp2, { id: 'nope', enabled: true });
    } catch (e) {
      missing = /不存在/.test(e.message);
    }
    assert(missing, 'unknown id refused');

    let invalidated = 0;
    let synced = 0;
    const runtime = {
      invalidateToolsCache: () => {
        invalidated += 1;
      },
      syncSessions: async () => {
        synced += 1;
      }
    };
    const manager = createMcpManager({
      userDataPath: tmp2,
      mcpStore: remoteStore,
      getRuntime: () => runtime
    });

    // list 不重挂（只读不改配置）
    const listedNow = await manager.applyToolRequest({ action: 'list' });
    assert(listedNow.ok && Array.isArray(listedNow.servers), 'list returns servers');
    assert(invalidated === 0 && synced === 0, 'list does not reload runtime');

    // add（stdio）→ 一次重挂
    const added = await manager.applyToolRequest({
      action: 'add',
      id: 'echo-srv',
      name: 'Echo SRV',
      command: 'npx',
      args: ['-y', 'demo-mcp']
    });
    assert(added.ok && added.applied === 'install', 'stdio add installed');
    assert(invalidated === 1 && synced === 1, 'add reloads runtime once');

    // add（远端 + token）：token 必须经凭据库落盘，条目才算 configured
    const remoteAdded = await manager.applyToolRequest({
      action: 'add',
      id: 'remote-x',
      name: 'Remote X',
      url: 'https://example.com/mcp',
      authHeaderName: 'X-API-Key',
      token: 'secret-token'
    });
    const remoteX = remoteAdded.servers.find((s) => s.id === 'remote-x');
    assert(remoteX && remoteX.transport === 'remote', 'remote add transport');
    assert(remoteX.configured === true, 'token stored → configured');
    assert(remoteX.url === 'https://example.com/mcp', 'remote url kept');

    // enable / 再 disable
    const enabled = await manager.applyToolRequest({ action: 'enable', id: 'remote-x' });
    assert(enabled.servers.find((s) => s.id === 'remote-x').enabled === true, 'enabled');
    const disabled = await manager.applyToolRequest({ action: 'enable', id: 'remote-x', enabled: false });
    assert(disabled.servers.find((s) => s.id === 'remote-x').enabled === false, 'disabled');

    // remove
    const removed = await manager.applyToolRequest({ action: 'remove', id: 'remote-x' });
    assert(!removed.servers.some((s) => s.id === 'remote-x'), 'remote removed');

    // 未知动作必须报错（而不是静默成功）
    let bad = false;
    try {
      await manager.applyToolRequest({ action: 'explode' });
    } catch (e) {
      bad = /未知操作/.test(e.message);
    }
    assert(bad, 'unknown action rejected');

    // request_credential：只把请求推到界面，模型拿不到明文
    const requests = [];
    const notify = (payload) => requests.push(payload);
    const uiAdded2 = await manager.applyToolRequest(
      { action: 'add', id: 'needs-key', name: 'Needs Key', url: 'https://k.example/mcp', authRequired: true },
      { notifyCredentialRequest: notify }
    );
    assert(uiAdded2.ok, 'add without token still ok');
    const asked = await manager.applyToolRequest(
      { action: 'request_credential', id: 'needs-key', reason: '调用它需鉴权' },
      { notifyCredentialRequest: notify }
    );
    assert(asked.ok && asked.requested === true, 'request_credential accepted');
    assert(requests.length === 1 && requests[0].serverId === 'needs-key', 'notifier got the request');
    assert(requests[0].fields.includes('token'), 'remote server asks for token');
    assert(!('token' in asked) && !JSON.stringify(asked).includes('secret'), 'no secret in tool result');
    const notFound = await manager.applyToolRequest(
      { action: 'request_credential', id: 'nope' },
      { notifyCredentialRequest: notify }
    );
    assert(notFound.ok === false && notFound.errorCode === 'MCP_SERVER_NOT_FOUND', 'unknown id → not found');
    const noUi = await manager.applyToolRequest({ action: 'request_credential', id: 'needs-key' });
    assert(noUi.ok === false && noUi.errorCode === 'MCP_CREDENTIAL_UI_UNAVAILABLE', 'no UI → clear error');

    // 包运维动作走 store 的实现：远端服务不是 npx 包 → 明确说不支持（且不联网、不重挂）
    const beforePkg = { invalidated, synced };
    const pkgCheck = await manager.applyToolRequest({ action: 'check_update', id: 'needs-key' });
    assert(pkgCheck.ok === true, 'check_update ok');
    assert(pkgCheck.result && pkgCheck.result.supported === false, 'remote server → not an npm package');
    assert(invalidated === beforePkg.invalidated && synced === beforePkg.synced, 'check_update does not reload');
    // repair_env 只认已知的修复类型（不认识的不能假装修好了）；store 回 ok:false 时
    // 工具信封也必须是失败 —— 外层套 ok:true 再配一句「已完成」会把模型骗过去
    const badRepair = await manager.applyToolRequest({ action: 'repair_env', repairKind: 'whatever' });
    assert(badRepair.result.ok === false, 'unknown repairKind rejected');
    assert(badRepair.ok === false, 'store said not-fixed → tool result must not be ok:true');
    assert(badRepair.errorCode === 'MCP_PACKAGE_FAILED', 'package failure keeps its errorCode');

    // UI「新增」入口同样支持远端：addMcpServer 与 upsert 共用同一处建条目
    const uiAdded = remoteStore.addMcpServer(tmp2, {
      id: 'ui-remote',
      name: 'UI Remote',
      url: 'https://example.com/mcp',
      authHeaderName: 'X-Key',
      authRequired: true
    });
    const uiRemote = uiAdded.find((s) => s.id === 'ui-remote');
    assert(uiRemote && uiRemote.transportKind === 'remote', 'addMcpServer accepts remote');
    assert(uiRemote.configured === false, 'ui remote waits for token');
    let dupId = false;
    try {
      remoteStore.addMcpServer(tmp2, { id: 'ui-remote', name: 'Dup', url: 'https://example.com/mcp' });
    } catch (e) {
      dupId = /已存在/.test(e.message);
    }
    assert(dupId, 'addMcpServer keeps create-only semantics');
  } finally {
    fs.rmSync(tmp2, { recursive: true, force: true });
  }
}

/** 工具名谓词：mcp_manage / mcp_tool_schema 不能被当成远端服务工具（否则会走 callAgentTool 而失败）。 */
function mcpToolNamePredicateChecks() {
  assert(isMcpServerToolName('mcp_mcp-daizhang__list_customers'), 'server tool recognised');
  assert(!isMcpServerToolName('mcp_manage'), 'mcp_manage is not a server tool');
  assert(!isMcpServerToolName('mcp_tool_schema'), 'mcp_tool_schema is not a server tool');
  assert(!isMcpServerToolName('fs_edit'), 'unrelated tool not matched');
  assert(toStoreRequest({ action: 'enable', id: 'x' }).payload.enabled === true, 'enable defaults true');
  assert(
    toStoreRequest({ action: 'add', id: 'y', name: 'Y', url: 'http://h/mcp', token: 't' }).payload.transportKind ===
      'remote',
    'url implies remote'
  );
  assert(
    toStoreRequest({ action: 'add', id: 'y', name: 'Y', url: 'http://h/mcp', token: 't' }).payload.authRequired ===
      true,
    'token implies authRequired'
  );
}

const empty = store.loadMcpStore(tmp);
assert(empty.custom.length === 0, 'empty custom');

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });
