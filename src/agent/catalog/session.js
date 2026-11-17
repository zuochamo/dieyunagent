'use strict';

/**
 * 会话与澄清工具：agent_clarify / session_new / session_set_workspace / subagent。
 * 会话/工作空间绑定语义在 `src/agent/session-workspace-bind.js`（工具只是入口）。
 */

const CLARIFY_TOOL = {
  type: 'function',
  function: {
    name: 'agent_clarify',
    description:
      '思考或执行中信息不明确、存在多种互斥理解或需用户确认时调用。会在对话中展示表格选项。禁止因对话已压缩/折叠就询问「本轮做什么」——先根据压缩摘要、折叠历史、近轮原文和工作区恢复任务。禁止臆测。',
    parameters: {
      type: 'object',
      properties: {
        question: { type: 'string', description: '需要确认的问题' },
        options: {
          type: 'array',
          description: '选项列表，2～8 项',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              label: { type: 'string', description: '选项标题' },
              description: { type: 'string', description: '可选说明' },
              preview: { type: 'string', description: '可选预览：代码片段 / ASCII 布局 / 配置示例，等宽展示，供用户并排对比各选项的实际样子' }
            },
            required: ['id', 'label']
          }
        },
        allowMultiple: { type: 'boolean', description: '是否允许多选，默认 false' },
        inputPlaceholder: { type: 'string', description: '补充输入框占位提示，默认「补充说明或手动输入…」' }
      },
      required: ['question', 'options']
    }
  }
};

/**
 * 会话级操作：新建对话 + 把工作空间挂上去（可带第一条任务）。
 *
 * 为什么是 RENDERER_ONLY_TOOLS：会话列表、当前会话、工作空间视图三者都是 Renderer 的状态，
 * Main 单方面建行/切工作空间只会让 UI 与账本脱钩。渲染器侧的执行体直接复用「新对话」按钮那条
 * 单源流程（renderer-chat-history.js 的 createNewSession），这里不重复一遍建会话 + 绑工作空间的顺序。
 */
const SESSION_TOOL = {
  type: 'function',
  function: {
    name: 'session_new',
    description:
      '新建一个对话，并把它的工作空间设到指定目录（可顺带把第一条任务发进去）。' +
      '适用：用户说「开个新对话做这件事」「换到 <某目录> 继续」「这个项目单独开一个会话」，' +
      '或当前对话已被别的任务占住、需要干净起点（新对话会按该目录重新加载 AGENTS.md / 记忆 / 索引）。' +
      '效果：立即切到新对话并挂上工作空间；原对话的消息与工作空间不受影响，可从历史列表切回。' +
      '只想改当前对话的工作空间、不新建对话时，用 session_set_workspace，不要用本工具。' +
      '传 prompt 时本轮应就此收尾：任务在新的对话里独立执行，你在这里继续调工具不会再影响它。',
    parameters: {
      type: 'object',
      properties: {
        workspacePath: {
          type: 'string',
          description:
            '工作空间的绝对路径（例如 D:\\UE5-Tutorial-Course），或远端工作区 URI：ssh://<用户名>@<主机>/<远端路径>' +
            '（例如 ssh://dieyunx@192.168.31.62/run/media/dieyunx/dieyunserver/dieyuntools）。' +
            '远端 URI 必须带 //，不要写成 ssh:主机:/路径 或 user@host:/path——那不是合法工作空间，挂上后整条对话的 cwd 都是错的。' +
            '省略则沿用当前对话的工作空间。'
        },
        title: {
          type: 'string',
          description: '新对话的标题，写清项目或任务，便于在历史列表里辨认。省略则先留空，历史列表用首条消息充当标题。'
        },
        prompt: {
          type: 'string',
          description: '可选：新对话的第一条消息，会立即发送并开始执行。用户已把任务说清时，把任务原样写进来。'
        }
      },
      required: []
    }
  }
};

