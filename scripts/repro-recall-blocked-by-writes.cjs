'use strict';
/**
 * P2 定向复现：`memory.long_recall` 会不会排在「写入连接」后面。
 *
 * 现场见 `%APPDATA%/dieyunagent/logs/main.log` 两行
 * `RPC_TIMEOUT memory.long_recall id=… timeoutMs=120000`（2026-10-31 13:59:38 / 14:12:43）。
 *
 * 背景：memory 库只有**一条写入连接**（`SqliteHandle::with_conn`，互斥）。聊天落库、
 * 快照写入、记忆写都用它。召回是每轮系统提示要等的**纯读**，如果它也走写入连接，
 * 就会排在所有写入后面 —— 一轮里写入越密集，召回越慢，极端情况就是超时。
 *
 * 本脚本用「并发大快照写入」把写入连接压满，同时按固定节奏打 long_recall，
 * 对比 `DIEYUN_CORE_BIN` 指向的两个二进制：
 *
 *   node scripts/repro-recall-blocked-by-writes.cjs  (DIEYUN_CORE_BIN=改造前)
 *   node scripts/repro-recall-blocked-by-writes.cjs  (DIEYUN_CORE_BIN=改造后)
 *
 * 判据：改造后 long_recall 的 p95/max 应该明显低于改造前，且不被写入队列拖成秒级。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const CORE = process.env.DIEYUN_CORE_BIN || path.join(__dirname, '..', 'target', 'release', 'dieyun-core.exe');
const WRITERS = Number(process.env.P2_WRITERS || 6);
const FLOOD_MS = Number(process.env.P2_FLOOD_MS || 8000);
const PAYLOAD_MB = Number(process.env.P2_PAYLOAD_MB || 4);

class Core {
  constructor(dataDir) {
    this.proc = spawn(CORE, ['--data-dir', dataDir, 'serve-stdio'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, DIEYUN_DATA_DIR: dataDir }
    });
    this.seq = 0;
    this.pending = new Map();
    this.buf = '';
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
    this.proc.stderr.on('data', (d) => (this.stderr += d));
  }

  call(method, params, timeoutMs = 300000) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(String(id));
        reject(Object.assign(new Error(`${method} 超时`), { code: 'CORE_RPC_TIMEOUT' }));
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

const pct = (sorted, p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] : 0);

(async () => {
  if (!fs.existsSync(CORE)) {
    console.error(`找不到 core：${CORE}`);
    process.exit(2);
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dy-p2-'));
  const core = new Core(tmp);
  await core.call('core.configure', { data_dir: tmp, workspace_roots: [tmp] });

  // 召回要有内容可查，否则它会走「没有记忆」的早退分支，测不到读路径
  for (let i = 0; i < 30; i += 1) {
    await core.call('memory.long_add', {
      content: `索引与记忆压测条目 ${i}：建库期间的召回不该被写入连接拖住`,
      source: 'p2-repro',
      kind: 'fact',
      scope: 'global',
      importance: 2
    });
  }

  // 基线：安静状态下召回
  const quiet = [];
  for (let i = 0; i < 10; i += 1) {
    const t = Date.now();
    await core.call('memory.long_recall', { query: '索引 记忆', scope: 'global', limit: 5 });
    quiet.push(Date.now() - t);
  }
  quiet.sort((a, b) => a - b);

  // 压满写入连接：并发写大快照
  const payload = 'x'.repeat(PAYLOAD_MB * 1024 * 1024);
  let stop = false;
  const writerDone = [];
  const writeTimes = [];
  for (let w = 0; w < WRITERS; w += 1) {
    const sessionId = `p2-flood-${w}`;
    await core.call('memory.session_create', { sessionId, workspacePath: tmp, title: 'p2' });
    writerDone.push(
      (async () => {
        while (!stop) {
          const t = Date.now();
          try {
            await core.call('memory.request_snapshot_append', {
              sessionId,
              runId: 'p2',
              round: 1,
              source: 'chat',
              messagesJson: payload,
              keepPerSession: 200,
              keepCompacted: 200
            });
          } catch {
            // 压测里失败不致命
          }
          writeTimes.push(Date.now() - t);
        }
      })()
    );
  }

  await new Promise((r) => setTimeout(r, 400)); // 让写入先把连接占住
  const underLoad = [];
  const deadline = Date.now() + FLOOD_MS;
  while (Date.now() < deadline) {
    const t = Date.now();
    await core.call('memory.long_recall', { query: '索引 记忆', scope: 'global', limit: 5 });
    underLoad.push(Date.now() - t);
    await new Promise((r) => setTimeout(r, 100));
  }
  stop = true;
  await Promise.all(writerDone);

  underLoad.sort((a, b) => a - b);
  writeTimes.sort((a, b) => a - b);
  const report = (label, arr) =>
    `${label}: p50 ${pct(arr, 50)}ms / p95 ${pct(arr, 95)}ms / max ${arr[arr.length - 1] || 0}ms (${arr.length} 次)`;

  console.log(`core=${path.basename(CORE)} 写入并发=${WRITERS} 负载=${FLOOD_MS}ms 载荷=${PAYLOAD_MB}MB`);
  console.log(report('安静时 long_recall', quiet));
  console.log(report('压满写入时 long_recall', underLoad));
  console.log(report('写入本身的耗时', writeTimes));

  const before = pct(quiet, 50);
  const loaded = pct(underLoad, 95);
  console.log(
    loaded > 1000
      ? `\n结论：写入队列把召回拖到了 ${loaded}ms（p95）—— 召回确实排在写入连接后面`
      : `\n结论：写入压满时召回 p95 仍只有 ${loaded}ms（安静时 ${before}ms）—— 召回没有排在写入连接后面`
  );

  core.kill();
  await new Promise((r) => setTimeout(r, 300));
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    // Windows 上 sqlite 句柄释放有延迟，残留临时目录不影响结论
  }
})().catch((e) => {
  console.error('复现失败:', e && e.message);
  process.exit(1);
});
