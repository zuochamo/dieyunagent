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
const { createTimelineJournal, summarizeTimeline, TIMELINE_CHANNEL } = require('../../src/browser/timeline');
const { createJournalScope, VIEW_OWNER_KEY } = require('../../src/browser/journal-scope');
const {
  resolveTarget,
  applyTarget,
  retarget,
  normalizeRequested,
  ENGINE_PARAM_DESCRIPTION,
  REASON
} = require('../../src/browser/engine-target');
const {
  normalizeSnapshotMode,
  SNAPSHOT_MODES,
  buildSnapshotScript,
  buildClickCoordsScript
} = require('../../src/browser/snapshot-script');
const { FRAME_HELPERS } = require('../../src/browser/frame-script');
const {
  formatRef,
  parseRef,
  isRef,
  refSnapshotId,
  refSelector,
  checkRefOrigin,
  isRefFailureError,
  enrichRefFailure,
  mintSnapshotId,
  __resetSnapshotCounter,
  REF_RE,
  REF_FAILURE,
  REF_PARAM_DESCRIPTION,
  refLifecycleNote
} = require('../../src/browser/ref-namespace');
const { createBrowserSessionScope } = require('../../src/browser/session-scope');
const { createPlaywrightRunner } = require('../../src/browser/playwright-runner');
const { normalizeAssertions } = require('../../src/browser/expect');
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

describe('引擎决策（engine-target 单一来源）', () => {
  it('显式 engine 永远优先，不因归属漂移', () => {
    expect(resolveTarget({ requested: 'playwright', ownerEngine: 'browserview' }).engine).toBe('playwright');
    expect(resolveTarget({ requested: 'browserview', ownerEngine: 'playwright' }).engine).toBe('browserview');
  });

  it('auto 跟随归属引擎，不看 URL 字符串', () => {
    expect(resolveTarget({ requested: 'auto', ownerEngine: 'playwright' })).toMatchObject({
      engine: 'playwright',
      requested: 'auto',
      explicit: false,
      reason: REASON.AUTO_OWNER,
      downgraded: false
    });
    expect(resolveTarget({ requested: 'auto', ownerEngine: 'browserview' }).engine).toBe('browserview');
    expect(resolveTarget({}).reason).toBe(REASON.AUTO_DEFAULT);
  });

  it('后台会话不能用 BrowserView：显式请求被降级且必须可见', () => {
    const t = resolveTarget({ requested: 'browserview', isBackgroundSession: true, sessionId: 's2' });
    expect(t).toMatchObject({
      engine: 'playwright',
      requested: 'browserview',
      downgraded: true,
      reason: REASON.BACKGROUND_SESSION
    });
    const out = applyTarget({ ok: true, engine: 'playwright', url: 'https://a.com' }, t);
    expect(out.downgraded).toBe(true);
    expect(out.downgradeReason).toBe(REASON.BACKGROUND_SESSION);
    expect(String(out.downgradeNote)).toContain('Playwright');
    // 结果自报的执行者不被 target 覆盖（两字段含义不同：计划 vs 实际）
    expect(out.engine).toBe('playwright');
  });

  it('后台会话的 auto 说明原因但不标 downgraded（没有承诺被破坏）', () => {
    expect(resolveTarget({ requested: 'auto', isBackgroundSession: true })).toMatchObject({
      engine: 'playwright',
      downgraded: false,
      reason: REASON.BACKGROUND_SESSION
    });
  });

  it('未知 engine 取值回落 auto 并给出 warning', () => {
    const t = resolveTarget({ requested: 'edge' });
    expect(t.requested).toBe('auto');
    expect(String(t.warning)).toContain('edge');
    expect(normalizeRequested('embedded').requested).toBe('browserview');
    expect(normalizeRequested('pw').requested).toBe('playwright');
  });

  it('retarget：运行期改道后实际执行者必须可见', () => {
    const t = resolveTarget({ requested: 'auto' });
    const out = retarget({ ok: false, engine: 'playwright', error: 'x' }, t, {
      engine: 'playwright',
      reason: REASON.CROSS_FRAME
    });
    expect(out.downgraded).toBe(true);
    expect(out.target.engine).toBe('playwright');
    expect(out.downgradeReason).toBe(REASON.CROSS_FRAME);
  });

  it('instanceId 由 (engine, sessionId) 派生：同序列稳定，改道/换会话即换实例', () => {
    const t = resolveTarget({ requested: 'browserview', sessionId: 'sess-1' });
    expect(t.instanceId).toBe('browserview#sess-1');
    // 同一 target 重复回填 → 同一操作序列（snapshot → click）看到同一个实例身份
    expect(applyTarget({ ok: true, engine: 'browserview' }, t).instanceId).toBe('browserview#sess-1');
    expect(applyTarget({ ok: true }, t).instanceId).toBe(t.instanceId);
    // 运行期改道：实际执行者换了，实例身份必须跟着换（否则调用方误判落点没变）
    const moved = retarget({ ok: true, engine: 'playwright' }, t, {
      engine: 'playwright',
      reason: REASON.CROSS_FRAME
    });
    expect(moved.instanceId).toBe('playwright#sess-1');
    expect(moved.instanceId).not.toBe(t.instanceId);
    // 没有会话身份时落到缺省键
    expect(resolveTarget({}).instanceId).toBe('browserview#default');
    // 不同会话即便同引擎也是不同实例
    expect(resolveTarget({ sessionId: 'sess-2' }).instanceId).not.toBe(t.instanceId);
  });

  it('所有 browser_* 的 engine 参数共用同一文案（消除重复契约）', () => {
    const withEngine = catalog.BROWSER_TOOLS.filter((t) => t.function?.parameters?.properties?.engine);
    expect(withEngine.length).toBeGreaterThan(20);
    for (const t of withEngine) {
      expect(t.function.parameters.properties.engine.description, t.function.name).toBe(ENGINE_PARAM_DESCRIPTION);
    }
  });

  it('web_search 的 engine 是搜索引擎，不受浏览器引擎契约影响', () => {
    const props = toolParams(catalog.WEB_TOOLS, 'web_search').properties;
    expect(String(props.engine.description)).toContain('baidu');
  });
});

