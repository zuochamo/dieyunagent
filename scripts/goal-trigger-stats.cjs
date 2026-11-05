'use strict';

// @ts-check
/**
 * 会话目标「触发率」统计（只读，不写任何文件）。
 *
 * 为什么需要它：`docs/SESSION-GOAL-PLAN.md` §14 定了复测口径 —— 目标体系「能不能用」与
 * 「模型愿不愿意用」是两件事，后者只能靠数数，不能靠手感。这个脚本就是那四个数的唯一算法：
 *
 *   1. 触发率  = 多步会话（写/执行类调用 ≥ 3）中出现过 `goal_*` 的占比
 *   2. 误开率  = 单元会话（工具调用 ≤ 1）中出现过 `goal_start` 的占比 —— **不应上升**
 *   3. 收尾质量 = `goal_finish(complete)` 被 `judgeGoalFinish` 打回的次数 / 总申请次数
 *   4. 烧毁率  = `session_goals` 里 `status=stalled` 占比
 *
 * 数据源（都是既有的东西，不新增埋点）：
 *   - `tool-telemetry.jsonl`（+ 轮转的 `.1`）：每次工具调用的 name / ok / errorCode / sessionId
 *   - `diecloud-memory.sqlite` 的 `session_goals` 表：目标对象、状态、事实、收尾主张
 *   - `plans.json` 里 `trigger=goal` 的计划目标：同一套收尾主张（计划侧）
 *
 * 口径边界（别误读）：
 *   - 遥测没有工具入参，所以「多步会话」只能用写/执行类调用次数当代理，不是「跑了多少轮」。
 *   - 打回（`accepted:false`）在遥测里表现为 `ok:true`（打回是正常业务结果），只能从
 *     目标对象的 `claims[].accepted` 数出来。
 *
 * 用法：
 *   node scripts/goal-trigger-stats.cjs [--since YYYY-MM-DD] [--json] [--verbose]
 */

const fs = require('fs');
const path = require('path');
const { resolveUserDataDir } = require('../src/app-paths');

/** 「写/执行」类工具：判断一个会话是否在做多步工作时用它们当代理（不含只读工具） */
const WRITE_EXEC_TOOLS = new Set([
  'fs_edit',
  'fs_write',
  'fs_edit_many',
  'host_exec',
  'worktree_apply_run'
]);

const GOAL_TOOLS = new Set(['goal_start', 'goal_update', 'goal_check', 'goal_finish']);

function parseArgs(argv) {
  const out = { since: '', json: false, verbose: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--json') out.json = true;
    else if (a === '--verbose' || a === '-v') out.verbose = true;
    else if (a === '--since') out.since = String(argv[(i += 1)] || '');
    else if (a.startsWith('--since=')) out.since = a.slice('--since='.length);
  }
  return out;
}

function readTelemetry(userData) {
  // 轮转文件在前：`.1` 更旧，两段的 ts 混排由下面统一排序
  const files = ['tool-telemetry.jsonl.1', 'tool-telemetry.jsonl'].map((f) => path.join(userData, f));
  const rows = [];
  const found = [];
  for (const f of files) {
    if (!fs.existsSync(f)) continue;
    found.push(f);
    for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line);
        if (r && typeof r.ts === 'number') rows.push(r);
      } catch {
        // 半行（进程被杀时可能出现）——跳过，统计不该因为一行坏 JSON 失败
      }
    }
  }
  rows.sort((a, b) => a.ts - b.ts);
  return { rows, files: found };
}

function loadSessionGoals(userData) {
  const dbPath = path.join(userData, 'diecloud-memory.sqlite');
  if (!fs.existsSync(dbPath)) return { rows: [], dbPath, error: '数据库不存在' };
  let db;
  try {
    const { DatabaseSync } = require('node:sqlite');
    db = new DatabaseSync(dbPath, { readOnly: true });
    const rows = db.prepare('SELECT session_id, goal_json FROM session_goals').all();
    return { rows, dbPath, error: '' };
  } catch (e) {
    return { rows: [], dbPath, error: (e && e.message) || String(e) };
  } finally {
    try {
      if (db) db.close();
    } catch {
      /* ignore */
    }
  }
}

