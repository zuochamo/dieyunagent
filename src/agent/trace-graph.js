'use strict';

/**
 * 轨迹图的数据整形 —— **唯一来源**（纯函数，无 DOM、无全局）。
 *
 * 输入就是思考区那份 trace（Main 的 `agent_traces.trace_json` 与 Renderer 的
 * `sessionActiveRuns.get(sid).trace` 同形），输出一张「泳道图」：
 *
 * ```
 * 主线            ├─ 勘察 ─┤├─ 拆解 ─┤├──── 调度 ────┤├─ 验收 ─┤
 * 写入子 Agent #2                 ├────── 改 alpha ──────┤
 * 写入子 Agent #3                 ├───── 改 beta ───┤
 * 勘察子 Agent #1        ├── 调研 ──┤
 * ```
 *
 * 三条设计约束（都是被数据逼出来的）：
 * 1. **时间戳可能没有**：老会话 / 老版本落库的 trace 里没有 `startedAt`。这时不能谎报时长，
 *    直接 `degraded:true` 按序号等宽铺 —— 布局退化，但**泳道与并发关系仍然正确**。
 * 2. **一个子 Agent = 一条泳道**：子 Agent 卡片把全部轮次装在 `rounds` 里，所以它的泳道由
 *    多个 span（每轮一个）拼成；卡片级的 `startedAt/endedAt` 只用于兜底。
 * 3. **顺序按时间排，不按数组顺序**：trace 里子 Agent 卡片曾经被 append 到「汇总」之后
 *    （2026-11-19 审计），按数组画会画成“先汇总后干活”。有 `startedAt` 就按它排；
 *    没有就保持数组顺序（并在结果里标 `degraded`，让 UI 说得出来）。
 */

const MAIN_LANE_ID = 'main';

