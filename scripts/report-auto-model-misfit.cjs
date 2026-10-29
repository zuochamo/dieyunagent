#!/usr/bin/env node
'use strict';

/**
 * Auto 选型「错配率」只读报表 —— 决定要不要给 Auto 加「试错账本」的证据入口。
 *
 * 背景：Auto 只是 Renderer 在发送前选一次 route（见 renderer-composer.resolveComposerModelForSend），
 * 选型本身靠声明（启用顺序 + 模态），不再靠模型名猜能力。既然选择会错，就要能**量**出来：
 * 错得少就别加机制（减法优先），错得多再加「route → 近期失败原因」的自过期观测。
 *
 * 本脚本只读，不写库、不改配置。数据全部来自**已经存在**的旁路事实：
 *   - request_snapshots：每轮真实请求的 model / est_tokens / token_budget / source；
 *   - agent_runs：run 的最终 status。
 *
 * 能回答：某模型是否在本机真实会话里顶穿过预算（那会表现为 400 context_length_exceeded）。
 * 不能回答（并在输出里显式说明）：某次失败是否由「Auto 选错了模型」导致 ——
 * request_snapshots 目前没有 route 列，run_id 与 agent_runs.id 也不对齐，
 * 所以任何「按模型归因失败」的结论都只能是猜测。
 *
 * 用法：
 *   node scripts/report-auto-model-misfit.cjs                 # 读默认 userData 库
 *   node scripts/report-auto-model-misfit.cjs --db <path>     # 指定 diecloud-memory.sqlite
 *   node scripts/report-auto-model-misfit.cjs --days 30       # 只看最近 N 天
 *   node scripts/report-auto-model-misfit.cjs --json          # 机器可读
 */

const fs = require('fs');
const path = require('path');

const OVER80_SHARE_LIMIT = 0.2; // >80% 预算的请求占比超过它就认为「选型吃紧」
const FAILED_SHARE_LIMIT = 0.05; // run 失败率超过它就认为「值得归因」

function parseArgs(argv) {
  const out = { db: '', days: 0, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--db') out.db = String(argv[++i] || '');
    else if (a === '--days') out.days = Math.max(0, Number(argv[++i]) || 0);
    else if (a === '--json') out.json = true;
  }
  return out;
}

function defaultDbPath() {
  const appData = process.env.APPDATA || path.join(process.env.HOME || '', '.config');
  return path.join(appData, 'dieyunagent', 'diecloud-memory.sqlite');
}

function openDb(dbPath) {
  let DatabaseSync;
  try {
    ({ DatabaseSync } = require('node:sqlite'));
  } catch {
    console.error('[report] 需要带 node:sqlite 的 Node（>= 22.5，本项目用 24）。');
    process.exit(2);
  }
  if (!fs.existsSync(dbPath)) {
    console.error(`[report] 找不到库文件：${dbPath}\n[report] 用 --db 指定，或先跑一次应用生成。`);
    process.exit(2);
  }
  return new DatabaseSync(dbPath, { readOnly: true });
}

function hasTable(db, name) {
  const row = db
    .prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type='table' AND name=?")
    .get(name);
  return !!row && Number(row.c) > 0;
}

