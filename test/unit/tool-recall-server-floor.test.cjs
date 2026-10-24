'use strict';

/**
 * A3：MCP 工具召回的「每服务保底」。
 * 背景：语义/关键词召回只取 top-N 时，某个服务可能整体 0 命中，
 * 该服务下全部工具对模型不可见（mcp_tool_schema 只查已召回工具的 schema）。
 */

const { applyServerFloor } = require('../../src/tools/tool-vector-index');

function entry(id, serverId, tokens) {
  return { id, name: id, serverId, source: 'mcp', tokens: tokens || [] };
}

function row(e, score) {
  return { entry: e, score: score || 0, semanticScore: 0, keywordScore: score || 0 };
}

function serversOf(rows) {
  return rows.map((r) => r.entry.serverId);
}

describe('applyServerFloor（每服务保底）', () => {
  it('名额未满时补上未命中服务的条目，且不动原有顺序', () => {
    const entries = [
      entry('blender_a', 'blender'),
      entry('blender_b', 'blender'),
      entry('ue_a', 'unreal'),
      entry('ue_b', 'unreal')
    ];
    const rows = [row(entries[0], 0.8), row(entries[1], 0.7)];
    const out = applyServerFloor(rows, entries, 10);
    expect(serversOf(out)).toEqual(['blender', 'blender', 'unreal']);
    expect(out[2].entry.id).toBe('ue_a');
  });

  it('名额已满时从「重复服务」换出名额，永不吃掉某服务的唯一一条', () => {
    const entries = [
      entry('b1', 'blender'),
      entry('b2', 'blender'),
      entry('b3', 'blender'),
      entry('u1', 'unreal')
    ];
    const rows = [row(entries[0], 0.9), row(entries[1], 0.8), row(entries[2], 0.7)];
    const out = applyServerFloor(rows, entries, 4);
    expect(out.length).toBe(4);
    // 从尾部（b3）换出，b1/b2 保留
    expect(out.slice(0, 2).map((r) => r.entry.id)).toEqual(['b1', 'b2']);
    expect(serversOf(out)).toContain('unreal');
  });

  it('保底预算上限为 ceil(max/2)，不会把名额全给弱相关服务', () => {
    const entries = [];
    for (const sid of ['a', 'b', 'c', 'd', 'e']) entries.push(entry(`${sid}1`, sid));
    // 只有 a 命中，b~e 全部未覆盖
    const rows = [row(entries[0], 0.9)];
    const out = applyServerFloor(rows, entries, 6);
    // budget = ceil(6/2) = 3 → 最多补 3 个服务
    expect(out.length).toBe(4);
    expect(serversOf(out)[0]).toBe('a');
  });

  it('预算内按弱相关分优先，而不是候选顺序', () => {
    const entries = [entry('a1', 'a'), entry('b1', 'b'), entry('c1', 'c')];
    const rows = [row(entries[0], 0.9)];
    const scoreOf = (e) => (e.serverId === 'c' ? 0.5 : 0.1);
    const out = applyServerFloor(rows, entries, 3, scoreOf);
    // budget = min(2, ceil(3/2)=2) → 两个都补；顺序应按分数 c 先
    expect(serversOf(out)).toEqual(['a', 'c', 'b']);
  });

  it('只有一个服务时不处理；空 rows 原样返回', () => {
    const entries = [entry('a1', 'a'), entry('a2', 'a')];
    const rows = [row(entries[0], 0.9)];
    expect(applyServerFloor(rows, entries, 10)).toBe(rows);
    expect(applyServerFloor([], entries, 10)).toEqual([]);
  });

  it('所有服务都已覆盖时原样返回（零开销）', () => {
    const entries = [entry('a1', 'a'), entry('b1', 'b')];
    const rows = [row(entries[0], 0.9), row(entries[1], 0.5)];
    expect(applyServerFloor(rows, entries, 10)).toBe(rows);
  });
});
