'use strict';

/**
 * `peer_list` / `peer_send` / `peer_claim` 三个工具在**工具层**的形状断言。
 *
 * 为什么单独测：协调器返回的是内部形状（`{ok, error, holders}`），模型看到的是工具层
 * 转换后的形状（`errorCode` / `retryable` / `suggestedFix` / `peers` 提示）。这层出错时
 * agent 会拿到「无法解释的失败」，比直接报错更糟。
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createPeerCoordinator } = require('../src/peer');
const { createMainToolBridge } = require('../src/agent/tool-bridge-main');
const { getToolByName, ALL_STATIC_TOOLS } = require('../src/agent/tool-catalog');
const { AGENT_LIMITS_DEFAULTS } = require('../src/agent/agent-limits');

function mkTmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `dieyun-peer-${prefix}-`));
}

const NOOP_GATEWAY = { invokeRpc: async () => ({ ok: true }) };

async function main() {
  // —— schema 必须在目录里 ——
  for (const name of ['peer_list', 'peer_send', 'peer_claim']) {
    assert.ok(getToolByName(name), `${name} 应在工具目录中`);
    assert.ok(
      ALL_STATIC_TOOLS.some((t) => t.function && t.function.name === name),
      `${name} 应在 ALL_STATIC_TOOLS 中（否则模型看不到）`
    );
  }

  // —— 必须在**桌面聊天路径**的工具表里 ——
  // `ALL_STATIC_TOOLS` 只是汇总表：模型看到的工具集由 renderer-tool-defs.js#buildAgentTools
  // 逐个 push（Main 侧另一份是 PLAN_RUNTIME_TOOL_NAMES）。进了汇总表但没进这两处，
  // 就等于「schema 在、执行也在、只有模型永远调不到」—— 它会如实回答「工具表里没有」。
  const catalog = require('../src/agent/tool-catalog');
  assert.ok(
    Array.isArray(catalog.PEER_TOOLS) && catalog.PEER_TOOLS.length === 3,
    'PEER_TOOLS 必须从 tool-catalog 导出（渲染器要取这一份）'
  );
  const toolDefsSrc = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'renderer', 'renderer-tool-defs.js'),
    'utf8'
  );
  assert.ok(/_tc\.PEER_TOOLS/.test(toolDefsSrc), 'renderer-tool-defs.js 必须从 DieyunToolCatalog 取 PEER_TOOLS');
  assert.ok(
    /tools\.push\(\.\.\.PEER_TOOLS\)/.test(toolDefsSrc),
    'renderer-tool-defs.js 必须把 PEER_TOOLS 推进工具表（否则模型看不到 peer_send）'
  );

  // —— Main 侧跑一轮（计划 / 频道 / headless / peer 来信触发的那一轮）也要有 ——
  // 服务器上没有 Renderer，它那一轮的工具表来自 `main-agent-tools.js`；
  // 缺了这三件，headless 永远只能「被动被呼叫」而不能主动派活。
  const mainTools = await require('../src/agent/main-agent-tools').buildMainAgentTools(null);
  for (const name of ['peer_list', 'peer_send', 'peer_claim']) {
    assert.ok(
      mainTools.some((t) => t.function && t.function.name === name),
      `${name} 应在 Main 侧工具表（main-agent-tools）里，否则 headless / 频道 / 计划都调不到`
    );
  }

  // —— 装配只有一个来源：桌面与 headless 都走 src/peer/boot.js ——
  const bootSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'peer', 'boot.js'), 'utf8');
  assert.ok(/noteTurnCompleted/.test(bootSrc), 'peer/boot.js 必须接上跨机回合回传（否则对端等到超时）');
  for (const entry of ['src/main-entry.js', 'src/headless/boot.js']) {
    const src = fs.readFileSync(path.join(__dirname, '..', entry), 'utf8');
    assert.ok(/bootPeerRuntime/.test(src), `${entry} 必须走 src/peer/boot.js 装配互通（勿各写一份）`);
  }

  // —— 桌面与网页两侧都必须能回答同一套动作 ——
  // 面板代码只有一套（`renderer-peer.js`），四处入口却不一样：桌面 preload IPC、headless
  // 网页 `/ws`、以及桌面/网页各自的注入面。任何一处漏一个方法，症状都是「某个界面空白」，
  // 而不会报错 —— 所以用「用到的集合 ⊆ 两侧实现的集合」把它们钉住。
  const { PEER_ACTION_NAMES, createPeerActions } = require('../src/peer/actions');
  const preloadSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'preload.js'), 'utf8');
  const ipcChannels = [...preloadSrc.matchAll(/invoke\('peer:([\w-]+)'/g)].map((m) => m[1]);
  assert.ok(ipcChannels.length >= 10, `preload 里应能扫到 peer:* 通道，实际 ${ipcChannels.length}`);
  for (const ch of ipcChannels) {
    assert.ok(PEER_ACTION_NAMES.includes(ch), `preload 的 peer:${ch} 必须在 src/peer/actions.js 的动作表里`);
  }
  const uiSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'headless', 'desktop-ui.js'), 'utf8');
  const rendererPeerSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'renderer-peer.js'), 'utf8');
  const usedByPanel = new Set([...rendererPeerSrc.matchAll(/peerApi\.(\w+)/g)].map((m) => m[1]));
  for (const name of usedByPanel) {
    assert.ok(
      new RegExp(`\\b${name}:`).test(uiSrc),
      `桌面面板用到的 ${name} 必须在 headless 网页替身（desktop-ui.js）里实现，否则网页里 Bot 面板是空的`
    );
  }

  // —— 未启用时：结构化「能力没开」，不是静默消失 ——
  const disabledBridge = createMainToolBridge({ gateway: NOOP_GATEWAY, userDataPath: '' });
  for (const [name, args] of [
    ['peer_list', {}],
    ['peer_send', { peer: 'x', text: 'hi' }],
    ['peer_claim', { action: 'list' }]
  ]) {
    const r = await disabledBridge.executeAgentTool(name, args, { sessionId: 's1' });
    assert.ok(r && r.ok === false, `${name} 未启用时应返回 ok:false`);
    assert.strictEqual(r.errorCode, 'PEER_UNAVAILABLE', `${name} 未启用时 errorCode 应为 PEER_UNAVAILABLE`);
  }

  // —— 启用后 ——
  const dir = mkTmp('tools');
  const coordinator = createPeerCoordinator({
    userDataPath: dir,
    getWorkspace: () => ({ workspacePath: path.join(__dirname, '..') }),
    rpc: async () => ({ ok: true }),
    submitTask: async () => ({ requestId: 'r1' }),
    limits: () => ({ ...AGENT_LIMITS_DEFAULTS, peerPortBase: 18370, peerDiscoveryPort: 18343 }),
    log: () => {}
  });

  try {
    await coordinator.start();
    const bridge = createMainToolBridge({ gateway: NOOP_GATEWAY, userDataPath: '', peerCoordinator: coordinator });
    const ctx = { sessionId: 'sess_peer_tool' };

    const list = await bridge.executeAgentTool('peer_list', {}, ctx);
    assert.ok(list && list.ok === true, `peer_list 应成功: ${JSON.stringify(list)}`);
    assert.ok(Array.isArray(list.peers), 'peer_list 应返回 peers 数组');
    assert.strictEqual(typeof list.note, 'string', 'peer_list 应带一句说明');

    const noTarget = await bridge.executeAgentTool('peer_send', { text: '有话没处说' }, ctx);
    assert.ok(noTarget && noTarget.ok === false, '缺对端应失败');
    assert.strictEqual(noTarget.errorCode, 'MISSING_ARG');
    assert.ok(
      noTarget.diagnostics && Array.isArray(noTarget.diagnostics.peers),
      `缺对端时应附上可选对端（diagnostics.peers），实际 ${JSON.stringify(noTarget)}`
    );

    const notFound = await bridge.executeAgentTool('peer_send', { peer: '不存在的机器', text: 'hi' }, ctx);
    assert.ok(notFound && notFound.ok === false);
    assert.strictEqual(notFound.errorCode, 'PEER_NOT_FOUND');
    assert.strictEqual(notFound.retryable, false, '找不到人不是可重试错误');

    const unreachable = await bridge.executeAgentTool(
      'peer_send',
      { host: '127.0.0.1', port: 1, text: 'hi' },
      ctx
    );
    assert.ok(unreachable && unreachable.ok === false, '连不通应失败');
    assert.strictEqual(unreachable.retryable, true, '连不通属于可重试（对方可能刚开机）');

    // —— 动作表（桌面 IPC 与 headless 网页共用）：真的能驱动协调器 ——
    const actions = createPeerActions(() => coordinator);
    const actionStatus = await actions.handle('status');
    assert.ok(actionStatus.ok === true && actionStatus.status && actionStatus.status.peerId, 'status 动作应返回本机身份');
    const actionRooms = await actions.handle('rooms');
    assert.ok(actionRooms.ok === true && Array.isArray(actionRooms.rooms), 'rooms 动作应返回房间数组');
    const actionTrust = await actions.handle('set-auto-trust', { enabled: true });
    assert.ok(actionTrust.ok === true && actionTrust.settings.autoTrust === true, 'set-auto-trust 应落成 true');
    await actions.handle('set-auto-trust', { enabled: false });
    const unknownAction = await actions.handle('nope', {});
    assert.ok(unknownAction.ok === false, '未知动作应返回 ok:false 而不是抛');
    const actionsWithoutCoordinator = createPeerActions(() => null);
    const noCoord = await actionsWithoutCoordinator.handle('status');
    assert.strictEqual(noCoord.errorCode, 'PEER_UNAVAILABLE', '没有协调器时应给 PEER_UNAVAILABLE');

    const claim = await bridge.executeAgentTool(
      'peer_claim',
      { action: 'acquire', kind: 'file', key: 'src/peer/wire.js', note: '改信封' },
      ctx
    );
    assert.ok(claim && claim.ok === true, `拿租约应成功: ${JSON.stringify(claim)}`);

    const listed = await bridge.executeAgentTool('peer_claim', { action: 'list' }, ctx);
    assert.ok(listed && listed.ok === true);
    assert.ok(
      (listed.claims || []).some((c) => c.key === 'src/peer/wire.js'),
      'list 应能看到自己刚申领的租约'
    );

    const released = await bridge.executeAgentTool(
      'peer_claim',
      { action: 'release', kind: 'file', key: 'src/peer/wire.js' },
      ctx
    );
    assert.ok(released && released.ok === true, '释放租约应成功');
  } finally {
    coordinator.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }

  console.log('test-peer-tools.cjs ok');
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
