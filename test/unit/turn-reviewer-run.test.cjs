'use strict';

/**
 * Reviewer 执行侧（`src/agent/turn-reviewer-run.js`，Main only）的单测。
 *
 * 覆盖「请求怎么组、失败怎么退」两件事 —— 这两件以前在 Renderer 里、零测试：
 *   1. 端点 / 请求头只认 `llm-request`（不在这里拼 URL、不写 Authorization）；
 *   2. 跳过的四种理由（未启用 / 没有 diff / 端点解析不出来 / 中途被停）；
 *   3. 端点不认 JSON 模式 → 退回普通模式再发一次（不算失败）；
 *   4. 返回非 JSON → 一次格式修复，不重新判断；
 *   5. 任何异常都退化成「跳过验收」，绝不把这一轮判成失败。
 */

const assert = require('node:assert/strict');
const { buildReviewerRequest, runTurnReviewer } = require('../../src/agent/turn-reviewer-run');

const SETTINGS = {
  reviewerEnabled: true,
  reviewerModel: 'reviewer-model',
  reviewerBaseUrl: 'https://reviewer.example/v1',
  reviewerApiKey: 'sk-test'
};
const FILES = [{ path: 'src/a.js', added: 2, removed: 0, diff: '--- before\n+a' }];

function facts(extra = {}) {
  return { userTask: '把登录页改完', files: FILES, ...extra };
}

/** 记录每次请求，按脚本依次返回（或抛错）。 */
function scriptedFetch(responses) {
  const calls = [];
  const fn = async ({ url, headers, body }) => {
    calls.push({ url, headers, body });
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return next;
  };
  fn.calls = calls;
  return fn;
}

describe('Reviewer 请求装配（端点 / 请求头只认 llm-request）', () => {
  test('url 与 body 形状', () => {
    const req = buildReviewerRequest(
      { model: 'm1', apiConfig: { baseUrl: 'https://api.example/v1', apiKey: 'k' } },
      { messages: [{ role: 'user', content: 'hi' }], maxTokens: 800, jsonMode: true }
    );
    assert.match(req.url, /chat\/completions$/);
    assert.equal(req.body.model, 'm1');
    assert.equal(req.body.max_tokens, 800);
    assert.equal(req.body.temperature, 0);
    assert.deepEqual(req.body.response_format, { type: 'json_object' });
    assert.match(JSON.stringify(req.headers), /Bearer k/);
  });

  test('jsonMode=false 时不带 response_format', () => {
    const req = buildReviewerRequest(
      { model: 'm1', apiConfig: { baseUrl: 'https://api.example/v1', apiKey: 'k' } },
      { messages: [], jsonMode: false }
    );
    assert.equal(req.body.response_format, undefined);
  });

  test('端点解析不出来 → null（调用侧据此跳过，不发请求）', () => {
    assert.equal(buildReviewerRequest({ model: 'm', apiConfig: { baseUrl: '' } }, {}), null);
  });
});

describe('从循环账本取证据（Rust TraceTool 形状）', () => {
  test('trace 里的 tool 是 {name,args,result}，也要能推出改动文件', async () => {
    // 回归：只认 toolArgs 时，Main 侧账本（Rust TraceTool 用 `args`）永远推不出文件，
    // 于是 Reviewer 每轮都 skip，reason 还报成 reviewer_disabled。
    const fetchOnce = scriptedFetch(['{"accepted":true,"reason":"ok"}']);
    const trace = [
      {
        round: 1,
        phase: 'work',
        tools: [
          { name: 'fs_edit', args: { filePath: 'src/login.js' }, result: { ok: true } },
          { name: 'fs_write_file', args: { filePath: 'src/theme.css' }, result: { ok: true } }
        ]
      }
    ];
    const r = await runTurnReviewer({
      settings: SETTINGS,
      facts: { userTask: '改登录页', trace },
      fetchReviewerOnce: fetchOnce
    });
    assert.equal(r.skipped, undefined, '有改动文件就该真的去跑 Reviewer');
    assert.equal(fetchOnce.calls.length, 1);
    const sent = JSON.stringify(fetchOnce.calls[0].body);
    assert.ok(sent.includes('src/login.js'), '账本里的文件路径要进 payload');
    assert.ok(sent.includes('src/theme.css'));
  });

  test('没有改动文件时跳过理由要写清是 no_diff，而不是 disabled', async () => {
    const fetchOnce = scriptedFetch([]);
    const r = await runTurnReviewer({
      settings: SETTINGS,
      facts: { userTask: '闲聊', trace: [] },
      fetchReviewerOnce: fetchOnce
    });
    assert.equal(r.skipped, true);
    assert.equal(r.reason, 'reviewer_no_diff', '别把「拿不到 diff」伪装成「用户没开」');
    assert.equal(fetchOnce.calls.length, 0);
  });
});

