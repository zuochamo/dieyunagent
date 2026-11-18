// @ts-check
'use strict';

/**
 * 内网 agent 互通的公开入口。
 *
 * 模块边界（详见 `docs/PEER-MESH-PLAN.md`）：
 * - `wire.js`        帧与信封（唯一协议定义）
 * - `store.js`       身份 / 信任清单 / 会话绑定 / 手工对端 / 开关（唯一落盘点）
 * - `workspace-key.js` 「同一个项目」判定（唯一来源）
 * - `discovery.js`   UDP 局域网宣告
 * - `server.js`      本机 WS 入站（握手换身份，未确认机器不给租约快照）
 * - `client.js`      出站请求（一次请求一次连接）
 * - `coordinator.js` 业务语义：落会话 / 自动跑一轮 / 回复回传 / 建议式租约
 *
 * 外部只需要协调器：Main 创建一份，工具层（tool-bridge）与 IPC 都经它说话。
 */

const { createPeerCoordinator } = require('./coordinator');
const { createPeerStore } = require('./store');
const { workspaceKeyFor, workspaceInfoFor } = require('./workspace-key');
const wire = require('./wire');

module.exports = {
  createPeerCoordinator,
  createPeerStore,
  workspaceKeyFor,
  workspaceInfoFor,
  wire
};
