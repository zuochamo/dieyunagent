'use strict';
/**
 * 词法通道质量测量（§3 FTS5 决策的**可重复**依据）
 *
 * 回答的问题：现在这条 `LIKE '%term%'` 子串通道，**找得到吗、排得对吗、多慢**。
 * 只有它先坏了，才谈得上「换 FTS5 + bm25」；§4 的向量那条有明确触发线，这条同样要有数据。
 *
 * 做法（不依赖 app / 网关 / 网络，只 spawn 本仓 core）：
 *   1) `dieyun-core --data-dir <tmp> serve-stdio` + stdio JSON-RPC；
 *   2) `core.configure` → `codebase.index.start`（**不建向量**，只测词法）→ 轮询 `codebase.status`；
 *   3) 题目**机械抽样**（不挑好答的）：单标识符题取语料里出现频次最高的若干 token；
 *      多词题从真实注释行里切 2–3 个 token；
 *   4) ground truth 由本脚本自己扫文件算（**只数正文**，路径命中不算证据 —— 与
 *      `index/search.rs` 的 `content_hits` 同一口径），算 hit@1 / hit@limit / MRR；
 *   5) 逐题记延迟，汇总 p50 / p95，并落一份 JSON 到 `.dieyun/measure-lexical/`，供前后对比。
 *
 * 判据（写死在脚本里，避免「看了数据再改口径」）：
 *   - hit@limit ≥ 0.90 且 MRR ≥ 0.70 且 p95 ≤ 300ms → **不换**（LIKE 够用）
 *   - p95 > 300ms 或 hit@limit < 0.90 → **触发 §3**（换 FTS5 前先按 docs/VECTOR-SEARCH.md §4 的方式量一次真语料）
 *
 * 用法：
 *   node scripts/measure-lexical-quality.cjs [--workspace <dir>] [--limit 5] [--sample 20]
 *        [--core <exe>] [--json <path>] [--keep] [--quiet]
 *   缺省 workspace = 本仓；core = DIEYUN_CORE_BIN，否则 target/{debug,release}/dieyun-core(.exe)
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { IGNORED_DIRS, BINARY_EXT } = require('../src/index/source-files');

const ROOT = path.join(__dirname, '..');

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      out[key] = next;
      i += 1;
    } else {
      out[key] = true;
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const WORKSPACE = path.resolve(String(args.workspace || ROOT));
const LIMIT = Math.max(1, Number(args.limit) || 5);
const SAMPLE = Math.max(4, Number(args.sample) || 20);
const QUIET = !!args.quiet;
const KEEP = !!args.keep;

function findCore() {
  if (args.core) return String(args.core);
  if (process.env.DIEYUN_CORE_BIN) return process.env.DIEYUN_CORE_BIN;
  for (const rel of [
    ['target', 'debug', 'dieyun-core.exe'],
    ['target', 'debug', 'dieyun-core'],
    ['target', 'release', 'dieyun-core.exe'],
    ['target', 'release', 'dieyun-core']
  ]) {
    const p = path.join(ROOT, ...rel);
    if (fs.existsSync(p)) return p;
  }
  throw new Error('找不到 dieyun-core：先 cargo build -p dieyun-core，或传 --core <exe>');
}

// ── core stdio 客户端（行 JSON-RPC；与 scripts/index-timing-driver.py 同一份协议）────────
class Core {
  constructor(exe, dataDir) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.proc = spawn(exe, ['--data-dir', dataDir, 'serve-stdio'], {
      stdio: ['pipe', 'pipe', 'pipe']
    });
    this.buf = '';
    this.seq = 0;
    this.pending = new Map();
    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', (chunk) => {
      this.buf += chunk;
      let nl;
      while ((nl = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, nl).trim();
        this.buf = this.buf.slice(nl + 1);
        if (!line) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        const waiter = this.pending.get(msg.id);
        if (!waiter) continue;
        this.pending.delete(msg.id);
        if (msg.error) waiter.reject(new Error(`${msg.error.code}: ${msg.error.message}`));
        else waiter.resolve(msg.result);
      }
    });
    this.proc.stderr.setEncoding('utf8');
    this.stderr = '';
    this.proc.stderr.on('data', (c) => {
      this.stderr += c;
      if (this.stderr.length > 8000) this.stderr = this.stderr.slice(-8000);
    });
  }

  call(method, params, timeoutMs = 600000) {
    this.seq += 1;
    const id = this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} 超时（${timeoutMs}ms）`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        }
      });
      this.proc.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  }

  close() {
    try {
      this.proc.stdin.end();
    } catch {
      /* ignore */
    }
    // 等进程真的退出再返回：Windows 上 sqlite 句柄没释放时删临时目录会 EPERM
    this.exited = new Promise((resolve) => {
      const done = () => resolve();
      this.proc.once('exit', done);
      setTimeout(() => {
        try {
          this.proc.kill();
        } catch {
          /* ignore */
        }
        setTimeout(done, 500);
      }, 3000);
    });
    try {
      this.proc.kill();
    } catch {
      /* ignore */
    }
    return this.exited;
  }
}

