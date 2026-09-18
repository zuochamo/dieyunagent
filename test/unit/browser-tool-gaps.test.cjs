'use strict';

const { spawn } = require('child_process');
const catalog = require('../../src/agent/tool-catalog');
const { buildExploreTools } = require('../../src/agent/planner-tool-filters');
const { isWriteTool, isMutatingAgentTool } = require('../../src/agent/guardrails-shared');
const { validateToolArgs } = require('../../src/agent/tool-validate');
const {
  normalizeFrameSpec,
  normalizeFramePath,
  isMainFrameSpec,
  frameDescriptorMatches,
  describeFrameSpec
} = require('../../src/browser/frame-script');
const { createTimelineJournal, summarizeTimeline } = require('../../src/browser/timeline');
const { normalizeSnapshotMode, SNAPSHOT_MODES } = require('../../src/browser/snapshot-script');
const {
  registerProcessHandle,
  listProcessHandles,
  killProcessHandle
} = require('../../src/gateway/host-control');

function toolParams(tools, name) {
  const t = (tools || []).find((x) => x && x.function && x.function.name === name);
  return t ? t.function.parameters || {} : null;
}

describe('isWeakToolCallerModel（弱模型判定只看规模，不看厂商名）', () => {
  it('强模型不降级（厂商子串不得误伤）', () => {
    for (const id of [
      'DeepSeek-V4.1-Flash',
      'deepseek-chat-v3.1',
      'deepseek-v3.1-671b',
      'MiniMax-M2',
      'minimax-m2',
      'qwen2.5-72b-instruct',
      'qwen3-max',
      'glm-4.6',
      'claude-3-7-sonnet',
      'gpt-4.1',
      'gemini-2.5-flash'
    ]) {
      expect(catalog.isWeakToolCallerModel(id)).toBe(false);
    }
  });

  it('真小模型仍降级（≤8B / mini / tiny 等）', () => {
    for (const id of [
      'qwen2.5-7b',
      'qwen2_5-7b',
      '1.8b',
      'llama-3-8b',
      'gpt-4o-mini',
      'tinyllama-1.1b',
      'deepseek-llm-7b-chat',
      'phi-2',
      'gemma-2b'
    ]) {
      expect(catalog.isWeakToolCallerModel(id)).toBe(true);
    }
  });

  it('空值不判弱', () => {
    expect(catalog.isWeakToolCallerModel('')).toBe(false);
    expect(catalog.isWeakToolCallerModel(null)).toBe(false);
    expect(catalog.isWeakToolCallerModel(undefined)).toBe(false);
  });
});

describe('浏览器工具 schema（frame / mode / annotate / force）', () => {
  it('新增 browser_frames 与 browser_timeline 工具', () => {
    expect(toolParams(catalog.BROWSER_TOOLS, 'browser_frames')).toBeTruthy();
    expect(toolParams(catalog.BROWSER_TOOLS, 'browser_timeline')).toBeTruthy();
  });

  it('browser_timeline 暴露 source / frame / urlPattern 三个过滤维度', () => {
    const tl = toolParams(catalog.BROWSER_TOOLS, 'browser_timeline').properties;
    expect(tl.source).toBeTruthy();
    expect(tl.frame).toBeTruthy();
    expect(tl.urlPattern).toBeTruthy();
    // source 是数据来源维度（agent|page），不能再被描述成 frame
    expect(String(tl.source.description)).toContain('page');
    expect(String(tl.source.description)).not.toContain('frame');
  });

  it('关键工具带上 frame / mode / annotate / force 参数', () => {
    const snapshot = toolParams(catalog.BROWSER_TOOLS, 'browser_snapshot').properties;
    expect(snapshot.mode).toBeTruthy();
    expect(snapshot.frame).toBeTruthy();
    expect(snapshot.maxElements).toBeTruthy();

    const click = toolParams(catalog.BROWSER_TOOLS, 'browser_click').properties;
    expect(click.frame).toBeTruthy();
    expect(click.force).toBeTruthy();

    const shot = toolParams(catalog.BROWSER_TOOLS, 'browser_screenshot').properties;
    expect(shot.annotate).toBeTruthy();
    expect(shot.frame).toBeTruthy();

    const evaluate = toolParams(catalog.BROWSER_TOOLS, 'browser_evaluate').properties;
    expect(evaluate.frame).toBeTruthy();

    for (const name of ['browser_type', 'browser_select_option', 'browser_hover', 'browser_drag', 'browser_scroll', 'browser_press_key', 'browser_wait_for', 'browser_upload_file', 'browser_expect', 'browser_observe', 'browser_a11y_snapshot']) {
      const props = toolParams(catalog.BROWSER_TOOLS, name);
      expect(props, name).toBeTruthy();
      expect(props.properties.frame, name).toBeTruthy();
    }
  });

  it('host_proc 工具存在且属于 HOST_TOOLS', () => {
    const params = toolParams(catalog.HOST_TOOLS, 'host_proc');
    expect(params).toBeTruthy();
    expect(params.properties.action).toBeTruthy();
  });
});

