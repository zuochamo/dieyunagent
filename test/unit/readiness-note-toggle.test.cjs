'use strict';

/**
 * 「显示完成验收提示」开关（设置 → 主题）。
 *
 * 偏好存在 `diecloud.trace.prefs.v1` 的 `showReadiness` 字段（与其它聊天区显示开关同一份
 * `tracePrefs`），读取方只有 `agent-guardrails.js: applyReadinessNote` —— 它是验收提示的
 * 唯一渲染出口（ruleGate / reviewer 两个来源都经过它），所以开关只在那里判一次。
 *
 * 关掉的语义：不往回复正文追加提示；`readiness.evidence` / `ok` 照旧，排查不受影响。
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const NOTE_RE = /完成验收/;

function loadRendererGuardrails(tracePrefs) {
  const shared = require('../../src/agent/guardrails-shared');
  const file = path.join(__dirname, '../../src/renderer/agent-guardrails.js');
  const sandbox = {
    window: {},
    GuardrailsShared: shared,
    getAgentLimits: () => ({}),
    console
  };
  // 真实环境里 tracePrefs 是 renderer-theme.js 的同作用域 var；未传入即模拟「尚未加载」
  if (tracePrefs !== undefined) sandbox.tracePrefs = tracePrefs;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(file, 'utf8'), sandbox, { filename: file });
  return sandbox.window;
}

const READINESS = { ok: false, surfaceToUser: true, note: '浏览器操作后检测到页面运行时错误。' };

describe('完成验收提示显示开关', () => {
  test('默认（未设置）照常追加提示', () => {
    const w = loadRendererGuardrails();
    expect(NOTE_RE.test(w.applyReadinessNote('正文', READINESS))).toBe(true);
  });

  test('showReadiness !== false 时照常追加', () => {
    const w = loadRendererGuardrails({ showReadiness: true, showReasoning: false });
    expect(NOTE_RE.test(w.applyReadinessNote('正文', READINESS))).toBe(true);
  });

  test('showReadiness === false 时不追加，正文原样返回', () => {
    const w = loadRendererGuardrails({ showReadiness: false });
    const out = w.applyReadinessNote('正文', READINESS);
    expect(NOTE_RE.test(out)).toBe(false);
    expect(out).toBe('正文');
  });

  test('关掉后也不影响已存在提示的剥离（幂等链不断）', () => {
    const w = loadRendererGuardrails({ showReadiness: false });
    const dirty = '正文\n\n---\n\n> ⚠️ **完成验收**：旧提示。';
    // 开关关闭时直接原样返回，历史消息本来也不会重绘；
    // 这里只断言不会「因为开关关闭而多出一段」
    expect(NOTE_RE.test(w.applyReadinessNote(dirty, READINESS))).toBe(true);
    expect(String(w.applyReadinessNote(dirty, READINESS)).split('完成验收').length - 1).toBe(1);
  });

  test('showReadiness 为脏数据时不误关（只认严格的 false）', () => {
    const w = loadRendererGuardrails({ showReadiness: 'false' });
    expect(NOTE_RE.test(w.applyReadinessNote('正文', READINESS))).toBe(true);
  });

  test('tracePrefs 缺失/为 null 时不崩', () => {
    expect(() => loadRendererGuardrails(null).applyReadinessNote('正文', READINESS)).not.toThrow();
  });
});

describe('偏好读写（renderer-theme 的 loadTracePrefs）', () => {
  function loadThemePrefs(stored) {
    const file = path.join(__dirname, '../../src/renderer/renderer-theme.js');
    const sandbox = {
      window: {
        localStorage: {
          getItem: (key) => (key === 'diecloud.trace.prefs.v1' ? stored : null),
          setItem: () => {}
        },
        diecloud: {}
      },
      document: {
        documentElement: {
          style: {},
          dataset: {},
          setAttribute() {},
          removeAttribute() {},
          getAttribute: () => null
        },
        querySelectorAll: () => []
      },
      $: () => null,
      renderChatFromMessages: () => {},
      console
    };
    vm.createContext(sandbox);
    // 整文件执行会顺带跑 initTheme/initColorTemperature 等，用最小 DOM 桩兜住
    vm.runInContext(fs.readFileSync(file, 'utf8'), sandbox, { filename: file });
    return sandbox.tracePrefs;
  }

  test('旧存档（无 showReadiness 字段）默认显示', () => {
    const prefs = loadThemePrefs(JSON.stringify({ showReasoning: true }));
    expect(prefs.showReadiness).toBe(true);
  });

  test('存档里显式关闭能读回来', () => {
    const prefs = loadThemePrefs(JSON.stringify({ showReadiness: false }));
    expect(prefs.showReadiness).toBe(false);
  });

  test('存档损坏时回落到默认（显示）', () => {
    const prefs = loadThemePrefs('{not json');
    expect(prefs.showReadiness).toBe(true);
  });
});

describe('设置页 checkbox 绑定（#trace-show-readiness）', () => {
  /** 用假 DOM 驱动真实 renderer-theme.js：连线 → change → 写回 localStorage。 */
  function bootWithCheckbox() {
    const file = path.join(__dirname, '../../src/renderer/renderer-theme.js');
    const handlers = {};
    const saved = {};
    const box = {
      checked: true,
      addEventListener: (type, fn) => {
        handlers[type] = fn;
      }
    };
    const sandbox = {
      window: {
        localStorage: {
          getItem: () => null,
          setItem: (key, value) => {
            saved[key] = value;
          }
        },
        diecloud: {}
      },
      document: {
        documentElement: {
          style: {},
          dataset: {},
          setAttribute() {},
          removeAttribute() {},
          getAttribute: () => null
        },
        querySelectorAll: () => []
      },
      $: (id) => (id === 'trace-show-readiness' ? box : null),
      renderChatFromMessages: () => {},
      console
    };
    vm.createContext(sandbox);
    vm.runInContext(fs.readFileSync(file, 'utf8'), sandbox, { filename: file });
    return { box, handlers, saved, sandbox };
  }

  test('取消勾选 → tracePrefs.showReadiness=false 并落盘', () => {
    const { box, handlers, saved } = bootWithCheckbox();
    expect(box.checked).toBe(true); // 初始从默认值同步
    box.checked = false;
    handlers.change();
    const persisted = JSON.parse(saved['diecloud.trace.prefs.v1'] || '{}');
    expect(persisted.showReadiness).toBe(false);
  });

  test('重新勾选 → 恢复显示', () => {
    const { box, handlers, saved } = bootWithCheckbox();
    box.checked = false;
    handlers.change();
    box.checked = true;
    handlers.change();
    const persisted = JSON.parse(saved['diecloud.trace.prefs.v1'] || '{}');
    expect(persisted.showReadiness).toBe(true);
  });

  test('落盘后立刻被 agent-guardrails 读到（同一条链）', () => {
    const { box, handlers, saved } = bootWithCheckbox();
    box.checked = false;
    handlers.change();
    const persisted = JSON.parse(saved['diecloud.trace.prefs.v1'] || '{}');
    const w = loadRendererGuardrails(persisted);
    expect(NOTE_RE.test(w.applyReadinessNote('正文', READINESS))).toBe(false);
  });
});
