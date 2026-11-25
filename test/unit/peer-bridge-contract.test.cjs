'use strict';

/**
 * peer 桥接口契约：`src/peer/actions.js#PEER_BRIDGE_METHODS` 必须与动作表一一对应，
 * 且桌面 preload / headless 网页都**只从这一份派生**。
 *
 * 守的是一条真实漂移：`set-auto-trust` 在动作表里有、在 `preload.js` 里没抄，
 * 而网页侧自己补了一条 —— 同一份面板两条行为（「桌面能点、网页空白」）。
 */

const fs = require('fs');
const path = require('path');
const {
  PEER_ACTION_NAMES,
  PEER_BRIDGE_METHODS,
  buildPeerBridge
} = require('../../src/peer/actions');

const camel = (action) =>
  `peer${String(action)
    .split('-')
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join('')}`;

describe('peer 桥接口契约', () => {
  it('动作表与桥表一一对应（数量相同、动作名相同）', () => {
    expect(PEER_BRIDGE_METHODS).toHaveLength(PEER_ACTION_NAMES.length);
    expect(PEER_BRIDGE_METHODS.map((d) => d.action).sort()).toEqual([...PEER_ACTION_NAMES].sort());
  });

  it('方法名由动作名派生且不重复', () => {
    const names = PEER_BRIDGE_METHODS.map((d) => d.method);
    expect(new Set(names).size).toBe(names.length);
    for (const def of PEER_BRIDGE_METHODS) {
      expect(def.method).toBe(camel(def.action));
    }
  });

  it('buildPeerBridge 把参数整形交给动作表（含 set-auto-trust 这条曾漂移的）', async () => {
    const seen = [];
    const bridge = buildPeerBridge(async (action, payload) => {
      seen.push([action, payload]);
      return { ok: true };
    });
    for (const def of PEER_BRIDGE_METHODS) expect(typeof bridge[def.method]).toBe('function');

    await bridge.peerStatus();
    await bridge.peerSetAutoTrust(true);
    await bridge.peerTrust('peer-1', 'allow');
    await bridge.peerRoomClose('room-1');

    expect(seen).toEqual([
      ['status', {}],
      ['set-auto-trust', { enabled: true }],
      ['trust', { peerId: 'peer-1', decision: 'allow' }],
      ['room-close', { roomId: 'room-1' }]
    ]);
  });

  it('两侧都不再手抄 peer 方法（都从 PEER_BRIDGE_METHODS 派生）', () => {
    for (const rel of ['src/preload.js', 'src/headless/desktop-ui.js']) {
      const src = fs.readFileSync(path.join(__dirname, '../..', rel), 'utf8');
      // 桌面用 buildPeerBridge(...)，网页在生成脚本时展开 PEER_BRIDGE_METHODS —— 两者同源
      expect(src).toMatch(/buildPeerBridge\(|PEER_BRIDGE_METHODS/);
      // 手抄的特征：对**具体动作名**直接 invoke / agentCall（派生写法是 'peer:'+action 这种拼接）
      expect(src).not.toMatch(/ipcRenderer\.invoke\('peer:[a-z]/);
      expect(src).not.toMatch(/agentCall\('peer\.[a-z]/);
    }
  });
});
