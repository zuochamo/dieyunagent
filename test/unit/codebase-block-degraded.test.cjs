'use strict';
/**
 * 代码召回块的三态（`src/agent/context-signals.js:formatCodebaseBlock`）。
 *
 * 守的是一件事：**0 命中不许静默**。
 * 旧实现命中为空直接返回 `''`，于是这三种完全不同的处境在模型眼里一模一样：
 *   a) 本工作区还没建索引；
 *   b) 建了索引但没建向量（中文自然语言在子串通道上基本不会命中）；
 *   c) 确实没有相关代码。
 * 模型只能得出 (c) 并放弃检索——这正是 `codebase_search` 长期「建了没人用」的直接原因之一。
 * 现在的口径：a/b 各给一句可执行的话（改用 grep / 建向量），只有 c 返回空。
 */
const assert = require('node:assert/strict');

const { formatCodebaseBlock } = require('../../src/agent/context-signals');

describe('代码召回块：0 命中的三种处境必须分开', () => {
  it('没建索引 → 说明改用 grep，而不是静默空块', () => {
    const s = formatCodebaseBlock('登录记住密码', { results: [], needsIndex: true, vectorSearch: false }, 400);
    assert.ok(s.length > 0, '没建索引时不许返回空块');
    assert.match(s, /还没有可检索的代码索引/);
    assert.match(s, /grep/);
  });

  it('有索引但没向量 → 说明子串通道对中文几乎不命中，改 grep 或建向量', () => {
    const s = formatCodebaseBlock('登录记住密码存在哪', { results: [], vectorSearch: false }, 400);
    assert.ok(s.length > 0, '未建向量时的 0 命中不许返回空块');
    assert.match(s, /未建向量/);
    assert.match(s, /子串/);
    assert.match(s, /grep/);
  });

  it('有向量但真无命中 → 返回空（不拿噪声占预算）', () => {
    assert.equal(formatCodebaseBlock('不存在的符号', { results: [], vectorSearch: true }, 400), '');
  });

  it('有命中时仍按原格式输出，并标出通道模式', () => {
    const s = formatCodebaseBlock(
      'login',
      {
        vectorSearch: true,
        totalCandidates: 2,
        results: [{ path: 'src/auth/login.ts', startLine: 10, endLine: 20, snippet: 'function login() {}' }]
      },
      400
    );
    assert.match(s, /【相关代码 · 自动检索】/);
    assert.match(s, /模式：向量\+子串/);
    assert.match(s, /### 1\. src\/auth\/login\.ts:10-20/);
  });
});