/**
 * 「把当前对话的工作空间换到指定目录」——一个名字，两种执行现场：
 *
 * - **桌面**（Renderer 执行，见 `renderer-workspace-ssh.js#applySessionWorkspaceFromTool`）：
 *   会话列表、当前会话、工作空间视图都是渲染器的状态，Main 单方面改绑定只会让 UI 与账本脱钩，
 *   所以列在 RENDERER_ONLY_TOOLS 里，Main 收到只做反委托。执行体复用「工作空间选择器」
 *   那条流程（改视图 + 写会话行 + 重载 AGENTS/索引 + 重启终端），不另写一份。
 * - **外部频道**（Main 执行，见 `channels/workspace-switch.js`）：没有 UI 可点，只能在 Main 落绑定，
 *   并额外限制候选（频道默认 + 本机已有会话的工作空间）——群聊里任何人都能发消息，
 *   不能让一句话把 Agent 指到系统目录。
 *
 * 与 `session_new` 的分工：本工具**不动当前会话**（消息与历史留着），只是换它绑定的目录；
 * 要一个干净起点、新开对话才用 session_new。
 */
const SESSION_WORKSPACE_TOOL = {
  type: 'function',
  function: {
    name: 'session_set_workspace',
    description:
      '把**当前这条对话**的工作空间换到指定目录（不新建对话，消息与历史仍留在本会话）。' +
      '适用：用户说「切到 XX 项目」「这个事在 XX 目录做」「换个工作空间」——他要的是在本会话里换项目。' +
      '外部频道（企业微信等）里只能切到本机已有会话用过的项目或该频道默认目录，不在范围内时会返回可选列表，' +
      '别自己编路径；不知道有哪些候选就先不传参数调用一次。' +
      '传 "default" 表示回到默认工作空间。' +
      '切换从下一轮生效：本轮已装配的系统提示、AGENTS.md、索引仍是原目录的，需要在新目录干活就本轮收尾，下一轮再做。',
    parameters: {
      type: 'object',
      properties: {
        workspace: {
          type: 'string',
          description:
            '目标工作空间的绝对路径（如 F:\\dieyundaizhang），外部频道里也可用项目目录名（如 dieyundaizhang，需唯一）；' +
            '传 "default" 回到默认工作空间；留空则只返回候选清单、不做切换。'
        }
      },
      required: []
    }
  }
};

/**
 * 只读并发调研子 Agent。
 * 只注入给「协调者」——Agent 主循环、Explore 模式、Plan 的 explore 阶段；
 * 研究子 Agent 的工具集 = Explore 白名单，白名单不含本工具，递归被物理切断（深度恒为 1）。
 * Main 执行（见 src/agent/subagent-runner.js），不属于 RENDERER_ONLY_TOOLS。
 */
const SUBAGENT_TOOL = {
  type: 'function',
  function: {
    name: 'subagent',
    description:
      '派出一个只读研究子 Agent 并行调研一个明确问题（读文件 / 搜索 / 查符号 / 联网）。' +
      '需要分别摸清多个互不依赖的模块或多个事实来源时，一次并发发多个调用，比自己串行读快得多。' +
      '子 Agent 只读、不改工作区、不能再派子 Agent。' +
      '返回的是结论与证据路径的摘要（不是全量过程）；过程可在对话里展开那张折叠卡片查看。' +
      '已经让子 Agent 查过的东西不要自己再查一遍。' +
      '若返回 reason="limit"（或摘要里写明「达到轮次/工具预算被截断」），说明这次调研没跑完：' +
      '摘要只是它已完成的发现，不要当成完整结论 —— 缩小问题范围后重派，或自己补查缺口。',
    parameters: {
      type: 'object',
      properties: {
        task: {
          type: 'string',
          description:
            '这次调研要回答的单一问题，写清边界与期望产出（例如「X 模块的鉴权入口在哪、被谁调用」）。'
        },
        label: {
          type: 'string',
          description: '简短标签（可留空），用于在界面上区分多路子 Agent：写成这次派发在干什么'
        },
        hints: {
          type: 'array',
          items: { type: 'string' },
          description: '已知线索或起点路径，减少子 Agent 的重复探索'
        },
        continueFrom: {
          type: 'string',
          description:
            '追问模式：填上次结果返回的 subagentId，子 Agent 会带着上次的完整对话继续调研本次 task（仍只读、深度不变）'
        }
      },
      required: ['task']
    }
  }
};


module.exports = {
  CLARIFY_TOOL,
  SESSION_TOOL,
  SESSION_WORKSPACE_TOOL,
  SUBAGENT_TOOL
};
