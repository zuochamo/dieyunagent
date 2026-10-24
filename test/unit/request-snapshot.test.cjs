'use strict';

/**
 * 请求快照装配（纯函数 + 写入器行为）。
 *
 * 这里只测「装配出的那一行对不对」，不测落库（落库见
 * `scripts/test-request-snapshot.cjs` 与 Rust `memory/snapshot.rs` 的 #[cfg(test)]）。
 */

const assert = require('node:assert/strict');

const {
  buildRequestSnapshotPayload,
  createRequestSnapshotWriter,
  envelopeMessages,
  resolveSnapshotLimits,
  systemTextOf,
  toolNamesOf,
  sha256,
  SNAPSHOT_APPEND_RPC,
  SNAPSHOT_SOURCES,
  SNAPSHOT_REASONS
} = require('../../src/agent/request-snapshot');
const { AGENT_LIMITS_DEFAULTS } = require('../../src/agent/agent-limits');

const LIMITS = Object.freeze({
  requestSnapshotEnabled: true,
  requestSnapshotKeepPerSession: 40,
  requestSnapshotKeepCompacted: 200,
  requestSnapshotMaxMessagesChars: 400000,
  requestSnapshotSystemMaxChars: 64000,
  requestSnapshotToolsMaxChars: 96000
});

function body(overrides = {}) {
  return {
    model: 'deepseek-chat',
    stream: true,
    messages: [
      { role: 'system', content: 'SYS' },
      { role: 'user', content: '你好' },
      { role: 'assistant', content: '在' }
    ],
    tools: [{ type: 'function', function: { name: 'fs_read_file', parameters: { type: 'object' } } }],
    ...overrides
  };
}

describe('request-snapshot 装配', () => {
  it('sha256 稳定且区分内容', () => {
    assert.equal(sha256('abc'), sha256('abc'));
    assert.notEqual(sha256('abc'), sha256('abd'));
    assert.equal(sha256(undefined), sha256(''));
  });

  it('system 文本只取第一条 system，数组 content 取 text part', () => {
    assert.equal(systemTextOf([{ role: 'system', content: 'A' }]), 'A');
    assert.equal(
      systemTextOf([
        { role: 'system', content: [{ type: 'text', text: 'A' }, { type: 'image_url' }, { type: 'text', text: 'B' }] }
      ]),
      'A\nB'
    );
    assert.equal(systemTextOf([{ role: 'user', content: 'x' }]), '');
  });

  it('工具名兼容 openai 包装与裸 name', () => {
    assert.deepEqual(
      toolNamesOf([{ type: 'function', function: { name: 'a' } }, { name: 'b' }, { function: {} }]),
      ['a', 'b']
    );
  });

  it('超上限时改存信封，且明写 truncated', () => {
    const json = JSON.stringify([{ role: 'user', content: 'x'.repeat(500) }]);
    const small = envelopeMessages(json, 10000);
    assert.equal(small.truncated, false);
    assert.equal(small.messagesJson, json);

    const big = envelopeMessages(json, 100);
    assert.equal(big.truncated, true);
    const env = JSON.parse(big.messagesJson);
    assert.equal(env.truncated, true);
    assert.equal(env.chars, json.length);
    assert.equal(env.hash, sha256(json));
    assert.ok(env.head.length > 0 && env.tail.length > 0, '信封要留头尾预览');
    assert.equal(big.chars, json.length, 'chars 记原长，不因截断而变小');
  });

  it('缺 sessionId / 关开关 / 空 messages 时不产生载荷', () => {
    assert.equal(buildRequestSnapshotPayload({ body: body(), sessionId: '', limits: LIMITS }), null);
    assert.equal(
      buildRequestSnapshotPayload({
        body: body(),
        sessionId: 's1',
        limits: { ...LIMITS, requestSnapshotEnabled: false }
      }),
      null
    );
    assert.equal(
      buildRequestSnapshotPayload({ body: body({ messages: [] }), sessionId: 's1', limits: LIMITS }),
      null
    );
  });

  it('大字段每条都存全文（不做跨行去重）：NULL 只表示"没落库"', () => {
    const first = buildRequestSnapshotPayload({
      body: body(),
      sessionId: 's1',
      runId: 'r1',
      round: 0,
      limits: LIMITS
    });
    assert.equal(first.systemText, 'SYS');
    assert.ok(first.toolsJson, '首份必须带 tools 原文');
    assert.equal(first.systemChars, 3);
    assert.equal(first.messageCount, 3);
    assert.ok(first.estTokens > 0);
    assert.equal(first.source, SNAPSHOT_SOURCES.CHAT);
    assert.equal(first.reason, SNAPSHOT_REASONS.INITIAL);
    assert.equal(first.keepPerSession, 40);
    assert.equal(first.keepCompacted, 200);

    const second = buildRequestSnapshotPayload({
      body: body({ messages: [...body().messages, { role: 'user', content: '下一轮' }] }),
      sessionId: 's1',
      runId: 'r1',
      round: 1,
      limits: LIMITS
    });
    // 去重会让 NULL 同时表示「与上一行相同」和「超上限没落库」，并发写还会读串行；
    // 现在每一行都自带全文，读侧只有一个答案。
    assert.equal(second.systemText, 'SYS', 'system 每行都存');
    assert.ok(second.toolsJson, 'tools 每行都存');
    assert.equal(second.systemHash, first.systemHash);
    assert.equal(second.toolsHash, first.toolsHash);
    assert.deepEqual(JSON.parse(second.toolsNames), ['fs_read_file']);
  });

  it('system 超上限时只留 hash 与字符数（NULL 的唯一含义）', () => {
    const capped = buildRequestSnapshotPayload({
      body: body({ messages: [{ role: 'system', content: 'x'.repeat(200) }, { role: 'user', content: 'hi' }] }),
      sessionId: 's1',
      limits: { ...LIMITS, requestSnapshotSystemMaxChars: 50 }
    });
    assert.equal(capped.systemText, null, '超过 systemMaxChars 不落全文');
    assert.equal(capped.systemChars, 200, '但字符数要如实记（读者据此区分"空"与"没存"）');
    assert.ok(capped.systemHash, 'hash 仍在，能判断"内容变没变"');
  });

  it('压缩结论与审计事实原样落到载荷', () => {
    const payload = buildRequestSnapshotPayload({
      body: body(),
      sessionId: 's1',
      limits: LIMITS,
      reason: SNAPSHOT_REASONS.OVERFLOW_RETRY,
      compaction: {
        compacted: true,
        tokensBefore: 900,
        tokensAfter: 300,
        archiveId: 7,
        tokenBudget: 96000,
        triggerRatio: 0.72,
        compactionRoundCount: 2
      },
      contextAudit: { fold: { foldedCount: 3 } }
    });
    assert.equal(payload.compacted, true);
    assert.equal(payload.tokensBefore, 900);
    assert.equal(payload.tokensAfter, 300);
    assert.equal(payload.compactionArchiveId, 7);
    // 判定事实必须真写进去：列建了却永远 NULL，「这轮为什么没压」就只能靠猜
    assert.equal(payload.tokenBudget, 96000);
    assert.equal(payload.triggerRatio, 0.72);
    assert.equal(payload.compactionRoundCount, 2);
    assert.equal(payload.reason, 'overflow-retry');
    assert.deepEqual(JSON.parse(payload.contextAuditJson), { fold: { foldedCount: 3 } });
  });

  it('保留条数的非法值不许透传（0/负数会让整段会话被删空）', () => {
    for (const bad of [0, -3, NaN]) {
      const payload = buildRequestSnapshotPayload({
        body: body(),
        sessionId: 's1',
        limits: { ...LIMITS, requestSnapshotKeepPerSession: bad, requestSnapshotKeepCompacted: bad }
      });
      assert.equal(
        payload.keepPerSession,
        undefined,
        `keepPerSession=${String(bad)} 必须回落默认值，不能变成删除指令`
      );
      assert.equal(payload.keepCompacted, undefined, `keepCompacted=${String(bad)} must fall back`);
    }
  });

  it('缺压缩/审计时字段为 null 而不是 0', () => {
    const payload = buildRequestSnapshotPayload({ body: body(), sessionId: 's1', limits: LIMITS });
    assert.equal(payload.compacted, false);
    assert.equal(payload.tokensBefore, null);
    assert.equal(payload.compactionArchiveId, null);
    assert.equal(payload.contextAuditJson, null);
  });
});

