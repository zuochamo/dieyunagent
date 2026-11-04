'use strict';

/**
 * Electron 宿主的唯一取用点（浏览器能力栈用）。
 *
 * 为什么不在模块顶部直接 `require('electron')`：
 * Gateway 的 handler 汇总（`gateway/handlers/index.js`）会静态加载 `browser` handler，
 * 而 headless（纯 Node / 服务器无 Chromium）**同样要加载这条链路**才能启动。顶部 require
 * 一旦在无 Electron 的进程里执行，结果不是「浏览器不可用」而是 `MODULE_NOT_FOUND` 直接把
 * 整个进程打死 —— 连终端模式都起不来。`browser_*` 工具在无窗口环境本来就不可用
 * （见 docs/HEADLESS-MODE-PLAN.md §5.2），所以这里把「取 Electron」推迟到真正调用时才发生。
 *
 * 只给浏览器/捕获这类**必须**有 Electron 的代码用；普通路径优先走既有单一来源
 * （例如目录解析在 `src/app-paths.js`，它在自己的 `configure()` 里取 electron）。
 */

let cached = null;
let failed = null;

function requireElectron() {
  if (cached) return cached;
  if (failed) throw failed;
  try {
    // eslint-disable-next-line global-require
    const mod = require('electron');
    // **形状校验**：在纯 Node 进程里 `require('electron')` 并不抛错，而是返回可执行文件的
    // **路径字符串**。若直接缓存，`electronOrNull()?.app` 会静默变成 undefined，
    // 故障点就漂到调用方（表现成「下载目录莫名其妙是 cwd」）。这里按「没有宿主」处理。
    if (!mod || typeof mod !== 'object' || (!mod.app && !mod.BrowserWindow)) {
      throw new Error('require("electron") 未返回 Electron API 对象（当前进程不是 Electron 宿主）');
    }
    cached = mod;
    return cached;
  } catch (e) {
    failed = new Error('浏览器能力需要 Electron 宿主：无界面（headless）模式不支持 browser_* 工具');
    failed.code = 'ELECTRON_UNAVAILABLE';
    failed.cause = e;
    throw failed;
  }
}

/** 只在不关心缺失时使用（例如「有就用 Electron 的下载目录，没有就用 cwd」） */
function electronOrNull() {
  try {
    return requireElectron();
  } catch {
    return null;
  }
}

module.exports = { requireElectron, electronOrNull };
