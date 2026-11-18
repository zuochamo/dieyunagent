'use strict';
/**
 * 跨语言契约（Rust struct/enum → `types/core-contracts.d.ts`）
 *
 * 解决的问题（docs/NODE-THINNING-PLAN.md N1.3）：`agent.run.*` 这些方法的参数/回包形状
 * 一直是「Rust 一份 serde struct + Node 一份手写对象 + 一句『务必与 Node 端逐字对齐』的注释」。
 * 契约靠注释 = 一定会漂；现在把它变成生成物 + `tsc --noEmit` 闸门。
 *
 * 做法（**单一来源是 Rust 结构体本身**，不是这里的手写表）：
 *   1) 扫 `crates/*\/src/**\/*.rs`，只收**带 `@contract` 文档标记**的 `pub struct` / `pub enum`
 *      —— 标记跟着类型走，所以「哪些是跨语言契约」也只有一个出处；
 *   2) 读 `#[serde(rename_all = "camelCase")]` / `#[serde(rename = "…")]` / `#[serde(default)]`
 *      / `skip_serializing_if` 决定字段名与可选性；
 *   3) Rust 类型 → TS 类型（String/数值/bool/Option/Vec/HashMap/Value/嵌套契约类型）；
 *   4) 产出 `types/core-contracts.d.ts`（AUTO-GENERATED），调用方用
 *      `@type {import('../../types/core-contracts').StartParams}` 标注，字段漂了 `check:js` 立刻红。
 *
 * 用法：
 *   node scripts/generate-core-contracts.cjs           # 重新生成
 *   node scripts/generate-core-contracts.cjs --check    # 生成物是否过期（CI 用）
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'types', 'core-contracts.d.ts');
const MARKER = '@contract';

/** Rust 标量 → TS。 */
const SCALARS = {
  String: 'string',
  bool: 'boolean',
  u8: 'number',
  u16: 'number',
  u32: 'number',
  u64: 'number',
  usize: 'number',
  i8: 'number',
  i16: 'number',
  i32: 'number',
  i64: 'number',
  isize: 'number',
  f32: 'number',
  f64: 'number',
  Value: 'unknown',
  serde_json: 'unknown'
};

/**
 * 紧贴在声明上方的属性 / 文档块（`#[...]` 与 `///` 连续行）。
 *
 * 不能用「往前 N 字符」：那会吃到上一个类型自己的 `#[serde(rename_all = ...)]`，
 * 于是枚举会被贴上别人的 rename 规则（ContentChannel 就这么变成过 camelCase）。
 */
function attrBlockAbove(text, declIndex) {
  const lines = text.slice(0, declIndex).split('\n');
  const kept = [];
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i].trim();
    if (!line) continue;
    if (line.startsWith('#[') || line.startsWith('///')) {
      kept.unshift(line);
      continue;
    }
    break;
  }
  return kept.join('\n');
}

function collectRustFiles() {
  const out = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(abs);
        continue;
      }
      if (entry.isFile() && entry.name.endsWith('.rs')) out.push(abs);
    }
  };
  const cratesDir = path.join(ROOT, 'crates');
  for (const crate of fs.readdirSync(cratesDir, { withFileTypes: true })) {
    if (!crate.isDirectory()) continue;
    walk(path.join(cratesDir, crate.name, 'src'));
  }
  return out;
}

/** 从 `start` 处做花括号配对（跳过字符串/注释）。 */
function matchBrace(text, start) {
  let depth = 0;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    const next = text[i + 1];
    if (ch === '/' && next === '/') {
      const nl = text.indexOf('\n', i);
      if (nl < 0) break;
      i = nl;
      continue;
    }
    if (ch === '/' && next === '*') {
      const end = text.indexOf('*/', i + 2);
      if (end < 0) break;
      i = end + 1;
      continue;
    }
    if (ch === '"') {
      i += 1;
      while (i < text.length && text[i] !== '"') {
        if (text[i] === '\\') i += 1;
        i += 1;
      }
      continue;
    }
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function camel(name) {
  return name.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());
}

