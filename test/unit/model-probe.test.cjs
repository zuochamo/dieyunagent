'use strict';

const http = require('http');
const { probeModel } = require('../../src/gateway/handlers/model');

/**
 * `model.probe` 是设置页两个「测试」按钮的**唯一**出网口（渲染层不发 HTTP，
 * 这是 connect-src 能收成 'self' 的前提）。所以这里钉的是**请求本身**：
 * 端点怎么拼、头怎么带、body 是 `input` 还是 `texts[]`、失败怎么分流。
 */
function startServer(handler) {
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      requests.push({ method: req.method, url: req.url, headers: req.headers, body });
      handler(req, res, body);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        url: `http://127.0.0.1:${server.address().port}`,
        requests,
        close: () => new Promise((r) => server.close(r))
      });
    });
  });
}

function json(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

describe('model.probe', () => {
  it('chat：拼 /v1/chat/completions，带 Bearer 与自定义头，返回原始文本', async () => {
    const srv = await startServer((_req, res) =>
      json(res, 200, { choices: [{ message: { content: 'OK' } }] })
    );
    try {
      const res = await probeModel({
        kind: 'chat',
        model: 'gpt-x',
        baseUrl: srv.url,
        apiKey: 'k-1',
        headers: { 'X-Org': 'acme' },
        userAgent: 'dieyun-test',
        sessionId: 'sess-1'
      });
      const req = srv.requests[0];
      expect(req.url).toBe('/v1/chat/completions');
      expect(req.headers.authorization).toBe('Bearer k-1');
      expect(req.headers['x-org']).toBe('acme');
      expect(req.headers['user-agent']).toBe('dieyun-test');
      const body = JSON.parse(req.body);
      expect(body.model).toBe('gpt-x');
      expect(body.messages[0].role).toBe('user');
      expect(body.max_tokens).toBe(16);
      expect(res.status).toBe(200);
      expect(res.ok).toBe(true);
      expect(res.text).toContain('OK');
    } finally {
      await srv.close();
    }
  });

  it('chat：baseUrl 已带 /v1 时不重复加', async () => {
    const srv = await startServer((_req, res) => json(res, 200, { ok: true }));
    try {
      await probeModel({ kind: 'chat', model: 'm', baseUrl: `${srv.url}/v1` });
      expect(srv.requests[0].url).toBe('/v1/chat/completions');
    } finally {
      await srv.close();
    }
  });

  it('embedding：OpenAI 兼容端点用 input + dimensions', async () => {
    const srv = await startServer((_req, res) => json(res, 200, { data: [{ embedding: [0.1, 0.2] }] }));
    try {
      await probeModel({ kind: 'embedding', model: 'e', baseUrl: srv.url, dimensions: 8 });
      const req = srv.requests[0];
      expect(req.url).toBe('/v1/embeddings');
      const body = JSON.parse(req.body);
      expect(body.input).toBeTruthy();
      expect(body.dimensions).toBe(8);
      expect(body.texts).toBeUndefined();
    } finally {
      await srv.close();
    }
  });

  it('embedding：直连 .../embed 端点用 texts[]，不再接 /v1/embeddings', async () => {
    const srv = await startServer((_req, res) => json(res, 200, { embeddings: [[0.1]] }));
    try {
      await probeModel({ kind: 'embedding', model: 'e', baseUrl: `${srv.url}/embed`, dimensions: 4 });
      const req = srv.requests[0];
      expect(req.url).toBe('/embed');
      const body = JSON.parse(req.body);
      expect(Array.isArray(body.texts)).toBe(true);
      expect(body.input).toBeUndefined();
    } finally {
      await srv.close();
    }
  });

  it('服务端错误码原样回给调用方（由 UI 决定文案），不当成网络失败', async () => {
    const srv = await startServer((_req, res) => json(res, 401, { error: { message: 'API Key 无效' } }));
    try {
      const res = await probeModel({ kind: 'chat', model: 'm', baseUrl: srv.url });
      expect(res.status).toBe(401);
      expect(res.ok).toBe(false);
      expect(res.text).toContain('API Key 无效');
    } finally {
      await srv.close();
    }
  });

  it('缺参给出可分辨的错误码（UI 据此提示，不靠 message 猜）', async () => {
    await expect(probeModel({ kind: 'chat', model: 'm' })).rejects.toMatchObject({
      code: 'MISSING_BASE_URL'
    });
    await expect(probeModel({ kind: 'chat', baseUrl: 'http://127.0.0.1:1' })).rejects.toMatchObject({
      code: 'MISSING_MODEL'
    });
  });

  it('连不上 → PROBE_UNREACHABLE（不是把 fetch failed 直接抛给用户）', async () => {
    await expect(
      probeModel({ kind: 'chat', model: 'm', baseUrl: 'http://127.0.0.1:1' })
    ).rejects.toMatchObject({ code: 'PROBE_UNREACHABLE' });
  });

  it('不响应 → PROBE_TIMEOUT（按 timeoutMs 收口，不拖到 RPC 超时）', async () => {
    const srv = await startServer(() => {
      /* 故意不回 */
    });
    try {
      await expect(
        probeModel({ kind: 'chat', model: 'm', baseUrl: srv.url, timeoutMs: 60 })
      ).rejects.toMatchObject({ code: 'PROBE_TIMEOUT' });
    } finally {
      await srv.close();
    }
  });
});
