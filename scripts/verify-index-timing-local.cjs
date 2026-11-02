'use strict';
/**
 * 本机版「双会话索引耗时对比」——不需要 SSH，用同一个驱动脚本
 * （`scripts/index-timing-driver.py`，SSH 版原样上传它）打本地 core：
 *
 *   A-冷启动      新库 + 空缓存  → 向量全量真算
 *   B-第二个会话  新库 + 热缓存  → 向量应全部复用，端点 0 次调用
 *   C-同库重建    同一个库 force → 片段重建、向量走缓存
 *
 * 它的第二个用途是**验证 SSH 版脚本本身**：驱动、三次测量的口径、断言都在这儿跑通，
 * 真机上剩下的变量只有 SSH 传输。真机版：`npm run verify:index-timing-ssh`。
 *
 * 用法：node scripts/verify-index-timing-local.cjs [coreExe]
 */
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const CORE = process.argv[2] || process.env.DIEYUN_CORE_BIN || path.join(ROOT, 'target', 'release', 'dieyun-core.exe');
const DIMS = 64;
const FILES = 60;
// 每批故意慢一点，才能从「在飞请求数」看出批量与并发是否真的生效（本机语料太小）
const EMBED_LATENCY_MS = Number(process.env.DY_EMBED_LATENCY_MS || 60);

function startFakeEmbedding() {
  const state = { calls: 0, inputs: 0, inflight: 0, maxInflight: 0 };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = JSON.parse(raw || '{}');
      const list = Array.isArray(body.input) ? body.input : [body.input];
      state.calls += 1;
      state.inputs += list.length;
      state.inflight += 1;
      state.maxInflight = Math.max(state.maxInflight, state.inflight);
      const data = list.map((text, index) => {
        const v = new Array(DIMS).fill(0);
        const s = String(text);
        for (let i = 0; i < s.length; i += 1) v[(i * 7 + s.charCodeAt(i)) % DIMS] += 1;
        const norm = Math.sqrt(v.reduce((acc, x) => acc + x * x, 0)) || 1;
        return { index, embedding: v.map((x) => x / norm) };
      });
      setTimeout(() => {
        state.inflight -= 1;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data, model: body.model }));
      }, EMBED_LATENCY_MS);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, state, port: server.address().port }));
  });
}

function makeWorkspace(dir) {
  for (let f = 0; f < FILES; f += 1) {
    const lines = [];
    for (let i = 0; i < 40; i += 1) {
      lines.push(`function fn${f}_${i}(value) {`);
      lines.push(`  // 索引耗时测量用的稳定语料 ${f}-${i}`);
      lines.push('  return value + ' + i + ';');
      lines.push('}');
    }
    fs.writeFileSync(path.join(dir, `mod${f}.js`), lines.join('\n'), 'utf8');
  }
}

