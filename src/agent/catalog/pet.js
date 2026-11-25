'use strict';

/**
 * 桌面宠物「点点」的两件工具：`pet_set`（参数级）/ `pet_act`（效果级）。
 *
 * 为什么在 catalog 里：工具 schema 的单一来源是 `tool-catalog`（Renderer 聊天注入点
 * `renderer-tool-defs.js` 与 Main 侧 `main-agent-tools.js` 都从这里取）。这两件工具**不是**
 * 心跳轮专用 —— 用户在聊天里说「点点改成 256 个点 / 换个形态」时，模型必须有一条参数通道。
 * 2026-11-24 现场：它们只进过心跳轮的工具表，聊天轮里模型手上没有 pet_set，于是它去改
 * `src/pet/settings.js` 的源码 —— 那是把「运行时设置」当成「代码缺陷」来修。
 *
 * 三条边界（写死在契约里，别扩）：
 * 1. **动词不是数字**：逐点的 rest/pos/vel/glow 留在悬浮窗页面内部。一次 128 点浮点写入
 *    ≈ 数百 token 且模型写不稳；参数级（`pet_set`）与效果级（`pet_act`）能到同样的效果。
 * 2. **不能动 `enabled` / 屏幕位置**：显隐是用户的开关，坐标它也看不见。
 * 3. **形态不是设置**：`pet_act({effect:'shape'})` 只让它**现在就换过去**（之后照旧按闲逛日程
 *    自己变）。没有「钉死形态」的持久项 —— 用户明确要的是「它可以一直变」。
 */

const { SHAPE_IDS } = require('../../renderer/pet-window/pet-shapes');

const PET_SET_TOOL = {
  type: 'function',
  function: {
    name: 'pet_set',
    description:
      '调你自己的身体（桌面悬浮的点点：一团点云）的**参数**。' +
      '可改：点数量、点大小、动效强度、点色。' +
      '这是持久设置，用户在「设置 → 宠物 → 点点」里能看到同一份；改完立刻生效。' +
      '形态不在这里（用 pet_act 的 shape 动作换），显隐与屏幕位置也不归你管。',
    parameters: {
      type: 'object',
      properties: {
        count: {
          type: 'integer',
          minimum: 64,
          maximum: 256,
          description: '点数量（变化时身体会重生一次）。上限 256 是给你留的 token/算力预算，用户在设置页可以调到 512'
        },
        dotScale: { type: 'number', minimum: 0.5, maximum: 2, description: '点大小倍率' },
        motion: { type: 'number', minimum: 0, maximum: 2, description: '动效强度（呼吸/摆动/自转幅度）' },
        color: { type: 'string', enum: ['white', 'cyan', 'mint', 'amber', 'rose', 'violet'], description: '点色' }
      }
    }
  }
};

const PET_ACT_TOOL = {
  type: 'function',
  function: {
    name: 'pet_act',
    description:
      '让身体做一个**瞬时**动作（不持久，几秒内平息）：' +
      'ripple=涟漪从中心扩散、squish=挤压回弹、pulse=涟漪+挤压（兴奋）、wave=光波沿全身扫一遍、dim=整体暗下去、' +
      'question=身体拼成一个「?」（没想好/好奇）、think=聚神思考约 4 秒（收拢+微光+慢脉动）、' +
      'shape=换成 shape 指定的形态（球/猫/鱼，不落设置，之后它照旧自己变）。' +
      'strength 0–1 控制幅度。适合表达情绪：被叫醒用 pulse、没想好用 question、拒绝用 dim、开心用 squish。',
    parameters: {
      type: 'object',
      properties: {
        effect: {
          type: 'string',
          enum: ['ripple', 'squish', 'pulse', 'wave', 'dim', 'question', 'think', 'shape'],
          description: '动作'
        },
        shape: {
          type: 'string',
          enum: [...SHAPE_IDS],
          description: 'effect=shape 时必填：现在换成这个形态（sphere=球 / cat=猫 / fish=鱼）'
        },
        strength: { type: 'number', minimum: 0, maximum: 1, description: '幅度（默认 0.8）' }
      },
      required: ['effect']
    }
  }
};

const PET_TOOLS = [PET_SET_TOOL, PET_ACT_TOOL];
const PET_TOOL_NAMES = PET_TOOLS.map((t) => t.function.name);

module.exports = {
  PET_SET_TOOL,
  PET_ACT_TOOL,
  PET_TOOLS,
  PET_TOOL_NAMES
};