// ── 语料 ──────────────────────────────────────────────────────────────────────
const TEXT_EXT = new Set([
  '.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.json', '.md', '.css', '.scss',
  '.py', '.go', '.rs', '.java', '.yml', '.yaml', '.toml', '.sh', '.ps1', '.bat',
  '.txt', '.sql', '.html', '.htm'
]);
const MAX_FILE_BYTES = 512 * 1024;

function collectFiles(root) {
  const out = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      // 隐藏项与 Rust walker 一致：`ignore` crate 默认跳过点目录 / 点文件，
      // 索引里永远不会有它们 —— 算进 ground truth 只会制造假「漏召」。
      if (entry.name.startsWith('.')) continue;
      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name)) continue;
        walk(abs);
        continue;
      }
      if (!entry.isFile()) continue;
      const ext = path.extname(entry.name).toLowerCase();
      if (BINARY_EXT.has(ext) || !TEXT_EXT.has(ext)) continue;
      let st;
      try {
        st = fs.statSync(abs);
      } catch {
        continue;
      }
      if (st.size > MAX_FILE_BYTES) continue;
      let text;
      try {
        text = fs.readFileSync(abs, 'utf8');
      } catch {
        continue;
      }
      out.push({ rel: path.relative(root, abs).replace(/\\/g, '/'), text, lower: text.toLowerCase() });
    }
  };
  walk(root);
  return out;
}

/** 机械抽样：出现频次最高的标识符（确定性：按频次降序 + 名字排序，均匀取 SAMPLE 个）。 */
function sampleIdentifierQueries(files, n) {
  const freq = new Map();
  const re = /\b[a-z][a-z0-9_]{7,24}\b/g;
  for (const f of files) {
    const seen = new Set();
    let m;
    while ((m = re.exec(f.text))) seen.add(m[0]);
    for (const token of seen) freq.set(token, (freq.get(token) || 0) + 1);
  }
  const ranked = [...freq.entries()]
    .filter(([, count]) => count >= 3)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const picked = [];
  const step = Math.max(1, Math.floor(ranked.length / n));
  for (let i = 0; i < ranked.length && picked.length < n; i += step) picked.push(ranked[i][0]);
  return picked.map((token) => ({ kind: 'identifier', query: token, tokens: [token] }));
}

