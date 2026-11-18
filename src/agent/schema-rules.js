'use strict';

/**
 * 工具参数的条件规则求值（`docs/TOOL-VALIDATE-DECISION.md` 选 A 的落地）
 *
 * 为什么需要它：`lsp` / `worktree` / `host_proc` 的规则是「**某个 action 下才必填**」，
 * JSON Schema 用 `allOf` + `if/then` 表达得了，但得有人会算。以前这段知识只活在
 * `tool-validate.js` 的六处 if 里（schema 对它一无所知，模型也看不到）。
 *
 * 现在：**catalog schema 是唯一出处**，手写校验器与生成的校验器都调这里求值。
 *
 * 支持的子集（够用为止，不做通用 JSON Schema 引擎）：
 *   - 顶层：`required`、`allOf`
 *   - 分支：`if` / `then`、`anyOf`
 *   - 叶子（作用在单个字段上）：`const`、`enum`、`type`、`not`
 *
 * 不做的：`$ref`、`oneOf`、`patternProperties`、`if/else`。加之前先问「catalog 真的需要吗」。
 */

/** 缺字段时的错误码归口（与生成器、手写校验共用一份）。 */
function missingCodeFor(field) {
  const f = String(field || '').toLowerCase();
  if (f.includes('path') || f === 'dir' || f === 'file') return 'MISSING_PATH';
  if (f === 'content' || f === 'text' || f === 'body') return 'MISSING_CONTENT';
  return 'MISSING_ARG';
}

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function typeOk(val, type) {
  if (type === 'array') return Array.isArray(val);
  if (type === 'object') return isPlainObject(val);
  if (type === 'number') return typeof val === 'number' && Number.isFinite(val);
  if (type === 'integer') return typeof val === 'number' && Number.isInteger(val);
  if (type === 'null') return val === null;
  return typeof val === type;
}

/** 字段是否「算给了」（空白字符串算没给，除非字段本身允许空）。 */
const BLANK_OK = new Set(['content', 'text', 'body', 'patch', 'diff', 'command', 'note']);

function present(args, field) {
  const v = args[field];
  if (v === undefined || v === null) return false;
  if (typeof v === 'string' && !v.trim() && !BLANK_OK.has(String(field).toLowerCase())) return false;
  return true;
}

/** 单字段是否满足某个叶子 schema（const / enum / type / not）。 */
function fieldMatches(value, spec) {
  if (!isPlainObject(spec)) return true;
  if (spec.not && fieldMatches(value, spec.not)) return false;
  if (Object.prototype.hasOwnProperty.call(spec, 'const') && value !== spec.const) return false;
  if (Array.isArray(spec.enum) && !spec.enum.includes(value)) return false;
  if (spec.type && !typeOk(value, spec.type)) return false;
  return true;
}

/** 参数是否满足一个「条件/结果」子 schema（`required` + `properties` + `anyOf` / `not`）。 */
function matches(args, schema) {
  if (!isPlainObject(schema)) return true;
  // 子 schema 级的 not / anyOf：跨字段互斥与择一都要用
  if (isPlainObject(schema.not) && matches(args, schema.not)) return false;
  if (Array.isArray(schema.anyOf) && schema.anyOf.length && !schema.anyOf.some((alt) => matches(args, alt))) {
    return false;
  }
  for (const field of Array.isArray(schema.required) ? schema.required : []) {
    if (!present(args, field)) return false;
  }
  const props = isPlainObject(schema.properties) ? schema.properties : {};
  for (const [field, spec] of Object.entries(props)) {
    // 条件判断只看「给了的字段」：没给就不算违反（必填由 required 管）
    if (!present(args, field)) continue;
    if (!fieldMatches(args[field], spec)) return false;
  }
  return true;
}

/** 把 `if` 分支里那句人话拼出来：`operation=workspaceSymbol` / `action 属于 create/preview_run`。 */
function describeCondition(cond) {
  if (!isPlainObject(cond)) return '';
  const props = isPlainObject(cond.properties) ? cond.properties : {};
  const parts = [];
  for (const [field, spec] of Object.entries(props)) {
    if (!isPlainObject(spec)) continue;
    if (Object.prototype.hasOwnProperty.call(spec, 'const')) parts.push(`${field}=${spec.const}`);
    else if (Array.isArray(spec.enum)) parts.push(`${field} 属于 ${spec.enum.join('/')}`);
    else if (isPlainObject(spec.not) && Array.isArray(spec.not.enum)) {
      parts.push(`${field} 不是 ${spec.not.enum.join('/')}`);
    }
  }
  return parts.join(' 且 ');
}

