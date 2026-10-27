'use strict';

/**
 * computer 工具的键名解析（win32-input.parseKeyCombo，纯函数不触 koffi）
 * 与沙箱档位判定（sandbox-policy.decideOsControlAction）。
 */

const { parseKeyCombo, SUPPORTED_KEY_TOKENS } = require('../../src/computer/win32-input');
const { decideOsControlAction, SANDBOX_CATEGORIES } = require('../../src/gateway/sandbox-policy');

describe('parseKeyCombo', () => {
  it('ctrl+c：修饰键 + 主键 VK', () => {
    const r = parseKeyCombo('ctrl+c');
    expect(r.modifiers).toEqual(['ctrl']);
    expect(r.key).toBe('c');
    expect(r.vk).toBe(0x43);
    expect(r.extended).toBe(false);
  });

  it('多修饰键保序', () => {
    const r = parseKeyCombo('ctrl+shift+esc');
    expect(r.modifiers).toEqual(['ctrl', 'shift']);
    expect(r.vk).toBe(0x1b);
  });

  it('方向键带扩展键标记，普通键不带', () => {
    expect(parseKeyCombo('up').extended).toBe(true);
    expect(parseKeyCombo('delete').extended).toBe(true);
    expect(parseKeyCombo('f4').extended).toBe(false);
    expect(parseKeyCombo('ctrl+c').extended).toBe(false);
  });

  it('纯修饰键（win）按下再释放是合法动作', () => {
    const r = parseKeyCombo('win');
    expect(r.key).toBe('win');
    expect(r.modifiers).toEqual([]);
    expect(r.vk).toBe(0x5b);
  });

  it('ctrl+alt+delete 是系统安全序列，直接拒绝', () => {
    expect(() => parseKeyCombo('ctrl+alt+delete')).toThrow(/安全序列/);
  });

  it('未知键名与空键报 INVALID_KEY', () => {
    expect(() => parseKeyCombo('ctrl+ destabilize')).toThrow(/不认识的键|无效/);
    expect(() => parseKeyCombo('')).toThrow(/无效|为空/);
  });

  it('键名表覆盖常用键（字母/数字/F1-F24/导航/修饰/常用标点）', () => {
    for (const t of ['a', 'z', '0', '9', 'f1', 'f24', 'enter', 'tab', 'esc', 'space', 'home', 'end', 'win', 'ctrl', 'alt', 'shift', 'minus', 'slash']) {
      expect(SUPPORTED_KEY_TOKENS).toContain(t);
    }
  });
});

describe('decideOsControlAction', () => {
  it('截屏：任何档位都放行（开关即同意读屏）', () => {
    for (const mode of ['read-only', 'workspace-write', 'danger-full-access']) {
      const d = decideOsControlAction('screenshot', { mode });
      expect(d.action).toBe('allow');
      expect(d.category).toBe(SANDBOX_CATEGORIES.OS_CONTROL);
    }
  });

  it('输入动作：非 danger 档 ask-once', () => {
    for (const act of ['click', 'type', 'key', 'scroll', 'drag', 'move']) {
      const d = decideOsControlAction(act, { mode: 'workspace-write' });
      expect(d.action).toBe('ask');
      expect(d.category).toBe(SANDBOX_CATEGORIES.OS_CONTROL);
    }
    const ro = decideOsControlAction('click', { mode: 'read-only' });
    expect(ro.action).toBe('ask');
  });

  it('输入动作：danger-full-access 直接放行', () => {
    const d = decideOsControlAction('type', { mode: 'danger-full-access' });
    expect(d.action).toBe('allow');
  });

  it('wait 不属于输入动作（不改变系统状态）', () => {
    expect(decideOsControlAction('wait', { mode: 'read-only' }).action).toBe('allow');
  });

  it('白名单倒置：未知/新增动作必须 ask（fail-closed，不能静默放行）', () => {
    for (const act of ['long_press', 'paste_clipboard', '', 'screenshot ']) {
      const d = decideOsControlAction(act, { mode: 'workspace-write' });
      expect(d.action).toBe('ask');
    }
    // 完全放开档仍然是全放行（档位语义优先）
    expect(decideOsControlAction('long_press', { mode: 'danger-full-access' }).action).toBe('allow');
  });
});
