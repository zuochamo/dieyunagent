'use strict';

/* globals describe, it, expect */

/**
 * 身体工具的硬边界（心跳轮的它 / 聊天轮的它 ↔ 点点）：
 * - pet_set 只放行身体字段白名单：enabled / 坐标 / 未知字段一律丢弃（显隐与位置不归模型管）；
 *   数值夹取在 settings.js（唯一来源），这里只规整类型。
 * - pet_act 的 effect 必须在白名单内（取自 schema 的 enum），strength 夹 0–1；
 *   `shape` 动作必须带合法形态（一次性换形态，不落设置）。
 * - 执行（runPetSet / runPetAct）是心跳轮与聊天轮**共用的那一份**：
 *   桥为空 → PET_UNAVAILABLE、宠物没显示 → PET_DISABLED，都是结构化错误（不是「工具不存在」）。
 */

const {
  PET_SET_TOOL,
  PET_ACT_TOOL,
  PET_ACT_EFFECTS,
  PET_ACT_SHAPES,
  normalizePetSet,
  normalizePetAct,
  runPetSet,
  runPetAct
} = require('../../src/alive/pet-tools');
const { createPetHandlers } = require('../../src/agent/main-tools/pet');
const catalog = require('../../src/agent/tool-catalog');
const PetShapes = require('../../src/renderer/pet-window/pet-shapes');

/** 假桥：记录调用；available 决定「点点显示着没有」 */
function fakeBridge({ available = true } = {}) {
  const calls = { params: [], act: [] };
  return {
    calls,
    available: () => available,
    enabled: () => available,
    setParams: (patch) => {
      calls.params.push(patch);
      return { ok: true, settings: { ...patch } };
    },
    act: (payload) => calls.act.push(payload)
  };
}

