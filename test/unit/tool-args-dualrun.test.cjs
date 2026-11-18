'use strict';

/**
 * 手写 vs 生成的双跑（docs/NODE-THINNING-PLAN.md N2.1 第三段）
 *
 * 生成的 `tool-validate.generated.js` **还没生效**；这条用例是替换前的验收闸门：
 *   ① 每条差异都必须在 `KNOWN_DIFFS` 里声明（带分类与理由）；
 *   ② 声明过的差异必须**仍然发生** —— 修好了就删条目，留着说明「声明过期」；
 *   ③ 一致率不得下滑（只许升）。
 *
 * 差异清单与分类是单一来源：`scripts/lib/tool-validate-dualrun.cjs`（报告脚本也用它）。
 */

const { summarize } = require('../../scripts/lib/tool-validate-dualrun.cjs');

const MIN_AGREE = 62; // 2026-11-18：43 → 45（A0）→ 51（A1）→ 58（A2）→ 62（A3，差异归零）

describe('手写 vs 生成的机械校验（双跑）', () => {
  const result = summarize();

  test('没有未声明的差异（新差异 = 生成器或手写改了口径，必须先声明才有资格替换）', () => {
    const undeclared = result.diffs.filter((d) => d.category === 'UNDECLARED');
    expect(undeclared.map((d) => `${d.tool}（${d.why}）：手写=${d.hand} 生成=${d.gen}`)).toEqual([]);
  });

  test('没有过期声明（差异消失了就把 KNOWN_DIFFS 条目删掉）', () => {
    expect(result.stale).toEqual([]);
  });

  test('没有变形声明（差异还在但两侧结论变了 → 理由要重写）', () => {
    expect(
      result.reshaped.map((d) => `${d.tool}（${d.why}）：手写=${d.hand} 生成=${d.gen}`)
    ).toEqual([]);
  });

  test('一致率不下滑', () => {
    // eslint-disable-next-line no-console
    console.log(
      `[dualrun] 一致 ${result.agree}/${result.total}，差异 ${result.diffs.length}：` +
        Object.entries(result.byCategory)
          .map(([k, v]) => `${k}=${v}`)
          .join(' ')
    );
    expect(result.agree).toBeGreaterThanOrEqual(MIN_AGREE);
  });

  test('差异只有已知成因（分类必须在允许集合里）', () => {
    const allowed = new Set([
      'schema-empty',
      'schema-conditional',
      'schema-lacks-enum',
      'schema-lacks-range',
      'alias',
      'errorCode-taxonomy',
      'handwritten-missing-enum'
    ]);
    const bad = result.diffs.filter((d) => !allowed.has(d.category));
    expect(bad.map((d) => `${d.tool}: ${d.category}`)).toEqual([]);
  });
});