/**
 * 变体名 → snake_case（`Answer` → `answer`，`NeedPlanLlm` → `need_plan_llm`）。
 *
 * 注意**不是** `_${c.toLowerCase()}`：那样 `Answer` 会变成 `_answer`，而上游协议里是 `answer`。
 */
function snake(name) {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase();
}

/** Rust 类型字符串 → TS。 */
function toTs(rustType, known) {
  const t = rustType.trim();
  if (SCALARS[t]) return SCALARS[t];
  const opt = /^Option<(.+)>$/.exec(t);
  if (opt) return `${toTs(opt[1], known)} | null`;
  const vec = /^(?:Vec|HashSet|BTreeSet)<(.+)>$/.exec(t);
  if (vec) return `${toTs(vec[1], known)}[]`;
  const map = /^(?:HashMap|BTreeMap)<[^,]+,\s*(.+)>$/.exec(t);
  if (map) return `Record<string, ${toTs(map[1], known)}>`;
  if (/^&(?:'[a-z]+\s+)?str$/.test(t)) return 'string';
  if (t.startsWith('&')) return toTs(t.replace(/^&(?:'[a-z]+\s+)?/, ''), known);
  if (known.has(t)) return t;
  return `unknown /* Rust: ${t.replace(/\*\//g, '* /')} */`;
}

/** 解析一个 struct 块。 */
function parseStruct(text, headerMatch, known, contracts) {
  const name = headerMatch[1];
  const braceAt = text.indexOf('{', headerMatch.index + headerMatch[0].length - 1);
  const end = matchBrace(text, braceAt);
  if (end < 0) return null;
  const header = attrBlockAbove(text, headerMatch.index);
  const body = text.slice(braceAt + 1, end);
  const camelCase = /rename_all\s*=\s*"camelCase"/.test(header);

  const fields = [];
  let rename = null;
  let optional = false;
  let doc = [];
  for (const rawLine of body.split('\n')) {
    const line = rawLine.trim();
    if (line.startsWith('///')) {
      doc.push(line.replace(/^\/\/\/\s?/, ''));
      continue;
    }
    const ren = /#\[serde\(rename\s*=\s*"([^"]+)"\)\]/.exec(line);
    if (ren) {
      rename = ren[1];
      continue;
    }
    if (/#\[serde\((?:[^)]*\bdefault\b|skip_serializing_if)/.test(line)) {
      optional = true;
      continue;
    }
    if (line.startsWith('#[')) continue;
    const field = /^pub\s+([a-z_0-9]+)\s*:\s*(.+?),?$/.exec(line);
    if (!field) continue;
    const rustName = field[1];
    const rustType = field[2].replace(/,$/, '');
    const tsName = rename || (camelCase ? camel(rustName) : rustName);
    fields.push({
      name: tsName,
      rustName,
      tsType: toTs(rustType, known),
      optional,
      doc
    });
    rename = null;
    optional = false;
    doc = [];
  }
  return { kind: 'struct', name, fields, file: contracts };
}

/** 解析一个 enum 块（只支持 unit variant）。 */
function parseEnum(text, headerMatch, contracts) {
  const name = headerMatch[1];
  const braceAt = text.indexOf('{', headerMatch.index + headerMatch[0].length - 1);
  const end = matchBrace(text, braceAt);
  if (end < 0) return null;
  const header = attrBlockAbove(text, headerMatch.index);
  const body = text.slice(braceAt + 1, end);
  const lower = /rename_all\s*=\s*"(lowercase|camelCase|snake_case)"/.exec(header);
  const values = [];
  for (const rawLine of body.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('//') || line.startsWith('#')) continue;
    const variant = /^([A-Z][A-Za-z0-9]*)\s*,?$/.exec(line);
    if (!variant) return null; // 带数据的枚举不生成（避免猜错）
    const v = variant[1];
    if (!lower) values.push(v);
    else if (lower[1] === 'lowercase') values.push(v.toLowerCase());
    else if (lower[1] === 'snake_case') values.push(snake(v));
    else values.push(camel(v));
  }
  return { kind: 'enum', name, values, file: contracts };
}

function extract() {
  const found = [];
  for (const file of collectRustFiles()) {
    const text = fs.readFileSync(file, 'utf8');
    const rel = path.relative(ROOT, file).replace(/\\/g, '/');
    const re = /^(?:\s*\/\/\/[^\n]*\n)*\s*pub(?:\([^)]*\))?\s+(struct|enum)\s+([A-Za-z0-9_]+)/gm;
    let m;
    while ((m = re.exec(text))) {
      const windowStart = Math.max(0, m.index - 800);
      const window = text.slice(windowStart, m.index);
      // 标记可能在匹配到的 doc 块里（/// @contract 紧贴声明），也可能在更上面
      if (!m[0].includes(MARKER) && !window.includes(MARKER)) continue;
      found.push({ kind: m[1], name: m[2], index: m.index, decl: m[0], text, rel });
    }
  }
  return found;
}

function render(items) {
  const known = new Set(items.map((i) => i.name));
  const blocks = [];
  for (const item of items) {
    const header = /^\s*(?:pub(?:\([^)]*\))?\s+)(struct|enum)\s+([A-Za-z0-9_]+)/m.exec(item.decl);
    const fake = { index: item.index, 0: item.decl, 1: item.name };
    if (item.kind === 'struct') {
      const parsed = parseStruct(item.text, fake, known, item.rel);
      if (!parsed) continue;
      const lines = [];
      lines.push(`/** 来自 \`${item.rel}\`（Rust \`${item.name}\`）。 */`);
      lines.push(`export interface ${parsed.name} {`);
      for (const f of parsed.fields) {
        if (f.doc.length) lines.push(`  /** ${f.doc.join(' ')} */`);
        lines.push(`  ${f.name}${f.optional ? '?' : ''}: ${f.tsType};`);
      }
      lines.push('}');
      blocks.push(lines.join('\n'));
    } else {
      const parsed = parseEnum(item.text, fake, item.rel);
      if (!parsed) continue;
      blocks.push(
        `/** 来自 \`${item.rel}\`（Rust \`${item.name}\`）。 */\n` +
          `export type ${parsed.name} = ${parsed.values.map((v) => `'${v}'`).join(' | ')};`
      );
    }
  }
  const head = [
    '// AUTO-GENERATED by scripts/generate-core-contracts.cjs — DO NOT EDIT.',
    '// 更新：npm run generate:core-contracts；校验：npm run verify:core-contracts。',
    '//',
    '// 来源：Rust 里带 `@contract` 标记的 struct / enum（docs/NODE-THINNING-PLAN.md N1.3）。',
    '// 调用方用 `@type {import("../../types/core-contracts").X}` 标注 → 字段改了一侧，`npm run check:js` 就红。',
    ''
  ].join('\n');
  return `${head}\n${blocks.join('\n\n')}\n`;
}

function main() {
  const check = process.argv.includes('--check');
  const items = extract();
  if (!items.length) {
    console.error('✗ 没找到任何 @contract 类型：标记丢了？');
    process.exit(1);
  }
  const text = render(items);
  if (check) {
    const committed = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8').replace(/\r\n/g, '\n') : '';
    if (committed.trim() !== text.trim()) {
      console.error(`✗ ${path.relative(ROOT, OUT)} 过期：跑 npm run generate:core-contracts`);
      process.exit(1);
    }
    console.log(`[dieyun:contracts] OK（${items.length} 个 @contract 类型）`);
    return;
  }
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, text, 'utf8');
  console.log(`[dieyun:contracts] wrote ${path.relative(ROOT, OUT)}（${items.length} 个类型）`);
  for (const i of items) console.log(`  - ${i.name} (${i.rel})`);
}

main();