describe('request-snapshot 写入器', () => {
  it('未启用 / 无 sessionId 时完全不发 RPC', async () => {
    let calls = 0;
    const w = createRequestSnapshotWriter({
      invoke: async () => {
        calls += 1;
        return { ok: true };
      },
      sessionId: '',
      limits: LIMITS
    });
    assert.equal(w.enabled, false);
    assert.equal(await w.write({ body: body() }), null);
    assert.equal(calls, 0);
  });

  it('每一行都带完整大字段（没有"上一行游标"这回事）', async () => {
    const sent = [];
    const w = createRequestSnapshotWriter({
      invoke: async (method, params) => {
        sent.push({ method, params });
        return { ok: true, id: sent.length };
      },
      sessionId: 's1',
      source: SNAPSHOT_SOURCES.SUBAGENT,
      limits: LIMITS
    });
    assert.equal(w.enabled, true);
    await w.write({ body: body(), runId: 'r1', round: 0 });
    await w.write({ body: body(), runId: 'r1', round: 1 });
    assert.equal(sent.length, 2);
    assert.equal(sent[0].method, SNAPSHOT_APPEND_RPC);
    assert.equal(sent[0].params.systemText, 'SYS');
    assert.equal(sent[1].params.systemText, 'SYS');
    assert.equal(sent[0].params.source, 'subagent');
    assert.equal(w.count, 2);
  });

  it('写失败只吞掉，不抛给主链路', async () => {
    const w = createRequestSnapshotWriter({
      invoke: async () => {
        throw new Error('sidecar gone');
      },
      sessionId: 's1',
      limits: LIMITS,
      logger: { warn: () => {} }
    });
    assert.equal(await w.write({ body: body() }), null);
    assert.equal(w.count, 0);
  });
});

describe('request-snapshot limits', () => {
  it('读不到用户设置时回落到 agent-limits 的默认值（不新增字面量）', () => {
    const limits = resolveSnapshotLimits(null, null);
    for (const key of [
      'requestSnapshotEnabled',
      'requestSnapshotKeepPerSession',
      'requestSnapshotKeepCompacted',
      'requestSnapshotMaxMessagesChars',
      'requestSnapshotSystemMaxChars',
      'requestSnapshotToolsMaxChars'
    ]) {
      assert.equal(limits[key], AGENT_LIMITS_DEFAULTS[key], key);
    }
  });

  it('默认保留策略是「40 轮 + 压缩行 200」', () => {
    assert.equal(AGENT_LIMITS_DEFAULTS.requestSnapshotKeepPerSession, 40);
    assert.equal(AGENT_LIMITS_DEFAULTS.requestSnapshotKeepCompacted, 200);
    assert.equal(AGENT_LIMITS_DEFAULTS.requestSnapshotEnabled, true);
  });
});
