'use strict';

const { validateShellCommand } = require('../gateway/exec-policy');
const { GRAPH_LEGACY_OPS, GRAPH_OPERATIONS, fsEditArgsPresent } = require('./guardrails-shared');

function isHttpUrl(s) {
  try {
    const u = new URL(String(s));
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

function looksLikeApplyPatchCommand(cmd) {
  return /(?:^|[\s;&|`])apply_patch\b/.test(String(cmd || '').trim());
}

function applyPatchUnsupported() {
  return {
    ok: false,
    error: '没有 apply_patch 命令/工具。请用 fs_edit 修改已有文件，或 fs_write_file 新建/覆盖。',
    errorCode: 'USE_FS_EDIT',
    retryable: false,
    suggestedFix: '改用 fs_edit（从最近一次 fs_read_file 复制 oldString）'
  };
}

function mcpArgPresent(val) {
  if (val == null) return false;
  if (typeof val === 'string') return !!val.trim();
  if (Array.isArray(val)) return val.length > 0;
  if (typeof val === 'object') return Object.keys(val).length > 0;
  return true;
}

function jsonSchemaTypeOk(val, typeSpec) {
  const types = Array.isArray(typeSpec) ? typeSpec : typeSpec ? [typeSpec] : [];
  if (!types.length) return true;
  return types.some((t) => {
    if (t === 'string') return typeof val === 'string';
    if (t === 'number' || t === 'integer') return typeof val === 'number' && Number.isFinite(val);
    if (t === 'boolean') return typeof val === 'boolean';
    if (t === 'array') return Array.isArray(val);
    if (t === 'object') return !!val && typeof val === 'object' && !Array.isArray(val);
    if (t === 'null') return val == null;
    return true;
  });
}

function mcpRequiredKeys(schema) {
  if (!schema || typeof schema !== 'object') return [];
  if (Array.isArray(schema.required) && schema.required.length) {
    return schema.required.map((k) => String(k));
  }
  const props = schema.properties && typeof schema.properties === 'object' ? schema.properties : {};
  const keys = Object.keys(props);
  if (keys.length === 1) return keys;
  return [];
}

/**
 * @param {string} name
 * @param {object} args
 * @param {object} [schema]
 */
function validateMcpInputArgs(name, args, schema) {
  const n = String(name || '').trim() || 'mcp';
  const a = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
  if (!schema || typeof schema !== 'object') return { ok: true };
  if (schema.type && schema.type !== 'object' && !schema.properties) {
    return {
      ok: false,
      error: `${n} 的参数应是 ${schema.type}，不要传空对象 {}`,
      errorCode: 'MISSING_ARG',
      retryable: false,
      suggestedFix: `按工具 schema 传入参数，不要调用 ${n}({})`
    };
  }
  const properties = schema.properties && typeof schema.properties === 'object' ? schema.properties : {};
  const required = mcpRequiredKeys(schema);
  const missing = [];
  const badType = [];
  for (const key of required) {
    const val = a[key];
    if (!mcpArgPresent(val)) {
      missing.push(key);
      continue;
    }
    const spec = properties[key];
    const want = spec && spec.type;
    if (want && !jsonSchemaTypeOk(val, want)) badType.push(key);
  }
  if (missing.length) {
    return {
      ok: false,
      error: `${n} 缺少参数：${missing.join('、')}`,
      errorCode: 'MISSING_ARG',
      retryable: false,
      suggestedFix: `按工具 schema 传入 ${missing.join('、')}，不要调用 ${n}({})`
    };
  }
  if (badType.length) {
    return {
      ok: false,
      error: `${n} 参数类型错误：${badType.join('、')}`,
      errorCode: 'MISSING_ARG',
      retryable: false,
      suggestedFix: `按工具 schema 修正 ${badType.join('、')} 的类型`
    };
  }
  return { ok: true };
}

/**
 * @returns {{ ok: true } | { ok: false, error: string, errorCode: string, retryable: false, suggestedFix?: string }}
 */
function validateToolArgs(name, args, opts) {
  let n = String(name || '').trim();
  let a = args && typeof args === 'object' ? args : {};
  const legacyGraphOp = GRAPH_LEGACY_OPS[n.toLowerCase()] || GRAPH_LEGACY_OPS[n];
  if (legacyGraphOp) {
    n = 'graph';
    a = { ...a, operation: a.operation || a.op || legacyGraphOp };
  }

  if (!n) {
    return { ok: false, error: '工具名为空', errorCode: 'INVALID_NAME', retryable: false };
  }

  switch (n) {
    case 'host_exec': {
      const cmd = String(a.command || '').trim();
      if (!cmd) {
        return {
          ok: false,
          error: 'host_exec 缺少 command',
          errorCode: 'MISSING_ARG',
          retryable: false,
          suggestedFix: '提供 command 字符串；Windows 下避免 python -c 双引号内分号'
        };
      }
      const policy = validateShellCommand(cmd);
      if (!policy.ok) {
        return {
          ok: false,
          error: policy.message || '命令被安全策略拒绝',
          errorCode: policy.code || 'BLOCKED',
          retryable: false,
          suggestedFix: '拆分命令逐步执行，或改用临时 .py/.ps1 脚本'
        };
      }
      if (looksLikeApplyPatchCommand(cmd)) {
        return applyPatchUnsupported();
      }
      return { ok: true };
    }
    case 'apply_patch':
      return applyPatchUnsupported();
    case 'host_proc':
      if (a.action === 'kill' && !String(a.id || '').trim() && !a.pid) {
        return {
          ok: false,
          error: 'host_proc kill 需要 id 或 pid',
          errorCode: 'MISSING_ARG',
          retryable: false,
          suggestedFix: '传 host_exec detached 返回的 handle（id），或 host_proc list 里的 pid'
        };
      }
      return { ok: true };
    case 'fs_read_file':
    case 'fs_list_dir':
    case 'host_print_image': {
      const p = a.filePath || a.dirPath;
      if (!p || !String(p).trim()) {
        return {
          ok: false,
          error: `${n} 缺少路径参数`,
          errorCode: 'MISSING_PATH',
          retryable: false,
          suggestedFix: '使用相对工作区路径，如 src/main.js'
        };
      }
      return { ok: true };
    }
    case 'fs_write_file': {
      const p = a.filePath;
      if (!p || !String(p).trim()) {
        return {
          ok: false,
          error: 'fs_write_file 缺少 filePath',
          errorCode: 'MISSING_PATH',
          retryable: false
        };
      }
      if (a.content == null || typeof a.content !== 'string') {
        return {
          ok: false,
          error: 'fs_write_file 缺少有效 content（字符串）',
          errorCode: 'MISSING_CONTENT',
          retryable: false
        };
      }
      return { ok: true };
    }
    case 'fs_edit': {
      const p = a.filePath || a.path;
      if (!p || !String(p).trim()) {
        return {
          ok: false,
          error: 'fs_edit 缺少 filePath',
          errorCode: 'MISSING_PATH',
          retryable: false
        };
      }
      const { hasLegacy, hasEdits } = fsEditArgsPresent(a);
      if (!hasLegacy && !hasEdits) {
        return {
          ok: false,
          error: 'fs_edit 缺少 oldString 或 edits',
          errorCode: 'MISSING_OLD',
          retryable: false,
          suggestedFix: '从最近一次 fs_read_file 原文复制；多处不相交改动用 edits[{oldText,newText}]'
        };
      }
      return { ok: true };
    }
    case 'web_fetch':
    case 'host_open_url':
      if (!isHttpUrl(a.url)) {
        return {
          ok: false,
          error: 'url 必须是 http(s) 链接',
          errorCode: 'INVALID_URL',
          retryable: false,
          suggestedFix: '示例：https://example.com/path'
        };
      }
      return { ok: true };
    case 'web_search':
      if (!String(a.query || '').trim()) {
        return {
          ok: false,
          error: 'web_search 缺少 query',
          errorCode: 'MISSING_ARG',
          retryable: false
        };
      }
      return { ok: true };
    case 'read_symbol':
      if (
        (!a.filePath || !String(a.filePath).trim()) &&
        !String(a.name || a.symbol || a.symbolName || '').trim()
      ) {
        return {
          ok: false,
          error: 'read_symbol 需要 filePath 或 name',
          errorCode: 'MISSING_ARG',
          retryable: false,
          suggestedFix: 'filePath+name、filePath+line，或只给 name 全库查找'
        };
      }
      return { ok: true };
    case 'codebase_search':
      if (!String(a.query || '').trim()) {
        return {
          ok: false,
          error: 'codebase_search 缺少 query',
          errorCode: 'MISSING_ARG',
          retryable: false
        };
      }
      return { ok: true };
    case 'grep':
      if (!String(a.pattern || a.query || '').trim()) {
        return {
          ok: false,
          error: 'grep 缺少 pattern',
          errorCode: 'MISSING_ARG',
          retryable: false
        };
      }
      return { ok: true };
    case 'glob':
      if (!String(a.pattern || a.glob || '').trim()) {
        return {
          ok: false,
          error: 'glob 缺少 pattern',
          errorCode: 'MISSING_ARG',
          retryable: false
        };
      }
      return { ok: true };
    case 'lsp': {
      const op = String(a.operation || a.op || '').trim();
      const allowed = new Set([
        'goToDefinition',
        'findReferences',
        'goToImplementation',
        'hover',
        'typeDefinition',
        'documentSymbol',
        'workspaceSymbol'
      ]);
      if (!allowed.has(op)) {
        return {
          ok: false,
          error:
            'lsp.operation 必须是 workspaceSymbol / documentSymbol / goToDefinition / typeDefinition / goToImplementation / findReferences / hover',
          errorCode: 'MISSING_ARG',
          retryable: false
        };
      }
      if (op === 'workspaceSymbol') {
        if (!String(a.query || a.name || a.symbol || '').trim()) {
          return {
            ok: false,
            error: 'lsp workspaceSymbol 缺少 query（符号名）',
            errorCode: 'MISSING_ARG',
            retryable: false
          };
        }
        return { ok: true };
      }
      if (!String(a.filePath || a.file_path || a.path || '').trim()) {
        return {
          ok: false,
          error: 'lsp 缺少 filePath',
          errorCode: 'MISSING_PATH',
          retryable: false
        };
      }
      if (op === 'documentSymbol') return { ok: true };
      if (a.line == null || !Number(a.line)) {
        return {
          ok: false,
          error: 'lsp 缺少 line（1-based）',
          errorCode: 'MISSING_ARG',
          retryable: false
        };
      }
      return { ok: true };
    }
    case 'graph': {
      const op = String(a.operation || a.op || '').trim();
      if (!GRAPH_OPERATIONS.has(op)) {
        return {
          ok: false,
          error:
            'graph.operation 必须是 find_symbol / semantic_find / module_deps / callers / callees / impact / lsp_callers',
          errorCode: 'MISSING_ARG',
          retryable: false
        };
      }
      if ((op === 'find_symbol' || op === 'semantic_find') && !String(a.query || '').trim()) {
        return {
          ok: false,
          error: `graph.${op} 缺少 query`,
          errorCode: 'MISSING_ARG',
          retryable: false
        };
      }
      if ((op === 'callers' || op === 'callees' || op === 'lsp_callers') && !String(a.name || '').trim()) {
        return {
          ok: false,
          error: `graph.${op} 缺少 name`,
          errorCode: 'MISSING_ARG',
          retryable: false
        };
      }
      if (op === 'impact' && !String(a.path || '').trim()) {
        return {
          ok: false,
          error: 'graph.impact 缺少 path',
          errorCode: 'MISSING_PATH',
          retryable: false
        };
      }
      return { ok: true };
    }
    case 'playbook_propose': {
      if (
        !String(a.title || '').trim() ||
        !String(a.goal || '').trim() ||
        !String(a.steps || '').trim()
      ) {
        return {
          ok: false,
          error: 'playbook_propose 需要 title、goal、steps',
          errorCode: 'MISSING_ARG',
          retryable: false
        };
      }
      return { ok: true };
    }
    case 'agents_md_propose': {
      if (!String(a.section || '').trim() || !String(a.content || '').trim()) {
        return {
          ok: false,
          error: 'agents_md_propose 需要 section 与 content',
          errorCode: 'MISSING_ARG',
          retryable: false
        };
      }
      return { ok: true };
    }
    case 'sql_query':
      if (!String(a.sql || '').trim()) {
        return {
          ok: false,
          error: 'sql_query 缺少 sql',
          errorCode: 'MISSING_ARG',
          retryable: false
        };
      }
      return { ok: true };
    case 'mcp_tool_schema':
      if (!String(a.agentName || '').trim()) {
        return {
          ok: false,
          error: 'mcp_tool_schema 缺少 agentName',
          errorCode: 'MISSING_ARG',
          retryable: false
        };
      }
      return { ok: true };
    default:
      if (n.startsWith('mcp_') && n !== 'mcp_tool_schema') {
        return validateMcpInputArgs(n, a, opts && opts.mcpSchema);
      }
      if (n.startsWith('browser_') && n !== 'browser_status' && n !== 'browser_close') {
        if (n === 'browser_navigate' && !String(a.url || '').trim()) {
          return {
            ok: false,
            error: 'browser_navigate 缺少 url',
            errorCode: 'MISSING_ARG',
            retryable: false
          };
        }
        if (n === 'browser_evaluate' && !String(a.script || '').trim()) {
          return {
            ok: false,
            error: 'browser_evaluate 需要 script',
            errorCode: 'MISSING_ARG',
            retryable: false
          };
        }
        if (n === 'browser_expect') {
          const list = Array.isArray(a.assertions) ? a.assertions : [];
          if (!list.length) {
            return {
              ok: false,
              error: 'browser_expect 需要非空 assertions 数组',
              errorCode: 'MISSING_ARG',
              retryable: false
            };
          }
        }
        if (n === 'browser_select_option' && !String(a.value || '').trim() && !String(a.label || '').trim()) {
          return {
            ok: false,
            error: 'browser_select_option 需要 value 或 label',
            errorCode: 'MISSING_ARG',
            retryable: false
          };
        }
        if (n === 'browser_hover' && !String(a.ref || '').trim() && !String(a.selector || '').trim()) {
          return {
            ok: false,
            error: 'browser_hover 需要 ref 或 selector',
            errorCode: 'MISSING_ARG',
            retryable: false
          };
        }
        if (n === 'browser_drag') {
          const hasFrom = String(a.ref || '').trim() || String(a.selector || '').trim();
          const hasTo =
            String(a.toRef || '').trim() ||
            String(a.toSelector || '').trim() ||
            Number(a.dx) ||
            Number(a.dy);
          if (!hasFrom) {
            return {
              ok: false,
              error: 'browser_drag 需要起始 ref 或 selector',
              errorCode: 'MISSING_ARG',
              retryable: false
            };
          }
          if (!hasTo) {
            return {
              ok: false,
              error: 'browser_drag 需要 toRef/toSelector 或 dx/dy',
              errorCode: 'MISSING_ARG',
              retryable: false
            };
          }
        }
        if (
          (n === 'browser_click' || n === 'browser_double_click' || n === 'browser_right_click') &&
          !String(a.ref || '').trim() &&
          !String(a.selector || '').trim()
        ) {
          return {
            ok: false,
            error: `${n} 需要 ref 或 selector`,
            errorCode: 'MISSING_ARG',
            retryable: false
          };
        }
        if (n === 'browser_import_storage') {
          const hasCookies = Array.isArray(a.cookies) && a.cookies.length > 0;
          const hasLs =
            a.localStorage && typeof a.localStorage === 'object' && !Array.isArray(a.localStorage) &&
            Object.keys(a.localStorage).length > 0;
          if (!hasCookies && !hasLs) {
            return {
              ok: false,
              error: 'browser_import_storage 需要 cookies 或 localStorage',
              errorCode: 'MISSING_ARG',
              retryable: false
            };
          }
        }
      }
      return { ok: true };
  }
}

module.exports = {
  validateToolArgs,
  validateMcpInputArgs,
  isHttpUrl,
  applyPatchUnsupported
};
