'use strict';

/**
 * 快捷键（renderer-shortcuts.js）纯逻辑冒烟：组合键解析 / 事件→组合键 / 匹配 / 冲突 / 持久化。
 *
 * 直接 `vm` 加载真实文件（不复制一份逻辑到测试里），只给最小 window / document 桩：
 * 本模块顶层不做 DOM 访问，测的都是按键判定与键位表本身。
 *
 * Run: node scripts/test-shortcuts.cjs
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SOURCE_PATH = path.join(__dirname, '..', 'src', 'renderer', 'renderer-shortcuts.js');

function loadShortcutsModule(settingsRef) {
  const source = fs.readFileSync(SOURCE_PATH, 'utf8');
  const saved = [];
  const sandbox = {
    console,
    settings: settingsRef.value,
    saveSettings: (s) => saved.push(JSON.parse(JSON.stringify(s))),
    escapeHtml: (v) => String(v == null ? '' : v),
    window: { addEventListener() {} },
    document: {
      querySelectorAll: () => [],
      querySelector: () => null,
      getElementById: () => null,
      addEventListener() {}
    },
    savedCalls: saved
  };
  sandbox.window.window = sandbox.window;
  const ctx = vm.createContext(sandbox);
  vm.runInContext(source, ctx, { filename: 'renderer-shortcuts.js' });
  return { ctx, saved };
}

function keyEvent(partial) {
  return {
    code: '',
    key: '',
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    metaKey: false,
    repeat: false,
    ...partial
  };
}

function main() {
  const settingsRef = { value: { shortcuts: {} } };
  const { ctx, saved } = loadShortcutsModule(settingsRef);
  const {
    comboFromShortcutEvent,
    getShortcutCombo,
    matchesShortcut,
    parseShortcutCombo,
    saveShortcutCombo,
    shortcutConflict
  } = ctx;

  // ---- 解析：修饰键大小写 / 别名都落到同一个口径 ----
  const parsed = parseShortcutCombo('ctrl+shift+m');
  assert.strictEqual(parsed.ctrl, true);
  assert.strictEqual(parsed.shift, true);
  assert.strictEqual(parsed.alt, false);
  assert.strictEqual(parsed.key, 'M');
  // ⌘ / Win 并入 Ctrl：与旧代码 ev.ctrlKey || ev.metaKey 一致
  assert.strictEqual(parseShortcutCombo('Cmd+M').ctrl, true);
  assert.strictEqual(parseShortcutCombo('Meta+M').ctrl, true);
  // 'Alt+Option' 只算一次 Alt（重复修饰键不叠加）
  const altOnly = parseShortcutCombo('Alt+Option');
  assert.strictEqual(altOnly.alt, true);
  assert.strictEqual(altOnly.ctrl, false);
  assert.strictEqual(altOnly.shift, false);

  // ---- 事件 → 组合键：用 code 取主键（Shift+1 不会变成 Shift+!） ----
  assert.strictEqual(comboFromShortcutEvent(keyEvent({ code: 'KeyM', key: 'm', ctrlKey: true })), 'Ctrl+M');
  assert.strictEqual(comboFromShortcutEvent(keyEvent({ code: 'KeyM', key: 'M', ctrlKey: true, shiftKey: true })), 'Ctrl+Shift+M');
  assert.strictEqual(comboFromShortcutEvent(keyEvent({ code: 'Digit1', key: '!', ctrlKey: true, shiftKey: true })), 'Ctrl+Shift+1');
  assert.strictEqual(comboFromShortcutEvent(keyEvent({ code: 'F5', key: 'F5' })), 'F5');
  assert.strictEqual(comboFromShortcutEvent(keyEvent({ code: 'Space', key: ' ', altKey: true })), 'Alt+Space');
  assert.strictEqual(comboFromShortcutEvent(keyEvent({ code: 'ArrowUp', key: 'ArrowUp', ctrlKey: true })), 'Ctrl+ArrowUp');
  // 裸字母 / 裸数字不允许（会让正常打字不可用）
  assert.strictEqual(comboFromShortcutEvent(keyEvent({ code: 'KeyM', key: 'm' })), '');
  // 只按修饰键：还没按到主键，继续等
  assert.strictEqual(comboFromShortcutEvent(keyEvent({ code: 'ControlLeft', key: 'Control', ctrlKey: true })), '');
  // 输入法组字中 / 无效键
  assert.strictEqual(comboFromShortcutEvent(keyEvent({ code: '', key: 'Process' })), '');

  // ---- 默认键位与匹配 ----
  assert.strictEqual(getShortcutCombo('voice.toggle'), 'Ctrl+M');
  assert.strictEqual(getShortcutCombo('settings.open'), 'Alt+S');
  assert.strictEqual(matchesShortcut(keyEvent({ code: 'KeyM', key: 'm', ctrlKey: true }), 'voice.toggle'), true);
  assert.strictEqual(matchesShortcut(keyEvent({ code: 'KeyM', key: 'm', ctrlKey: true, shiftKey: true }), 'voice.toggle'), false);
  assert.strictEqual(matchesShortcut(keyEvent({ code: 'KeyM', key: 'm' }), 'voice.toggle'), false);
  // macOS 的 ⌘M 与 Ctrl+M 等价
  assert.strictEqual(matchesShortcut(keyEvent({ code: 'KeyM', key: 'm', metaKey: true }), 'voice.toggle'), true);
  // 未登记的 id 不匹配任何键（不会误触发）
  assert.strictEqual(matchesShortcut(keyEvent({ code: 'KeyM', key: 'm', ctrlKey: true }), 'nope.nope'), false);

  // ---- 改键：落在 settings.shortcuts，立刻生效 ----
  assert.strictEqual(saveShortcutCombo('voice.toggle', 'Ctrl+Shift+M'), true);
  assert.strictEqual(settingsRef.value.shortcuts['voice.toggle'], 'Ctrl+Shift+M');
  assert.strictEqual(saved.length, 1);
  assert.strictEqual(matchesShortcut(keyEvent({ code: 'KeyM', key: 'm', ctrlKey: true, shiftKey: true }), 'voice.toggle'), true);
  assert.strictEqual(matchesShortcut(keyEvent({ code: 'KeyM', key: 'm', ctrlKey: true }), 'voice.toggle'), false);

  // ---- 冲突：已被别的快捷键占用时能报出那一条 ----
  const conflict = shortcutConflict('voice.toggle', 'Alt+S');
  assert.ok(conflict && conflict.id === 'settings.open', 'Alt+S 应识别为 settings.open 占用');
  assert.strictEqual(shortcutConflict('voice.toggle', 'Ctrl+Shift+M'), null);

  // ---- 恢复默认：不留在设置里当冗余副本 ----
  assert.strictEqual(saveShortcutCombo('voice.toggle', 'Ctrl+M'), true);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(settingsRef.value.shortcuts, 'voice.toggle'), false);
  assert.strictEqual(getShortcutCombo('voice.toggle'), 'Ctrl+M');
  // 传空串等价于恢复默认
  saveShortcutCombo('settings.open', 'Ctrl+Alt+O');
  saveShortcutCombo('settings.open', '');
  assert.strictEqual(Object.prototype.hasOwnProperty.call(settingsRef.value.shortcuts, 'settings.open'), false);

  // ---- 未知 id 写入不了（键位表才是单一来源） ----
  assert.strictEqual(saveShortcutCombo('nope.nope', 'Ctrl+Q'), false);

  console.log('ok shortcuts tests');
}

main();
