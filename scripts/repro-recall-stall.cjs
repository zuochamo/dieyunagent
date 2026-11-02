'use strict';
/**
 * P2 复现器：建库窗口内 `memory.long_recall` 会不会被拖住（`CORE_RPC_TIMEOUT`）。
 *
 * 现场：2026-10-31 13:59:38 与 14:12:43 各有一次 `memory.long_recall` 撞满 120s 的宿主预算
 * （`%APPDATA%/dieyunagent/logs/main.log` 两行 `RPC_TIMEOUT memory.long_recall timeoutMs=120000`），
 * 当时本地索引库正在建（1.1 GB 库 + 455 MB WAL）。当时 core 侧没有任何耗时记录，
 * 所以「卡在 core 内部」还是「卡在传输」无法判定 —— 本脚本用**真实体量的数据**在单进程内
 * 把这件事量出来：一边建库，一边按固定节奏打 long_recall，看它是否被拖慢。
 *
 * 关键前提：**不动用户的真实库**。memory 库整库复制一份到临时目录，core 只碰副本。
 *
 * 用法：node scripts/repro-recall-stall.cjs [workspace] [--interval=500]
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const WORKSPACE = process.argv.find((a) => !a.startsWith('-') && a !== process.argv[0] && a !== process.argv[1]) || process.cwd();
const INTERVAL = Number((process.argv.find((a) => a.startsWith('--interval=')) || '').split('=')[1] || 500);
const CORE = process.env.DIEYUN_CORE_BIN || path.join(__dirname, '..', 'target', 'release', 'dieyun-core.exe');
const REAL_DATA = path.join(process.env.APPDATA || '', 'dieyunagent');

class Core {
  constructor(dataDir) {
    this.proc = spawn(CORE, ['--data-dir', dataDir, 'serve-stdio'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, DIEYUN_DATA_DIR: dataDir }
    });
    this.seq = 0;
    this.pending = new Map();
    this.buf = '';
    this.slowLines = [];
    this.stderr = '';
    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', (c) => {
      this.buf += c;
      let i;
      while ((i = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, i).trim();
        this.buf = this.buf.slice(i + 1);
        if (!line) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        const w = this.pending.get(String(msg.id));
        if (!w) continue;
        this.pending.delete(String(msg.id));
        if (msg.error) w.reject(Object.assign(new Error(msg.error.message), { code: msg.error.code }));
        else w.resolve(msg.result);
      }
    });
    this.proc.stderr.setEncoding('utf8');
    this.proc.stderr.on('data', (d) => {
      this.stderr += d;
      for (const line of String(d).split('\n')) {
        if (line.includes('[rpc-slow]')) this.slowLines.push(line.trim());
      }
    });
  }

  call(method, params, timeoutMs = 300000) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(String(id));
        reject(Object.assign(new Error(`${method} 超时 ${timeoutMs}ms`), { code: 'CORE_RPC_TIMEOUT' }));
      }, timeoutMs);
      this.pending.set(String(id), {
        resolve: (v) => (clearTimeout(timer), resolve(v)),
        reject: (e) => (clearTimeout(timer), reject(e))
      });
      this.proc.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  }

  kill() {
    try {
      this.proc.kill();
    } catch {}
  }
}

function pct(sorted, p) {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

(async () => {
  if (!fs.existsSync(CORE)) {
    console.error(`找不到 core：${CORE}（先 cargo build --release -p dieyun-core）`);
    process.exit(2);
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dy-recall-repro-'));
  // memory 库整库复制：core 会写入 bump_memory_usage，绝不能碰用户的真库
  for (const suffix of ['', '-wal', '-shm']) {
    const src = path.join(REAL_DATA, `diecloud-memory.sqlite${suffix}`);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(tmp, `diecloud-memory.sqlite${suffix}`));
  }
  const memBytes = fs.existsSync(path.join(tmp, 'diecloud-memory.sqlite'))
    ? fs.statSync(path.join(tmp, 'diecloud-memory.sqlite')).size
    : 0;
  console.log(`memory 库副本：${(memBytes / 1024 / 1024).toFixed(0)} MB · workspace=${WORKSPACE}`);

  const core = new Core(tmp);
  const indexDb = path.join(tmp, 'index.sqlite');
  await core.call('core.configure', { data_dir: tmp, workspace_roots: [WORKSPACE], index_db_path: indexDb });

  const recall = async () => {
    const t = Date.now();
    try {
      const r = await core.call('memory.long_recall', { query: '索引 向量 建库 超时', limit: 5 }, 130000);
      return { ms: Date.now() - t, mode: r && r.mode, hits: (r && r.results && r.results.length) || 0 };
    } catch (e) {
      return { ms: Date.now() - t, error: e.code || e.message };
    }
  };

  // 基线：无建库干扰
  const base = [];
  for (let i = 0; i < 5; i += 1) base.push((await recall()).ms);
  base.sort((a, b) => a - b);
  console.log(`基线 long_recall：p50 ${pct(base, 50)}ms / max ${base[base.length - 1]}ms（${base.length} 次）`);

  // 建库 + 并发探针
  const started = Date.now();
  await core.call('codebase.index.start', { workspaceRoot: WORKSPACE, force: true, vectors: false });
  const samples = [];
  let building = true;
  const poller = (async () => {
    while (building) {
      samples.push(await recall());
      await new Promise((r) => setTimeout(r, INTERVAL));
    }
  })();
  let st;
  for (;;) {
    st = await core.call('codebase.status', { workspaceRoot: WORKSPACE });
    if (!st.indexing && Date.now() - started > 3000) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  const buildMs = Date.now() - started;
  building = false;
  await poller;

  const times = samples.map((s) => s.ms).sort((a, b) => a - b);
  const errors = samples.filter((s) => s.error);
  console.log(
    `建库 ${(buildMs / 1000).toFixed(1)}s（片段 ${st.chunkCount} / 文件 ${st.fileCount}）· 期间 long_recall ${samples.length} 次：` +
      `p50 ${pct(times, 50)}ms / p95 ${pct(times, 95)}ms / max ${times[times.length - 1] || 0}ms` +
      `${errors.length ? ` · 失败 ${errors.length} 次（${errors.map((e) => e.error).join(',')}）` : ''}`
  );
  const worst = samples.slice().sort((a, b) => b.ms - a.ms).slice(0, 5);
  console.log('最慢 5 次：', worst.map((s) => `${s.ms}ms${s.error ? `(${s.error})` : ''}`).join(' '));
  console.log(`core 侧慢请求日志 ${core.slowLines.length} 行：`, core.slowLines.slice(0, 10).join(' | ') || '(无)');

  const blocked = (times[times.length - 1] || 0) > 5000;
  console.log(
    blocked
      ? '\n结论：core 内部确实会把 long_recall 拖慢到 5s 以上 —— 修在 core（归属问题）'
      : '\n结论：core 内部没有拖住 long_recall（都在秒级以内）—— 卡点在传输 / 守护进程 / 宿主进程，不在 SQLite 归属'
  );

  core.kill();
  fs.rmSync(tmp, { recursive: true, force: true });
})().catch((e) => {
  console.error('复现失败:', e && e.message);
  process.exit(1);
});