function loadPlanGoals(userData) {
  const p = path.join(userData, 'plans.json');
  if (!fs.existsSync(p)) return [];
  try {
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    const arr = Array.isArray(j) ? j : j && Array.isArray(j.plans) ? j.plans : Object.values(j || {});
    return arr.filter((x) => x && x.goal && String(x.trigger || '') === 'goal');
  } catch {
    return [];
  }
}

const pct = (n, d) => (d ? `${((n / d) * 100).toFixed(1)}%` : '—');
const day = (ts) => new Date(ts).toISOString().slice(0, 10);

function main() {
  const args = parseArgs(process.argv.slice(2));
  const userData = resolveUserDataDir();
  const { rows: allRows, files } = readTelemetry(userData);
  const sinceMs = args.since ? Date.parse(`${args.since}T00:00:00Z`) : NaN;
  if (args.since && !Number.isFinite(sinceMs)) {
    console.error(`--since 不是合法日期（要 YYYY-MM-DD）：${args.since} —— 按全窗口统计`);
  }
  const rows = Number.isFinite(sinceMs) ? allRows.filter((r) => r.ts >= sinceMs) : allRows;

  if (!rows.length) {
    console.log(`没有遥测数据：${files.join(', ') || path.join(userData, 'tool-telemetry.jsonl')} 不存在或为空`);
    process.exitCode = 1;
    return;
  }

  // —— 1/2：会话级触发面 ——
  const sessions = new Map();
  const toolStats = new Map();
  for (const r of rows) {
    const name = String(r.tool || '');
    const key = `${name} | ${r.ok ? 'ok' : r.errorCode || 'ERR'}`;
    toolStats.set(key, (toolStats.get(key) || 0) + 1);
    const sid = String(r.sessionId || '(none)');
    const s = sessions.get(sid) || { sid, tools: 0, writeExec: 0, goalTools: 0, goalStart: 0 };
    s.tools += 1;
    if (WRITE_EXEC_TOOLS.has(name)) s.writeExec += 1;
    if (GOAL_TOOLS.has(name)) s.goalTools += 1;
    if (name === 'goal_start') s.goalStart += 1;
    sessions.set(sid, s);
  }
  const list = [...sessions.values()];
  const multiStep = list.filter((s) => s.writeExec >= 3);
  const multiStepWithGoal = multiStep.filter((s) => s.goalTools > 0);
  const tiny = list.filter((s) => s.tools <= 1);
  const tinyWithGoalStart = tiny.filter((s) => s.goalStart > 0);

  // —— 3/4：目标对象侧（会话 + 计划） ——
  const sessionGoals = loadSessionGoals(userData);
  const goalRows = [];
  for (const r of sessionGoals.rows) {
    let g = null;
    try {
      g = JSON.parse(r.goal_json);
    } catch {
      g = null;
    }
    if (g) goalRows.push({ sid: r.session_id, g });
  }
  const claims = [];
  let stalled = 0;
  let unverified = 0;
  for (const { g } of goalRows) {
    if (String(g.status || '') === 'stalled') stalled += 1;
    const checks = g.goal && Array.isArray(g.goal.checks) ? g.goal.checks : [];
    if (!checks.length) unverified += 1;
    for (const c of Array.isArray(g.claims) ? g.claims : []) claims.push(c);
  }
  const planGoals = loadPlanGoals(userData);
  const planClaims = [];
  for (const p of planGoals) {
    for (const c of Array.isArray(p.claims) ? p.claims : []) planClaims.push(c);
  }
  const rejected = claims.filter((c) => c && c.accepted === false).length;
  const planRejected = planClaims.filter((c) => c && c.accepted === false).length;

  const report = {
    window: { from: day(rows[0].ts), to: day(rows[rows.length - 1].ts), days: new Set(rows.map((r) => day(r.ts))).size },
    userData,
    telemetryFiles: files,
    toolCalls: rows.length,
    trigger: {
      multiStepSessions: multiStep.length,
      multiStepSessionsWithGoal: multiStepWithGoal.length,
      triggerRate: pct(multiStepWithGoal.length, multiStep.length)
    },
    falseTrigger: {
      tinySessions: tiny.length,
      tinySessionsWithGoalStart: tinyWithGoalStart.length,
      falseTriggerRate: pct(tinyWithGoalStart.length, tiny.length)
    },
    goalToolCalls: [...toolStats.entries()]
      .filter(([k]) => GOAL_TOOLS.has(k.split(' | ')[0]))
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => ({ call: k, n: v })),
    sessionGoals: {
      total: goalRows.length,
      stalled,
      stalledRate: pct(stalled, goalRows.length),
      unverified,
      dbError: sessionGoals.error
    },
    finishQuality: {
      sessionClaims: claims.length,
      sessionRejected: rejected,
      planGoalPlans: planGoals.length,
      planClaims: planClaims.length,
      planRejected
    },
    detail: {
      multiStepWithGoal: multiStepWithGoal.map((s) => ({ sessionId: s.sid, tools: s.tools, writeExec: s.writeExec, goalTools: s.goalTools })),
      tinyWithGoalStart: tinyWithGoalStart.map((s) => ({ sessionId: s.sid, tools: s.tools, goalStart: s.goalStart }))
    }
  };

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  const L = [];
  L.push(`【会话目标触发率】${report.window.from} → ${report.window.to}（有数据的 ${report.window.days} 天）`);
  L.push(`数据源：${files.map((f) => path.basename(f)).join(' + ')}、session_goals${planGoals.length ? '、plans.json' : ''}`);
  L.push(`工具调用总数：${report.toolCalls}`);
  L.push('');
  L.push('—— 触发面 ——');
  L.push(`多步会话（写/执行类调用 ≥3）：${multiStep.length}`);
  L.push(`  其中出现过 goal_*：${multiStepWithGoal.length}    触发率 ${report.trigger.triggerRate}`);
  L.push(`单元会话（工具调用 ≤1）：${tiny.length}`);
  L.push(`  其中出现过 goal_start：${tinyWithGoalStart.length}    误开率 ${report.falseTrigger.falseTriggerRate}（不应上升）`);
  L.push('');
  L.push('—— 目标工具调用（ok / errorCode） ——');
  if (!report.goalToolCalls.length) L.push('  （窗口内没有任何 goal_* 调用）');
  for (const t of report.goalToolCalls) L.push(`  ${t.call}  ×${t.n}`);
  L.push('');
  L.push('—— 目标对象（会话侧） ——');
  if (sessionGoals.error) L.push(`  读不到 session_goals：${sessionGoals.error}`);
  L.push(`目标 ${goalRows.length} 条；stalled ${stalled}（${report.sessionGoals.stalledRate}）；无声明检查（未验证）${unverified}`);
  for (const { sid, g } of goalRows) {
    const checks = (g.goal && g.goal.checks) || [];
    L.push(
      `  ${sid}  status=${g.status || '?'} outcome=${g.outcome || '-'} attempt=${g.attempt || 0}` +
        ` checks=${checks.length} todos=${((g.goal && g.goal.todos) || []).length} facts=${(g.evidence || []).length}` +
        ` claims=${(g.claims || []).length}`
    );
  }
  L.push('');
  L.push('—— 收尾质量（打回率） ——');
  L.push(`会话目标：申请 ${claims.length} 次，被打回 ${rejected} 次`);
  L.push(`计划目标：${planGoals.length} 条计划，申请 ${planClaims.length} 次，被打回 ${planRejected} 次`);
  if (args.verbose && multiStepWithGoal.length) {
    L.push('');
    L.push('—— 明细：触发过的多步会话 ——');
    for (const s of report.detail.multiStepWithGoal) {
      L.push(`  ${s.sessionId}  工具 ${s.tools} / 写执行 ${s.writeExec} / goal_* ${s.goalTools}`);
    }
  }
  console.log(L.join('\n'));
}

main();
