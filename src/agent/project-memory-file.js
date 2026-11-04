'use strict';

/**
 * 项目记忆的文件形态：`<workspace>/.dieyun/memory.md`。
 *
 * 为什么项目记忆要走文件，而不是继续堆 SQLite 行：
 *
 * 1. **没人是唯一真相**。库里的 1500+ 条项目记忆，用户看不见、改不了、删不掉，只能通过
 *    「每轮注入 8 条」间接影响模型；写多了也读不到（藏起来的记忆等于没有记忆）。
 *    文件是可读、可手改、可 diff、可随仓库提交的形态 —— 手改立刻生效。
 * 2. **身份问题消失**。路径派生的 `project:<hash>` scope 一改目录名就断，还要维护路径表；
 *    文件跟着仓库走，重命名不会丢。
 * 3. **向量只做索引**。语义召回需要 embedding，但「项目记忆有哪些」不需要 —— 注入按字符预算
 *    读文件头部（最新在前），语义检索退化为可选项（DB 里的旧行仍可被 memory_recall 按需查到）。
 *
 * 文件格式（故意极简，人可读第一、机器解析第二）：
 *
 *     # 项目记忆
 *     > 说明…
 *
 *     - 最新一条
 *     - 上一条
 *
 * 约束：
 * - 一行一条，`- ` 开头；最新在最前面（注入只读前面一段，所以顺序就是优先级）。
 * - `kind=secret` / `kind=private` 的条目**永不写入本文件**（它会进版本库，等于泄露）。
 * - 重复判定按归一化后的正文完全相等（近重复由归纳器的 LLM 合并，不在文件层再造一套相似度）。
 */

const PROJECT_MEMORY_REL_PATH = '.dieyun/memory.md';

const FILE_HEADER = [
  '# 项目记忆',
  '',
  '> 本文件由叠云 Agent 维护（自动归纳会合并新增条目），也可以直接手改：注入时按字符预算读最前面的条目。',
  '> 一行一条、`- ` 开头，最新的放最前面；不要写密钥/口令类内容。',
  ''
].join('\n');

/** 单条正文上限：一条记忆写成一整段长文就不是「记忆」了。 */
const ENTRY_MAX_CHARS = 300;
/** 文件条目数上限：再多也进不了注入预算，纯属占位。 */
const FILE_MAX_ENTRIES = 200;

function normalizeText(s) {
  return String(s || '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 归一化键：比较用（大小写与标点差异不该产生第二条记忆）。 */
function entryKey(s) {
  return normalizeText(s)
    .toLowerCase()
    .replace(/[。．.；;，,！!？?、~～"'“”‘’()（）\[\]【】:：]/g, '');
}

/**
 * 解析文件里的条目（只认 `- ` 开头的行；标题、引用、说明行一律忽略，
 * 这样手写 Markdown 也不会被误当成记忆）。
 * @returns {string[]} 原文顺序（最新在前）
 */
function parseProjectMemoryEntries(text) {
  const out = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line.startsWith('- ')) continue;
    const body = normalizeText(line.slice(2));
    if (!body) continue;
    out.push(body.slice(0, ENTRY_MAX_CHARS));
  }
  return out;
}

/**
 * 合并条目：新条目在前，按归一化正文去重，超上限丢最旧的。
 * @param {string[]} existing 现有条目（最新在前）
 * @param {string[]} incoming 新条目（调用方给的是「较新的」）
 */
function mergeProjectMemoryEntries(existing, incoming) {
  const seen = new Set();
  const out = [];
  for (const raw of [...(incoming || []), ...(existing || [])]) {
    const body = normalizeText(raw).slice(0, ENTRY_MAX_CHARS);
    if (!body) continue;
    const key = entryKey(body);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(body);
    if (out.length >= FILE_MAX_ENTRIES) break;
  }
  return out;
}

function renderProjectMemoryFile(entries) {
  const list = (entries || []).slice(0, FILE_MAX_ENTRIES);
  if (!list.length) return FILE_HEADER;
  return `${FILE_HEADER}${list.map((e) => `- ${e}`).join('\n')}\n`;
}

/**
 * 注入块：只取文件头部的条目，按字符预算截断（预算归 `agent-limits`）。
 * @param {string} text 文件原文
 * @param {{ maxChars?: number, workspacePath?: string }} opts
 */
function formatProjectMemoryBlock(text, opts = {}) {
  const entries = parseProjectMemoryEntries(text);
  if (!entries.length) return '';
  const maxChars = Math.max(400, Number(opts.maxChars) || 2400);
  const lines = [];
  let used = 0;
  for (const e of entries) {
    const line = `- ${e}`;
    if (used + line.length + 1 > maxChars) break;
    lines.push(line);
    used += line.length + 1;
  }
  if (!lines.length) return '';
  const more = entries.length > lines.length ? `\n（还有 ${entries.length - lines.length} 条更早的条目未注入，需要时用 memory_recall 或直接读 ${PROJECT_MEMORY_REL_PATH}）` : '';
  return [
    `【项目记忆 · ${PROJECT_MEMORY_REL_PATH} · 跨会话沉淀，非本轮对话记录】`,
    opts.workspacePath ? `绑定工作空间：${opts.workspacePath}` : '',
    '与当前任务相关时优先遵守；与用户最新输入或【本会话近期对话】冲突时以会话对话为准。手改该文件即时生效。',
    lines.join('\n') + more
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * 「这条记忆能不能离开本机」——**唯一判定**。
 *
 * 两个落地物都要过这一关，而它们的后果一样：`.dieyun/memory.md` 会进版本库，
 * 共享记忆库是局域网里所有机器共读。所以 secret / private 既不能写文件、也不能上传，
 * 判定只写一份（`filterEntriesForFile` 与 `memory-shared` 的上传路径共用）。
 * @param {string} kind
 */
function isShareableKind(kind) {
  const k = String(kind || 'normal').toLowerCase();
  return k !== 'secret' && k !== 'private';
}

/**
 * 归纳器产出的条目 → 文件条目。
 * secret / private 直接丢弃：本文件会进版本库，写进去就是泄露。
 */
function filterEntriesForFile(items) {
  const kept = [];
  let dropped = 0;
  for (const item of items || []) {
    const kind = String((item && item.kind) || 'normal').toLowerCase();
    const content = normalizeText(item && item.content).slice(0, ENTRY_MAX_CHARS);
    if (!content) continue;
    if (!isShareableKind(kind)) {
      dropped += 1;
      continue;
    }
    kept.push(content);
  }
  return { kept, dropped };
}

module.exports = {
  PROJECT_MEMORY_REL_PATH,
  parseProjectMemoryEntries,
  mergeProjectMemoryEntries,
  renderProjectMemoryFile,
  formatProjectMemoryBlock,
  filterEntriesForFile,
  isShareableKind,
  entryKey
};
