'use strict';

const { TOOL_NAME_ALIASES } = require('./agent/guardrails-shared');

/**
 * 部分 OpenAI 兼容模型（如 mimo）把 tool call 写在 content 的 XML 里，
 * 而不填充 message.tool_calls，导致 agent loop 提前 finish。
 *
 * 支持格式：
 * 1) <function=host_exec><parameter=command>…
 * 2) <parameter name="host_exec">…</parameter>（mimo 常见）
 * 3) 多个 <tool_call> 连续出现且无 </tool_call> 闭合
 * 4) <tool call>（空格）与 </parameter>、</function> 混用
 * 5) DeepSeek DSML：<tool_calls><invoke name="…">… 或 <｜DSML｜…> 前缀变体
 */

const TOOL_CALL_OPEN_RE = /<tool[\s_]+call>/gi;
const TOOL_CALL_CLOSE_RE = /<\/tool[\s_]+call>/gi;
const DSML_TAG_PREFIX = /<\uff5cDSML\uff5c/gi;
const DSML_TAG_CLOSE_PREFIX = /<\/\uff5cDSML\uff5c/gi;

/** parameter name 等于工具名时视为「工具参数块」 */
const TOOL_PARAM_NAMES = new Set([
  'host_exec',
  'exec',
  'fs_read_file',
  'fs_write_file',
  'fs_edit',
  'fs_list_dir',
  'grep',
  'glob',
  'read_symbol',
  'lsp',
  'web_fetch',
  'web_search',
  'browser_navigate',
  'browser_reload',
  'browser_back',
  'browser_forward',
  'browser_snapshot',
  'browser_click',
  'browser_type',
  'browser_fill',
  'browser_select_option',
  'browser_hover',
  'browser_drag',
  'browser_double_click',
  'browser_right_click',
  'browser_scroll',
  'browser_press_key',
  'browser_screenshot',
  'browser_viewport',
  'browser_pdf',
  'browser_evaluate',
  'browser_wait_for',
  'browser_observe',
  'browser_upload_file',
  'browser_import_storage',
  'browser_export_storage',
  'browser_cookies',
  'browser_dialog',
  'browser_route',
  'browser_emulate',
  'browser_har_export',
  'browser_a11y_snapshot',
  'browser_network',
  'browser_console',
  'browser_expect',
  'browser_visual_diff',
  'browser_status',
  'browser_close',
  'sql_query',
  'sql_list_tables',
  'sql_list_databases'
]);

function genToolCallId(index) {
  return `call_fallback_${Date.now().toString(36)}_${index}`;
}

/** 统一 mimo / DeepSeek DSML 各变体标签，便于分段与剥除 */
function normalizeToolCallMarkup(text) {
  return String(text || '')
    .replace(DSML_TAG_PREFIX, '<')
    .replace(DSML_TAG_CLOSE_PREFIX, '</')
    .replace(/<tool[\s_]+calls>/gi, '<tool_calls>')
    .replace(/<\/tool[\s_]+calls>/gi, '</tool_calls>')
    .replace(TOOL_CALL_OPEN_RE, '<tool_call>')
    .replace(TOOL_CALL_CLOSE_RE, '</tool_call>')
    .replace(/<\/function\s*>/gi, '')
    .replace(/<function\s*>/gi, '');
}

function trimParameterBody(raw) {
  return String(raw || '')
    .replace(/<\/parameter>\s*$/i, '')
    .replace(/<\/function>\s*$/i, '')
    .trim();
}

function normalizeToolName(name) {
  const raw = String(name || '').trim();
  if (!raw) return '';
  return TOOL_NAME_ALIASES[raw.toLowerCase()] || raw;
}

function isToolParameterName(name) {
  const n = normalizeToolName(name);
  return TOOL_PARAM_NAMES.has(n) || TOOL_PARAM_NAMES.has(name);
}

