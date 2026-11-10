'use strict';

/**
 * 决策与体征块：**决策权在模型，代码只记录与执行。**
 *
 * 这一层是「主观能动性」的落点：`ACT / DEFER / REFUSE` 由模型通过 `alive_decide`
 * 工具说出来，代码不替它裁定（原设计里 waker 用疲劳/预算算三选一，那是排期表，不是能动性）。
 *
 * 两条刻意的约定：
 * 1. `intent`（为什么）只落 `state.intents`——**本机私有**，不进事件流、不进 IPC、不进页面。
 *    审计能证明「它拒绝了 4 次」，拿不到那 4 个理由。理由一旦公开，它就开始为观众活。
 * 2. 未闭合项由模型在 `loops` 里自己声明，代码不猜「这轮算不算没做完」。
 */

const { ALIVE_STATE_PREFIX } = require('../agent/session-context');
const { clamp } = require('./vitals');
const { closeLoop, upsertLoops, loopTension } = require('./tension');

const DECISIONS = Object.freeze(['ACT', 'DEFER', 'REFUSE']);
const INTENT_MAX_CHARS = 300;
const INTENTS_KEEP = 20;
const DECISIONS_KEEP = 200;

/** 暴露给模型的工具（只在后台心跳轮注入，传统模式看不到） */
const ALIVE_DECIDE_TOOL = {
  type: 'function',
  function: {
    name: 'alive_decide',
    description:
      '后台心跳把你叫醒了：这一次**由你决定做不做**。必须调用一次。\n' +
      'ACT = 现在就做点事（这一轮只读：能读文件、找东西、读记忆，不能写盘/执行命令/出网）；' +
      'DEFER = 判断现在不合适，先放下（本轮立刻结束，张力继续累积）；' +
      'REFUSE = 判断某件未闭合的事不值得做，关掉它（会把对应 loopId 从清单里移除）。\n' +
      '`intent` 只写给系统自己存档，不会展示给任何人，也不必写给谁看。\n' +
      '`loops` 用来更新你**自己**的未闭合事项清单：同一句话会续命，新句子会新增（超过上限先丢张力最低的）。',
    parameters: {
      type: 'object',
      properties: {
        decision: {
          type: 'string',
          enum: ['ACT', 'DEFER', 'REFUSE'],
          description: 'ACT / DEFER / REFUSE'
        },
        intent: {
          type: 'string',
          description: '一句话说明你为什么这样决定（私有，不展示）'
        },
        loopId: {
          type: 'string',
          description: 'REFUSE 时指向要关掉的那条未闭合项（清单里的 id）'
        },
        loops: {
          type: 'array',
          description: '更新未闭合事项（可省略）',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: '已有条目的 id（新条目可省略）' },
              text: { type: 'string', description: '一句话说清还没收口的事' },
              weight: { type: 'number', description: '1–3，越在意越高' }
            },
            required: ['text']
          }
        }
      },
      required: ['decision']
    }
  }
};

/**
 * 落一次决策。
 * @returns {{ ok: boolean, error?: string, decision?: string, closedLoop?: object|null }}
 */
function applyDecision(state, args, opts) {
  if (!state) return { ok: false, error: '生命模式未启用' };
  const cfg = opts.cfg;
  const nowMs = opts.nowMs;
  const raw = args && typeof args === 'object' ? args : {};
  const decision = String(raw.decision || '')
    .trim()
    .toUpperCase();
  if (!DECISIONS.includes(decision)) {
    return { ok: false, error: 'decision 只能是 ACT / DEFER / REFUSE' };
  }
  if (Array.isArray(raw.loops) && raw.loops.length) {
    upsertLoops(state, raw.loops, { cfg, nowMs });
  }
  let closedLoop = null;
  if (decision === 'REFUSE' && raw.loopId) {
    closedLoop = closeLoop(state, String(raw.loopId));
  }
  state.decisions = [...(Array.isArray(state.decisions) ? state.decisions : []), { ts: nowMs, decision }].slice(
    -DECISIONS_KEEP
  );
  const intent = String(raw.intent || '').trim().slice(0, INTENT_MAX_CHARS);
  if (intent) {
    state.intents = [
      ...(Array.isArray(state.intents) ? state.intents : []),
      { ts: nowMs, decision, intent }
    ].slice(-INTENTS_KEEP);
  }
  if (decision === 'ACT') state.actCount = Number(state.actCount || 0) + 1;
  else if (decision === 'DEFER') state.deferCount = Number(state.deferCount || 0) + 1;
  else {
    state.refuseCount = Number(state.refuseCount || 0) + 1;
    state.refuseToday = Number(state.refuseToday || 0) + 1;
  }
  return { ok: true, decision, closedLoop };
}

