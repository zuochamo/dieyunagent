'use strict';
/**
 * 运行中 trace checkpoint 的增量切片（审计 P1-5）。
 *
 * `src/renderer/agent/trace-store.js` 是纯浏览器脚本：不进 esbuild bundle，由 <script>
 * 直接加载，也没有 module.exports。所以这里用 `new Function` 造一个只带 `window` 的
 * 求值环境，取出其中的纯函数来断言——不触碰任何浏览器全局状态。
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = path.join(__dirname, '..', '..', 'src', 'renderer', 'agent', 'trace-store.js');

function loadTraceStoreProbe() {
  const source = fs.readFileSync(SRC, 'utf8');
  const factory = new Function(
    'window',
    `${source}\nreturn { buildTraceCheckpointDelta, tracePrefixFingerprint };`
  );
  // 文件尾部会以 `window.DieyunNamespaces.register('DieyunAgent', {...})` 自我注册，
  // 这里给个空实现即可——断言只针对两个纯函数，不触碰注册表。
  return factory({ diecloud: {}, DieyunNamespaces: { register() {} } });
}

const { buildTraceCheckpointDelta, tracePrefixFingerprint } = loadTraceStoreProbe();

/** 造一个「已落库 count 条」的游标，指纹与被落库的前缀一致。 */
function cursorFor(runId, trace, count) {
  return { runId, count, fingerprint: tracePrefixFingerprint(trace, count - 1) };
}

describe('trace checkpoint 增量切片', () => {
  it('没有游标时全量发送', () => {
    const trace = [
      { round: 1, thought: 'A' },
      { round: 2, thought: 'B' }
    ];
    const delta = buildTraceCheckpointDelta({}, 'run-1', trace);
    assert.equal(delta.from, 0);
    assert.deepEqual(delta.entries, trace);
  });

  it('游标命中时只发「会变的尾部 + 新增」', () => {
    const landed = [
      { round: 1, thought: '看入口' },
      { round: 2, thought: '读 flush' }
    ];
    const live = { traceCheckpointCursor: cursorFor('run-1', landed, landed.length) };
    // 前缀（第 0 条）按值不变，尾部思考在长，并新增一轮。
    const next = [
      { round: 1, thought: '看入口' },
      { round: 2, thought: '读 flush 并补测' },
      { round: 3, thought: '改代码' }
    ];
    const delta = buildTraceCheckpointDelta(live, 'run-1', next);
    assert.equal(delta.from, 1, '起点 = 已落库条数 - 1，尾部一并重发');
    assert.deepEqual(delta.entries, [next[1], next[2]]);
  });

  it('前缀被改写（重试重排）时退回全量', () => {
    const live = {
      traceCheckpointCursor: cursorFor(
        'run-1',
        [
          { thought: 'A' },
          { thought: 'B' }
        ],
        2
      )
    };
    const rewritten = [{ thought: 'A 被重写' }, { thought: 'B2' }, { thought: 'C' }];
    assert.equal(buildTraceCheckpointDelta(live, 'run-1', rewritten).from, 0);
  });

  it('trace 变短时退回全量', () => {
    const live = { traceCheckpointCursor: cursorFor('run-1', [{ thought: 'A' }], 5) };
    const shorter = [{ thought: 'A' }, { thought: 'B' }];
    const delta = buildTraceCheckpointDelta(live, 'run-1', shorter);
    assert.equal(delta.from, 0);
    assert.deepEqual(delta.entries, shorter);
  });

  it('换了 run 时退回全量', () => {
    const landed = [
      { thought: 'A' },
      { thought: 'B' }
    ];
    const live = { traceCheckpointCursor: cursorFor('run-1', landed, landed.length) };
    assert.equal(buildTraceCheckpointDelta(live, 'run-2', landed).from, 0);
  });

  it('只落了 1 条时不走增量分支（尾部工具状态翻转必须全量覆盖）', () => {
    const landed = [{ thought: 'A', tools: [{ id: 't1', pending: true }] }];
    const live = { traceCheckpointCursor: cursorFor('run-1', landed, 1) };
    const settled = [{ thought: 'A', tools: [{ id: 't1', pending: false }] }];
    const delta = buildTraceCheckpointDelta(live, 'run-1', settled);
    assert.equal(delta.from, 0);
    assert.deepEqual(delta.entries, settled);
  });
});