describe('ref origin 身份（ref-namespace 单一来源）', () => {
  it('ref 形如 ref-<seq>@<snapshotId>，可解析出 origin', () => {
    expect(formatRef(3, 's1')).toBe('ref-3@s1');
    expect(parseRef('ref-3@s1')).toEqual({ seq: 3, snapshotId: 's1' });
    expect(refSnapshotId('ref-12@sa')).toBe('sa');
    expect(isRef('ref-0@s1')).toBe(true);
  });

  it('裸计数 ref 与脏输入一律不合法', () => {
    for (const bad of ['ref-0', 'ref-0@', '@s1', 'ref-a@s1', 'ref-0@s', 'ref-0@s1!', 'ref-0@S1', 0, null, undefined, {}, 'a"b']) {
      expect(isRef(bad), String(bad)).toBe(false);
      expect(parseRef(bad), String(bad)).toBeNull();
    }
    // 内部空白容许（模型偶尔带空格），但 origin 必须完整
    expect(parseRef(' ref-1@s2 ')).toEqual({ seq: 1, snapshotId: 's2' });
    expect(REF_RE.test('ref-3@s1')).toBe(true);
  });

  it('mintSnapshotId 单调递增且全局唯一（不跨会话撞号）', () => {
    __resetSnapshotCounter(0);
    const a = mintSnapshotId();
    const b = mintSnapshotId();
    expect(a).toBe('s1');
    expect(b).toBe('s2');
    expect(new Set([a, b]).size).toBe(2);
    expect(REF_RE.test(formatRef(0, b))).toBe(true);
  });

  it('origin 一致才放行：过期 ref 报 REF_EXPIRED 而非笼统找不到', () => {
    expect(checkRefOrigin('ref-3@s1', 's1')).toMatchObject({ ok: true, seq: 3, snapshotId: 's1' });

    const expired = checkRefOrigin('ref-3@s1', 's2');
    expect(expired.ok).toBe(false);
    expect(expired.reason).toBe('expired');
    expect(expired.errorCode).toBe(REF_FAILURE.EXPIRED);
    expect(expired.snapshotId).toBe('s1');
    expect(expired.currentSnapshotId).toBe('s2');
    expect(expired.error).toContain('s1');
    expect(expired.error).toContain('s2');

    // 从未 snapshot 过 → 明确要求先 snapshot，而不是提示「元素未找到」
    const none = checkRefOrigin('ref-0@s1', '');
    expect(none.errorCode).toBe(REF_FAILURE.NO_SNAPSHOT);
    const malformed = checkRefOrigin('ref-0', 's1');
    expect(malformed.errorCode).toBe(REF_FAILURE.MALFORMED);
  });

  it('ref 失效类错误不被当作「换个引擎重试就能找到」', () => {
    expect(isRefFailureError({ errorCode: REF_FAILURE.EXPIRED })).toBe(true);
    expect(isRefFailureError(REF_FAILURE.NO_SNAPSHOT)).toBe(true);
    expect(isRefFailureError({ errorCode: 'TARGET_NOT_FOUND' })).toBe(false);
    expect(isRefFailureError(null)).toBe(false);
  });

  it('ref 失效错误体补全：实例 / 页面 / 世代 / 是否导航过 + 可行动建议', () => {
    const enriched = enrichRefFailure(
      { ok: false, errorCode: REF_FAILURE.EXPIRED, error: 'ref 已失效', snapshotId: 's1', currentSnapshotId: 's2' },
      {
        engine: 'browserview',
        instanceId: 'browserview#sess-1',
        url: 'https://a.com/login',
        refEpoch: 7,
        navigatedSinceSnapshot: true
      }
    );
    // 顶层：渲染层与调用方直接读的字段
    expect(enriched.instanceId).toBe('browserview#sess-1');
    expect(enriched.refEpoch).toBe(7);
    expect(enriched.navigatedSinceSnapshot).toBe(true);
    // diagnostics：失败信封归一化时唯一会被保留的结构字段
    expect(enriched.diagnostics).toMatchObject({
      engine: 'browserview',
      instanceId: 'browserview#sess-1',
      url: 'https://a.com/login',
      snapshotId: 's1',
      currentSnapshotId: 's2',
      refEpoch: 7,
      navigatedSinceSnapshot: true
    });
    // 旧 ref 不是暂时故障：不重试，且给出下一步动作
    expect(enriched.retryable).toBe(false);
    expect(enriched.suggestedFix).toContain('browser_snapshot');
    // 不覆盖上游已给的建议；不臆断未导航的情况
    expect(
      enrichRefFailure({ ok: false, errorCode: REF_FAILURE.EXPIRED, suggestedFix: '改用 selector' }, {}).suggestedFix
    ).toBe('改用 selector');
    expect(enrichRefFailure({ ok: false, errorCode: REF_FAILURE.EXPIRED }, {}).navigatedSinceSnapshot).toBe(false);
    // 非 ref 失效错误原样返回（不裹诊断、不动重试语义）
    const other = { ok: false, errorCode: 'TARGET_NOT_FOUND', retryable: true };
    expect(enrichRefFailure(other, { instanceId: 'x' })).toBe(other);
    expect(enrichRefFailure(null)).toBeNull();
    // 成功的 origin 校验结果不受影响
    const okOrigin = { ok: true, seq: 3, snapshotId: 's1' };
    expect(enrichRefFailure(okOrigin, { instanceId: 'x' })).toBe(okOrigin);
  });

  it('enrichRefFailure 不用 undefined 盖掉引擎/上游已报的同一事实', () => {
    const enriched = enrichRefFailure(
      {
        ok: false,
        errorCode: REF_FAILURE.EXPIRED,
        engine: 'playwright',
        diagnostics: { instanceId: 'playwright#sess-9', snapshotId: 's9', currentSnapshotId: 's10', refEpoch: 4 }
      },
      {}
    );
    expect(enriched.engine).toBe('playwright');
    expect(enriched.diagnostics).toMatchObject({
      engine: 'playwright',
      instanceId: 'playwright#sess-9',
      snapshotId: 's9',
      currentSnapshotId: 's10',
      refEpoch: 4
    });
    // ctx 只补「它知道的那部分」，未知字段保持缺省而不是变成 undefined 键
    const partial = enrichRefFailure({ ok: false, errorCode: REF_FAILURE.EXPIRED }, { url: 'https://c.com' });
    expect(partial.url).toBe('https://c.com');
    expect(partial.diagnostics.url).toBe('https://c.com');
    expect(partial.instanceId).toBeUndefined();
  });

  it('ref → 选择器只在格式合法时产出（不把脏串拼进选择器）', () => {
    expect(refSelector('ref-3@s1')).toBe('[data-dieyun-ref="ref-3@s1"]');
    expect(refSelector('ref-0')).toBeNull();
    expect(refSelector(null)).toBeNull();
  });

  it('会话账本记录「当前 snapshot」：epoch 只在 recordSnapshot 递增', () => {
    const scope = createBrowserSessionScope();
    expect(scope.getSnapshot('sess-a')).toBeNull();
    expect(scope.recordSnapshot('sess-a', { id: 's1', engine: 'browserview', url: 'https://a.com' })).toMatchObject({
      id: 's1',
      epoch: 1,
      engine: 'browserview',
      url: 'https://a.com'
    });
    expect(scope.recordSnapshot('sess-a', { id: 's2', engine: 'playwright' }).epoch).toBe(2);
    expect(scope.getSnapshot('sess-a').id).toBe('s2');
    // 会话之间互不影响
    expect(scope.recordSnapshot('sess-b', { id: 's3' }).epoch).toBe(1);
    // 非法 snapshotId 不写账本
    expect(scope.recordSnapshot('sess-a', { id: 'nope' })).toBeNull();

    scope.clearSnapshots();
    expect(scope.getSnapshot('sess-a')).toBeNull();
    expect(scope.getSnapshot('sess-b')).toBeNull();
    // 清空后重新开始计数（页面已没了，epoch 从头来）
    expect(scope.recordSnapshot('sess-a', { id: 's4' }).epoch).toBe(1);
  });

  it('navigatedSinceSnapshot：导航事件与 url 变化任一成立即已跳转，缺证据不臆断', () => {
    const scope = createBrowserSessionScope();
    expect(scope.navigatedSinceSnapshot('sess-a')).toBe(false);

    scope.recordSnapshot('sess-a', { id: 's1' });
    expect(scope.navigatedSinceSnapshot('sess-a')).toBe(false);
    expect(scope.getNavigation('sess-a')).toBeNull();

    scope.recordNavigation('sess-a', { url: 'https://b.com/login' });
    expect(scope.getNavigation('sess-a').url).toBe('https://b.com/login');
    expect(scope.navigatedSinceSnapshot('sess-a')).toBe(true);

    // 重新 snapshot 之后，此前的导航就被甩在身后了（乐观判定不留下陈旧 true）
    scope.recordSnapshot('sess-a', { id: 's2' });
    expect(scope.navigatedSinceSnapshot('sess-a')).toBe(false);

    // 页面自己跳转（表单提交 / JS 重定向 / 点链接）不经过 navigate 工具：账本里没有导航事件，
    // 只能靠「snapshot 时的 url ≠ 当前 url」认出来（调用方把引擎自报的当场 url 传进来）
    scope.recordSnapshot('sess-a', { id: 's3', url: 'https://a.com/login.html' });
    expect(scope.navigatedSinceSnapshot('sess-a')).toBe(false);
    expect(scope.navigatedSinceSnapshot('sess-a', { currentUrl: 'https://a.com/3d/' })).toBe(true);
    // url 相同、或 url 未知（空串）时一律不臆断
    expect(
      scope.navigatedSinceSnapshot('sess-a', { currentUrl: 'https://a.com/login.html' })
    ).toBe(false);
    expect(scope.navigatedSinceSnapshot('sess-a', { currentUrl: '' })).toBe(false);
    // 没有引擎证据时退回会话 meta.url（由 setOwner 逐次刷新）
    scope.updateMeta('sess-a', { url: 'https://a.com/3d/' });
    expect(scope.navigatedSinceSnapshot('sess-a')).toBe(true);

    // 会话之间互不影响；无会话身份不写账本
    expect(scope.navigatedSinceSnapshot('sess-b')).toBe(false);
    expect(scope.recordNavigation('', { url: 'x' })).toBeNull();
  });

  it('生效会话身份只有一条规则：显式 sessionId → 前台 BrowserView 会话', () => {
    const scope = createBrowserSessionScope();
    // 只有「确实还没绑定任何会话」才是 null（instanceId 落到 #default 缺省键）
    expect(scope.resolveEffectiveSessionId()).toBeNull();
    expect(scope.resolveEffectiveSessionId('   ')).toBeNull();

    scope.setActiveViewSessionId('s-1790075690229-dae5864');
    // auto 调用（不带 sessionId）与显式调用必须得到同一身份，否则同一实例被叫成两个名字
    expect(scope.resolveEffectiveSessionId()).toBe('s-1790075690229-dae5864');
    expect(scope.resolveEffectiveSessionId(null)).toBe('s-1790075690229-dae5864');
    expect(scope.resolveEffectiveSessionId('s-1790075690229-dae5864')).toBe(
      's-1790075690229-dae5864'
    );
    // 显式后台会话优先于前台会话，并沿用同一份归一化（去空白）
    expect(scope.resolveEffectiveSessionId('sess-bg')).toBe('sess-bg');
    expect(scope.resolveEffectiveSessionId(' sess-bg ')).toBe('sess-bg');
  });

  it('snapshot 脚本把 origin 身份写进页面，可在解析时校验', () => {
    __resetSnapshotCounter(0);
    const script = buildSnapshotScript({ mode: 'interactive', maxElements: 5, snapshotId: 's7' });
    expect(script).toContain('const snapshotId = "s7"');
    expect(script).toContain('window.__dieyunRefSnapshotId = snapshotId');
    expect(script).toContain('__dyFormatRef(state.ref++, state.snapshotId)');
    expect(script).toContain('state.snapshotId');
    // 缺省时自己铸一个（脚本可独立跑）
    __resetSnapshotCounter(3);
    expect(buildSnapshotScript({})).toContain('"s4"');
  });

  it('注入脚本内置同一份 origin 校验（格式定义不与 Node 侧分叉）', () => {
    expect(FRAME_HELPERS).toContain('function __dyCheckRefOrigin');
    expect(FRAME_HELPERS).toContain('function __dyParseRef');
    expect(FRAME_HELPERS).toContain('REF_MALFORMED');
    expect(FRAME_HELPERS).toContain('REF_NO_SNAPSHOT');
    expect(FRAME_HELPERS).toContain('REF_EXPIRED');
    // 正则来自 ref-namespace，两侧同源
    expect(FRAME_HELPERS).toContain(JSON.stringify(`^ref-(\\d{1,6})@(s[0-9a-z]{1,12})$`));
    // 解析入口确实做了 origin 校验
    expect(buildClickCoordsScript('"ref-0@s1"', 'null')).toContain('__dyResolveTargetEx');
  });

  it('所有 browser_* 的 ref 参数共用同一文案（消除重复契约）', () => {
    const withRef = catalog.BROWSER_TOOLS.filter((t) => {
      const props = t.function?.parameters?.properties || {};
      return props.ref || props.toRef;
    });
    expect(withRef.length).toBeGreaterThan(5);
    for (const t of withRef) {
      const props = t.function.parameters.properties;
      for (const key of ['ref', 'toRef']) {
        if (!props[key]) continue;
        expect(props[key].description, `${t.function.name}.${key}`).toBe(REF_PARAM_DESCRIPTION);
      }
    }
  });

  it('browser_expect 的 ref 也走同一份格式（裸 ref-0 被拒）', () => {
    expect(normalizeAssertions([{ kind: 'visible', ref: 'ref-0@s1' }])[0].ref).toBe('ref-0@s1');
    expect(() => normalizeAssertions([{ kind: 'visible', ref: 'ref-0' }])).toThrow(/ref 非法/);
    expect(() => normalizeAssertions([{ kind: 'visible', ref: 'a"b' }])).toThrow(/ref 非法/);
  });
});

