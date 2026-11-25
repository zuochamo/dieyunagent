'use strict';

/* globals describe, it, expect */

/**
 * 拖动的位置算账（`src/pet/drag.js`，纯函数）。
 *
 * 这三条是「宠物位置卡死 / 拖不动」的可算部分 —— `main/pet-window.js` 顶层 require('electron')
 * 装不进单测，所以算法搬进来直测：
 * 1. 抓取偏移丢了要能自愈，且**第一帧不跳**；
 * 2. 跨屏时窗口中心落进显示区之间的缝里，要夹进**最近**那台，不回退主屏；
 * 3. 窗口永远整块留在工作区内（含负坐标的左屏）。
 */

const {
  distanceToRectSq,
  pickWorkArea,
  clampIntoWorkArea,
  offsetForPointer,
  positionForPointer
} = require('../../src/pet/drag');

/** 两块屏：主屏 + 右边一台（中间留 40px 的缝，模拟混合 DPI 排列下系统报出来的空隙） */
const PRIMARY = { x: 0, y: 0, width: 1920, height: 1040 };
const RIGHT = { x: 1960, y: 0, width: 1280, height: 1000 };
const AREAS = [PRIMARY, RIGHT];

describe('pet drag', () => {
  it('中心在屏内：夹进那一台', () => {
    expect(pickWorkArea(AREAS, 500, 500, PRIMARY)).toBe(PRIMARY);
    expect(pickWorkArea(AREAS, 2400, 500, PRIMARY)).toBe(RIGHT);
  });

  it('中心落在两屏之间的缝里：取最近那台，不回退主屏', () => {
    // 缝隙 1920..1960；x=1950 离 RIGHT(1960) 更近 → 必须选右屏
    expect(pickWorkArea(AREAS, 1950, 500, PRIMARY)).toBe(RIGHT);
    // 反向：x=1925 离主屏更近
    expect(pickWorkArea(AREAS, 1925, 500, PRIMARY)).toBe(PRIMARY);
    // 一个屏都没有时（取不到显示器列表）才用兜底
    expect(pickWorkArea([], 10, 10, PRIMARY)).toBe(PRIMARY);
  });

  it('距离函数：内部为 0，外部是到边的距离平方', () => {
    expect(distanceToRectSq(100, 100, PRIMARY)).toBe(0);
    expect(distanceToRectSq(1930, 100, PRIMARY)).toBe(10 * 10);
    expect(distanceToRectSq(1930, 1200, PRIMARY)).toBe(10 * 10 + 160 * 160);
  });

  it('夹取：窗口整块留在工作区内（含负坐标左屏与超宽窗口）', () => {
    const left = { x: -1280, y: -100, width: 1280, height: 1000 };
    expect(clampIntoWorkArea([left], -2000, -500, 210, left)).toEqual({ x: -1280, y: -100 });
    expect(clampIntoWorkArea([left], 0, 0, 210, left)).toEqual({ x: -210, y: 0 });

    // 窗口比工作区还宽：至少不能算出一个在左边框外的位置（不做负宽）
    const tiny = { x: 0, y: 0, width: 100, height: 100 };
    const pos = clampIntoWorkArea([tiny], 500, 500, 280, tiny);
    expect(pos.x).toBe(0);
    expect(pos.y).toBe(0);
  });

  it('偏移丢失时自愈：第一次移动窗口不跳，之后 1:1 跟指针', () => {
    const bounds = { x: 800, y: 600, width: 210, height: 210 };
    const pointer = { x: 880, y: 700 }; // 指针在窗口内的 (80, 100)
    // dragStart 没成功 → 没有 offset，用「指针 − 当前左上角」现补
    const offset = offsetForPointer(bounds, pointer);
    const first = positionForPointer(AREAS, bounds, offset, pointer, PRIMARY);
    expect(first).toEqual({ x: 800, y: 600 }); // 不跳

    // 之后按同一份偏移跟指针走：指针 +30/+15 → 窗口 +30/+15
    const moved = positionForPointer(AREAS, bounds, offset, { x: 910, y: 715 }, PRIMARY);
    expect(moved).toEqual({ x: 830, y: 615 });
  });

  it('拖动时不会跑出工作区（指针甩到屏外 → 夹在边缘）', () => {
    const bounds = { x: 800, y: 600, width: 210, height: 210 };
    const offset = { x: 80, y: 100 };
    // 甩到主屏右边界之外、但仍在主屏范围内（不应跳到右屏）
    const pos = positionForPointer(AREAS, bounds, offset, { x: 1900, y: 20 }, PRIMARY);
    expect(pos.x).toBe(PRIMARY.x + PRIMARY.width - 210);
    expect(pos.y).toBe(PRIMARY.y);
    // 甩到很远（落进右屏区域）：跟着指针去右屏，仍不跑出右屏边界
    const far = positionForPointer(AREAS, bounds, offset, { x: 99999, y: -99999 }, PRIMARY);
    expect(far.x).toBe(RIGHT.x + RIGHT.width - 210);
    expect(far.y).toBe(RIGHT.y);
  });
});
