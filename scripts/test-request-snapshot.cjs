'use strict';

/**
 * 请求快照冒烟（需要 dieyun-core sidecar）。
 *
 * 验证四件事：
 * 1. `memory.request_snapshot_append` 能落一行、`get` 能取回原文；
 * 2. `recent` 不带大字段（避免 UI 一点开就拉整段 prompt）；
 * 3. 保留裁剪真的生效，且**压缩行按自己的上限保留**（不被最近 N 轮挤掉）；
 * 4. 大字段去重语义（NULL = 与上一条相同）在 RPC 层原样透传。
 *
 * 用法: node scripts/test-request-snapshot.cjs
 */

const path = require('path');
const os = require('os');
const fs = require('fs');
const assert = require('node:assert/strict');

const { createCoreBridge } = require('../src/core-bridge');
const { resolveDieyunCoreBinary } = require('../src/core-bridge-path');

const RPC_TIMEOUT_MS = 15000;

function row(overrides = {}) {
  return {
    sessionId: 'snap-smoke',
    source: 'chat',
    model: 'deepseek-chat',
    messagesJson: JSON.stringify([{ role: 'user', content: 'hi' }]),
    messagesChars: 30,
    messageCount: 1,
    messagesHash: 'h1',
    systemHash: 'sh',
    systemChars: 3,
    toolsNames: '[]',
    estTokens: 12,
    reason: 'initial',
    ...overrides
  };
}

