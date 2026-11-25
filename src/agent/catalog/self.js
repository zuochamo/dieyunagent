'use strict';

/**
 * 「看一眼自己」的工具：`agent_inspect`。
 *
 * 为什么需要它：模型关于自己的事实（沙箱档位、真实可写根、生效的轮次/工具预算、最近哪些工具
 * 老失败）此前只能靠**猜文件路径**去读配置，或者干脆不知道 —— 于是它按错的自我认知规划，
 * 撞墙后换路径再撞一次，烧的是步数和上下文。
 *
 * 三条边界（写死在契约里，别扩）：
 * 1. **只回事实**：没有 phase、没有「该不该继续 / 该不该收尾」，也不给建议。
 *    `AGENTS.md` 第 5 条禁的是 `agent_status` 状态机，不是「读事实」。
 * 2. **只读**：不写盘、不改配置、不进 tool-gate 关卡顺序。
 * 3. **数字一律来自现成解析器**（`resolveAgentLoopSpec` / `getAgentLimits`），
 *    这里不写第二份缺省。
 *
 * 数据来源（全部已有）：`permissions.sandbox_state`（Gateway）、`permissions-store` 快照、
 * `agent-limits`、`tool-telemetry` 摘要，以及 `capability-index` 的能力表（开关 → 人话）。
 */
const AGENT_INSPECT_TOOL = {
  type: 'function',
  function: {
    name: 'agent_inspect',
    description:
      '查看「我这一轮实际是什么配置」的事实：沙箱档位与真实可写根、能力开关（开着的 / 关着的）、' +
      '生效的循环与子 Agent 轮次预算、目标预算、最近工具调用的失败面。\n' +
      '什么时候用：某个工具明明「应该有」却调不到；想确认能不能写到某个位置；怀疑自己被轮次/工具上限截断；' +
      '连续失败想知道是不是同一类错误。\n' +
      '**只读、只报事实**：它不会改任何设置，也不会替你判断「该不该继续」。要改设置属于用户的事。',
    parameters: { type: 'object', properties: {} }
  }
};

/**
 * 向用户申请一项能力（申请闭环）。
 *
 * 为什么是工具而不是提示词话术：模型在正文里写「请你去设置里打开摄像头」时，用户很可能
 * 既没看到、也不知道点哪儿；而 `mcp_manage.request_credential` 早就证明「模型发起 → 界面弹出来
 * → 用户亲手填 → 模型 list 复查」这条路能闭环。这里把同一形态推广到权限开关。
 *
 * 边界：**它不能给自己开权限**。它只把请求送到界面（打开对应设置页并标出开关），
 * 由用户决定；模型能做的只有「申请」和「复查开了没有」。
 */
const AGENT_CAPABILITY_TOOL = {
  type: 'function',
  function: {
    name: 'agent_capability',
    description:
      '两件事：action=request 向用户申请一项你现在没有的能力（界面会打开对应设置页并标出要开的开关）；' +
      'action=list 查「有哪些能力、现在开没开、各在哪开」（申请后复查用）。\n' +
      '什么时候用：这件事必须用某个能力才能做完（看屏幕 / 摄像头 / 键鼠 / 执行命令 / 写文件 / 联网 / MCP 凭据），' +
      '而工具表里没有它 —— 用这个工具把请求送到用户眼前，**不要**在正文里写一句「请你去设置里打开 X」然后继续等。\n' +
      '它不会给你提权：开关永远由用户按。开好了用 action=list 复查，再继续干活。',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['request', 'list'],
          description: 'request = 申请一项能力；list = 列出现有能力与开关状态'
        },
        kind: {
          type: 'string',
          description:
            'request 时要哪一项：fsWrite / shellExec / browser / webFetch / osControl（电脑控制）/ camera（手机摄像头）/ ' +
            'desktopCamera（本机摄像头）/ mcpCredential（MCP 服务凭据）'
        },
        reason: {
          type: 'string',
          description: '一句话说明为什么现在需要它（会显示在界面上，用户据此判断要不要开）'
        }
      },
      required: ['action'],
      allOf: [
        {
          if: { properties: { action: { const: 'request' } }, required: ['action'] },
          then: { required: ['kind'] }
        }
      ]
    }
  }
};

module.exports = {
  AGENT_INSPECT_TOOL,
  AGENT_CAPABILITY_TOOL
};
