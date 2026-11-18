'use strict';
/**
 * 手写 vs 生成的**双跑比对**（N2.1：先比对，后替换）
 *
 * 单一来源在这里：夹具、观测、差异清单都从这一处取，测试与报告脚本共用。
 *
 * 差异分类（每一条都要在 `KNOWN_DIFFS` 里有理由，且必须**仍然存在**）：
 *   schema-empty              schema 里没有这个字段/规则（goal_*、goal 内部、跨字段…）
 *   schema-conditional        schema 能表达但要 if/then（某个 action 下才必填）
 *   schema-lacks-enum         手写有取值集合，schema 没写 enum
 *   schema-lacks-range        手写有上下限，schema 没写 minimum/maximum
 *   alias                     手写接受别名，schema 只有一个字段名
 *   errorCode-taxonomy        结论一致，错误码归类不同
 *   handwritten-missing-enum  schema 有 enum，**手写没校验**（旧代码漏了）
 *
 * 判据：差异条数只能减少。生成器或 schema 改进后，对应条目必须从 `KNOWN_DIFFS` 删掉
 * （测试会检查「声明了但没发生」= 过期条目）。
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const FIXTURE = path.join(ROOT, 'test', 'fixtures', 'tool-args-cases.json');

/** @type {Record<string, { category: string, reason: string }>} */
/**
 * 已知差异表。**现在是空的**（2026-11-18：A3 统一错误码口径后差异归零）——
 * 手写校验器与生成的校验器在 62 条夹具上逐条一致。
 *
 * 什么时候会再加条目：只有当某条规则暂时**只能**手写、而 schema 表达不了时才允许，
 * 并且必须写清分类与两侧结论（`pairs`），否则双跑直接报「未声明差异」。
 *
 * @type {Record<string, { category: string, pairs: { hand: string, gen: string }, reason: string }>}
 */
const KNOWN_DIFFS = {};

function loadFixture() {
  return JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
}

/** 逐条跑手写与生成，返回差异清单（不含一致项）。 */
function collectDiffs() {
  const { validateToolArgs } = require(path.join(ROOT, 'src', 'agent', 'tool-validate'));
  const { validateToolArgsGenerated } = require(path.join(ROOT, 'src', 'agent', 'tool-validate.generated'));
  const fixture = loadFixture();
  const diffs = [];
  let agree = 0;
  for (const c of fixture.cases) {
    const hand = validateToolArgs(c.tool, c.args, {});
    const gen = validateToolArgsGenerated(c.tool, c.args, {});
    const hOk = !!(hand && hand.ok);
    const gOk = !!(gen && gen.ok);
    if (hOk === gOk && (hOk || hand.errorCode === gen.errorCode)) {
      agree += 1;
      continue;
    }
    const known = KNOWN_DIFFS[`${c.tool}|${c.why}`];
    const handOutcome = hOk ? 'ok' : hand.errorCode || 'reject';
    const genOutcome = gOk ? 'ok' : gen.errorCode || 'reject';
    diffs.push({
      tool: c.tool,
      why: c.why,
      hand: handOutcome,
      gen: genOutcome,
      category: known ? known.category : 'UNDECLARED',
      reason: known ? known.reason : '',
      // 差异的**性质**也要一致：补了 enum 之后从「gen=ok」变成「gen=INVALID_ARG」，
      // 说明这条已经从「schema 缺规则」变成「错误码口径」—— 条目必须重写，不能静默通过。
      pairsMatch: known && known.pairs ? known.pairs.hand === handOutcome && known.pairs.gen === genOutcome : null
    });
  }
  return { total: fixture.cases.length, agree, diffs };
}

/** 汇总：分类计数 + 过期条目（声明了但没再发生）。 */
function summarize() {
  const { total, agree, diffs } = collectDiffs();
  const byCategory = {};
  for (const d of diffs) byCategory[d.category] = (byCategory[d.category] || 0) + 1;
  const observed = new Set(diffs.map((d) => `${d.tool}|${d.why}`));
  const stale = Object.keys(KNOWN_DIFFS).filter((k) => !observed.has(k));
  // 差异还在、但两侧结论变了 → 声明过期（理由写的是旧现象）
  const reshaped = diffs.filter((d) => d.pairsMatch === false);
  return { total, agree, diffs, byCategory, stale, reshaped };
}

module.exports = { KNOWN_DIFFS, collectDiffs, summarize, loadFixture };
