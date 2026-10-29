'use strict';

/**
 * computer 工具的动作枚举 —— **唯一来源**。
 *
 * 为什么单独一个模块：这套枚举过去在 `tool-validate`（校验白名单）、`computer/service`
 * （分发白名单）、`gateway/sandbox-policy`（只读白名单）、`tool-catalog`（schema 描述）
 * 各写一份。任何一处新增动作忘了同步，后果是**静默放行**（沙箱没判定 = 无审批直通）或
 * **静默拒绝**（schema 允许、校验拒绝），都很难在测试里暴露。
 *
 * 每个动作只声明一次「它的性质」，其余模块派生使用：
 * - `mutates`：会不会改变系统状态 —— 沙箱档位据此判定（只读免审批）；
 * - `coordinate`：需不需要坐标（required / optional / none）—— 校验据此报 MISSING_ARG；
 * - `click`：属于点击家族（同一套按钮语义）；
 * - `button`：该动作的固定鼠标键（right_click / middle_click），无需模型再传 button；
 * - `modifiers`：支持按住修饰键（shift/ctrl/alt/win）；
 * - `region`：支持 `screenshot` 的区域裁剪（同时会改变模型坐标空间）。
 *
 * 只声明有消费者的字段：没有消费者的元数据是死代码。
 */
const ACTION_TABLE = Object.freeze({
  screenshot: Object.freeze({ mutates: false, coordinate: 'none', region: true }),
  click: Object.freeze({ mutates: true, coordinate: 'optional', click: true, modifiers: true }),
  double_click: Object.freeze({ mutates: true, coordinate: 'optional', click: true, modifiers: true }),
  right_click: Object.freeze({ mutates: true, coordinate: 'optional', click: true, modifiers: true, button: 'right' }),
  middle_click: Object.freeze({ mutates: true, coordinate: 'optional', click: true, modifiers: true, button: 'middle' }),
  move: Object.freeze({ mutates: true, coordinate: 'required' }),
  drag: Object.freeze({ mutates: true, coordinate: 'required', modifiers: true }),
  type: Object.freeze({ mutates: true, coordinate: 'none' }),
  key: Object.freeze({ mutates: true, coordinate: 'none' }),
  scroll: Object.freeze({ mutates: true, coordinate: 'optional' }),
  wait: Object.freeze({ mutates: false, coordinate: 'none' }),
  wait_until: Object.freeze({ mutates: false, coordinate: 'none' }),
  list_windows: Object.freeze({ mutates: false, coordinate: 'none' }),
  activate_window: Object.freeze({ mutates: true, coordinate: 'none' })
});

/** 全部动作（顺序即 schema 描述顺序）。 */
const COMPUTER_ACTIONS = Object.freeze(Object.keys(ACTION_TABLE));

/** 给 schema 描述用的枚举文本（避免各处再拼一遍）。 */
const COMPUTER_ACTIONS_TEXT = COMPUTER_ACTIONS.join(' | ');

function namesWhere(pred) {
  return new Set(COMPUTER_ACTIONS.filter((name) => pred(ACTION_TABLE[name])));
}

/** 点击家族：一次/双击/右键/中键，同一套 button 语义。 */
const CLICK_ACTIONS = namesWhere((m) => m.click === true);

/** 只读动作（不改系统状态）：沙箱档位下不需要审批。 */
const READ_ONLY_ACTIONS = namesWhere((m) => m.mutates === false);

/** 支持按住修饰键的动作。 */
const MODIFIER_ACTIONS = namesWhere((m) => m.modifiers === true);

/** 支持 region 裁剪的动作。 */
const REGION_ACTIONS = namesWhere((m) => m.region === true);

/**
 * @param {string} name
 * @returns {{ mutates: boolean, coordinate: 'required'|'optional'|'none',
 *   click?: boolean, modifiers?: boolean, region?: boolean } | null}
 */
function actionMeta(name) {
  const meta = ACTION_TABLE[String(name || '')];
  return meta || null;
}

function isComputerAction(name) {
  return Boolean(ACTION_TABLE[String(name || '')]);
}

module.exports = {
  COMPUTER_ACTIONS,
  COMPUTER_ACTIONS_TEXT,
  CLICK_ACTIONS,
  READ_ONLY_ACTIONS,
  MODIFIER_ACTIONS,
  REGION_ACTIONS,
  actionMeta,
  isComputerAction
};
