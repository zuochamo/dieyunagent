'use strict';

/**
 * 把 `src/renderer/renderer-utils.js` 装进一个极简沙箱，取出**文案格式函数**。
 *
 * 为什么需要它：渲染层脚本没有 module.exports，单元测试只能用 `new Function` 造沙箱把源码装进去。
 * 格式函数自 2026-11 起只剩 `renderer-utils.js` 一份实现（`fmtClock` / `fmtRelShort` / `fmtRelAgo` …），
 * 面板源码里不再自带副本 —— 所以测试必须把**真的那一份**注入沙箱，而不是在测试里另写一遍实现
 * （那样测的就不是生产代码了）。
 *
 * 用法：
 *   const { loadRendererFmt } = require('./lib/load-renderer-fmt.cjs');
 *   const fmt = loadRendererFmt();
 *   // factory 的形参里加 'fmtRelAgo'，实参传 fmt.fmtRelAgo
 */

const fs = require('node:fs');
const path = require('node:path');

const UTILS_SRC = path.join(__dirname, '..', '..', '..', 'src', 'renderer', 'renderer-utils.js');

const EXPORTED = ['fmtClock', 'fmtMonthDayClock', 'fmtRelShort', 'fmtRelAgo', 'fmtDateTime', 'fmtBar', 'fmtBytes'];

function loadRendererFmt() {
  const win = { addEventListener() {} };
  const doc = {
    getElementById: () => null,
    createElement: () => ({
      style: {},
      classList: { add() {}, remove() {}, toggle() {} },
      appendChild() {},
      addEventListener() {}
    }),
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {}
  };
  const factory = new Function(
    'window',
    'document',
    `${fs.readFileSync(UTILS_SRC, 'utf8')}
     return { ${EXPORTED.join(', ')} };`
  );
  return factory(win, doc);
}

module.exports = { loadRendererFmt, RENDERER_FMT_NAMES: EXPORTED };
