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
  CJK_CHARS_PER_TOKEN,
  IMAGE_PART_EQUIV_CHARS,
  IMAGE_PART_EQUIV_TOKENS
} = require('../../src/agent/token-estimate');
const { AGENT_LIMITS_DEFAULTS } = require('../../src/agent/agent-limits');

// 与 Rust `crates/dieyun-base/src/compaction/tokens.rs` 的 #[cfg(test)] 共用同一份基线。
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

/**
 * 图片计费回归。旧行为：image part 既无 `text` 也无 `content`，退化成「整个 JSON 计费」，
 * 于是 base64 长度直接变成 token 数 —— 一张 1.5MB PNG 估到 685406 token，越过压缩触发线，
 * 而图片不可折叠也不可压缩，压缩每轮白跑（实测一次 75s 超时失败）。
 */
describe('图片 part 等效计费（与 base64 长度无关）', () => {
  const img = (url) => ({ type: 'image_url', image_url: { url } });

  it('折算系数由 agent-limits 的等效字符数推导，且与 Rust 同值', () => {
    assert.equal(IMAGE_PART_EQUIV_CHARS, AGENT_LIMITS_DEFAULTS.visionPartEqChars);
    assert.equal(
      IMAGE_PART_EQUIV_TOKENS,
      Math.ceil(AGENT_LIMITS_DEFAULTS.visionPartEqChars / CHARS_PER_TOKEN)
    );
    // Rust `IMAGE_PART_EQUIV_TOKENS` 硬编码此值，改动必须两侧同时改（fixture 会失败提醒）
    assert.equal(IMAGE_PART_EQUIV_TOKENS, 1875);
  });

  it('base64 长度不影响计费：小图与大图同价', () => {
    const small = img('data:image/png;base64,iVBORw0KGgo=');
    const big = img(`data:image/png;base64,${'A'.repeat(4096)}`);
    assert.equal(estimateContentTokens(small), IMAGE_PART_EQUIV_TOKENS);
    assert.equal(estimateContentTokens(big), IMAGE_PART_EQUIV_TOKENS);
  });

  it('三种 part 形状同价（与 guardrails-shared.isChatImagePart 同集合）', () => {
    assert.equal(
      estimateContentTokens({ type: 'input_image', image_url: 'data:image/png;base64,AAAA' }),
      IMAGE_PART_EQUIV_TOKENS
    );
    assert.equal(
      estimateContentTokens({
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: 'AAAA' }
      }),
      IMAGE_PART_EQUIV_TOKENS
    );
    // 文本 part 不受影响
    assert.equal(estimateContentTokens({ type: 'text', text: 'a' }), estimateTextTokens('a'));
  });

  it('图片与文本混排时相加，不吞掉文本计费', () => {
    const content = [{ type: 'text', text: '看图' }, img('data:image/png;base64,iVBORw0KGgo=')];
    assert.equal(
      estimateContentTokens(content),
      estimateTextTokens('看图') + IMAGE_PART_EQUIV_TOKENS
    );
  });
});
