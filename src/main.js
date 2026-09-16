'use strict';

/** 安装引导独立进程：主应用退出后仍显示叠云风格安装进度 */
if (process.argv.includes('--update-bootstrap')) {
  require('./update-bootstrap/run.js');
} else {
  try {
    require('../scripts/win-utf8-console.cjs');
  } catch (_) {
    /* ignore */
  }
  require('./app-paths').configure();
  require('./main-entry.js');
}
