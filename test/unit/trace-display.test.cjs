'use strict';

/**
 * 回放「展示态」trace 整形（`src/agent/trace-display.js`）。
 *
 * 现场：思考区回放时每条历史回合各取一份**整份** trace（首屏最多 32 次），而其中一大半
 * 字段收起状态根本用不到 —— 全库实测 58.7MB 里 `tool.result` 11.5%、`tool.toolArgs` 9.9%
 * （界面只读 `filePath`）、`tool.args` 2.4%、`diff` 正文 12.1%、普通回合 `fullThought` 27.9%。
 *
 * 这里锁的是「裁什么、留什么、怎么标记」这条契约：
 * 1. 界面从不读的字段直接不搬；
 * 2. 摘要要用的（thought / 工具名 / argsBrief / summary / diff 统计 / filePath）一个都不能少；
 * 3. 裁掉正文的 diff **保留空串 + `textTrimmed`**：删键会让「查看 diff · +N -M」整行消失（改变界面）；
 * 4. 展开后才需要的（`fullThought` 尾巴、diff 正文）打标记，渲染层按标记去取完整态；
 * 5. 子 Agent 卡片（`isolated`）默认展开 → 思考与嵌套轮次原样保留；
 * 6. 不修改入参（缓存与落库两条路都可能还拿着它）。
 */

const assert = require('node:assert/strict');
const path = require('node:path');

const { shapeTraceForDisplay } = require(path.join(
  __dirname,
  '..',
  '..',
  'src',
  'agent',
  'trace-display.js'
));

function makeRow() {
  return {
    runId: 'trace-1',
    sessionId: 's1',
    trace: [
      {
        round: 1,
        phase: 'tool',
        thought: '短版思考',
        fullThought: 'F'.repeat(50),
        visibleContent: '旁白',
        tools: [
          {
            name: 'fs_edit_file',
            argsBrief: 'src/a.js',
            summary: '写入完成 +12 -3',
            toolArgs: { filePath: 'src/a.js', content: 'x'.repeat(200) },
            args: { filePath: 'src/a.js', big: 'y'.repeat(200) },
            result: { ok: true, output: 'z'.repeat(300) },
            diff: { created: false, added: 12, removed: 3, beforeText: 'B'.repeat(300), afterText: 'A'.repeat(300), beforeSnippet: 'snip' }
          }
        ]
      },
      {
        round: 2,
        phase: 'answer',
        thought: '第二轮的短思考',
        fullThought: 'G'.repeat(5), // 短于 headChars，原样保留
        tools: []
      }
    ]
  };
}

const HEAD = 10;
const shaped = shapeTraceForDisplay(makeRow(), { thoughtHeadChars: HEAD });
const [e1, e2] = shaped.trace;

test('界面从不读的 tool 字段不再搬运（result / args）', () => {
  const tool = e1.tools[0];
  assert.equal(tool.result, undefined);
  assert.equal(tool.args, undefined);
});

test('toolArgs 只留 filePath（摘要与产物识别只读它）', () => {
  assert.deepEqual(e1.tools[0].toolArgs, { filePath: 'src/a.js' });
});

test('摘要要用的字段一个都不能少', () => {
  const tool = e1.tools[0];
  assert.equal(tool.name, 'fs_edit_file');
  assert.equal(tool.argsBrief, 'src/a.js');
  assert.equal(tool.summary, '写入完成 +12 -3');
  assert.equal(e1.thought, '短版思考');
  assert.equal(e1.visibleContent, '旁白');
  assert.equal(e1.phase, 'tool');
  assert.equal(e1.round, 1);
});

test('diff 正文被裁：保留空串与统计，并打 textTrimmed（不删键，否则「查看 diff」整行消失）', () => {
  const diff = e1.tools[0].diff;
  assert.equal(diff.beforeText, '');
  assert.equal(diff.afterText, '');
  assert.equal(diff.textTrimmed, true);
  assert.equal(diff.added, 12);
  assert.equal(diff.removed, 3);
  assert.equal(diff.created, false);
  assert.equal(diff.beforeSnippet, 'snip', '片段要留着（收起时摘要行与兜底渲染都用它）');
});

test('fullThought 超长才截断并打标，短的整条保留', () => {
  assert.equal(e1.fullThought, 'F'.repeat(HEAD));
  assert.equal(e1.fullThoughtTruncated, true);
  assert.equal(e1.fullThoughtChars, 50);
  assert.equal(e2.fullThought, 'G'.repeat(5), '没超长就不该动它');
  assert.equal(e2.fullThoughtTruncated, undefined);
});

test('子 Agent 卡片（isolated）整块不裁：思考、嵌套轮次、工具行全部原样', () => {
  const row = {
    trace: [
      {
        isolated: true,
        subagentId: 'sa-1',
        fullThought: 'H'.repeat(50),
        rounds: [
          {
            round: 1,
            fullThought: 'I'.repeat(50),
            tools: [
              {
                name: 'fs_edit_file',
                summary: '3 命中',
                toolArgs: { filePath: 'a.js', content: 'x'.repeat(50) },
                args: { filePath: 'a.js' },
                result: { out: 'r'.repeat(100) },
                diff: { created: false, added: 1, removed: 0, beforeText: 'B'.repeat(20), afterText: 'A'.repeat(20) }
              }
            ]
          }
        ]
      }
    ]
  };
  const out = shapeTraceForDisplay(row, { thoughtHeadChars: HEAD });
  const entry = out.trace[0];
  assert.equal(entry.fullThought, 'H'.repeat(50), '卡片默认展开，思考不能截');
  assert.equal(entry.fullThoughtTruncated, undefined);
  assert.equal(entry.rounds[0].fullThought, 'I'.repeat(50));
  // 卡片里的工具行也原样：裁了它就得再对一层 index 才能补回来，不值得
  const tool = entry.rounds[0].tools[0];
  assert.ok(tool.result, '卡片里的 result 保留（整块不裁）');
  assert.ok(tool.args, '卡片里的 args 保留');
  assert.deepEqual(tool.toolArgs, { filePath: 'a.js', content: 'x'.repeat(50) });
  assert.equal(tool.diff.beforeText, 'B'.repeat(20), '卡片里的 diff 正文保留');
  assert.equal(tool.diff.textTrimmed, undefined);
  assert.equal(out.displayShape.trimmedFields, 0, '整块不裁 → 一处都没动');
});

test('不修改入参（缓存 / 落库两条路可能还握着原对象）', () => {
  const row = makeRow();
  const before = JSON.stringify(row);
  shapeTraceForDisplay(row, { thoughtHeadChars: HEAD });
  assert.equal(JSON.stringify(row), before);
});

test('没有 trace 的行原样返回（空行 / 未命中不该被包一层）', () => {
  assert.equal(shapeTraceForDisplay(null), null);
  const empty = { runId: 'trace-2', trace: [] };
  assert.equal(shapeTraceForDisplay(empty, { thoughtHeadChars: HEAD }), empty);
});

test('整形结果自带 displayShape 统计（便于排查「这一条为什么还是大」）', () => {
  assert.equal(shaped.displayShape.thoughtHeadChars, HEAD);
  assert.equal(shaped.displayShape.truncatedThoughts, 1);
  assert.ok(shaped.displayShape.trimmedFields >= 1);
});