describe('浏览器工具分层（CORE 常驻 / ADVANCED 按需注册）', () => {
  it('两层并集等于全量，且不重叠', () => {
    const core = catalog.BROWSER_CORE_TOOLS.map((t) => t.function.name);
    const adv = catalog.BROWSER_ADVANCED_TOOLS.map((t) => t.function.name);
    const all = catalog.BROWSER_TOOLS.map((t) => t.function.name);
    expect(new Set([...core, ...adv])).toEqual(new Set(all));
    expect(core.length + adv.length).toBe(all.length);
    expect(core.filter((n) => adv.includes(n))).toEqual([]);
  });

  it('ADVANCED 只含验收/调试/凭据/导出类工具', () => {
    for (const name of ['browser_visual_diff', 'browser_viewport', 'browser_cookies', 'browser_pdf']) {
      expect(catalog.BROWSER_ADVANCED_TOOL_NAMES).toContain(name);
    }
    for (const name of ['browser_navigate', 'browser_snapshot', 'browser_click', 'browser_type', 'browser_observe']) {
      expect(catalog.BROWSER_ADVANCED_TOOL_NAMES).not.toContain(name);
    }
  });

  it('弱模型白名单全部落在 CORE，不会被按需层漏掉', () => {
    const weak = ['browser_navigate', 'browser_snapshot', 'browser_a11y_snapshot', 'browser_network', 'browser_console', 'browser_frames', 'browser_timeline', 'browser_observe', 'browser_status', 'browser_close'];
    const core = new Set(catalog.BROWSER_CORE_TOOLS.map((t) => t.function.name));
    for (const name of weak) expect(core.has(name)).toBe(true);
  });

  it('已合并的冗余工具不再出现在任何一层', () => {
    const all = catalog.ALL_STATIC_TOOLS.map((t) => t.function.name);
    for (const name of ['browser_fill', 'browser_double_click', 'browser_right_click']) {
      expect(all).not.toContain(name);
    }
  });
});

describe('Explore 白名单（只读浏览器工具补齐）', () => {
  const all = [
    'fs_read_file',
    'browser_snapshot',
    'browser_observe',
    'browser_frames',
    'browser_timeline',
    'browser_evaluate',
    'browser_click',
    'browser_screenshot',
    'host_exec',
    'fs_write_file'
  ].map((name) => ({ type: 'function', function: { name, description: name, parameters: { type: 'object' } } }));

  it('browser_frames / browser_timeline 可用，写入与 eval 仍被排除', () => {
    const kept = buildExploreTools(all).map((t) => t.function.name);
    expect(kept).toContain('browser_frames');
    expect(kept).toContain('browser_timeline');
    expect(kept).not.toContain('browser_evaluate');
    expect(kept).not.toContain('browser_click');
    expect(kept).not.toContain('browser_screenshot');
    expect(kept).not.toContain('host_exec');
    for (const name of kept) {
      expect(isWriteTool(name)).toBe(false);
    }
  });
});

describe('变更类工具归类（guardrails-shared）', () => {
  it('host_proc 与 host_exec 同属变更类，只读工具不误判', () => {
    expect(isMutatingAgentTool('host_proc')).toBe(true);
    expect(isMutatingAgentTool('host_exec')).toBe(true);
    expect(isMutatingAgentTool('fs_read_file')).toBe(false);
    expect(isMutatingAgentTool('browser_frames')).toBe(false);
  });
});

