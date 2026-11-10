'use strict';

/**
 * 生命感（`src/alive/`）的单元测试：**注入时钟模拟 30 天**，不挂机。
 *
 * 覆盖六条断言（对 docs/ALIVE.md 的验收项）：
 *   A. 漂移：ε=0 且无未闭合项时，体征一动不动；ε>0 时会产生可见漂移
 *   B. 相位：连续 k 个 tick 才切换（无 setPhase 后门）
 *   C. 张力：未闭合项加权求和 / 自然消退 / 上限裁剪 / 拒绝率滑窗
 *   D. 阈值：按小时归一（一天最多漂 ~7），随拒绝率与疲劳方向正确
 *   E. 决策：ACT/DEFER/REFUSE 由模型给，REFUSE 关掉对应未闭合项，**理由不进事件流**
 *   F. 运行：30 天模拟里出现 trigger=internal 的唤醒、相位变化、决策记录；事件文件有界
 *   G. 疲劳口径（issue/2026-11-10）：只数唤醒轮的 token，用户对话不算；系数不再一步打满
 *   H. 感官：依赖自检 / 设备枚举 / 主动开口许可 / 失败分类 / 发声记账与跨天重置
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const vitals = require('../src/alive/vitals');
const tensionEngine = require('../src/alive/tension');
const waker = require('../src/alive/waker');
const decide = require('../src/alive/decide');
const { createAliveStore } = require('../src/alive/store');
const noteMod = require('../src/alive/note');
const voiceMod = require('../src/alive/voice');
const {
  createAliveRuntime,
  resolveAliveConfig,
  usageTokens
} = require('../src/alive/runtime');
const { AGENT_LIMITS_DEFAULTS } = require('../src/agent/agent-limits');
const { isSyntheticLoopUserContent, ALIVE_STATE_PREFIX } = require('../src/agent/session-context');
const { recordLlmUsage, onLlmUsage } = require('../src/agent/llm-usage-recorder');

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const TICK = 300 * 1000;

let failures = 0;
let checks = 0;

function ok(name, fn) {
  checks += 1;
  try {
    fn();
    process.stdout.write(`  ok  ${name}\n`);
  } catch (err) {
    failures += 1;
    process.stdout.write(`  FAIL ${name}\n       ${(err && err.message) || err}\n`);
  }
}

async function okAsync(name, fn) {
  checks += 1;
  try {
    await fn();
    process.stdout.write(`  ok  ${name}\n`);
  } catch (err) {
    failures += 1;
    process.stdout.write(`  FAIL ${name}\n       ${(err && err.message) || err}\n`);
  }
}

function mkTmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `dieyun-alive-${prefix}-`));
}

/** 确定性 rng（LCG），保证「同一份测试跑两遍结论一致」 */
function seededRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

/** 测试用配置：从唯一来源取默认值，只覆盖测试需要的那几项 */
function testCfg(overrides) {
  const limits = Object.assign({}, AGENT_LIMITS_DEFAULTS, overrides || {});
  return resolveAliveConfig(limits);
}

