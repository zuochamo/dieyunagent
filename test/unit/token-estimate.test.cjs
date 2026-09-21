'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('node:assert/strict');

const {
  estimateTextTokens,
  estimateContentTokens,
  estimateMessageTokens,
  estimateMessagesTokens,
  CHARS_PER_TOKEN,
  CJK_CHARS_PER_TOKEN
} = require('../../src/agent/token-estimate');

// 与 Rust `crates/dieyun-core/src/compaction/tokens.rs` 的 #[cfg(test)] 共用同一份基线。
const FIXTURE = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'token-estimate-cases.json'), 'utf8')
);

describe('token-estimate 跨语言一致性（H4）', () => {
  it('系数与 Rust 硬编码一致（cjk=1.5 / other=3.2）', () => {
    assert.equal(CJK_CHARS_PER_TOKEN, 1.5);
    assert.equal(CHARS_PER_TOKEN, 3.2);
  });

  it('textCases：estimateTextTokens 与 Rust estimate_text_tokens 逐例一致', () => {
    assert.ok(FIXTURE.textCases.length > 0, 'textCases 不能为空');
    for (const { input, expected } of FIXTURE.textCases) {
      const actual = estimateTextTokens(input);
      assert.equal(actual, expected, `estimateTextTokens(${JSON.stringify(input)})`);
    }
  });

  it('sharedMessageCases：estimateMessagesTokens 与 Rust estimate_messages_tokens 逐例一致', () => {
    assert.ok(FIXTURE.sharedMessageCases.length > 0, 'sharedMessageCases 不能为空');
    for (const { message, expected } of FIXTURE.sharedMessageCases) {
      const actual = estimateMessagesTokens([message]);
      assert.equal(actual, expected, `estimateMessagesTokens(${JSON.stringify(message)})`);
    }
  });

  it('按 Unicode 码点计数（星平面字符只算 1，与 Rust chars() 一致）', () => {
    assert.equal(estimateTextTokens('\ud83d\ude00\ud83d\ude00'), 1);
    assert.equal(estimateTextTokens('中\ud83d\ude00'), 1);
    assert.equal(estimateTextTokens('\ud795\udc4f'), 1);
  });

  it('数组 content 分别计费求和、无分隔符', () => {
    assert.equal(
      estimateContentTokens(['alpha', 'beta']),
      estimateTextTokens('alpha') + estimateTextTokens('beta')
    );
  });

  it('tool_calls 是刻意的 JS 侧增量（Rust 不计）', () => {
    const base = estimateMessageTokens({ role: 'assistant', content: '' });
    const withTools = estimateMessageTokens({
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 'c1', type: 'function', function: { name: 'grep', arguments: '{}' } }]
    });
    assert.ok(withTools > base, 'tool_calls 应抬高消息计费');
  });
});
