'use strict';

const http = require('http');

const {
  upstreamStreamErrorMessage,
  processSseTextChunk
} = require('../../src/agent/sse-delta-parse');
const { streamChatCompletionMain } = require('../../src/llm-stream-utils');
const { chatCompletionJson } = require('../../src/llm-proxy');

/**
 * 中转（OpenAI 兼容网关）把上游错误当正常响应回吐的两个真实形态：
 *   流式：`HTTP 200` + `data: {"error": {...}}` + `data: [DONE]`
 *   非流式：`HTTP 200` + `{"error": {...}}`
 * 这类响应既无 content 也无 tool_calls，历史上被当成「空回复」→ 上层静默成功
 * （定时任务把一次没执行的巡检记成 lastRunOk: true）。
 */
const SSE_ERROR_BODY =
  ': start\n\n' +
  'data: {"error": {"message": "Go usage limit exceeded", "type": "rate_limit_error"}}\n\n' +
  'data: [DONE]\n\n';

const SSE_OK_BODY =
  'data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n' +
  'data: {"choices":[{"delta":{"content":"你好"}}]}\n\n' +
  'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}\n\n' +
  'data: [DONE]\n\n';

function startServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, url: `http://127.0.0.1:${server.address().port}/v1/chat/completions` });
    });
  });
}

function stopServer(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

function sseHandler(body) {
  return (req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
      res.end(body);
    });
  };
}

describe('upstreamStreamErrorMessage · 上游错误载荷识别', () => {
  it('识别中转的 error 对象（流式与非流式同一判据）', () => {
    expect(
      upstreamStreamErrorMessage({
        error: { message: 'Go usage limit exceeded', type: 'rate_limit_error' }
      })
    ).toBe('Go usage limit exceeded');
    expect(upstreamStreamErrorMessage({ error: 'insufficient balance' })).toBe('insufficient balance');
    expect(upstreamStreamErrorMessage({ type: 'error', message: 'boom' })).toBe('boom');
    expect(upstreamStreamErrorMessage({ error: {} })).toBe('上游返回错误但未给出信息');
  });

  it('正常响应载荷一律不误判', () => {
    expect(upstreamStreamErrorMessage({ choices: [{ delta: { content: 'ok' } }] })).toBe('');
    // 工具结果里的 error 字段（嵌套在 choices 内）不是流级错误
    expect(upstreamStreamErrorMessage({ choices: [{ delta: { content: '{"error":"x"}' } }] })).toBe('');
    expect(upstreamStreamErrorMessage(null)).toBe('');
    expect(upstreamStreamErrorMessage('boom')).toBe('');
  });
});

describe('processSseTextChunk · 错误载荷随 delta 上报', () => {
  it('把 data: {"error":…} 作为 _upstreamError 交给消费方，不产出 content', () => {
    const deltas = [];
    const r = processSseTextChunk('', SSE_ERROR_BODY, (d) => deltas.push(d));
    expect(r.done).toBe(true);
    expect(deltas).toEqual([{ _upstreamError: 'Go usage limit exceeded' }]);
  });

  it('正常流仍只产出内容增量', () => {
    const deltas = [];
    processSseTextChunk('', SSE_OK_BODY, (d) => deltas.push(d));
    expect(deltas.some((d) => d._upstreamError)).toBe(false);
    expect(deltas.map((d) => d.content).filter(Boolean).join('')).toBe('你好');
  });
});

describe('流式链路 · 上游错误必须变成失败', () => {
  let server = null;
  let url = '';

  afterEach(async () => {
    if (server) await stopServer(server);
    server = null;
  });

  it('HTTP 200 + SSE error 载荷 → 抛错并带上游文案（原来是空回复）', async () => {
    ({ server, url } = await startServer(sseHandler(SSE_ERROR_BODY)));
    await expect(
      streamChatCompletionMain(
        { model: 'deepseek-flash', messages: [{ role: 'user', content: 'hi' }] },
        { url, firstTokenTimeoutMs: 5000, idleTimeoutMs: 5000 }
      )
    ).rejects.toThrow(/LLM 上游错误：Go usage limit exceeded/);
  });

  it('正常 SSE 流不受影响，照常返回正文', async () => {
    ({ server, url } = await startServer(sseHandler(SSE_OK_BODY)));
    const resp = await streamChatCompletionMain(
      { model: 'deepseek-flash', messages: [{ role: 'user', content: 'hi' }] },
      { url, firstTokenTimeoutMs: 5000, idleTimeoutMs: 5000 }
    );
    expect(resp.content).toBe('你好');
    expect(resp.finishReason).toBe('stop');
    expect(resp.usage.total_tokens).toBe(5);
  });
});

describe('非流式链路 · HTTP 200 里的错误体必须变成失败', () => {
  let server = null;
  let url = '';

  afterEach(async () => {
    if (server) await stopServer(server);
    server = null;
  });

  it('{"error":…} → 抛错（原来是空 choices → 空回复）', async () => {
    ({ server, url } = await startServer((req, res) => {
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            error: { message: 'Go usage limit exceeded', type: 'GoUsageLimitError' }
          })
        );
      });
    }));
    await expect(chatCompletionJson(url, { headers: {}, body: '{}' })).rejects.toThrow(
      /LLM 上游错误：Go usage limit exceeded/
    );
  });

  it('正常 JSON 响应照常返回', async () => {
    ({ server, url } = await startServer((req, res) => {
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }));
      });
    }));
    const json = await chatCompletionJson(url, { headers: {}, body: '{}' });
    expect(json.choices[0].message.content).toBe('ok');
  });
});
