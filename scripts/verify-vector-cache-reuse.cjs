'use strict';
/**
 * 批次 6 真机验收：跨 worktree 向量复用在**真实 core 进程**上是否生效。
 *
 * 场景就是乙案：同一个 data_dir（缓存所在），两个**不同**的索引库文件
 * （`<worktreeA>/.dieyun/index.sqlite` 与 `<worktreeB>/.dieyun/index.sqlite`），
 * 模拟「换个 SSH 会话 = 换一份空库」。
 *
 * 期望：
 *   库 A 首建 → vectorsReused=0，vectorsEmbedded=N（真的调了 N 次 embedding）
 *   库 B 首建 → vectorsReused=N，vectorsEmbedded=0（一次都没再调）
 *
 * 用法：node scripts/tmp-vector-cache-e2e.cjs [coreExe]
 */
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const CORE = process.argv[2] || path.join('target', 'debug', 'dieyun-core.exe');
const DIMS = 4;

/** 假 embedding 端点：按文本哈希给确定性向量，并统计调用次数 */
function startFakeEmbedding() {
  const state = { calls: 0, inputs: 0 };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = JSON.parse(raw || '{}');
      const list = Array.isArray(body.input) ? body.input : [body.input];
      state.calls += 1;
      state.inputs += list.length;
      const data = list.map((text, index) => {
        const v = new Array(DIMS).fill(0);
        for (let i = 0; i < text.length; i += 1) v[(i * 7 + text.charCodeAt(i)) % DIMS] += 1;
        const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
        return { index, embedding: v.map((x) => x / norm) };
      });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data, model: body.model }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, state, port: server.address().port }));
  });
}

class CoreClient {
  constructor(exe, dataDir) {
    this.proc = spawn(exe, ['--data-dir', dataDir, 'serve-stdio'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, DIEYUN_DATA_DIR: dataDir },
    });
    this.buf = '';
    this.pending = new Map();
    this.seq = 0;
    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', (chunk) => {
      this.buf += chunk;
      let idx;
      while ((idx = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, idx).trim();
        this.buf = this.buf.slice(idx + 1);
        if (!line) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        const waiter = this.pending.get(String(msg.id));
        if (!waiter) continue;
        this.pending.delete(String(msg.id));
        if (msg.error) waiter.reject(new Error(`${msg.error.code}: ${msg.error.message}`));
        else waiter.resolve(msg.result);
      }
    });
    this.proc.stderr.setEncoding('utf8');
    this.proc.stderr.on('data', (d) => process.stderr.write(`[core] ${d}`));
  }

  call(method, params, timeoutMs = 300000) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`${method} 超时 ${timeoutMs}ms`)),
        timeoutMs
      );
      this.pending.set(String(id), {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.proc.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  }

  async waitIdle(workspaceRoot, ms = 300000) {
    const deadline = Date.now() + ms;
    for (;;) {
      const st = await this.call('codebase.status', { workspaceRoot });
      if (!st.indexing) return st;
      if (Date.now() > deadline) throw new Error('索引超时未完成');
      await new Promise((r) => setTimeout(r, 300));
    }
  }

  kill() {
    try {
      this.proc.kill();
    } catch {}
  }
}

