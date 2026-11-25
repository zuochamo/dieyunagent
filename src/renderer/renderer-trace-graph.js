/* global document, TraceGraph, setTracePaneMode */
'use strict';

/**
 * 「轨迹」页 →「轨迹图」子标签的渲染（**只画，不判**）。
 *
 * 数据整形全在 `src/agent/trace-graph.js`（纯函数，Main 与 Renderer 同一份）。
 *
 * ## 视觉：顺时针 45° 的电路板
 *
 * 主线是**斜向总线**（左上 → 右下），时间沿总线方向推进；子 Agent 是**从总线引出的支路**，
 * **左右两侧交替**分布（+1 右下侧、−1 左上侧、+2 / −2 …），这样矩形空间（尤其窄高侧栏）
 * 被斜向摊开，而不是一路向下排成一条长条。
 *
 * 坐标是**手算**的，不是给整组套 `rotate(45)`：
 * `P(t, side) = u * s(t) + n(side) * d(lane)`
 * 其中 `u = (c, c)`，`n = side × (−c, c)`，`c = √2/2`。
 * 这样**焊盘/走线是斜的**（用 `transform="rotate(45 …)"` 让矩形跟着板子转），而**文字保持水平** ——
 * 整体 transform 会把泳道名和时间刻度一起转 45°，直接没法读。
 *
 * 其余约定：
 * - 配色：主线 `currentColor`（跟随主题黑白），只有子 Agent 支路带色相；
 * - 失败不用红色：**虚线框 + ✕**；
 * - 没有时间戳（老数据）时不画刻度，按顺序等距铺。
 */

const TRACE_GRAPH_MAX_TICKS = 5;
/** 45° 的两个分量 */
const C = Math.SQRT1_2;
/** 支路之间的法向间距（px） */
const LANE_GAP = 34;
const PAD_PAD = 18;
const MIN_DRAW_W = 320;
const SUBAGENT_HUES = [200, 268, 330, 155, 32, 96];
const SVG_NS = 'http://www.w3.org/2000/svg';
/** 相邻节点标签的最小水平间距（斜向排布下太密就不标，避免叠字） */
const MIN_LABEL_GAP = 56;