describe('Reviewer 执行的跳过分支（都不发请求、都不抛）', () => {
  test('未启用 / 半套配置', async () => {
    const fetchOnce = scriptedFetch([]);
    assert.equal((await runTurnReviewer({ settings: { ...SETTINGS, reviewerEnabled: false }, facts: facts(), fetchReviewerOnce: fetchOnce })).reason, 'reviewer_disabled');
    assert.equal((await runTurnReviewer({ settings: { reviewerEnabled: true }, facts: facts(), fetchReviewerOnce: fetchOnce })).reason, 'reviewer_disabled');
    assert.equal(fetchOnce.calls.length, 0, '一次请求都不发');
  });

  test('没有文件 diff → 跳过（让模型凭聊天记录想象比不验收更糟）', async () => {
    const fetchOnce = scriptedFetch([]);
    const r = await runTurnReviewer({ settings: SETTINGS, facts: { userTask: 'x', files: [] }, fetchReviewerOnce: fetchOnce });
    assert.equal(r.skipped, true);
    assert.equal(fetchOnce.calls.length, 0);
  });

  test('调用抛错 → 跳过验收，不把这一轮判成失败', async () => {
    const fetchOnce = scriptedFetch([new Error('ECONNREFUSED')]);
    const r = await runTurnReviewer({ settings: SETTINGS, facts: facts(), fetchReviewerOnce: fetchOnce });
    assert.equal(r.ok, true);
    assert.equal(r.skipped, true);
    assert.equal(r.reason, 'reviewer_error');
  });
});

describe('Reviewer 执行的成功/否决路径', () => {
  test('accepted=true → ok，且带上用的模型', async () => {
    const fetchOnce = scriptedFetch(['{"accepted":true,"reason":"diff 覆盖目标"}']);
    const r = await runTurnReviewer({ settings: SETTINGS, facts: facts(), fetchReviewerOnce: fetchOnce });
    assert.equal(r.ok, true);
    assert.equal(r.model, 'reviewer-model');
    assert.equal(fetchOnce.calls.length, 1);
    // 送进去的证据里必须有 diff 与用户目标
    const sent = JSON.stringify(fetchOnce.calls[0].body);
    assert.match(sent, /把登录页改完/);
    assert.match(sent, /src\/a\.js/);
  });

  test('accepted=false → ok:false + note（Renderer 只渲染这句）', async () => {
    const fetchOnce = scriptedFetch(['{"accepted":false,"reason":"只改了样式","missing":["没有补测试"],"nextAction":"补一个用例"}']);
    const r = await runTurnReviewer({ settings: SETTINGS, facts: facts(), fetchReviewerOnce: fetchOnce });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'reviewer_validation_failed');
    assert.match(r.note, /只改了样式/);
    assert.match(r.note, /没有补测试/);
  });

  test('端点不认 JSON 模式 → 退回普通模式重发一次（不算失败）', async () => {
    const fetchOnce = scriptedFetch([
      new Error('400 unsupported parameter: response_format'),
      '{"accepted":true,"reason":"ok"}'
    ]);
    const r = await runTurnReviewer({ settings: SETTINGS, facts: facts(), fetchReviewerOnce: fetchOnce });
    assert.equal(r.ok, true);
    assert.equal(fetchOnce.calls.length, 2);
    assert.equal(fetchOnce.calls[1].body.response_format, undefined, '第二次不带 response_format');
  });

  test('返回非 JSON → 一次格式修复，不重新判断', async () => {
    const fetchOnce = scriptedFetch([
      '我觉得改得还行，但没有给 JSON',
      '{"accepted":false,"reason":"修复后仍不通过","missing":["缺测试"]}'
    ]);
    const r = await runTurnReviewer({ settings: SETTINGS, facts: facts(), fetchReviewerOnce: fetchOnce });
    assert.equal(r.ok, false);
    assert.equal(fetchOnce.calls.length, 2);
    assert.match(JSON.stringify(fetchOnce.calls[1].body.messages), /只负责把输入改写成合法 JSON/);
  });
});