/** 多词题：从真实注释行里切 2–3 个 token（中文词按连续片段切）。 */
function sampleMultiTermQueries(files, n) {
  const out = [];
  const seen = new Set();
  for (const f of files) {
    for (const line of f.text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('//') && !trimmed.startsWith('#') && !trimmed.startsWith('*')) continue;
      const words = trimmed
        .replace(/^[/#*\s]+/, '')
        .split(/[\s，。、：:（）()「」【】]+/)
        .filter((w) => w && !w.startsWith('@') && w.length >= 2);
      if (words.length < 2) continue;
      const tokens = words.slice(0, Math.min(3, words.length));
      const query = tokens.join(' ');
      if (seen.has(query)) continue;
      seen.add(query);
      out.push({ kind: 'multi', query, tokens });
      if (out.length >= n) return out;
    }
  }
  return out;
}

/**
 * 索引**实际会看到**的文件集合：本脚本的粗筛（IGNORED_DIRS / 二进制扩展 / 文本扩展）
 * 之后再套一遍 `.gitignore`（用 `git check-ignore`，与 Rust walker 的 `ignore` crate 同语义）。
 *
 * 为什么必须有这一步：漏掉它，被 .gitignore 掉的文件（`build/`、`src/renderer/dist/` …）
 * 会被算进 ground truth，于是「索引没召回」里混进一堆「本来就不该进索引」的文件，
 * 命中率被人为压低 —— 测量口径必须和被测对象一致。
 */
function applyGitignore(files, root) {
  if (!files.length) return { kept: files, ignored: 0 };
  // 用 `ignore` 包而不是 shell 出去找 git：Rust walker 用的就是 ignore crate 的语义
  // （尊重 `.gitignore` / `.ignore`，且**不要求**这个目录是 git 仓库 —— 用户随手指的
  // 一个文件夹也可能带 .gitignore）。找不到这个包就退化成「只按 IGNORED_DIRS/隐藏项」。
  let ig;
  try {
    const createIgnore = require('ignore');
    ig = createIgnore();
    for (const name of ['.gitignore', '.ignore']) {
      const p = path.join(root, name);
      if (fs.existsSync(p)) ig.add(fs.readFileSync(p, 'utf8'));
    }
  } catch {
    return { kept: files, ignored: 0 };
  }
  const kept = files.filter((f) => !ig.ignores(f.rel));
  return { kept, ignored: files.length - kept.length };
}

/** ground truth：**正文**里同时出现所有 token 的文件（与 `content_hits` 同口径）。 */
function truthFor(files, tokens) {
  const lowered = tokens.map((t) => t.toLowerCase());
  return files.filter((f) => lowered.every((t) => f.lower.includes(t))).map((f) => f.rel);
}

function pct(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return Math.round(sorted[idx]);
}

async function main() {
  const exe = findCore();
  // 产物与（--keep 时的）索引库都落在 `.dieyun/measure-lexical/`：
  // 仓库约定的本机运行时数据目录（已被 .gitignore 覆盖），不污染 build/。
  const OUT_DIR = path.join(ROOT, '.dieyun', 'measure-lexical');
  const dataDir = KEEP
    ? path.join(OUT_DIR, 'data')
    : fs.mkdtempSync(path.join(os.tmpdir(), 'dy-lexical-'));
  const indexDb = path.join(dataDir, 'codebase.sqlite');
  const core = new Core(exe, dataDir);
  const log = (...m) => {
    if (!QUIET) console.log(...m);
  };

  try {
    log(`corpus: ${WORKSPACE}`);
    await core.call('core.configure', {
      data_dir: dataDir,
      workspace_roots: [WORKSPACE],
      index_db_path: indexDb
    });

    log('indexing (lexical only, vectors=false)…');
    const t0 = Date.now();
    await core.call('codebase.index.start', {
      workspaceRoot: WORKSPACE,
      force: true,
      vectors: false
    });
    let status = null;
    for (let i = 0; i < 600; i += 1) {
      status = await core.call('codebase.status', { workspaceRoot: WORKSPACE });
      if (status && status.indexed && !status.indexing) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    const indexMs = Date.now() - t0;

    const scanned = collectFiles(WORKSPACE);
    const { kept: files, ignored } = applyGitignore(scanned, WORKSPACE);
    log(`corpus 过滤：扫到 ${scanned.length} 个文本文件，其中 ${ignored} 个被 .gitignore 排除（不进索引，也不算漏召）`);
    const queries = [
      ...sampleIdentifierQueries(files, SAMPLE),
      ...sampleMultiTermQueries(files, Math.max(2, Math.round(SAMPLE / 2)))
    ];

    const rows = [];
    for (const q of queries) {
      const truth = truthFor(files, q.tokens);
      if (!truth.length) continue;
      const started = Date.now();
      const res = await core.call('codebase.search', {
        workspaceRoot: WORKSPACE,
        query: q.query,
        limit: LIMIT
      });
      const latencyMs = Date.now() - started;
      // 按文件去重（同一文件可能命中多个 chunk）：否则一个文件能占满 top-k，
      // 「命中率」会低估真实可达性。
      const returned = [
        ...new Set(
          (res && Array.isArray(res.results) ? res.results : []).map((r) =>
            String(r.relPath || r.rel_path || r.path || '')
          )
        )
      ];
      const truthSet = new Set(truth);
      const firstHitIdx = returned.findIndex((p) => truthSet.has(p));
      rows.push({
        kind: q.kind,
        query: q.query,
        truthFiles: truth.length,
        returned,
        hit1: returned[0] !== undefined && truthSet.has(returned[0]),
        hitAtLimit: firstHitIdx >= 0,
        reciprocalRank: firstHitIdx >= 0 ? 1 / (firstHitIdx + 1) : 0,
        latencyMs
      });
    }

    const agg = {
      workspace: WORKSPACE,
      limit: LIMIT,
      core: exe,
      corpus: {
        textFilesScanned: files.length,
        textFilesIgnoredByGit: ignored,
        indexedFiles: status && status.fileCount,
        chunks: status && status.chunkCount,
        filesSkipped: status && status.filesSkipped,
        filesTruncated: status && status.filesTruncated
      },
      indexMs,
      queries: rows.length,
      hit1: rows.filter((r) => r.hit1).length / Math.max(1, rows.length),
      hitAtLimit: rows.filter((r) => r.hitAtLimit).length / Math.max(1, rows.length),
      mrr: rows.reduce((s, r) => s + r.reciprocalRank, 0) / Math.max(1, rows.length),
      latency: {
        p50: pct(rows.map((r) => r.latencyMs), 50),
        p95: pct(rows.map((r) => r.latencyMs), 95),
        max: Math.max(0, ...rows.map((r) => r.latencyMs))
      },
      rows
    };
    // 判据写死在这里（见文件头）：命中/排序/延迟三项都在线内就不换 FTS5。
    // 题数不足（小目录 / 抽样全军覆没）时不下结论 —— 否则 0 题的 run 也会被判成 trigger。
    const MIN_QUERIES = 8;
    agg.minQueries = MIN_QUERIES;
    if (rows.length < MIN_QUERIES) {
      agg.verdict = 'insufficient-queries';
    } else {
      agg.verdict =
        agg.hitAtLimit >= 0.9 && agg.mrr >= 0.7 && agg.latency.p95 <= 300
          ? 'keep-LIKE'
          : 'trigger-FTS5';
    }

    fs.mkdirSync(OUT_DIR, { recursive: true });
    const outFile =
      String(args.json || '') ||
      path.join(OUT_DIR, `lexical-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
    fs.writeFileSync(outFile, `${JSON.stringify(agg, null, 2)}\n`, 'utf8');

    log('');
    log(`corpus  ${agg.corpus.textFilesScanned} 个文本文件 / ${agg.corpus.indexedFiles} 进索引 / ${agg.corpus.chunks} chunk（建库 ${indexMs}ms）`);
    log(`queries ${agg.queries} 题（identifier + multi-term，机械抽样）`);
    log(`hit@1   ${(agg.hit1 * 100).toFixed(1)}%`);
    log(`hit@${LIMIT}   ${(agg.hitAtLimit * 100).toFixed(1)}%`);
    log(`MRR     ${agg.mrr.toFixed(3)}`);
    log(`latency p50 ${agg.latency.p50}ms / p95 ${agg.latency.p95}ms / max ${agg.latency.max}ms`);
    log(`verdict ${agg.verdict}（判据 hit@limit ≥ 90% ∧ MRR ≥ 0.70 ∧ p95 ≤ 300ms，且题数 ≥ ${MIN_QUERIES}）`);
    if (agg.verdict === 'insufficient-queries') {
      log(`  ⚠ 有效题目只有 ${rows.length} 道（< ${MIN_QUERIES}）：这个目录太小或语料里抽不出题，本次不给结论`);
    }
    log(`artifact ${path.relative(ROOT, outFile)}`);
    if (agg.verdict === 'trigger-FTS5') {
      log('');
      log('未达判据的题目（对照 §3 的「动什么算完」）：');
      for (const r of rows.filter((x) => !x.hitAtLimit).slice(0, 10)) {
        log(`  ✗ [${r.kind}] ${r.query} → truth=${r.truthFiles} 份，返回 ${r.returned.length} 条`);
      }
      for (const r of rows.filter((x) => x.hitAtLimit && !x.hit1).slice(0, 10)) {
        log(`  ~ [${r.kind}] ${r.query} → 命中但不在第一（rank ${Math.round(1 / r.reciprocalRank)}）`);
      }
    }
    if (agg.corpus.filesTruncated) {
      log(`注意：本轮有文件因 16k 上限被截断（filesTruncated=${agg.corpus.filesTruncated}）—— 语料规模判据需要先处理它`);
    }
    process.exitCode = 0;
  } finally {
    await core.close();
    if (!KEEP) {
      // 临时数据目录随进程清理：`--keep` 时才留在 build/ 下供复跑。
      // 删不掉不算失败（句柄偶尔还挂着），打一行就够。
      try {
        fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      } catch (e) {
        if (!QUIET) console.log(`注意：临时目录没删干净（${e.code || e.message}）：${dataDir}`);
      }
    }
  }
}

main().catch((err) => {
  console.error(`✗ ${err && err.message ? err.message : err}`);
  process.exitCode = 1;
});
