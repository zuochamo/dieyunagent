'use strict';

const { validateShellCommand } = require('../gateway/exec-policy');
const { GRAPH_LEGACY_OPS, GRAPH_OPERATIONS, fsEditArgsPresent } = require('./guardrails-shared');
// 数字护栏单一来源（AGENTS.md §6）：computer 输入长度上限只改 agent-limits。
const { AGENT_LIMITS_DEFAULTS } = require('./agent-limits');

const COMPUTER_ACTIONS = [
  'screenshot',
  'click',
  'double_click',
  'right_click',
  'middle_click',
  'move',
  'drag',
  'type',
  'key',
  'scroll',
  'wait'
];
const COMPUTER_CLICK_ACTIONS = new Set(['click', 'double_click', 'right_click', 'middle_click']);

/** 校验 [x, y] 坐标：二元数值数组（像素坐标，允许小数/越界由执行端钳制）。 */
function computerPointOk(v) {
  return (
    Array.isArray(v) &&
    v.length === 2 &&
    Number.isFinite(Number(v[0])) &&
    Number.isFinite(Number(v[1]))
  );
}

/**
 * computer 工具参数校验（形状与枚举；档位/审批在 gateway，坐标换算在 computer/service）。
 */
function validateComputerArgs(a) {
  const act = String(a.action || '');
  if (!COMPUTER_ACTIONS.includes(act)) {
    return {
      ok: false,
      error: `computer 未知动作「${act}」`,
      errorCode: 'INVALID_ACTION',
      retryable: false,
      suggestedFix: `action 取值：${COMPUTER_ACTIONS.join(' | ')}`
    };
  }
  if (COMPUTER_CLICK_ACTIONS.has(act) || act === 'move' || act === 'drag') {
    if (act === 'drag' || act === 'move') {
      // move/drag 必须给坐标（没有「移到当前光标」的语义）；click 家族可省略=在当前位置点
      if (!computerPointOk(a.coordinate)) {
        return {
          ok: false,
          error: `computer ${act} 需要 coordinate（[x, y] 截图像素坐标）`,
          errorCode: 'MISSING_ARG',
          retryable: false,
          suggestedFix: '先 action=screenshot 看画面，再按截图里的像素位置传 coordinate'
        };
      }
    } else if (a.coordinate != null && !computerPointOk(a.coordinate)) {
      return {
        ok: false,
        error: 'coordinate 必须是 [x, y] 两个数字',
        errorCode: 'INVALID_ARG',
        retryable: false
      };
    }
    if (act === 'drag') {
      if (!computerPointOk(a.to)) {
        return {
          ok: false,
          error: 'computer drag 需要 to（终点 [x, y]）',
          errorCode: 'MISSING_ARG',
          retryable: false
        };
      }
    }
    if (a.button != null && !['left', 'right', 'middle'].includes(String(a.button))) {
      return {
        ok: false,
        error: `button 取值 left|right|middle，收到「${a.button}」`,
        errorCode: 'INVALID_ARG',
        retryable: false
      };
    }
    return { ok: true };
  }
  if (act === 'type') {
    const text = String(a.text == null ? '' : a.text);
    if (!text) {
      return {
        ok: false,
        error: 'computer type 需要 text',
        errorCode: 'MISSING_ARG',
        retryable: false
      };
    }
    if (text.length > AGENT_LIMITS_DEFAULTS.computerTextMaxLen) {
      return {
        ok: false,
        error: `text 超长（${text.length} > ${AGENT_LIMITS_DEFAULTS.computerTextMaxLen}）`,
        errorCode: 'INVALID_ARG',
        retryable: false,
        suggestedFix: '分段输入：先 type 前半段，再 type 后半段'
      };
    }
    return { ok: true };
  }
  if (act === 'key') {
    const key = String(a.key == null ? '' : a.key).trim();
    if (!key) {
      return { ok: false, error: 'computer key 需要 key（如 "ctrl+c"）', errorCode: 'MISSING_ARG', retryable: false };
    }
    if (key.length > AGENT_LIMITS_DEFAULTS.computerKeyMaxLen) {
      return {
        ok: false,
        error: `key 超长（> ${AGENT_LIMITS_DEFAULTS.computerKeyMaxLen}）`,
        errorCode: 'INVALID_ARG',
        retryable: false
      };
    }
    // 键名合法性在执行端 parseKeyCombo 判（那里有完整 VK 表与具体报错），
    // 这里只挡明显结构性错误：纯数字坐标等类型错误。
    if (!/^[A-Za-z0-9+]+$/.test(key)) {
      return {
        ok: false,
        error: `key 含非法字符（只支持字母/数字 + 「+」分隔）`,
        errorCode: 'INVALID_ARG',
        retryable: false,
        suggestedFix: '修饰键 win/ctrl/alt/shift，主键如 enter/tab/f1/a/1'
      };
    }
    return { ok: true };
  }
  if (act === 'scroll') {
    if (a.direction != null && !['up', 'down'].includes(String(a.direction))) {
      return {
        ok: false,
        error: `direction 取值 up|down，收到「${a.direction}」`,
        errorCode: 'INVALID_ARG',
        retryable: false
      };
    }
    if (a.amount != null) {
      const n = Number(a.amount);
      if (!Number.isFinite(n) || n < 1 || n > AGENT_LIMITS_DEFAULTS.computerScrollMaxNotches) {
        return {
          ok: false,
          error: `amount 需在 1–${AGENT_LIMITS_DEFAULTS.computerScrollMaxNotches}`,
          errorCode: 'INVALID_ARG',
          retryable: false,
          suggestedFix: '大距离滚动分多次调用，中间看截图调整'
        };
      }
    }
    return { ok: true };
  }
  if (act === 'wait') {
    const n = Number(a.ms);
    if (!Number.isFinite(n) || n < AGENT_LIMITS_DEFAULTS.computerWaitMinMs || n > AGENT_LIMITS_DEFAULTS.computerWaitMaxMs) {
      return {
        ok: false,
        error: `wait 的 ms 需在 ${AGENT_LIMITS_DEFAULTS.computerWaitMinMs}–${AGENT_LIMITS_DEFAULTS.computerWaitMaxMs}`,
        errorCode: 'INVALID_ARG',
        retryable: false
      };
    }
    return { ok: true };
  }
  // screenshot：无附加参数
  return { ok: true };
}


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

