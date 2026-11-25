'use strict';

/**
 * Pure-logic smoke for composer queue normalize + live-run 收尾判据。
 * Run: node scripts/test-composer-queue-edit.cjs
 *
 * ⚠️ 这里**不许再抄一份实现**：2026-11-21 之前的版本把
 * `newComposerQueueItemId` / `normalizeComposerQueueItem` / `normalizeComposerQueueList` /
 * `reorderById` / `shouldAutoFlush` / `takeById` / `insertAt` 全在脚本里重写一遍再断言自己，
 * 其中 `reorderById` / `shouldAutoFlush` / `takeById` 在 `src/` 里根本不存在 ——
 * 断言全绿也证明不了生产代码。现在改为用沙箱把**真实源码**装进来断言（同
 * `test/unit/lib/load-renderer-fmt.cjs` 的做法）。
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

/** 把一段「无 module.exports 的渲染层脚本」装进沙箱，取回指定顶层声明。 */
function loadRendererScript(relPath, names) {
  const src = fs.readFileSync(path.join(ROOT, relPath), 'utf8');
  const win = {};
  const doc = {
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: () => ({
      style: {},
      classList: { add() {}, remove() {}, toggle() {} },
      appendChild() {},
      addEventListener() {},
      remove() {}
    }),
    addEventListener() {},
    body: { appendChild() {}, classList: { add() {}, remove() {}, toggle() {} } }
  };
  const storage = new Map();
  const localStorage = {
    getItem: (k) => (storage.has(k) ? storage.get(k) : null),
    setItem: (k, v) => storage.set(k, String(v)),
    removeItem: (k) => storage.delete(k)
  };
  // 只传 window/document/localStorage：其余自由标识符只在函数体内出现，调用前不需要存在。
  const factory = new Function(
    'window',
    'document',
    'localStorage',
    src + '\nreturn { ' + names.join(', ') + ' };'
  );
  return factory(win, doc, localStorage);
}

function main() {
  const queue = loadRendererScript('src/renderer/renderer-composer-queue.js', [
    'newComposerQueueItemId',
    'normalizeComposerQueueItem',
    'normalizeComposerQueueList',
    'COMPOSER_QUEUE_SOFT_FAIL_LIMIT'
  ]);

  // 老数据（没有 id / rev）经归一化后必须补齐，且时间戳沿用原值
  const legacy = queue.normalizeComposerQueueList([
    { text: 'hello', attachments: [], enqueuedAt: 100 },
    { text: 'world', enqueuedAt: 200 }
  ]);
  assert.strictEqual(legacy.length, 2);
  assert.ok(legacy[0].id.startsWith('cq-'), '缺 id 的老条目要补一个新 id');
  assert.ok(legacy[1].id.startsWith('cq-'));
  assert.notStrictEqual(legacy[0].id, legacy[1].id, '两个条目不能拿到同一个 id');
  assert.strictEqual(legacy[0].rev, 0);
  assert.strictEqual(legacy[0].updatedAt, 100);
  assert.strictEqual(legacy[0].text, 'hello');

  // 已有字段必须原样保留（编辑 / 重排靠 id + rev 定位）
  const kept = queue.normalizeComposerQueueItem({
    id: 'cq-fixed',
    text: 'x',
    rev: 3,
    enqueuedAt: 1,
    updatedAt: 2,
    attachments: [{ path: 'a.png' }]
  });
  assert.strictEqual(kept.id, 'cq-fixed');
  assert.strictEqual(kept.rev, 3);
  assert.strictEqual(kept.updatedAt, 2);
  assert.strictEqual(kept.attachments.length, 1);
  assert.notStrictEqual(kept.attachments, undefined);

  // 空白正文按「只有附件」的默认文案落库
  const empty = queue.normalizeComposerQueueItem({ text: '   ' });
  assert.strictEqual(empty.text, '请根据附件内容协助我。');

  // 非数组输入不许炸
  assert.deepStrictEqual(queue.normalizeComposerQueueList(null), []);

  // 软失败上限是「连续发送失败到第 N 次就暂停队列」的判据，只能来自生产常量
  assert.strictEqual(typeof queue.COMPOSER_QUEUE_SOFT_FAIL_LIMIT, 'number');
  assert.ok(queue.COMPOSER_QUEUE_SOFT_FAIL_LIMIT >= 2, '软失败上限至少 2 才有「重试」的含义');

  // live run 收尾判据：runId 对不上就不许把别人的气泡收掉
  const liveRun = loadRendererScript('src/renderer/renderer-chat-live-run.js', [
    'shouldFinishSessionActiveRun'
  ]);
  const should = liveRun.shouldFinishSessionActiveRun;
  assert.strictEqual(should(null, 'r1'), true);
  assert.strictEqual(should({ runId: 'r1' }, 'r1'), true);
  assert.strictEqual(should({ runId: 'r2' }, 'r1'), false);
  assert.strictEqual(should({ runId: 'r2' }, ''), false);
  assert.strictEqual(should({ runId: '' }, ''), true);

  console.log('[dieyun:test] test-composer-queue-edit passed');
}

main();