function seedRepo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'parse.js'), 'function parseConfig(text) {\n  return JSON.parse(text);\n}\n');
  fs.writeFileSync(path.join(dir, 'route.js'), 'function matchRoute(pathname) {\n  return pathname.split("/");\n}\n');
  fs.writeFileSync(path.join(dir, 'cache.js'), 'function warmCache(entries) {\n  return entries.length;\n}\n');
}

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dieyun-vec-e2e-'));
  const dataDir = path.join(tmp, 'data');
  const repoA = path.join(tmp, 'worktrees', 'sess-a', 'main');
  const repoB = path.join(tmp, 'worktrees', 'sess-b', 'main');
  seedRepo(repoA);
  seedRepo(repoB);
  const dbA = path.join(repoA, '.dieyun', 'index.sqlite');
  const dbB = path.join(repoB, '.dieyun', 'index.sqlite');
  for (const db of [dbA, dbB]) fs.mkdirSync(path.dirname(db), { recursive: true });

  const embed = await startFakeEmbedding();
  const core = new CoreClient(CORE, dataDir);
  const configure = (repo, db) =>
    core.call('core.configure', {
      data_dir: dataDir,
      workspace_roots: [repo],
      index_db_path: db,
      embedding: {
        model: 'e2e-embed',
        // EmbeddingConfig 是 camelCase 序列化口径（base_url → baseUrl）
        baseUrl: `http://127.0.0.1:${embed.port}`,
        dimensions: DIMS,
        apiKey: '',
        authMode: 'none',
      },
    });

  const fail = (msg) => {
    throw new Error(msg);
  };

  try {
    // ── 会话 A：全新缓存 + 全新库 → 全部真算
    await configure(repoA, dbA);
    await core.call('codebase.index.start', { workspaceRoot: repoA, force: true, vectors: true });
    const stA = await core.waitIdle(repoA);
    const callsAfterA = embed.state.calls;
    console.log('库A:', JSON.stringify({
      chunkCount: stA.chunkCount,
      vectorCount: stA.vectorCount,
      vectorsReused: stA.vectorsReused,
      vectorsEmbedded: stA.vectorsEmbedded,
      embeddingCalls: callsAfterA,
    }));
    if (stA.vectorsReused !== 0) fail(`库A 不该有复用，实际 ${stA.vectorsReused}`);
    if (stA.vectorsEmbedded !== stA.chunkCount) fail(`库A 应全部真算：${stA.vectorsEmbedded} vs ${stA.chunkCount}`);
    if (callsAfterA === 0) fail('库A 没调过 embedding 端点，测试前提不成立');

    // ── 会话 B：同一个 data_dir（共享缓存）、另一份空库 → 应该全命中
    await configure(repoB, dbB);
    await core.call('codebase.index.start', { workspaceRoot: repoB, force: true, vectors: true });
    const stB = await core.waitIdle(repoB);
    const callsAfterB = embed.state.calls;
    console.log('库B:', JSON.stringify({
      chunkCount: stB.chunkCount,
      vectorCount: stB.vectorCount,
      vectorsReused: stB.vectorsReused,
      vectorsEmbedded: stB.vectorsEmbedded,
      embeddingCalls: callsAfterB,
    }));
    if (stB.vectorsReused !== stB.chunkCount) fail(`库B 应全部复用缓存：复用 ${stB.vectorsReused} / 段 ${stB.chunkCount}`);
    if (stB.vectorsEmbedded !== 0) fail(`库B 不该再调 embedding，实际 ${stB.vectorsEmbedded}`);
    if (callsAfterB !== callsAfterA) fail('库B 又请求了 embedding 端点');

    // ── 语义检索在库 B 上必须真的走向量通道
    const sr = await core.call('codebase.search', { workspaceRoot: repoB, query: '解析配置文件的函数', limit: 5 });
    console.log('检索:', JSON.stringify({ vectorSearch: sr.vectorSearch, hits: (sr.results || []).length, mode: sr.mode }));
    if (!sr.vectorSearch) fail('库B 检索没走向量通道（can_vector 为 false）');
    if (!sr.results || sr.results.length === 0) fail('库B 向量检索 0 命中');

    // ── 缓存文件落在 data_dir，且没有写进项目
    const cacheFile = path.join(dataDir, 'vector-cache.sqlite');
    if (!fs.existsSync(cacheFile)) fail(`没找到缓存文件 ${cacheFile}`);
    const stray = [];
    for (const repo of [repoA, repoB]) {
      for (const name of fs.readdirSync(path.join(repo, '.dieyun'))) {
        if (name.startsWith('vector-cache')) stray.push(path.join(repo, '.dieyun', name));
      }
    }
    if (stray.length) fail(`缓存不该写进项目：${stray.join(', ')}`);
    console.log('缓存文件:', cacheFile, `${fs.statSync(cacheFile).size} bytes`);

    console.log('\nE2E OK：乙案（每会话一份库）+ 向量在第二份库上零 embedding 调用');
    process.exitCode = 0;
  } catch (err) {
    console.error('\nE2E 失败:', err.message);
    process.exitCode = 1;
  } finally {
    core.kill();
    embed.server.close();
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {}
  }
})();