function clipLabel(text, max) {
  const s = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
  if (!s) return '';
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function formatTraceSpanMs(ms) {
  const n = Math.max(0, Number(ms) || 0);
  if (n < 1000) return `${Math.round(n)}ms`;
  if (n < 60_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}s`;
  const m = Math.floor(n / 60_000);
  const s = Math.round((n % 60_000) / 1000);
  return s ? `${m}m${s}s` : `${m}m`;
}

function svgEl(tag, attrs) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null) continue;
    el.setAttribute(k, String(v));
  }
  return el;
}

function laneColor(lane, index) {
  if (!lane || lane.kind === 'main') return 'currentColor';
  const hue = SUBAGENT_HUES[(index - 1 + SUBAGENT_HUES.length) % SUBAGENT_HUES.length];
  return `hsl(${hue} 52% 58%)`;
}

/** 子 Agent 分布在主线两侧：0 → 0（主线），1 → +1，2 → −1，3 → +2 … */
function laneSide(index) {
  if (index === 0) return 0;
  const n = Math.ceil(index / 2);
  return index % 2 === 1 ? n : -n;
}

function traceGraphEmptyState(text, hint) {
  const box = document.createElement('div');
  box.className = 'trace-graph-empty';
  const title = document.createElement('div');
  title.className = 'subagent-panel-empty-title';
  title.textContent = text;
  box.appendChild(title);
  if (hint) {
    const sub = document.createElement('div');
    sub.className = 'subagent-panel-empty-hint';
    sub.textContent = hint;
    box.appendChild(sub);
  }
  return box;
}

/**
 * 斜向坐标框架：时间 → 沿板子的距离；泳道 → 法向偏移。
 *
 * @param {{start:number, end:number}} range
 * @param {number} length 板子沿主线方向的长度（px）
 */
function makeFrame(range, length) {
  const span = Math.max(1, range.end - range.start);
  return {
    span,
    length,
    /** @param {number} ms @param {number} side 法向（0 = 主线） */
    at(ms, side) {
      const s = ((Number(ms) || 0) - range.start) / span * length;
      const d = side * LANE_GAP;
      return { x: s * C - d * C, y: s * C + d * C };
    }
  };
}

/** 时间刻度：短线垂直于主线，文字保持水平。 */
function appendAxis(g, frame) {
  const axis = svgEl('g', { class: 'trace-graph-axis', 'data-role': 'axis' });
  for (let i = 0; i < TRACE_GRAPH_MAX_TICKS; i += 1) {
    const ratio = i / (TRACE_GRAPH_MAX_TICKS - 1);
    const p = frame.at(frame.rangeStart + frame.span * ratio, 0);
    axis.appendChild(svgEl('line', {
      x1: p.x - 4 * C,
      y1: p.y - 4 * C,
      x2: p.x + 4 * C,
      y2: p.y + 4 * C,
      stroke: 'currentColor',
      'stroke-width': 1,
      'stroke-opacity': 0.35
    }));
    const label = svgEl('text', {
      x: p.x + 8 * C,
      y: p.y - 8 * C,
      'text-anchor': 'middle',
      'font-size': 9,
      fill: 'currentColor',
      'fill-opacity': 0.5
    });
    label.textContent = i === 0 ? '0' : `+${formatTraceSpanMs(frame.span * ratio)}`;
    axis.appendChild(label);
  }
  g.appendChild(axis);
  return axis;
}

/**
 * 一条支路：斜向走线 + 焊盘 + （子 Agent）与主线的两条直角连接。
 */
function appendLane(root, lane, index, frame) {
  const side = laneSide(index);
  const color = laneColor(lane, index);
  const g = svgEl('g', {
    class: 'trace-graph-lane',
    'data-lane': lane.id,
    'data-kind': lane.kind,
    'data-side': side
  });

  const timed = lane.spans.filter((s) => s.timed);
  const firstStart = timed.length ? timed[0].start : lane.spans[0].start;
  const lastEnd = timed.length
    ? Math.max(...timed.map((s) => s.end))
    : lane.spans[lane.spans.length - 1].end;

  const pStart = frame.at(firstStart, side);
  const pEnd = frame.at(lastEnd, side);

  // 支线本体：**一根线**（不加框、不加厚块 —— 加粗块看起来像管道）
  g.appendChild(svgEl('line', {
    x1: pStart.x,
    y1: pStart.y,
    x2: pEnd.x,
    y2: pEnd.y,
    stroke: color,
    'stroke-width': 1,
    'stroke-opacity': lane.kind === 'main' ? 0.5 : 0.6
  }));

  // 子 Agent：**一条**直角支线从总线引出来（不画收回线，避免两条线看起来像管道），
  // 交接处一个过孔点；支线末端自然收在最后一轮。
  if (side !== 0) {
    const onMain = frame.at(firstStart, 0);
    g.appendChild(svgEl('path', {
      d: `M ${onMain.x} ${onMain.y} L ${pStart.x} ${pStart.y}`,
      fill: 'none',
      stroke: color,
      'stroke-width': 1,
      'stroke-opacity': 0.5
    }));
    g.appendChild(svgEl('circle', {
      cx: onMain.x,
      cy: onMain.y,
      r: 1.8,
      fill: color,
      'fill-opacity': 0.9
    }));
  }

  // 每一轮 = 线上的一个**节点**（时长靠节点间距表达）；失败在节点上打 ✕
  let lastLabelX = -Infinity;
  for (const span of lane.spans) {
    const isFirstSpan = span === lane.spans[0];
    const mid = span.timed
      ? (Math.max(span.start, firstStart) + Math.min(span.end, lastEnd)) / 2 || span.start
      : span.start;
    const center = frame.at(mid, side);
    const node = svgEl('g', { class: 'trace-graph-node', 'data-round': span.round || 0 });

    node.appendChild(
      svgEl('circle', {
        cx: center.x,
        cy: center.y,
        r: span.running ? 2.6 : 2,
        fill: color,
        'fill-opacity': span.untimed ? 0.35 : 0.95,
        ...(span.untimed ? { 'stroke-dasharray': '1 1' } : {})
      })
    );

    if (span.failed) {
      node.appendChild(svgEl('path', {
        d: `M ${center.x - 4} ${center.y - 4} L ${center.x + 4} ${center.y + 4} M ${center.x + 4} ${center.y - 4} L ${center.x - 4} ${center.y + 4}`,
        fill: 'none',
        stroke: color,
        'stroke-width': 1.2,
        'stroke-opacity': 0.95
      }));
    }

    const title = [
      span.round ? `第 ${span.round} 轮` : span.label,
      span.tools ? `${span.tools} 次工具` : '',
      span.failed ? `${span.failed} 次失败` : '',
      span.running ? '进行中' : span.timed ? formatTraceSpanMs(span.end - span.start) : '未记到时间'
    ].filter(Boolean);
    // 悬浮看事件内容（节点标不下的那句），完整正文在「子代理」页 / 思考区
    node.appendChild(svgEl('title', {})).textContent =
      title.join(' · ') + (span.text ? `\n${span.text}` : '');

    // ── 节点标签：标「这一步在干什么」（阶段名 / 第 N 轮）
    // 斜向排布下相邻点很近，所以按**沿板方向的最小间距**决定标不标；失败 / 进行中 / 首个节点强制标。
    const forced = !!span.failed || !!span.running || isFirstSpan;
    if (forced || Math.abs(center.x - lastLabelX) >= MIN_LABEL_GAP) {
      // 有阶段名就用阶段名（勘察 / 汇总 / 写入子 Agent #3），没有就用这一轮在想什么
      const short = clipLabel(span.label || span.text || (span.round ? `第 ${span.round} 轮` : ''), 14);
      if (short) {
        // 法向偏移一点点就够：太多会和邻线撞上。主线往“右上”偏，支线往自己那一侧偏
        const offX = side === 0 ? 9 * C : -side * 9 * C;
        const offY = side === 0 ? -9 * C : side * 9 * C;
        const labelEl = svgEl('text', {
          x: center.x + offX,
          y: center.y + offY,
          'text-anchor': 'middle',
          'dominant-baseline': 'middle',
          'font-size': 9,
          fill: 'currentColor',
          'fill-opacity': span.failed ? 0.85 : 0.55,
          class: 'trace-graph-node-label'
        });
        labelEl.textContent = short;
        node.appendChild(labelEl);
        lastLabelX = center.x;
      }
    }

    if (lane.kind === 'subagent') {
      node.setAttribute('class', 'trace-graph-node is-clickable');
      node.addEventListener('click', () => {
        if (typeof setTracePaneMode === 'function') setTracePaneMode('subagents');
      });
    }
    g.appendChild(node);
  }

  // 支路名：贴在支路起点外侧，水平文字
  const labelAt = frame.at(firstStart, side);
  const out = 12;
  const anchor = svgEl('text', {
    x: labelAt.x - side * out * C,
    y: labelAt.y + side * out * C - (side === 0 ? 10 : 0),
    'text-anchor': side >= 0 ? 'start' : 'end',
    'font-size': lane.kind === 'main' ? 11 : 10,
    'font-weight': lane.kind === 'main' ? 600 : 400,
    fill: 'currentColor',
    'fill-opacity': lane.kind === 'main' ? 0.9 : 0.6
  });
  anchor.textContent = side === 0 ? `${lane.label}（主线）` : lane.label;
  g.appendChild(anchor);

  if (lane.status === 'running') {
    g.appendChild(svgEl('circle', {
      cx: pEnd.x,
      cy: pEnd.y,
      r: 2.6,
      fill: color,
      'fill-opacity': 0.9,
      class: 'trace-graph-lane-live'
    }));
  }

  root.appendChild(g);
}

function renderTraceGraph(mount, snap) {
  if (!mount) return;
  const trace = Array.isArray(snap && snap.trace) ? snap.trace : [];
  if (typeof TraceGraph === 'undefined' || typeof TraceGraph.buildTraceGraph !== 'function') {
    mount.replaceChildren(traceGraphEmptyState('轨迹图数据层未加载（agent-bundle 未重建？）'));
    return;
  }
  const graph = TraceGraph.buildTraceGraph(trace, { now: Date.now() });
  mount.replaceChildren();
  if (!graph.lanes.length) {
    mount.appendChild(
      traceGraphEmptyState('这次运行还没有可画的轨迹', '发一条消息后，主线与派发出去的子 Agent 会按时间画在这里。')
    );
    return;
  }

  const summary = document.createElement('div');
  summary.className = 'trace-graph-summary';
  const wall = graph.degraded
    ? '无时间戳（老数据未记录起止），按顺序排列'
    : `墙钟 ${formatTraceSpanMs(graph.totals.wallMs)}`;
  summary.textContent = `${graph.totals.lanes} 条支路 · ${graph.totals.spans} 个节点 · 工具 ${graph.totals.tools}${
    graph.totals.failed ? ` · 失败 ${graph.totals.failed}` : ''
  } · ${wall}`;
  mount.appendChild(summary);

  const width = Math.max(
    MIN_DRAW_W,
    Math.floor(Number(mount.clientWidth) || Number(mount.getBoundingClientRect?.().width) || 0) || MIN_DRAW_W
  );
  // 板子长度：斜着放要除以 √2 才不超宽，留一点边
  const boardLen = Math.max(220, (width - PAD_PAD * 2) / C);
  const frame = makeFrame(graph.range, boardLen);
  frame.rangeStart = graph.range.start;

  // 先画到一个临时组里，再按包围盒平移 + 定 viewBox（斜向布局不能预设宽高）
  const draw = svgEl('g', {});
  if (!graph.degraded) appendAxis(draw, frame);
  graph.lanes.forEach((lane, i) => appendLane(draw, lane, i, frame));

  const box = boundsOf(draw);
  const pad = PAD_PAD;
  // 缩放时线宽保持 1px（否则放大后线条会变成粗管、缩小后消失）
  for (const el of walkTree(draw)) {
    const tag = String(el.tagName || '');
    if (tag === 'line' || tag === 'path' || tag === 'circle') {
      el.setAttribute('vector-effect', 'non-scaling-stroke');
    }
  }
  // 斜向布局的宽高事先算不准：先按容器宽度定缩比，再用同一个缩比算高度，
  // 避免 viewBox 比例与 height 属性不一致时被浏览器 letterbox 缩小。
  const boxW = Math.max(1, box.maxX - box.minX + pad * 2);
  const boxH = Math.max(1, box.maxY - box.minY + pad * 2);
  const scale = width / boxW;
  const height = Math.max(60, Math.round(boxH * scale));
  const viewBox = { x: box.minX - pad, y: box.minY - pad, w: boxW, h: boxH };
  const svg = svgEl('svg', {
    class: 'trace-graph-svg',
    width: '100%',
    height,
    viewBox: `${viewBox.x} ${viewBox.y} ${viewBox.w} ${viewBox.h}`,
    role: 'img',
    'aria-label': '本次运行的轨迹：斜向主线与分布在两侧的子 Agent 支路'
  });
  svg.appendChild(draw);
  // 缩放 / 平移：状态挂在 svg 上（每次刷新会重建节点，状态跟着重放）
  attachTraceGraphView(mount, svg, draw, viewBox, String((snap && snap.runId) || ''));
  mount.appendChild(svg);

  const hint = document.createElement('div');
  hint.className = 'trace-graph-hint';
  hint.textContent = '滚轮缩放 · 按住拖动平移 · 双击复位';
  mount.appendChild(hint);
}

/* ── 缩放 / 平移 ────────────────────────────────────────────────────────────
   为什么不用 CSS `transform: scale`：那把线宽、字号一起放大，图上会出现一像素变四像素的糊线。
   这里改**绘制组的 transform**（`translate × scale`），配合 `vector-effect` 保持线宽稳定。 */

const TRACE_VIEW_MIN_SCALE = 0.4;
const TRACE_VIEW_MAX_SCALE = 12;

/** 每个会话记住的视图状态（刷新不丢缩放；换一次运行才复位）。 */
const traceGraphViews = new Map();

function clampTraceScale(s) {
  const n = Number(s);
  if (!Number.isFinite(n) || n <= 0) return 1;
  return Math.min(TRACE_VIEW_MAX_SCALE, Math.max(TRACE_VIEW_MIN_SCALE, n));
}

/**
 * 以 `point`（用户坐标系里的一点）为中心缩放：该点在屏幕上的位置保持不变。
 *
 * `screen = translate + scale × world` ⇒ `world = (screen − translate) / scale`，
 * 缩放后要让 world 落在同一个 screen 上，于是 `translate' = screen − world × scale'`。
 * 纯函数：便于单测（UI 里只是把它算出来的结果写回 transform）。
 */
function zoomTraceView(view, point, factor) {
  const scale = clampTraceScale((view.scale || 1) * factor);
  const px = Number(point && point.x) || 0;
  const py = Number(point && point.y) || 0;
  const wx = (px - (view.x || 0)) / (view.scale || 1);
  const wy = (py - (view.y || 0)) / (view.scale || 1);
  return { scale, x: px - wx * scale, y: py - wy * scale };
}

/** 客户端像素 → 用户坐标（用 viewBox + 元素矩形换算，不依赖 getScreenCTM，测试里也能算）。 */
function clientToUser(rect, viewBox, clientX, clientY) {
  const left = Number(rect && rect.left) || 0;
  const top = Number(rect && rect.top) || 0;
  const w = Number(rect && rect.width) || 0;
  const h = Number(rect && rect.height) || 0;
  if (!w || !h) return { x: viewBox.x + viewBox.w / 2, y: viewBox.y + viewBox.h / 2 };
  return {
    x: viewBox.x + ((clientX - left) / w) * viewBox.w,
    y: viewBox.y + ((clientY - top) / h) * viewBox.h
  };
}

function attachTraceGraphView(mount, svg, draw, viewBox, runKey) {
  const key = runKey || 'current';
  let view = traceGraphViews.get(key);
  if (!view) {
    view = { scale: 1, x: 0, y: 0 };
    traceGraphViews.set(key, view);
    // 每次运行的视图状态只留最近几条：长会话里 runId 会一直变，不清就是内存泄漏
    while (traceGraphViews.size > 8) {
      const oldest = traceGraphViews.keys().next().value;
      if (oldest === key) break;
      traceGraphViews.delete(oldest);
    }
  }
  const apply = () => {
    // translate 在前、scale 在后：与 zoomTraceView 的 `screen = t + s × world` 一致
    draw.setAttribute('transform', `translate(${view.x} ${view.y}) scale(${view.scale})`);
  };
  apply();

  const rectOf = () => (svg.getBoundingClientRect ? svg.getBoundingClientRect() : null);
  const toUser = (clientX, clientY) => clientToUser(rectOf(), viewBox, clientX, clientY);

  // 滚轮缩放：以指针位置为中心（Ctrl 不必按）。`passive:false` 才能 preventDefault 掉页面滚动。
  svg.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      const factor = Math.exp(-(Number(e.deltaY) || 0) * 0.0015);
      view = zoomTraceView(view, toUser(e.clientX, e.clientY), factor);
      traceGraphViews.set(key, view);
      apply();
    },
    { passive: false }
  );

  // 按住拖动平移（含触屏：pointer 事件统一处理）
  let dragging = false;
  let moved = false;
  let startClient = { x: 0, y: 0 };
  let startView = { x: 0, y: 0 };
  const onDown = (e) => {
    if (e.button != null && e.button !== 0) return;
    dragging = true;
    moved = false;
    startClient = { x: e.clientX || 0, y: e.clientY || 0 };
    startView = { x: view.x, y: view.y };
    if (svg.setPointerCapture && e.pointerId != null) {
      try {
        svg.setPointerCapture(e.pointerId);
      } catch {
        // ignore
      }
    }
    mount.classList.add('is-panning');
  };
  const onMove = (e) => {
    if (!dragging) return;
    const dx = (e.clientX || 0) - startClient.x;
    const dy = (e.clientY || 0) - startClient.y;
    if (Math.abs(dx) + Math.abs(dy) > 3) moved = true;
    const rect = rectOf();
    const w = Number(rect && rect.width) || 0;
    const h = Number(rect && rect.height) || 0;
    if (!w || !h) return;
    view = {
      scale: view.scale,
      x: startView.x + (dx / w) * viewBox.w,
      y: startView.y + (dy / h) * viewBox.h
    };
    traceGraphViews.set(key, view);
    apply();
    if (moved && e.preventDefault) e.preventDefault();
  };
  const onUp = () => {
    if (!dragging) return;
    dragging = false;
    mount.classList.remove('is-panning');
    // 拖完紧接着的那次 click 不该被当成「点节点」：捕获阶段吞掉它
    if (moved) {
      const swallow = (ev) => {
        ev.stopPropagation();
        ev.preventDefault();
        svg.removeEventListener('click', swallow, true);
      };
      svg.addEventListener('click', swallow, true);
    }
  };
  svg.addEventListener('pointerdown', onDown);
  svg.addEventListener('pointermove', onMove);
  svg.addEventListener('pointerup', onUp);
  svg.addEventListener('pointercancel', onUp);
  svg.addEventListener('pointerleave', onUp);

  // 双击复位
  svg.addEventListener('dblclick', (e) => {
    e.preventDefault();
    view = { scale: 1, x: 0, y: 0 };
    traceGraphViews.set(key, view);
    apply();
  });
}

/**
 * 包围盒：从画出来的图元反算（斜向布局宽高事先算不准）。
 * 只认 rect/line/circle/path 的显式坐标 —— 我们的图元都是自己生成的，不依赖 getBBox。
 */
function boundsOf(group) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const push = (x, y) => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  };
  const num = (v) => Number(v) || 0;
  for (const el of walkTree(group)) {
    const t = String(el.tagName || '');
    // 用 getAttribute 读回：真 DOM 上 setAttribute 不会在对象上留可读副本
    const attr = (name) => (el.getAttribute ? el.getAttribute(name) : null);
    if (t === 'line') {
      push(num(attr('x1')), num(attr('y1')));
      push(num(attr('x2')), num(attr('y2')));
    } else if (t === 'rect') {
      // 焊盘带 rotate(45 cx cy)：用中心 ± 半对角线估外接框（宁可大一点）
      const w = num(attr('width'));
      const h = num(attr('height'));
      const cx = num(attr('x')) + w / 2;
      const cy = num(attr('y')) + h / 2;
      const r = Math.hypot(w, h) / 2;
      push(cx - r, cy - r);
      push(cx + r, cy + r);
    } else if (t === 'circle') {
      push(num(attr('cx')) - num(attr('r')), num(attr('cy')) - num(attr('r')));
      push(num(attr('cx')) + num(attr('r')), num(attr('cy')) + num(attr('r')));
    } else if (t === 'text') {
      // 文字按锚点附近估一个框（右锚往左伸）
      push(num(attr('x')) - 60, num(attr('y')) - 10);
      push(num(attr('x')) + 60, num(attr('y')) + 10);
    } else if (t === 'path') {
      for (const m of String(attr('d') || '').matchAll(/([ML])\s*(-?[\d.]+)\s+(-?[\d.]+)/g)) {
        push(Number(m[2]), Number(m[3]));
      }
    }
  }
  if (!Number.isFinite(minX)) return { minX: 0, minY: 0, maxX: 100, maxY: 100 };
  return { minX, minY, maxX, maxY };
}

function walkTree(node, out = []) {
  out.push(node);
  for (const kid of node.children || []) walkTree(kid, out);
  return out;
}

window.renderTraceGraph = renderTraceGraph;
window.formatTraceSpanMs = formatTraceSpanMs;
// 纯函数导出：单测直接验缩放数学（浏览器里也给预览页用）
window.zoomTraceView = zoomTraceView;
window.clampTraceScale = clampTraceScale;
