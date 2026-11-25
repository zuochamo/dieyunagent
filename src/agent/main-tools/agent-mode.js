'use strict';

/**
 * 「运行模式」类工具（Main 专属，没有 Gateway 对应实现）。
 *
 * 现在只有一个：`fan_out` —— 模型在**执行途中**发现这件事该拆成多路并行写入时，把决定权交回来。
 *
 * 为什么必须有它：planner 是整轮管线，只能在开跑前选一次（入口判定见 `planner-router.js`），
 * 而难度是动态的 —— 开头像单点修改，跑到第 8 步才发现要动 5 个互不依赖的文件。
 * 没有这个工具，模型只能在「继续串行做完」和「停下来让用户再说一遍」之间选。
 *
 * 这里**只登记意图**，不做任何真正的切换：本轮照常收尾，由 Renderer 看到这次调用后，
 * 用同一份用户请求直接起 planner（`renderer-agent-send.js` 的 handoff），trace 两段合并。
 * 这样 abort / worktree / 断点 / undo 的生命周期一个都不用在半路改接。
 */

/** 子任务只用来给规划阶段当提示；多了没有意义（规划器会自己勘察拆解）。 */
const FAN_OUT_MAX_SUBTASKS = 12;

function createAgentModeHandlers() {
  return {
    /**
     * @param {{reason?: string, subtasks?: Array<{title?: string, instruction?: string}>}} args
     */
    async fan_out(args = {}) {
      const reason = String(args.reason || '').replace(/\s+/g, ' ').trim();
      if (!reason) {
        return {
          ok: false,
          errorCode: 'FAN_OUT_REASON_REQUIRED',
          error: 'fan_out 需要 reason：一句话说明为什么这件事要拆成并行执行'
        };
      }
      const rawList = Array.isArray(args.subtasks) ? args.subtasks : [];
      const subtasks = rawList
        .map((s) => ({
          title: String((s && s.title) || '').trim(),
          instruction: String((s && s.instruction) || '').trim()
        }))
        .filter((s) => s.title || s.instruction)
        .slice(0, FAN_OUT_MAX_SUBTASKS);
      return {
        ok: true,
        handoff: 'planner',
        reason: reason.slice(0, 200),
        subtasks,
        note:
          '已记录。本轮到此收尾：宿主会用同一份用户请求起「多路并行执行」并交付最终结果。' +
          '不要再继续调用工具，也不要在文字里声称已经做完 —— 你的文字不会被当作最终答复。'
      };
    }
  };
}

module.exports = { createAgentModeHandlers };