describe('Phase 3：观察账本按会话归位（不再按引擎分裂）', () => {
  it('同一会话跨引擎的记录落在同一个桶，engine 只作过滤', () => {
    let active = 'sess-a';
    const scope = createJournalScope({ resolveDefaultSessionId: () => active });
    scope.network('sess-a').add({ engine: 'browserview', method: 'POST', url: 'https://a.com/api/auth/login' });
    scope.network('sess-a').add({ engine: 'playwright', method: 'GET', url: 'https://a.com/next' });
    scope.network('sess-b').add({ engine: 'playwright', method: 'GET', url: 'https://b.com/' });

    // 同一会话：BrowserView 的登录请求与改道后 Playwright 的请求都在（不再丢在另一个桶）
    expect(scope.network('sess-a').list({}).map((e) => e.url)).toEqual([
      'https://a.com/api/auth/login',
      'https://a.com/next'
    ]);
    expect(scope.network('sess-b').list({}).map((e) => e.url)).toEqual(['https://b.com/']);
    // 显式引擎 = 过滤维度，不是「换一个账本」
    expect(scope.network('sess-a').list({ engine: 'browserview' }).length).toBe(1);
    expect(scope.network('sess-a').status({ engine: 'playwright' })).toMatchObject({ total: 1 });
    expect(scope.network('sess-a').status()).toMatchObject({ total: 2 });
    // 无 sessionId → 落到默认会话（前台），不是「合并所有会话」
    expect(scope.keyOf(null)).toBe('sess-a');
    expect(scope.network(null)).toBe(scope.network('sess-a'));
    active = 'sess-b';
    expect(scope.keyOf(undefined)).toBe('sess-b');
    expect(scope.network('')).toBe(scope.network('sess-b'));
  });

  it('轮次开始清空只清本会话，并留下清空时间供「查不到」自解释', () => {
    const scope = createJournalScope({ resolveDefaultSessionId: () => 'sess-a' });
    scope.console('sess-a').add({ engine: 'browserview', level: 'error', text: 'a' });
    scope.network('sess-a').add({ engine: 'browserview', url: 'https://a.com/login' });
    scope.console('sess-b').add({ engine: 'playwright', level: 'error', text: 'b' });
    expect(scope.clearedAt('sess-a')).toBe(0);

    const cleared = scope.clear('sess-a');
    expect(cleared.cleared).toEqual(['console', 'network']);
    expect(cleared.clearedAt).toBeGreaterThan(0);
    expect(scope.network('sess-a').list({})).toEqual([]);
    expect(scope.clearedAt('sess-a')).toBe(cleared.clearedAt);
    // 别的会话不受影响：这正是「另一个会话 reset 把本会话请求清掉」的根因
    expect(scope.console('sess-b').list({}).length).toBe(1);
    expect(scope.clearedAt('sess-b')).toBe(0);
    // 也能只清某一类
    expect(scope.clear('sess-b', ['console']).cleared).toEqual(['console']);
    expect(scope.console('sess-b').list({})).toEqual([]);
  });

  it('会话回收 / 整体关闭会丢弃账本，无身份时仍归到 __view__', () => {
    const scope = createJournalScope();
    scope.network(null).add({ engine: 'browserview', url: 'https://x.com/' });
    expect(scope.keyOf(null)).toBe(VIEW_OWNER_KEY);
    expect(scope.keys()).toEqual([VIEW_OWNER_KEY]);
    expect(scope.drop(null)).toBe(true);
    expect(scope.keys()).toEqual([]);

    scope.console('sess-a').add({ engine: 'browserview', level: 'error', text: 'x' });
    scope.console('sess-b').add({ engine: 'playwright', level: 'error', text: 'y' });
    expect(scope.keys()).toHaveLength(2);
    scope.reset();
    expect(scope.keys()).toEqual([]);
  });

  it('页面侧时间线条目也带 engine，否则同会话跨引擎无法区分来源', () => {
    const journal = createTimelineJournal();
    journal.addBindingPayload(
      JSON.stringify({ channel: TIMELINE_CHANNEL, type: 'click', ts: Date.now() }),
      'playwright'
    );
    journal.add({ type: 'navigate', source: 'agent', engine: 'browserview', url: 'https://a.com' });
    expect(journal.list({})[0].engine).toBe('playwright');
    expect(journal.status()).toMatchObject({ total: 2, pageEvents: 1, agentEvents: 1 });
    expect(journal.status({ engine: 'playwright' })).toMatchObject({ total: 1, pageEvents: 1 });
    expect(journal.status({ engine: 'browserview' })).toMatchObject({ total: 1, agentEvents: 1 });
    // 非本通道的 payload 仍然被拒
    expect(journal.addBindingPayload(JSON.stringify({ channel: 'nope', type: 'click' }), 'playwright')).toBeNull();
  });

  it('读取入口只有一个：两个 runner 不再各自实现 journal 读取', () => {
    const fs = require('fs');
    const path = require('path');
    const root = path.join(__dirname, '..', '..', 'src', 'browser');
    const service = fs.readFileSync(path.join(root, 'service.js'), 'utf8');
    expect(service.match(/function journalQuery\(/g)).toHaveLength(1);
    for (const file of ['controller.js', 'playwright-runner.js']) {
      const src = fs.readFileSync(path.join(root, file), 'utf8');
      expect(src, `${file} 不应再自带 journal 读取实现`).not.toMatch(/function (network|consoleMessages|timeline)\(/);
      expect(src, `${file} 的写入应经访问器按会话归属`).not.toMatch(
        /[^()]\b(networkJournal|consoleJournal|timelineJournal)\.(add|list|status|clear)/
      );
      expect(src, `${file} 应通过 journal-scope 写入`).toContain('journals.');
    }
  });
});

describe('空闲会话回收（P2-7：无头实例不长期挂着）', () => {
  it('status 暴露回收阈值与每个会话的最后使用时间', () => {
    const runner = createPlaywrightRunner({ log: () => {}, idleSessionMs: 5000 });
    const st = runner.status();
    expect(st.idleSessionMs).toBe(5000);
    expect(st.sessionCount).toBe(0);
    expect(st.sessions).toEqual([]);
  });

  it('reapIdleSessions 在无会话时安全返回；0 = 关闭回收', async () => {
    const runner = createPlaywrightRunner({ log: () => {}, idleSessionMs: 5000 });
    expect(await runner.reapIdleSessions()).toMatchObject({ ok: true, closed: [], idleMs: 5000 });
    const off = createPlaywrightRunner({ log: () => {}, idleSessionMs: 0 });
    expect(off.status().idleSessionMs).toBe(0);
    expect(await off.reapIdleSessions()).toMatchObject({ ok: true, closed: [] });
  });

  it('非法 / 缺省阈值回落到默认值（不会被环境变量塞成 NaN 或负数）', () => {
    expect(createPlaywrightRunner({ log: () => {} }).status().idleSessionMs).toBeGreaterThan(0);
    expect(createPlaywrightRunner({ log: () => {}, idleSessionMs: 'abc' }).status().idleSessionMs).toBeGreaterThan(0);
    expect(createPlaywrightRunner({ log: () => {}, idleSessionMs: -1 }).status().idleSessionMs).toBeGreaterThan(0);
  });

  it('回收必须先摘账再关页面，否则并发新建的会话会被迟到的 delete 抹掉', () => {
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'browser', 'playwright-runner.js'), 'utf8');
    const body = src.slice(src.indexOf('async function closeSession('), src.indexOf('function attachPageEvents('));
    expect(body).toContain('sessions.delete(key)');
    expect(
      body.indexOf('sessions.delete(key)'),
      'closeSession 应先从 sessions 摘账，再 await 关页面'
    ).toBeLessThan(body.indexOf('await entry.page.close()'));
  });

  it('有操作在途的会话不回收（长操作不能被误判成空闲）', () => {
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'browser', 'playwright-runner.js'), 'utf8');
    const body = src.slice(
      src.indexOf('async function reapIdleSessions('),
      src.indexOf('function ensureIdleSweep(')
    );
    // lastUsedAt 是「操作开始时间」：跑得比 idleSessionMs 还久的操作必须靠在途计数兜住，
    // 否则页会在操作执行中被关掉，操作当场以 Target closed 失败
    expect(body).toContain('if (isOpInFlight(key)) continue;');
    expect(
      body.indexOf('if (isOpInFlight(key)) continue;'),
      '在途判定要先于空闲时长判定'
    ).toBeLessThan(body.indexOf('now - last < idleSessionMs'));
  });

  it('对外 API 统一经 trackSessionOps 装饰，且不改变同步/异步语义', async () => {
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'browser', 'playwright-runner.js'), 'utf8');
    expect(src, '导出必须走装饰器，否则在途登记会漏方法').toContain('return trackSessionOps({');
    const body = src.slice(src.indexOf('function trackSessionOps('), src.indexOf('async function reapIdleSessions('));
    expect(body).toContain('resolveSessionKey(');
    expect(body).toContain('enterOp(key)');
    expect(body).toContain('exitOp(key)');

    const runner = createPlaywrightRunner({ log: () => {}, idleSessionMs: 5000 });
    // status() 是同步方法：被包成 async 的话这里拿到的就是 Promise 而不是结果对象
    expect(runner.status()).toMatchObject({ ok: true, engine: 'playwright' });
    // 异步方法照旧返回可 await 的 promise
    await expect(runner.reapIdleSessions()).resolves.toMatchObject({ ok: true, closed: [] });
    await expect(runner.close()).resolves.toMatchObject({ ok: true });
  });
});

