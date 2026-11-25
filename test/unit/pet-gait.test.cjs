'use strict';

/* globals describe, it, expect */

/**
 * 猫步态（`src/renderer/pet-window/pet-cat-gait.js`）的硬约束 —— 这几条挂了，猫在桌面上就会
 * 「抽腿 / 溜冰 / 腹线撕裂 / 步序错乱」，用户在 210px 的窗口里一眼就能看出来：
 *
 * A. 分区：腹线以下每个点都必须落进某条腿的区间或尾巴（有孤儿点 = 那条描边不会动）。
 * B. 腹线归躯干：腿摆不能把两腿之间那段横线拽走。
 * C. 支撑相脚是**踩住的**：占空比内的相位不抬脚，且脚掌沿地面往后扫（不是来回溜冰）。
 * D. **四拍对角步行**：右前 → 左后 → 左前 → 右后，每条腿相差 1/4 拍。
 * E. 站着（amp=0）腿与躯干完全静止，只有尾巴还慢慢摆。
 * F. 步幅有界、位移场连续：不能出现「相邻两个点被扯向相反方向」的撕裂。
 */

const PetShapes = require('../../src/renderer/pet-window/pet-shapes');
const Gait = require('../../src/renderer/pet-window/pet-cat-gait');

const N = PetShapes.PET_POINT_COUNT;
const pts = PetShapes.shapePointsFor('cat', N);
const dx = new Float32Array(N);
const dy = new Float32Array(N);

function gaitAt(phase, amp, tMs) {
  Gait.computeGait(pts, N, { phase, amp, tMs: tMs || 0 }, dx, dy);
  return { dx, dy };
}

function isLegPoint(i) {
  const x = pts[i * 3];
  const y = pts[i * 3 + 1];
  return !Gait.isTail(x, y) && y < Gait.LEG_TOP_Y && x > Gait.ZONES[0].xMin && x < Gait.ZONES[1].xMax;
}

/** 某个区间里「远侧 / 近侧」那条腿的脚掌点（最低点，且完全在纯一侧、不受过渡带混合） */
function pawOf(zone, side) {
  let best = -1;
  for (let i = 0; i < N; i++) {
    if (!isLegPoint(i)) continue;
    const x = pts[i * 3];
    const y = pts[i * 3 + 1];
    if (x < zone.xMin || x > zone.xMax) continue;
    const pure = side === 'far' ? x < zone.midX - zone.blend : x > zone.midX + zone.blend;
    if (!pure) continue;
    if (best < 0 || y < pts[best * 3 + 1]) best = i;
  }
  return best;
}