describe('pet-tools', () => {
  it('工具 schema：名字与关键字段在位', () => {
    expect(PET_SET_TOOL.function.name).toBe('pet_set');
    expect(PET_ACT_TOOL.function.name).toBe('pet_act');
    expect(PET_SET_TOOL.function.parameters.properties.enabled).toBeUndefined();
    expect(PET_ACT_TOOL.function.parameters.required).toEqual(['effect']);
    expect(PET_ACT_EFFECTS).toContain('pulse');
    expect(PET_ACT_EFFECTS).toContain('shape');
  });

  it('schema 是单一来源：catalog 里按名解析到的就是这两件（聊天注入走 catalog）', () => {
    expect(catalog.getToolByName('pet_set')).toBe(PET_SET_TOOL);
    expect(catalog.getToolByName('pet_act')).toBe(PET_ACT_TOOL);
    // 条件注入表里有它们，但**不在**静态表里（宠物只有桌面版才有）
    expect(catalog.CONDITIONAL_TOOLS.map((t) => t.function.name)).toEqual(
      expect.arrayContaining(['pet_set', 'pet_act'])
    );
    expect(catalog.ALL_STATIC_TOOLS.map((t) => t.function.name)).not.toContain('pet_set');
    // 形态枚举只来自 pet-shapes（不在这里另抄一份）
    expect(PET_ACT_SHAPES).toEqual([...PetShapes.SHAPE_IDS]);
  });

  it('pet_set：字段白名单，enabled/x/y 造不进去；shape 也不在白名单里', () => {
    const res = normalizePetSet({
      shape: 'cat',
      count: 200,
      dotScale: 1.5,
      motion: 1.2,
      color: 'rose',
      enabled: false,
      x: 999,
      y: 999,
      evil: 'boom'
    });
    expect(res.ok).toBe(true);
    expect(res.patch).toEqual({ count: 200, dotScale: 1.5, motion: 1.2, color: 'rose' });
    // 形态不是它能设的：设置里没有「钉死形态」这一项，它自己变
    expect(PET_SET_TOOL.function.parameters.properties.shape).toBeUndefined();
  });

  it('pet_set：全空 / 非对象 → 拒绝', () => {
    expect(normalizePetSet({}).ok).toBe(false);
    expect(normalizePetSet(null).ok).toBe(false);
    expect(normalizePetSet({ shape: 123 }).ok).toBe(false);
    expect(normalizePetSet({ count: 'abc' }).ok).toBe(false);
  });

  it('pet_act：effect 白名单 + strength 夹取', () => {
    expect(normalizePetAct({ effect: 'pulse', strength: 5 })).toEqual({ ok: true, effect: 'pulse', strength: 1 });
    expect(normalizePetAct({ effect: 'ripple', strength: -3 }).strength).toBe(0);
    expect(normalizePetAct({ effect: 'wave' }).strength).toBe(0.8);
    expect(normalizePetAct({ effect: 'dance' }).ok).toBe(false);
    expect(normalizePetAct({}).ok).toBe(false);
  });

  it('pet_act shape：一次性换形态，必须给合法形态（不落设置）', () => {
    expect(normalizePetAct({ effect: 'shape', shape: 'cat' })).toEqual({ ok: true, effect: 'shape', shape: 'cat' });
    expect(normalizePetAct({ effect: 'shape' }).ok).toBe(false);
    expect(normalizePetAct({ effect: 'shape', shape: 'dog' }).ok).toBe(false);
    // 不是 shape 动作时多余的 shape 不影响（也不会被当成形态设置）
    expect(normalizePetAct({ effect: 'pulse', shape: 'cat' })).toEqual({ ok: true, effect: 'pulse', strength: 0.8 });
  });

  it('runPetSet / runPetAct：走桥，返回生效结果', () => {
    const bridge = fakeBridge();
    expect(runPetSet(bridge, { count: 256 })).toEqual({ ok: true, settings: { count: 256 } });
    expect(bridge.calls.params).toEqual([{ count: 256 }]);

    expect(runPetAct(bridge, { effect: 'shape', shape: 'fish' })).toEqual({
      ok: true,
      effect: 'shape',
      shape: 'fish'
    });
    expect(runPetAct(bridge, { effect: 'pulse', strength: 0.5 })).toEqual({
      ok: true,
      effect: 'pulse',
      strength: 0.5
    });
    expect(bridge.calls.act).toEqual([
      { kind: 'shape', shape: 'fish' },
      { kind: 'act', effect: 'pulse', strength: 0.5 }
    ]);
  });

  it('执行端：桥为空 / 宠物没显示 → 结构化错误，不引导去改源码', () => {
    const none = runPetSet(null, { count: 256 });
    expect(none.ok).toBe(false);
    expect(none.errorCode).toBe('PET_UNAVAILABLE');

    const off = runPetAct(fakeBridge({ available: false }), { effect: 'pulse' });
    expect(off.ok).toBe(false);
    expect(off.errorCode).toBe('PET_DISABLED');
    expect(off.error).toContain('设置 → 宠物');
  });

  it('聊天轮的 handler 与心跳轮同一份语义（main-tools/pet）', async () => {
    const bridge = fakeBridge();
    const handlers = createPetHandlers({ getPetBridge: () => bridge });
    await expect(handlers.pet_set({ count: 256 })).resolves.toEqual({ ok: true, settings: { count: 256 } });
    await expect(handlers.pet_act({ effect: 'shape', shape: 'cat' })).resolves.toEqual({
      ok: true,
      effect: 'shape',
      shape: 'cat'
    });
    expect(bridge.calls.params).toEqual([{ count: 256 }]);
    expect(bridge.calls.act).toEqual([{ kind: 'shape', shape: 'cat' }]);

    // 没有桥的宿主（headless / 网页版）：结构化错误
    const bare = createPetHandlers({ getPetBridge: () => null });
    await expect(bare.pet_act({ effect: 'pulse' })).resolves.toMatchObject({ errorCode: 'PET_UNAVAILABLE' });
  });
});
