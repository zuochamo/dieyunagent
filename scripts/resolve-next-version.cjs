'use strict';

/**
 * 打印「建议的下一个发布版号」（当前开发版 +1 patch），供发布入口批处理读取。
 * stdout 只输出一个版本号，便于 `for /f` 取值；出错走 stderr + 非零退出码。
 */

const { readCurrentVersion, nextReleaseVersion } = require('./app-version.cjs');

let current = '';
try {
  current = readCurrentVersion();
} catch (err) {
  console.error(`[ERROR] 读取 package.json 失败: ${err.message}`);
  process.exit(1);
}

const next = nextReleaseVersion(current);
if (!next) {
  console.error(`[ERROR] 无法从 package.json version 推导下一个版号: ${current || '(空)'}`);
  process.exit(1);
}
console.log(next);
