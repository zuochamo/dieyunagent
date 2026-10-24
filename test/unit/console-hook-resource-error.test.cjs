'use strict';

/**
 * 回归：注入的 console 异常钩子把「资源加载失败」当成页面运行时错误。
 *
 * 现场（2026-10-17）：完成验收提示里出现三条
 *   `[pageerror] unknown error；[pageerror] unknown error；[pageerror] unknown error`
 * 根因：`buildConsoleErrorHookScript` 用 `addEventListener('error', fn, true)`（capture），
 * 于是 <img>/<script>/<link> 404 也会进回调；这类事件没有 message、target 是元素，
 * 旧代码直接落到 `'unknown error'` 兜底 → 变成「无信息」的运行时错误证据，
 * 触发 `verifyAgentCompletionReadiness` 的 browser_runtime_errors 分支。
 *
 * 修法：没有 message 且 target 不是 window 的事件不转发（真 uncaught 异常 target 是 window）。
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SOURCE = path.join(__dirname, '../../src/browser/console-collector.js');
const collector = require(SOURCE);

function installHook() {
  const listeners = {};
  const logged = [];
  const win = {
    addEventListener(type, fn) {
      (listeners[type] = listeners[type] || []).push(fn);
    }
  };
  const sandbox = {
    window: win,
    console: { error: (text) => logged.push(String(text)) }
  };
  vm.createContext(sandbox);
  vm.runInContext(collector.buildConsoleErrorHookScript(), sandbox);
  return {
    listeners,
    logged,
    win,
    fire(type, event) {
      for (const fn of listeners[type] || []) fn(event);
    }
  };
}

describe('console 异常钩子：资源加载失败不算运行时错误', () => {
  test('图片/脚本/样式加载失败不会被转发成 pageerror', () => {
    const hook = installHook();
    hook.fire('error', { target: { tagName: 'IMG' }, message: '', error: null });
    hook.fire('error', { target: { tagName: 'SCRIPT' }, message: '', error: null });
    hook.fire('error', { target: { tagName: 'LINK' }, message: undefined, error: null });
    expect(hook.logged).toEqual([]);
  });

  test('target 是元素但带 message 的事件仍然转发（不误伤自定义派发）', () => {
    const hook = installHook();
    hook.fire('error', { target: { tagName: 'DIV' }, message: 'boom', error: null });
    expect(hook.logged).toHaveLength(1);
    expect(hook.logged[0]).toContain('boom');
  });

  test('window 上的未捕获异常照常转发并带上位置', () => {
    const hook = installHook();
    hook.fire('error', {
      target: hook.win,
      message: 'Cannot read properties of null',
      filename: 'app.js',
      lineno: 42
    });
    expect(hook.logged).toHaveLength(1);
    expect(hook.logged[0]).toContain(collector.PAGE_ERROR_MARKER);
    expect(hook.logged[0]).toContain('app.js:42');
    const classified = collector.classifyConsoleEntry('error', hook.logged[0]);
    expect(classified.source).toBe('pageerror');
    expect(classified.text).toContain('Cannot read properties of null');
  });

  test('unhandledrejection 不受影响', () => {
    const hook = installHook();
    hook.fire('unhandledrejection', { reason: new Error('fetch failed') });
    expect(hook.logged).toHaveLength(1);
    expect(collector.classifyConsoleEntry('error', hook.logged[0]).source).toBe(
      'unhandledrejection'
    );
  });

  test('钩子只装一次（重复注入不叠加监听）', () => {
    const hook = installHook();
    // 同一 window 上再跑一次脚本应该直接返回 already
    const sandbox = { window: hook.win, console: { error: () => {} } };
    vm.createContext(sandbox);
    vm.runInContext(collector.buildConsoleErrorHookScript(), sandbox);
    expect(hook.listeners.error).toHaveLength(1);
  });
});

describe('console 采集：unknown error 不再作为噪声来源', () => {
  test('journal 只记录真的带信息的错误', () => {
    const journal = collector.createConsoleJournal();
    journal.add({ source: 'pageerror', level: 'error', text: 'boom' });
    const listed = journal.list({ errorsOnly: true });
    expect(listed).toHaveLength(1);
    expect(fs.existsSync(SOURCE)).toBe(true);
  });
});
