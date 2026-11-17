'use strict';

/**
 * 计划与目标工具：plan_* / goal_*。
 * 事实、核对与续跑判定在 `src/plans/goal-run.js` 与 `src/goals/session-goal.js`，这里只有 schema。
 */

const PLAN_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'plan_create',
      description:
        '创建计划（写入 plans.json）。两种形态二选一：' +
        '①定时（RRULE）：能确定时间规则就直接给 rrule 或 onceAt（确定、不再额外解析），只有拿到的是自然语言、无法确定时间规则时才省略它们交解析器推断；' +
        '②目标型（给 goal）：没有时间规则、"做到某某条件成立为止"的长任务用它 —— 计划会一轮轮自动续跑，每轮由模型跑 goal 检查、直到申请完成或预算用完。' +
        '用户说「每天 X 点…发到当前对话」时，计划会投递到当前会话。',
      parameters: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: '计划名称（简短中文）'
          },
          goal: {
            type: 'object',
            description:
              '目标型计划（"一直做到 X 成立"）。给了它就不要再给 rrule/onceAt。' +
              'objective 是「什么状态算达成」那一句，它会进每一轮的交接班文本；' +
              '检查命令决定「做没做完」能不能被机器核对，所以要先和用户确认一条**现在会失败、做完会通过**的命令；' +
              '确实没有可执行的检查（例如主观目标）就传空数组 checks: []，那是未验证模式：照样能跑，但完成申请不会被代码核对。' +
              '预算（轮次/时长）不在这里设：沿用默认值，用户可在「定时任务 → 目标」里改。',
            properties: {
              objective: {
                type: 'string',
                description:
                  '一句话说清「什么状态算达成」（每轮交接班的第一行就是它）。和 goal_start 的 objective 同一个含义，别写成检查命令'
              },
              checks: {
                type: 'array',
                items: { type: 'string' },
                description:
                  '每项一条检查命令（原样执行，退出码 0 = 通过），如 "npm test"、"cargo build"。别写解释性文字，也别把多条命令拼成一段'
              },
              cwd: {
                type: 'string',
                description: '检查命令的工作目录（可选，留空 = 计划运行的工作空间）'
              }
            },
            required: ['objective', 'checks']
          },
          rrule: {
            type: 'string',
            description:
              'iCalendar RRULE（不含 RRULE: 前缀），与 onceAt 二选一。如 每天9:00 → FREQ=DAILY;BYHOUR=9;BYMINUTE=0；每周一9:00 → FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=0；每30分钟 → FREQ=MINUTELY;INTERVAL=30；每2小时 → FREQ=HOURLY;INTERVAL=2；总共跑5次加 ;COUNT=5'
          },
          onceAt: {
            type: 'string',
            description:
              '仅执行一次时的 ISO8601 本地时间，与 rrule 二选一。如 2026-05-26T09:00:00'
          },
          prompt: {
            type: 'string',
            description:
              '计划要完成的任务说明（完整、可执行）：定时型写「到点做什么」；目标型写「什么状态算达成」，它是每一轮交接班的依据'
          },
          description: {
            type: 'string',
            description: '用户对定时任务的完整描述（自然语言兜底，缺 rrule/onceAt 时据此解析）'
          },
          skillIds: {
            type: 'array',
            items: { type: 'string' },
            description: '可选关联技能 id 列表'
          },
          todos: {
            type: 'array',
            items: { type: 'string' },
            description: '可选 TODO 清单，每项是一个可执行检查项'
          },
          workspace: {
            type: 'string',
            description:
              '可选：计划执行时使用的工作空间（本地绝对路径，如 E:\\\\project）。留空 = 跟随执行时当前打开的工作空间'
          }
        },
        required: []
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'plan_list',
      description:
        '列出所有已保存的计划（定时 / 目标型）。目标型计划额外给出：跑了几轮、声明的检查、最后一条检查事实、是否已收尾（outcome）。',
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'plan_delete',
      description:
        '删除指定 id 的计划（含目标型）。注意它连运行记录一起删；目标型只是「别再跑了、但保留已跑事实」时，' +
        '让用户在「定时任务 → 目标」面板里停用，或用 plan_cancel 先中止当前这一轮',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '计划 id' }
        },
        required: ['id']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'plan_run',
      description:
        '立刻手动执行一次指定计划（等价于界面上的「立即运行」，不等定时点）。' +
        '执行是异步的：起跑后结果出现在计划绑定的会话里，别在这里等它跑完。',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '计划 id（先用 plan_list 取）' }
        },
        required: ['id']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'plan_cancel',
      description:
        '中止某个计划正在跑的那一次执行（计划本身保留，下次到点照常触发）。' +
        '只在用户明确要停的时候用，别用它顺手清后台任务。',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '计划 id（先用 plan_list 取）' }
        },
        required: ['id']
      }
    }
  }
];

