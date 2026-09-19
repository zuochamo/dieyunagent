'use strict';

const { computeLineDiffStats } = require('../../src/gateway/line-diff-stats');

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
