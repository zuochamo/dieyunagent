'use strict';

/**
 * Smoke: src/default-workspace-gc.js
 *
 * 覆盖：预算换算；纯规则（到期回收 / 宽限期 / 受保护名 / 工程标记 / 容量上限补刀 /
 * 受保护条目顶住上限时如实报 overBudget）；真盘端到端（旧垃圾被删、工程目录与新鲜文件
 * 留着、dryRun 一个字节不动）；失败静默（目标目录不存在时不炸）。
 *
 * 这个策略会真的删文件，所以「不该删的绝不删」这几条是主要断言方向。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  resolveGcLimits,
  planReclaim,
  pruneDefaultWorkspace,
  scheduleDefaultWorkspaceGc
} = require('../src/default-workspace-gc');

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assert failed');
}

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1000 * DAY; // 任意固定基准，避免依赖真实时钟

function entry(name, { bytes = 0, ageDays = 0, protectedByName = false, protectedByMarker = false }) {
  return {
    name,
    full: `/tmp/ws/${name}`,
    kind: 'file',
    bytes,
    lastActivityMs: NOW - ageDays * DAY,
    protectedByName,
    protectedByMarker
  };
}

function testResolveLimits() {
  const d = resolveGcLimits({});
  assert(d.retentionMs === 30 * DAY, '默认保留 30 天');
  assert(d.maxBytes === 1024 * 1024 * 1024, '默认上限 1 GB');
  assert(d.graceMs === 24 * 60 * 60 * 1000, '默认宽限 24 小时');
  assert(d.maxEntries > 0, '单趟条目预算有值');
  const c = resolveGcLimits({ defaultWorkspaceRetentionDays: 7, defaultWorkspaceMaxMb: 50 });
  assert(c.retentionMs === 7 * DAY && c.maxBytes === 50 * 1024 * 1024, '覆盖值生效');
  const bad = resolveGcLimits({ defaultWorkspaceRetentionDays: -3, defaultWorkspaceMaxMb: 'x' });
  assert(bad.retentionMs === 30 * DAY && bad.maxBytes === 1024 * 1024 * 1024, '非法值回落默认');
}

function testPlanRules() {
  const cfg = { retentionMs: 30 * DAY, graceMs: DAY, maxBytes: 1000 };

  // 1) 到期垃圾回收；宽限期内不动；受保护的不动
  const plan = planReclaim(
    [
      entry('old-probe.py', { bytes: 10, ageDays: 40 }),
      entry('fresh.py', { bytes: 10, ageDays: 0 }),
      entry('yesterday.py', { bytes: 10, ageDays: 0.5 }),
      entry('.dieyun', { bytes: 10, ageDays: 400, protectedByName: true }),
      entry('README.md', { bytes: 10, ageDays: 400, protectedByName: true }),
      entry('my-repo', { bytes: 10, ageDays: 400, protectedByMarker: true })
    ],
    cfg,
    NOW
  );
  assert(plan.reclaim.length === 1, '只回收到期的那一条');
  assert(plan.reclaim[0].name === 'old-probe.py', '回收的是到期垃圾');
  assert(plan.keptFresh.includes('fresh.py') && plan.keptFresh.includes('yesterday.py'), '新鲜条目进 keptFresh');
  assert(plan.keptProtected.includes('.dieyun'), '.dieyun 受保护');
  assert(plan.keptProtected.includes('my-repo'), '工程标记受保护');
  assert(plan.overBudget === false, '未超上限');

  // 2) 超容量：最旧优先补刀，删到达标为止
  const budget = planReclaim(
    [
      entry('a-old', { bytes: 400, ageDays: 20 }),
      entry('b-mid', { bytes: 400, ageDays: 10 }),
      entry('c-new', { bytes: 400, ageDays: 2 }),
      entry('d-newest', { bytes: 400, ageDays: 1.5 })
    ],
    { retentionMs: 30 * DAY, graceMs: DAY, maxBytes: 500 },
    NOW
  );
  assert(budget.reclaim.length === 3, '超上限时按最旧优先删到只剩一条');
  assert(
    budget.reclaim.map((e) => e.name).join(',') === 'a-old,b-mid,c-new',
    '最旧优先且顺序稳定'
  );
  assert(budget.keptBytes === 400 && budget.overBudget === false, '补刀后达标');

  // 3) 受保护条目顶住上限：不删，但如实报 overBudget
  const stuck = planReclaim(
    [entry('big-repo', { bytes: 900, ageDays: 400, protectedByMarker: true }), entry('junk', { bytes: 300, ageDays: 40 })],
    { retentionMs: 30 * DAY, graceMs: DAY, maxBytes: 500 },
    NOW
  );
  assert(stuck.reclaim.length === 1 && stuck.reclaim[0].name === 'junk', '能删的先删');
  assert(stuck.overBudget === true, '剩下受保护条目时如实报超限');

  // 4) retention 关闭（0）时只剩容量规则
  const noAge = planReclaim([entry('old', { bytes: 900, ageDays: 400 })], {
    retentionMs: 0,
    graceMs: DAY,
    maxBytes: 500
  }, NOW);
  assert(noAge.reclaim.length === 1, 'retention=0 时仍按容量上限回收');
}

/** 把整棵树（含目录自身 mtime）回拨到 ageDays 天前 —— 目录 mtime 必须最后改 */
function ageTree(target, ageDays) {
  const when = new Date(Date.now() - ageDays * DAY);
  const dirs = [];
  const walk = (p) => {
    const st = fs.statSync(p);
    if (st.isDirectory()) {
      for (const name of fs.readdirSync(p)) walk(path.join(p, name));
      dirs.push(p);
      return;
    }
    fs.utimesSync(p, when, when);
  };
  walk(target);
  for (const d of dirs) fs.utimesSync(d, when, when);
}

