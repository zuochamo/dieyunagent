'use strict';

/**
 * 改动回执：形状 + 唯一落盘（`<userData>/self-changes.jsonl`）。
 *
 * 锁三件事：
 * 1. `target` 必填 —— 说不出「改了哪个东西」的回执没有意义；
 * 2. 只存 hash + 字符数，不存全文（日志不该跟着 AGENTS.md 一起涨）；
 * 3. 写盘失败不影响工具结果（回执是附加事实，不是事务的一部分）。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  makeReceipt,
  fingerprintText,
  fingerprintJson,
  recordSelfChange,
  changeReceipt,
  selfChangesPath
} = require('../../src/agent/change-receipt');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'self-changes-'));
}

describe('change-receipt', () => {
  it('makeReceipt 要求 target，并给出默认生效时点', () => {
    expect(() => makeReceipt({})).toThrow(/target/);
    const r = makeReceipt({ target: 'plan:p1' });
    expect(r.target).toBe('plan:p1');
    expect(r.effectiveFrom).toBe('immediate');
    expect(r.before).toBe(null);
    expect(r.after).toBe(null);
    expect(typeof r.at).toBe('string');
  });

  it('指纹只含 hash 与字符数（全文不进回执）', () => {
    const a = fingerprintText('hello');
    expect(a.chars).toBe(5);
    expect(a.hash).toHaveLength(12);
    expect(fingerprintText('hello')).toEqual(a);
    expect(fingerprintText('hello!').hash).not.toBe(a.hash);
    expect(fingerprintText(null)).toBe(null);
    expect(fingerprintJson({ a: 1 })).toEqual(fingerprintText('{"a":1}'));
  });

  it('recordSelfChange 追加一行 JSON 到 self-changes.jsonl', () => {
    const dir = tmpDir();
    try {
      const receipt = makeReceipt({ target: 'skill:/s/demo', effectiveFrom: 'next-round' });
      expect(recordSelfChange(dir, receipt)).toBe(true);
      const file = selfChangesPath(dir);
      const rows = fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
      expect(rows).toHaveLength(1);
      expect(rows[0].target).toBe('skill:/s/demo');
      expect(rows[0].effectiveFrom).toBe('next-round');
      expect(typeof rows[0].ts).toBe('number');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('没有 userData 时只回回执、不落盘（也不抛）', () => {
    const r = changeReceipt('', { target: 'mcp:add:pg' });
    expect(r.target).toBe('mcp:add:pg');
    expect(recordSelfChange('', r)).toBe(false);
  });
});
