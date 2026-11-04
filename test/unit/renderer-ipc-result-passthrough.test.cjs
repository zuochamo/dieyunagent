'use strict';

/**
 * Main → Renderer 的**结果透传契约**（静态契约测试）。
 *
 * 为什么是静态的：这条链路的错误形态是「字段在中间被重建掉了」——`agent:rust-loop-run`
 * 在 Main 里给结果挂了 `readiness`（完成验收）与 `goal`（会话目标续跑），Renderer 的
 * `chatCompletionWithToolsViaRust` 若按字段白名单重建返回值，新加的字段就会**静默消失**：
 * 目标不再续跑、完成提示不再出现，且没有任何报错。这类回归只有「把三端的字段名钉在
 * 一起」才拦得住，跑一遍真实循环（需要模型凭据）反而不适合放进单测。
 *
 * 历史故障（2026-11-04）：该函数确实按白名单重建返回对象，`goal` / `readiness` 双双丢失。
 */

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const loopSrc = read('src/renderer/renderer-agent-rust-loop.js');
const runtimeSrc = read('src/main/ipc/agent-runtime.js');
const runSrc = read('src/renderer/renderer-agent-run.js');
const completeSrc = read('src/renderer/renderer-agent-complete.js');

describe('Main → Renderer 结果透传', () => {
  it('Main 侧确实把 readiness / goal 挂到返回结果上（生产方）', () => {
    assert.match(
      runtimeSrc,
      /result\.readiness\s*=/,
      'Main 必须把完成验收结果挂到 result.readiness'
    );
    assert.match(
      runtimeSrc,
      /result\.goal\s*=/,
      'Main 必须把会话目标续跑判定挂到 result.goal'
    );
  });

  it('Renderer 取结果时先展开 Main 给的对象，再覆盖已知字段（不得按白名单重建）', () => {
    assert.match(
      loopSrc,
      /\.\.\.\(done && typeof done === 'object' \? done : null\)/,
      '返回值必须以 `...done` 起手：按字段重建会静默丢掉新增字段'
    );
    // 反证：白名单式重建（`return { runId: done.runId, ...` ）一旦回归，上面那行的语义就没了
    assert.ok(
      !/return\s*\{\s*\n\s*runId:\s*done\.runId/.test(loopSrc),
      '不得以「逐字段列出」的方式重建返回对象'
    );
  });

  it('两个消费方读的就是这两个字段名', () => {
    assert.match(
      runSrc,
      /result\.goal\s*&&\s*result\.goal\.cont/,
      'Renderer 续跑只看 `result.goal.cont`（判定本身在 Main）'
    );
    assert.match(
      completeSrc,
      /\.result\.readiness|result\.readiness/,
      'Renderer 完成提示读 `result.readiness`'
    );
  });
});
