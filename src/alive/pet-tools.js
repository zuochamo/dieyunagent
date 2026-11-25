'use strict';

/**
 * 「身体」工具的语义（schema 在 `agent/catalog/pet.js`，这里只有参数规整与执行）。
 *
 * 两个轮次共用这一份：
 *   - **心跳轮**（`main/alive-boot.js` 的 `preTool`）：绑定生命感后它自己调身体；
 *   - **聊天轮**（`agent/main-tools/pet.js` 的 `pet_set` / `pet_act`）：用户说「点点改成 256 个点」
 *     时模型直接调参数，而不是去改源码。
 *
 * 边界（与既有约定一致）：
 *   - **动词不是数字**：逐点的 rest/pos/vel/glow 留在悬浮窗页面内部，模型拿到的是参数级
 *     （`pet_set`，走 settings 唯一写入口，与用户滑杆同一份）与效果级（`pet_act`，瞬时不起持久状态）。
 *   - **不能动 `enabled` / 位置**：显隐是用户的开关，坐标它也看不见（要挪窝以后给专门动词）。
 *   - 数值边界只在 `src/pet/settings.js` 一处（这里只做字段白名单与类型规整，夹取交给它）；
 *     形态合法值只来自 schema 的 enum（它又取自 `pet-shapes.SHAPE_IDS`）。
 */

const { PET_SET_TOOL, PET_ACT_TOOL, PET_TOOLS, PET_TOOL_NAMES } = require('../agent/catalog/pet');

/** pet_act 的动作白名单：**取自 schema 的 enum**（不再另抄一份） */
const PET_ACT_EFFECTS = Object.freeze(
  (PET_ACT_TOOL.function.parameters.properties.effect.enum || []).slice()
);
/** pet_act 的形态合法值：同样取自 schema（schema 又取自 `pet-shapes.SHAPE_IDS`） */
const PET_ACT_SHAPES = Object.freeze(
  (PET_ACT_TOOL.function.parameters.properties.shape.enum || []).slice()
);

/**
 * 身体在不在：桥为空 = 这台机器没有桌面宠物（headless / 网页版）；
 * `available()` 为假 = 用户关着「显示点点」。
 *
 * 两种都回**结构化错误**而不是「工具不存在」：模型能从错误里读到该去哪儿开，
 * 与 `peer_*` 的 PEER_UNAVAILABLE 同一取舍（藏在工具表外只会让它去改源码）。
 */
function petNotReady(petBridge) {
  if (!petBridge || typeof petBridge.setParams !== 'function') {
    return {
      ok: false,
      errorCode: 'PET_UNAVAILABLE',
      retryable: false,
      error: '这台机器没有桌面宠物（无界面运行 / 网页版），点点这具身体不存在。'
    };
  }
  if (typeof petBridge.available === 'function' && petBridge.available() !== true) {
    return {
      ok: false,
      errorCode: 'PET_DISABLED',
      retryable: false,
      error:
        '点点现在没有显示：用户关着「设置 → 宠物 → 点点」里的开关。要它出现请让用户自己打开那个开关；' +
        '不要改源码来实现这个效果。'
    };
  }
  return null;
}

/**
 * pet_set 参数白名单：只留身体可调字段，类型不对的字段直接丢掉（夹取在 settings.js）。
 * 形态不在白名单里：它自己变；`pet_act` 的 shape 动作才是一次性换形态。
 */
function normalizePetSet(args) {
  const a = args && typeof args === 'object' ? args : {};
  const patch = {};
  if (a.count !== undefined && Number.isFinite(Number(a.count))) patch.count = Math.round(Number(a.count));
  if (a.dotScale !== undefined && Number.isFinite(Number(a.dotScale))) patch.dotScale = Number(a.dotScale);
  if (a.motion !== undefined && Number.isFinite(Number(a.motion))) patch.motion = Number(a.motion);
  if (typeof a.color === 'string') patch.color = a.color;
  const keys = Object.keys(patch);
  return keys.length ? { ok: true, patch } : { ok: false, error: '没有可设置的字段' };
}

/**
 * pet_act 参数规整：effect 必须在白名单里；`shape` 动作必带合法形态；其余动作夹 strength 到 0–1。
 */
function normalizePetAct(args) {
  const a = args && typeof args === 'object' ? args : {};
  const effect = PET_ACT_EFFECTS.includes(a.effect) ? a.effect : '';
  if (!effect) return { ok: false, error: 'effect 必须是 ' + PET_ACT_EFFECTS.join('/') };
  if (effect === 'shape') {
    const shape = PET_ACT_SHAPES.includes(a.shape) ? a.shape : '';
    if (!shape) return { ok: false, error: 'effect=shape 时必须给 shape：' + PET_ACT_SHAPES.join('/') };
    return { ok: true, effect, shape };
  }
  let strength = Number(a.strength);
  if (!Number.isFinite(strength)) strength = 0.8;
  strength = Math.max(0, Math.min(1, strength));
  return { ok: true, effect, strength };
}

/** 执行 pet_set（心跳轮 preTool 与聊天轮 handler 共用这一份） */
function runPetSet(petBridge, args) {
  const notReady = petNotReady(petBridge);
  if (notReady) return notReady;
  const norm = normalizePetSet(args);
  if (!norm.ok) return norm;
  return petBridge.setParams(norm.patch);
}

/** 执行 pet_act（同上） */
function runPetAct(petBridge, args) {
  const notReady = petNotReady(petBridge);
  if (notReady) return notReady;
  const norm = normalizePetAct(args);
  if (!norm.ok) return norm;
  if (norm.effect === 'shape') {
    petBridge.act({ kind: 'shape', shape: norm.shape });
    return { ok: true, effect: 'shape', shape: norm.shape };
  }
  petBridge.act({ kind: 'act', effect: norm.effect, strength: norm.strength });
  return { ok: true, effect: norm.effect, strength: norm.strength };
}

module.exports = {
  PET_SET_TOOL,
  PET_ACT_TOOL,
  PET_TOOLS,
  PET_TOOL_NAMES,
  PET_ACT_EFFECTS,
  PET_ACT_SHAPES,
  normalizePetSet,
  normalizePetAct,
  runPetSet,
  runPetAct
};
