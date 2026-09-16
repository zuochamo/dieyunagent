'use strict';

const { truncateListPayload } = require('../../src/mcp/servers/dieyun-open-api/client');
const { capToolResultValue } = require('../../src/agent/tool-result-cap');
const { formatMcpCallResult } = require('../../src/mcp/runtime-manager');

describe('list summary survives truncation', () => {
  it('puts total before items', () => {
    const rows = Array.from({ length: 120 }, (_, i) => ({ id: `c${i}` }));
    const { data, truncated } = truncateListPayload({ items: rows }, 50);
    const text = JSON.stringify(data);
    expect(truncated).toBe(true);
    expect(data.total).toBe(120);
    expect(data.items).toHaveLength(50);
    expect(text.indexOf('"total"')).toBeLessThan(text.indexOf('"items"'));
  });

  it('puts total before bookmarks and keeps sibling fields', () => {
    const rows = Array.from({ length: 120 }, (_, i) => ({ id: `b${i}`, title: `t${i}` }));
    const { data } = truncateListPayload({ groups: [{ id: 'g1' }], bookmarks: rows }, 50);
    const text = JSON.stringify(data);
    expect(data.total).toBe(120);
    expect(data.bookmarks).toHaveLength(50);
    expect(data.groups).toEqual([{ id: 'g1' }]);
    expect(text.indexOf('"total"')).toBeLessThan(text.indexOf('"bookmarks"'));
  });

  it('prepends total even when the list is not truncated', () => {
    const { data, truncated } = truncateListPayload({ items: [{ id: 'a' }] }, 50);
    expect(truncated).toBe(false);
    expect(JSON.stringify(data).startsWith('{"total":1,')).toBe(true);
  });

  it('reports total for a short bookmark list too', () => {
    const rows = Array.from({ length: 3 }, (_, i) => ({ id: `b${i}` }));
    const { data, truncated } = truncateListPayload({ bookmarks: rows }, 50);
    expect(truncated).toBe(false);
    expect(data.total).toBe(3);
    expect(data.bookmarks).toHaveLength(3);
    expect(JSON.stringify(data).startsWith('{"total":3,')).toBe(true);
  });

  it('truncates unknown list field names too', () => {
    const rows = Array.from({ length: 120 }, (_, i) => ({ id: `c${i}` }));
    const { data, truncated } = truncateListPayload({ computers: rows }, 50);
    const text = JSON.stringify(data);
    expect(truncated).toBe(true);
    expect(data.total).toBe(120);
    expect(data.computers).toHaveLength(50);
    expect(text.indexOf('"total"')).toBeLessThan(text.indexOf('"computers"'));
  });

  it('truncates a top-level array', () => {
    const rows = Array.from({ length: 120 }, (_, i) => ({ id: i }));
    const result = truncateListPayload(rows, 50);
    expect(result.truncated).toBe(true);
    expect(result.data).toHaveLength(50);
    expect(result.total).toBe(120);
  });

  it('keeps the tail so a trailing summary stays readable', () => {
    const value = { ok: true, content: 'a'.repeat(9000), total: 500, note: '仅返回前 50 条' };
    const capped = capToolResultValue(value, 2000);
    expect(capped.truncated).toBe(true);
    expect(capped.previewTail).toContain('"total":500');
    expect(capped.previewTail).toContain('仅返回前 50 条');
    expect(capped.preview.length).toBeGreaterThan(0);
  });

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
