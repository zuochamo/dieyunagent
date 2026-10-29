'use strict';

/**
 * 回归：同一条 assistant 消息里「完成验收」提示出现两次。
 *
 * 现场（2026-10-17，messages.id=4834）：
 *   正文 → --- → > ⚠️ **完成验收**：… → --- → > ⚠️ **完成验收**：…（一字不差两遍）
 *
 * 链路：旧的 `collectCompletionDiagnosticsForRun` 往 trace 里写了一条「完成验收」phase（伪轮次），
 * 其 thought 被 `reasoningTextFromTrace` 当真思考落进 `messages.reasoning` 并上行回传；正文里的
 * 提示也随 `messages.content` 作为历史回显 ⇒ 模型照着复述一遍，渲染层再追加一次 = 两段。
 * （那条伪轮次已随「完成验收判定搬到 Main」一起删除，但正文提示仍会进历史，幂等闸门要留着。）
 *
 * 修法（两条同源闸门）：
 *   1. `session-context.assistantTextFromMessage`（历史投影唯一出口）剥掉验收提示；
 *   2. `guardrails-shared.stripReadinessNotes` 被 `applyReadinessNote` 复用做幂等。
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { stripReadinessNotes } = require('../../src/agent/guardrails-shared');
const { assistantTextFromMessage } = require('../../src/agent/session-context');

const NOTE =
  '> ⚠️ **完成验收**：写入后静态检查仍有 error 级诊断。请继续修复诊断问题；如果无法自动修复，请说明卡点。';
const count = (s) => String(s || '').split('完成验收').length - 1;

function loadRendererGuardrails() {
  const shared = require('../../src/agent/guardrails-shared');
  const file = path.join(__dirname, '../../src/renderer/agent-guardrails.js');
  const sandbox = {
    window: {},
    GuardrailsShared: shared,
    getAgentLimits: () => ({}),
    console
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(file, 'utf8'), sandbox, { filename: file });
  return sandbox.window;
}

describe('完成验收提示不重复', () => {
  test('剥离：同一提示出现两次也能一次清干净', () => {
    const text = `正文\n\n---\n\n${NOTE}\n\n---\n\n${NOTE}`;
    expect(count(text)).toBe(2);
    const out = stripReadinessNotes(text);
    expect(count(out)).toBe(0);
    expect(out).toBe('正文');
  });

  test('剥离：开头就是提示（无前置换行）也能删', () => {
    expect(count(stripReadinessNotes(`---\n\n${NOTE}`))).toBe(0);
  });

  test('剥离：没有提示的正文原样返回（不误伤）', () => {
    const text = '正常交付正文。\n\n---\n\n> 备注：这段不是验收提示。';
    expect(stripReadinessNotes(text)).toBe(text);
  });

  test('历史投影：上行给模型的正文不含验收提示', () => {
    const text = `正文\n\n---\n\n${NOTE}\n\n---\n\n${NOTE}`;
    const projected = assistantTextFromMessage({ role: 'assistant', content: text }, {});
    expect(count(projected)).toBe(0);
    expect(projected).toContain('正文');
  });

  test('历史投影：整条只有提示时回退占位，不把提示当正文喂回去', () => {
    const projected = assistantTextFromMessage({ role: 'assistant', content: `---\n\n${NOTE}` }, {});
    expect(count(projected)).toBe(0);
    expect(projected).toBe('（模型未生成文字答复。）');
  });

  test('applyReadinessNote：已有提示时只保留一段（幂等）', () => {
    const w = loadRendererGuardrails();
    const readiness = { ok: false, surfaceToUser: true, note: '写入后静态检查仍有 error 级诊断。' };
    const once = w.applyReadinessNote('正文', readiness);
    expect(count(once)).toBe(1);
    const twice = w.applyReadinessNote(once, readiness);
    expect(count(twice)).toBe(1);
    expect(twice).toBe(once);
  });

  test('applyReadinessNote：无 note / 不面向用户时不动正文', () => {
    const w = loadRendererGuardrails();
    expect(w.applyReadinessNote('正文', null)).toBe('正文');
    expect(w.applyReadinessNote('正文', { ok: true, note: 'x', surfaceToUser: true })).toBe('正文');
    expect(w.applyReadinessNote('正文', { ok: false, note: 'x', surfaceToUser: false })).toBe('正文');
  });
});