/**
 * 会话级目标：**模型可以自己开目标**（用户不必先学会一句咒语），也可以在推进中补检查与清单。
 *
 * 为什么必须是工具而不是代码判断：要不要把一件事当成「做到 X 成立为止」，是语义判断 ——
 * 猜关键词（“帮我实现”“直到通过”）必然误判；写成「每轮无条件跑一条命令」又会烧掉整晚预算。
 * 入口交给模型，代码只负责三件客观的事：跑命令取事实、核对主张与事实是否一致、按预算停。
 *
 * 单会话单目标：已有进行中的目标时 `goal_start` 会返回它（让模型接着推进，而不是每轮重开）。
 *
 * 描述里写了两条**能力事实**（不是话术推动）：「可以途中补开」「同一轮内就能开→check→finish」。
 * 缺了它们模型会把开目标理解成「下一轮才开始的手续」，于是永远等不到时机 —— 而四件目标工具
 * 常驻（见 `renderer-tool-defs.js`）本来就是为了同轮连贯，这是既有能力，只是之前没写出来。
 */
const GOAL_START_TOOL = {
  type: 'function',
  function: {
    name: 'goal_start',
    description:
      '给**当前会话**建一个目标：一句话说清「什么状态算达成」。建了之后每轮都会自动带着目标与检查事实再来一轮，' +
      '直到 goal_finish 收尾或预算用尽 —— 中途不需要用户点「继续」。\n' +
      '默认倾向：要跑多步就建（改代码 / 查证 / 修一条失败链 / 装环境 / 排查现场）。判断依据不是「听起来大不大」，' +
      '而是「要么需要不止一轮，要么需要一条命令来证明做完了」。\n' +
      '不用建的：一次问答、纯解释、单条命令就能给出答案的事。\n' +
      '**可以途中补开**：不必等开工前。已经跑了好几步还没收口、或验收命令跑红了要继续修 —— 现在开就对了；' +
      '同一轮里可以接着 goal_check 与 goal_finish，不会多花一步，也不用重头再来。\n' +
      '没有能自动判定的验收命令也能开（checks 留空 = 未验证模式）：完成申请不会被代码核对，' +
      '但目标、清单与续跑照样生效；这种情况请在 goal_check 时自己给一条能失败的命令。\n' +
      '目标 = 验收面：objective（一句话说清达成状态）+ checks（可执行命令，退出码 0 = 通过）+ todos（**开工前先列出的计划清单**，边做边勾给人看；不参与自动判定）。',
    parameters: {
      type: 'object',
      properties: {
        objective: {
          type: 'string',
          description: '一句话说清「什么状态算达成」，人和你都能据此判断下一步'
        },
        checks: {
          type: 'array',
          description: '可机器验收的命令（可空 = 未验证模式：能跑，但完成申请不会被代码核对）',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: '短 id（缺省取命令前 40 字符）' },
              command: { type: 'string', description: '可执行命令，退出码 0 = 通过' }
            },
            required: ['command']
          }
        },
        todos: {
          type: 'array',
          description: '推进清单（**开工前先列出来**、都是未完成项；之后每完成一项就置 done。显示在侧栏「目标」页，也注入到每轮背景；不参与自动判定）',
          items: {
            type: 'object',
            properties: {
              text: { type: 'string', description: '一项具体要做的事' },
              done: { type: 'boolean', description: '做完了就置 true' }
            },
            required: ['text']
          }
        }
      },
      required: ['objective']
    }
  }
};

