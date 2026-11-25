'use strict';

// section 白名单**唯一来源**是 `src/agents-md.js#EDITABLE_SECTION_IDS`（执行侧
// `propose-tools-main.js` 与模板同源）。schema 以前自己抄了一份数组 —— 那是第二个拷贝。
const { EDITABLE_SECTION_IDS } = require('../../agents-md-sections');

/**
 * Agent 自我维护类工具：长期记忆（memory_recall / memory_forget）/ 会话回忆 / 技能增删 / AGENTS.md 提议。
 * 语义在执行侧（`src/agent/knowledge-maintainer.js`、`src/memory-shared`、Rust `memory`），这里只有 schema。
 */

const AGENTS_MD_PROPOSE_TOOL = {
  type: 'function',
  function: {
    name: 'agents_md_propose',
    description:
      '向当前工作空间 .dieyun/AGENTS.md 做分段增量更新（项目地图：命令、目录、规范、坑点等）。' +
      '**同主题已有条目时用 merge 并入，不要追加第二条**；新增用 append；整段重写用 replace。' +
      '设置里可开 Diff 预览后再采纳。也可以 fs_edit 该文件。',
    parameters: {
      type: 'object',
      properties: {
        section: {
          type: 'string',
          enum: EDITABLE_SECTION_IDS,
          description: '要更新的区块'
        },
        content: {
          type: 'string',
          description: '要写入的 Markdown 条目或短段落（建议以 - 开头的列表项）'
        },
        action: {
          type: 'string',
          enum: ['append', 'merge', 'replace'],
          description:
            'append 追加（默认）；merge 用 content 替换 anchor 命中的那一条（同主题合并的唯一方式）；replace 替换该 section 全文'
        },
        anchor: {
          type: 'string',
          description: 'merge 时必填：目标条目的开头片段（如 "**CameraCut"），在该 section 内按前缀匹配'
        },
        reason: {
          type: 'string',
          description: '可选：为何记录此项'
        }
      },
      required: ['section', 'content']
    }
  }
};

const SKILL_CREATE_TOOL = {
  type: 'function',
  function: {
    name: 'skill_create',
    description:
      '在用户主目录 ~/.dieyun/skills 创建新技能（写入 SKILL.md）。创建后提示用户在「技能列表」中启用。',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '技能显示名称（英文文件夹名会自动派生）' },
        description: { type: 'string', description: '一句话简介，写入 frontmatter' },
        content: { type: 'string', description: 'SKILL.md 正文（Markdown）' }
      },
      required: ['name', 'description']
    }
  }
};

// —— 记忆工具：让「读记忆 / 纠错」发生在对话内，而不是只能等自动注入 ——
//
// 记忆系统的老问题是「写得多、读得少」：每轮只自动注入 8+5 条，模型想不起别的只能认。
// 这两个工具把检索与纠错交回模型：recall 按需拉原始条目（带 id），forget 把记错的
// 那条软归档（可恢复，非物理删除）。都在轮内完成，不需要新增表或界面。
const MEMORY_RECALL_TOOL = {
  type: 'function',
  function: {
    name: 'memory_recall',
    description:
      '按需检索长期记忆（项目级 + 用户级），返回带 id 的条目。' +
      '自动注入每轮只带最相关的几条；需要想起更多细节、或确认「之前定过什么」时用它。' +
      '只有本次召回/注入出现过的 id 才能用于 memory_forget。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '要查的主题，自然语言即可' },
        scope: {
          type: 'string',
          enum: ['all', 'project', 'global'],
          description: '检索范围：默认 all（项目 + 用户级）'
        },
        limit: { type: 'number', description: '返回条数上限（默认 8，最多 12）' }
      },
      required: ['query']
    }
  }
};

const MEMORY_FORGET_TOOL = {
  type: 'function',
  function: {
    name: 'memory_forget',
    description:
      '归档（软删除、可恢复）用户明确说记错了的记忆条目。' +
      '只接受本次请求里通过 memory_recall 或自动注入出现过的 id；' +
      '不要用它自行清理「看起来没用」的记忆。',
    parameters: {
      type: 'object',
      properties: {
        memoryIds: {
          type: 'array',
          items: { type: 'number' },
          description: '要归档的记忆 id（来自本次召回结果）'
        },
        reason: { type: 'string', description: '为何归档（写进审计日志，帮助事后复盘）' }
      },
      required: ['memoryIds']
    }
  }
};