function pct(n) {
  return `${(Number(n) * 100).toFixed(1)}%`;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const dbPath = args.db || defaultDbPath();
  const db = openDb(dbPath);
  const since = args.days > 0 ? Date.now() - args.days * 24 * 3600 * 1000 : 0;

  if (!hasTable(db, 'request_snapshots')) {
    console.error('[report] 库里没有 request_snapshots（版本过旧或未开启快照）。');
    process.exit(2);
  }

  const where = since ? 'WHERE created_at >= ?' : '';
  const bind = since ? [since] : [];
  const rows = db
    .prepare(
      `SELECT model,
              COUNT(*) n,
              SUM(CASE WHEN token_budget > 0 AND est_tokens > token_budget THEN 1 ELSE 0 END) over_budget,
              SUM(CASE WHEN token_budget > 0 AND est_tokens > token_budget * 0.8 THEN 1 ELSE 0 END) over80,
              AVG(CASE WHEN token_budget > 0 THEN 1.0*est_tokens/token_budget END) avg_ratio,
              MAX(CASE WHEN token_budget > 0 THEN 1.0*est_tokens/token_budget END) max_ratio
         FROM request_snapshots ${where}
        GROUP BY model
        ORDER BY n DESC`
    )
    .all(...bind);

  const runStats = hasTable(db, 'agent_runs')
    ? db
        .prepare(
          `SELECT status, COUNT(*) n FROM agent_runs ${since ? 'WHERE created_at >= ?' : ''} GROUP BY status`
        )
        .all(...bind)
    : [];
  const runTotal = runStats.reduce((acc, r) => acc + Number(r.n), 0);
  const runBad = runStats
    .filter((r) => !['completed', 'done', 'success', 'pending_apply', 'running'].includes(String(r.status)))
    .reduce((acc, r) => acc + Number(r.n), 0);

  const total = rows.reduce((acc, r) => acc + Number(r.n), 0);
  const overBudget = rows.reduce((acc, r) => acc + Number(r.over_budget || 0), 0);
  const over80 = rows.reduce((acc, r) => acc + Number(r.over80 || 0), 0);
  const over80Share = total ? over80 / total : 0;
  const failedShare = runTotal ? runBad / runTotal : 0;

  const verdict = [];
  if (!total) {
    verdict.push('没有快照数据：先跑几个真实会话再来量。');
  } else if (overBudget > 0) {
    verdict.push(
      `有 ${overBudget}/${total} 次请求顶穿预算 —— Auto 会挑到窗口不够的模型，值得加「route → 近期失败」账本。`
    );
  } else if (over80Share > OVER80_SHARE_LIMIT) {
    verdict.push(
      `${pct(over80Share)} 的请求吃掉 >80% 预算（超阈值 ${pct(OVER80_SHARE_LIMIT)}）—— 选型吃紧，先看是不是 Auto 总挑小窗口模型。`
    );
  } else {
    verdict.push(
      `0 次顶穿预算，>80% 预算的请求仅 ${pct(over80Share)}（阈值 ${pct(OVER80_SHARE_LIMIT)}）—— 现有证据不支持给 Auto 加账本。`
    );
  }
  if (runTotal && failedShare > FAILED_SHARE_LIMIT) {
    verdict.push(
      `run 失败/中断率 ${pct(failedShare)}（${runBad}/${runTotal}）高于阈值 ${pct(FAILED_SHARE_LIMIT)}，但当前**无法按模型归因**（见下方缺口）。`
    );
  }

  const payload = {
    db: dbPath,
    windowDays: args.days || null,
    requests: total,
    models: rows.map((r) => ({
      model: r.model,
      requests: Number(r.n),
      overBudget: Number(r.over_budget || 0),
      over80pct: Number(r.n) ? Number(r.over80 || 0) / Number(r.n) : 0,
      avgBudgetRatio: Number(r.avg_ratio) || 0,
      maxBudgetRatio: Number(r.max_ratio) || 0
    })),
    runs: { total: runTotal, bad: runBad, byStatus: runStats },
    verdict
  };

  if (args.json) {
    console.log(JSON.stringify(payload, null, 2));
    db.close();
    return;
  }

  console.log('Auto 选型错配率（只读，来自既有 request_snapshots / agent_runs）');
  console.log(`库：${dbPath}`);
  console.log(`窗口：${args.days ? `最近 ${args.days} 天` : '全部'} · 请求 ${total} 条 · run ${runTotal} 个`);
  console.log('');
  console.log('模型                                请求   超预算  >80%预算  平均占用  最高占用');
  for (const r of payload.models) {
    const name = String(r.model || '(null)').padEnd(34, ' ');
    console.log(
      `${name}${String(r.requests).padStart(6)}${String(r.overBudget).padStart(9)}` +
        `${pct(r.over80pct).padStart(10)}${pct(r.avgBudgetRatio).padStart(10)}${pct(r.maxBudgetRatio).padStart(10)}`
    );
  }
  if (runTotal) {
    console.log('');
    console.log(
      `run 状态：${runStats.map((r) => `${r.status}=${r.n}`).join(' · ')}（异常 ${runBad}，${pct(failedShare)}）`
    );
  }
  console.log('');
  console.log('归因缺口（要补才谈得上「按模型算失败率」）：');
  console.log('  · request_snapshots 没有 route 列 → 分不出这一次是 Auto 还是手选；');
  console.log('  · 快照的 run_id 与 agent_runs.id 不对齐 → 请求与 run 结果接不上；');
  console.log('  · messages 表无错误标记 → “不支持识图 / 401 / 429”这类失败没有可查字段。');
  console.log('  在补齐之前，本报表只能证明「有没有顶穿预算」，不能证明「哪次失败是 Auto 选错」。');
  console.log('');
  console.log('判定：');
  for (const line of verdict) console.log(`  - ${line}`);

  db.close();
}

main();
