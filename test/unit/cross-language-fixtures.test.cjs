'use strict';

/**
 * 跨语言 fixture 双跑（Node 侧）：
 *
 * 1. `context-overflow-cases.json` —— 与 Rust `agent/driver.rs` 同一份用例，
 *    两侧必须对每一条给出相同结论；
 * 2. `snippet-budget-cases.json` —— 只断言关系型不变量：Rust 的摘录预算必须大于 Node 的
 *    展示预算（Rust 先截断 = 命中词直接消失，Node 补不回来）。
 *
 * Rust 侧的同一份断言在 `crates/dieyun-runtime/src/agent/driver.rs` 与
 * `crates/dieyun-codebase/src/index/search.rs` 的 `#[cfg(test)]` 里，读的是同样两个文件。
 */

const fs = require('fs');
const path = require('path');

const { isContextOverflowError } = require('../../src/llm-reconnect-retry');
const SHARED = require('../../src/agent/shared-constants');
const { getAgentLimits } = require('../../src/agent/agent-limits');

const readFixture = (name) =>
  JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'fixtures', name), 'utf8'));

describe('跨语言 fixture · 上下文溢出判定', () => {
  const fixture = readFixture('context-overflow-cases.json');

  it('词表来自共享文件（不是本文件里的正则）', () => {
    expect(SHARED.contextOverflowPatterns.length).toBeGreaterThan(5);
    expect(SHARED.contextOverflowPatterns).toContain('exceeds the maximum length');
  });

  for (const c of fixture.cases) {
    it(`${c.overflow ? '溢出' : '非溢出'}：${c.message.slice(0, 48)}`, () => {
      expect(isContextOverflowError(new Error(c.message))).toBe(c.overflow);
    });
  }
});

describe('跨语言 fixture · 摘录预算', () => {
  const fixture = readFixture('snippet-budget-cases.json');

  it('Rust 预算（字符）必须大于 Node 展示预算', () => {
    expect(fixture.invariants.rustBudgetMustExceedNodeMax).toBe(true);
    expect(SHARED.snippets.rustBudgetChars).toBeGreaterThan(SHARED.snippets.codebaseSnippetMaxChars);
  });

  it('Node 侧实际生效的展示预算就是共享值', () => {
    const limits = getAgentLimits(require('os').tmpdir());
    expect(limits.codebaseSnippetMax).toBe(SHARED.snippets.codebaseSnippetMaxChars);
  });

  it('用例的字符量级与两份预算自洽', () => {
    const nodeMax = SHARED.snippets.codebaseSnippetMaxChars;
    const rustMax = SHARED.snippets.rustBudgetChars;
    for (const c of fixture.cases) {
      const total = c.lines * c.perLine;
      if (c.expectTruncated) {
        // 必须大过 Rust 预算才叫「截断」，否则这条用例在 Rust 侧恒真、等于没测
        expect(total).toBeGreaterThan(rustMax);
      } else {
        // 必须落在 Node 预算之内，才证明「Rust 没有提前截断」
        expect(total).toBeLessThanOrEqual(nodeMax);
      }
    }
  });
});
