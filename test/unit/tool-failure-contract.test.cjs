'use strict';
/**
 * 工具失败必须带「可处置」的错误码，不能一律塌成 TOOL_ERROR / EXCEPTION。
 *
 * 背景（2026-10-23 改进清单 AGT-06）：`web_fetch` 16 次失败全记成 TOOL_ERROR、
 * `host_exec` 34 次全记成 EXCEPTION。根因不是「没产生精确信息」，而是**字段名对不上**：
 * web 层把精确错误码写在 `code`、处置建议写在 `hint`/`guidance`，而失败契约
 * （`tool-harness.classifyFailure` → `tool-gate.wrapStructuredError` → 遥测）只认
 * `errorCode` / `suggestedFix`。于是信息在折信封那一步全丢，模型只能盲目换引擎重试。
 *
 * 这里钉住契约：精确失败必须原样穿过 classifyFailure，且 suggestedFix 要能到模型手里。
 */
const assert = require('node:assert/strict');

const { classifyFailure } = require('../../src/agent/tool-harness.js');
const { webFetch } = require('../../src/gateway/web/fetch.js');
const { webSearch } = require('../../src/gateway/web/search.js');
const transport = require('../../src/gateway/web/transport.js');

function stubTransport(fn) {
  const orig = transport.request;
  transport.request = fn;
  return () => {
    transport.request = orig;
  };
}

describe('web 失败信封保留精确错误码', () => {
  it('HTTP 403 → ACCESS_DENIED，且带 browser_navigate 的 suggestedFix', async () => {
    const restore = stubTransport(async (url) => ({
      ok: true,
      url,
      status: 403,
      contentType: 'text/html',
      body: '<html><body>forbidden</body></html>'
    }));
    try {
      const res = await webFetch('https://example.com/private');
      assert.equal(res.ok, false);

      const failure = classifyFailure('web_fetch', res, null);
      assert.equal(failure.errorCode, 'ACCESS_DENIED');
      assert.equal(failure.retryable, false);
      assert.match(failure.suggestedFix, /browser_navigate/);
      assert.equal(failure.diagnostics.status, 403);
    } finally {
      restore();
    }
  });

  it('内网地址 → URL_NOT_ALLOWED（安全拦截不提示绕过）', async () => {
    const res = await webFetch('http://192.168.1.1/');
    const failure = classifyFailure('web_fetch', res, null);
    assert.equal(failure.errorCode, 'URL_NOT_ALLOWED');
    assert.equal(failure.suggestedFix, '');
  });

  it('网络层失败 → FETCH_FAILED / NETWORK_ERROR 且可重试', async () => {
    const restore = stubTransport(async (url) => ({ ok: false, url, status: 0, code: 'NETWORK_ERROR', error: 'fetch failed' }));
    try {
      const res = await webFetch('https://example.com/down');
      const failure = classifyFailure('web_fetch', res, null);
      assert.equal(failure.errorCode, 'NETWORK_ERROR');
      assert.equal(failure.retryable, true);
    } finally {
      restore();
    }
  });

  it('搜索 SERP 解析不出结果 → SERP_PARSE_FAILED，不再塌成 TOOL_ERROR', async () => {
    const restore = stubTransport(async (url) => ({
      ok: true,
      url,
      status: 200,
      contentType: 'text/html',
      bytes: 100,
      body: '<html><body><div>nothing</div></body></html>'
    }));
    try {
      const res = await webSearch('AGT-06 回归查询', { engine: 'bing' });
      const failure = classifyFailure('web_search', res, null);
      assert.equal(failure.errorCode, 'SERP_PARSE_FAILED');
      assert.equal(failure.retryable, false);
      assert.match(failure.suggestedFix, /换 engine/);
    } finally {
      restore();
    }
  });
});

describe('shell 失败声明式错误码', () => {
  it('本地命令超时 → SHELL_TIMEOUT（不是 EXCEPTION），且不自动重试', () => {
    const err = new Error('命令超时（90000ms，进程已终止）');
    err.code = 'SHELL_TIMEOUT';
    err.retryable = false;
    err.suggestedFix = '长任务请给 waitMs 或 detached=true';
    const failure = classifyFailure('host_exec', null, err);
    assert.equal(failure.errorCode, 'SHELL_TIMEOUT');
    assert.equal(failure.retryable, false);
    assert.match(failure.suggestedFix, /waitMs/);
  });

  it('远程命令超时 → SSH_EXEC_TIMEOUT', () => {
    const err = Object.assign(new Error('远程命令超时（180000ms）'), {
      code: 'SSH_EXEC_TIMEOUT',
      retryable: false,
      suggestedFix: '改用 nohup 后台执行'
    });
    const failure = classifyFailure('host_exec', null, err);
    assert.equal(failure.errorCode, 'SSH_EXEC_TIMEOUT');
    assert.equal(failure.retryable, false);
  });

  it('用户停止 → SHELL_ABORTED，不提示重跑', () => {
    const err = Object.assign(new Error('已停止'), { name: 'AbortError', code: 'SHELL_ABORTED', retryable: false });
    const failure = classifyFailure('host_exec', null, err);
    assert.equal(failure.errorCode, 'SHELL_ABORTED');
  });
});
