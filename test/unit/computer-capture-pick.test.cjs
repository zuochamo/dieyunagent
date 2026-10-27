'use strict';

/**
 * 捕获源匹配（capture.pickSourceForDisplay）。
 *
 * 回归的是真机 bug：`Display` 上没有 displayId 字段 → 键恒为空 → 退回「按序号猜」，
 * 而 getSources() 的顺序与 getAllDisplays() 不保证一致（实测双屏机正好相反），
 * 结果把副屏画面当成主屏截图返回，坐标却按主屏几何换算 → 点击落在另一块屏。
 * 这里用真机数据（主屏 id 128932170 / 副屏 id 3858962195，源顺序与显示器顺序相反）。
 */

const { pickSourceForDisplay } = require('../../src/computer/capture');

const SOURCE_PRIMARY = { id: 'screen:0:0', display_id: '128932170', name: '屏幕 1' };
const SOURCE_SECONDARY = { id: 'screen:4:0', display_id: '3858962195', name: '屏幕 2' };
// 真机返回顺序：主屏在前
const SOURCES = [SOURCE_PRIMARY, SOURCE_SECONDARY];

const DISPLAY_PRIMARY = { index: 0, id: 128932170, displayId: '128932170', primary: true };
const DISPLAY_SECONDARY = { index: 1, id: 3858962195, displayId: '3858962195', primary: false };

describe('capture.pickSourceForDisplay', () => {
  it('按 display_id 匹配，不受源顺序影响', () => {
    expect(pickSourceForDisplay(SOURCES, DISPLAY_PRIMARY)).toBe(SOURCE_PRIMARY);
    expect(pickSourceForDisplay(SOURCES, DISPLAY_SECONDARY)).toBe(SOURCE_SECONDARY);
    // 顺序反过来也一样
    const reversed = [SOURCE_SECONDARY, SOURCE_PRIMARY];
    expect(pickSourceForDisplay(reversed, DISPLAY_PRIMARY)).toBe(SOURCE_PRIMARY);
    expect(pickSourceForDisplay(reversed, DISPLAY_SECONDARY)).toBe(SOURCE_SECONDARY);
  });

  it('displayId 必须是 String(Display.id)：缺失时不按序号猜，直接报 CAPTURE_FAILED', () => {
    const brokenKey = { index: 0, id: 128932170, displayId: '', primary: true };
    let err = null;
    try {
      pickSourceForDisplay(SOURCES, brokenKey);
    } catch (e) {
      err = e;
    }
    expect(err).not.toBeNull();
    expect(err.code).toBe('CAPTURE_FAILED');
    // 报错要带现有源，方便排查（而不是静默给一张错屏）
    expect(err.message).toContain('128932170');
  });

  it('匹配不到时报错，绝不回落到 sources[display.index]', () => {
    const ghost = { index: 0, id: 999, displayId: '999', primary: true };
    expect(() => pickSourceForDisplay(SOURCES, ghost)).toThrow(/捕获失败/);
  });

  it('单屏单源允许无视 display_id（部分平台不提供）', () => {
    const noId = [{ id: 'screen:0:0', display_id: '' }];
    const display = { index: 0, displayId: '0', primary: true };
    expect(pickSourceForDisplay(noId, display, { singleDisplay: true })).toBe(noId[0]);
    // 多屏时不允许兜底
    expect(() => pickSourceForDisplay(noId, display, { singleDisplay: false })).toThrow(/捕获失败/);
  });
});