function reject(errorCode, error, field) {
  const out = { ok: false, error, errorCode, retryable: false };
  if (field) out.field = field;
  return out;
}

/** 求值单个分支的 `then`（目前只有 required / anyOf）。 */
function checkThen(toolName, args, then, condText) {
  const when = condText ? `（${condText} 时）` : '';
  for (const field of Array.isArray(then.required) ? then.required : []) {
    if (!present(args, field)) {
      return reject(
        missingCodeFor(field),
        `${toolName} 缺少 ${field}${when}`,
        field
      );
    }
  }
  if (Array.isArray(then.anyOf) && then.anyOf.length) {
    const ok = then.anyOf.some((alt) => matches(args, alt));
    if (!ok) {
      const alts = then.anyOf
        .map((alt) => (Array.isArray(alt.required) ? alt.required.join(' + ') : '?'))
        .join(' 或 ');
      return reject(missingCodeFor(''), `${toolName} 需要 ${alts} 之一${when}`);
    }
  }
  // 互斥：`then.not` 命中即违规（例如「给了 goal 就不许再给 rrule」）
  if (isPlainObject(then.not) && matches(args, then.not)) {
    return reject('INVALID_ARG', `${toolName} 的这组参数互斥${when}`);
  }
  if (isPlainObject(then.properties)) {
    for (const [field, spec] of Object.entries(then.properties)) {
      if (!present(args, field)) continue;
      // 嵌套对象：`required` 作用在内层（`plan_create.goal.objective / .checks`）
      if (isPlainObject(spec) && Array.isArray(spec.required) && spec.required.length) {
        if (!isPlainObject(args[field])) {
          return reject('INVALID_ARG', `${toolName} 的 ${field} 应该是对象${when}`, field);
        }
        for (const inner of spec.required) {
          if (!present(args[field], inner)) {
            return reject(
              missingCodeFor(inner),
              `${toolName} 缺少 ${field}.${inner}${when}`,
              `${field}.${inner}`
            );
          }
        }
        continue;
      }
      if (!fieldMatches(args[field], spec)) {
        return reject('INVALID_ARG', `${toolName} 的 ${field} 取值不合法${when}`, field);
      }
    }
  }
  return { ok: true };
}

/**
 * 按 schema 里的 `allOf` / `if-then` / `anyOf` 求值。
 *
 * @param {string} toolName
 * @param {{ allOf?: any[] }} params 工具的 `parameters`（schema）
 * @param {any} args
 * @returns {{ ok: true } | { ok: false, error: string, errorCode: string, retryable: boolean, field?: string }}
 */
function evaluateRules(toolName, params, args) {
  const a = isPlainObject(args) ? args : {};
  const allOf = isPlainObject(params) && Array.isArray(params.allOf) ? params.allOf : [];
  for (const branch of allOf) {
    if (!isPlainObject(branch)) continue;
    if (isPlainObject(branch.if)) {
      if (!matches(a, branch.if)) continue;
      const then = isPlainObject(branch.then) ? branch.then : null;
      if (!then) continue;
      const res = checkThen(toolName, a, then, describeCondition(branch.if));
      if (!res.ok) return res;
      continue;
    }
    // 无条件的 allOf 分支：`required` 直接算必填
    const res = checkThen(toolName, a, branch, '');
    if (!res.ok) return res;
  }
  // 顶层 anyOf（例如 read_symbol 的三选一）
  if (isPlainObject(params) && Array.isArray(params.anyOf) && params.anyOf.length) {
    const ok = params.anyOf.some((alt) => matches(a, alt));
    if (!ok) {
      const alts = params.anyOf
        .map((alt) => (Array.isArray(alt.required) ? alt.required.join(' + ') : '?'))
        .join(' 或 ');
      return reject(missingCodeFor(''), `${toolName} 需要 ${alts} 之一`);
    }
  }
  return { ok: true };
}

module.exports = { evaluateRules, matches, fieldMatches, missingCodeFor, present, BLANK_OK };
