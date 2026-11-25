'use strict';

/**
 * 轨迹图渲染层（`src/renderer/renderer-trace-graph.js`）的 DOM 契约 —— **顺时针 45° 电路板版**。
 *
 * 浏览器脚本（无 module.exports）→ `new Function` + 极简 DOM 桩加载（同 renderer-goal-panel 手法）。
 *
 * 钉住五件事：
 *   1. 主线 = 一条支路，子 Agent **左右两侧交替**（data-side = +1 / −1 / +2 …）；
 *   2. 焊盘矩形必须 `rotate(45 …)`（板子是斜的），但**文字不转**（否则刻度读不了）；
 *   3. 时间沿对角线推进：x 与 y 同时增长；
 *   4. 子 Agent 支路有两条连接 path + 两个过孔点；
 *   5. 失败用虚线框 + ✕（不靠红色）；无时间戳不画刻度。
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { buildTraceGraph } = require('../../src/agent/trace-graph.js');

const RENDERER_SRC = path.join(__dirname, '..', '..', 'src', 'renderer', 'renderer-trace-graph.js');

function makeNode(tag, ns) {
  const node = {
    tagName: tag,
    namespaceURI: ns || null,
    className: '',
    textContent: '',
    style: {},
    dataset: {},
    attrs: {},
    children: [],
    clientWidth: 0,
    classList: {
      add(...names) {
        node.className = [node.className, ...names].filter(Boolean).join(' ');
      },
      remove() {},
      toggle() {}
    },
    setAttribute(name, value) {
      node.attrs[name] = String(value);
      if (name === 'class') node.className = String(value);
    },
    getAttribute(name) {
      return node.attrs[name] == null ? null : node.attrs[name];
    },
    appendChild(child) {
      node.children.push(child);
      return child;
    },
    append(...kids) {
      node.children.push(...kids);
    },
    replaceChildren(...kids) {
      node.children = [...kids];
    },
    addEventListener() {}
  };
  return node;
}

function loadRenderer() {
  const doc = {
    createElement: (tag) => makeNode(tag),
    createElementNS: (ns, tag) => makeNode(tag, ns),
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => []
  };
  const factory = new Function(
    'window',
    'document',
    'TraceGraph',
    'setTracePaneMode',
    `${fs.readFileSync(RENDERER_SRC, 'utf8')}
     return { renderTraceGraph, formatTraceSpanMs, zoomTraceView, clampTraceScale };`
  );
  return factory({}, doc, { buildTraceGraph }, () => {});
}

const { renderTraceGraph, formatTraceSpanMs, zoomTraceView, clampTraceScale } = loadRenderer();
const T = 1_700_000_000_000;

function walk(node, out = []) {
  out.push(node);
  for (const kid of node.children || []) walk(kid, out);
  return out;
}
const byClass = (root, cls) =>
  walk(root).filter((n) => String(n.className || '').split(/\s+/).includes(cls));
const byAttr = (root, attr, value) =>
  walk(root).filter((n) => (value === undefined ? n.getAttribute(attr) != null : n.getAttribute(attr) === value));

function traceWithTwoSubagents() {
  return [
    { round: 1, phase: '勘察', tools: [{ name: 'grep' }], startedAt: T, endedAt: T + 10000 },
    { round: 2, phase: '调度', tools: [{ name: 'fs_edit', failed: true }], startedAt: T + 10000, endedAt: T + 20000 },
    {
      isolated: true,
      subagentId: 'sa-1',
      phase: '写入子 Agent #1',
      rounds: [{ round: 1, tools: [{ name: 'fs_edit' }], startedAt: T + 5000, endedAt: T + 15000 }]
    },
    {
      isolated: true,
      subagentId: 'sa-2',
      phase: '勘察子 Agent #2',
      rounds: [{ round: 1, tools: [{ name: 'grep' }], startedAt: T + 6000, endedAt: T + 12000 }]
    }
  ];
}

describe('轨迹图 / 渲染层（45° 电路板）', () => {
  it('时长格式：毫秒 / 秒 / 分', () => {
    assert.equal(formatTraceSpanMs(420), '420ms');
    assert.equal(formatTraceSpanMs(1500), '1.5s');
    assert.equal(formatTraceSpanMs(43000), '43s');
    assert.equal(formatTraceSpanMs(130000), '2m10s');
  });

  it('子 Agent 左右交替：主线 side=0，两路分别是 +1 / −1', () => {
    const mount = makeNode('div');
    renderTraceGraph(mount, { trace: traceWithTwoSubagents(), running: false });
    const lanes = byAttr(mount, 'data-lane');
    assert.equal(lanes.length, 3);
    assert.equal(lanes[0].getAttribute('data-side'), '0');
    assert.equal(lanes[1].getAttribute('data-side'), '1');
    assert.equal(lanes[2].getAttribute('data-side'), '-1');
    const summary = byClass(mount, 'trace-graph-summary')[0];
    assert.match(summary.textContent, /3 条支路 · 4 个节点 · 工具 4/);
  });

  it('文字保持水平（不许整体旋转 45°）', () => {
    const mount = makeNode('div');
    renderTraceGraph(mount, { trace: traceWithTwoSubagents(), running: false });
    const texts = walk(mount).filter((n) => n.tagName === 'text');
    assert.ok(texts.length > 0);
    for (const t of texts) {
      assert.equal(t.getAttribute('transform'), null, '文字必须保持水平，不许旋转');
    }
    // 节点是圆点（不是方块）
    assert.ok(byClass(mount, 'trace-graph-node').every((n) => walk(n).some((c) => c.tagName === 'circle')));
  });

  it('没有粗块：整张图只有线 + 节点（一个 rect 都没有）', () => {
    const mount = makeNode('div');
    renderTraceGraph(mount, { trace: traceWithTwoSubagents(), running: false });
    assert.equal(walk(mount).filter((n) => n.tagName === 'rect').length, 0, '不许有焊盘矩形（像管道）');
    assert.equal(byClass(mount, 'trace-graph-node').length, 4, '4 块 = 4 个节点');
    // 每条支路一根线
    const lines = walk(mount).filter((n) => n.tagName === 'line');
    assert.ok(lines.length >= 3, `每条支路一根主线：${lines.length}`);
  });

  it('时间沿对角线推进：x 与 y 同时增长', () => {
    const mount = makeNode('div');
    renderTraceGraph(mount, { trace: traceWithTwoSubagents(), running: false });
    const lane = byAttr(mount, 'data-lane', 'main')[0];
    const line = walk(lane).find((n) => n.tagName === 'line');
    const x1 = Number(line.getAttribute('x1'));
    const y1 = Number(line.getAttribute('y1'));
    const x2 = Number(line.getAttribute('x2'));
    const y2 = Number(line.getAttribute('y2'));
    assert.ok(x2 > x1 && y2 > y1, `主线应向右下延伸：(${x1},${y1}) → (${x2},${y2})`);
    // 45°：Δx 与 Δy 应几乎相等
    assert.ok(Math.abs(x2 - x1 - (y2 - y1)) < 0.5, 'Δx 应约等于 Δy（45°）');
  });

  it('子 Agent：一条直角支线 + 过孔点，两路分居主线两侧', () => {
    const mount = makeNode('div');
    renderTraceGraph(mount, { trace: traceWithTwoSubagents(), running: false });
    for (const id of ['sa-1', 'sa-2']) {
      const lane = byAttr(mount, 'data-lane', id)[0];
      const connector = walk(lane).filter(
        (n) => n.tagName === 'path' && String(n.getAttribute('d')).startsWith('M')
      );
      assert.equal(connector.length, 1, `${id} 只需一条引下支线（不画收回线）`);
      const vias = walk(lane).filter((n) => n.tagName === 'circle');
      // 1 个过孔 + 本轮节点（1 轮 = 1 节点）
      assert.equal(vias.length, 2, `${id} 应有 1 个过孔 + 1 个节点`);
    }
    // 两路子 Agent 的支线应分居主线两侧：算法向有符号距离（n = (−C, C)，间距 34px）
    const mainLine = walk(byAttr(mount, 'data-lane', 'main')[0]).find((n) => n.tagName === 'line');
    const ax = Number(mainLine.getAttribute('x1'));
    const ay = Number(mainLine.getAttribute('y1'));
    const signedOffset = (line) => {
      const px = Number(line.getAttribute('x1'));
      const py = Number(line.getAttribute('y1'));
      return Math.SQRT1_2 * (py - ay - (px - ax));
    };
    const offA = signedOffset(walk(byAttr(mount, 'data-lane', 'sa-1')[0]).find((n) => n.tagName === 'line'));
    const offB = signedOffset(walk(byAttr(mount, 'data-lane', 'sa-2')[0]).find((n) => n.tagName === 'line'));
    assert.ok(Math.abs(Math.abs(offA) - 34) < 1.5, `支路离主线应是一个法向间距：${offA}`);
    assert.ok(Math.abs(Math.abs(offB) - 34) < 1.5, `支路离主线应是一个法向间距：${offB}`);
    assert.notEqual(Math.sign(offA), Math.sign(offB), '两路应分居主线两侧');
  });

  it('失败：节点上打 ✕（不靠颜色），正常节点没有', () => {
    const mount = makeNode('div');
    renderTraceGraph(mount, { trace: traceWithTwoSubagents(), running: false });
    const nodes = byClass(mount, 'trace-graph-node');
    const withCross = nodes.filter((n) =>
      walk(n).some((c) => c.tagName === 'path' && /M .* L .* M /.test(String(c.getAttribute('d'))))
    );
    assert.equal(withCross.length, 1, '只有那一个失败轮带 ✕');
    assert.equal(withCross[0].getAttribute('data-round'), '2');
  });

  it('无时间戳：不画刻度、摘要写明按顺序排列', () => {
    const trace = [
      { round: 1, phase: 'a', tools: [] },
      { round: 2, phase: 'b', tools: [] }
    ];
    const mount = makeNode('div');
    renderTraceGraph(mount, { trace, running: false });
    assert.equal(byAttr(mount, 'data-role', 'axis').length, 0);
    assert.match(byClass(mount, 'trace-graph-summary')[0].textContent, /无时间戳/);
    assert.equal(byClass(mount, 'trace-graph-node').length, 2);
  });

  it('节点带标签：有阶段名用阶段名，没有就用「这一轮在想什么」', () => {
    const trace = [
      { round: 1, phase: '勘察', thought: '先看工作区', tools: [], startedAt: T, endedAt: T + 15000 },
      { round: 2, phase: '', thought: '把三处文件各改一处', tools: [], startedAt: T + 15000, endedAt: T + 30000 },
      { round: 3, phase: '', thought: '收尾', tools: [], startedAt: T + 30000, endedAt: T + 45000 }
    ];
    const mount = makeNode('div');
    renderTraceGraph(mount, { trace, running: false });
    const labels = byClass(mount, 'trace-graph-node-label').map((n) => n.textContent);
    assert.ok(labels.includes('勘察'), `阶段名要显示：${JSON.stringify(labels)}`);
    assert.ok(
      labels.some((t) => t.includes('把三处文件')),
      `没有阶段名时用思考原文当标题：${JSON.stringify(labels)}`
    );
    assert.ok(labels.every((t) => t.length <= 15), '标签要截断，不能糊满整张图');
  });

  it('节点太密时自动省略标签（不叠字）', () => {
    const trace = Array.from({ length: 10 }, (_, i) => ({
      round: i + 1,
      phase: '',
      thought: `第${i + 1}步`,
      tools: [],
      startedAt: T + i * 800,
      endedAt: T + i * 800 + 700
    }));
    const mount = makeNode('div');
    renderTraceGraph(mount, { trace, running: false });
    const nodes = byClass(mount, 'trace-graph-node').length;
    const labels = byClass(mount, 'trace-graph-node-label').length;
    assert.equal(nodes, 10);
    assert.ok(labels < nodes, `密集时应省略部分标签（节点 ${nodes}，标签 ${labels}）`);
    assert.ok(labels >= 1, '首个节点必须带标签（否则不知道该线是什么）');
  });

  it('悬浮内容包含这一轮的事件文本', () => {
    const trace = [
      { round: 1, phase: '勘察', thought: '先读一下 README 再决定改哪', tools: [{ name: 'fs_read_file' }], startedAt: T, endedAt: T + 5000 }
    ];
    const mount = makeNode('div');
    renderTraceGraph(mount, { trace, running: false });
    const title = walk(mount).find((n) => n.tagName === 'title');
    assert.ok(title, '节点要有 title（悬浮提示）');
    assert.match(title.textContent, /第 1 轮/);
    assert.match(title.textContent, /1 次工具/);
    assert.match(title.textContent, /先读一下 README/);
  });

  it('滚轮缩放：以指针为中心，缩放前后指针对应的世界坐标不变', () => {
    const point = { x: 120, y: 40 };
    const before = { scale: 1, x: 0, y: 0 };
    const worldBefore = {
      x: (point.x - before.x) / before.scale,
      y: (point.y - before.y) / before.scale
    };
    const after = zoomTraceView(before, point, 2);
    assert.equal(after.scale, 2);
    const worldAfter = { x: (point.x - after.x) / after.scale, y: (point.y - after.y) / after.scale };
    assert.ok(Math.abs(worldAfter.x - worldBefore.x) < 1e-6, '锚点世界坐标必须不变');
    assert.ok(Math.abs(worldAfter.y - worldBefore.y) < 1e-6);
    // 已经平移过的情况下也要成立
    const moved = { scale: 2.5, x: -30, y: 12 };
    const w1 = { x: (point.x - moved.x) / moved.scale, y: (point.y - moved.y) / moved.scale };
    const after2 = zoomTraceView(moved, point, 0.6);
    const w2 = { x: (point.x - after2.x) / after2.scale, y: (point.y - after2.y) / after2.scale };
    assert.ok(Math.abs(w2.x - w1.x) < 1e-6 && Math.abs(w2.y - w1.y) < 1e-6);
  });

  it('缩放有上下限（0.4× ~ 12×），异常输入回落到 1×', () => {
    assert.equal(clampTraceScale(999), 12);
    assert.equal(clampTraceScale(0.01), 0.4);
    assert.equal(clampTraceScale(NaN), 1);
    assert.equal(clampTraceScale('2'), 2);
    assert.equal(zoomTraceView({ scale: 1, x: 0, y: 0 }, { x: 0, y: 0 }, 1e9).scale, 12);
  });

  it('渲染时把视图 transform 写在绘制组上，并给出缩放/平移提示', () => {
    const mount = makeNode('div');
    renderTraceGraph(mount, { trace: traceWithTwoSubagents(), running: false, runId: 'run-1' });
    const drawGroup = byClass(mount, 'trace-graph-lane')[0]?.parent;
    // 首帧：translate(0 0) scale(1)
    const svg = walk(mount).find((n) => n.tagName === 'svg');
    const g = (svg.children || []).find((c) => c.tagName === 'g');
    assert.ok(g, '要有绘制组');
    assert.match(String(g.getAttribute('transform')), /^translate\(0 0\) scale\(1\)$/);
    const hint = byClass(mount, 'trace-graph-hint')[0];
    assert.ok(hint, '要有操作提示');
    assert.match(hint.textContent, /滚轮缩放/);
    assert.match(hint.textContent, /拖动平移/);
    assert.match(hint.textContent, /双击复位/);
    // 线宽不随缩放变粗
    const stroked = walk(g).filter((n) => ['line', 'path', 'circle'].includes(n.tagName));
    assert.ok(stroked.length > 0 && stroked.every((n) => n.getAttribute('vector-effect') === 'non-scaling-stroke'));
    void drawGroup;
  });

  it('空 trace：空态文案，不抛错', () => {
    const mount = makeNode('div');
    renderTraceGraph(mount, { trace: [] });
    const flat = (n) => [String(n.textContent || ''), ...(n.children || []).map(flat)].join(' ');
    assert.match(flat(mount), /还没有可画的轨迹/);
  });
});