async function testEndToEnd() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dieyun-ws-gc-'));
  try {
    // 旧垃圾：单文件 + 目录
    fs.writeFileSync(path.join(root, 'probe_old.py'), 'print(1)\n');
    fs.mkdirSync(path.join(root, 'tmp-scratch'));
    fs.writeFileSync(path.join(root, 'tmp-scratch', 'out.txt'), 'x'.repeat(2048));
    ageTree(root, 60);

    // 工程目录：有 .git（必须留下，即使很旧、很大）
    fs.mkdirSync(path.join(root, 'my-repo', '.git'), { recursive: true });
    fs.writeFileSync(path.join(root, 'my-repo', 'main.py'), 'y'.repeat(4096));
    ageTree(path.join(root, 'my-repo'), 200);

    // 新鲜文件（宽限期内）
    fs.writeFileSync(path.join(root, 'fresh.md'), 'fresh\n');

    const limits = { defaultWorkspaceRetentionDays: 30, defaultWorkspaceMaxMb: 50, defaultWorkspaceGraceHours: 24 };

    // dryRun 一个字节都不能动
    const dry = await pruneDefaultWorkspace({ root, limits, dryRun: true });
    assert(fs.existsSync(path.join(root, 'probe_old.py')), 'dryRun 不删文件');
    assert(dry.wouldDelete.includes('probe_old.py') && dry.wouldDelete.includes('tmp-scratch'), 'dryRun 报出待删清单');
    assert(!dry.wouldDelete.includes('my-repo'), 'dryRun 不动工程目录');

    const res = await pruneDefaultWorkspace({ root, limits });
    assert(!fs.existsSync(path.join(root, 'probe_old.py')), '到期文件被删');
    assert(!fs.existsSync(path.join(root, 'tmp-scratch')), '到期目录被删');
    assert(fs.existsSync(path.join(root, 'my-repo', 'main.py')), '工程目录保留');
    assert(fs.existsSync(path.join(root, 'fresh.md')), '新鲜文件保留');
    assert(res.deleted === 2, `删了 2 项（实际 ${res.deleted}）`);
    assert(res.overBudget === false, '未超上限');

    // 目录不存在：静默返回，不抛
    const missing = await pruneDefaultWorkspace({ root: path.join(root, 'nope'), limits });
    assert(missing.checked === 0, '目录不存在时静默');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function testScheduleSmoke() {
  // 装配入口：立刻跑一趟并把 timer unref 掉，stop 可关
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dieyun-ws-gc-sched-'));
  try {
    const lines = [];
    const handle = scheduleDefaultWorkspaceGc({
      root,
      limits: { defaultWorkspaceRetentionDays: 30 },
      log: { info: (m) => lines.push(m), warn: () => {} }
    });
    assert(handle && typeof handle.stop === 'function', '返回 stop');
    handle.stop();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function main() {
  testResolveLimits();
  testPlanRules();
  await testEndToEnd();
  await testScheduleSmoke();
  console.log('[dieyun:test] default-workspace-gc OK');
}

main().catch((err) => {
  console.error('[dieyun:test] default-workspace-gc FAILED:', (err && err.message) || err);
  process.exit(1);
});