function readAttr(tag, attr) {
  const re = new RegExp(`\\b${attr}="([^"]*)"`, 'i');
  const m = tag.match(re);
  return m ? m[1] : '';
}

function normalizeHostExecArgs(name, args) {
  const n = normalizeToolName(name);
  const out = { ...args };
  if (n !== 'host_exec') return out;
  if (out.command) return out;
  if (out.host_exec) {
    out.command = out.host_exec;
    delete out.host_exec;
    return out;
  }
  if (out.exec) {
    out.command = out.exec;
    delete out.exec;
    return out;
  }
  const keys = Object.keys(out).filter((k) => k !== 'timeoutMs' && k !== 'timeout');
  if (keys.length === 1 && typeof out[keys[0]] === 'string') {
    out.command = out[keys[0]];
    delete out[keys[0]];
  }
  if (out.timeout != null && out.timeoutMs == null) {
    const t = Number(out.timeout);
    if (Number.isFinite(t)) out.timeoutMs = t;
    delete out.timeout;
  }
  return out;
}

function parseJsonToolCallBlock(inner) {
  const trimmed = String(inner || '').trim();
  if (!trimmed.startsWith('{')) return null;
  try {
    const obj = JSON.parse(trimmed);
    const name = normalizeToolName(obj.name || obj.function || obj.tool);
    if (!name) return null;
    const args = obj.arguments || obj.parameters || obj.args || {};
    return {
      name,
      arguments: normalizeHostExecArgs(name, args && typeof args === 'object' ? args : {})
    };
  } catch {
    return null;
  }
}

/** mimo: <parameter name="host_exec" string="true">cmd</parameter> */
function parseNamedParameterToolCallBlock(block) {
  const text = String(block || '');
  if (!/<parameter\s+name="/i.test(text)) return null;

  let toolName = '';
  const args = {};

  const openRe = /<parameter\s+name="([^"]+)"([^>]*)>([\s\S]*?)<\/parameter>/gi;
  let m;
  while ((m = openRe.exec(text)) !== null) {
    const pname = m[1].trim();
    const body = m[3].trim();
    const norm = normalizeToolName(pname);
    if (isToolParameterName(pname)) {
      toolName = norm;
      args.command = body;
    } else if (pname === 'timeout' || pname === 'timeoutMs') {
      const n = Number(body || readAttr(m[2], 'value'));
      if (Number.isFinite(n)) args.timeoutMs = n;
    } else if (body) {
      args[pname] = body;
    }
  }

  const selfRe = /<parameter\s+name="([^"]+)"([^>]*)\/\s*>/gi;
  while ((m = selfRe.exec(text)) !== null) {
    const pname = m[1].trim();
    const val = readAttr(m[0], 'value') || readAttr(m[2], 'value');
    if ((pname === 'timeout' || pname === 'timeoutMs') && val) {
      const n = Number(val);
      if (Number.isFinite(n)) args.timeoutMs = n;
    } else if (isToolParameterName(pname) && val && !toolName) {
      toolName = normalizeToolName(pname);
      args.command = val;
    }
  }

  if (!toolName) return null;
  return { name: toolName, arguments: normalizeHostExecArgs(toolName, args) };
}

function parseXmlToolCallBlock(block) {
  const fnMatch = block.match(/<function=([^>\n/]+)\s*\/?>/i);
  if (!fnMatch) return null;
  const name = normalizeToolName(fnMatch[1].trim());
  const args = {};

  const paramRe =
    /<parameter=([^>\n/]+)\s*\/?>([\s\S]*?)(?=<\/parameter>|<parameter=|<\/tool_call>|<tool_call>|<function=|<\/function>|$)/gi;
  let pm;
  while ((pm = paramRe.exec(block)) !== null) {
    args[pm[1].trim()] = trimParameterBody(pm[2]);
  }

  if (!Object.keys(args).length) {
    const body = block
      .replace(/<\/?tool_call>/gi, '')
      .replace(/<function=[^>]+>\s*/i, '')
      .trim();
    if (body && !body.includes('<')) {
      args.command = body;
    }
  }

  return { name, arguments: normalizeHostExecArgs(name, args) };
}

