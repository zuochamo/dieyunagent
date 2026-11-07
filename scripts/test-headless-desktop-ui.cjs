'use strict';

/**
 * 浏览器版桌面界面（`/app/`）的静态护栏。
 *
 * 为什么值得单独一条：shim 是**模板字符串生成**的 JS。模板里的注释/文案一旦出现反引号，
 * 会提前闭合模板，产物是一段语法错误的脚本 —— 而那时代码本身仍然 `node --check`/`tsc` 全绿
 * （坏的是字符串内容），要等部署起来才看到 `桌面界面未启用：Unexpected identifier …`
 * 和 `/app/` 直接 404（2026-11-05 真实踩过）。所以这里把「生成物能不能被解析」钉住。
 */

const assert = require('assert');
const { createDesktopUi, buildShim } = require('../src/headless/desktop-ui');

function makeShim(overrides = {}) {
  return buildShim({
    gatewayUrl: 'ws://127.0.0.1:17330',
    gatewayToken: 'gw-token',
    webToken: 'web-token',
    workspacePath: '/srv/agent-workspace',
    modelSettings: { textModel: 'm' },
    rustCoreReady: true,
    permissions: {},
    ...overrides
  });
}

// 1) 生成物必须能被解析（模板里出现反引号就会让这条挂掉）
const shim = makeShim();
assert.doesNotThrow(() => new Function(shim), 'shim 必须是合法 JS');
assert.ok(shim.length > 2000, 'shim 不应为空');

// 2) 渲染层用到的 preload 能力必须在
for (const key of [
  'getGatewayInfo',
  'getWorkspace',
  'setLocalWorkspace',
  'setWorkspace',
  'browseServerDir',
  'getPermissions',
  'setPermissions',
  'agentRustLoopRun'
]) {
  assert.ok(shim.includes(key), `shim 缺少 ${key}`);
}
// 工作区切换必须走 /ws 的那一个方法，别在 shim 里另写一份
assert.ok(shim.includes("'desktop.set_workspace'"), 'shim 应调用 desktop.set_workspace');
assert.ok(shim.includes("'desktop.list_dirs'"), 'shim 应调用 desktop.list_dirs');
assert.ok(shim.includes("'desktop.set_permissions'"), 'shim 应调用 desktop.set_permissions');
assert.ok(shim.includes('applyWorkspace'), 'shim 应有工作区镜像的唯一写入点');

// 3) 注入值要进得去（路径带空格/中文是常态，字符串化不能拼坏）
const tricky = makeShim({ workspacePath: "/opt/叠云 Agent/it's here" });
assert.doesNotThrow(() => new Function(tricky), '带引号/中文的路径也要生成合法 JS');
assert.ok(tricky.includes('叠云 Agent'), '工作空间路径应原样注入');

// 4) 没有工作空间时也能生成
const empty = makeShim({ workspacePath: '' });
assert.doesNotThrow(() => new Function(empty), '空工作空间也要合法');

// 5) 工厂本身可用
const ui = createDesktopUi({
  packageRoot: process.cwd(),
  getGatewayInfo: () => ({ token: 'gw' }),
  getWebToken: () => 'web',
  getWorkspace: () => '/tmp',
  getModelSettings: () => null,
  getPermissions: () => ({}),
  getRustCoreReady: () => true
});
assert.strictEqual(typeof ui.handleHttp, 'function', 'handleHttp');
assert.strictEqual(typeof ui.handleUpgrade, 'function', 'handleUpgrade');

console.log('test-headless-desktop-ui.cjs ok');
