'use strict';
/**
 * 统计信息页「索引使用率」的口径（`src/agent/tool-telemetry.js:summarizeIndexUsage`）。
 *
 * 这张表要回答的是 `docs/INDEX-VALUE-REVIEW.md` §7 的复核问题：索引到底有没有被用。
 * 因此这里锁死三件事：
 *   1. 分组口径只有一处（`INDEX_TOOL_GROUPS`），`grep` / `lsp` 不算索引工具；
 *   2. 占比用**全部遥测记录**算，不是「近 200 次」——用短窗口评估索引会把「刚建完的
 *      一次使用」放大成 50%，正是 0.05% 那个数字被误读的镜像错误；
 *   3. 0 次要如实说 0，不要伪装成「没有数据」。
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  summarizeIndexUsage,
  summarizeTelemetry,
  describeIndexInjections,
  INDEX_TOOL_GROUPS,
  telemetryPath
} = require('../../src/agent/tool-telemetry');

function row(tool, extra = {}) {
  return { ts: 1_700_000_000_000, tool, ok: true, ...extra };
}

describe('索引使用率口径', () => {
  it('分组只认索引工具：grep / lsp 不算', () => {
    const ids = INDEX_TOOL_GROUPS.map((g) => g.id);
    assert.deepEqual(ids, ['codebase', 'graph']);
    const allTools = INDEX_TOOL_GROUPS.flatMap((g) => g.tools);
    assert.deepEqual(allTools, ['codebase_search', 'graph', 'read_symbol']);
    for (const notIndex of ['grep', 'lsp', 'fs_read_file', 'host_exec']) {
      assert.ok(!allTools.includes(notIndex), `${notIndex} 不该算索引工具`);
    }
  });

  it('按全窗口算占比，长尾调用不会被短窗口挤掉', () => {
    const rows = [];
    // 300 次普通工具调用之后才出现 3 次索引调用：若只看最后 200 次就只剩 3/200，
    // 但全窗口口径下是 3/303 —— 这正是「索引用得少但确实在用」的真实形态。
    for (let i = 0; i < 300; i += 1) rows.push(row('host_exec'));
    rows.push(row('codebase_search'));
    rows.push(row('graph'));
    rows.push(row('read_symbol'));

    const usage = summarizeIndexUsage(rows);
    assert.equal(usage.total, 303);
    assert.equal(usage.indexCalls, 3);
    const byId = Object.fromEntries(usage.groups.map((g) => [g.id, g]));
    assert.equal(byId.codebase.calls, 1);
    assert.equal(byId.graph.calls, 2, 'graph 与 read_symbol 归同一组');
    assert.equal(byId.codebase.share, 0.3);
    assert.equal(byId.graph.share, 0.7);
    assert.equal(byId.codebase.successRate, 100);
  });

  it('0 次如实报 0（不是「无数据」）', () => {
    const usage = summarizeIndexUsage([row('grep'), row('fs_read_file')]);
    assert.equal(usage.total, 2);
    assert.equal(usage.indexCalls, 0);
    for (const g of usage.groups) {
      assert.equal(g.calls, 0);
      assert.equal(g.share, 0);
      assert.equal(g.successRate, 0, '没调用过不能显示 100%');
    }
  });

  it('失败按错误码归类，索引不可用的原因能被看见', () => {
    const usage = summarizeIndexUsage([
      row('codebase_search', { ok: false, errorCode: 'INDEX_REQUIRED' }),
      row('codebase_search', { ok: false, errorCode: 'INDEXING_IN_PROGRESS' }),
      row('codebase_search', { ok: false, errorCode: 'INDEX_REQUIRED' }),
      row('codebase_search')
    ]);
    const codebase = usage.groups.find((g) => g.id === 'codebase');
    assert.equal(codebase.calls, 4);
    assert.equal(codebase.ok, 1);
    assert.equal(codebase.successRate, 25);
    assert.equal(codebase.topErrors[0].errorCode, 'INDEX_REQUIRED');
    assert.equal(codebase.topErrors[0].count, 2);
  });

  it('空遥测（新装 / 刚清空）不炸且给出零值结构', () => {
    const usage = summarizeIndexUsage([]);
    assert.equal(usage.total, 0);
    assert.equal(usage.since, null);
    assert.equal(usage.groups.length, INDEX_TOOL_GROUPS.length);
  });
});

describe('summarizeTelemetry 把使用率挂在同一份摘要上', () => {
  it('一次读文件同时给出近 200 次窗口与全窗口使用率', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dieyun-telemetry-'));
    const file = telemetryPath(dir);
    const lines = [];
    for (let i = 0; i < 250; i += 1) lines.push(JSON.stringify(row('host_exec')));
    lines.push(JSON.stringify(row('codebase_search')));
    fs.writeFileSync(file, `${lines.join('\n')}\n`, 'utf8');

    const s = summarizeTelemetry(dir);
    assert.equal(s.total, 200, '原有字段仍是近 200 次窗口');
    assert.equal(s.indexUsage.total, 251, '使用率用全窗口');
    const codebase = s.indexUsage.groups.find((g) => g.id === 'codebase');
    assert.equal(codebase.calls, 1);
    assert.equal(codebase.share, 0.4, '1/251 ≈ 0.4%');

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('文件不存在时给空结构而不是抛错', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dieyun-telemetry-empty-'));
    const s = summarizeTelemetry(dir);
    assert.equal(s.total, 0);
    assert.equal(s.indexUsage.total, 0);
    assert.equal(s.indexUsage.groups.length, INDEX_TOOL_GROUPS.length);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

/**
 * 注入那一半的口径。存在的理由是实测误判：2026-11-03 面板显示工具调用 0.6%，
 * 而同一窗口 `repo_map` 注入 833/1771 轮 —— 只看调用就会把「在用」读成「没用」。
 */
