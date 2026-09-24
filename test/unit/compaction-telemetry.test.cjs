'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  compactionTelemetryRow,
  recordCompactionTelemetry,
  summarizeCompactionTelemetry,
  compactionTelemetryPath
} = require('../../src/agent/compaction-telemetry');

function tempUserDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'compaction-telemetry-'));
}

describe('compactionTelemetryRow', () => {
  it('未触发（没调 LLM）不记：未达触发线 / 冷却中 / 原子不足都走这条', () => {
    expect(
      compactionTelemetryRow({
        payload: { compacted: false, messages: [] },
        startedAt: Date.now()
      })
    ).toBeNull();
  });

  it('未配置 LLM 的早退不记', () => {
    expect(
      compactionTelemetryRow({
        payload: { compacted: false, summary: null, foldedTranscript: '', pinnedUserCount: 0 }
      })
    ).toBeNull();
  });

  it('成功：result=compacted + 记录节省量与耗时', () => {
    const row = compactionTelemetryRow({
      payload: { compacted: true, tokensBefore: 9000, tokensAfter: 4000 },
      force: false,
      model: 'glm-4',
      startedAt: Date.now() - 1200
    });
    expect(row).toMatchObject({
      trigger: 'auto',
      result: 'compacted',
      tokensBefore: 9000,
      tokensAfter: 4000,
      savedTokens: 5000,
      model: 'glm-4'
    });
    expect(row.reason).toBeUndefined();
    expect(row.ms).toBeGreaterThanOrEqual(1000);
  });

  it('强制压缩记 trigger=force', () => {
    const row = compactionTelemetryRow({
      payload: { compacted: true, tokensBefore: 100, tokensAfter: 90 },
      force: true
    });
    expect(row.trigger).toBe('force');
  });

  it('失败：compactionSkipped=llm_error 记 reason 与截断后的 detail', () => {
    const row = compactionTelemetryRow({
      payload: {
        compacted: false,
        compactionSkipped: 'llm_error',
        llmError: 'x'.repeat(500)
      }
    });
    expect(row.result).toBe('failed');
    expect(row.reason).toBe('llm_error');
    expect(row.detail).toHaveLength(200);
    // 失败不产出节省量：Rust 侧的 tokensAfter 只是 prepare 预估，拿来算会造假象
    expect(row.savedTokens).toBeUndefined();
  });

  it('失败：内容审核拒绝单列 reason', () => {
    const row = compactionTelemetryRow({
      payload: { compacted: false, compactionSkipped: 'content_policy' }
    });
    expect(row).toMatchObject({ result: 'failed', reason: 'content_policy' });
  });

  it('失败：只有 llmError 没有 skipped 时按 llm_error 归类', () => {
    const row = compactionTelemetryRow({
      payload: { compacted: false, llmError: 'rpc timeout' }
    });
    expect(row).toMatchObject({ result: 'failed', reason: 'llm_error', detail: 'rpc timeout' });
  });

  it('失败：reason 取 Rust 分类码，而不是笼统的 llm_error', () => {
    const row = compactionTelemetryRow({
      payload: {
        compacted: false,
        compactionSkipped: 'llm_error',
        llmError:
          "LLM_UPSTREAM_TIMEOUT: HTTP 502 Bad Gateway: {\"error\":{\"message\":\"('Connection aborted.', TimeoutError('The write operation timed out'))\"}}"
      }
    });
    expect(row.result).toBe('failed');
    expect(row.reason).toBe('LLM_UPSTREAM_TIMEOUT');
    // detail 保留原始报文，定位时不用再翻日志
    expect(row.detail).toContain('HTTP 502');
  });

  it('失败：模型只输出思考与真空正文分成两个 reason', () => {
    const reasoningOnly = compactionTelemetryRow({
      payload: {
        compacted: false,
        compactionSkipped: 'llm_error',
        llmError: 'LLM_REASONING_ONLY: 压缩模型只输出了思考、正文为空（未写入摘要，已跳过压缩）'
      }
    });
    const empty = compactionTelemetryRow({
      payload: {
        compacted: false,
        compactionSkipped: 'llm_error',
        llmError: 'LLM_EMPTY_CONTENT: 压缩模型返回空内容（未写入摘要，已跳过压缩）'
      }
    });
    expect(reasoningOnly.reason).toBe('LLM_REASONING_ONLY');
    expect(empty.reason).toBe('LLM_EMPTY_CONTENT');
  });

  it('失败：llmError 没有分类码前缀时回落到 skipped（旧数据 / 非分类错误）', () => {
    const row = compactionTelemetryRow({
      payload: { compacted: false, compactionSkipped: 'llm_error', llmError: 'boom' }
    });
    expect(row.reason).toBe('llm_error');
  });
});

describe('summarizeCompactionTelemetry', () => {
  it('文件不存在时返回全零（不抛）', () => {
    const s = summarizeCompactionTelemetry(tempUserDir());
    expect(s).toMatchObject({
      attempted: 0,
      auto: 0,
      forced: 0,
      ok: 0,
      failed: 0,
      successRate: 0,
      savedTokensAvg: 0,
      byReason: []
    });
  });

  it('按次数 / 动态 / 强制 / 失败原因聚合，成功率只以触发数为分母', () => {
    const dir = tempUserDir();
    const rows = [
      { trigger: 'auto', result: 'compacted', savedTokens: 5000, ms: 1000 },
      { trigger: 'auto', result: 'compacted', savedTokens: 3000, ms: 3000 },
      { trigger: 'auto', result: 'failed', reason: 'llm_error', ms: 500 },
      { trigger: 'force', result: 'failed', reason: 'llm_error', ms: 200 },
      { trigger: 'force', result: 'failed', reason: 'content_policy', ms: 100 }
    ];
    for (const row of rows) recordCompactionTelemetry(dir, row);

    const s = summarizeCompactionTelemetry(dir);
    expect(s.attempted).toBe(5);
    expect(s.auto).toBe(3);
    expect(s.forced).toBe(2);
    expect(s.ok).toBe(2);
    expect(s.failed).toBe(3);
    expect(s.successRate).toBe(40);
    expect(s.savedTokensTotal).toBe(8000);
    expect(s.savedTokensAvg).toBe(4000);
    expect(s.elapsedMsAvg).toBe(960);
    expect(s.byReason).toEqual([
      { reason: 'llm_error', count: 2 },
      { reason: 'content_policy', count: 1 }
    ]);
  });

  it('窗口只取最近 limit 行，且破损行被跳过而不影响其余统计', () => {
    const dir = tempUserDir();
    recordCompactionTelemetry(dir, { trigger: 'auto', result: 'compacted', savedTokens: 1, ms: 10 });
    recordCompactionTelemetry(dir, { trigger: 'auto', result: 'failed', reason: 'llm_error', ms: 10 });
    // 直接追加一行坏 JSON：真实场景里进程被杀会留下截断行
    fs.appendFileSync(compactionTelemetryPath(dir), '{not json\n', 'utf8');

    const all = summarizeCompactionTelemetry(dir);
    expect(all.attempted).toBe(2);
    expect(all.failed).toBe(1);

    const one = summarizeCompactionTelemetry(dir, 1);
    expect(one.attempted).toBe(1);
    expect(one.ok).toBe(0);
  });
});