/**
 * 必填项只认工具自己声明的 `required`。
 * 这里曾经在 required 缺失时把「唯一属性」当成必填 —— 猜错会把可选参数判成必填，
 * 调用还没到服务器就被打回（例如 postgres 的 list_schemas 只有可选的 database，
 * 合法调用 list_schemas({}) 会报「缺少参数：database」）。缺 required 就不猜，交给服务器判。
 */
function mcpRequiredKeys(schema) {
  if (!schema || typeof schema !== 'object') return [];
  if (!Array.isArray(schema.required)) return [];
  return schema.required.map((k) => String(k)).filter(Boolean);
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
    case 'computer':
      return validateComputerArgs(a);
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
      if (a.fetchTop != null) {
        const n = Number(a.fetchTop);
        if (!Number.isFinite(n) || n < 0 || n > 3) {
          return {
            ok: false,
            error: `fetchTop 超出范围：${a.fetchTop}`,
            errorCode: 'INVALID_ARG',
            retryable: true,
            suggestedFix: 'fetchTop 取 0-3，默认 0（只搜索不抓正文）'
          };
        }
      }
      if (a.page != null) {
        const p = Number(a.page);
        if (!Number.isFinite(p) || p < 1 || p > 10) {
          return {
            ok: false,
            error: `page 超出范围：${a.page}`,
            errorCode: 'INVALID_ARG',
            retryable: true,
            suggestedFix: 'page 从 1 开始，最多 10'
          };
        }
      }
      return { ok: true };
    case 'read_symbol': {
      const hasPath = !!(a.filePath && String(a.filePath).trim());
      const hasName = !!String(a.name || a.symbol || a.symbolName || '').trim();
      const hasLine = Number(a.line) > 0;
      if (!hasPath && !hasName) {
        return {
          ok: false,
          error: 'read_symbol 需要 filePath 或 name',
          errorCode: 'MISSING_ARG',
          retryable: false,
          suggestedFix: 'filePath+name、filePath+line，或只给 name 全库查找'
        };
      }
      // 只给 filePath 定位不到任何符号（符号定位只有「按 name」与「按包含某行的最小符号」
      // 两条路）；在此拦下，避免白跑 LSP/结构索引并回一句不指向病因的 SYMBOL_NOT_FOUND。
      // handler 侧同判，保证 fs.read_symbol 的空 name 分支只可能是「有 line 但该行无符号」。
      if (hasPath && !hasName && !hasLine) {
        return {
          ok: false,
          error: 'read_symbol 只给 filePath 无法定位符号：需要 name 或 line',
          errorCode: 'MISSING_ARG',
          retryable: false,
          suggestedFix: '补 name（读该符号）或补 line（读包含该行的符号）；读整个文件请用 fs_read_file'
        };
      }
      return { ok: true };
    }
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
  validateComputerArgs,
  validateMcpInputArgs,
  isHttpUrl,
  applyPatchUnsupported
};
