'use strict';

const { validateShellCommand } = require('../gateway/exec-policy');
const { GRAPH_LEGACY_OPS, GRAPH_OPERATIONS, fsEditArgsPresent } = require('./guardrails-shared');
// 数字护栏单一来源（AGENTS.md §6）：computer 输入长度上限只改 agent-limits。
const { AGENT_LIMITS_DEFAULTS } = require('./agent-limits');
// 修饰键/键名的单一来源是注入层（VK 表在那里），这里只引用不复制。
const { MODIFIER_NAMES } = require('../computer/win32-input');
// 动作枚举的单一来源（性质声明在 computer/actions.js，任何新增动作只改那一处）。
const {
  COMPUTER_ACTIONS_TEXT,
  MODIFIER_ACTIONS,
  REGION_ACTIONS,
  actionMeta
} = require('../computer/actions');
// 「是不是 MCP 服务注册的工具」唯一判定（mcp_manage / mcp_tool_schema 例外）
const { isMcpServerToolName } = require('../mcp/tool-name');
// mcp_manage 的动作清单唯一来源（与 schema enum / apply() 分派同源，不在这里另抄一份）
const { MCP_MANAGE_ACTIONS } = require('../mcp/manage');

const MCP_MANAGE_REMOTE_TRANSPORTS = ['remote', 'streamable-http', 'http'];

/** 校验 [x, y] 坐标：二元数值数组（像素坐标，允许小数/越界由执行端钳制）。 */
function computerPointOk(v) {
  return (
    Array.isArray(v) &&
    v.length === 2 &&
    Number.isFinite(Number(v[0])) &&
    Number.isFinite(Number(v[1]))
  );
}

/** computer 参数形状错误的统一信封（避免重复写五个字段）。 */
function computerArgError(error, suggestedFix) {
  return {
    ok: false,
    error,
    errorCode: 'INVALID_ARG',
    retryable: false,
    ...(suggestedFix ? { suggestedFix } : {})
  };
}

/**
 * 修饰键 / region 的**归属**校验：静默忽略比报错更难查 ——
 * 拼错的 `shfit` 会变成「按普通点击执行」，`region` 挂在 click 上会让模型的坐标凭空错位。
 */
function validateComputerExtras(args) {
  if (args.modifiers != null) {
    if (MODIFIER_ACTIONS.has(args.action)) {
      if (!Array.isArray(args.modifiers)) {
        return computerArgError('modifiers 必须是字符串数组', `例：modifiers=["shift"]（可选 ${MODIFIER_NAMES.join(' / ')}）`);
      }
      const bad = args.modifiers
        .map((n) => String(n == null ? '' : n).trim().toLowerCase())
        .filter((n) => n && !MODIFIER_NAMES.includes(n));
      if (bad.length) {
        return computerArgError(
          `不支持的修饰键「${bad.join('、')}」`,
          `modifiers 只支持：${MODIFIER_NAMES.join(' / ')}`
        );
      }
    } else {
      return computerArgError(
        `modifiers 只用于点击与拖拽（收到 ${args.action}）`,
        '需要按住修饰键的组合操作用 action=key（如 "ctrl+v"）；区间选择/多选用 click + modifiers'
      );
    }
  }
  if (args.region != null) {
    if (!REGION_ACTIONS.has(args.action)) {
      return computerArgError(
        `region 只用于 action=screenshot（收到 ${args.action}）`,
        '要看局部细节：先 screenshot + region 裁出来，再按该区域的坐标操作'
      );
    }
    const r = args.region;
    if (!Array.isArray(r) || r.length !== 4 || !r.every((n) => Number.isFinite(Number(n)))) {
      return computerArgError('region 必须是 [x, y, 宽, 高] 四个数字', '例：region=[100, 80, 600, 400]');
    }
    if (Number(r[2]) <= 0 || Number(r[3]) <= 0) {
      return computerArgError(`region 的宽高必须大于 0（收到 ${r[2]}×${r[3]}）`, 'region=[x, y, 宽, 高]');
    }
  }
  return null;
}

