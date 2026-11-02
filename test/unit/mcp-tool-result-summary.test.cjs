'use strict';

// 原文件还覆盖了叠云 Open API 本地服务的 truncateListPayload / resolveListLimit / callApi。
// 那套服务 2026-11 起不再随客户端分发（source 已删），对应用例一并删除；
// 这里只保留与具体 MCP 服务无关的两件事：结果裁剪保尾部摘要、MCP 调用结果格式化。

const { capToolResultValue } = require('../../src/agent/tool-result-cap');
const { formatMcpCallResult } = require('../../src/mcp/runtime-manager');

describe('tool result capping', () => {
  it('keeps the tail so a trailing summary stays readable', () => {
    const value = { ok: true, content: 'a'.repeat(9000), total: 500, note: '仅返回前 50 条' };
    const capped = capToolResultValue(value, 2000);
    expect(capped.truncated).toBe(true);
    expect(capped.previewTail).toContain('"total":500');
    expect(capped.previewTail).toContain('仅返回前 50 条');
    expect(capped.preview.length).toBeGreaterThan(0);
  });
});

describe('mcp call result formatting', () => {
  it('does not duplicate mcp text into raw', () => {
    const text = 'x'.repeat(7800);
    const out = formatMcpCallResult({ content: [{ type: 'text', text }] });
    expect(out.content).toBe(text);
    expect(out.raw).toBeUndefined();
    // 修复前 content + raw 两份文本会让 JSON 超过 14000，落进 spill/cap 的阈值缝隙
    expect(JSON.stringify(out).length).toBeLessThan(8192);
  });

  it('still exposes the message for mcp errors', () => {
    const out = formatMcpCallResult({
      isError: true,
      content: [{ type: 'text', text: 'boom' }]
    });
    expect(out).toEqual({ error: 'boom' });
  });

  it('keeps non-text parts (images) in raw', () => {
    const out = formatMcpCallResult({
      content: [
        { type: 'text', text: 'done' },
        { type: 'image', data: 'AAAA', mimeType: 'image/png' }
      ]
    });
    expect(out.content).toBe('done\n[image]');
    expect(out.raw.content).toHaveLength(1);
    expect(out.raw.content[0].type).toBe('image');
  });
});