describe('索引注入口径（与工具调用互补的那一半）', () => {
  it('占比的分母是有审计事实的轮次，历史行只进 total', () => {
    const d = describeIndexInjections({
      total: 3200,
      rounds: 1771,
      allowed: 1600,
      repoMap: 833,
      codeAuto: 0,
      codeExplicit: 0,
      since: 1_700_000_000_000,
      until: 1_700_300_000_000
    });
    assert.ok(d, '有数据时不能返回 null');
    assert.equal(d.rounds, 1771, '分母只数带 index 审计的轮次');
    assert.equal(d.total, 3200, '窗口内全部快照另记，用来说明旧行没这项事实');
    assert.equal(d.repoMapShare, 47, '833/1771 ≈ 47.0%');
    assert.equal(d.code, 0);
    assert.equal(d.codeShare, 0);
  });

  it('相关代码把自动检索与 @Codebase 拆开，但合成一行占比', () => {
    const d = describeIndexInjections({
      total: 200,
      rounds: 200,
      allowed: 200,
      repoMap: 0,
      codeAuto: 6,
      codeExplicit: 2,
      since: 1,
      until: 2
    });
    assert.equal(d.code, 8);
    assert.equal(d.codeAuto, 6);
    assert.equal(d.codeExplicit, 2);
    assert.equal(d.codeShare, 4);
    assert.equal(d.repoMapShare, 0);
  });

  it('读不到（null / 非对象）返回 null —— UI 才会写「不可用」而不是 0', () => {
    assert.equal(describeIndexInjections(null), null);
    assert.equal(describeIndexInjections(undefined), null);
    assert.equal(describeIndexInjections('nope'), null);
  });

  it('没有任何审计轮次时占比是 0，不是 NaN', () => {
    const d = describeIndexInjections({ total: 12, rounds: 0, repoMap: 0, codeAuto: 0, codeExplicit: 0 });
    assert.ok(d);
    assert.equal(d.repoMapShare, 0);
    assert.equal(d.codeShare, 0);
    assert.equal(d.since, null);
  });
});