/** 推进清单 / 目标修订：整体替换（一次调用即最新真相，不做逐项增删工具） */
const GOAL_UPDATE_TOOL = {
  type: 'function',
  function: {
    name: 'goal_update',
    description:
      '更新当前会话目标的 objective / checks / todos（**给什么就整体替换什么**，没给的字段保留）。' +
      '用途：**每完成一项就立刻调一次**，把对应 todo 置 done —— 别攒到全部做完再一次性写，' +
      '那样用户在侧栏只能看到 0 然后跳到满格（清单是给人看计划的，不是完工汇报）。' +
      '发现新的验收命令也用它补进 checks。' +
      '不要用它改 outcome —— 收尾只有 goal_finish 一条路。',
    parameters: {
      type: 'object',
      properties: {
        objective: { type: 'string', description: '修订目标（含义变了才改；只改措辞就别动）' },
        checks: {
          type: 'array',
          description: '整体替换检查清单',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              command: { type: 'string', description: '可执行命令，退出码 0 = 通过' }
            },
            required: ['command']
          }
        },
        todos: {
          type: 'array',
          description: '整体替换推进清单（**把已完成项一起带上并置 done=true**，给的就是最新的全量清单）',
          items: {
            type: 'object',
            properties: {
              text: { type: 'string' },
              done: { type: 'boolean' }
            },
            required: ['text']
          }
        }
      }
    }
  }
};

/**
 * 目标推进期的两个工具（`goal_check` / `goal_finish`）。
 *
 * 为什么它们必须是工具、不能是调度器的固定步骤：**节奏是语义判断** —— 什么时候跑哪条检查、
 * 跑几次，取决于模型刚改了什么、哪条检查便宜。代码只留两件事：跑命令、核对主张与事实。
 *
 * 计划轮（`plan-agent-runner`）与会话轮（Renderer 主循环）共用这两个 schema，
 * 执行都在 `tool-bridge-main`，目标解析见那里的 `resolveGoalTarget`。
 * `goal_update`（改清单）只给会话目标：计划目标的验收面在「自动化」里改。
 */
const GOAL_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'goal_check',
      description:
        '跑一次检查命令，并把结果作为「事实」记到目标上（退出码、超时、被沙箱/审批拒绝、输出尾部）。' +
        '什么时候跑、跑哪条由你决定：目标声明了检查就按声明跑（用 check_id）；没声明时自己给一条能失败的命令。' +
        '事实是 goal_finish 的唯一依据 —— 没有通过的事实，完成申请会被打回。',
      parameters: {
        type: 'object',
        properties: {
          check_id: {
            type: 'string',
            description: '已声明检查的 id（与 command 二选一；给了 id 就用它的命令，命令由目标持有）'
          },
          command: {
            type: 'string',
            description: '要执行的检查命令（退出码 0 = 通过）；check_id 缺省时必填'
          }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'goal_finish',
      description:
        '为目标的一轮申请收尾。complete = 目标已达成：代码会核对事实（最近一次检查必须通过；' +
        '声明了检查时每条的最新结果都要通过），对不上就被打回并回灌失败事实；' +
        'blocked = 有具体卡点做不下去、需要人处理。不确定就先 goal_check 再取一次事实，别提前宣布完成。',
      parameters: {
        type: 'object',
        properties: {
          outcome: {
            type: 'string',
            enum: ['complete', 'blocked'],
            description: 'complete = 目标达成；blocked = 卡住需要人处理'
          },
          note: {
            type: 'string',
            description: '一句话：完成时指向哪条检查/证据；阻塞时写确切卡点（人据此接手）'
          }
        },
        required: ['outcome']
      }
    }
  }
];

/**
 * MCP 工具的两个入口，刻意合并在一个工具里（不新增第二个工具）：
 * - `agentName`：已知名字，查完整 JSON Schema（本轮工具表里的 schema 被折叠时用）。
 * - `query`：不知道叫什么 / 本轮工具表里没有它时，按自然语言检索「全部已启用 MCP 服务」。
 *
 * 为什么必须有 query：本轮 mcp_* 工具是按用户提问召回的子集（见 renderer-tool-defs.js），
 * 任务中途换向时新工具不会自己冒出来。没有 query 这条路，一次召回 miss 就等于该工具
 * 整轮不存在 —— 模型连「有这个工具」都不知道，无法补救。
 */

module.exports = {
  PLAN_TOOLS,
  GOAL_START_TOOL,
  GOAL_UPDATE_TOOL,
  GOAL_TOOLS
};
