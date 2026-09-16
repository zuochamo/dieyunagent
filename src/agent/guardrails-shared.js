'use strict';
// @ts-check

/**
 * Shared tool guardrail constants + pure logic (Main + Renderer).
 * Numeric limits always come from agent-limits.js via createGuardrailApi(getLimits).
 */

const TOOL_NAME_ALIASES = Object.freeze({
  rg: 'grep',
  ripgrep: 'grep',
  read_file: 'fs_read_file',
  write_file: 'fs_write_file',
  list_dir: 'fs_list_dir',
  edit: 'fs_edit',
  str_replace: 'fs_edit',
  str_replace_editor: 'fs_edit',
  search_replace: 'fs_edit'
});

/** 旧七个 graph_* 工具名 → 统一 graph.operation */
const GRAPH_LEGACY_OPS = Object.freeze({
  graph_module_deps: 'module_deps',
  graph_find_symbol: 'find_symbol',
  graph_semantic_find_symbol: 'semantic_find',
  graph_callers: 'callers',
  graph_callees: 'callees',
  graph_impact: 'impact',
  graph_lsp_callers: 'lsp_callers'
});

const GRAPH_OPERATIONS = Object.freeze(
  new Set(['find_symbol', 'semantic_find', 'module_deps', 'callers', 'callees', 'impact', 'lsp_callers'])
);

/** 工具名归类单一来源（Main + Renderer 共用）。含 host_exec，调用方按命令内容细分。 */
const MUTATING_TOOL_NAMES = Object.freeze(
  new Set([
    'host_exec',
    'fs_write_file',
    'fs_edit',
    'host_print_image',
    'skill_create',
    'plan_create',
    'plan_delete',
    'agents_md_propose',
    'playbook_propose'
  ])
);

/** 会写入本地文件的工具名（不含 host_exec，后者按命令内容判断）。 */
const FILE_WRITE_TOOL_NAMES = Object.freeze(
  new Set(['fs_write_file', 'fs_edit', 'skill_create', 'agents_md_propose', 'playbook_propose'])
);

/** 会改变页面状态的浏览器工具名前缀。 */
const BROWSER_MUTATING_PREFIXES = Object.freeze([
  'browser_click',
  'browser_evaluate',
  'browser_type',
  'browser_fill',
  'browser_select',
  'browser_press',
  'browser_scroll',
  'browser_hover',
  'browser_drag',
  'browser_double',
  'browser_right',
  'browser_navigate',
  'browser_reload',
  'browser_back',
  'browser_forward',
  'browser_import',
  'browser_cookies',
  'browser_route',
  'browser_emulate'
]);

function isMutatingAgentToolName(name) {
  const n = String(name || '');
  if (MUTATING_TOOL_NAMES.has(n)) return true;
  return BROWSER_MUTATING_PREFIXES.some((p) => n === p || n.startsWith(`${p}_`));
}

/** fs_edit 参数是否可用（legacy oldString/newString 或 edits 数组）。 */
function fsEditArgsPresent(args) {
  const a = args && typeof args === 'object' ? args : {};
  const oldString = a.oldString != null ? a.oldString : a.old_string;
  const newString = a.newString != null ? a.newString : a.new_string;
  const hasLegacy =
    typeof oldString === 'string' && oldString.length > 0 && typeof newString === 'string';
  const hasEdits = a.edits != null && a.edits !== '';
  return { ok: hasLegacy || hasEdits, hasLegacy, hasEdits, oldString, newString };
}

const HOST_EXEC_FILE_WRITE_RE =
  /(?:^|[\s;&|])(?:set-content|add-content|out-file|new-item|copy-item|move-item|remove-item|ren(?:ame)?|del|erase|mkdir|rmdir|md|rd|touch|tee|cp|mv|rm|git\s+(?:apply|commit|merge|rebase|checkout|switch|restore|reset|clean)|patch)\b|(?:>|>>)|\b(?:writefile|appendfile|unlink|rename|mkdir|rmdir|rmSync|writeFileSync|appendFileSync)\b|(?:^|[\s;&|])sed\s+-[^-\s]*i/i;

const HOST_EXEC_VALIDATION_RE =
  /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|check|lint|typecheck|build)\b|\b(?:cargo|go)\s+(?:test|check|build)\b|\b(?:pytest|ruff|mypy|tsc|eslint|vitest|jest)\b|workspace\.diagnostics/i;

function stableStringifyArgs(args) {
  if (args == null) return '';
  if (typeof args !== 'object') return String(args);
  try {
    const sorted = {};
    for (const k of Object.keys(args).sort()) sorted[k] = args[k];
    return JSON.stringify(sorted);
  } catch {
    return String(args);
  }
}

function toolCallFingerprint(name, args) {
  return `${String(name || '').trim()}\0${stableStringifyArgs(args)}`;
}

function parseFingerprint(fp) {
  const sep = String(fp || '').indexOf('\0');
  if (sep < 0) return { name: fp, args: {} };
  try {
    return { name: fp.slice(0, sep), args: JSON.parse(fp.slice(sep + 1)) };
  } catch {
    return { name: fp.slice(0, sep), args: {} };
  }
}

function countRecentStreak(history, fingerprint) {
  let streak = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i] === fingerprint) streak += 1;
    else break;
  }
  return streak;
}

