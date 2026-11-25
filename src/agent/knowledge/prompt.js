'use strict';

/**
 * 归纳器的 system prompt 与三份「写入规则」文本 —— **唯一措辞**。
 *
 * 为什么单独一个文件：提示词是最常被改、也最需要并排对照的东西（`UNIFIED_KNOWLEDGE_SCHEMA` 的
 * 字段、`PROJECT_MEMORY_FILE_RULE` 的 scope 分流、`AGENTS_MERGE_RULE` 的 merge/anchor）——
 * 之前在 1600 行的归纳器中间，改一句要翻很久。
 *
 * 纯搬移（2026-11-21）：逻辑一行没改，`knowledge-maintainer.js` 继续再导出。
 */

// AGENTS.md 的体积上限只有一个来源：`agents-md.js` 的 `MAX_FILE_CHARS`。
const { MAX_FILE_CHARS: AGENTS_MD_FILE_MAX_CHARS } = require('../../agents-md');

/**
 * scope 分流规则 + 项目条目的落点。两个 prompt（完整 / 收尾）共用同一份：
 * 项目记忆是仓库里的文件而不是库，写法要按「人也会读」来要求。
 */
const PROJECT_MEMORY_FILE_RULE =
  '与工作空间架构/约定/常用命令/目录结构相关的事实标 scope=project，其余标 scope=global。' +
  'scope=project 的条目会写进仓库里的 .dieyun/memory.md（人可读、可手改、会随仓库提交）：' +
  '一行一句短陈述、自包含（不写「上面说的那样」），不要写密钥/口令/隐私（这类只能用 scope=global）。\n';

const UNIFIED_KNOWLEDGE_SCHEMA = `只输出 JSON，不要 Markdown 包裹或额外说明。格式：
{
  "memories": [{"content":"…","kind":"normal|private|secret","importance":1-5,"scope":"global|project"}],
  "archive_memory_ids": ["记忆id"],
  "agents_updates": [{"section":"commands","action":"append|merge|replace","anchor":"merge 时填已有条目的开头片段","content":"- …","confidence":0.9}]
}`;

/**
 * 同主题合并的唯一可执行路径（merge + anchor）。
 *
 * 不给这条引导，后台归纳器只会 append —— 实测某项目文件在一天内被加了 20 条，
 * 其中 CameraCut 同主题重复两次，直接把文件顶到 24000 上限、要靠人工压。
 * 措辞与 `tool-catalog.js` 的 agents_md_propose 描述保持一致。
 */
const AGENTS_MERGE_RULE =
  '   **同主题已有条目要合并，不要追加第二条**：用 action:"merge" + anchor' +
  '（已有条目的开头片段，如 "**CameraCut"），content 写合并后的完整条目；' +
  '确实没有同主题条目时才用 action:"append"；整段重写用 action:"replace"。\n';

/**
 * 给归纳器一个体积感。没有这句，它不知道自己在往一个快写满的文件里塞东西，
 * 于是照旧 append（实测正是这条路径把文件顶到 24000）。
 */
function agentsPressureNote(content, maxChars) {
  const len = String(content || '').length;
  const limit = Number(maxChars) || AGENTS_MD_FILE_MAX_CHARS;
  if (len < limit * 0.75) return '';
  return `\n⚠ 当前已约 ${len} 字（上限 ${limit}，接近写满）：本次 agents_updates 只做合并（merge），不要 append 新增条目。`;
}

/**
 * 归纳器 system prompt。两种形态：
 *   - fullPeriodic：定时完整归纳（输入是「近期对话 + 已有记忆 + AGENTS.md」语料）；
 *   - 默认：一轮任务收尾（输入含 plan/验收/工具/变更）。
 */
function buildKnowledgeSystemPrompt(opts = {}) {
  const { fullPeriodic, agentsEnabled } = opts;
  if (fullPeriodic) {
    let boundary =
      '你是叠云 Agent 的定时知识归纳器。根据输入中的对话与已有知识，合并去重、提炼稳定事实，并建议归档过时记忆。' +
      UNIFIED_KNOWLEDGE_SCHEMA +
      '【写入边界】\n' +
      '1. memories：可复用事实/偏好/密钥（标 kind）；不要寒暄与无结论过程。\n' +
      '2. ' +
      PROJECT_MEMORY_FILE_RULE +
      '3. archive_memory_ids：仅填输入里给出的过时/重复记忆 id。\n';
    if (agentsEnabled) {
      boundary +=
        '4. agents_updates：稳定命令/目录/规范/坑点短列表；section=overview|structure|commands|conventions|testing|architecture|gotchas。\n' +
        AGENTS_MERGE_RULE;
    } else {
      boundary += '4. 本次未启用 AGENTS.md 维护：agents_updates 必须为空数组。\n';
    }
    return `${boundary}5. 只写「未来任务仍会用到」的内容，不要复述本轮做了什么。`;
  }
  const agentsLine = agentsEnabled
    ? '4. agents_updates：稳定命令/目录/规范/坑点短列表；section=overview|structure|commands|conventions|testing|architecture|gotchas。\n' +
      AGENTS_MERGE_RULE
    : '4. 本次未启用 AGENTS.md 维护：agents_updates 必须为空数组。\n';
  return (
    '你是叠云 Agent 的知识归纳器。根据输入中的任务、结果、工具轨迹与文件变更，提炼稳定可复用的记忆，' +
    '并按需要提出 AGENTS.md 更新。' +
    UNIFIED_KNOWLEDGE_SCHEMA +
    '【写入边界】\n' +
    '1. memories：可复用事实/偏好/密钥（标 kind）；不要寒暄与无结论过程。\n' +
    '2. ' +
    PROJECT_MEMORY_FILE_RULE +
    '3. 只写「未来任务仍会用到」的内容，不要复述本轮做了什么。\n' +
    agentsLine
  );
}

module.exports = {
  PROJECT_MEMORY_FILE_RULE,
  UNIFIED_KNOWLEDGE_SCHEMA,
  AGENTS_MERGE_RULE,
  agentsPressureNote,
  buildKnowledgeSystemPrompt
};
