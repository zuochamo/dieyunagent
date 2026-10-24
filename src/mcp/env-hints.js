'use strict';

/**
 * 「一个 MCP 服务声明了哪些环境变量」的**唯一来源**。
 *
 * 历史背景：起初每个服务只声明一个 `envHint`（字符串），配置页也只有**一个**输入框
 * （`store.js` 保存时写 `{ [envHint]: value }`）。于是「一个服务要传两个变量」没有出口 ——
 * 最典型的是 mcp-postgres：它支持多库（`DATABASE_URL` 与 `MCP_DATABASE_URLS` 互为替代，
 * 见 registry 里该条目的说明），但第二个变量填不进去，只能手改 mcp.json。
 *
 * 本模块把「声明」规范化成一张可以有多行的表，调用方（就绪判定 / 配置页 / 系统提示 /
 * 搜索索引）一律以它为准，**不要再各自去读 `server.envHint` 字段**。
 *
 * 两种声明方式可混用：
 * - `envHint: 'DATABASE_URL'`（旧）—— 单个变量，等价于一条 `required: true` 的条目，
 *   行为与改动前逐字一致。
 * - `envHints: [...]`（新）—— 条目可以是字符串（＝`{ name }`）或
 *   `{ name, label?, hint?, required? }`；`required` 省略时视为 true。
 *
 * `envRequirement` 决定「怎么算配好了」：
 * - `'all'`（默认）—— 所有 `required` 条目都必须就位（旧的单变量语义）。
 * - `'any'`           —— 至少一个条目就位即可（条目互为替代，例如单库串与多库串）。
 *
 * @typedef {{ name: string, label: string, hint: string, required: boolean }} EnvHintDef
 */

/** POSIX 环境变量名：字母/下划线开头。非法名直接丢弃，避免把脏数据透传进子进程 env。 */
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function normalizeEntry(raw) {
  const src = typeof raw === 'string' ? { name: raw } : raw;
  if (!src || typeof src !== 'object' || Array.isArray(src)) return null;
  const name = String(src.name || '').trim();
  if (!name || !ENV_NAME_RE.test(name)) return null;
  return {
    name,
    label: String(src.label || '').trim(),
    hint: String(src.hint || '').trim(),
    required: src.required !== false
  };
}

/**
 * 规范化后的声明表（按声明顺序，按变量名去重）。
 * @param {object | null | undefined} server
 * @returns {EnvHintDef[]}
 */
function getEnvHintDefs(server) {
  const out = [];
  const seen = new Set();
  const push = (def) => {
    if (!def || seen.has(def.name)) return;
    seen.add(def.name);
    out.push(def);
  };
  const list = server && Array.isArray(server.envHints) ? server.envHints : [];
  for (const raw of list) push(normalizeEntry(raw));
  // 旧的单变量声明排在后面：若与 envHints 重名，以 envHints 里那条为准（保留 label/hint）。
  if (server && server.envHint) push(normalizeEntry({ name: server.envHint, required: true }));
  return out;
}

/** @param {object | null | undefined} server @returns {string[]} */
function getEnvHintNames(server) {
  return getEnvHintDefs(server).map((def) => def.name);
}

/** @param {object | null | undefined} server @returns {'all' | 'any'} */
function getEnvRequirement(server) {
  return server && server.envRequirement === 'any' ? 'any' : 'all';
}

/**
 * 声明的环境变量是否已就位。
 * @param {object | null | undefined} server
 * @param {(name: string) => boolean} hasValue 判「这个变量名现在有值吗」（凭据库 / process.env）
 * @returns {boolean}
 */
function isEnvSatisfied(server, hasValue) {
  const defs = getEnvHintDefs(server);
  if (!defs.length) return true;
  const has = (name) => {
    try {
      return !!hasValue(name);
    } catch {
      return false;
    }
  };
  if (getEnvRequirement(server) === 'any') return defs.some((def) => has(def.name));
  return defs.filter((def) => def.required).every((def) => has(def.name));
}

module.exports = {
  getEnvHintDefs,
  getEnvHintNames,
  getEnvRequirement,
  isEnvSatisfied
};