describe('定位失败契约（ref 失效诊断只组装「返回的失败体」）', () => {
  const fs = require('fs');
  const path = require('path');
  const root = path.join(__dirname, '..', '..', 'src', 'browser');

  it('playwright 各交互方法定位失败一律返回失败体，不得抛错绕过诊断组装', () => {
    const src = fs.readFileSync(path.join(root, 'playwright-runner.js'), 'utf8');
    // 抛错会被 harness 归一成 EXCEPTION，ref 失效诊断（engine/instanceId/refEpoch/建议）全部丢失
    expect(src, '定位失败不得再抛错').not.toMatch(/err\.code = located\.errorCode/);
    const returns = src.match(/if \(!located\.ok\) return \{/g) || [];
    expect(returns.length, 'click/hover/type/select/scroll/expect/upload 等都应走返回').toBeGreaterThanOrEqual(6);
  });

  it('BrowserView 的 expect 失败体保留 ref 来源，供上层补全诊断', () => {
    const src = fs.readFileSync(path.join(root, 'controller.js'), 'utf8');
    const body = src.slice(src.indexOf('async function expect('), src.indexOf('async function readLocalStorage('));
    expect(body).toContain('snapshotId: raw.snapshotId');
    expect(body).toContain('currentSnapshotId: raw.currentSnapshotId');
  });

  it('旧 ref 失效说明是单一来源，且写明两种 code 各自的触发条件', () => {
    const note = refLifecycleNote();
    // 报 REF_NO_SNAPSHOT 的条件：页面已跳转（新文档没有 snapshot 印章）
    expect(note).toContain('REF_NO_SNAPSHOT');
    expect(note).toContain('页面跳转');
    // 报 REF_EXPIRED 的条件：同一文档内再次 snapshot（origin 已不是当前 snapshot）
    expect(note).toContain('REF_EXPIRED');
    expect(note).toContain('再次 snapshot');
    expect(note).toContain('browser_snapshot');

    // 生成给页面的 snapshot note 引用同一份文案（不是各自抄一遍）
    expect(buildSnapshotScript({}).includes(JSON.stringify(note))).toBe(true);

    // 两套引擎的 note 都取自 ref-namespace，不再各自硬编码说法
    const playwrightSrc = fs.readFileSync(path.join(root, 'playwright-runner.js'), 'utf8');
    expect(playwrightSrc).toContain('refLifecycleNote');
    expect(playwrightSrc).not.toContain('会明确报 REF_EXPIRED');
  });

  it('定位失败体自报当场 url，供上层区分「跳转导致」与「被新 snapshot 取代」', () => {
    // 页面内失败（BrowserView / Playwright 的 evaluate 路径）由 location.href 自报
    expect(FRAME_HELPERS).toContain('out.url = String(location.href)');
    // Playwright 的 Node 侧失败体由 page.url() 自报
    const src = fs.readFileSync(path.join(root, 'playwright-runner.js'), 'utf8');
    const body = src.slice(src.indexOf('async function locateTarget('), src.indexOf('async function locateTarget(') + 700);
    expect(body).toContain('page.url()');
    expect(body).toContain('url: currentUrl');
  });
});
