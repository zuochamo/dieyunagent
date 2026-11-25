'use strict';

/**
 * 身体（桌面宠物「点点」）：`pet_set` / `pet_act` 在**聊天轮**的执行体。
 *
 * 为什么需要这一档：用户说「点点改成 256 个点 / 换个形态」时，模型手上必须有参数通道。
 * 之前这两件工具只进心跳轮的工具表（`main/alive-boot.js` 的 `extraTools` + `preTool`），
 * 聊天轮里没有 → 模型只能去改 `src/pet/settings.js` 的源码（把运行时设置当代码缺陷修）。
 *
 * 语义与参数检查都在 `src/alive/pet-tools.js`（`runPetSet` / `runPetAct`）：
 * 心跳轮与聊天轮**共用同一份**，这里只负责拿到桥。
 *
 * @param {object} shared 工具桥闭包里的依赖与取值器（见 main-tools/index.js）
 */

const { runPetSet, runPetAct } = require('../../alive/pet-tools');

function createPetHandlers(shared) {
  const { getPetBridge } = shared;
  const bridge = () => (typeof getPetBridge === 'function' ? getPetBridge() : null);

  return {
    // 参数级：白名单 → settings 唯一写入口（与设置页滑杆同一份）
    pet_set: async (a) => runPetSet(bridge(), a),
    // 效果级：瞬时动作 / 一次性换形态，不留持久状态
    pet_act: async (a) => runPetAct(bridge(), a)
  };
}

module.exports = { createPetHandlers };