function parseToolCallBlock(block) {
  const inner = String(block || '')
    .replace(/^[\s\S]*?<tool_call>/i, '')
    .replace(/<\/tool_call>[\s\S]*$/i, '');
  return (
    parseJsonToolCallBlock(inner) ||
    parseNamedParameterToolCallBlock(block) ||
    parseXmlToolCallBlock(block) ||
    parseInvokeToolCallBlock(block)
  );
}

/** DeepSeek：<invoke name="host_exec"><parameter name="command">…</invoke> */
function parseInvokeInnerParameters(toolName, inner) {
  const args = {};
  const text = String(inner || '');
  const openRe = /<parameter\s+name="([^"]+)"([^>]*)>([\s\S]*?)<\/parameter>/gi;
  let m;
  while ((m = openRe.exec(text)) !== null) {
    const pname = m[1].trim();
    const body = m[3].trim();
    if (pname === 'timeout' || pname === 'timeoutMs') {
      const n = Number(body || readAttr(m[2], 'value'));
      if (Number.isFinite(n)) args.timeoutMs = n;
    } else if (body) {
      args[pname] = body;
    }
  }
  const selfRe = /<parameter\s+name="([^"]+)"([^>]*)\/\s*>/gi;
  while ((m = selfRe.exec(text)) !== null) {
    const pname = m[1].trim();
    const val = readAttr(m[0], 'value') || readAttr(m[2], 'value');
    if ((pname === 'timeout' || pname === 'timeoutMs') && val) {
      const n = Number(val);
      if (Number.isFinite(n)) args.timeoutMs = n;
    } else if (val) {
      args[pname] = val;
    }
  }
  return normalizeHostExecArgs(toolName, args);
}

function parseInvokeToolCallBlock(block) {
  const text = String(block || '');
  const openRe = /<invoke\s+name="([^"]+)"([^>]*)>([\s\S]*?)(?:<\/invoke>|$)/i;
  const m = text.match(openRe);
  if (!m) return null;

  const name = normalizeToolName(m[1]);
  const inner = m[3] || '';
  const args = parseInvokeInnerParameters(name, inner);
  if (Object.keys(args).length) {
    return { name, arguments: args };
  }

  const paramParsed = parseNamedParameterToolCallBlock(`<wrap>${inner}</wrap>`);
  if (paramParsed && paramParsed.name) {
    return { name: paramParsed.name, arguments: paramParsed.arguments };
  }

  const xmlParsed = parseXmlToolCallBlock(inner);
  if (xmlParsed && xmlParsed.name) return xmlParsed;

  const flat = inner.replace(/<[^>]+>/g, '').trim();
  if (flat) {
    return { name, arguments: normalizeHostExecArgs(name, { command: flat }) };
  }
  if (name) {
    return { name, arguments: normalizeHostExecArgs(name, {}) };
  }
  return null;
}

function extractInvokeToolCalls(text) {
  const normalized = normalizeToolCallMarkup(text);
  if (!/<invoke\s+name="/i.test(normalized) && !/<tool_calls>/i.test(normalized)) {
    return [];
  }

  const toolCalls = [];
  const seen = new Set();
  const body = normalized.replace(/<\/?tool_calls>/gi, '\n');
  const invokeRe = /<invoke\s+name="([^"]+)"[^>]*>[\s\S]*?(?=<\/invoke>|(?=<invoke\s+name=)|$)/gi;
  let m;
  while ((m = invokeRe.exec(body)) !== null) {
    const parsed = parseInvokeToolCallBlock(m[0]);
    if (!parsed || !parsed.name) continue;
    const hasArgs = parsed.arguments && Object.keys(parsed.arguments).length > 0;
    if (!hasArgs && !/<\/invoke>/i.test(m[0])) continue;
    const key = `${parsed.name}\0${JSON.stringify(parsed.arguments || {})}`;
    if (seen.has(key)) continue;
    seen.add(key);
    toolCalls.push({
      id: genToolCallId(toolCalls.length),
      name: parsed.name,
      arguments: parsed.arguments || {}
    });
  }
  return toolCalls;
}

