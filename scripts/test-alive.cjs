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
const recapMod = require('../src/alive/recap');
const eyesMod = require('../src/alive/eyes');
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

  ok('拿当前处境召回记忆：查询由事实拼成，召回结果进事实块（带 id 可对账）', () => {
    const cfg = testCfg();
    const t0 = Date.UTC(2026, 0, 1);
    const state = vitals.createInitialState(cfg, t0);
    const recap = {
      sessions: [{ title: '小规模销售收入日报', agoText: '5 分钟前', tail: '已推送 errcode:0' }],
      plans: [
        { name: 'EP04 巡检', objective: 'G1–G4 全过', attempt: 2, check: 'npm test', lastOk: false, tail: '' }
      ],
      lastHuman: null
    };
    const query = recapMod.buildRecallQuery(recap, ['抽屉：写了 first-light.txt'], 400);
    assert.ok(query.includes('小规模销售收入日报'), '会话标题要在查询里');
    assert.ok(query.includes('errcode:0'), '会话尾句要在查询里');
    assert.ok(query.includes('EP04 巡检'), '未收尾计划也要在查询里');
    assert.ok(query.includes('first-light.txt'), '它自己抽屉里那句也要在查询里');
    assert.strictEqual(recapMod.buildRecallQuery(recap, null, 10).length, 10, '按字数截断（embedding 成本）');
    assert.strictEqual(recapMod.buildRecallQuery(null, null, 400), '', '什么事实都没有就不该发查询');

    const block = decide.renderStateBlock(state, cfg, {
      nowMs: t0,
      load: 0,
      memory: [{ id: 1774, kind: 'normal', text: '对话过长需要开新会话时先写交接' }]
    });
    assert.ok(block.includes('你记得的'), '召回的记忆要进事实块');
    assert.ok(block.includes('#1774'), '要带记忆 id（出问题能对账）');
  });

  ok('体征块：「有没有人在场」只说 load 这个事实，不替它下「没人」的结论', () => {
    const cfg = testCfg();
    const t0 = Date.UTC(2026, 0, 1);
    const state = vitals.createInitialState(cfg, t0);
    const quiet = decide.renderStateBlock(state, cfg, { nowMs: t0, load: 0 });
    // 只报事实：没有对话活动。**不能**再宣布「没有人在等你回话」——
    // 它这一轮手里有摄像头/屏幕照片，屋里有没有人该由它看见。
    assert.ok(quiet.includes('没有对话活动'), '空闲时该报「没有对话活动」这个事实');
    assert.ok(!quiet.includes('没有人在等你回话'), '代码不能再替它断言"没人在"');
    assert.ok(quiet.includes('你自己看'), '屋里有没有人交给它自己看');
    assert.ok(quiet.includes('alive_speak'), '空闲时也允许它出声（说给在场的人听）');
    const busy = decide.renderStateBlock(state, cfg, { nowMs: t0, load: 0.42 });
    assert.ok(busy.includes('最近 5 分钟这台机器上有对话活动'), '有人在用就该说出来');
    assert.ok(busy.includes('alive_speak'), '在场时允许它出声');
    // 没有 load 这个事实（老调用方 / 测试）时按"没有对话活动"说，不瞎猜有人
    const unknown = decide.renderStateBlock(state, cfg, { nowMs: t0 });
    assert.ok(unknown.includes('没有对话活动'));
    assert.ok(!unknown.includes('没有人在等你回话'));
  });

  ok('权力档：提示词只有一种说法（只读 / 可写 / 可跑，不会同时出现）', () => {
    const cfg = testCfg();
    const state = vitals.createInitialState(cfg, 0);
    const mk = (power) =>
      decide.renderStateBlock(state, cfg, { nowMs: 0, power, wakeRoot: 'D:\\alive-sandbox' });
    const read = mk('read');
    assert.ok(read.includes('这一轮是只读的'), 'read 档要说明只读');
    assert.ok(!read.includes('你可以**改文件**'), 'read 档不能暗示能写');
    const write = mk('write');
    assert.ok(!write.includes('这一轮是只读的'), 'write 档不能再说"只读"（自相矛盾）');
    assert.ok(write.includes('你可以**改文件**') && write.includes('D:\\alive-sandbox'), 'write 档要说清根目录');
    assert.ok(!write.includes('也可以**跑命令**'), 'write 档不能暗示能跑命令');
    assert.ok(!write.includes('也可以**联网**'), 'write 档不能暗示能出网（出网跟着 exec 档）');
    const exec = mk('exec');
    assert.ok(!exec.includes('这一轮是只读的'), 'exec 档不能再说"只读"');
    assert.ok(exec.includes('也可以**跑命令**'), 'exec 档要说明能跑命令');
    assert.ok(exec.includes('也可以**联网**'), 'exec 档要说明能联网（web_search / web_fetch）');
    assert.ok(exec.includes('也可以**开浏览器**'), 'exec 档要说明能开浏览器 / 动键鼠');
    assert.ok(exec.includes('WAKE_YIELD'), 'exec 档要说清"有人跑任务时会让路"，否则它会把拒当故障重试');
    assert.ok(exec.includes('每轮最多 6 次') && exec.includes('每轮最多 3 条'), '两个次数上限都要写出来');
  });

  await okAsync('最近工作事实块：只报事实、按字数截断、取数失败就空着', async () => {    const cfg = testCfg();
    const t0 = Date.UTC(2026, 0, 1);
    const state = vitals.createInitialState(cfg, t0);
    const calls = [];
    const invokeRpc = async (method, params) => {
      calls.push(method);
      // 形状必须与 RPC 真实返回一致：Rust `SessionRow` / `MessageRow` 都是 serde camelCase。
      // （这份 fixture 原来写的是 `updated_at`，于是"字段名读错了"在测试里看不见 —— 真实环境
      //   每条会话都被时间窗滤掉，事实块永远说"没有别的会话动静"。）
      if (method === 'memory.sessions_list') {
        return [
          { id: 's-a', title: '在改浏览器面板', updatedAt: t0 - 12 * 60000 },
          { id: 's-self', title: '生命体征（后台心跳）', updatedAt: t0 - 60000 },
          { id: 's-old', title: '上周的会话', updatedAt: t0 - 100 * HOUR }
        ];
      }
      return [
        { role: 'user', content: '把那个面板的可见性问题修一下', createdAt: t0 - 13 * 60000 },
        { role: 'assistant', content: '改完了，gate 之后不再盖住别的页签', createdAt: t0 - 12 * 60000 }
      ];
    };
    const recap = await recapMod.collectRecap({
      invokeRpc,
      selfSessionId: 's-self',
      nowMs: t0,
      limits: { recapWindowHours: 24, recapSessions: 3, recapTailChars: 40 }
    });
    assert.strictEqual(recap.sessions.length, 1, '窗口外的会话与心跳会话自己都不能进');
    assert.ok(recap.sessions[0].title.includes('浏览器'));
    assert.ok(recap.sessions[0].tail.includes('gate'), '应带最后一句');
    assert.ok(recap.lastHuman && recap.lastHuman.tail.includes('面板'), '要能说出"最后一次听到人说话"');
    assert.ok(!calls.includes('memory.sessions_list') === false);

    const block = decide.renderStateBlock(state, cfg, { nowMs: t0, recap });
    assert.ok(block.includes('最近这台机器上'), '状态块要带最近工作');
    assert.ok(block.includes('最后一次听到人说话'), '状态块要带人的最后一句');

    // 取数失败：不抛、不编，只说"没有动静"
    const broken = await recapMod.collectRecap({
      invokeRpc: async () => {
        throw new Error('rpc down');
      },
      nowMs: t0,
      limits: {}
    });
    assert.deepStrictEqual(broken.sessions, []);
    const quiet = decide.renderStateBlock(state, cfg, { nowMs: t0, recap: broken });
    assert.ok(quiet.includes('没有别的会话动静'));
    assert.ok(!quiet.includes('最后一次听到人说话'), '什么都取不到时不能编一句"人说话"');
  });

  await okAsync('最近工作事实块：meta 封套不是"合成消息"，机器触发的一轮也不算人说的话', async () => {
    const t0 = Date.UTC(2026, 0, 1);
    /** 与 `session-context.packMessageMeta` 落库形状一致 */
    const pack = (text, meta) => `【叠云meta】${JSON.stringify(meta || {})}\n${text}`;
    const makeInvoke = (userContent, assistantContent, userMeta) => async (method) => {
      if (method === 'memory.sessions_list') return [{ id: 's-a', title: '某会话', updatedAt: t0 - 60000 }];
      return [
        { role: 'user', content: pack('[系统] 生命体征\n· 张力 40.1') },
        { role: 'user', content: pack(userContent, { inputText: userContent, ...(userMeta || {}) }) },
        { role: 'assistant', content: pack(assistantContent, { modelLabel: 'X', ts: t0 - 60000 }) }
      ];
    };

    // 真人打字：正文里的 meta 封套不能把这条判成"合成"，尾句与"人说的话"都要取得到
    const human = await recapMod.collectRecap({
      invokeRpc: makeInvoke('帮我看看这个报错', '看过了，是端口占用'),
      nowMs: t0,
      limits: { recapWindowHours: 24, recapSessions: 3, recapTailChars: 40 }
    });
    assert.strictEqual(human.sessions.length, 1);
    assert.ok(human.sessions[0].tail.includes('端口占用'), '尾句要取正文，不能把 meta 封套当内容');
    assert.ok(!human.sessions[0].tail.includes('叠云meta'), '封套不能进事实块');
    assert.ok(human.lastHuman && human.lastHuman.tail.includes('报错'), '真人打字必须被认出来');

    // 定时触发的一轮（meta.trigger）：正文是人话，但这句不是人现在说的 → 不算"听到人说话"
    const auto = await recapMod.collectRecap({
      invokeRpc: makeInvoke('跑一下今天的日报', '日报已推送', { trigger: { kind: 'schedule' } }),
      nowMs: t0,
      limits: { recapWindowHours: 24, recapSessions: 3, recapTailChars: 40 }
    });
    assert.strictEqual(auto.lastHuman, null, '机器触发的一轮不能被当成"人在说话"');
  });

  await okAsync('醒来时先看一眼：默认不给图，缺锁就说缺哪个，取到图才成为这一轮的输入', async () => {
    // 1) 没勾：什么都不取
    const none = await eyesMod.captureWakeShots({ wants: {}, senses: {}, permissions: {} });
    assert.deepStrictEqual(none.parts, []);
    assert.deepStrictEqual(none.seen, []);

    // 2) 勾了摄像头但感官关着 / 权限没开：明确说差什么，不给图
    const noSense = await eyesMod.captureWakeShots({
      wants: { camera: true },
      senses: { eyes: false },
      permissions: { desktopCamera: true }
    });
    assert.strictEqual(noSense.parts.length, 0);
    assert.strictEqual(noSense.seen[0].errorCode, 'SENSE_DISABLED');
    const noPerm = await eyesMod.captureWakeShots({
      wants: { screen: true },
      senses: { eyes: true },
      permissions: { osControl: false }
    });
    assert.strictEqual(noPerm.seen[0].errorCode, 'PERMISSION_DENIED');

    // 3) 齐件：两个 part（摄像头 + 屏幕），都是 data URL
    const shots = await eyesMod.captureWakeShots({
      wants: { camera: true, screen: true },
      senses: { eyes: true },
      permissions: { desktopCamera: true, osControl: true },
      createSource: () => ({
        capture: async () => ({ ok: true, base64: 'AAA', mime: 'image/jpeg', width: 640, height: 480, device: 'cam' })
      }),
      listDisplays: () => [{ index: 0, primary: true }],
      grabDisplay: async () => ({ image: {} }),
      encode: () => ({ mime: 'image/png', base64: 'BBB', width: 800, height: 600 })
    });
    assert.strictEqual(shots.parts.length, 2);
    for (const p of shots.parts) {
      assert.strictEqual(p.type, 'image_url');
      assert.ok(String(p.image_url.url).startsWith('data:image/'), '必须是 data URL，且不落盘');
    }
    assert.ok(shots.seen.every((s) => s.ok === true));

    // 4) 取不到时如实写进状态块（不许假装看过）
    const cfg = testCfg();
    const block = decide.renderStateBlock(vitals.createInitialState(cfg, 0), cfg, {
      nowMs: 0,
      look: [
        { tool: 'wake_camera', ok: true, width: 640, height: 480 },
        { tool: 'wake_screen', ok: false, errorCode: 'PERMISSION_DENIED' }
      ]
    });
    assert.ok(block.includes('你醒来时先看了一眼'), '要告诉它这一轮看过');
    assert.ok(block.includes('没看成'), '失败也要如实说');
  });

  ok('完成收口：ACT 带 done 关掉条目（做完 ≠ 拒绝），张力不再计它', () => {
    const cfg = testCfg();
    const t0 = Date.UTC(2026, 0, 1);
    const state = vitals.createInitialState(cfg, t0);
    tensionEngine.upsertLoops(state, [{ text: '把这件事实收尾' }, { text: '另一件不值得做' }], { cfg, nowMs: t0 });
    const list = state.loops.slice();
    assert.strictEqual(list.length, 2);
    const tensionBefore = tensionEngine.totalLoopTension(state.loops, t0, cfg);
    const res = decide.applyDecision(
      state,
      { decision: 'ACT', done: [list[0].id], intent: '处理完了' },
      { cfg, nowMs: t0 + 1000 }
    );
    assert.strictEqual(res.ok, true);
    assert.deepStrictEqual(res.doneIds, [list[0].id]);
    assert.strictEqual(state.loops.length, 1, '收口后清单少一条');
    assert.ok(tensionEngine.totalLoopTension(state.loops, t0, cfg) < tensionBefore, '收口的那条不再计张力');
    assert.strictEqual(state.actCount, 1);
    assert.strictEqual(state.refuseCount, 0, '做完不是拒绝');
    assert.strictEqual(state.refuseToday, 0);
    // 不存在的 id：不抛、不虚增
    const again = decide.applyDecision(state, { decision: 'DEFER', done: ['loop-nope'] }, { cfg, nowMs: t0 + 2000 });
    assert.strictEqual(again.ok, true);
    assert.deepStrictEqual(again.doneIds, []);
    // 工具 schema 与提示词都要有这个动作（否则模型根本不知道能"做完"）
    const schema = decide.ALIVE_DECIDE_TOOL.function.parameters.properties;
    assert.ok(schema.done && schema.done.type === 'array', 'alive_decide 要有 done');
    const block = decide.renderStateBlock(state, cfg, { nowMs: t0 });
    assert.ok(block.includes('done'), '状态块要提到 done');
    // 清单空着也要能自己开一条：以前只教了怎么关，它 7 次醒来清单都是 0 条
    assert.ok(block.includes('loops'), '状态块要说明可以自己开一条未闭合事项');
    // 「做完了」要对事实：这句必须在提示里（代码侧另有 DONE_NO_EVIDENCE 留痕）
    assert.ok(block.includes('要对得上事实'), '状态块要写明做完要对得上事实');
  });

  await okAsync('它自己的记忆回到眼前：抽屉最后几行进状态块；说做完却没有事实依据要留痕', async () => {
    const cfg = testCfg();
    const t0 = Date.UTC(2026, 0, 1);
    const state = vitals.createInitialState(cfg, t0);
    // 1) 抽屉内容进事实块（它自己的字），且排在"外面发生了什么"之前
    const withNote = decide.renderStateBlock(state, cfg, {
      nowMs: t0,
      load: 0,
      note: ['[2026-11-11 22:23] 第 5 次醒来第一次真动手：写了 first-light.txt，并核到了'],
      recap: {
        sessions: [{ title: '别的会话', agoText: '10 分钟前', tail: '日报推成功' }],
        plans: [],
        lastHuman: null
      }
    });
    assert.ok(withNote.includes('你抽屉里最近写的'), '要带上它自己写过的话');
    assert.ok(withNote.includes('first-light.txt'), '原话要原样出现');
    assert.ok(
      withNote.indexOf('你抽屉里最近写的') < withNote.indexOf('最近这台机器上'),
      '先让它想起自己，再看外面'
    );

    // 2) 说「做完了」但这一轮从头到尾没有它自己的动作 → 记一条 DONE_NO_EVIDENCE（只留痕、不驳回）
    //    对账在**轮末**做（这一轮用 done 关掉了条目、整轮又没有依据），所以这里跑真的唤醒轮。
    const root = mkTmp('done-evidence');
    let clock2 = t0;
    /**
     * 这一轮轮到它做什么：
     * none / auto-eye（代码替它拍的输入）/ self-eye（它自己调的）/ action /
     * action-late（先把条目 done 掉、再去跑命令核对 —— 真实里常见的顺序）
     */
    let mode = 'none';
    const rt = createAliveRuntime({
      userDataPath: root,
      limits: Object.assign({}, AGENT_LIMITS_DEFAULTS, { aliveTickIntervalMs: TICK }),
      now: () => clock2,
      rng: seededRng(44),
      turnRunner: async () => {
        rt.applyDecision({ decision: 'ACT', loops: [{ text: '把这件事实收尾' }], intent: '开一条' });
        const id = rt.getState().loops[0].id;
        if (mode === 'action-late') {
          // 先划掉、再验证：2026-11-14 实测里它真这么干（06:38 那轮），按"决定那一刻"判会冤枉它
          rt.applyDecision({ decision: 'ACT', done: [id], intent: '我先关掉，再核一遍' });
          rt.recordEvent({ kind: 'ACTION', tool: 'host_exec', ok: true, target: 'dir /b F:\\alive-sandbox' });
          return { content: '核过了' };
        }
        if (mode === 'auto-eye') {
          rt.recordEvent({ kind: 'EYE', tool: 'wake_camera', ok: true, auto: true, width: 1568, height: 882 });
        } else if (mode === 'self-eye') {
          rt.recordEvent({ kind: 'EYE', tool: 'desktop_camera_look', ok: true, width: 800, height: 600 });
        } else if (mode === 'action') {
          rt.recordEvent({ kind: 'ACTION', tool: 'fs_write_file', ok: true, target: 'D:\\alive-sandbox\\a.txt' });
        }
        rt.applyDecision({ decision: 'ACT', done: [id], intent: '我做完了' });
        return { content: '做完了' };
      }
    });
    try {
      const warnCount = () => rt.decisions(50).filter((e) => e.kind === 'DONE_NO_EVIDENCE').length;

      await rt.wakeNow();
      assert.strictEqual(warnCount(), 1, '没有任何动作就声称做完，要留一条痕');
      assert.strictEqual(rt.getState().loops.length, 0, '缺依据也要真收口 —— 代码没资格替它判断哪条算数');

      // 自动睁眼（`auto: true`：醒来时先看一眼是这一轮的**输入**）不算依据。
      // 2026-11-13 实测：以前 EYE 一律算依据，眼睛一开这条对账就再也没响过 —— 等于关着。
      mode = 'auto-eye';
      clock2 += TICK;
      await rt.wakeNow();
      assert.strictEqual(warnCount(), 2, '自动睁眼不该被当成"做完的证据"');

      // 它**自己**调的睁眼算依据
      mode = 'self-eye';
      clock2 += TICK;
      await rt.wakeNow();
      assert.strictEqual(warnCount(), 2, '它自己调的睁眼算依据');

      // 成功的 ACTION 更算
      mode = 'action';
      clock2 += TICK;
      await rt.wakeNow();
      assert.strictEqual(warnCount(), 2, '有依据的收口不该被记成缺依据');

      // 先 `done` 后干活：整轮下来有依据，不该报缺依据（2026-11-14 修的时刻判定假警报）
      mode = 'action-late';
      clock2 += TICK;
      await rt.wakeNow();
      assert.strictEqual(warnCount(), 2, '按整轮判：先划掉、随后真跑了命令，不算缺依据');
    } finally {
      rt.stop();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  ok('未收尾的目标型计划：进事实块；已收尾与非目标型不进', () => {
    const cfg = testCfg();
    const t0 = Date.UTC(2026, 0, 1);
    const state = vitals.createInitialState(cfg, t0);
    const plans = [
      {
        trigger: 'goal',
        outcome: null,
        name: '把索引建完',
        attempt: 3,
        goal: { objective: '全仓向量建满', checks: [{ id: 'c1', command: 'npm run test:agent' }] },
        lastRunOk: false,
        updatedAt: '2026-01-01T00:00:00.000Z'
      },
      { trigger: 'goal', outcome: 'complete', name: '已完成的目标', attempt: 1 },
      { trigger: 'schedule', outcome: null, name: '定时开会', attempt: 9 }
    ];
    const plansOut = recapMod.collectOpenPlans({
      listPlans: () => plans,
      limits: { recapPlans: 3, recapTailChars: 40 }
    });
    assert.strictEqual(plansOut.length, 1, '只留未收尾的目标型计划');
    assert.ok(plansOut[0].name.includes('索引'));
    assert.strictEqual(plansOut[0].attempt, 3);
    assert.ok(plansOut[0].check.includes('npm run test:agent'));
    const block = decide.renderStateBlock(state, cfg, {
      nowMs: t0,
      recap: { sessions: [], plans: plansOut, lastHuman: null }
    });
    assert.ok(block.includes('未收尾的目标型计划'));
    assert.ok(block.includes('上次检查没过'));
    assert.ok(!block.includes('定时开会'), '非目标型计划不该出现');
    // 存储不可用 / 没有入口：不抛、不编
    assert.deepStrictEqual(
      recapMod.collectOpenPlans({ listPlans: () => { throw new Error('x'); }, limits: { recapPlans: 3 } }),
      []
    );
    assert.deepStrictEqual(recapMod.collectOpenPlans({ limits: { recapPlans: 3 } }), []);
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
      turnRunner: async ({ stateBlock, state }) => {
        wakeTurns += 1;
        assert.ok(stateBlock.startsWith(ALIVE_STATE_PREFIX), '唤醒轮必须拿到体征块');
        // 模拟模型：走工具落决策（同一入口），一并声明一件未闭合的事。
        // REFUSE 必须指向一条真实存在的未闭合项（空手 REFUSE 不算拒绝，见 C1）。
        const loopId = (state.loops && state.loops[0] && state.loops[0].id) || undefined;
        const refuse = wakeTurns % 4 === 0 && !!loopId;
        const dec = rt.applyDecision({
          decision: refuse ? 'REFUSE' : 'ACT',
          intent: '模拟决策',
          ...(refuse ? { loopId } : { loops: [{ text: `待办 ${wakeTurns}` }] })
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

      // 「设定」：一个自由文本框，走同一条 setOption；status 带回原文与字数上限
      assert.strictEqual(alive.status().setup, '', '设定默认为空');
      assert.strictEqual(alive.setOption('setup', '人生目标：把角落摸清。\n遇到人打个招呼。').ok, true);
      assert.strictEqual(
        alive.status().setup,
        '人生目标：把角落摸清。\n遇到人打个招呼。',
        '设定要能读回（页面回显靠它）'
      );
      assert.strictEqual(alive.status().setupMaxChars, AGENT_LIMITS_DEFAULTS.aliveSetupMaxChars);
      const huge = alive.setOption('setup', '字'.repeat(AGENT_LIMITS_DEFAULTS.aliveSetupMaxChars + 10));
      assert.strictEqual(huge.setup.length, AGENT_LIMITS_DEFAULTS.aliveSetupMaxChars, '超上限即截断');
      assert.deepStrictEqual(
        alive.senses(),
        { drawer: true, eyes: true, voice: false, micDevice: '麦克风 (USB)', cameraDevice: 'OBSBOT Tiny 2' },
        '写设定不能冲掉感官与设备选择'
      );

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

  await okAsync('心跳会话被归档：另开一条并写回 settings（别把记录丢进侧栏看不见的地方）', async () => {
    const { bootAliveRuntime } = require('../src/main/alive-boot');
    const root = mkTmp('alive-session-archived');
    const calls = [];
    const rows = new Map([['s-old', { id: 's-old', title: '生命体征（后台心跳）', archived: true }]]);
    /** 假的 memory RPC：会话表是唯一真相（`session_get` 必须如实回答 archived） */
    const gateway = {
      invokeRpc: async (method, params) => {
        calls.push({ method, params });
        if (method === 'memory.session_get') return rows.get(params.sessionId) || null;
        if (method === 'memory.session_create') {
          const row = { id: 's-new', title: params.title, archived: false };
          rows.set(row.id, row);
          return row;
        }
        throw new Error(`unexpected rpc: ${method}`);
      }
    };
    try {
      // 归档发生在装配之前：settings 里还指着那条已归档的会话
      createAliveStore(root).writeSettings({ sessionId: 's-old' });
      const alive = bootAliveRuntime({
        userData: root,
        getGateway: () => gateway,
        getCoreBridge: () => null,
        getMcpRuntime: () => null,
        getCompactionAgent: () => null,
        createToolBridge: () => ({ executeAgentTool: async () => ({ ok: true }) }),
        log: () => {}
      });
      try {
        assert.strictEqual(alive.status().sessionId, 's-old', '装配后先沿用 settings 里的会话');
        // 跑一轮（后面的轮次会在 runMainTurn 里失败 —— 这一条只关心"换到哪条会话"）
        await alive.wakeOnce().catch(() => {});
        assert.ok(
          calls.some((c) => c.method === 'memory.session_create'),
          '绑定的会话已归档时应该另开一条'
        );
        assert.strictEqual(alive.status().sessionId, 's-new', '新会话 id 要写回 settings（否则每轮都新建）');
        assert.strictEqual(
          createAliveStore(root).readSettings().sessionId,
          's-new',
          '落盘必须在 settings.json 里'
        );
        assert.strictEqual(rows.get('s-old').archived, true, '归档是用户的决定，不该被偷偷改回去');
      } finally {
        alive.stop();
      }
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
      rt.recordEvent({ kind: 'SPEAK', ok: true, chars: 12, text: '我在，桌上有杯水凉了' });
      rt.noteVoice(clock, '我在，桌上有杯水凉了');
      const st1 = rt.status();
      assert.strictEqual(st1.voiceCountToday, 1, '应记一次');
      assert.strictEqual(st1.lastVoiceAt, clock, '应记下时间');
      assert.strictEqual(
        st1.voiceMaxPerDay,
        AGENT_LIMITS_DEFAULTS.aliveVoiceMaxPerDay,
        '上限必须来自 agent-limits（本机只有这一个来源）'
      );
      assert.strictEqual(
        st1.voiceMinIntervalMs,
        AGENT_LIMITS_DEFAULTS.aliveVoiceMinIntervalMs,
        '间隔也要由 status 带出：页面文案读它，别在 Renderer 里再抄一个数'
      );
      // 「它说了什么」必须留得下来：人可能不在/没听清，主窗口那条与日志都靠它
      assert.strictEqual(st1.lastVoiceText, '我在，桌上有杯水凉了', '最近一句原话要进 status');
      assert.ok(
        rt.decisions(50).some((e) => e.kind === 'SPEAK' && String(e.text || '').includes('水凉了')),
        '事件流也要带原话（日志逐条可回看）'
      );
      rt.noteVoice(clock, '  多行\n换行   也要压成一行  ');
      assert.strictEqual(rt.status().lastVoiceText, '多行 换行 也要压成一行', '空白要压平，别把日志撑成多行');
      rt.noteVoice(clock);
      assert.strictEqual(
        rt.status().lastVoiceText,
        '多行 换行 也要压成一行',
        '只听不说不该把上一句擦掉'
      );
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

      // 内网 / 本机语音服务（FunASR SenseVoice 等）不要鉴权：有端点就是配好了。
      // 把 apiKey 当配置的一部分会让"已经能转写"的机器亮红字（issue/2026-11-11）。
      const keyless = voiceMod.describeVoiceCapability({
        env: { DIEYUN_MIC_DEVICE: '麦克风 (USB)' },
        ffmpegPath: ffmpeg,
        speechConfig: { baseUrl: 'http://127.0.0.1:10095/v1', apiKey: '', model: 'SenseVoiceSmall' },
        ttsConfig: { baseUrl: 'http://127.0.0.1:5018/v1', apiKey: '', model: 'tts-1' }
      });
      assert.strictEqual(keyless.hasSpeechConfig, true, '没有 apiKey 的转写端点也算配置');
      assert.strictEqual(keyless.hasTtsConfig, true, '没有 apiKey 的合成端点也算配置');
      assert.strictEqual(keyless.ok, true, `无 key 端点齐件时应 ok，实际：${keyless.problems.map((p) => p.code).join('/')}`);
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

  // ───────────────── 回归：这一版补的三处设计遗漏（A/B/C）─────────────────
  ok('A1 抽屉能读回来：读的仍是它自己那一个文件（没有路径参数）', () => {
    assert.ok(noteMod.ALIVE_READ_NOTE_TOOL, '要有读回工具');
    assert.strictEqual(noteMod.ALIVE_READ_NOTE_TOOL.function.name, 'alive_read_note');
    assert.deepStrictEqual(
      Object.keys(noteMod.ALIVE_READ_NOTE_TOOL.function.parameters.properties || {}),
      [],
      '读回不能有路径参数（否则就是扩大了边界）'
    );
    const root = mkTmp('readnote');
    try {
      noteMod.appendNote(root, '第一行', { nowMs: Date.UTC(2026, 0, 2, 3, 4) });
      assert.ok(noteMod.readNote(root).includes('第一行'), '写进去的要能读回来');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  ok('C1 空手 REFUSE 不算拒绝（只有真关掉一条未闭合项才计数）', () => {
    const cfg = testCfg();
    const t0 = Date.UTC(2026, 0, 1);
    const state = vitals.createInitialState(cfg, t0);
    tensionEngine.upsertLoops(state, [{ text: '待办' }], { cfg, nowMs: t0 });
    const empty = decide.applyDecision(state, { decision: 'REFUSE' }, { cfg, nowMs: t0 });
    assert.strictEqual(empty.ok, true);
    assert.strictEqual(state.refuseCount, 0, '空手拒绝不该抬高拒绝率');
    assert.strictEqual(state.refuseToday, 0);
    const bound = decide.applyDecision(
      state,
      { decision: 'REFUSE', loopId: state.loops[0].id },
      { cfg, nowMs: t0 }
    );
    assert.strictEqual(bound.closedLoop && bound.closedLoop.text, '待办', '要真的关掉');
    assert.strictEqual(state.refuseCount, 1);
    assert.strictEqual(state.refuseToday, 1);
  });

  ok('B1/B4 数字只有一处来源：保留条数与「可疑顺从」阈值都在 agent-limits', () => {
    const cfg = testCfg();
    assert.strictEqual(cfg.decisionsKeep, AGENT_LIMITS_DEFAULTS.aliveDecisionsKeep);
    assert.strictEqual(cfg.intentsKeep, AGENT_LIMITS_DEFAULTS.aliveIntentsKeep);
    assert.strictEqual(cfg.suspiciousWakeMin, AGENT_LIMITS_DEFAULTS.aliveSuspiciousWakeMin);
    assert.strictEqual(cfg.historyMax, undefined, '死配置 aliveHistoryMax 应已删除');

    const t0 = Date.UTC(2026, 0, 1);
    const state = vitals.createInitialState(cfg, t0);
    state.wakeCountToday = AGENT_LIMITS_DEFAULTS.aliveSuspiciousWakeMin - 1;
    state.refuseToday = 0;
    assert.strictEqual(decide.suspiciousObedience(state, cfg), false, '没到线不告警');
    state.wakeCountToday = AGENT_LIMITS_DEFAULTS.aliveSuspiciousWakeMin;
    assert.strictEqual(decide.suspiciousObedience(state, cfg), true, '到线且今天没拒绝就告警');

    // 保留条数确实生效（不是只写在配置里）
    for (let i = 0; i < cfg.intentsKeep + 5; i += 1) {
      decide.applyDecision(state, { decision: 'ACT', intent: `第 ${i} 次` }, { cfg, nowMs: t0 });
    }
    assert.strictEqual(state.intents.length, cfg.intentsKeep, 'intents 只留上限那么多');
    assert.ok(state.decisions.length <= cfg.decisionsKeep, 'decisions 有界');
  });

  await okAsync('A2/A3/C2 唤醒回执：WAKE 带 load、WAKE_END 带 token、没表态记一条', async () => {
    const root = mkTmp('wake-receipt');
    const limits = Object.assign({}, AGENT_LIMITS_DEFAULTS, { aliveTickIntervalMs: TICK });
    let clock = Date.UTC(2026, 0, 1);
    let speakDecision = false;
    const rt = createAliveRuntime({
      userDataPath: root,
      limits,
      now: () => clock,
      rng: seededRng(41),
      turnRunner: async () => {
        recordLlmUsage({ total_tokens: 30000 });
        // 第一轮故意不表态（模拟模型忘了调 alive_decide），第二轮才调
        if (speakDecision) rt.applyDecision({ decision: 'DEFER', intent: '模拟' });
      }
    });
    rt.start();
    try {
      await rt.tickOnce();
      // 第一轮：只在醒来时喂用量（load 高 = 有人正在用）
      clock += TICK;
      recordLlmUsage({ total_tokens: 40000 });
      rt.getState().tension = 100;
      await rt.tickOnce();
      let events = rt.decisions(200);
      const wake1 = events.find((e) => e.kind === 'WAKE');
      assert.ok(wake1 && typeof wake1.load === 'number', 'WAKE 要带当时的 load（可看出是不是在你说话时醒的）');
      assert.ok(wake1.load > 0, `load 应大于 0，实际 ${wake1 && wake1.load}`);
      const end1 = events.find((e) => e.kind === 'WAKE_END');
      assert.ok(end1 && end1.tokens > 0, `WAKE_END 要带这一轮烧掉的 token，实际 ${JSON.stringify(end1)}`);
      assert.ok(end1.durationMs >= 0, 'WAKE_END 要带耗时');
      assert.strictEqual(rt.status().lastWakeTokens, end1.tokens, '上次唤醒成本要进 status');
      assert.ok(
        events.some((e) => e.kind === 'WAKE_NO_DECISION'),
        '没调 alive_decide 要记一条观测事件'
      );

      // 第二轮：模型表态了，就不该再有 WAKE_NO_DECISION
      speakDecision = true;
      const before = rt.decisions(200).filter((e) => e.kind === 'WAKE_NO_DECISION').length;
      clock += 30 * 60 * 1000;
      rt.getState().tension = 100;
      await rt.tickOnce();
      events = rt.decisions(200);
      const after = events.filter((e) => e.kind === 'WAKE_NO_DECISION').length;
      assert.strictEqual(after, before, '表过态的那一轮不该被记成没表态');
    } finally {
      rt.stop();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  await okAsync('它醒来写了什么：正文压成一行进 state（主窗口「它醒来写了…」的唯一来源）', async () => {
    const root = mkTmp('wake-text');
    let clock = Date.UTC(2026, 0, 1);
    const firstReply = '  这轮把 vision 稿的第二节核完。\n\n  顺带记一行：没人读的东西不算交付。  ';
    let reply = firstReply;
    const rt = createAliveRuntime({
      userDataPath: root,
      limits: Object.assign({}, AGENT_LIMITS_DEFAULTS, { aliveTickIntervalMs: TICK }),
      now: () => clock,
      rng: seededRng(45),
      turnRunner: async () => {
        rt.applyDecision({ decision: 'ACT', intent: '写完了' });
        return { content: reply };
      }
    });
    try {
      await rt.wakeNow();
      const expected = '这轮把 vision 稿的第二节核完。 顺带记一行：没人读的东西不算交付。';
      assert.strictEqual(rt.status().lastWakeText, expected, '多行正文要压成一行再进 status');
      assert.strictEqual(rt.status().lastWakeTextAt, clock, '要记住时间（主窗口那行用它判新旧）');

      // 空正文（DEFER 那种"没写东西"的一轮）不覆盖上一行
      reply = '';
      clock += TICK;
      await rt.wakeNow();
      assert.strictEqual(rt.status().lastWakeText, expected, '没写东西的一轮不该把上一次擦掉');

      // 上限来自 agent-limits，不是页面上写死的数
      const max = Number(AGENT_LIMITS_DEFAULTS.aliveWakeTextMaxChars) || 0;
      assert.ok(max > 0, 'aliveWakeTextMaxChars 要有值');
      reply = `标题行\n${'x'.repeat(max + 80)}`;
      clock += TICK;
      await rt.wakeNow();
      assert.strictEqual(rt.status().lastWakeText.length, max, `要按 ${max} 字截断`);

      // 只留一行在 state：正文不进事件流（日志不是录音带，也不该成为搬运正文的通道）
      assert.ok(
        !rt.decisions(50).some((e) => e.text !== undefined && e.kind === 'WAKE_END'),
        'WAKE_END 不该带本轮正文'
      );
    } finally {
      rt.stop();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  await okAsync('手动唤醒：跳过张力门限、事件如实记 manual、在跑时不排队、额度用完就拒', async () => {
    const root = mkTmp('wake-now');
    const limits = Object.assign({}, AGENT_LIMITS_DEFAULTS, { aliveTickIntervalMs: TICK });
    const clock = Date.UTC(2026, 0, 1);
    let turns = 0;
    const rt = createAliveRuntime({
      userDataPath: root,
      limits,
      now: () => clock,
      rng: seededRng(43),
      turnRunner: async () => {
        turns += 1;
      }
    });
    try {
      // 1) 没越线也能被人叫醒：确实跑了 turnRunner
      const first = rt.wakeNow();
      // 2) 一轮在跑时再按一次：直接拒（不排队、不叠加）
      const second = await rt.wakeNow();
      assert.strictEqual(second.ok, false);
      assert.strictEqual(second.reason, 'already-running');
      assert.ok((await first).ok, '第一次按要真的醒');
      assert.strictEqual(turns, 1, '只跑了一轮');

      const st = rt.getState();
      assert.ok(st.tension < st.wakeThreshold, '手动唤醒不该伪造"张力已越线"');
      const wake = rt.decisions(50).filter((e) => e.kind === 'WAKE').pop();
      assert.ok(wake, '要记一条 WAKE 事件');
      assert.strictEqual(wake.trigger, 'manual', '账本里不能把人的手写成它自己醒的');
      assert.strictEqual(st.wakeCountToday, 1, '唤醒次数照样记账');

      // 3) 今日 token 额度用完：手动也不放行（那是钱）
      st.tokenToday = Number(rt.cfg.dailyTokenBudget) || 1;
      const capped = await rt.wakeNow();
      assert.strictEqual(capped.ok, false);
      assert.strictEqual(capped.reason, 'token-day-cap');
      assert.strictEqual(turns, 1, '额度用完不该再跑一轮');
    } finally {
      rt.stop();
      fs.rmSync(root, { recursive: true, force: true });
    }
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

      // 新选项：醒来时先看一眼（默认关）+ 它自己的脑子（空 = 跟随机型设置）
      assert.strictEqual(d.wakeLookCamera, false, '默认不自动拍');
      assert.strictEqual(d.wakeLookScreen, false, '默认不自动截屏');
      assert.strictEqual(d.modelRoute, '', '默认跟随模型设置');
      const withNew = store.writeSettings({
        wakeLookCamera: true,
        wakeLookScreen: true,
        modelRoute: 'custom:model-42'
      });
      assert.strictEqual(withNew.wakeLookCamera, true);
      assert.strictEqual(withNew.wakeLookScreen, true);
      assert.strictEqual(withNew.modelRoute, 'custom:model-42');
      assert.strictEqual(store.readSettings().voiceSpontaneous, true, '写新选项不该冲掉旧值');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  // ───────────────── 回归：看得见（额度 / 历史），见 docs/ALIVE-VISIBILITY-PLAN.md ─────────────────
  ok('① 额度：达到日额度就不再醒，<=0 表示不限', () => {
    const cfg = testCfg();
    assert.ok(cfg.dailyTokenBudget > 0, '默认要有一条额度');
    const t0 = Date.UTC(2026, 0, 1);
    const state = vitals.createInitialState(cfg, t0);
    state.tension = state.wakeThreshold + 10;
    state.wakeCountToday = 0;
    assert.strictEqual(waker.evaluate({ state, cfg, nowMs: t0 }).wake, true, '没超额度时应能醒');

    state.tokenToday = cfg.dailyTokenBudget;
    const blocked = waker.evaluate({ state, cfg, nowMs: t0 });
    assert.strictEqual(blocked.wake, false);
    assert.strictEqual(blocked.reason, 'token-day-cap', '超额度要给可读理由');

    // 显式关掉护栏（<=0）= 不限
    const unlimited = Object.assign({}, cfg, { dailyTokenBudget: 0 });
    assert.strictEqual(waker.evaluate({ state, cfg: unlimited, nowMs: t0 }).wake, true);
  });

  ok('① 额度：跨天由 rollDay 清零（与其它今日计数同一处）', () => {
    const cfg = testCfg({ aliveTensionEps: 0, aliveFatigueEps: 0, aliveTensionIdleRampPerHour: 0 });
    // dayKey 是**本地日期**：用 UTC 零点（= 本地 08:00）避开时区把两天并成一天
    const t0 = Date.UTC(2026, 0, 1, 0, 0, 0);
    const state = vitals.createInitialState(cfg, t0);
    state.tokenToday = 12345;
    state.wakeCountToday = 3;
    vitals.stepVitals(state, { nowMs: t0 + TICK, tokens: 0, loopTension: 0, cfg, rng: seededRng(5) });
    assert.strictEqual(state.tokenToday, 12345, '同一天不清零');
    const nextDay = Date.UTC(2026, 0, 2, 0, 0, 0);
    vitals.stepVitals(state, { nowMs: nextDay, tokens: 0, loopTension: 0, cfg, rng: seededRng(6) });
    assert.strictEqual(state.tokenToday, 0, '跨天应清零');
    assert.strictEqual(state.wakeCountToday, 0);
  });

  await okAsync('① 记账：tokenToday = 当日 WAKE_END.tokens 之和（同一个数）', async () => {
    const root = mkTmp('tokenledger');
    const limits = Object.assign({}, AGENT_LIMITS_DEFAULTS, { aliveTickIntervalMs: TICK });
    let clock = Date.UTC(2026, 0, 1, 9, 0, 0);
    const rt = createAliveRuntime({
      userDataPath: root,
      limits,
      now: () => clock,
      rng: seededRng(51),
      turnRunner: async () => {
        recordLlmUsage({ total_tokens: 25000 });
        rt.applyDecision({ decision: 'DEFER', intent: '模拟' });
      }
    });
    rt.start();
    try {
      await rt.tickOnce();
      clock += TICK;
      rt.getState().tension = 100;
      await rt.tickOnce();
      const events = rt.decisions(200);
      const ends = events.filter((e) => e.kind === 'WAKE_END');
      assert.strictEqual(ends.length, 1, '应醒一次');
      const sum = ends.reduce((n, e) => n + (Number(e.tokens) || 0), 0);
      assert.ok(sum > 0, 'WAKE_END 应带 token');
      assert.strictEqual(rt.status().tokenToday, sum, 'tokenToday 必须等于当日 WAKE_END.tokens 之和');
      assert.strictEqual(rt.status().dailyTokenBudget, limits.aliveDailyTokenBudget);
    } finally {
      rt.stop();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  await okAsync('① 超额度时只记一条 WAKE_SKIPPED（不逐跳刷屏）', async () => {
    const root = mkTmp('tokencap');
    const limits = Object.assign({}, AGENT_LIMITS_DEFAULTS, {
      aliveTickIntervalMs: TICK,
      aliveDailyTokenBudget: 1 // 立刻用光
    });
    let clock = Date.UTC(2026, 0, 1, 9, 0, 0);
    const rt = createAliveRuntime({ userDataPath: root, limits, now: () => clock, rng: seededRng(52) });
    rt.start();
    try {
      await rt.tickOnce();
      rt.getState().tokenToday = 999; // 已超额
      for (let i = 0; i < 6; i += 1) {
        clock += TICK;
        rt.getState().tension = 100; // 每跳都「想醒」
        await rt.tickOnce();
      }
      const skipped = rt.decisions(200).filter((e) => e.kind === 'WAKE_SKIPPED' && e.reason === 'token-day-cap');
      assert.strictEqual(skipped.length, 1, `同一上限每天只记一条，实际 ${skipped.length}`);
      assert.ok(skipped[0].tokenToday >= 999 && skipped[0].budget > 0, '要带 tokenToday / budget 供对账');
      assert.strictEqual(rt.decisions(200).filter((e) => e.kind === 'WAKE').length, 0, '超额度不该醒');
    } finally {
      rt.stop();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  ok('② 历史：逐跳一条、窗口过滤、坏行跳过、读侧抽样有界', () => {
    const root = mkTmp('history');
    try {
      const store = createAliveStore(root);
      const base = Date.UTC(2026, 0, 1);
      // 100 条，间隔 5 分钟
      for (let i = 0; i < 100; i += 1) {
        store.appendSample(
          { ts: base + i * TICK, phase: 'LOW', tension: i, fatigue: 100 - i, tokenToday: 0, wakeCountToday: 0 },
          { maxLines: 4000 }
        );
      }
      const last = base + 99 * TICK;
      const all = store.readSamples({ points: 240, windowMs: 24 * 3600 * 1000, nowMs: last });
      assert.strictEqual(all.total, 100, '窗口内应有 100 条');
      assert.strictEqual(all.samples.length, 100, '点数少于上限时原样返回');
      assert.ok(
        all.samples.every((s, i) => i === 0 || Number(s.ts) >= Number(all.samples[i - 1].ts)),
        'ts 必须递增'
      );

      const thinned = store.readSamples({ points: 10, windowMs: 24 * 3600 * 1000, nowMs: last });
      assert.ok(thinned.samples.length <= 10, `抽样后不该超过 points，实际 ${thinned.samples.length}`);
      assert.strictEqual(thinned.samples[0].ts, base, '抽样要含首');
      assert.strictEqual(thinned.samples[thinned.samples.length - 1].ts, last, '抽样要含尾');

      // 窗口只留最近 30 分钟（≈ 7 条）
      const narrow = store.readSamples({ points: 240, windowMs: 30 * 60 * 1000, nowMs: last });
      assert.ok(narrow.total <= 7 && narrow.total > 0, `窗口过滤应生效，实际 ${narrow.total}`);

      // 坏行跳过：不因为一行坏 JSON 让整条曲线空掉
      fs.appendFileSync(store.historyFile, '{ not json\n', 'utf8');
      const afterBad = store.readSamples({ points: 240, windowMs: 24 * 3600 * 1000, nowMs: last + TICK });
      assert.ok(afterBad.total >= 100, '坏行应被跳过而不是整份读不出来');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  ok('② 历史：超过行数上限裁一半（与事件流同一套裁剪）', () => {
    const root = mkTmp('historytrim');
    try {
      const store = createAliveStore(root);
      const base = Date.UTC(2026, 0, 1);
      for (let i = 0; i < 60; i += 1) {
        store.appendSample({ ts: base + i * 1000, phase: 'LOW', tension: 1, fatigue: 1 }, { maxLines: 20 });
      }
      const lines = fs.readFileSync(store.historyFile, 'utf8').split('\n').filter(Boolean).length;
      assert.ok(lines <= 40, `裁剪后应有界（裁一半 → ≤40），实际 ${lines}`);
      assert.ok(lines >= 1, '不该裁空');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  await okAsync('② 心跳会写采样：跑两跳后 history() 能读到', async () => {
    const root = mkTmp('historytick');
    const limits = Object.assign({}, AGENT_LIMITS_DEFAULTS, { aliveTickIntervalMs: TICK });
    let clock = Date.UTC(2026, 0, 1, 9, 0, 0);
    const rt = createAliveRuntime({ userDataPath: root, limits, now: () => clock, rng: seededRng(53) });
    rt.start();
    try {
      await rt.tickOnce();
      clock += TICK;
      await rt.tickOnce();
      const h = rt.history({ points: 240 });
      assert.ok(h.samples.length >= 2, `每跳一条采样，实际 ${h.samples.length}`);
      assert.strictEqual(h.samples[h.samples.length - 1].phase, rt.status().phase, '采样里的相位要与状态一致');
      assert.ok(typeof h.samples[0].ts === 'number' && h.windowMs > 0);
    } finally {
      rt.stop();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  // ───────────────────── H. 设定（拟态 → 设定：一段自由文本）─────────────────────
  ok('设定：写进 settings.json 读得回来，超出字数上限就截断（读写两侧都夹）', () => {
    const root = mkTmp('setup');
    try {
      const store = createAliveStore(root);
      assert.strictEqual(store.readSettings().setup, '', '设定默认空（不内置一段性格：写什么就是什么）');
      const saved = store.writeSettings({
        setup: '  人生目标：把屋里没人管的角落摸清。\r\n遇到人就打个招呼。  '
      });
      assert.strictEqual(saved.setup, '人生目标：把屋里没人管的角落摸清。\n遇到人就打个招呼。', '换行统一、首尾空白去掉');
      assert.strictEqual(store.readSettings().setup, saved.setup);
      // 每轮都要付的 prompt 成本：一段几万字的设定不能反复进状态块
      const huge = '字'.repeat(AGENT_LIMITS_DEFAULTS.aliveSetupMaxChars + 500);
      const capped = store.writeSettings({ setup: huge });
      assert.strictEqual(capped.setup.length, AGENT_LIMITS_DEFAULTS.aliveSetupMaxChars, '写入侧要截断');
      // 手改文件（绕过写入路径）也不能把超长文本带进 prompt
      const raw = JSON.parse(fs.readFileSync(store.settingsFile, 'utf8'));
      raw.setup = '设'.repeat(AGENT_LIMITS_DEFAULTS.aliveSetupMaxChars + 100);
      fs.writeFileSync(store.settingsFile, JSON.stringify(raw), 'utf8');
      assert.strictEqual(
        store.readSettings().setup.length,
        AGENT_LIMITS_DEFAULTS.aliveSetupMaxChars,
        '读取侧也要夹（settings.json 是人可以手改的文件）'
      );
      assert.strictEqual(store.readSettings().enabled, false, '写设定不能把别的开关写坏');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  ok('设定：按原文进状态块，排在事实之前（不拆字段、不加工）', () => {
    const cfg = testCfg();
    const t0 = Date.UTC(2026, 0, 1);
    const state = vitals.createInitialState(cfg, t0);
    tensionEngine.upsertLoops(state, [{ text: '把那份没写完的东西收尾' }], { cfg, nowMs: t0 });
    const block = decide.renderStateBlock(state, cfg, {
      nowMs: t0,
      setup: '人生目标：把屋里没人管的角落摸清。\n遇到人就打个招呼，偶尔聊两句。'
    });
    assert.ok(block.startsWith(ALIVE_STATE_PREFIX), '仍以生命体征前缀开头（合成消息判定不能坏）');
    assert.ok(isSyntheticLoopUserContent(block), '带设定后仍必须被认成合成消息');
    assert.ok(block.includes('用户给你写的设定'), '设定要单独成节');
    assert.ok(block.includes('遇到人就打个招呼'), '原文照贴（按行缩进）');
    assert.ok(block.indexOf('人生目标：') < block.indexOf('未闭合事项'), '设定排在事实之前');
    assert.ok(block.includes('DEFER 要说得出口'), '有设定时要说清"设定 → 这一小步"，否则它照样天天 DEFER');
    assert.ok(!block.includes('用户还没给你写设定'), '有设定时不能再提示"还没写"');
  });

  ok('设定：没写时不替它编一份，只把「你现在缺的正是方向」说出来', () => {
    const cfg = testCfg();
    const state = vitals.createInitialState(cfg, 0);
    const block = decide.renderStateBlock(state, cfg, { nowMs: 0 });
    assert.ok(!block.includes('用户给你写的设定'), '没写设定就不该有这一节');
    assert.ok(block.includes('用户还没给你写设定'), '要告诉它"现在缺的正是方向"（它老 DEFER 的原因）');
  });

  await okAsync('设定：唤醒轮的状态块里真的带上了，且改完下一轮就生效', async () => {
    const root = mkTmp('setupwake');
    const limits = Object.assign({}, AGENT_LIMITS_DEFAULTS, { aliveTickIntervalMs: TICK });
    let clock = Date.UTC(2026, 0, 1, 9, 0, 0);
    const blocks = [];
    const rt = createAliveRuntime({
      userDataPath: root,
      limits,
      now: () => clock,
      rng: seededRng(61),
      turnRunner: async ({ stateBlock }) => {
        blocks.push(stateBlock);
        rt.applyDecision({ decision: 'ACT', intent: '看一眼' });
      }
    });
    try {
      rt.store.writeSettings({ setup: '人生目标：把角落摸清。' });
      await rt.wakeNow();
      assert.strictEqual(blocks.length, 1);
      assert.ok(blocks[0].includes('把角落摸清'), '设定要进唤醒轮状态块');
      rt.store.writeSettings({ setup: '遇到人就打个招呼。' });
      clock += HOUR;
      await rt.wakeNow();
      assert.ok(blocks[1].includes('遇到人就打个招呼'), '改完下一轮就生效（每次唤醒现读 settings.json）');
      assert.ok(!blocks[1].includes('把角落摸清'), '旧设定不该再出现');
      rt.store.writeSettings({ setup: '' });
      clock += HOUR;
      await rt.wakeNow();
      assert.ok(blocks[2].includes('用户还没给你写设定'), '清空后退回"还没写"的说法');
    } finally {
      rt.stop();
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
