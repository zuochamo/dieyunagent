'use strict';

const { computeLineDiffStats, withinLineDiffBudget } = require('../../src/gateway/line-diff-stats');

function join(lines) {
  return lines.join('\n');
}

describe('computeLineDiffStats', () => {
  it('两处插入点之间未变更的行不计入 removed（真实回归：+32 -5 应为 +32 -0）', () => {
    const before = join([
      'def norm(key, invert=False):',
      '    vals = [emp[n][key] for n in names]',
      '    lo, hi = min(vals), max(vals)',
      '    if hi == lo:',
      '        return {n: 50.0 for n in names}',
      '    out = {n: (emp[n][key] - lo) / (hi - lo) * 100 for n in names}',
      '    if invert:',
      '        out = {n: 100 - v for n, v in out.items()}',
      '    return out'
    ]);
    const after = join([
      'def norm(key, invert=False):',
      '    """docstring"""',
      '    vals = [emp[n][key] for n in names]',
      '    lo, hi = min(vals), max(vals)',
      '    # 边界保护注释',
      '    if hi == lo:',
      '        return {n: 50.0 for n in names}',
      '    out = {n: (emp[n][key] - lo) / (hi - lo) * 100 for n in names}',
      '    # 公式注释',
      '    if invert:',
      '        out = {n: 100 - v for n, v in out.items()}',
      '    return out'
    ]);
    expect(computeLineDiffStats(before, after)).toEqual({ added: 3, removed: 0 });
  });

  it('纯删除', () => {
    const before = join(['a', 'b', 'c', 'd']);
    const after = join(['a', 'd']);
    expect(computeLineDiffStats(before, after)).toEqual({ added: 0, removed: 2 });
  });

  it('替换', () => {
    const before = join(['a', 'old1', 'old2', 'd']);
    const after = join(['a', 'new1', 'new2', 'new3', 'd']);
    expect(computeLineDiffStats(before, after)).toEqual({ added: 3, removed: 2 });
  });

  it('新建文件（beforeText 为 null）', () => {
    expect(computeLineDiffStats(null, join(['x', 'y']))).toEqual({ added: 2, removed: 0 });
  });

  it('内容相同', () => {
    expect(computeLineDiffStats(join(['a', 'b']), join(['a', 'b']))).toEqual({
      added: 0,
      removed: 0
    });
  });

  it('CRLF 换行按行匹配', () => {
    expect(computeLineDiffStats('a\r\nb', 'a\r\nb\r\nc')).toEqual({ added: 1, removed: 0 });
  });

  it('超 LCS 上限退回块级行数', () => {
    const head = join(Array.from({ length: 300 }, (_, i) => `h${i}`));
    const tail = join(Array.from({ length: 10 }, (_, i) => `t${i}`));
    const before = `${head}\n${join(Array.from({ length: 700 }, (_, i) => `old${i}`))}\n${tail}`;
    const after = `${head}\n${join(Array.from({ length: 700 }, (_, i) => `new${i}`))}\n${tail}`;
    // 中间块 700x700 超过 LINE_DIFF_MAX_LINE_PRODUCT，退回块级口径
    expect(computeLineDiffStats(before, after)).toEqual({ added: 700, removed: 700 });
  });
});

/**
 * \u300c\u8fd9\u4efd diff \u8fd8\u7b97\u5f97\u52a8\u5417\u300d\u7684\u5224\u636e\u53ea\u6709\u4e00\u4efd\uff08\u672c\u6a21\u5757\uff09\u3002
 * Renderer \u7684\u9010\u884c op \u8868\uff08renderer-tool-results.js#buildLineDiffOps\uff09\u4e5f\u8d70\u8fd9\u91cc\uff1a
 * \u4ee5\u524d\u4e24\u5904\u5404\u5199 4000 / 400000\uff0c\u4e00\u5904\u6539\u4e86\u53e6\u4e00\u5904\u6ca1\u6539\u5c31\u4f1a\u51fa\u73b0
 * \u300c\u5fbd\u6807\u8bf4 +1 \u22121\u3001\u5c55\u5f00\u5374\u662f\u5757\u7ea7\u5dee\u300d\u3002
 */
describe('withinLineDiffBudget', () => {
  it('\u5c0f\u6587\u4ef6\u5728\u9884\u7b97\u5185', () => {
    expect(withinLineDiffBudget(100, 120)).toBe(true);
    expect(withinLineDiffBudget(0, 0)).toBe(true);
  });

  it('\u884c\u6570\u4e4b\u548c\u6216\u4e58\u79ef\u8d85\u9650\u5c31\u4e0d\u5728\u9884\u7b97\u5185', () => {
    // 3999 + 1 = 4000 \u5728\u9884\u7b97\u5185\uff1b4001 + 1 \u8d85\u884c\u6570\u4e0a\u9650
    expect(withinLineDiffBudget(3999, 1)).toBe(true);
    expect(withinLineDiffBudget(4001, 1)).toBe(false);
    // 700 x 700 = 490000 \u8d85\u4e58\u79ef\u4e0a\u9650
    expect(withinLineDiffBudget(700, 700)).toBe(false);
  });

  it('\u5f02\u5e38\u8f93\u5165\u6309 0 \u5904\u7406\uff08\u4e0d\u629b\u9519\uff09', () => {
    expect(withinLineDiffBudget(undefined, undefined)).toBe(true);
    expect(withinLineDiffBudget(-5, 3)).toBe(true);
    expect(withinLineDiffBudget('10', 20)).toBe(true);
  });
});