function runDriver(args) {
  return new Promise((resolve, reject) => {
    const child = spawn('python', [path.join(__dirname, 'index-timing-driver.py'), ...args], {
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let out = '';
    let err = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (c) => (out += c));
    child.stderr.on('data', (c) => (err += c));
    child.on('close', (code) => resolve({ code, out, err }));
    child.on('error', reject);
  });
}

const assertions = [];
const check = (ok, message) => assertions.push({ ok: Boolean(ok), message });

(async () => {
  if (!fs.existsSync(CORE)) {
    console.error(`找不到 core：${CORE}（先 cargo build --release -p dieyun-core）`);
    process.exit(2);
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dy-timing-'));
  const ws = path.join(tmp, 'proj');
  const data = path.join(tmp, 'data');
  fs.mkdirSync(ws, { recursive: true });
  fs.mkdirSync(data, { recursive: true });
  makeWorkspace(ws);

  const embed = await startFakeEmbedding();
  const dbA = path.join(data, 'session-a.sqlite');
  const dbB = path.join(data, 'session-b.sqlite');
  const result = await runDriver([
    `--core=${CORE}`,
    `--ws=${ws}`,
    `--data=${data}`,
    `--db_a=${dbA}`,
    `--db_b=${dbB}`,
    `--embed-url=http://127.0.0.1:${embed.port}`,
    '--model=e2e-embed',
    `--dims=${DIMS}`
  ]);
  embed.server.close();

  const rows = [];
  for (const line of result.out.split('\n')) {
    const text = line.trim();
    if (!text.startsWith('{')) continue;
    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      continue;
    }
    if (msg.error) {
      console.error('驱动失败:', msg.error, result.err.slice(-2000));
      process.exit(1);
    }
    rows.push(msg);
  }
  if (rows.length < 4) {
    console.error('驱动输出不完整:', result.out, result.err.slice(-2000));
    process.exit(1);
  }

  const byLabel = (prefix) => rows.find((r) => String(r.label || '').startsWith(prefix));
  const a = byLabel('A');
  const b = byLabel('B');
  const c = byLabel('C');
  const search = rows.find((r) => r.search);

  console.log('标签            耗时      文件   片段   向量   复用   新算      库大小');
  for (const r of [a, b, c]) {
    console.log(
      `${r.label.padEnd(14)} ${String(r.elapsedMs + 'ms').padStart(7)} ${String(r.fileCount).padStart(5)} ` +
        `${String(r.chunkCount).padStart(6)} ${String(r.vectorCount).padStart(6)} ` +
        `${String(r.vectorsReused).padStart(6)} ${String(r.vectorsEmbedded).padStart(6)} ` +
        `${(r.dbBytes / 1024).toFixed(0).padStart(9)} KB`
    );
  }
  console.log(
    `端点调用：输入 ${embed.state.inputs} 条 / 请求 ${embed.state.calls} 次 · ` +
      `在飞峰值 ${embed.state.maxInflight}（闸门 4）· 每批模拟 ${EMBED_LATENCY_MS}ms`
  );
  console.log(`检索：vectorSearch=${search.search.vectorSearch} hits=${search.search.hits}`);

  check(a.vectorsEmbedded === a.vectorCount && a.vectorsReused === 0, 'A 冷启动应全部真算（复用 0）');
  check(b.vectorsReused === a.vectorCount && b.vectorsEmbedded === 0, 'B 第二个会话应全部复用（新算 0）');
  check(c.vectorsReused === a.vectorCount && c.vectorsEmbedded === 0, 'C 同库重建应全部复用（新算 0）');
  // 小语料上耗时由轮询粒度与端点延迟主导，这里只要求「不慢于」；真正的时间账看 SSH 真机版
  check(b.elapsedMs <= a.elapsedMs * 1.2, `B 不应慢于 A（B ${b.elapsedMs}ms vs A ${a.elapsedMs}ms）`);
  check(search.search.vectorSearch === true, '检索应走向量通道（vectorSearch=true）');
  // 批大小 + 有界并发：请求数远少于片段数，且在飞峰值进到 (1, 4]
  check(
    embed.state.calls < a.chunkCount,
    `批量生效：请求 ${embed.state.calls} 次 < 片段 ${a.chunkCount} 条`
  );
  check(embed.state.maxInflight > 1, `并发生效：在飞峰值 ${embed.state.maxInflight} > 1`);
  check(embed.state.maxInflight <= 4, `并发受闸门约束：在飞峰值 ${embed.state.maxInflight} ≤ 4`);

  const failed = assertions.filter((x) => !x.ok);
  for (const item of assertions) console.log(`${item.ok ? '✓' : '✗'} ${item.message}`);
  fs.rmSync(tmp, { recursive: true, force: true });
  if (failed.length) {
    console.error(`\n${failed.length} 条断言未通过`);
    process.exit(1);
  }
  console.log('\n双会话耗时对比：全部断言通过');
})().catch((e) => {
  console.error('失败:', e && e.message);
  process.exit(1);
});