function normalizeAgentToolName(name, args) {
  const raw = String(name || '').trim();
  const key = raw.toLowerCase();
  const mapped = TOOL_NAME_ALIASES[key] || raw;
  const next = { ...(args || {}) };
  if (mapped === 'codebase_search' && !next.query) {
    next.query = String(next.pattern || next.q || next.search || next.path || next.filePath || raw).slice(
      0,
      500
    );
  }
  if (mapped === 'grep' && !next.pattern) {
    next.pattern = String(next.query || next.q || next.search || '').slice(0, 500);
  }
  if (mapped === 'glob' && !next.pattern) {
    next.pattern = String(next.glob || next.query || next.q || '').slice(0, 500);
  }
  if (mapped === 'lsp') {
    if (!next.operation) next.operation = next.op || next.method;
    // workspaceSymbol 是纯名字查询，path 可能是工作区目录而非文件，不搬运
    if (!next.filePath && next.operation !== 'workspaceSymbol') {
      next.filePath = next.file_path || next.path || next.file;
    }
    if (next.character == null && next.column != null) next.character = next.column;
    if (next.character == null && next.col != null) next.character = next.col;
  }
  if (mapped === 'read_symbol') {
    if (!next.filePath && (next.file_path || next.path)) next.filePath = next.file_path || next.path;
    if (!next.name) next.name = next.symbol || next.symbolName || next.symbol_name || next.query;
    if (next.maxLines == null) next.maxLines = next.max_lines;
  }
  if (mapped === 'fs_read_file' && !next.filePath) {
    next.filePath = next.path || next.file || next.filename;
  }
  if (mapped === 'fs_list_dir' && !next.dirPath) {
    next.dirPath = next.path || next.dir || next.directory;
  }
  if (mapped === 'fs_write_file' && !next.filePath) {
    next.filePath = next.path || next.file || next.filename;
  }
  if (mapped === 'fs_edit') {
    if (!next.filePath) next.filePath = next.path || next.file || next.filename;
    if (next.oldString == null) next.oldString = next.old_string;
    if (next.newString == null) next.newString = next.new_string;
    if (next.replaceAll == null) next.replaceAll = next.replace_all;
  }
  const legacyGraphOp = GRAPH_LEGACY_OPS[key] || GRAPH_LEGACY_OPS[mapped];
  if (legacyGraphOp) {
    if (!next.operation) next.operation = next.op || legacyGraphOp;
    return { name: 'graph', args: next };
  }
  if (mapped === 'graph') {
    if (!next.operation) next.operation = next.op;
  }
  return { name: mapped, args: next };
}

function hostExecCommand(args) {
  return String(args?.command || '').trim();
}

function hostExecLooksFileWriting(commandOrArgs) {
  const cmd =
    typeof commandOrArgs === 'string'
      ? commandOrArgs
      : hostExecCommand(commandOrArgs);
  return !!cmd && HOST_EXEC_FILE_WRITE_RE.test(cmd);
}

function hostExecLooksValidation(commandOrArgs) {
  const cmd =
    typeof commandOrArgs === 'string'
      ? commandOrArgs
      : hostExecCommand(commandOrArgs);
  return !!cmd && HOST_EXEC_VALIDATION_RE.test(cmd);
}

function isWriteTool(name, args) {
  const n = String(name || '').trim();
  if (n === 'fs_write_file' || n === 'fs_edit') return true;
  if (n === 'host_exec') return hostExecLooksFileWriting(args);
  return false;
}

/**
 * @param {() => object} getLimits returns agent-limits merged object
 */
function createGuardrailApi(getLimits) {
  function lims() {
    return typeof getLimits === 'function' ? getLimits() : {};
  }

  return {
    shouldBlockRepeatToolCall(name, args, history, limit) {
      const lim = limit != null ? limit : lims().repeatToolStreakLimit;
      const fp = toolCallFingerprint(name, args);
      const streak = countRecentStreak(history, fp);
      return streak >= Math.max(2, lim) - 1;
    },
    recordToolCallFingerprint(history, name, args) {
      const fp = toolCallFingerprint(name, args);
      history.push(fp);
      const maxHist = lims().repeatHistoryMax;
      while (history.length > maxHist) history.shift();
      return fp;
    },
    repeatToolBlockMessage(name, argsBrief, limit) {
      const arg = argsBrief ? `(${argsBrief})` : '';
      const lim = limit != null ? limit : lims().repeatToolStreakLimit;
      return (
        `重复工具调用已止损：连续 ${lim} 次相同调用 ${name}${arg}。` +
        '请换思路、换参数，或直接向用户说明卡点。'
      );
    }
  };
}

const SHARED_EXPORTS = {
  TOOL_NAME_ALIASES,
  GRAPH_LEGACY_OPS,
  GRAPH_OPERATIONS,
  HOST_EXEC_FILE_WRITE_RE,
  HOST_EXEC_VALIDATION_RE,
  stableStringifyArgs,
  toolCallFingerprint,
  parseFingerprint,
  countRecentStreak,
  normalizeAgentToolName,
  hostExecCommand,
  hostExecLooksFileWriting,
  hostExecLooksValidation,
  isWriteTool,
  MUTATING_TOOL_NAMES,
  FILE_WRITE_TOOL_NAMES,
  BROWSER_MUTATING_PREFIXES,
  isMutatingAgentTool: isMutatingAgentToolName,
  fsEditArgsPresent,
  createGuardrailApi
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = SHARED_EXPORTS;
}

if (typeof window !== 'undefined') {
  /** @type {any} */
  const w = window;
  w.GuardrailsShared = SHARED_EXPORTS;
}
