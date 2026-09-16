'use strict';

/**
 * 符号定位的纯文本工具。
 *
 * 供「SSH 降级兜底」共用：远程没有 Language Server / 结构索引时，
 * 用 grep 找定义行、再用启发式推断符号体范围。这些函数不依赖运行时上下文，便于单测。
 */

/** GNU grep BRE 安全转义（BRE 里仅这些是元字符） */
function breEscape(s) {
  return String(s).replace(/[.*^$[\]\\]/g, '\\$&');
}

const ID_CHAR = /[A-Za-z0-9_$]/;

/** 提取行首标识符时要跳过的关键字，避免把 `export`/`function` 当成符号名 */
const CODE_KEYWORDS = new Set([
  'export',
  'default',
  'async',
  'await',
  'function',
  'class',
  'interface',
  'struct',
  'enum',
  'trait',
  'impl',
  'type',
  'namespace',
  'module',
  'package',
  'public',
  'private',
  'protected',
  'internal',
  'static',
  'final',
  'abstract',
  'const',
  'let',
  'var',
  'def',
  'fn',
  'func',
  'sub',
  'return',
  'import',
  'from',
  'use',
  'mod',
  'pub',
  'declare',
  'override',
  'virtual',
  'template',
  'typename',
  'using'
]);

/** 行内是否「像定义」（定义类查询用它给候选排序） */
const DEFLIKE_RE =
  /(^|[^\w$])(function|class|interface|struct|enum|trait|impl|def|fn|func|sub|const|let|var|type|module|namespace|export|public|private|protected|static)\b/;

/** 「定义关键字 + 空格 + 名字」的 BRE 形式，直接喂给 grep（documentSymbol 降级用） */
const DEF_KEYWORD_BRE =
  '\\(function\\|class\\|interface\\|struct\\|enum\\|trait\\|impl\\|def\\|fn\\|func\\|const\\|let\\|var\\|type\\|namespace\\|module\\)[[:space:]]\\+[A-Za-z_$]';

/** 从定义行提取 keyword 与 name */
const DEF_NAME_RE =
  /\b(function|class|interface|struct|enum|trait|impl|def|fn|func|const|let|var|type|namespace|module)\s+([A-Za-z_$][\w$]*)/;

/** 关键字 → 粗粒度符号类型（与 LSP SymbolKind 命名的常用部分对齐） */
const KIND_BY_KEYWORD = {
  function: 'function',
  func: 'function',
  fn: 'function',
  def: 'function',
  class: 'class',
  interface: 'interface',
  struct: 'struct',
  enum: 'enum',
  trait: 'interface',
  impl: 'class',
  const: 'constant',
  let: 'variable',
  var: 'variable',
  type: 'typeParameter',
  namespace: 'namespace',
  module: 'module'
};

/** 取光标（0-based 列）处的标识符；落空则回退到行内第一个非关键字标识符 */
function identifierAt(line, idx0) {
  const text = String(line || '');
  if (!text) return '';
  let i = Math.max(0, Math.min(text.length - 1, idx0));
  if (!ID_CHAR.test(text[i])) {
    if (i > 0 && ID_CHAR.test(text[i - 1])) {
      i -= 1;
    } else {
      return firstIdentifier(text);
    }
  }
  let s = i;
  while (s > 0 && ID_CHAR.test(text[s - 1])) s -= 1;
  let e = i;
  while (e + 1 < text.length && ID_CHAR.test(text[e + 1])) e += 1;
  const word = text.slice(s, e + 1);
  return /^\d+$/.test(word) ? '' : word;
}

/** 行内第一个非关键字标识符（去掉注释/字符串噪声后） */
function firstIdentifier(line) {
  const re = /[A-Za-z_$][A-Za-z0-9_$]*/g;
  const text = stripCodeNoise(String(line || ''));
  let m;
  while ((m = re.exec(text))) {
    if (!CODE_KEYWORDS.has(m[0])) return m[0];
  }
  return '';
}

/** 去掉行内字符串与行注释，避免花括号配平被字面量干扰 */
function stripCodeNoise(line) {
  let out = '';
  let quote = null;
  const text = String(line || '');
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === '\\') {
        i += 1;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      continue;
    }
    if (ch === '/' && text[i + 1] === '/') break;
    out += ch;
  }
  return out;
}

/**
 * 从 startLine 起启发式推断符号体结束行（1-based，含）。
 * 花括号配平优先（C-like）；无花括号时用缩进回退（Python 等）。
 * 推断不出就返回 startLine —— 宁少读不多读。
 */
function inferBlockEnd(lines, startLine, cap) {
  const idx = Math.max(0, startLine - 1);
  if (idx >= lines.length) return startLine;
  const first = String(lines[idx] ?? '');
  const baseIndent = (first.match(/^[ \t]*/) || [''])[0].length;
  const limit = Math.min(lines.length, idx + Math.max(1, Number(cap) || 400));
  let brace = 0;
  let sawBrace = false;
  for (let i = idx; i < limit; i++) {
    const raw = String(lines[i] ?? '');
    for (const ch of stripCodeNoise(raw)) {
      if (ch === '{') {
        brace += 1;
        sawBrace = true;
      } else if (ch === '}') {
        brace -= 1;
      }
    }
    if (sawBrace && brace <= 0) return i + 1;
    if (!sawBrace && i > idx) {
      const trimmed = raw.trim();
      if (!trimmed) continue;
      const indent = (raw.match(/^[ \t]*/) || [''])[0].length;
      if (indent <= baseIndent) {
        // 回到上一非空行：中间的空行不属于符号体
        let last = i - 1;
        while (last > idx && !String(lines[last] ?? '').trim()) last -= 1;
        return last + 1;
      }
    }
  }
  return limit;
}

module.exports = {
  breEscape,
  CODE_KEYWORDS,
  identifierAt,
  firstIdentifier,
  stripCodeNoise,
  inferBlockEnd,
  DEFLIKE_RE,
  DEF_KEYWORD_BRE,
  DEF_NAME_RE,
  KIND_BY_KEYWORD
};