describe('frame spec 解析（frame-script）', () => {
  it('normalizeFrameSpec：main / path / name / url / urlRegex', () => {
    expect(normalizeFrameSpec(undefined)).toEqual({ kind: 'main' });
    expect(normalizeFrameSpec('main')).toEqual({ kind: 'main' });
    expect(normalizeFrameSpec('top')).toEqual({ kind: 'main' });
    expect(normalizeFrameSpec('0')).toEqual({ kind: 'path', path: ['0'] });
    expect(normalizeFrameSpec('0.1')).toEqual({ kind: 'path', path: ['0', '1'] });
    expect(normalizeFrameSpec(1)).toEqual({ kind: 'path', path: ['1'] });
    expect(normalizeFrameSpec({ path: [0, 1] })).toEqual({ kind: 'path', path: ['0', '1'] });
    expect(normalizeFrameSpec('chat-frame')).toEqual({ kind: 'name', value: 'chat-frame' });
    expect(normalizeFrameSpec('url:example.com/embed')).toEqual({ kind: 'url', value: 'example.com/embed' });
    expect(normalizeFrameSpec('https://example.com/embed')).toEqual({ kind: 'url', value: 'https://example.com/embed' });
    expect(normalizeFrameSpec('/embed\\.php/i')).toEqual({ kind: 'urlRegex', value: 'embed\\.php' });
  });

  it('normalizeFramePath：非法路径返回 null', () => {
    expect(normalizeFramePath('a.b')).toBeNull();
    expect(normalizeFramePath('')).toEqual([]);
  });

  it('frameDescriptorMatches：各类 spec 命中', () => {
    expect(frameDescriptorMatches({ main: true }, { kind: 'main' })).toBe(true);
    expect(frameDescriptorMatches({ path: '0.1' }, { kind: 'path', path: ['0', '1'] })).toBe(true);
    expect(frameDescriptorMatches({ path: '0' }, { kind: 'path', path: ['0', '1'] })).toBe(false);
    expect(frameDescriptorMatches({ name: 'chat' }, { kind: 'name', value: 'chat' })).toBe(true);
    expect(frameDescriptorMatches({ url: 'https://a.com/x' }, { kind: 'url', value: 'a.com' })).toBe(true);
    expect(frameDescriptorMatches({ url: 'https://a.com/x' }, { kind: 'urlRegex', value: 'a\\.com' })).toBe(true);
    expect(frameDescriptorMatches({ url: 'https://a.com/x' }, { kind: 'urlRegex', value: '[' })).toBe(false);
  });

  it('describeFrameSpec / isMainFrameSpec', () => {
    expect(isMainFrameSpec(normalizeFrameSpec(''))).toBe(true);
    expect(isMainFrameSpec(normalizeFrameSpec('0'))).toBe(false);
    expect(describeFrameSpec({ kind: 'path', path: ['0', '1'] })).toBe('path=0.1');
    expect(describeFrameSpec({ kind: 'name', value: 'chat' })).toBe('name=chat');
  });
});

describe('事件时间线（timeline）', () => {
  it('journal：add / list 过滤 / status 统计', () => {
    const j = createTimelineJournal();
    j.add({ type: 'navigate', source: 'agent', url: 'https://a.com' });
    j.add({ type: 'click', source: 'agent', target: { tag: 'button', selector: '#go' } });
    j.add({ type: 'input', source: 'page', frame: 'main', value: 'hello' });

    expect(j.list().length).toBe(3);
    expect(j.list({ type: 'click' }).length).toBe(1);
    expect(j.list({ source: 'agent' }).length).toBe(2);
    const status = j.status();
    expect(status.total).toBe(3);
    expect(status.agentEvents).toBe(2);
    expect(status.pageEvents).toBe(1);
  });

  it('addBindingPayload：只收本通道 JSON，其余返回 null', () => {
    const j = createTimelineJournal();
    const row = j.addBindingPayload(JSON.stringify({ channel: 'timeline', type: 'click', frame: 'iframe', target: { tag: 'a' } }));
    expect(row).toBeTruthy();
    expect(row.source).toBe('page');
    expect(j.addBindingPayload('{"other":1}')).toBeNull();
    expect(j.addBindingPayload('not-json')).toBeNull();
  });

  it('保留事件自身时间戳（页面侧优先），非法值回落当前时间', () => {
    const j = createTimelineJournal();
    expect(j.add({ type: 'click', source: 'page', ts: 1700000000000 }).ts).toBe(1700000000000);
    const fromPage = j.addBindingPayload(
      JSON.stringify({ channel: 'timeline', type: 'click', ts: 1700000000500, frame: 'iframe' })
    );
    expect(fromPage.ts).toBe(1700000000500);
    // 缺失 / 非法 ts 才回落到 Date.now()，且页面时间不会被当成本地时间覆盖
    expect(j.add({ type: 'click', ts: 'bogus' }).ts).toBeGreaterThan(1700000000500);
    expect(j.add({ type: 'click', ts: 0 }).ts).toBeGreaterThan(1700000000500);
  });

  it('list：source 只认 agent|page，frame 才是 frame 维度', () => {
    const j = createTimelineJournal();
    j.add({ type: 'click', source: 'page', frame: 'iframe', url: 'https://a.com/embed' });
    j.add({ type: 'click', source: 'agent', frame: 'path=0.1', url: 'https://a.com/embed' });
    j.add({ type: 'click', source: 'page', frame: 'main', url: 'https://a.com/home' });

    // 回归：frame 值传给 source 不再被误当 frame 过滤（旧 schema 描述曾如此误导）
    expect(j.list({ source: 'iframe' }).length).toBe(0);
    expect(j.list({ source: 'agent' }).length).toBe(1);
    expect(j.list({ source: 'page' }).length).toBe(2);
    expect(j.list({ frame: 'iframe' }).length).toBe(1);
    expect(j.list({ frame: 'path=0.1' }).length).toBe(1);
    expect(j.list({ urlPattern: 'home' }).length).toBe(1);
  });

  it('summarizeTimeline：默认压缩 input，includeInput 打开', () => {
    const j = createTimelineJournal();
    j.add({ type: 'click', source: 'page' });
    j.add({ type: 'input', source: 'page', value: 'x' });
    const compact = summarizeTimeline(j.list());
    expect(compact.shown).toBe(1);
    expect(compact.count).toBe(2);
    expect(summarizeTimeline(j.list(), { includeInput: true }).shown).toBe(2);
  });
});

