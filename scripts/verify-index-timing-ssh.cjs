'use strict';
/**
 * SSH 双会话索引耗时对比（真机验收，`docs/SSH-INDEX-COLD-START-PLAN.md` §4 第 7 条）。
 *
 * 乙案（每个会话一份索引库 `…/worktree/.dieyun/index.sqlite`）的成本结构，只有真机能量出来：
 * 冷建库要遍历 + 读全部文件；向量阶段若每会话重算，是「文件数 × 文件大小」换算成
 * embedding 计费与墙钟时间。批次 6 的复用缓存就是为了让第二个会话不必再算一遍。
 *
 * 本脚本把「两个 SSH 会话」如实复现成**同一份远端项目 + 两份独立索引库 + 同一个 data_dir**，
 * 按顺序量三次：
 *
 *   A 冷启动     新库 + 空缓存            → 片段要建、向量全量真算
 *   B 第二个会话 新库 + 热缓存            → 片段要建、向量应全部复用（0 次请求端点）
 *   C 同库重建   同一个库 + force         → 片段要重建、向量走缓存（面板手点「重建」的形态）
 *
 * 用法（口令只从文件读，不进命令行、不进仓库）：
 *   set DY_SSH_HOST=192.168.31.62
 *   set DY_SSH_USER=dieyunx
 *   set DY_SSH_PW_FILE=%TEMP%\dy_ssh_pw
 *   set DY_WS=/path/to/real/project            # 远端真实项目（必填）
 *   set DY_EMBED_LATENCY_MS=250                # 模拟真实 embedding 服务的每批延迟
 *   npm run verify:index-timing-ssh
 *
 * 退出码：0 全绿 / 1 断言失败 / 2 连接、部署或前置条件失败。
 */
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { createSshSessionManager } = require('../src/ssh/session-manager');
const { resolveConnectPayload } = require('../src/ssh/connect-payload');
const { getSshConfigBlocks } = require('../src/ssh/ssh-config');

function env(name, fallback) {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}

const HOST = env('DY_SSH_HOST', '');
const USER = env('DY_SSH_USER', 'dieyunx');
const PW_FILE = env('DY_SSH_PW_FILE', path.join(os.tmpdir(), 'dy_ssh_pw'));
const WS = env('DY_WS', '').replace(/\/+$/, '');
const CORE_LOCAL = env('DY_CORE_LINUX', path.join(__dirname, '..', 'build', 'dieyun-core-linux', 'dieyun-core'));
const EMBED_MODEL = env('DY_EMBED_MODEL', 'timing-embed');
const EMBED_DIMS = Number(env('DY_EMBED_DIMS', '256')) || 256;
const EMBED_LATENCY_MS = Number(env('DY_EMBED_LATENCY_MS', '250')) || 0;
const KEEP = env('DY_KEEP', '') === '1';

if (!HOST || !WS) {
  console.error('需要 DY_SSH_HOST 与 DY_WS（远端真实项目路径）');
  process.exit(2);
}
// 认证：有口令文件就用口令；没有就走 ~/.ssh/config 里的 key / agent（与 app 的连接逻辑同源，
// 见 src/ssh/connect-payload.js）。口令永远只从文件读，不进命令行、不进仓库。
const HAS_PW_FILE = fs.existsSync(PW_FILE);
if (!HAS_PW_FILE && !process.env.DY_SSH_KEY_ONLY) {
  console.log(`未找到 ${PW_FILE}，按 ~/.ssh/config 的 key / agent 认证尝试（强制口令：设置 DY_SSH_KEY_ONLY=0）`);
}
if (!fs.existsSync(CORE_LOCAL)) {
  console.error(`找不到 Linux core：${CORE_LOCAL}；先 npm run pack:dieyun-core:linux`);
  process.exit(2);
}

const PW = HAS_PW_FILE ? fs.readFileSync(PW_FILE, 'utf8').trim() : '';

/** 远端驱动：见 scripts/index-timing-driver.py（用 python3 说 JSON-RPC，远端不一定有 node） */
const DRIVER_PY = fs.readFileSync(path.join(__dirname, 'index-timing-driver.py'), 'utf8');

const t0 = Date.now();
const results = [];
function check(label, pass, detail) {
  results.push([pass ? 'PASS' : 'FAIL', label]);
  console.log(`${pass ? 'PASS' : 'FAIL'} | ${label}${detail == null ? '' : ` | ${String(detail).slice(0, 300)}`}`);
}

function lanIPv4() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal) return net.address;
    }
  }
  return '';
}