function toNum(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** 卡片标题去掉状态后缀（「· 已完成」「· 运行中…」），泳道名要短。 */
function laneLabel(entry) {
  const phase = String((entry && entry.phase) || '').trim();
  const cut = phase.indexOf(' · ');
  if (cut > 0) {
    const tail = phase.slice(cut + 3);
    // 只砍状态类尾巴，不砍「· 同步 README 与 AGENTS.md」这种真标题
    if (/^(已完成|运行中|准备中|失败|已停止)/.test(tail)) return phase.slice(0, cut);
  }
  return phase || '（无标题）';
}

function countFailed(tools) {
  let n = 0;
  for (const t of tools || []) {
    if (!t) continue;
    if (t.failed || t.error || (t.result && t.result.ok === false)) n += 1;
  }
  return n;
}

/**
 * 把一张 entry（或它的某一轮）转成 span。
 *
 * `text` 是**节点上要显示的事件内容摘要**（模型这一轮在想什么 / 这一步在干什么）：
 * 图里只能放一小段（节点要标得下），完整正文仍在「子代理」页与思考区。
 *
 * @param {{ entryIndex: number, round?: number, label: string, text?: string, startedAt?: number,
 *           endedAt?: number, tools?: any[], running?: boolean, now: number }} input
 */
function buildSpan(input) {
  const tools = Array.isArray(input.tools) ? input.tools : [];
  const start = toNum(input.startedAt);
  const ended = toNum(input.endedAt);
  // 「还在跑」= **有开始时间、没有结束时间**。没有开始时间（老数据 / 这一版没记到）不是运行中，
  // 否则整条支路会在图上一直闪“进行中”，把几分钟前的历史运行画成还没跑完。
  const running = !ended && start > 0 && input.running !== false;
  const end = ended || (running ? Math.max(input.now || 0, start) : start);
  const text = String(input.text || '').replace(/\s+/g, ' ').trim();
  return {
    entryIndex: input.entryIndex,
    round: input.round || 0,
    label: input.label,
    text: text.length > 160 ? `${text.slice(0, 160)}…` : text,
    start,
    end,
    timed: start > 0,
    running: !!running,
    tools: tools.length,
    failed: countFailed(tools)
  };
}

/**
 * @param {Array} trace 思考区 trace（含 isolated 子 Agent 卡片）
 * @param {{ now?: number }} [opts]
 */
function buildTraceGraph(trace, opts = {}) {
  const now = toNum(opts.now) || Date.now();
  const list = Array.isArray(trace) ? trace : [];
  /** @type {Map<string, any>} */
  const lanes = new Map();
  let degraded = false;

  const ensureLane = (id, kind, label) => {
    let lane = lanes.get(id);
    if (!lane) {
      lane = { id, kind, label, status: 'done', spans: [], startedAt: 0, endedAt: 0 };
      lanes.set(id, lane);
    }
    return lane;
  };

  const mainLane = ensureLane(MAIN_LANE_ID, 'main', '主线');

  list.forEach((entry, entryIndex) => {
    if (!entry || typeof entry !== 'object') return;
    const isolated = !!entry.isolated;
    const lane = isolated
      ? ensureLane(
          String(entry.subagentId || `subagent-${entryIndex}`),
          'subagent',
          laneLabel(entry)
        )
      : mainLane;

    // 子 Agent：一轮一个 span；没有 rounds 的旧数据结构就整张卡算一个 span。
    const rounds = isolated && Array.isArray(entry.rounds) && entry.rounds.length ? entry.rounds : null;
    if (rounds) {
      for (const r of rounds) {
        const span = buildSpan({
          entryIndex,
          round: r && r.round,
          label: `第 ${(r && r.round) || '?'} 轮`,
          text: (r && (r.thought || r.fullThought)) || '',
          startedAt: r && r.startedAt,
          endedAt: r && r.endedAt,
          tools: (r && r.tools) || [],
          now
        });
        if (!span.timed) degraded = true;
        if (span.running) lane.status = 'running';
        lane.spans.push(span);
      }
      // 卡片级时间兜底：轮次没有时间时，用卡片整体的起止把这条泳道画成一整块
      const cardStart = toNum(entry.startedAt);
      const cardEnd = toNum(entry.endedAt);
      if (lane.spans.every((s) => !s.timed) && cardStart) {
        lane.spans = [
          buildSpan({
            entryIndex,
            round: entry.round,
            label: laneLabel(entry),
            text: entry.thought || entry.fullThought || '',
            startedAt: cardStart,
            endedAt: cardEnd,
            tools: (Array.isArray(entry.rounds) ? entry.rounds : []).flatMap((r) => (r && r.tools) || []),
            now
          })
        ];
      }
    } else {
      const span = buildSpan({
        entryIndex,
        round: entry.round,
        // 主线的每一条不一定有 phase（普通轮次只有 round）：没有就留空，
        // 由渲染层退回用 text（这一轮在想什么）当节点标签 —— 空白标签等于没标。
        label: entry.phase ? laneLabel(entry) : '',
        text: entry.thought || entry.fullThought || '',
        startedAt: entry.startedAt,
        endedAt: entry.endedAt,
        tools: entry.tools || [],
        now
      });
      if (!span.timed) degraded = true;
      if (span.running && !isolated) lane.status = 'running';
      lane.spans.push(span);
    }
  });

  // 泳道内按时间（或数组顺序）排；有时间的整体再按开始时间排泳道
  for (const lane of lanes.values()) {
    if (lane.spans.some((s) => s.timed)) {
      lane.spans.sort((a, b) => a.start - b.start || a.entryIndex - b.entryIndex);
    }
    const timed = lane.spans.filter((s) => s.timed);
    if (timed.length) {
      lane.startedAt = Math.min(...timed.map((s) => s.start));
      const ends = timed.filter((s) => !s.running).map((s) => s.end);
      lane.endedAt = ends.length ? Math.max(...ends) : Math.max(...timed.map((s) => s.end));
    }
  }

  const allLanes = [...lanes.values()];
  const extra = allLanes
    .filter((l) => l.kind === 'subagent')
    .sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0) || a.label.localeCompare(b.label));

  // 主线永远在最上：它是读图的第一落点
  const ordered = [mainLane, ...extra];
  const visible = ordered.filter((l) => l.spans.length);

  // 全图有没有任何时间戳：一条都没有才整张退化成顺序图。
  // 只有个别 span 缺时间（例如终态那行占位没记到）时，把那根画成泳道末尾的竖线，
  // 而不是把整张图降级 —— 混着画比整张退化更接近事实。
  const anyTimed = visible.some((l) => l.spans.some((s) => s.timed));
  if (!anyTimed) {
    degraded = true;
    for (const lane of visible) {
      lane.spans = lane.spans.map((s, i) => ({ ...s, start: i, end: i + 1, timed: false }));
    }
  } else {
    degraded = false;
    const liveStart = Math.min(
      ...visible.flatMap((l) => l.spans.filter((s) => s.timed).map((s) => s.start))
    );
    for (const lane of visible) {
      let cursor = lane.startedAt || liveStart;
      for (const s of lane.spans) {
        if (s.timed) {
          cursor = Math.max(cursor, s.end);
          continue;
        }
        s.start = cursor;
        s.end = cursor;
        s.untimed = true;
      }
    }
  }

  const timedSpans = visible.flatMap((l) => l.spans.filter((s) => s.timed));
  const range = timedSpans.length
    ? {
        start: Math.min(...timedSpans.map((s) => s.start)),
        end: Math.max(...timedSpans.map((s) => s.end)),
        // 退化模式下横轴是「序号」，不是时间
        unit: 'ms'
      }
    : { start: 0, end: visible.reduce((n, l) => Math.max(n, l.spans.length), 1), unit: 'index' };

  return {
    degraded,
    range,
    lanes: visible,
    totals: {
      lanes: visible.length,
      spans: visible.reduce((n, l) => n + l.spans.length, 0),
      tools: visible.reduce((n, l) => n + l.spans.reduce((m, s) => m + s.tools, 0), 0),
      failed: visible.reduce((n, l) => n + l.spans.reduce((m, s) => m + s.failed, 0), 0),
      wallMs: degraded ? 0 : Math.max(0, range.end - range.start)
    }
  };
}

module.exports = { buildTraceGraph, MAIN_LANE_ID, laneLabel };