async function main() {
  const bin = resolveDieyunCoreBinary();
  if (!bin) {
    console.error('未找到 dieyun-core，请先运行: npm run cargo:build');
    process.exit(1);
  }
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dieyun-snap-'));
  const bridge = createCoreBridge({
    binaryPath: bin,
    log: () => {}
  });

  try {
    await bridge.start();
    await bridge.configure({
      data_dir: dataDir,
      workspace_roots: [path.resolve(__dirname, '..')],
    });
    await bridge.invoke('core.ping', {}, RPC_TIMEOUT_MS);

    // 1) 落一行 + 取回原文
    const first = await bridge.invoke(
      'memory.request_snapshot_append',
      row({ systemText: 'SYS', toolsJson: '[]', keepPerSession: 40, keepCompacted: 200 }),
      RPC_TIMEOUT_MS
    );
    assert.equal(first.ok, true, 'append 应返回 ok');
    assert.ok(first.id > 0, 'append 应返回自增 id');

    const got = await bridge.invoke(
      'memory.request_snapshot_get',
      { id: first.id },
      RPC_TIMEOUT_MS
    );
    assert.equal(got.id, first.id);
    assert.equal(got.sessionId, 'snap-smoke');
    assert.equal(got.systemText, 'SYS', 'get 必须返回 system 全文');
    assert.deepEqual(JSON.parse(got.messagesJson), [{ role: 'user', content: 'hi' }]);
    assert.equal(got.truncated, false);
    assert.equal(got.compacted, false);

    // 2) recent 不带大字段
    const list = await bridge.invoke(
      'memory.request_snapshot_recent',
      { sessionId: 'snap-smoke', limit: 20 },
      RPC_TIMEOUT_MS
    );
    assert.equal(list.length, 1);
    assert.equal(list[0].messagesJson, undefined, 'recent 不得返回 messagesJson');
    assert.equal(list[0].systemText, undefined, 'recent 不得返回 systemText');
    assert.equal(list[0].messagesChars, 30);

    // 3) 保留裁剪：先打一条压缩行，再灌 20 条普通行，keepPerSession=5
    const compactedRow = await bridge.invoke(
      'memory.request_snapshot_append',
      row({ compacted: true, tokensBefore: 900, tokensAfter: 300, compactionArchiveId: 42 }),
      RPC_TIMEOUT_MS
    );
    let lastPruned = 0;
    for (let i = 0; i < 20; i += 1) {
      const res = await bridge.invoke(
        'memory.request_snapshot_append',
        row({ round: i, keepPerSession: 5, keepCompacted: 200 }),
        RPC_TIMEOUT_MS
      );
      lastPruned = res.pruned || 0;
    }
    assert.ok(lastPruned > 0, '超过 keepPerSession 后必须开始裁剪');

    const after = await bridge.invoke(
      'memory.request_snapshot_recent',
      { sessionId: 'snap-smoke', limit: 200 },
      RPC_TIMEOUT_MS
    );
    assert.ok(after.length <= 7, `裁剪后应只剩 5 条最近 + 1 条压缩，实际 ${after.length}`);
    const compactedLeft = after.filter((r) => r.compacted);
    assert.equal(compactedLeft.length, 1, '压缩行必须存活（它是排查重点）');
    assert.equal(compactedLeft[0].id, compactedRow.id);
    assert.equal(compactedLeft[0].compactionArchiveId, 42);
    assert.equal(compactedLeft[0].tokensAfter, 300);

    // 4) 去重语义透传：systemText=null 的行仍然带 systemHash
    const dedup = await bridge.invoke(
      'memory.request_snapshot_append',
      row({ systemText: null, systemHash: 'sh', toolsJson: null, keepPerSession: 5 }),
      RPC_TIMEOUT_MS
    );
    const dedupRow = await bridge.invoke(
      'memory.request_snapshot_get',
      { id: dedup.id },
      RPC_TIMEOUT_MS
    );
    assert.equal(dedupRow.systemText, null);
    assert.equal(dedupRow.systemHash, 'sh');

    // 5) 缺参报错（不是静默丢数据）
    const rejected = await bridge
      .invoke('memory.request_snapshot_append', { messagesJson: '[]' }, RPC_TIMEOUT_MS)
      .then(() => null)
      .catch((err) => err);
    assert.ok(rejected, '缺 sessionId 必须报错');

    // 6) 全库上限：`keepPerSession × 会话数` 会线性涨，跨会话要有总闸（按最旧优先裁）
    for (let i = 0; i < 4; i += 1) {
      await bridge.invoke(
        'memory.request_snapshot_append',
        row({ sessionId: 'snap-cap-a', round: i, keepPerSession: 40, keepCompacted: 200, keepTotalRows: 1000 }),
        RPC_TIMEOUT_MS
      );
    }
    let capPruned = 0;
    for (let i = 0; i < 4; i += 1) {
      const res = await bridge.invoke(
        'memory.request_snapshot_append',
        row({ sessionId: 'snap-cap-b', round: i, keepPerSession: 40, keepCompacted: 200, keepTotalRows: 6 }),
        RPC_TIMEOUT_MS
      );
      capPruned = res.pruned || 0;
    }
    assert.ok(capPruned > 0, '超过 keepTotalRows 后必须跨会话裁剪');
    const capA = await bridge.invoke(
      'memory.request_snapshot_recent',
      { sessionId: 'snap-cap-a', limit: 200 },
      RPC_TIMEOUT_MS
    );
    const capB = await bridge.invoke(
      'memory.request_snapshot_recent',
      { sessionId: 'snap-cap-b', limit: 200 },
      RPC_TIMEOUT_MS
    );
    assert.equal(capB.length, 4, `全库窗 6 ⇒ 最新的会话保住自己 4 行，实际 ${capB.length}`);
    assert.ok(capA.length < 4, `全库上限必须裁掉最旧会话的行，snap-cap-a 实际剩 ${capA.length}`);

    console.log('[request-snapshot] OK rows=%d prunedLast=%d capA=%d', after.length, lastPruned, capA.length);
  } finally {
    try {
      await bridge.stop();
    } catch {
      /* ignore */
    }
    try {
      fs.rmSync(dataDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

main().catch((err) => {
  console.error('[request-snapshot] FAIL', err && err.message ? err.message : err);
  process.exit(1);
});