describe('snapshot mode', () => {
  it('normalizeSnapshotMode：合法值透传，非法回落 interactive', () => {
    expect(SNAPSHOT_MODES).toEqual(['interactive', 'all', 'dom']);
    expect(normalizeSnapshotMode('all')).toBe('all');
    expect(normalizeSnapshotMode('DOM')).toBe('dom');
    expect(normalizeSnapshotMode('bogus')).toBe('interactive');
    expect(normalizeSnapshotMode(null, { interactive: false })).toBe('all');
  });
});

describe('host_proc 参数校验', () => {
  it('kill 缺 id/pid 报错，list 放行', () => {
    expect(validateToolArgs('host_proc', { action: 'kill' }).ok).toBe(false);
    expect(validateToolArgs('host_proc', { action: 'kill', id: 'hostproc-1' }).ok).toBe(true);
    expect(validateToolArgs('host_proc', {}).ok).toBe(true);
    expect(validateToolArgs('host_proc', { action: 'list' }).ok).toBe(true);
  });
});

describe('host_exec 进程句柄注册表', () => {
  it('list 默认只列存活，按会话过滤', async () => {
    const child = spawn(process.execPath, ['-e', 'setTimeout(()=>{},60000)'], { stdio: 'ignore' });
    const rec = registerProcessHandle({
      command: 'node -e setTimeout',
      sessionId: 'sess-a',
      detached: false,
      pid: child.pid,
      child
    });
    try {
      await new Promise((r) => setTimeout(r, 300));
      const inSession = listProcessHandles({ sessionId: 'sess-a' });
      expect(inSession.ok).toBe(true);
      const mine = inSession.processes.find((p) => p.id === rec.id);
      expect(mine).toBeTruthy();
      expect(mine.alive).toBe(true);

      const other = listProcessHandles({ sessionId: 'sess-b' });
      expect(other.processes.find((p) => p.id === rec.id)).toBeFalsy();

      const withFinished = listProcessHandles({ sessionId: 'sess-a', includeFinished: true });
      expect(withFinished.processes.find((p) => p.id === rec.id)).toBeTruthy();
    } finally {
      await killProcessHandle({ id: rec.id });
      child.kill();
    }
  });

  it('kill 只接受已登记进程，拒绝任意 PID 与跨会话', async () => {
    const child = spawn(process.execPath, ['-e', 'setTimeout(()=>{},60000)'], { stdio: 'ignore' });
    const rec = registerProcessHandle({ command: 'node -e setTimeout', sessionId: 'sess-a', pid: child.pid, child });
    try {
      await expect(killProcessHandle({ pid: 999999 })).resolves.toMatchObject({ ok: false, errorCode: 'PROC_NOT_FOUND' });
      await expect(killProcessHandle({})).resolves.toMatchObject({ ok: false, errorCode: 'PROC_ID_REQUIRED' });
      await expect(killProcessHandle({ id: 'hostproc-not-exist' })).resolves.toMatchObject({ ok: false, errorCode: 'PROC_NOT_FOUND' });
      await expect(killProcessHandle({ id: rec.id, sessionId: 'sess-b' })).resolves.toMatchObject({
        ok: false,
        errorCode: 'PROC_SESSION_MISMATCH'
      });
    } finally {
      await killProcessHandle({ id: rec.id, sessionId: 'sess-a' });
    }
  });

  it('kill 真实结束已登记进程', async () => {
    const child = spawn(process.execPath, ['-e', 'setTimeout(()=>{},60000)'], { stdio: 'ignore' });
    const rec = registerProcessHandle({ command: 'node -e setTimeout', sessionId: 'sess-c', pid: child.pid, child });
    const pid = child.pid;
    const result = await killProcessHandle({ id: rec.id, sessionId: 'sess-c' });
    expect(result.ok).toBe(true);
    expect(result.killed[0].killed).toBe(true);
    await new Promise((r) => setTimeout(r, 300));
    let alive = true;
    try {
      process.kill(pid, 0);
    } catch {
      alive = false;
    }
    expect(alive).toBe(false);
  });
});
