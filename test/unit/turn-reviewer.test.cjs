'use strict';

/**
 * Reviewer 验收（`src/agent/turn-reviewer.js`）的单测。
 *
 * 这个模块承载「一轮做完了没」的**第二个证据源**（独立 Reviewer 的结论），而它原先长在
 * Renderer 里、零测试。这里守住四件事：
 *   1. 配置不全 / 没开 / 没有 diff → 不跑（宁可不验收，也不要拿半套配置发 401 请求）；
 *   2. 提示词与输入装配的形状稳定（模型看到的字段一旦漂移，验收结论就跟着漂）；
 *   3. 结论整形成与 `evaluateTurnReadiness` 同形状（ok / note / reason），Renderer 不判；
 *   4. 与证据判定的**合并规则只有一条**：Reviewer 不通过压过证据，原判已不通过则两条 note 都留。
 */

const assert = require('node:assert/strict');
const {
  resolveReviewerConfig,
  shouldRunReviewer,
  buildReviewerPayload,
  buildReviewerMessages,
  buildRepairMessages,
  judgeReviewerOutcome,
  mergeReviewerIntoReadiness,
  REVIEWER_SYSTEM_PROMPT
} = require('../../src/agent/turn-reviewer');

const SETTINGS = {
  reviewerEnabled: true,
  reviewerModel: 'reviewer-model',
  reviewerBaseUrl: 'https://reviewer.example/v1',
  reviewerApiKey: 'sk-test'
};
const FILES = [{ path: 'src/a.js', added: 3, removed: 1, diff: '--- before\nx\n+++ after\ny' }];

describe('Reviewer 配置与触发条件', () => {
  test('半套配置等于没配（缺 model 或 baseUrl 都返回 null）', () => {
    assert.equal(resolveReviewerConfig({}), null);
    assert.equal(resolveReviewerConfig({ reviewerModel: 'm' }), null);
    assert.equal(resolveReviewerConfig({ reviewerBaseUrl: 'https://x/v1' }), null);
    const ok = resolveReviewerConfig(SETTINGS);
    assert.equal(ok.model, 'reviewer-model');
    assert.deepEqual(ok.apiConfig, { baseUrl: 'https://reviewer.example/v1', apiKey: 'sk-test' });
  });

  test('开关、配置、diff 三者齐了才跑', () => {
    assert.equal(shouldRunReviewer({ settings: SETTINGS, files: FILES }), true);
    assert.equal(shouldRunReviewer({ settings: { ...SETTINGS, reviewerEnabled: false }, files: FILES }), false);
    assert.equal(shouldRunReviewer({ settings: SETTINGS, files: [] }), false, '没有 diff 不跑');
    assert.equal(shouldRunReviewer({ settings: {}, files: FILES }), false);
  });
});

describe('Reviewer 输入装配', () => {
  test('payload 只带必要证据，且都有上限', () => {
    const payload = buildReviewerPayload({
      userTask: '把登录页改完',
      files: FILES,
      diagnostics: { hasErrors: true, samples: ['err1'], errorCount: 1 },
      planSummary: '计划摘要',
      browser: { consoleErrorCount: 2, networkErrorCount: 1, errors: ['boom'], lastAssertion: 'failed' }
    });
    assert.equal(payload.userTask, '把登录页改完');
    assert.equal(payload.files.length, 1);
    assert.equal(payload.diagnostics.hasErrors, true);
    assert.match(payload.diagnostics.text, /err1/);
    assert.equal(payload.browser.consoleErrors, 2);
    assert.equal(payload.browser.lastAssertion, 'failed');
  });

  test('没有诊断 / 浏览器证据时是 null，不要凭空造 0', () => {
    const payload = buildReviewerPayload({ userTask: 'x', files: [] });
    assert.equal(payload.diagnostics, null);
    assert.equal(payload.browser, null);
  });

  test('messages 的形状：一条 system（唯一提示词）+ 一条 user（JSON 证据）', () => {
    const msgs = buildReviewerMessages({ userTask: 'x', files: [] });
    assert.equal(msgs.length, 2);
    assert.equal(msgs[0].role, 'system');
    assert.equal(msgs[0].content, REVIEWER_SYSTEM_PROMPT);
    assert.equal(msgs[1].role, 'user');
    assert.match(msgs[1].content, /"userTask": "x"/);
    // 修复提示词是另一份（只改格式，不重新判断）
    const repair = buildRepairMessages('{"accepted": tru');
    assert.equal(repair.length, 2);
    assert.match(repair[0].content, /只负责把输入改写成合法 JSON/);
  });
});

describe('Reviewer 结论整形', () => {
  test('accepted=true → ok', () => {
    const v = judgeReviewerOutcome({ accepted: true, reason: 'diff 覆盖目标' });
    assert.equal(v.ok, true);
    assert.equal(v.reviewer.reason, 'diff 覆盖目标');
  });

  test('accepted=false → ok:false + 可直接渲染的 note（原因 / 缺失项 / 下一步）', () => {
    const v = judgeReviewerOutcome({
      accepted: false,
      reason: '只改了样式',
      missing: ['没有补测试'],
      nextAction: '补一个回归用例'
    });
    assert.equal(v.ok, false);
    assert.equal(v.reason, 'reviewer_validation_failed');
    assert.equal(v.shouldRetry, false, '验收不通过不触发自动重跑');
    assert.equal(v.surfaceToUser, true);
    assert.match(v.note, /只改了样式/);
    assert.match(v.note, /没有补测试/);
    assert.match(v.note, /补一个回归用例/);
  });

  test('没有解析结果 → 跳过（不是不通过）', () => {
    const v = judgeReviewerOutcome(null);
    assert.equal(v.ok, true);
    assert.equal(v.skipped, true);
  });
});

describe('与证据判定的合并规则（唯一一处）', () => {
  test('Reviewer 通过 / 跳过 → 原判不动', () => {
    const base = { ok: false, note: '证据里没有验证', reason: 'no_validation' };
    assert.equal(mergeReviewerIntoReadiness(base, { ok: true, accepted: true }), base);
    assert.equal(mergeReviewerIntoReadiness(base, { ok: true, skipped: true }), base);
  });

  test('Reviewer 不通过 → 压过证据判定，且保留证据', () => {
    const base = { ok: true, evidence: { hasWriteSignal: true } };
    const merged = mergeReviewerIntoReadiness(base, {
      ok: false,
      note: 'Reviewer 目标验收未通过：只改了样式',
      reason: 'reviewer_validation_failed'
    });
    assert.equal(merged.ok, false);
    assert.equal(merged.reason, 'reviewer_validation_failed');
    assert.deepEqual(merged.evidence, { hasWriteSignal: true }, '证据不能被合流吞掉');
    assert.deepEqual(merged.reasons, ['reviewer_validation_failed']);
  });

  test('两边都不通过 → 两条 note 都在（两种原因都要让人看见）', () => {
    const base = { ok: false, note: '证据说没跑验证', reason: 'no_validation' };
    const merged = mergeReviewerIntoReadiness(base, {
      ok: false,
      note: 'Reviewer 说只改了样式',
      reason: 'reviewer_validation_failed'
    });
    assert.equal(merged.ok, false);
    assert.match(merged.note, /证据说没跑验证/);
    assert.match(merged.note, /Reviewer 说只改了样式/);
    assert.deepEqual(merged.reasons, ['no_validation', 'reviewer_validation_failed']);
    assert.equal(merged.reason, 'no_validation', '原判的 reason 保持（它是主判）');
  });
});