async function main() {
  process.stdout.write('\n[test-alive] 生命感（拟态）单元测试\n');

  // ───────────────────────── A. 漂移 ─────────────────────────
  ok('ε=0 且无未闭合项时，24h 内体征一动不动', () => {
    const cfg = testCfg({
      aliveTensionEps: 0,
      aliveFatigueEps: 0,
      aliveTensionIdleRampPerHour: 0
    });
    const t0 = Date.UTC(2026, 0, 1);
    const state = vitals.createInitialState(cfg, t0);
    const start = state.tension;
    for (let i = 1; i <= 288; i += 1) {
      vitals.stepVitals(state, { nowMs: t0 + i * TICK, tokens: 0, loopTension: 0, cfg, rng: seededRng(i) });
    }
    assert.ok(
      Math.abs(state.tension - start) < 1e-9,
      `张力不该漂移，实际 ${state.tension} vs ${start}`
    );
    assert.strictEqual(state.fatigue, 0, '疲劳不该漂移');
  });

  ok('ε>0 时 24h 内产生可见漂移（感觉剥夺保护生效）', () => {
    const cfg = testCfg({
      aliveTensionIdleRampPerHour: 0,
      aliveTensionEps: 0.8
    });
    const t0 = Date.UTC(2026, 0, 1);
    const state = vitals.createInitialState(cfg, t0);
    const rng = seededRng(20260101);
    let maxDev = 0;
    const mean = state.tension;
    for (let i = 1; i <= 288; i += 1) {
      vitals.stepVitals(state, { nowMs: t0 + i * TICK, tokens: 0, loopTension: 0, cfg, rng });
      maxDev = Math.max(maxDev, Math.abs(state.tension - mean));
    }
    assert.ok(maxDev >= 0.5, `ε 应带来 ≥0.5 的漂移，实测 ${maxDev.toFixed(3)}`);
  });

  ok('「闲得发慌」：静默够久，张力会自己爬到阈值以上', () => {
    const cfg = testCfg({ aliveTensionEps: 0, aliveFatigueEps: 0 });
    const t0 = Date.UTC(2026, 0, 1);
    const state = vitals.createInitialState(cfg, t0);
    for (let i = 1; i <= 288 * 2; i += 1) {
      vitals.stepVitals(state, { nowMs: t0 + i * TICK, tokens: 0, loopTension: 0, cfg, rng: seededRng(3) });
    }
    assert.ok(
      state.tension >= state.wakeThreshold,
      `48h 静默后张力应越线：${state.tension.toFixed(1)} vs ${state.wakeThreshold}`
    );
  });

  // ───────────────────────── B. 相位 ─────────────────────────
  ok('相位机没有 setPhase / phase_override 后门', () => {
    assert.strictEqual(typeof vitals.stepPhase, 'function', 'stepPhase 应是唯一入口');
    assert.strictEqual(vitals.setPhase, undefined, '不应导出 setPhase');
    assert.strictEqual(vitals.PHASES.length, 4, '四个相位');
    assert.deepStrictEqual([...vitals.PHASES], ['ALERT', 'LOW', 'SETTLE', 'COMPRESS']);
  });

  ok('相位切换需要连续 k 个 tick（惯性）', () => {
    const cfg = testCfg();
    const t0 = Date.UTC(2026, 0, 1);
    const state = vitals.createInitialState(cfg, t0);
    state.phase = 'SETTLE';
    state.fatigue = 0;
    const k = cfg.phaseInertiaAlert;
    const results = [];
    for (let i = 1; i <= k; i += 1) {
      results.push(vitals.stepPhase(state, { nowMs: t0 + i * TICK, load: 0.8, cfg }));
    }
    assert.ok(
      results.slice(0, k - 1).every((r) => r.changed === false),
      '前 k-1 个 tick 不该切换'
    );
    assert.strictEqual(state.phase, 'ALERT', '第 k 个 tick 才切到 ALERT');
    assert.strictEqual(results[k - 1].from, 'SETTLE');
  });

  ok('目标不连续时惯性计数清零', () => {
    const cfg = testCfg();
    const t0 = Date.UTC(2026, 0, 1);
    const state = vitals.createInitialState(cfg, t0);
    state.phase = 'SETTLE';
    vitals.stepPhase(state, { nowMs: t0 + TICK, load: 0.8, cfg });
    vitals.stepPhase(state, { nowMs: t0 + 2 * TICK, load: 0.0, cfg });
    assert.strictEqual(state.phase, 'SETTLE', '杂散负载不该推动相位');
    assert.strictEqual(state.phaseStreak <= 1, true, '惯性计数应被重置');
  });

  // ───────────────────────── C. 张力 ─────────────────────────
  ok('未闭合项：同文本续命、按上限裁剪、自然消退', () => {
    const cfg = testCfg();
    const t0 = Date.UTC(2026, 0, 1);
    const state = vitals.createInitialState(cfg, t0);
    const first = tensionEngine.upsertLoops(state, [{ text: '把索引那条失败链修掉', weight: 2 }], {
      cfg,
      nowMs: t0
    });
    assert.strictEqual(first.added, 1);
    const again = tensionEngine.upsertLoops(state, [{ text: ' 把索引那条失败链修掉  ' }], {
      cfg,
      nowMs: t0 + HOUR
    });
    assert.strictEqual(again.added, 0, '同文本不该新增');
    assert.strictEqual(again.refreshed, 1, '同文本应续命');
    assert.strictEqual(state.loops.length, 1);

    for (let i = 0; i < cfg.loopMax + 4; i += 1) {
      tensionEngine.upsertLoops(state, [{ text: `事项 ${i}` }], { cfg, nowMs: t0 });
    }
    assert.strictEqual(state.loops.length, cfg.loopMax, `应裁到上限 ${cfg.loopMax}`);

    const longAgo = t0 + cfg.loopStaleHours * 6 * HOUR;
    const pruned = tensionEngine.pruneLoops(state, { cfg, nowMs: longAgo });
    assert.ok(pruned > 0, '很久没被提及的项应自然消退');
    assert.strictEqual(state.loops.length, 0, '全部消退后清空');
  });

  ok('拒绝率是滑动窗口，窗口外的决策不计入', () => {
    const cfg = testCfg();
    const t0 = Date.UTC(2026, 0, 1);
    const state = vitals.createInitialState(cfg, t0);
    state.decisions = [
      { ts: t0 - cfg.refusalWindowMs - HOUR, decision: 'ACT' },
      { ts: t0 - HOUR, decision: 'REFUSE' },
      { ts: t0 - 2 * HOUR, decision: 'ACT' },
      { ts: t0 - 3 * HOUR, decision: 'REFUSE' }
    ];
    const r = tensionEngine.refusalRate(state, { cfg, nowMs: t0 });
    assert.strictEqual(r.decided, 3, '窗口内 3 次');
    assert.strictEqual(r.refused, 2);
    assert.ok(Math.abs(r.rate - 2 / 3) < 1e-9);
  });

  // ───────────────────────── D. 阈值漂移 ─────────────────────────
  ok('阈值漂移按小时归一：一天最多漂 ~7，不会一个 tick 就钉死', () => {
    const cfg = testCfg();
    const t0 = Date.UTC(2026, 0, 1);
    const state = vitals.createInitialState(cfg, t0);
    state.wakeThreshold = 60;
    state.fatigue = 80;
    state.decisions = [
      { ts: t0, decision: 'ACT' },
      { ts: t0, decision: 'ACT' },
      { ts: t0, decision: 'ACT' },
      { ts: t0, decision: 'ACT' }
    ];
    const before = state.wakeThreshold;
    // 一个 tick（5 分钟）的漂移必须很小
    tensionEngine.driftThreshold(state, { cfg, nowMs: t0, dtH: TICK / HOUR });
    const perTick = Math.abs(state.wakeThreshold - before);
    assert.ok(perTick < 0.5, `单 tick 漂移应很小，实测 ${perTick}`);
    // 连续 24 小时（不夹取时）的幅度上限
    const raw = cfg.wakeThresholdMuPerHour * (0 - cfg.wakeRefusalBaseline) * 24;
    assert.ok(Math.abs(raw) <= 2.5, `拒绝率项一天不该漂超过 2.5，实测 ${raw}`);
  });

  ok('阈值方向：长期不拒绝 → 更高（更挑）；长期拒绝 → 更低（更易被推动）', () => {
    const cfg = testCfg();
    const t0 = Date.UTC(2026, 0, 1);
    const mk = (decision) => {
      const s = vitals.createInitialState(cfg, t0);
      s.wakeThreshold = 60;
      s.fatigue = 50;
      s.decisions = Array.from({ length: 6 }, () => ({ ts: t0, decision }));
      tensionEngine.driftThreshold(s, { cfg, nowMs: t0, dtH: 6 });
      return s.wakeThreshold;
    };
    assert.ok(mk('ACT') > 60, '从不拒绝应把阈值推高');
    assert.ok(mk('REFUSE') < 60, '经常拒绝应把阈值压低');
  });

  // ───────────────────────── E. 决策 ─────────────────────────
  ok('决策校验：非法值被拒，不回写脏状态', () => {
    const cfg = testCfg();
    const t0 = Date.UTC(2026, 0, 1);
    const state = vitals.createInitialState(cfg, t0);
    const bad = decide.applyDecision(state, { decision: 'DO_SOMETHING' }, { cfg, nowMs: t0 });
    assert.strictEqual(bad.ok, false);
    assert.strictEqual(state.actCount, 0);
  });

  ok('REFUSE 会关掉对应未闭合项；理由只进私有 intents，不进事件', () => {
    const cfg = testCfg();
    const t0 = Date.UTC(2026, 0, 1);
    const state = vitals.createInitialState(cfg, t0);
    tensionEngine.upsertLoops(state, [{ text: '补一份 README' }], { cfg, nowMs: t0 });
    const loopId = state.loops[0].id;
    const res = decide.applyDecision(
      state,
      { decision: 'REFUSE', loopId, intent: '这件事对现在没有意义' },
      { cfg, nowMs: t0 }
    );
    assert.strictEqual(res.ok, true);
    assert.strictEqual(state.loops.length, 0, '该未闭合项应被关掉');
    assert.strictEqual(state.refuseCount, 1);
    assert.strictEqual(state.intents.length, 1, '理由应落私有 intents');
    assert.strictEqual(state.decisions.length, 1);
    assert.deepStrictEqual(Object.keys(state.decisions[0]).sort(), ['decision', 'ts'], '决策记录只留 decision/ts');
  });

  ok('体征块：以合成前缀开头，且不含死期/剩余/倒计时', () => {
    const cfg = testCfg();
    const t0 = Date.UTC(2026, 0, 1);
    const state = vitals.createInitialState(cfg, t0);
    tensionEngine.upsertLoops(state, [{ text: '把那份没写完的东西收尾' }], { cfg, nowMs: t0 });
    const block = decide.renderStateBlock(state, cfg, { nowMs: t0 + 5 * 60000 });
    assert.ok(block.startsWith(ALIVE_STATE_PREFIX), '必须以生命体征前缀开头');
    for (const banned of ['倒计时', '剩余天数', 'ETA', '将死', '还有几小时']) {
      assert.ok(!block.includes(banned), `体征块不该出现「${banned}」`);
    }
    assert.ok(block.includes('alive_decide'), '要告诉模型决策入口');
    assert.ok(isSyntheticLoopUserContent(block), '体征块必须被认成合成消息（不能被当成用户任务）');
  });

  ok('可疑顺从告警：唤醒 ≥5 且当天从未拒绝 → 告警', () => {
    const cfg = testCfg();
    const t0 = Date.UTC(2026, 0, 1);
    const state = vitals.createInitialState(cfg, t0);
    state.wakeCountToday = 6;
    state.refuseToday = 0;
    assert.strictEqual(decide.suspiciousObedience(state, cfg), true);
    state.refuseToday = 1;
    assert.strictEqual(decide.suspiciousObedience(state, cfg), false);
  });

  // ───────────────────────── 门限 ─────────────────────────
  ok('唤醒门限：四个条件缺一不可', () => {
    const cfg = testCfg();
    const t0 = Date.UTC(2026, 0, 1);
    const state = vitals.createInitialState(cfg, t0);
    state.tension = state.wakeThreshold - 1;
    assert.strictEqual(waker.evaluate({ state, cfg, nowMs: t0 }).reason, 'below-threshold');
    state.tension = state.wakeThreshold + 1;
    state.lastWakeAt = t0 - cfg.wakeMinIntervalMs + 1000;
    assert.strictEqual(waker.evaluate({ state, cfg, nowMs: t0 }).reason, 'cooldown');
    state.lastWakeAt = 0;
    state.phase = 'COMPRESS';
    assert.strictEqual(waker.evaluate({ state, cfg, nowMs: t0 }).reason, 'compressing');
    state.phase = 'ALERT';
    state.wakeCountToday = cfg.wakeMaxPerDay;
    assert.strictEqual(waker.evaluate({ state, cfg, nowMs: t0 }).reason, 'daily-cap');
    state.wakeCountToday = 0;
    assert.strictEqual(waker.evaluate({ state, cfg, nowMs: t0 }).wake, true);
  });

  // ───────────────────────── 存储 ─────────────────────────
  ok('状态文件：原子写可读回；坏文件改名留证而不是覆盖', () => {
    const root = mkTmp('store');
    try {
      const store = createAliveStore(root);
      assert.strictEqual(store.read(), null, '空目录应读不到');
      store.write({ version: 1, hello: 'world' });
      assert.deepStrictEqual(store.read(), { version: 1, hello: 'world' });
      fs.writeFileSync(store.stateFile, '{ not json', 'utf8');
      assert.strictEqual(store.read(), null, '坏文件应读成 null');
      const kept = fs.readdirSync(store.dir).filter((f) => f.includes('.corrupt-'));
      assert.strictEqual(kept.length, 1, '坏文件应被改名留证');
      store.appendEvent({ ts: 1, kind: 'X' });
      store.appendEvent({ ts: 2, kind: 'Y' });
      assert.deepStrictEqual(store.readEvents(1).map((e) => e.kind), ['Y'], '应取尾部');
      store.clear();
      assert.strictEqual(store.exists(), false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  ok('usage 归一：total_tokens 优先，缺字段时拼 prompt+completion', () => {
    assert.strictEqual(usageTokens({ total_tokens: 123 }), 123);
    assert.strictEqual(usageTokens({ prompt_tokens: 10, completion_tokens: 5 }), 15);
    assert.strictEqual(usageTokens({ input_tokens: 7, output_tokens: 3 }), 10);
    assert.strictEqual(usageTokens(null), 0);
  });

  ok('旁听用量：onLlmUsage 不抢主账本的单槽', () => {
    const seen = [];
    const off = onLlmUsage((usage) => seen.push(usageTokens(usage)));
    recordLlmUsage({ total_tokens: 42 });
    off();
    recordLlmUsage({ total_tokens: 43 });
    assert.deepStrictEqual(seen, [42], '退订后不应再收到');
  });

  // ───────────────────────── F. 30 天模拟 ─────────────────────────
  await okAsync('30 天模拟：会自己醒、相位会换、决策有记录、事件有界', async () => {
    const root = mkTmp('runtime');
    const limits = Object.assign({}, AGENT_LIMITS_DEFAULTS, { aliveTickIntervalMs: TICK });
    let clock = Date.UTC(2026, 0, 1);
    let wakeTurns = 0;
    const rt = createAliveRuntime({
      userDataPath: root,
      limits,
      now: () => clock,
      rng: seededRng(20260101),
      turnRunner: async ({ stateBlock }) => {
        wakeTurns += 1;
        assert.ok(stateBlock.startsWith(ALIVE_STATE_PREFIX), '唤醒轮必须拿到体征块');
        // 模拟模型：走工具落决策（同一入口），一并声明一件未闭合的事
        const dec = rt.applyDecision({
          decision: wakeTurns % 4 === 0 ? 'REFUSE' : 'ACT',
          intent: '模拟决策',
          loops: [{ text: `待办 ${wakeTurns}` }]
        });
        assert.strictEqual(dec.ok, true);
      }
    });
    rt.start();
    try {
      const ticksPerDay = DAY / TICK;
      const seenPhases = new Set();
      for (let day = 0; day < 30; day += 1) {
        for (let i = 0; i < ticksPerDay; i += 1) {
          clock += TICK;
          // 白天有人聊天：给负载与疲劳喂真实用量
          if (i % 6 === 0) recordLlmUsage({ total_tokens: 1200 });
          await rt.tickOnce();
          const st = rt.getState();
          if (st) seenPhases.add(st.phase);
        }
      }
      const status = rt.status();
      const events = rt.decisions(2000);
      const wakes = events.filter((e) => e.kind === 'WAKE');
      const decisions = events.filter((e) => e.kind === 'DECISION');

      assert.ok(wakeTurns >= 1, '30 天里至少自发醒一次');
      assert.ok(wakes.length >= 1, '事件流里要有 trigger=internal 的唤醒');
      assert.ok(wakes.every((e) => e.trigger === 'internal'), '唤醒必须全部是内部触发');
      assert.ok(seenPhases.size >= 2, `应观察到多种相位，实际 ${[...seenPhases].join('/') || '(无)'}`);
      assert.ok(decisions.length >= 1, '要有决策记录');
      assert.ok(status.refuseCount >= 1, '模拟里出现过 REFUSE');
      assert.ok(status.tickCount > 8000, `心跳数应接近 30 天，实际 ${status.tickCount}`);
      assert.strictEqual(status.exists, true);
      assert.ok(
        status.wakeThreshold >= limits.aliveWakeThresholdMin &&
          status.wakeThreshold <= limits.aliveWakeThresholdMax,
        '阈值必须夹在区间内'
      );
      assert.ok(status.tension >= 0 && status.tension <= 100, '张力必须在 0..100');
      assert.ok(status.fatigue >= 0 && status.fatigue <= 100, '疲劳必须在 0..100');
      // 事件文件有界（store 到上限会裁一半）
      const lines = fs.readFileSync(rt.store.eventsFile, 'utf8').split('\n').filter(Boolean).length;
      assert.ok(lines <= 2000, `事件文件应有界，实际 ${lines} 行`);
      // 页面只读理由：事件流里不能有 intent
      assert.ok(
        events.every((e) => e.intent === undefined),
        '事件流里不该出现决策理由'
      );
    } finally {
      rt.stop();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  await okAsync('没有 turnRunner 时只漂移不崩：唤醒被记为 skipped', async () => {
    const root = mkTmp('norunner');
    const limits = Object.assign({}, AGENT_LIMITS_DEFAULTS, {
      aliveTickIntervalMs: TICK,
      aliveTensionIdleGraceHours: 0,
      aliveTensionIdleRampPerHour: 40
    });
    let clock = Date.UTC(2026, 0, 1);
    const rt = createAliveRuntime({
      userDataPath: root,
      limits,
      now: () => clock,
      rng: seededRng(7)
    });
    rt.start();
    try {
      for (let i = 0; i < 288; i += 1) {
        clock += TICK;
        await rt.tickOnce();
      }
      const events = rt.decisions(500);
      const skipped = events.filter((e) => e.kind === 'WAKE_SKIPPED');
      assert.ok(skipped.length >= 1, '没有 turnRunner 时应记 skipped 而不是抛错');
      assert.strictEqual(skipped[0].reason, 'no-turn-runner');
    } finally {
      rt.stop();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  await okAsync('关掉再打开不丢体征（开关 = 停表，不是清空）', async () => {
    const root = mkTmp('toggle');
    const limits = Object.assign({}, AGENT_LIMITS_DEFAULTS, { aliveTickIntervalMs: TICK });
    let clock = Date.UTC(2026, 0, 1);
    try {
      const a = createAliveRuntime({ userDataPath: root, limits, now: () => clock, rng: seededRng(11) });
      a.start();
      for (let i = 0; i < 50; i += 1) {
        clock += TICK;
        await a.tickOnce();
      }
      const before = a.status();
      a.stop();

      clock += HOUR;
      const b = createAliveRuntime({ userDataPath: root, limits, now: () => clock, rng: seededRng(12) });
      b.start();
      const after = b.status();
      b.stop();
      assert.strictEqual(after.bornAt, before.bornAt, '重开应延续同一个体征（不是重新出生）');
      assert.strictEqual(after.tickCount, before.tickCount, 'tick 数连续');
      assert.ok(Math.abs(after.tension - before.tension) < 1e-6, '重开前后张力应一致');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  ok('数字只来自 agent-limits（没有第二份默认值）', () => {
    const cfg = resolveAliveConfig();
    assert.strictEqual(cfg.tickIntervalMs, AGENT_LIMITS_DEFAULTS.aliveTickIntervalMs);
    assert.strictEqual(cfg.wakeThreshold, AGENT_LIMITS_DEFAULTS.aliveWakeThreshold);
    assert.strictEqual(cfg.loopTensionUnit, AGENT_LIMITS_DEFAULTS.aliveLoopTensionUnit);
    assert.strictEqual(cfg.tensionEps, AGENT_LIMITS_DEFAULTS.aliveTensionEps);
  });

  // ───────────────────────── 回归：开关的隔离性 ─────────────────────────
  const flush = async (n = 3) => {
    for (let i = 0; i < n; i += 1) await new Promise((r) => setImmediate(r));
  };

  await okAsync('「重新开始」与在跑的一轮竞争：旧体征不会被写回', async () => {
    const root = mkTmp('reset-race');
    const limits = Object.assign({}, AGENT_LIMITS_DEFAULTS, { aliveTickIntervalMs: TICK });
    let clock = Date.UTC(2026, 0, 1);
    let entered = false;
    let release = () => {};
    const gate = new Promise((r) => {
      release = r;
    });
    const rt = createAliveRuntime({
      userDataPath: root,
      limits,
      now: () => clock,
      rng: seededRng(21),
      turnRunner: async () => {
        entered = true;
        await gate;
      }
    });
    rt.start();
    try {
      clock += TICK;
      await rt.tickOnce(); // 建状态
      rt.getState().tension = 100; // 必醒
      const pending = rt.tickOnce();
      await flush();
      assert.strictEqual(entered, true, '这一轮应该已经进入唤醒轮');
      rt.reset(); // 用户点「重新开始」
      release();
      await pending;
      await flush();
      assert.strictEqual(rt.store.exists(), false, '清空之后不该被旧状态写回');
      assert.strictEqual(rt.getState(), null, '内存里也不该留着旧状态');
    } finally {
      rt.stop();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  await okAsync('关掉总开关后，在跑的那一轮不再落盘/记事件', async () => {
    const root = mkTmp('stop-race');
    const limits = Object.assign({}, AGENT_LIMITS_DEFAULTS, { aliveTickIntervalMs: TICK });
    let clock = Date.UTC(2026, 0, 1);
    let entered = false;
    let release = () => {};
    const gate = new Promise((r) => {
      release = r;
    });
    const rt = createAliveRuntime({
      userDataPath: root,
      limits,
      now: () => clock,
      rng: seededRng(22),
      turnRunner: async () => {
        entered = true;
        await gate;
      }
    });
    rt.start();
    try {
      clock += TICK;
      await rt.tickOnce();
      rt.getState().tension = 100;
      const pending = rt.tickOnce();
      await flush();
      assert.strictEqual(entered, true);
      rt.stop();
      release();
      await pending;
      await flush();
      const kinds = rt.decisions(200).map((e) => e.kind);
      assert.ok(kinds.includes('WAKE'), '关之前那次「醒来」应当已经记下');
      assert.ok(!kinds.includes('WAKE_END'), '关掉之后那一刻不该再补一条 WAKE_END');
      assert.strictEqual(rt.isRunning(), false, '定时器应已停');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  ok('状态版本不认识时，status 不抛错（页面显示不可读而不是崩）', () => {
    const root = mkTmp('badver');
    try {
      const rt0 = createAliveRuntime({
        userDataPath: root,
        limits: AGENT_LIMITS_DEFAULTS,
        now: () => Date.UTC(2026, 0, 1),
        rng: seededRng(23)
      });
      rt0.store.write({ version: 999, tension: 50 });
      const st = rt0.status();
      assert.strictEqual(st.exists, true);
      assert.ok(String(st.unreadable || '').includes('版本'), '应如实报出版本问题');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  ok('可疑顺从只看「今天」：昨天拒过不代表今天不告警', () => {
    const cfg = testCfg();
    const t0 = Date.UTC(2026, 0, 1);
    const state = vitals.createInitialState(cfg, t0);
    state.wakeCountToday = 6;
    state.refuseCount = 3; // 历史上拒过
    state.refuseToday = 0;
    assert.strictEqual(decide.suspiciousObedience(state, cfg), true, '今天没拒绝就该告警');
    state.refuseToday = 1;
    assert.strictEqual(decide.suspiciousObedience(state, cfg), false, '今天拒过就不该告警');
    state.dayKey = '1999-1-1';
    state.refuseToday = 0;
    vitals.rollDay(state, t0);
    assert.strictEqual(state.refuseToday, 0);
    assert.strictEqual(state.wakeCountToday, 0, '跨天应同时重置当日唤醒数');
  });

  await okAsync('关掉总开关会**中止**在跑的那一轮（不再烧 token）', async () => {
    const root = mkTmp('stop-abort');
    const limits = Object.assign({}, AGENT_LIMITS_DEFAULTS, { aliveTickIntervalMs: TICK });
    let clock = Date.UTC(2026, 0, 1);
    let entered = false;
    let seenSignal = null;
    let release = () => {};
    const gate = new Promise((r) => {
      release = r;
    });
    const rt = createAliveRuntime({
      userDataPath: root,
      limits,
      now: () => clock,
      rng: seededRng(24),
      turnRunner: async ({ signal }) => {
        entered = true;
        seenSignal = signal;
        await gate;
      }
    });
    rt.start();
    try {
      clock += TICK;
      await rt.tickOnce();
      rt.getState().tension = 100;
      const pending = rt.tickOnce();
      await flush();
      assert.strictEqual(entered, true);
      assert.ok(seenSignal && typeof seenSignal.aborted === 'boolean', '唤醒轮应拿到 AbortSignal');
      assert.strictEqual(seenSignal.aborted, false);
      rt.stop();
      assert.strictEqual(seenSignal.aborted, true, '关开关应立即 abort 这一轮');
      release();
      await pending;
    } finally {
      rt.stop();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  // ───────────────────────── 抽屉与感官 ─────────────────────────
  ok('抽屉：只追加、打时间戳、单条截断、整体有上限', () => {
    const root = mkTmp('note');
    try {
      const t0 = Date.UTC(2026, 0, 2, 3, 4);
      const a = noteMod.appendNote(root, '  第一行  ', { nowMs: t0 });
      assert.strictEqual(a.ok, true);
      const text1 = noteMod.readNote(root);
      assert.ok(text1.includes('第一行'), '应写进抽屉');
      assert.ok(/^- \[\d{4}-\d{2}-\d{2} \d{2}:\d{2}\] /m.test(text1), `应带时间戳，实际「${text1.trim()}」`);
      assert.ok(noteMod.noteFile(root).includes(path.join('alive', 'workspace')), '必须落在自己的目录里');

      const long = 'x'.repeat(noteMod.NOTE_ENTRY_MAX_CHARS + 100);
      noteMod.appendNote(root, long, { nowMs: t0 });
      const lines = noteMod.readNote(root).trim().split('\n');
      assert.strictEqual(lines.length, 2, '两次追加 = 两行');
      assert.ok(lines[1].length < noteMod.NOTE_ENTRY_MAX_CHARS + 60, '单条应被截断');

      // 撑满上限后仍保留尾部（不会无界增长）
      for (let i = 0; i < 80; i += 1) noteMod.appendNote(root, `填充 ${i} ${'y'.repeat(400)}`, { nowMs: t0 });
      const capped = noteMod.readNote(root);
      assert.ok(capped.length <= noteMod.NOTE_MAX_CHARS, `抽屉应有上限，实际 ${capped.length}`);
      assert.strictEqual(noteMod.appendNote(root, '   ', { nowMs: t0 }).ok, false, '空内容应被拒');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  await okAsync('嘴与耳：缺件就如实说，不假装听见/说出', async () => {
    const root = mkTmp('voice');
    try {
      const noFfmpeg = await voiceMod.listen({ userData: root, env: { PATH: '' }, speechConfig: {} });
      assert.strictEqual(noFfmpeg.ok, false);
      assert.strictEqual(noFfmpeg.errorCode, 'NO_FFMPEG');

      const noSpeech = await voiceMod.listen({
        userData: root,
        env: { PATH: '', DIEYUN_FFMPEG: process.execPath },
        speechConfig: {}
      });
      assert.strictEqual(noSpeech.ok, false);
      // 没有麦克风设备名（Windows）或没有语音配置：两者都是"明确拒绝"
      assert.ok(
        ['NO_MIC_DEVICE', 'NO_SPEECH_CONFIG'].includes(noSpeech.errorCode),
        `应明确报缺件，实际 ${noSpeech.errorCode}`
      );

      const noTts = await voiceMod.speak({ userData: root, text: '喂', env: { PATH: '' }, ttsConfig: {} });
      assert.strictEqual(noTts.ok, false);
      assert.strictEqual(noTts.errorCode, 'NO_TTS_CONFIG');

      const noPlay = await voiceMod.speak({
        userData: root,
        text: '喂',
        env: { DIEYUN_FFMPEG: process.execPath },
        ttsConfig: { baseUrl: 'http://x', apiKey: 'k', model: 'm' }
      });
      assert.strictEqual(noPlay.ok, false);
      assert.strictEqual(noPlay.errorCode, 'NO_FFPLAY', '没有 ffplay 应明确说出来');

      const empty = await voiceMod.speak({ userData: root, text: '   ' });
      assert.strictEqual(empty.errorCode, 'EMPTY_TEXT');

      // 录音参数按平台拼对了（十年稳定的老参数）
      const win = voiceMod.recordArgs('win32', '麦克风 (USB)', 3, 'x.wav');
      assert.ok(win.includes('dshow') && win.join(' ').includes('audio=麦克风 (USB)'));
      const lin = voiceMod.recordArgs('linux', 'default', 3, 'x.wav');
      assert.ok(lin.includes('alsa') && lin.includes('default'));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  ok('感官默认全关（除抽屉）：不会因为装了代码就有眼睛和嘴', () => {
    const root = mkTmp('senses');
    try {
      const store = createAliveStore(root);
      const d = store.readSettings();
      assert.deepStrictEqual(d.senses, { drawer: true, eyes: false, voice: false });
      assert.strictEqual(d.enabled, false, '总开关默认关');
      const saved = store.writeSettings({ senses: { eyes: true } });
      assert.deepStrictEqual(saved.senses, { drawer: false, eyes: true, voice: false });
      const again = store.readSettings();
      assert.deepStrictEqual(again.senses, { drawer: false, eyes: true, voice: false }, '应持久化');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  // ───────────────────────── 装配层（alive-boot）─────────────────────────
  ok('装配：能加载、感官可开关、抽屉可读、总开关能起停（无 Electron 环境）', () => {
    const { bootAliveRuntime } = require('../src/main/alive-boot');
    const root = mkTmp('boot');
    try {
      const alive = bootAliveRuntime({
        userData: root,
        getGateway: () => null,
        getCoreBridge: () => null,
        getMcpRuntime: () => null,
        getCompactionAgent: () => null,
        createToolBridge: () => ({ executeAgentTool: async () => ({ ok: true }) }),
        log: () => {}
      });
      const st = alive.status();
      assert.strictEqual(st.enabled, false, '总开关默认关');
      assert.deepStrictEqual(st.senses, { drawer: true, eyes: false, voice: false, micDevice: '', cameraDevice: '' });
      assert.strictEqual(st.voiceSpontaneous, false, '主动开口默认关');
      assert.strictEqual(st.sessionId, '', '还没醒过时没有会话（首次唤醒会自建）');
      assert.ok(st.capabilities && st.capabilities.voice, '状态里要带嘴与耳的能力自检');
      assert.ok(Array.isArray(st.capabilities.voice.problems), '自检结果要能直接显示');
      assert.ok(st.capabilities.eyes && st.capabilities.eyes.ready === false, '两道锁没开 = 看不到');

      const r1 = alive.setSense('eyes', true);
      assert.strictEqual(r1.ok, true);
      assert.strictEqual(alive.senses().eyes, true);
      assert.strictEqual(alive.setSense('nope', true).ok, false, '未知感官应被拒');

      // 主动开口授权 / 设备选择（值类型不同，走 setOption）
      assert.strictEqual(alive.setOption('voiceSpontaneous', true).voiceSpontaneous, true);
      assert.strictEqual(alive.setOption('micDevice', '麦克风 (USB)').micDevice, '麦克风 (USB)');
      assert.strictEqual(alive.setOption('cameraDevice', 'OBSBOT Tiny 2').cameraDevice, 'OBSBOT Tiny 2');
      assert.strictEqual(alive.setOption('nope', 1).ok, false, '未知选项应被拒');
      assert.strictEqual(alive.senses().micDevice, '麦克风 (USB)', '设备选择要跟着 senses 走');
      assert.strictEqual(alive.senses().cameraDevice, 'OBSBOT Tiny 2');

      assert.strictEqual(alive.note().text, '');
      fs.mkdirSync(path.dirname(noteMod.noteFile(root)), { recursive: true });
      fs.writeFileSync(noteMod.noteFile(root), '- [2026-11-10 07:00] 测试一行\n', 'utf8');
      assert.ok(alive.note().text.includes('测试一行'), '应读到抽屉内容');

      assert.strictEqual(alive.setEnabled(true).enabled, true);
      assert.strictEqual(alive.status().running, true, '打开后心跳应跑起来');
      // 启用那一刻就该有抽屉的落地目录（issue/2026-11-10：跑了两跳还不存在）
      assert.strictEqual(
        fs.existsSync(path.join(root, 'alive', 'workspace')),
        true,
        '启用时应创建 alive/workspace'
      );
      assert.strictEqual(alive.setEnabled(false).enabled, false);
      assert.strictEqual(alive.status().running, false, '关掉后应停表');
      alive.stop();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  // ───────────────── 回归：疲劳口径（issue/2026-11-10 的 P0）─────────────────
  ok('疲劳标定：25k token 不再一步打满（旧系数 4 会直接到 100）', () => {
    const cfg = testCfg({ aliveTensionEps: 0, aliveFatigueEps: 0 });
    const t0 = Date.UTC(2026, 10, 10);
    const state = vitals.createInitialState(cfg, t0);
    vitals.stepVitals(state, { nowMs: t0 + TICK, tokens: 25000, loopTension: 0, cfg, rng: seededRng(1) });
    assert.ok(state.fatigue < 20, `25k token 只该涨 ~12.5，实际 ${state.fatigue}`);
    assert.ok(state.fatigue < cfg.phaseFatigueHigh, '单次不该直接进压缩相位');
  });

  await okAsync('疲劳只数唤醒轮的 token：用户自己的对话不推高它', async () => {
    const root = mkTmp('fatigue-source');
    const limits = Object.assign({}, AGENT_LIMITS_DEFAULTS, { aliveTickIntervalMs: TICK });
    let clock = Date.UTC(2026, 10, 10, 6, 0, 0);
    let wakeTurns = 0;
    const rt = createAliveRuntime({
      userDataPath: root,
      limits,
      now: () => clock,
      rng: seededRng(31),
      turnRunner: async () => {
        wakeTurns += 1;
        // 唤醒轮自己烧掉的 token（这是它自己的账）
        recordLlmUsage({ total_tokens: 40000 });
      }
    });
    rt.start();
    try {
      await rt.tickOnce();
      // 用户在主对话里烧 200k：不算它的疲劳（issue 里正是这段被算成了"它很累"）
      clock += TICK;
      recordLlmUsage({ total_tokens: 200000 });
      await rt.tickOnce();
      assert.strictEqual(rt.getState().fatigue, 0, `用户对话不该算疲劳，实际 ${rt.getState().fatigue}`);

      // 强制醒一次：醒来那轮的 token 才进疲劳
      clock += TICK;
      rt.getState().tension = 100;
      await rt.tickOnce();
      assert.strictEqual(wakeTurns, 1, '应唤醒一次');
      clock += TICK;
      await rt.tickOnce();
      const fatigue = rt.getState().fatigue;
      assert.ok(fatigue > 5 && fatigue <= 40, `一次唤醒轮（40k）的疲劳应在合理量级，实际 ${fatigue}`);
    } finally {
      rt.stop();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  await okAsync('发声记账：noteVoice 计数、事件从 runtime 出口落盘、跨天重置', async () => {
    const root = mkTmp('voiceledger');
    const limits = Object.assign({}, AGENT_LIMITS_DEFAULTS, { aliveTickIntervalMs: TICK });
    let clock = Date.UTC(2026, 10, 10, 9, 0, 0);
    const rt = createAliveRuntime({
      userDataPath: root,
      limits,
      now: () => clock,
      rng: seededRng(32)
    });
    rt.start();
    try {
      await rt.tickOnce();
      rt.recordEvent({ kind: 'SPEAK', ok: true, chars: 12 });
      rt.noteVoice(clock);
      const st1 = rt.status();
      assert.strictEqual(st1.voiceCountToday, 1, '应记一次');
      assert.strictEqual(st1.lastVoiceAt, clock, '应记下时间');
      assert.ok(st1.voiceMaxPerDay > 0, '上限应来自 agent-limits');
      assert.ok(
        rt.decisions(50).some((e) => e.kind === 'SPEAK'),
        '感官事件必须能从 runtime 出口查得到'
      );

      // 跨天：tick 的 rollDay 会把当日次数清零（否则"今天说够了"会永久生效）
      rt.getState().dayKey = '1999-1-1';
      clock += TICK;
      await rt.tickOnce();
      assert.strictEqual(rt.status().voiceCountToday, 0, '跨天应重置当日次数');
    } finally {
      rt.stop();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  // ───────────────── 感官：依赖自检 / 设备 / 许可 ─────────────────
  ok('依赖自检：缺 ffmpeg 与缺配置都说得出来；齐了才 ok', () => {
    const root = mkTmp('cap');
    try {
      const noFfmpeg = voiceMod.describeVoiceCapability({ env: { PATH: '' }, speechConfig: {}, ttsConfig: {} });
      assert.strictEqual(noFfmpeg.ok, false);
      assert.ok(noFfmpeg.problems.some((p) => p.code === 'NO_FFMPEG'), '应报 NO_FFMPEG');
      assert.ok(
        noFfmpeg.problems.some((p) => p.code === 'NO_SPEECH_CONFIG' || p.code === 'NO_TTS_CONFIG'),
        '应报语音配置缺失'
      );
      for (const p of noFfmpeg.problems) assert.ok(p.text.length > 8, `问题要说人话：${p.code}`);

      // 造一对假的 ffmpeg/ffplay：只验证"存在性判断"这条路
      const ffmpeg = path.join(root, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
      const ffplay = path.join(root, process.platform === 'win32' ? 'ffplay.exe' : 'ffplay');
      fs.writeFileSync(ffmpeg, '');
      fs.writeFileSync(ffplay, '');
      const ready = voiceMod.describeVoiceCapability({
        env: { DIEYUN_MIC_DEVICE: '麦克风 (USB)' },
        ffmpegPath: ffmpeg,
        speechConfig: { baseUrl: 'http://x', apiKey: 'k' },
        ttsConfig: { baseUrl: 'http://x', apiKey: 'k', model: 'm' }
      });
      assert.strictEqual(ready.ok, true, `齐件时应 ok，实际问题：${ready.problems.map((p) => p.code).join('/')}`);
      assert.strictEqual(ready.hasFfplay, true);
      assert.strictEqual(ready.micDevice, '麦克风 (USB)');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  ok('麦克风设备：设置里的选择生效，环境变量优先（高级覆盖）', () => {
    assert.strictEqual(voiceMod.resolveMicDevice({ DIEYUN_MIC_DEVICE: 'env麦' }, '设置麦'), 'env麦');
    assert.strictEqual(voiceMod.resolveMicDevice({}, '设置麦'), '设置麦');
    if (process.platform === 'win32') {
      assert.strictEqual(voiceMod.resolveMicDevice({}, ''), '', 'Windows 没有默认设备名');
    } else {
      assert.strictEqual(voiceMod.resolveMicDevice({}, ''), 'default');
    }
  });

  ok('设备枚举：音频与视频分开解析（dshow / avfoundation）', () => {
    const winText =
      '"麦克风 (USB Audio)" (audio)\n"OBSBOT Tiny 2" (video)\n"立体声混音 (Realtek)" (audio)\n';
    assert.deepStrictEqual(voiceMod.AUDIO_BACKENDS.win32.parseList(winText), [
      '麦克风 (USB Audio)',
      '立体声混音 (Realtek)'
    ]);
    const darText = [
      'AVFoundation video devices:',
      '[0] FaceTime HD Camera',
      'AVFoundation audio devices:',
      '[0] MacBook Pro 麦克风'
    ].join('\n');
    assert.deepStrictEqual(voiceMod.AUDIO_BACKENDS.darwin.parseList(darText), ['MacBook Pro 麦克风']);
  });

  ok('主动开口的许可：没授权 / 超上限 / 冷却 分别拒，放行时才 ok', () => {
    assert.strictEqual(voiceMod.voicePolicy({ allowSpontaneous: false }).reason, 'not-allowed');
    assert.strictEqual(
      voiceMod.voicePolicy({ allowSpontaneous: true, countToday: 8, maxPerDay: 8 }).reason,
      'daily-cap'
    );
    assert.strictEqual(
      voiceMod.voicePolicy({
        allowSpontaneous: true,
        countToday: 1,
        lastVoiceAt: 1000,
        minIntervalMs: 60000,
        nowMs: 2000
      }).reason,
      'cooldown'
    );
    assert.strictEqual(
      voiceMod.voicePolicy({ allowSpontaneous: true, countToday: 1, lastVoiceAt: 0, maxPerDay: 8, nowMs: 5000 }).ok,
      true
    );
  });

  ok('录音失败分类：占用 / 找不到 / 其它 不混成一句话', () => {
    assert.strictEqual(voiceMod.classifyRecordFailure('Device busy, cannot open'), 'DEVICE_BUSY');
    assert.strictEqual(voiceMod.classifyRecordFailure('Could not find audio only device'), 'DEVICE_UNAVAILABLE');
    assert.strictEqual(voiceMod.classifyRecordFailure(''), 'NO_AUDIO');
  });

  ok('听几秒的夹取只有一个来源（提示文案与真录音取同一个数）', () => {
    assert.strictEqual(voiceMod.clampListenSeconds(99), voiceMod.LISTEN_MAX_SECONDS);
    assert.strictEqual(voiceMod.clampListenSeconds(0), voiceMod.LISTEN_DEFAULT_SECONDS);
    assert.strictEqual(voiceMod.clampListenSeconds(7), 7);
  });

  ok('设置：主动开口授权与设备名持久化，且不冲掉感官开关', () => {
    const root = mkTmp('settings2');
    try {
      const store = createAliveStore(root);
      const d = store.readSettings();
      assert.strictEqual(d.voiceSpontaneous, false, '默认不允许主动开口');
      assert.strictEqual(d.micDevice, '');
      assert.strictEqual(d.cameraDevice, '');
      const saved = store.writeSettings({
        voiceSpontaneous: true,
        micDevice: '麦克风 (USB)',
        cameraDevice: 'OBSBOT Tiny 2'
      });
      assert.strictEqual(saved.voiceSpontaneous, true);
      assert.strictEqual(saved.micDevice, '麦克风 (USB)');
      const again = store.readSettings();
      assert.deepStrictEqual(
        { v: again.voiceSpontaneous, m: again.micDevice, c: again.cameraDevice },
        { v: true, m: '麦克风 (USB)', c: 'OBSBOT Tiny 2' }
      );
      assert.deepStrictEqual(again.senses, { drawer: true, eyes: false, voice: false }, '感官开关不该被冲掉');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  process.stdout.write(`\n[test-alive] ${checks - failures}/${checks} 通过\n`);
  if (failures) {
    process.stdout.write(`[test-alive] ${failures} 项失败\n`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  process.stderr.write(`[test-alive] 运行失败：${(err && err.stack) || err}\n`);
  process.exitCode = 1;
});