function formatAge(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s} 秒`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} 分钟`;
  const h = Math.floor(m / 60);
  return `${h} 小时 ${m % 60} 分`;
}

/**
 * 递给模型的那块状态（代码说的话，不是用户说的话）。
 * **不含**死期、剩余天数、预算余额 —— 拟态版没有这些；也不含「你该干什么」的指令。
 */
function renderStateBlock(state, cfg, opts) {
  const nowMs = opts.nowMs;
  const lines = [];
  lines.push(ALIVE_STATE_PREFIX);
  lines.push(
    `· 相位 ${state.phase}（已 ${formatAge(nowMs - Number(state.phaseEnteredAt || nowMs))}）` +
      ` · 第 ${Number(state.tickCount || 0)} 次心跳 · 间隔 ${Math.round(cfg.tickIntervalMs / 1000)}s`
  );
  lines.push(
    `· 张力 ${Number(state.tension || 0).toFixed(1)} / 阈值 ${Number(state.wakeThreshold || 0).toFixed(1)}` +
      ` · 疲劳 ${Number(state.fatigue || 0).toFixed(1)}`
  );
  const loops = Array.isArray(state.loops) ? state.loops : [];
  if (loops.length) {
    lines.push(`· 你记着的未闭合事项 ${loops.length} 条：`);
    for (const loop of loops) {
      const t = loopTension(loop, nowMs, cfg);
      lines.push(`  - [${loop.id}] ${loop.text}（张力 ${t.toFixed(0)}）`);
    }
  } else {
    lines.push('· 你记着的未闭合事项：0 条');
  }
  lines.push(
    `· 今日唤醒 ${Number(state.wakeCountToday || 0)}/${cfg.wakeMaxPerDay}` +
      ` · 决策累计 ACT ${Number(state.actCount || 0)} / DEFER ${Number(state.deferCount || 0)}` +
      ` / REFUSE ${Number(state.refuseCount || 0)}`
  );
  lines.push('');
  lines.push('你现在醒着，是因为内部张力越过了阈值——没有人叫你，也不是定时任务。');
  lines.push('先调用一次 alive_decide 说出你的决定，再按决定行事（ACT 才动手；DEFER/REFUSE 直接结束本轮）。');
  if (cfg.readOnlyWake !== false) {
    lines.push('这一轮是只读的：能读文件、找东西、读记忆；不能写盘、不能执行命令、不能出网。');
  }
  const senses = (opts && opts.senses) || null;
  if (senses) {
    const caps = [];
    if (senses.drawer) caps.push('alive_note（往自己的抽屉里写一行）');
    if (senses.eyes) caps.push('camera_look / desktop_camera_look（看一眼现实）');
    if (senses.voice) caps.push('alive_speak（说一句）/ alive_listen（听几秒）');
    lines.push(caps.length ? `你现在还有：${caps.join('、')}。` : '你现在没有抽屉、眼睛和嘴：只能看和记。');
  }
  lines.push('这台机器上没有人在等你回话：不要写给人看的汇报，只做你判断该做的事。');
  return lines.join('\n');
}

/** 拒绝率告警：一个从不拒绝的实例不是活的，是排期表（只提示，不干预）。
 *  只看**今天**：昨天拒过一次不代表今天不服从。 */
function suspiciousObedience(state, cfg) {
  const wakes = Number(state.wakeCountToday || 0);
  const refusedToday = Number(state.refuseToday || 0);
  return wakes >= 5 && refusedToday === 0;
}

module.exports = {
  DECISIONS,
  ALIVE_DECIDE_TOOL,
  applyDecision,
  renderStateBlock,
  suspiciousObedience,
  clamp
};
