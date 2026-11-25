import { describe, it, expect } from 'vitest';

const roundText = require('../../src/agent/agent-round-text.js');
const { createAgentModeHandlers } = require('../../src/agent/main-tools/agent-mode.js');

describe('中途改道 / trace 读取（只认结构化调用）', () => {
  it('普通轮次没有 fan_out → null', () => {
    const trace = [{ phase: '思考', tools: [{ name: 'fs_read_file', toolArgs: {} }] }];
    expect(roundText.findFanOutRequest(trace)).toBeNull();
  });

  it('模型调了 fan_out → 取 reason 与子任务', () => {
    const trace = [
      { phase: '思考', tools: [{ name: 'grep', toolArgs: { pattern: 'x' } }] },
      {
        phase: '思考',
        tools: [
          {
            name: 'fan_out',
            toolArgs: {
              reason: '三处文件互不依赖',
              subtasks: [{ title: 'a', instruction: '改 a' }]
            }
          }
        ]
      }
    ];
    const hit = roundText.findFanOutRequest(trace);
    expect(hit.reason).toBe('三处文件互不依赖');
    expect(hit.subtasks).toHaveLength(1);
  });

  it('只有文字说「我要拆开做」不算数（不扫正文）', () => {
    const trace = [{ phase: '思考', thought: '我要拆开做，分三路并行', tools: [] }];
    expect(roundText.findFanOutRequest(trace)).toBeNull();
  });

  it('reason 缺失也给一句默认说法（不让卡面空白）', () => {
    const trace = [{ phase: '思考', tools: [{ name: 'fan_out', toolArgs: {} }] }];
    expect(roundText.findFanOutRequest(trace).reason).toContain('需要拆成多路并行');
  });

  it('实时 trace 用 args 字段也认', () => {
    const trace = [{ phase: '思考', tools: [{ name: 'fan_out', args: { reason: '并行三处' } }] }];
    expect(roundText.findFanOutRequest(trace).reason).toBe('并行三处');
  });
});

describe('中途改道 / fan_out 工具只登记意图', () => {
  const handlers = createAgentModeHandlers({});

  it('给了 reason → 回 handoff:planner，并明确「本轮收尾、别再调工具」', async () => {
    const r = await handlers.fan_out({ reason: '三处独立' });
    expect(r.ok).toBe(true);
    expect(r.handoff).toBe('planner');
    expect(r.note).toContain('本轮到此收尾');
    expect(r.note).toContain('不要再继续调用工具');
  });

  it('没 reason → 直接拒绝（避免空手改道）', async () => {
    const r = await handlers.fan_out({});
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe('FAN_OUT_REASON_REQUIRED');
  });

  it('子任务数量有上限，且丢掉了空条目', async () => {
    const subtasks = Array.from({ length: 20 }, (_, i) => ({ title: `t${i}`, instruction: `i${i}` }));
    const r = await handlers.fan_out({ reason: 'r', subtasks: [{}, ...subtasks] });
    expect(r.subtasks.length).toBeLessThanOrEqual(12);
    expect(r.subtasks.every((s) => s.title || s.instruction)).toBe(true);
  });
});
