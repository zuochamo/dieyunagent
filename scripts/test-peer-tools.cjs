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
