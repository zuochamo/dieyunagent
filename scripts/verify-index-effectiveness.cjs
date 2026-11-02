'use strict';
/**
 * 索引有效性实测（真 app + 真远端会话 + 真索引库）
 *
 * 回答一个具体问题：「代码索引 / 结构索引到底有没有用？」——用可复现的口径，而不是感觉。
 *
 * 做法：
 *   1) 经本机网关（`ws://127.0.0.1:17330`，真 Main / 真远端 Agent）按**会话作用域**打 RPC，
 *      不手拼 workspaceRoot —— 这正是 app 的调用形状；
 *   2) 题目从被测仓库**机械抽样**（不挑好答的）：标识符题 = 定义点里的符号名，
 *      自然语言题 = 仓库里的中文注释原文；
 *   3) 每题都有 ground truth（符号/注释所在文件），算 hit@1 / hit@5 / MRR，并与
 *      **无索引基线 `grep`** 对照；延迟也一起记；
 *   4) 结构索引三件事分开测：能不能索引（`graph.status`）、按名找到符号
 *      （`graph.symbol_search` / `fs.read_symbol`）、调用关系（`graph.callers`）。
 *
 * 环境变量：
 *   DY_SESSION      必填，会话 id（作用域唯一来源；缺省则用 `runWorkspaceRoot` 意义不大，直接报错）
 *   DY_SSH_HOST     抽样与 grep 基线用的主机（缺省则跳过基线，只测索引自身）
 *   DY_WS_URL       默认 ws://127.0.0.1:17330
 *   DY_TOKEN_FILE   默认 %APPDATA%\dieyunagent\gateway-token.txt
 *   DY_LIMIT        search limit（默认 5）
 *   DY_BUILD        1=允许首建索引/图（默认 1）
 *   DY_SAMPLE       每族抽样题数（默认 10 / 5）
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const WebSocket = require('ws');

const env = (k, d = '') => String(process.env[k] || d).trim();

const WS_URL = env('DY_WS_URL', 'ws://127.0.0.1:17330');
const TOKEN_FILE = env(
  'DY_TOKEN_FILE',
  path.join(process.env.APPDATA || os.homedir(), 'dieyunagent', 'gateway-token.txt')
);
const SESSION = env('DY_SESSION');
const SSH_HOST = env('DY_SSH_HOST');
const LIMIT = Number(env('DY_LIMIT', '5')) || 5;
const BUILD = env('DY_BUILD', '1') !== '0';
// 与面板「建向量」同一条路径：explicit `vectors: true`，不看持久意图 indexSemanticSearch
const VECTORS = env('DY_VECTORS', '0') === '1';
const N_SYMBOL = Number(env('DY_SAMPLE', '10')) || 10;
const N_NL = Math.max(1, Math.round(N_SYMBOL / 2));

function die(msg) {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

// ── 网关客户端（与本机 app 同一份 token / 同一套协议） ───────────────────────────
function connectGateway() {
  if (!fs.existsSync(TOKEN_FILE)) die(`找不到网关 token：${TOKEN_FILE}（app 没在跑？）`);
  const token = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL);
    const pending = new Map();
    let seq = 0;
    const timer = setTimeout(() => reject(new Error(`连接 ${WS_URL} 超时`)), 8000);
    ws.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    // auth 必须在 open 后立刻发：服务端先等 auth，再接受 call
    ws.on('open', () => {
      ws.send(JSON.stringify({ v: 1, type: 'auth', token }));
    });
    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (msg.type === 'auth_ok') {
        clearTimeout(timer);
        resolve({
          ws,
          call(method, params, timeoutMs = 120000) {
            return new Promise((res, rej) => {
              const id = `probe-${++seq}`;
              const t = setTimeout(() => {
                pending.delete(id);
                rej(
                  Object.assign(new Error(`${method} 超时 ${timeoutMs}ms`), {
                    code: 'PROBE_TIMEOUT'
                  })
                );
              }, timeoutMs);
              pending.set(id, { res, rej, t, method });
              ws.send(JSON.stringify({ v: 1, type: 'call', id, method, params }));
            });
          },
          close() {
            try {
              ws.close();
            } catch {
              /* ignore */
            }
          }
        });
        return;
      }
      const p = msg.id && pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      clearTimeout(p.t);
      if (msg.ok === false || msg.type === 'error') {
        const err = new Error((msg.error && msg.error.message) || 'rpc failed');
        Object.assign(err, msg.error || {}, { method: p.method });
        p.rej(err);
      } else {
        // 服务端把结果放在 `data`（见 src/gateway/server.js 的 `{type:'result', ok, data}`）
        p.res(msg.data !== undefined ? msg.data : msg);
      }
    });
  });
}

