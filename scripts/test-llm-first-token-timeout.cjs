'use strict';

/**
 * 覆盖 LLM 流式首包超时：SSE keep-alive 注释不应无限续命。
 * 运行：node scripts/test-llm-first-token-timeout.cjs
 */

const http = require('http');
const assert = require('assert');
const {
  streamChatSse,
  sseChunkHasDataLine,
  STREAM_FIRST_TOKEN_TIMEOUT_MS
} = require('../src/llm-proxy');

function testSseDataLineHelper() {
  assert.strictEqual(sseChunkHasDataLine(': keep-alive\n\n', '').found, false);
  assert.strictEqual(sseChunkHasDataLine('data: {"x":1}\n\n', '').found, true);
  assert.strictEqual(sseChunkHasDataLine('data: [DONE]\n\n', '').found, true);
  const partial = sseChunkHasDataLine('da', '');
  assert.strictEqual(partial.found, false);
  const cont = sseChunkHasDataLine('ta: {"a":1}\n', partial.rest);
  assert.strictEqual(cont.found, true);
  console.log('[dieyun:test] sseChunkHasDataLine ok');
}

async function testFirstTokenTimeoutIgnoresKeepalive() {
  const prev = process.env.LLM_FIRST_TOKEN_TIMEOUT_MS;
  process.env.LLM_FIRST_TOKEN_TIMEOUT_MS = '800';
  // 重新加载以应用 env（模块已缓存则直接用短超时逻辑：用独立短超时服务器测 detect）
  delete require.cache[require.resolve('../src/llm-proxy')];
  const proxy = require('../src/llm-proxy');

  const server = http.createServer((req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive'
    });
    // 只发 keep-alive，永不发 data:
    const tick = setInterval(() => {
      try {
        res.write(': keep-alive\n\n');
      } catch {
        clearInterval(tick);
      }
    }, 100);
    req.on('close', () => clearInterval(tick));
  });

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  const url = `http://127.0.0.1:${port}/chat/completions`;
  const started = Date.now();
  let err = null;
  try {
    await proxy.streamChatSse(url, {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 't', messages: [], stream: true }),
      onChunk: () => {}
    });
  } catch (e) {
    err = e;
  }
  const elapsed = Date.now() - started;
  server.close();
  if (prev == null) delete process.env.LLM_FIRST_TOKEN_TIMEOUT_MS;
  else process.env.LLM_FIRST_TOKEN_TIMEOUT_MS = prev;
  delete require.cache[require.resolve('../src/llm-proxy')];

  assert.ok(err, '应因 first_token 超时而失败');
  assert.match(String(err.message || err), /ETIMEDOUT first_token/);
  assert.ok(elapsed < 8000, `应较快失败，实际 ${elapsed}ms`);
  console.log(
    `[dieyun:test] first_token timeout ok (${elapsed}ms, default=${STREAM_FIRST_TOKEN_TIMEOUT_MS})`
  );
}

async function main() {
  testSseDataLineHelper();
  await testFirstTokenTimeoutIgnoresKeepalive();
  console.log('[dieyun:test] test-llm-first-token-timeout passed');
}

main().catch((err) => {
  console.error('[dieyun:test] failed', err);
  process.exit(1);
});
