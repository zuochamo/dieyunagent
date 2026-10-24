'use strict';

const {
  truncateListPayload,
  resolveListLimit,
  callApi
} = require('../../src/mcp/servers/dieyun-open-api/client');
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

  it('never overwrites an object-valued total with a row count', () => {
    // /tax/burden 的 total 是期间汇总对象，months>50 触发裁剪时不能把它冲成数字
    const total = { period: '2020-01~2026-09', payable: 148395.87, burdenRate: 0.9526 };
    const months = Array.from({ length: 81 }, (_, i) => ({ period: `m${i}` }));
    const { data, truncated } = truncateListPayload({ tenantId: 't1', total, months }, 50);
    expect(truncated).toBe(true);
    expect(data.total).toEqual(total);
    expect(data.months).toHaveLength(50);
    expect(data.tenantId).toBe('t1');
  });

  it('never overwrites an object-valued total in the items branch either', () => {
    const total = { payable: 1 };
    const rows = Array.from({ length: 120 }, (_, i) => ({ id: i }));
    const { data } = truncateListPayload({ total, items: rows }, 50);
    expect(data.total).toEqual(total);
    expect(data.items).toHaveLength(50);
  });

  it('still fills in a missing total so callers can see the row count', () => {
    const rows = Array.from({ length: 3 }, (_, i) => ({ id: i }));
    const { data } = truncateListPayload({ items: rows }, 50);
    expect(data.total).toBe(3);
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

describe('list limit follows the requested pageSize', () => {
  const ENV = {
    DAIZHANG_API_URL: 'http://127.0.0.1:3011/api/open-api/v1',
    DAIZHANG_API_KEY: 'test-key'
  };

  /** 伪造 open-api 返回：按 pageSize 切片，并带后端自己的 total/returned */
  function mockFetch(totalRows) {
    let seenUrl = null;
    const fn = async (url) => {
      seenUrl = String(url);
      const pageSize = Number(new URL(url).searchParams.get('pageSize')) || 50;
      const rows = Array.from({ length: Math.min(pageSize, totalRows) }, (_, i) => ({ id: `inv${i}` }));
      const body = {
        ok: true,
        ts: '2026-10-20T00:00:00.000Z',
        data: { total: totalRows, returned: rows.length, truncated: totalRows > rows.length, items: rows }
      };
      return { status: 200, ok: true, statusText: 'OK', text: async () => JSON.stringify(body) };
    };
    fn.url = () => seenUrl;
    return fn;
  }

  it('resolves explicit listLimit first, then pageSize, then undefined', () => {
    expect(resolveListLimit({ pageSize: 51 }, 30)).toBe(30);
    expect(resolveListLimit({ pageSize: 51 })).toBe(51);
    expect(resolveListLimit({ pageSize: 500 })).toBe(500);
    expect(resolveListLimit({})).toBeUndefined();
    expect(resolveListLimit(undefined, undefined)).toBeUndefined();
    // 非法值一律回落，不能让 0 / NaN / 负数变成「一条都不返回」
    expect(resolveListLimit({ pageSize: 0 })).toBeUndefined();
    expect(resolveListLimit({ pageSize: 'abc' })).toBeUndefined();
  });

  it('does not clip pageSize=51 down to 50 (the original bug)', async () => {
    const fetchImpl = mockFetch(2508);
    const out = await callApi('daizhang', '/invoices', { tenantId: 't1', pageSize: 51 }, { env: ENV, fetchImpl });
    expect(fetchImpl.url()).toContain('pageSize=51');
    expect(out.data.items).toHaveLength(51);
    // returned 保留后端原值；被本地裁过的话会是 50
    expect(out.data.returned).toBe(51);
    expect(out.data.total).toBe(2508);
  });

  it('honours pageSize=500', async () => {
    const fetchImpl = mockFetch(2508);
    const out = await callApi('daizhang', '/invoices', { tenantId: 't1', pageSize: 500 }, { env: ENV, fetchImpl });
    expect(out.data.items).toHaveLength(500);
    expect(out.data.returned).toBe(500);
  });

  it('still clips at 50 when the caller sets no pageSize', async () => {
    const fetchImpl = mockFetch(2508);
    const out = await callApi('daizhang', '/invoices', { tenantId: 't1' }, { env: ENV, fetchImpl });
    expect(out.data.items).toHaveLength(50);
    expect(out.data.truncated).toBe(true);
    expect(out.data.total).toBe(2508);
  });

  it('distinguishes a missing scope from a closed Open API on 403', async () => {
    const scopeErr = async () => ({
      status: 403,
      ok: false,
      statusText: 'Forbidden',
      text: async () => JSON.stringify({ ok: false, message: 'API Key 未授权 tax 作用域' })
    });
    await expect(
      callApi('daizhang', '/tax/burden', { tenantId: 't1' }, { env: ENV, fetchImpl: scopeErr })
    ).rejects.toThrow(/作用域/);

    const closedErr = async () => ({
      status: 403,
      ok: false,
      statusText: 'Forbidden',
      text: async () => JSON.stringify({ ok: false, code: 'OPEN_API_DISABLED' })
    });
    await expect(
      callApi('daizhang', '/tax/burden', { tenantId: 't1' }, { env: ENV, fetchImpl: closedErr })
    ).rejects.toThrow(/总开关|作用域/);
  });
});