// —— 会话检索工具：翻「以前聊过什么」 ——
//
// 记忆工具读的是**归纳后的结论**（长期记忆 / 项目记忆），这个读的是**原始对话**：
// 别的会话里人和模型实际说过什么，以及被压缩摘要吞掉的那段原文。
//
// 为什么只给一个工具而不是一套：记忆库是 distilled 的，会话是 raw 的，raw 侧只需要
// 「按字面找」——没有事件流、没有父子 trace，多给几个入口只会变成查不到东西的 schema。
const SESSION_RECALL_TOOL = {
  type: 'function',
  function: {
    name: 'session_recall',
    description:
      '检索既往会话的原始对话，成员按字面匹配返回带会话 id 的摘录。' +
      '用于「上次这个报错我们怎么处理的」「之前定过什么方案」这类归纳记忆里没有的细节。' +
      '默认只搜当前工作空间；folded=true 时连被压缩摘要吞掉的原文一起搜。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '要查的关键词或短语，字面匹配（不必写成句子）' },
        scope: {
          type: 'string',
          enum: ['workspace', 'session'],
          description: 'workspace = 当前工作空间内所有会话；session = 只看当前会话（默认 workspace）'
        },
        folded: {
          type: 'boolean',
          description: '是否同时检索压缩归档里被折叠的原文（默认 false）'
        },
        limit: { type: 'number', description: '返回条数上限（默认 12，最多 20）' }
      },
      required: ['query']
    }
  }
};

const MEMORY_TOOLS = [MEMORY_RECALL_TOOL, MEMORY_FORGET_TOOL];


const SKILL_DELETE_TOOL = {
  type: 'function',
  function: {
    name: 'skill_delete',
    description:
      '删除一个技能目录（用户自建 / 工作空间内的技能）。预装内置技能与技能根目录不可删。' +
      '只在用户明确要删时用；删之前先确认目录里就是他说的那个技能（可用 fs_read_file 看 SKILL.md）。',
    parameters: {
      type: 'object',
      properties: {
        dir: { type: 'string', description: '技能目录绝对路径（技能列表里显示的那个目录）' }
      },
      required: ['dir']
    }
  }
};


const SKILL_UPDATE_TOOL = {
  type: 'function',
  function: {
    name: 'skill_update',
    description:
      '改一个已有技能的 SKILL.md（目录不重命名、启用状态不变）。给什么改什么：name / description / content（正文）。\n' +
      '什么时候用：用户说「把这个技能的第 3 步改一下」「补一条注意事项」——**不要**删了重建：' +
      'createUserSkill 每次都新建目录（同名会变成 name-1），重建的副作用是启用状态丢失、技能列表堆副本。\n' +
      '预装内置技能不可修改（随包更新，改了下次升级会丢）。改之前先 fs_read_file 看一眼现在的全文。',
    parameters: {
      type: 'object',
      properties: {
        dir: { type: 'string', description: '技能目录绝对路径（技能列表里显示的那个目录）' },
        name: { type: 'string', description: '新名称（省略 = 保持原样）' },
        description: { type: 'string', description: '新简介（省略 = 保持原样）' },
        content: { type: 'string', description: '新正文（Markdown；省略 = 保持原样）' }
      },
      required: ['dir'],
      anyOf: [{ required: ['name'] }, { required: ['description'] }, { required: ['content'] }]
    }
  }
};


module.exports = {
  AGENTS_MD_PROPOSE_TOOL,
  SKILL_CREATE_TOOL,
  SKILL_DELETE_TOOL,
  SKILL_UPDATE_TOOL,
  MEMORY_RECALL_TOOL,
  MEMORY_FORGET_TOOL,
  MEMORY_TOOLS,
  SESSION_RECALL_TOOL
};
