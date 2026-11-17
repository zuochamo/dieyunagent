'use strict';

/**
 * 「只有 Main 能执行」的工具：**工具名 → 执行体**的注册表。
 *
 * 以前是一个 1036 行的 switch（24 个 case），加一个工具要在两千行里找位置，也没测试
 * 兜得住「改 A 分组的 case 顺手弄坏 B」。现在每个域一个文件、一个函数，注册表只有这一处。
 *
 * 返回 null 表示「不是 Main 专属工具」—— 调用方继续走 Gateway 委托（delegate-tool-gateway）。
 * 这个 null 语义是协议的一部分，别改成抛错。
 *
 * @param {object} shared 工具桥闭包里的依赖与取值器（tool-bridge-main.js 组装）
 */
const { createCameraHandlers } = require('./camera');
const { createMcpHandlers } = require('./mcp');
const { createRemoteHandlers } = require('./remote');
const { createSkillsHandlers } = require('./skills');
const { createPlansHandlers } = require('./plans');
const { createGoalsHandlers } = require('./goals');
const { createMemoryHandlers } = require('./memory');
const { createPeerHandlers } = require('./peer');

function createMainToolHandlers(shared) {
  return {
  ...createCameraHandlers(shared),
  ...createMcpHandlers(shared),
  ...createRemoteHandlers(shared),
  ...createSkillsHandlers(shared),
  ...createPlansHandlers(shared),
  ...createGoalsHandlers(shared),
  ...createMemoryHandlers(shared),
  ...createPeerHandlers(shared)
  };
}

module.exports = { createMainToolHandlers };
