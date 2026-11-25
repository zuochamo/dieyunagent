'use strict';

/* globals describe, it, expect, beforeEach, afterEach */

/**
 * 点点的两个硬约束：
 *
 * A. 形态表必须恰好 128 点且每次生成完全一致（「128 个点就是 128 个变量」是字面契约；
 *    猫不能每次长得不一样）。归一化保证任意形态体量一致（最长半轴 = 1）。
 * B. settings.json 是人可以手改的文件：读进来必须夹取（非法形状/颜色/滑杆值退默认），
 *    不能把畸形值送进悬浮窗。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const PetShapes = require('../../src/renderer/pet-window/pet-shapes');
const {
  DEFAULTS,
  normalizePetSettings,
  loadPetSettings,
  patchPetSettings,
  SIZE_MAX,
  MOTION_MAX,
  COUNT_MAX,
  COUNT_MIN,
  DOT_SCALE_MAX
} = require('../../src/pet/settings');

function pointsOf(name) {
  return PetShapes.shapePoints(name);
}

describe('pet-shapes', () => {
  it('点数恰为 128（字面契约）', () => {
    expect(PetShapes.PET_POINT_COUNT).toBe(128);
    for (const id of PetShapes.SHAPE_IDS) {
      expect(pointsOf(id).length).toBe(128 * 3);
    }
  });

  it('两次生成完全一致（形态是数据，不是随机艺术）', () => {
    // 形态表缓存在模块内：换一个新模块实例再取，应逐字节相同
    const fresh = require('../../src/renderer/pet-window/pet-shapes');
    for (const id of PetShapes.SHAPE_IDS) {
      expect(Array.from(fresh.shapePoints(id))).toEqual(Array.from(pointsOf(id)));
    }
  });

  it('球面：每点都在单位球上（斐波那契均匀分布）', () => {
    const pts = pointsOf('sphere');
    for (let i = 0; i < PetShapes.PET_POINT_COUNT; i++) {
      const x = pts[i * 3];
      const y = pts[i * 3 + 1];
      const z = pts[i * 3 + 2];
      expect(Math.sqrt(x * x + y * y + z * z)).toBeCloseTo(1, 5);
    }
  });

  it('猫：包围盒居中、最长半轴归一、2D 薄片（z 极小）', () => {
    const pts = pointsOf('cat');
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, maxAbsZ = 0;
    for (let i = 0; i < PetShapes.PET_POINT_COUNT; i++) {
      const x = pts[i * 3];
      const y = pts[i * 3 + 1];
      const z = pts[i * 3 + 2];
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      maxAbsZ = Math.max(maxAbsZ, Math.abs(z));
    }
    expect((minX + maxX) / 2).toBeCloseTo(0, 1);
    expect((minY + maxY) / 2).toBeCloseTo(0, 1);
    expect(Math.max((maxX - minX) / 2, (maxY - minY) / 2)).toBeCloseTo(1, 1);
    expect(maxAbsZ).toBeLessThanOrEqual(0.25); // 远侧腿带 z 深度分层（近大远小），不再是纯薄片
    expect(PetShapes.shapeKind('cat')).toBe('2d');
    expect(PetShapes.shapeKind('sphere')).toBe('3d');
  });

  it('未知形态/颜色退默认，不抛错', () => {
    expect(PetShapes.shapePoints('dog')).toBe(pointsOf('sphere'));
    expect(PetShapes.colorRgb('nope')).toEqual(PetShapes.colorRgb(PetShapes.DEFAULT_COLOR));
    expect(PetShapes.isValidColorId('cyan')).toBe(true);
    expect(PetShapes.isValidColorId('nope')).toBe(false);
  });

  it('点数可变：任意 count 恰好 n 点，球面/猫的规格不变', () => {
    for (const n of [64, 100, 128, 192, 256]) {
      const sphere = PetShapes.shapePointsFor('sphere', n);
      const cat = PetShapes.shapePointsFor('cat', n);
      expect(sphere.length).toBe(n * 3);
      expect(cat.length).toBe(n * 3);
      for (let i = 0; i < n; i++) {
        const x = sphere[i * 3];
        const y = sphere[i * 3 + 1];
        const z = sphere[i * 3 + 2];
        expect(Math.sqrt(x * x + y * y + z * z)).toBeCloseTo(1, 5);
      }
      // 猫：包围盒居中、最长半轴 1、薄片 z
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      for (let i = 0; i < n; i++) {
        minX = Math.min(minX, cat[i * 3]);
        maxX = Math.max(maxX, cat[i * 3]);
        minY = Math.min(minY, cat[i * 3 + 1]);
        maxY = Math.max(maxY, cat[i * 3 + 1]);
      }
      expect((minX + maxX) / 2).toBeCloseTo(0, 1);
      expect((minY + maxY) / 2).toBeCloseTo(0, 1);
      expect(Math.max((maxX - minX) / 2, (maxY - minY) / 2)).toBeGreaterThan(0.8); // 任意点数都大致撑满画框（嵌套采样小点数覆盖略小）
    }
  });

  it('点数缓存：同一 (形态, 点数) 返回同一张表', () => {
    expect(PetShapes.shapePointsFor('sphere', 200)).toBe(PetShapes.shapePointsFor('sphere', 200));
    expect(PetShapes.shapePointsFor('sphere', 200)).not.toBe(PetShapes.shapePointsFor('sphere', 128));
  });

  it('非法点数：非数字退默认，越界夹到合法域', () => {
    expect(PetShapes.shapePointsFor('sphere', 'abc').length).toBe(128 * 3);
    expect(PetShapes.shapePointsFor('sphere', -5).length).toBe(16 * 3);
    expect(PetShapes.shapePointsFor('sphere', 99999).length).toBe(512 * 3);
  });
});

describe('pet settings', () => {
  let dir;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-settings-'));
  });
  afterEach(() => {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it('归一化夹取：越界值与非法枚举一律退回安全侧', () => {
    const s = normalizePetSettings({
      size: 99,
      motion: -5,
      count: 9999,
      dotScale: 99,
      color: 'nope',
      enabled: false,
      x: 'abc',
      y: null
    });
    expect(s.shapeMode).toBeUndefined(); // 形态偏好已删除，不再是设置项
    expect(s.size).toBe(SIZE_MAX);
    expect(s.motion).toBe(0);
    expect(s.count).toBe(COUNT_MAX);
    expect(s.dotScale).toBe(DOT_SCALE_MAX);
    expect(s.color).toBe('white');
    expect(s.enabled).toBe(false);
    expect(s.x).toBeNull();
    expect(s.y).toBeNull();
  });

  it('点数量夹取：低于下限回 COUNT_MIN，小数取整', () => {
    expect(normalizePetSettings({ count: 3 }).count).toBe(COUNT_MIN);
    expect(normalizePetSettings({ count: 100.7 }).count).toBe(101);
    expect(normalizePetSettings({ count: 'abc' }).count).toBe(128);
  });

  it('生成器侧点数归一（clampPointCount）是唯一一份：悬浮窗重分配数组也走它', () => {
    const S = PetShapes;
    expect(S.clampPointCount('abc')).toBe(128);
    expect(S.clampPointCount(3)).toBe(S.COUNT_FLOOR);
    expect(S.clampPointCount(99999)).toBe(S.COUNT_CEIL);
    expect(S.clampPointCount(100.7)).toBe(101);
    // 生成出来的点表长度与归一点数一致（不会因为越界拿到别的长度）
    expect(S.shapePointsFor('cat', 3).length).toBe(S.COUNT_FLOOR * 3);
    expect(S.shapePointsFor('cat', 99999).length).toBe(S.COUNT_CEIL * 3);
  });

  it('enabled 只有显式 true = 开：预装默认关闭（与 IPC 开关同一语义）', () => {
    expect(normalizePetSettings({ enabled: true }).enabled).toBe(true);
    expect(normalizePetSettings({}).enabled).toBe(false);
    expect(normalizePetSettings({ enabled: 'no' }).enabled).toBe(false);
    expect(normalizePetSettings({ enabled: 'true' }).enabled).toBe(false);
    expect(normalizePetSettings({ enabled: 0 }).enabled).toBe(false);
    expect(normalizePetSettings({ enabled: 1 }).enabled).toBe(false);
    expect(normalizePetSettings({ enabled: false }).enabled).toBe(false);
  });

  it('预装（无 settings.json）解析为关闭', () => {
    expect(loadPetSettings(dir).enabled).toBe(false);
    expect(DEFAULTS.enabled).toBe(false);
    expect(DEFAULTS.shapeMode).toBeUndefined();
  });

  it('aliveBind 默认开、只有显式 false = 关', () => {
    expect(normalizePetSettings({}).aliveBind).toBe(true);
    expect(normalizePetSettings({ aliveBind: false }).aliveBind).toBe(false);
    expect(normalizePetSettings({ aliveBind: 'no' }).aliveBind).toBe(true);
  });

  it('patch 往返：写进去的合法值读得回来', () => {
    const saved = patchPetSettings(dir, { size: 1.4, motion: 1.6, color: 'rose', x: 120, y: 80 });
    expect(saved.size).toBe(1.4);
    expect(saved.motion).toBe(1.6);
    expect(saved.color).toBe('rose');
    const loaded = loadPetSettings(dir);
    expect(loaded).toEqual(saved);
  });

  it('文件损坏退默认（宠物设置不值得为它做迁移链）', () => {
    fs.mkdirSync(path.join(dir, 'pet'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'pet', 'settings.json'), '{oops', 'utf8');
    const loaded = loadPetSettings(dir);
    expect(loaded.shapeMode).toBeUndefined();
    expect(loaded.enabled).toBe(false);
  });

  it('老存档里的 shape / shapeMode 一律不读（删掉的设置项不写迁移链）', () => {
    fs.mkdirSync(path.join(dir, 'pet'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'pet', 'settings.json'),
      JSON.stringify({ shape: 'cat', shapeMode: 'cat', enabled: true }),
      'utf8'
    );
    const loaded = loadPetSettings(dir);
    expect(loaded.shapeMode).toBeUndefined();
    expect(loaded.shape).toBeUndefined();
    expect(loaded.enabled).toBe(true);
  });

  it('patch 合并语义：只改的键生效，其余保留', () => {
    patchPetSettings(dir, { count: 200, motion: MOTION_MAX });
    const again = patchPetSettings(dir, { color: 'amber' });
    expect(again.count).toBe(200);
    expect(again.motion).toBe(MOTION_MAX);
    expect(again.color).toBe('amber');
  });
});