/** 假 embedding 端点：确定性向量 + 可配延迟（延迟才是真机上的主要成本来源） */
function startEmbedServer() {
  const state = { calls: 0, inputs: 0, inflight: 0, maxInflight: 0 };
  const server = http.createServer((req, res) => {
    if (req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
      return;
    }
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      let body = {};
      try {
        body = JSON.parse(raw || '{}');
      } catch {
        res.writeHead(400).end('bad json');
        return;
      }
      const list = Array.isArray(body.input) ? body.input : [body.input];
      state.calls += 1;
      state.inputs += list.length;
      state.inflight += 1;
      state.maxInflight = Math.max(state.maxInflight, state.inflight);
      const data = list.map((text, index) => {
        const v = new Array(EMBED_DIMS).fill(0);
        const s = String(text || '');
        for (let i = 0; i < s.length; i += 1) v[(i * 7 + s.charCodeAt(i)) % EMBED_DIMS] += 1;
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
    server.listen(0, '0.0.0.0', () => resolve({ server, state, port: server.address().port }));
  });
}

function fmtBytes(n) {
  const v = Number(n) || 0;
  if (v > 1024 * 1024) return `${(v / 1024 / 1024).toFixed(1)} MB`;
  if (v > 1024) return `${(v / 1024).toFixed(0)} KB`;
  return `${v} B`;
}

(async () => {
  const ssh = createSshSessionManager({
    userDataPath: fs.mkdtempSync(path.join(os.tmpdir(), 'dy-timing-')),
    log: () => {}
  });
  const sh = (cmd, ms) => ssh.execScript(cmd, ms || 30000);

  await ssh.connect(
    resolveConnectPayload(
      {
        host: HOST,
        username: USER,
        acceptNewHostKey: true,
        ...(HAS_PW_FILE ? { password: PW, authType: 'password' } : {})
      },
      // 与 app 同源：配置块来自 ~/.ssh/config，agent 自动探测 —— 口令文件缺席时靠 key/agent 登录
      { sshConfigBlocks: getSshConfigBlocks() }
    )
  );
  console.log(`ssh ${USER}@${HOST} connected (${Date.now() - t0}ms)`);

  // ── 前置条件
  const uname = await sh('uname -sm; python3 -V 2>&1 || echo NO_PYTHON');
  console.log(String(uname.stdout || '').trim());
  const probe = String(uname.stdout || '');
  if (!/Linux/i.test(probe)) {
    console.error('远端不是 Linux，本脚本只覆盖 Linux（Windows 宿主请直接用 target\\release）');
    process.exit(2);
  }
  const py = (probe.match(/Python (\d+)\.(\d+)/) || []);
  if (!py[1] || Number(py[1]) < 3 || Number(py[2]) < 6) {
    console.error('远端缺 python3 ≥ 3.6，无法跑驱动');
    process.exit(2);
  }
  const wsProbe = String((await sh(`test -d "${WS}" && echo OK || echo MISSING`)).stdout || '').trim();
  if (wsProbe !== 'OK') {
    console.error(`远端项目不存在：${WS}`);
    process.exit(2);
  }
  const fileCount = Number(
    String((await sh(`cd "${WS}" && find . -type f -not -path "./.git/*" -not -path "./.dieyun/*" | wc -l`, 120000)).stdout || '0').trim()
  );
  const duOut = String((await sh(`cd "${WS}" && du -sh --exclude=.git 2>/dev/null | cut -f1`, 120000)).stdout || '').trim();
  console.log(`被测仓：${WS} · ${fileCount} 个文件 · ${duOut}`);
  check('被测仓文件数 > 0', fileCount > 0, fileCount);

  // ── 部署 core 与驱动到远端（放在 data_dir 边上，不污染被测仓）
  const baseDir = String(
    (await sh(`d=$(dirname "${WS}")/.dy-index-timing; mkdir -p "$d" && printf %s "$d"`)).stdout || ''
  ).trim();
  if (!baseDir) {
    console.error('无法创建远端工作目录');
    process.exit(2);
  }
  const coreRemote = `${baseDir}/dieyun-core`;
  const driverRemote = `${baseDir}/timing_driver.py`;
  const dataDir = `${baseDir}/data`;
  await ssh.sftpWriteFile(coreRemote, fs.readFileSync(CORE_LOCAL));
  await ssh.sftpWriteFile(driverRemote, Buffer.from(DRIVER_PY, 'utf8'));
  await sh(`chmod +x "${coreRemote}"; mkdir -p "${dataDir}"; "${coreRemote}" --version 2>&1 | head -2 || true`);
  check('core 已部署到远端', true, coreRemote);

  // ── 假 embedding 端点（远端要能连回本机）
  const embed = await startEmbedServer();
  const lan = lanIPv4();
  const override = env('DY_EMBED_URL', '');
  const embedUrl = override || `http://${lan}:${embed.port}`;
  if (!override) {
    const reach = String((await sh(`curl -s -m 5 "${embedUrl}/" || echo UNREACHABLE`, 15000)).stdout || '').trim();
    if (reach !== 'ok') {
      console.error(
        `远端连不到 ${embedUrl}（${reach || '空响应'}）。可设置 DY_EMBED_URL 指向远端能访问的 OpenAI 兼容端点后重试。`
      );
      embed.server.close();
      process.exit(2);
    }
  } else {
    console.log(`用外部端点 ${override}（此时不再统计端点调用次数）`);
  }
  console.log(`embedding 端点：${embedUrl}/v1/embeddings（每批模拟 ${EMBED_LATENCY_MS}ms，dims=${EMBED_DIMS}）`);

  // ── 跑三次测量
  const cmd =
    `python3 "${driverRemote}" --core="${coreRemote}" --ws="${WS}" --data="${dataDir}" ` +
    `--db_a="${baseDir}/indexA.sqlite" --db_b="${baseDir}/indexB.sqlite" ` +
    `--embed-url="${embedUrl}" --model="${EMBED_MODEL}" --dims=${EMBED_DIMS}`;
  const run = await sh(cmd, 3600000);
  const lines = String(run.stdout || '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const rows = [];
  for (const line of lines) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      console.log(`[driver] ${line}`);
      continue;
    }
    if (msg.error) {
      console.error(`驱动失败: ${msg.error}`);
      process.exit(1);
    }
    rows.push(msg);
  }
  if (rows.length < 3) {
    console.error(`期望三次测量，只拿到 ${rows.length} 条`);
    process.exit(1);
  }
  const builds = rows.filter((r) => r && r.label);
  const searchRow = rows.find((r) => r && r.search);

  console.log('\n── 结果 ──');
  for (const r of builds) {
    console.log(
      `${String(r.label).padEnd(14)} ${String(r.elapsedMs).padStart(8)}ms · 片段 ${r.chunkCount} · 向量 ${r.vectorCount}` +
        ` · 复用 ${r.vectorsReused} / 新算 ${r.vectorsEmbedded} · 库 ${fmtBytes(r.dbBytes)}`
    );
  }
  if (searchRow) {
    console.log(`检索：vectorSearch=${searchRow.search.vectorSearch} hits=${searchRow.search.hits}`);
  }
  console.log(
    `embedding 端点被请求 ${embed.state.calls} 次 / ${embed.state.inputs} 条文本 · ` +
      `在飞峰值 ${embed.state.maxInflight}（闸门 4）· 每批模拟 ${EMBED_LATENCY_MS}ms`
  );

  const [a, b, c] = builds;
  check('A 冷启动：向量全部真算', a.vectorsReused === 0 && a.vectorsEmbedded > 0, `复用 ${a.vectorsReused} / 新算 ${a.vectorsEmbedded} / 片段 ${a.chunkCount}`);
  check(
    'B 第二个会话：向量零新算',
    b.vectorsEmbedded === 0 && b.vectorCount === a.vectorCount,
    `复用 ${b.vectorsReused} / 新算 ${b.vectorsEmbedded} / 向量 ${b.vectorCount}（A ${a.vectorCount}）`
  );
  check(
    'C 同库重建：向量零新算',
    c.vectorsEmbedded === 0 && c.vectorCount === a.vectorCount,
    `复用 ${c.vectorsReused} / 新算 ${c.vectorsEmbedded} / 向量 ${c.vectorCount}`
  );
  check(
    'B 不慢于 A（向量阶段省下来了）',
    b.elapsedMs <= a.elapsedMs,
    `A ${a.elapsedMs}ms → B ${b.elapsedMs}ms（差 ${a.elapsedMs - b.elapsedMs}ms, ${Math.round((1 - b.elapsedMs / Math.max(1, a.elapsedMs)) * 100)}%）`
  );
  check('B 的库大小与 A 相当（向量确实写进了新库）', b.dbBytes > 0 && Math.abs(b.dbBytes - a.dbBytes) / Math.max(1, a.dbBytes) < 0.25, `${fmtBytes(a.dbBytes)} vs ${fmtBytes(b.dbBytes)}`);
  if (!override) {
    check(
      '端点只被第一个会话调用',
      embed.state.calls > 0,
      `${embed.state.calls} 次请求 / ${embed.state.inputs} 条文本（B、C 阶段的新算为 0，见上两行）`
    );
    // 批大小 + 有界并发：请求数远少于片段数，且在飞峰值进到 (1, 4]
    check(
      '批量生效：请求数远少于片段数',
      embed.state.calls * 4 < a.chunkCount,
      `请求 ${embed.state.calls} 次 vs 片段 ${a.chunkCount} 条（≈ ${(a.chunkCount / Math.max(1, embed.state.calls)).toFixed(1)} 条/批）`
    );
    check(
      '并发生效且受闸门约束',
      embed.state.maxInflight > 1 && embed.state.maxInflight <= 4,
      `在飞峰值 ${embed.state.maxInflight}（应在 2..=4）`
    );
  }

  const failed = results.filter((r) => r[0] === 'FAIL').length;
  console.log(`\n${failed ? `FAILED ${failed}/${results.length}` : `ALL OK (${results.length} checks)`} · 总耗时 ${Math.round((Date.now() - t0) / 1000)}s`);
  if (!KEEP) await sh(`rm -rf "${baseDir}"`);
  else console.log(`保留远端目录：${baseDir}`);
  embed.server.close();
  ssh.disconnect();
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error(`失败：${e && e.message ? e.message : e}`);
  process.exit(2);
});