// ── 远端 shell（抽样 / grep 基线） ────────────────────────────────────────────
function ssh(cmd, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    execFile(
      'ssh',
      ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', SSH_HOST, cmd],
      { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, encoding: 'utf8' },
      (err, stdout) => (err ? reject(err) : resolve(stdout))
    );
  });
}

// ── 指标 ───────────────────────────────────────────────────────────────────
function rankOf(paths, expect) {
  const want = expect.replace(/^\.?\//, '');
  for (let i = 0; i < paths.length; i += 1) {
    const got = String(paths[i] || '')
      .replace(/^\.?\//, '')
      .replace(/\\\\/g, '/');
    if (got === want || got.endsWith(`/${want}`)) return i + 1;
  }
  return 0;
}

function summarize(ranks, latencies) {
  const n = ranks.length || 1;
  const hit1 = ranks.filter((r) => r === 1).length;
  const hit5 = ranks.filter((r) => r > 0 && r <= LIMIT).length;
  const mrr = ranks.reduce((acc, r) => acc + (r > 0 ? 1 / r : 0), 0) / n;
  const sorted = latencies.slice().sort((a, b) => a - b);
  const p50 = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
  return { n: ranks.length, hit1, hit5, mrr, p50 };
}

function pct(a, b) {
  if (!b) return '0%';
  return `${Math.round((a / b) * 100)}%`;
}

/**
 * 把中文注释改写成「真实用户问法」：去掉虚词/标点，留下实词。
 *
 * 这是子串通道的天敌 —— 原文能撞上，去掉虚词后就不再是连续子串。用它才能回答
 * 「没有向量的时候，索引对『换个说法问同一件事』到底有没有用」。
 */
function paraphrase(text) {
  const stops = [
    '的', '了', '是', '在', '和', '与', '用', '把', '被', '就', '也', '都', '要', '会',
    '可', '这', '那', '一个', '我们', '你', '我', '它', '他', '她', '到', '对', '为',
    '从', '以', '及', '等', '中', '上', '下', '里', '时', '后', '前', '并', '而', '或',
    '不', '没', '有', '如果', '因为', '所以', '但是', '还是', '只', '更', '最', '再'
  ];
  let out = String(text || '');
  for (const w of stops) out = out.split(w).join(' ');
  return out.replace(/[\s，。：；、（）()【】\[\]“”"'`]+/g, ' ').trim();
}

// ── 主流程 ─────────────────────────────────────────────────────────────────
(async () => {
  if (!SESSION) die('需要 DY_SESSION=<会话 id>（作用域只认会话，脚本不拼 workspaceRoot）');
  const gw = await connectGateway();
  const call = gw.call.bind(gw);
  const t0 = Date.now();
  console.log(`网关 ${WS_URL} 已连接 · 会话 ${SESSION} · 用时 ${Date.now() - t0}ms`);

  // ① 代码索引：状态（这一行同时验证「会话根 = 远端连接声明的根」）
  let st = await call('codebase.status', { sessionId: SESSION }, 60000);
  const rootUri = String(st.workspaceRoot || '');
  console.log(
    `codebase.status: indexed=${!!st.indexed} indexing=${!!st.indexing} ` +
      `files=${st.fileCount ?? '?'} chunks=${st.chunkCount ?? '?'} vectors=${st.vectorCount ?? '?'}` +
      `${st.indexedAt ? ` indexedAt=${new Date(Number(st.indexedAt)).toISOString()}` : ''}`
  );

  if (BUILD && (!st.indexed || VECTORS || st.indexing)) {
    console.log(
      `· 建库（codebase.index.start，vectors=${VECTORS ? 'true（补齐/重建向量）' : '缺省=持久意图'}）…`
    );
    const bt = Date.now();
    await call(
      'codebase.index.start',
      VECTORS ? { sessionId: SESSION, skipIfReady: !VECTORS, vectors: true } : { sessionId: SESSION, skipIfReady: true },
      900000
    );
    let lastVec = -1;
    for (let i = 0; i < 900; i += 1) {
      await new Promise((r) => setTimeout(r, 1000));
      const prev = st;
      st = await call('codebase.status', { sessionId: SESSION }, 60000);
      if (VECTORS && Number(st.vectorCount) !== lastVec) {
        lastVec = Number(st.vectorCount);
        if (i % 5 === 0)
          console.log(`  向量 ${lastVec}/${st.chunkCount}（${((Date.now() - bt) / 1000).toFixed(0)}s）`);
      }
      if (st.indexed && !st.indexing) break;
      if (!VECTORS && prev.indexed && st.indexed) break;
    }
    console.log(
      `· 建库完成 ${Date.now() - bt}ms：chunks=${st.chunkCount} files=${st.fileCount} ` +
        `vectors=${st.vectorCount}（embedded=${st.vectorsEmbedded ?? '?'} reused=${st.vectorsReused ?? '?'}）`
    );
  }

  // 远端仓库根（grep 基线与抽样都在这上面）：优先用会话行里的工作区（唯一来源），
  // 其次才是 status 回包（不同版本可能不带 root）。
  const remoteRoot = await (async () => {
    if (SSH_HOST === '') return '';
    let ws = rootUri;
    if (!ws) {
      try {
        const row = await call('memory.session_get', { sessionId: SESSION }, 30000);
        ws = String((row && row.workspacePath) || '');
      } catch {
        /* 没有就退回空 */
      }
    }
    const m = ws.match(/^ssh:\/\/[^/]+(\/.*)$/);
    return m ? m[1] : '';
  })();
  if (remoteRoot) console.log(`远端根：${remoteRoot}`);

  // ② 机械抽样出题：符号 + 中文注释（都不挑「好答」的）
  let symbols = [];
  let nls = [];
  if (remoteRoot) {
    const defs = await ssh(
      `cd '${remoteRoot}' && grep -rn --include=*.py --include=*.js --include=*.ts -e '^def ' -e '^function ' -e '^async function ' -e '^export function ' -e '^export async function ' . | head -n 400`
    );
    const parsed = [];
    for (const line of String(defs).split('\n')) {
      const m = line.match(/^\.\/(.+?):(\d+):(?:export )?(?:async )?(?:def|function) ([A-Za-z_$][\w$]*)/);
      if (!m) continue;
      const name = m[3];
      if (name.length < 8) continue; // 太短的名字 grep 也能秒中，测不出差别
      parsed.push({ name, path: m[1], line: Number(m[2]) });
    }
    const step = Math.max(1, Math.floor(parsed.length / Math.max(1, N_SYMBOL)));
    for (let i = 0; i < parsed.length && symbols.length < N_SYMBOL; i += step) {
      const cand = parsed[i];
      if (!symbols.some((s) => s.name === cand.name)) symbols.push(cand);
    }

    const comments = await ssh(
      `cd '${remoteRoot}' && grep -rn --include=*.py --include=*.js --include=*.md -e '^#' -e '^ *//' . | head -n 2000`
    );
    const nlCand = [];
    for (const line of String(comments).split('\n')) {
      const m = line.match(/^\.\/(.+?):(\d+):(.*)$/);
      if (!m) continue;
      const text = m[3].replace(/^[#/\s]+/, '').trim();
      const cjk = (text.match(/[\u4e00-\u9fa5]/g) || []).length;
      if (cjk < 8 || text.length < 14) continue; // 太短的注释靠子串也能中
      nlCand.push({ text, path: m[1], line: Number(m[2]) });
    }
    const nstep = Math.max(1, Math.floor(nlCand.length / Math.max(1, N_NL)));
    for (let i = 0; i < nlCand.length && nls.length < N_NL; i += nstep) {
      if (!nls.some((s) => s.text === nlCand[i].text)) nls.push(nlCand[i]);
    }
    console.log(
      `抽样：符号 ${symbols.length} 个（定义点 ${parsed.length} 个）· 中文注释 ${nls.length} 条（候选 ${nlCand.length} 条）`
    );
  } else {
    console.log('（未给 DY_SSH_HOST：跳过抽样与 grep 基线，只测索引自身）');
  }

  // ③ 代码索引检索：与 grep 基线对照
  const rows = [];
  async function gradeIndex(item, query) {
    const t = Date.now();
    let res = null;
    let err = null;
    try {
      res = await call('codebase.search', { sessionId: SESSION, query, limit: LIMIT }, 120000);
    } catch (e) {
      err = e;
    }
    const ms = Date.now() - t;
    const paths = (res && res.results ? res.results : []).map((r) => r.path);
    return {
      item,
      query,
      paths,
      rank: err ? 0 : rankOf(paths, item.path),
      ms,
      vectorSearch: !!(res && res.vectorSearch),
      err: err ? err.code || err.message : ''
    };
  }

  async function gradeGrep(item, token) {
    if (!remoteRoot) return { rank: 0, ms: 0, top: [] };
    const t = Date.now();
    const out = await ssh(
      `cd '${remoteRoot}' && grep -rc -F -e '${token.replace(/'/g, "'\\''")}' --include=*.py --include=*.js --include=*.ts --include=*.md . 2>/dev/null | grep -v ':0$' | sort -t: -k2 -rn | head -n ${LIMIT}; true`
    );
    const ms = Date.now() - t;
    const top = String(out)
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => l.replace(/^\.\//, '').replace(/:\d+$/, ''));
    return { rank: rankOf(top, item.path), ms, top };
  }

  for (const s of symbols) {
    const idx = await gradeIndex(s, s.name);
    const gr = await gradeGrep(s, s.name);
    rows.push({ family: '标识符', ...idx, grepRank: gr.rank, grepMs: gr.ms, expect: s.path });
  }
  for (const n of nls) {
    // 自然语言两问法：原文（字面能撞上注释）／去掉虚词的改写（真实用户问法，子串必然断开）
    const idx = await gradeIndex(n, n.text);
    const gr = await gradeGrep(n, n.text);
    rows.push({ family: '自然语言', ...idx, grepRank: gr.rank, grepMs: gr.ms, expect: n.path });

    const para = paraphrase(n.text);
    if (para && para !== n.text) {
      const idx2 = await gradeIndex(n, para);
      const gr2 = await gradeGrep(n, para);
      rows.push({ family: '改写问法', ...idx2, grepRank: gr2.rank, grepMs: gr2.ms, expect: n.path });
    }
  }

  console.log('\n── 代码索引：命中情况（hit@1 / hit@' + LIMIT + '） ──');
  console.log('族        题  索引 hit@1  hit@' + LIMIT + '   MRR    p50   | grep hit@1  hit@' + LIMIT + '   MRR    p50');
  const families = ['标识符', '自然语言', '改写问法'];
  const agg = {};
  for (const fam of families) {
    const sub = rows.filter((r) => r.family === fam);
    if (!sub.length) continue;
    const idxS = summarize(sub.map((r) => r.rank), sub.map((r) => r.ms));
    const grS = summarize(sub.map((r) => r.grepRank), sub.map((r) => r.grepMs));
    agg[fam] = { idx: idxS, grep: grS };
    console.log(
      `${fam.padEnd(8)} ${String(idxS.n).padStart(2)}  ${String(pct(idxS.hit1, idxS.n)).padStart(8)}  ` +
        `${String(pct(idxS.hit5, idxS.n)).padStart(6)}  ${idxS.mrr.toFixed(2)}  ${String(idxS.p50 + 'ms').padStart(5)}  | ` +
        `${String(pct(grS.hit1, grS.n)).padStart(8)}  ${String(pct(grS.hit5, grS.n)).padStart(6)}  ` +
        `${grS.mrr.toFixed(2)}  ${String(grS.p50 + 'ms').padStart(5)}`
    );
  }
  const vectorOn = rows.some((r) => r.vectorSearch);
  console.log(`向量通道：${vectorOn ? '开（vectorSearch=true）' : '关（子串检索，索引库里没有向量）'}`);
  const errs = rows.filter((r) => r.err);
  if (errs.length) console.log(`检索报错 ${errs.length} 题：${[...new Set(errs.map((e) => e.err))].join(', ')}`);

  // ④ 结构索引：能不能索引 / 按名找符号 / 调用关系
  console.log('\n── 结构索引 ──');
  let gst = null;
  try {
    gst = await call('graph.status', { sessionId: SESSION }, 60000);
    console.log(
      `graph.status: indexed=${!!gst.indexed} indexing=${!!gst.indexing} ` +
        `files=${gst.fileCount ?? gst.files ?? '?'} symbols=${gst.symbolCount ?? gst.symbols ?? '?'} ` +
        `calls=${gst.callCount ?? gst.calls ?? '?'}`
    );
    if (BUILD && !gst.indexed && !gst.indexing) {
      const gt = Date.now();
      await call('graph.index.start', { sessionId: SESSION }, 900000);
      for (let i = 0; i < 300; i += 1) {
        await new Promise((r) => setTimeout(r, 1000));
        gst = await call('graph.status', { sessionId: SESSION }, 60000);
        if (gst.indexed && !gst.indexing) break;
      }
      console.log(`· 结构索引建成 ${Date.now() - gt}ms`);
    }
  } catch (e) {
    console.log(`graph.status 失败：${e.code || e.message}`);
  }

  const symProbe = ['graph.symbol_search', 'fs.read_symbol'].filter(Boolean);
  const symRows = [];
  for (const s of symbols) {
    const row = { name: s.name, path: s.path, symbolSearch: 0, readSymbol: '' };
    try {
      const r = await call(symProbe[0], { sessionId: SESSION, query: s.name, limit: 3 }, 60000);
      const hits = (r && (r.results || r.symbols || [])) || [];
      row.symbolSearch = rankOf(hits.map((h) => h.path || h.file || ''), s.path);
    } catch (e) {
      row.symbolSearch = -1;
      row.symbolSearchErr = e.code || e.message;
    }
    try {
      const r = await call('fs.read_symbol', { sessionId: SESSION, name: s.name, filePath: s.path }, 90000);
      const p = r && (r.path || r.file || r.filePath);
      row.readSymbol = p ? (String(p).replace(/^\.?\//, '').endsWith(s.path) ? 'ok' : `wrong:${p}`) : 'empty';
      if (r && r.symbol && r.symbol.name && r.symbol.name !== s.name) row.readSymbol = `other:${r.symbol.name}`;
    } catch (e) {
      row.readSymbol = e.code || 'ERR';
    }
    symRows.push(row);
  }
  const symHit = symRows.filter((r) => r.symbolSearch >= 1 && r.symbolSearch <= 3).length;
  const readOk = symRows.filter((r) => r.readSymbol === 'ok').length;
  console.log(
    `按名定位：graph.symbol_search 前 3 命中 ${symHit}/${symRows.length} · ` +
      `fs.read_symbol（带 filePath）成功 ${readOk}/${symRows.length}`
  );
  for (const r of symRows) {
    console.log(
      `  ${r.name.padEnd(34)} ${String(r.path).padEnd(38)} symSearch=${String(r.symbolSearch).padStart(2)} read=${r.readSymbol}`
    );
  }

  // 调用关系：挑 3 个「按 grep 应该有人调」的符号（调用图是按需建的，可能要等）
  if (remoteRoot && symbols.length) {
    console.log('\n── 调用关系（graph.callers） ──');
    let tested = 0;
    for (const s of symbols) {
      if (tested >= 3) break;
      const cnt = await ssh(
        `cd '${remoteRoot}' && grep -rn -F -e '${s.name}' --include=*.py --include=*.js . 2>/dev/null | wc -l`
      );
      if (Number(String(cnt).trim()) < 3) continue; // 没人调用就没法验证
      tested += 1;
      let r = null;
      let lastErr = null;
      for (let i = 0; i < 60; i += 1) {
        try {
          r = await call('graph.callers', { sessionId: SESSION, path: s.path, name: s.name }, 180000);
          lastErr = null;
          break;
        } catch (e) {
          lastErr = e;
          // 调用图在后台建：等它，而不是把它当失败
          if (String(e.code || '') !== 'GRAPH_INDEXING_IN_PROGRESS') break;
          await new Promise((res) => setTimeout(res, 2000));
        }
      }
      if (!r) {
        console.log(`  ${s.name.padEnd(34)} graph.callers 失败：${lastErr && (lastErr.code || lastErr.message)}`);
        continue;
      }
      const hits = (r && (r.sites || r.results || r.callers || [])) || [];
      console.log(
        `  ${s.name.padEnd(34)} grep 出现 ${String(cnt).trim()} 次 · graph.callers 返回 ${hits.length} 条` +
          `（解析到符号：${r && r.symbol ? '是' : '否'}）` +
          (hits.length ? ` → ${hits.slice(0, 3).map((h) => h.callerPath || h.path || h.file || '?').join(', ')}` : '')
      );
    }
    if (!tested) console.log('  （抽到的符号都没有第二处引用，跳过）');
  }

  // ⑤ 结论
  console.log('\n── 结论 ──');
  for (const fam of families) {
    const a = agg[fam];
    if (!a) continue;
    const better = a.idx.mrr > a.grep.mrr + 0.001;
    const worse = a.idx.mrr < a.grep.mrr - 0.001;
    console.log(
      `${fam}：索引 MRR ${a.idx.mrr.toFixed(2)} vs grep ${a.grep.mrr.toFixed(2)} —— ` +
        (better ? '索引更好' : worse ? 'grep 更好' : '打平') +
        `（延迟 ${a.idx.p50}ms vs ${a.grep.p50}ms）`
    );
  }
  console.log(
    `结构索引：按名定位 ${symHit}/${symRows.length} 命中前 3、read_symbol ${readOk}/${symRows.length} 成功` +
      `${vectorOn ? '' : ' · 向量通道关闭（自然语言题只能靠子串）'}`
  );
  gw.close();
})().catch((e) => {
  console.error(`✗ ${e.code ? `[${e.code}] ` : ''}${e.message}`);
  process.exit(1);
});