function splitToolCallSegments(text) {
  const normalized = normalizeToolCallMarkup(text);
  const segments = [];
  const re = /<tool_call>/gi;
  let match;
  let lastIndex = 0;
  while ((match = re.exec(normalized)) !== null) {
    if (match.index > lastIndex) {
      const between = normalized.slice(lastIndex, match.index);
      if (between.trim()) segments.push(between);
    }
    const start = match.index;
    const next = re.exec(normalized);
    if (next) {
      re.lastIndex = next.index;
      segments.push(normalized.slice(start, next.index));
      lastIndex = next.index;
    } else {
      segments.push(normalized.slice(start));
      lastIndex = normalized.length;
      break;
    }
  }
  if (!segments.length) {
    if (/<function=/i.test(normalized)) segments.push(`<tool_call>${normalized}`);
    else if (/<parameter\s+name="/i.test(normalized)) segments.push(`<tool_call>${normalized}`);
  }
  return segments.filter((s) => /<tool_call>/i.test(s) || /<function=/i.test(s) || /<parameter\s+name="/i.test(s));
}

function extractToolCallsFromContent(content) {
  const text = normalizeToolCallMarkup(content);
  if (!text) return [];

  const invokeCalls = extractInvokeToolCalls(text);
  if (invokeCalls.length) return invokeCalls;

  const toolCalls = [];
  const seen = new Set();

  for (const segment of splitToolCallSegments(text)) {
    const block = /<tool_call>/i.test(segment) ? segment : `<tool_call>${segment}`;
    const parsed = parseToolCallBlock(block);
    if (!parsed || !parsed.name) continue;
    const key = `${parsed.name}\0${JSON.stringify(parsed.arguments || {})}`;
    if (seen.has(key)) continue;
    seen.add(key);
    toolCalls.push({
      id: genToolCallId(toolCalls.length),
      name: parsed.name,
      arguments: parsed.arguments || {}
    });
  }

  if (!toolCalls.length) {
    const blockRe = /<tool_call>([\s\S]*?)<\/tool_call>/gi;
    let m;
    while ((m = blockRe.exec(text)) !== null) {
      const parsed = parseToolCallBlock(m[0]);
      if (!parsed || !parsed.name) continue;
      toolCalls.push({
        id: genToolCallId(toolCalls.length),
        name: parsed.name,
        arguments: parsed.arguments || {}
      });
    }
  }

  return toolCalls;
}

function stripToolCallMarkup(content) {
  const text = normalizeToolCallMarkup(content);
  return text
    .replace(/<tool_calls>[\s\S]*?(?=<tool_calls>|$)/gi, '')
    .replace(/<\/tool_calls>/gi, '')
    .replace(/<invoke\s+name="[^"]+"[^>]*>[\s\S]*?(?=<invoke\s+name=|<\/tool_calls>|$)/gi, '')
    .replace(/<\/invoke>/gi, '')
    .replace(/<invoke\s+name="[^"]+"[^>]*\/?>/gi, '')
    .replace(/<tool_call>[\s\S]*?(?=<tool_call>|$)/gi, '')
    .replace(/<\/tool_call>/gi, '')
    .replace(/<function=[^>\n/]+>\s*/gi, '')
    .replace(/<\/function\s*>/gi, '')
    .replace(/<parameter\s+name="[^"]+"[^>]*>[\s\S]*?<\/parameter>/gi, '')
    .replace(/<parameter\s+name="[^"]+"[^>]*\/\s*>/gi, '')
    .replace(/<parameter=[^>\n/]+>[\s\S]*?<\/parameter>/gi, '')
    .replace(/<parameter=[^>\n/]+>[\s\S]*?(?=<parameter=|<function=|<tool_call>|<invoke|<\/tool_calls>|$)/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function hasToolCallMarkupHint(text) {
  const normalized = normalizeToolCallMarkup(text);
  if (!normalized) return false;
  return (
    /<tool_call>/i.test(normalized) ||
    /<tool_calls>/i.test(normalized) ||
    /<invoke\s+name="/i.test(normalized) ||
    /<function=/i.test(normalized) ||
    /<parameter\s+name="/i.test(normalized)
  );
}

function hasIncompleteToolCallMarkup(content) {
  const text = normalizeToolCallMarkup(content);
  if (!text) return false;
  if (hasToolCallMarkupHint(text)) {
    return extractToolCallsFromContent(text).length === 0;
  }
  return false;
}

function enrichLlmToolCalls(llmResp) {
  const base = llmResp || {};
  let content = base.content != null ? String(base.content) : '';
  let toolCalls = Array.isArray(base.toolCalls) ? base.toolCalls.slice() : [];
  const incomingCount = toolCalls.length;

  toolCalls = filterCompleteFunctionToolCalls(toolCalls);
  if (!toolCalls.length) {
    toolCalls = filterCompleteFunctionToolCalls(extractToolCallsFromContent(content));
  }

  const incompleteToolMarkup = !toolCalls.length && hasIncompleteToolCallMarkup(content);
  if (toolCalls.length) {
    content = stripToolCallMarkup(content);
  }

  return {
    ...base,
    content,
    toolCalls,
    incompleteToolMarkup,
    incompleteJsonToolCalls: !!(
      !toolCalls.length &&
      !incompleteToolMarkup &&
      (base.incompleteJsonToolCalls || incomingCount > 0)
    )
  };
}

function parseCompleteJsonArgs(raw) {
  const json = normalizeCompleteToolCallArgumentsJson(raw);
  if (json == null) return null;
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

function normalizeCompleteToolCallArgumentsJson(raw) {
  if (raw == null) return '{}';
  if (typeof raw === 'object') {
    try {
      return JSON.stringify(raw);
    } catch {
      return null;
    }
  }
  const text = String(raw).trim();
  if (!text) return '{}';
  try {
    return JSON.stringify(JSON.parse(text));
  } catch {
    return null;
  }
}

/**
 * Drop tool_calls whose name is missing or arguments are not complete JSON.
 * Fail-closed: truncated `{"path":"/foo` must not become `{}`.
 */
function filterCompleteFunctionToolCalls(toolCalls) {
  if (!Array.isArray(toolCalls)) return [];
  const out = [];
  for (const tc of toolCalls) {
    if (!tc || typeof tc !== 'object') continue;
    const fn = tc.function;
    const name = String((fn && fn.name) || tc.name || '').trim();
    if (!name) continue;
    const rawArgs = fn ? fn.arguments : tc.arguments;
    const argsJson = normalizeCompleteToolCallArgumentsJson(rawArgs);
    if (argsJson == null) continue;
    if (fn) {
      out.push({
        ...tc,
        function: { ...fn, name, arguments: argsJson }
      });
    } else {
      let parsed;
      try {
        parsed = JSON.parse(argsJson);
      } catch {
        continue;
      }
      out.push({ ...tc, name, arguments: parsed });
    }
  }
  return out;
}

module.exports = {
  enrichLlmToolCalls,
  extractToolCallsFromContent,
  stripToolCallMarkup,
  normalizeToolCallMarkup,
  hasIncompleteToolCallMarkup,
  normalizeToolName,
  parseNamedParameterToolCallBlock,
  parseInvokeToolCallBlock,
  extractInvokeToolCalls,
  parseCompleteJsonArgs,
  normalizeCompleteToolCallArgumentsJson,
  filterCompleteFunctionToolCalls
};