describe('pet cat gait', () => {
  it('分区：腹线以下的点全部归入某条腿或尾巴（没有孤儿点）', () => {
    for (let i = 0; i < N; i++) {
      const x = pts[i * 3];
      const y = pts[i * 3 + 1];
      if (Gait.isTail(x, y) || y >= Gait.LEG_TOP_Y) continue;
      const inZone = Gait.ZONES.some((z) => x > z.xMin && x < z.xMax);
      expect(inZone).toBe(true);
    }
  });

  it('四条腿的脚掌点都能找到（远侧/近侧各一笔）', () => {
    for (const zone of Gait.ZONES) {
      expect(pawOf(zone, 'far')).toBeGreaterThanOrEqual(0);
      expect(pawOf(zone, 'near')).toBeGreaterThanOrEqual(0);
    }
  });

  it('腹线（两腿之间那段横线）不跟着腿摆：位移只有一个躯干轻摆的量级', () => {
    for (let k = 0; k < 8; k++) {
      const { dx: outDx } = gaitAt((k / 8) * Math.PI * 2, 1, 0);
      for (let i = 0; i < N; i++) {
        const x = pts[i * 3];
        const y = pts[i * 3 + 1];
        if (Math.abs(x) > 0.25 || y < -0.46 || y > -0.40) continue;
        expect(Math.abs(outDx[i])).toBeLessThan(0.04);
      }
    }
  });

  it('支撑相脚踩住不动：占空比内不抬脚，脚掌只沿地面往后扫', () => {
    const far = pawOf(Gait.ZONES[1], 'far');
    const restX = pts[far * 3];
    const offset = Gait.ZONES[1].farPhase;
    let prevX = null;
    for (let k = 0; k <= 6; k++) {
      const u = (k / 7) * Gait.DUTY;
      const { dx: outDx, dy: outDy } = gaitAt((u + offset) * Math.PI * 2, 1, 0);
      expect(Math.abs(outDy[far])).toBeLessThan(0.01); // 不抬脚
      const x = restX + outDx[far];
      if (prevX !== null) expect(x).toBeLessThan(prevX + 1e-6); // 往后扫（不是来回溜）
      prevX = x;
    }
  });

  it('四拍对角步行：右前 → 左后 → 左前 → 右后，每条腿相差 1/4 拍', () => {
    // 用各腿脚掌的抬脚峰值求出它「哪一刻抬起来」
    const measured = Gait.FOOTFALL_ORDER.map((limb) => {
      const zone = Gait.ZONES.find((z) => z.id === limb.zone);
      const side = limb.id[0] === 'R' ? 'near' : 'far';
      const paw = pawOf(zone, side);
      expect(paw).toBeGreaterThanOrEqual(0);
      let bestPhase = 0;
      let bestLift = -Infinity;
      for (let k = 0; k < 96; k++) {
        const phase = k / 96;
        const { dy: outDy } = gaitAt(phase * Math.PI * 2, 1, 0);
        if (outDy[paw] > bestLift) {
          bestLift = outDy[paw];
          bestPhase = phase;
        }
      }
      return { id: limb.id, phase: bestPhase, lift: bestLift };
    });

    // 顺序：按抬脚时刻排序后，把右前转到最前面，就该是 FOOTFALL_ORDER 的顺序
    const sorted = measured.slice().sort((a, b) => a.phase - b.phase);
    const startIdx = sorted.findIndex((m) => m.id === 'RF');
    const cyclic = sorted.slice(startIdx).concat(sorted.slice(0, startIdx)).map((m) => m.id);
    expect(cyclic).toEqual(['RF', 'LH', 'LF', 'RH']);

    // 每拍相差 1/4 周期
    for (let k = 1; k < sorted.length; k++) {
      const gap = sorted[k].phase - sorted[k - 1].phase;
      expect(gap).toBeGreaterThan(0.25 - 0.06);
      expect(gap).toBeLessThan(0.25 + 0.06);
    }
  });

  it('摆动相抬脚：抬到上限再落回，幅度在设定值附近', () => {
    let peak = 0;
    for (let k = 0; k < 60; k++) {
      const u = Gait.DUTY + (k / 60) * (1 - Gait.DUTY);
      const { dy: outDy } = gaitAt(u * Math.PI * 2, 1, 0);
      for (let i = 0; i < N; i++) peak = Math.max(peak, outDy[i]);
    }
    expect(peak).toBeGreaterThan(Gait.LIFT * 0.8);
    expect(peak).toBeLessThan(Gait.LIFT * 1.2);
  });

  it('站着（amp=0）：腿与躯干完全静止，只有尾巴还在慢慢摆', () => {
    for (let k = 0; k < 6; k++) {
      const phase = (k / 6) * Math.PI * 2;
      const { dx: outDx, dy: outDy } = gaitAt(phase, 0, 3000 + k * 700);
      let tailMoved = 0;
      for (let i = 0; i < N; i++) {
        const x = pts[i * 3];
        const y = pts[i * 3 + 1];
        if (Gait.isTail(x, y)) {
          tailMoved = Math.max(tailMoved, Math.abs(outDx[i]) + Math.abs(outDy[i]));
        } else {
          // 用 Math.abs：-0 也是「没动」，不必为负零较真
          expect(Math.abs(outDx[i])).toBe(0);
          expect(Math.abs(outDy[i])).toBe(0);
        }
      }
      expect(tailMoved).toBeGreaterThan(0.002);
    }
  });

  it('步幅有界：任何相位下点的水平位移都不超过体长的 1/5', () => {
    let maxDx = 0;
    for (let k = 0; k < 24; k++) {
      const { dx: outDx } = gaitAt((k / 24) * Math.PI * 2, 1, 0);
      for (let i = 0; i < N; i++) maxDx = Math.max(maxDx, Math.abs(outDx[i]));
    }
    expect(maxDx).toBeLessThan(0.2);
    expect(maxDx).toBeGreaterThan(Gait.STRIDE * 0.9); // 也确实迈得开（不是原地抖）
  });

  it('位移场连续：同一部位里相邻的点不会被扯向相反方向（描边不撕裂）', () => {
    // 部位之间允许相对滑动（尾巴在腿后面擦过去是不同深度的两个东西），
    // 但同一笔描边内部必须是连续场 —— 否则会出现肉眼可见的断层。
    const partOf = (i) => {
      const x = pts[i * 3];
      const y = pts[i * 3 + 1];
      if (Gait.isTail(x, y)) return 'tail';
      if (y < Gait.LEG_TOP_Y) {
        const zone = Gait.ZONES.find((z) => x > z.xMin && x < z.xMax);
        if (zone) return zone.id + (x < zone.midX ? '-far' : '-near');
      }
      return 'body';
    };
    const near = [];
    for (let i = 0; i < N; i++) {
      for (let j = i + 1; j < N; j++) {
        if (partOf(i) !== partOf(j)) continue;
        const ddx = pts[i * 3] - pts[j * 3];
        const ddy = pts[i * 3 + 1] - pts[j * 3 + 1];
        if (ddx * ddx + ddy * ddy < 0.07 * 0.07) near.push([i, j]);
      }
    }
    expect(near.length).toBeGreaterThan(20);
    for (let k = 0; k < 16; k++) {
      const { dx: outDx, dy: outDy } = gaitAt((k / 16) * Math.PI * 2, 1, 0);
      for (const [i, j] of near) {
        const gap = Math.hypot(outDx[i] - outDx[j], outDy[i] - outDy[j]);
        expect(gap).toBeLessThan(0.07); // 不超过一点间距，肉眼看不到断层
      }
    }
  });

  it('远近分明：远侧那条腿更暗更细，近侧与躯干保持原亮度', () => {
    const shade = new Float32Array(N);
    Gait.computeGait(pts, N, { phase: 0.3, amp: 1, tMs: 0 }, dx, dy, shade);
    for (const zone of Gait.ZONES) {
      const far = pawOf(zone, 'far');
      const near = pawOf(zone, 'near');
      expect(shade[far]).toBeLessThan(Gait.FAR_SHADE + 0.06);
      expect(shade[near]).toBeGreaterThan(0.95);
    }
    // 躯干/头/尾巴不参与「远侧压暗」
    for (let i = 0; i < N; i++) {
      if (isLegPoint(i)) continue;
      expect(shade[i]).toBe(1);
    }
  });

  it('limbState：支撑相角度单调后扫、摆动相从后扫回前方且周期首尾连续', () => {
    const out = { theta: 0, lift: 0 };
    let prev = Gait.limbState(0, out).theta;
    expect(prev).toBe(1);
    for (let k = 1; k <= 20; k++) {
      const t = Gait.limbState((k / 20) * Gait.DUTY, out).theta;
      expect(t).toBeLessThanOrEqual(prev + 1e-9);
      expect(out.lift).toBe(0);
      prev = t;
    }
    expect(Gait.limbState(Gait.DUTY, out).theta).toBe(-1);
    const mid = Gait.limbState(Gait.DUTY + (1 - Gait.DUTY) / 2, out);
    expect(mid.theta).toBeCloseTo(0, 6);
    expect(mid.lift).toBeCloseTo(1, 6);
    expect(Gait.limbState(0.999, out).theta).toBeCloseTo(1, 2);
  });
});
