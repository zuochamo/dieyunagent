'use strict';
/**
 * 交互 embedding 闸门（src/codebase/embedding-client.js）的两条硬约束：
 *
 *   1. **端点不返回时必须有墙钟上限**：交互查询用交互预算当硬上限，不能像以前那样裸 fetch
 *      一直挂着（Rust 侧同款：`remote.rs` 的 EMBED_REQUEST_TIMEOUT_MS）。
 *   2. **超时也要关闸**：以前只在成功时记往返，端点「TCP 通但永不返回」就永远关不上闸门，
 *      每轮召回都重新挂一次 —— 真机现场是 `memory.long_recall` 连续两次 120s 超时。
 */
const assert = require('node:assert/strict');
const http = require('node:http');

const { createEmbeddingClient } = require('../../src/codebase/embedding-client');

/** 接住请求但永不回话的端点：模拟「连接通、模型卡死」 */
function startHangingServer() {
  const sockets = new Set();
  const server = http.createServer(() => {
    /* 故意不响应 */
  });
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: server.address().port,
        close: () =>
          new Promise((done) => {
            for (const s of sockets) s.destroy();
            server.close(() => done());
          })
      });
    });
  });
}

describe('交互 embedding 闸门', () => {
  it('端点不返回时按交互预算超时，并把闸门关上', async () => {
    const hanging = await startHangingServer();
    const client = createEmbeddingClient({
      baseUrl: `http://127.0.0.1:${hanging.port}/v1`,
      model: 'test-model',
      dimensions: 8,
      interactiveBudgetMs: 300
    });

    const t0 = Date.now();
    await assert.rejects(
      () => client.embed('查询文本', { interactive: true }),
      (err) => {
        assert.equal(err.code, 'EMBEDDING_TOO_SLOW', `期望 EMBEDDING_TOO_SLOW，实际 ${err.code}: ${err.message}`);
        return true;
      }
    );
    const firstMs = Date.now() - t0;
    assert.ok(firstMs >= 250, `应在交互预算附近超时，实际 ${firstMs}ms`);
    assert.ok(firstMs < 5000, `不应挂死（上限 120s 只属于后台路径），实际 ${firstMs}ms`);

    // 闸门已关：第二次不再发请求，立刻拒绝
    const t1 = Date.now();
    await assert.rejects(
      () => client.embed('查询文本 2', { interactive: true }),
      (err) => {
        assert.equal(err.code, 'EMBEDDING_TOO_SLOW');
        return true;
      }
    );
    const secondMs = Date.now() - t1;
    assert.ok(secondMs < 200, `闸门关掉后应立刻拒绝，实际 ${secondMs}ms`);

    await hanging.close();
  }, 20000);
});