/**
 * computer 工具参数校验（形状与枚举；档位/审批在 gateway，坐标换算在 computer/service）。
 */
function validateComputerArgs(a) {
  const act = String(a.action || '');
  const meta = actionMeta(act);
  if (!meta) {
    return {
      ok: false,
      error: `computer 未知动作「${act}」`,
      errorCode: 'INVALID_ACTION',
      retryable: false,
      suggestedFix: `action 取值：${COMPUTER_ACTIONS_TEXT}`
    };
  }
  const extras = validateComputerExtras({ ...a, action: act });
  if (extras) return extras;

  // 坐标按动作性质判（性质声明在 computer/actions.js，不在这里再列一遍动作名）
  if (meta.coordinate === 'required' && !computerPointOk(a.coordinate)) {
    // move/drag 必须给坐标（没有「移到当前光标」的语义）；click 家族可省略=在当前位置点
    return {
      ok: false,
      error: `computer ${act} 需要 coordinate（[x, y] 截图像素坐标）`,
      errorCode: 'MISSING_ARG',
      retryable: false,
      suggestedFix: '先 action=screenshot 看画面，再按截图里的像素位置传 coordinate'
    };
  }
  if (meta.coordinate === 'optional' && a.coordinate != null && !computerPointOk(a.coordinate)) {
    return {
      ok: false,
      error: 'coordinate 必须是 [x, y] 两个数字',
      errorCode: 'INVALID_ARG',
      retryable: false
    };
  }
  if (meta.click || act === 'drag') {
    if (act === 'drag' && !computerPointOk(a.to)) {
      return {
        ok: false,
        error: 'computer drag 需要 to（终点 [x, y]）',
        errorCode: 'MISSING_ARG',
        retryable: false
      };
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
  if (act === 'wait_until') {
    const cond = String(a.condition == null ? 'changed' : a.condition);
    if (!['changed', 'stable'].includes(cond)) {
      return computerArgError(
        `wait_until 的 condition 取值 changed|stable，收到「${a.condition}」`,
        'condition=changed 等画面发生变化；condition=stable 等界面不再变化'
      );
    }
    if (a.ms != null) {
      const n = Number(a.ms);
      if (!Number.isFinite(n) || n <= 0 || n > AGENT_LIMITS_DEFAULTS.computerWaitUntilMaxMs) {
        return computerArgError(
          `wait_until 的 ms 需在 1–${AGENT_LIMITS_DEFAULTS.computerWaitUntilMaxMs}`,
          'ms 是等不到就放弃的超时上限，不传则用默认值'
        );
      }
    }
    return { ok: true };
  }
  if (act === 'activate_window') {
    const h = Number(a.handle);
    if (!Number.isFinite(h) || h <= 0) {
      return {
        ok: false,
        error: 'computer activate_window 需要 handle（list_windows 返回的窗口句柄）',
        errorCode: 'MISSING_ARG',
        retryable: false,
        suggestedFix: '先 action=list_windows 看有哪些窗口，再用它返回的 handle 激活'
      };
    }
    return { ok: true };
  }
  // screenshot / list_windows：region 已在 validateComputerExtras 里校验，这里没有别的参数
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
    case 'skill_delete': {
      const dir = String(a.dir || '').trim();
      if (!dir) {
        return {
          ok: false,
          error: 'skill_delete 需要 dir（技能目录绝对路径）',
          errorCode: 'MISSING_ARG',
          retryable: false
        };
      }
      // 只接受绝对路径：相对路径由「当前工作空间」解释，删错目录的代价太大
      if (!/^([a-zA-Z]:[\\/]|\\\\|\/)/.test(dir)) {
        return {
          ok: false,
          error: 'skill_delete 的 dir 必须是绝对路径',
          errorCode: 'INVALID_ARG',
          retryable: false
        };
      }
      return { ok: true };
    }
    case 'worktree': {
      const action = String(a.action || 'list').trim();
      const allowed = ['list', 'create', 'remove', 'list_runs', 'preview_run', 'apply_run', 'cleanup_run', 'prune'];
      if (!allowed.includes(action)) {
        return {
          ok: false,
          error: `worktree 的 action 必须是 ${allowed.join(' / ')}（收到「${action || '空'}」）`,
          errorCode: 'INVALID_ARG',
          retryable: false
        };
      }
      if (['create', 'preview_run', 'apply_run', 'cleanup_run'].includes(action) && !String(a.runId || '').trim()) {
        return {
          ok: false,
          error: `worktree ${action} 需要 runId`,
          errorCode: 'MISSING_ARG',
          retryable: false
        };
      }
      if (action === 'remove' && !String(a.path || '').trim()) {
        return {
          ok: false,
          error: 'worktree remove 需要 path（先用 action=list 取）',
          errorCode: 'MISSING_ARG',
          retryable: false
        };
      }
      return { ok: true };
    }
    case 'ssh': {
      // 只挡「明显缺东西」与「模型不该自己决定的」两件事；连接细节（别名/凭据/指纹）由
      // src/ssh/actions.js + connect-payload 统一处理。
      const action = String(a.action || 'status').trim();
      const allowed = ['list', 'status', 'connect', 'disconnect', 'port_forward', 'use_workspace', 'browse', 'home'];
      if (!allowed.includes(action)) {
        return {
          ok: false,
          error: `ssh 的 action 必须是 ${allowed.join(' / ')}（收到「${action || '空'}」）`,
          errorCode: 'INVALID_ARG',
          retryable: false
        };
      }
      // 明文密钥一律不许经模型传递：密码/口令只能来自本机凭据库
      if (a.password != null || a.passphrase != null) {
        return {
          ok: false,
          error: 'ssh 不接受明文密码/口令参数：让用户在「连接」面板保存一次凭据后重试',
          errorCode: 'INVALID_ARG',
          retryable: false
        };
      }
      if (action === 'connect' && !String(a.profile || a.host || '').trim()) {
        return {
          ok: false,
          error: 'ssh connect 需要 profile（~/.ssh/config 别名）或 host',
          errorCode: 'MISSING_ARG',
          retryable: false,
          suggestedFix: '先 action=list 看有哪些别名可用'
        };
      }
      if (action === 'use_workspace' && !String(a.remotePath || '').trim()) {
        return {
          ok: false,
          error: 'ssh use_workspace 需要 remotePath',
          errorCode: 'MISSING_ARG',
          retryable: false
        };
      }
      if (action === 'port_forward') {
        const sub = String(a.forwardAction || 'list').trim();
        if (!['list', 'add', 'remove'].includes(sub)) {
          return {
            ok: false,
            error: 'ssh port_forward 的 forwardAction 必须是 list / add / remove',
            errorCode: 'INVALID_ARG',
            retryable: false
          };
        }
        if (sub === 'add' && !(Number(a.remotePort) > 0)) {
          return {
            ok: false,
            error: 'ssh port_forward add 需要 remotePort',
            errorCode: 'MISSING_ARG',
            retryable: false
          };
        }
        if (sub === 'remove' && !String(a.id || '').trim()) {
          return {
            ok: false,
            error: 'ssh port_forward remove 需要 id（先用 forwardAction=list 取）',
            errorCode: 'MISSING_ARG',
            retryable: false
          };
        }
      }
      return { ok: true };
    }
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
            'graph.operation 必须是 find_symbol / module_deps / callers / callees / impact / lsp_callers',
          errorCode: 'MISSING_ARG',
          retryable: false
        };
      }
      if (op === 'find_symbol' && !String(a.query || '').trim()) {
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
    case 'mcp_manage': {
      // 动作枚举的唯一来源是 mcp/manage.js 的 MCP_MANAGE_ACTIONS（apply() 按它分派）；
      // 这里只挡「明显缺东西」的调用，真正的取舍（id 规则 / 白名单 / 是否已配置）在 store 里。
      const action = String(a.action || '').trim();
      if (!MCP_MANAGE_ACTIONS.includes(action)) {
        return {
          ok: false,
          error: `mcp_manage 的 action 必须是 ${MCP_MANAGE_ACTIONS.join(' / ')}（收到「${action || '空'}」）`,
          errorCode: 'INVALID_ARG',
          retryable: false
        };
      }
      // 包运维里只有 repair_env 不需要 id（它修的是整机环境，不是某个服务）
      if (action === 'repair_env') {
        const kind = String(a.repairKind || '').trim();
        if (!['windows-vctools', 'npm-cache-busy'].includes(kind)) {
          return {
            ok: false,
            error: 'mcp_manage repair_env 需要 repairKind（windows-vctools / npm-cache-busy）',
            errorCode: 'MISSING_ARG',
            retryable: false
          };
        }
        return { ok: true };
      }
      if (action === 'list') return { ok: true };
      if (!String(a.id || '').trim()) {
        return {
          ok: false,
          error: `mcp_manage ${action} 需要 id`,
          errorCode: 'MISSING_ARG',
          retryable: false
        };
      }
      if (action === 'add' && !String(a.name || '').trim()) {
        return {
          ok: false,
          error: 'mcp_manage add 需要 name（显示名）',
          errorCode: 'MISSING_ARG',
          retryable: false
        };
      }
      if (action === 'add' || action === 'update') {
        const transport = String(a.transport || '').trim();
        const remote =
          MCP_MANAGE_REMOTE_TRANSPORTS.includes(transport) || (!transport && !!String(a.url || '').trim());
        if (action === 'add') {
          if (remote && !String(a.url || '').trim()) {
            return {
              ok: false,
              error: 'mcp_manage add 远端服务需要 url',
              errorCode: 'MISSING_ARG',
              retryable: false
            };
          }
          if (!remote && !String(a.command || '').trim()) {
            return {
              ok: false,
              error: 'mcp_manage add 本地服务需要 command（远端 HTTP 服务请改给 url）',
              errorCode: 'MISSING_ARG',
              retryable: false
            };
          }
        }
        if (
          action === 'update' &&
          a.url == null &&
          a.command == null &&
          a.args == null &&
          a.token == null &&
          a.env == null &&
          a.name == null &&
          a.description == null &&
          a.authHeaderName == null
        ) {
          return {
            ok: false,
            error: 'mcp_manage update 至少要给一项要改的内容（url / command / args / token / env / name）',
            errorCode: 'MISSING_ARG',
            retryable: false
          };
        }
      }
      return { ok: true };
    }
    case 'goal_check': {
      // 目标型计划的一轮里跑一条检查命令。命令可以来自声明清单（check_id）或模型当场给。
      const command = String(a.command || '').trim();
      const checkId = String(a.check_id || a.checkId || '').trim();
      if (!command && !checkId) {
        return {
          ok: false,
          error: 'goal_check 需要 command（要跑的检查命令）或 check_id（已声明的检查）',
          errorCode: 'MISSING_ARG',
          retryable: false
        };
      }
      return { ok: true };
    }
    case 'goal_finish': {
      const outcome = String(a.outcome || '').trim();
      if (outcome !== 'complete' && outcome !== 'blocked') {
        return {
          ok: false,
          error: `goal_finish 的 outcome 必须是 complete 或 blocked（收到「${outcome || '空'}」）`,
          errorCode: 'INVALID_ARG',
          retryable: false
        };
      }
      return { ok: true };
    }
    case 'mcp_tool_schema': {
      // 两种模式二选一：agentName 查已知道具的完整 schema，query 在全部已启用服务里检索。
      const agentName = String(a.agentName || '').trim();
      const query = String(a.query || '').trim();
      if (!agentName && !query) {
        return {
          ok: false,
          error: 'mcp_tool_schema 需要 agentName（按名查 schema）或 query（检索没有出现在工具列表里的 MCP 工具）',
          errorCode: 'MISSING_ARG',
          retryable: false
        };
      }
      return { ok: true };
    }
    default:
      if (isMcpServerToolName(n)) {
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
  applyPatchUnsupported
};
