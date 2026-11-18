'use strict';
/**
 * `src/agent/tool-validate.js` 盘点（N2.1 的第一步，**不改行为**）
 *
 * 回答一个问题：这 1128 行里，哪些是「schema 一句话就能表达的机械校验」，哪些必须人写。
 * 产出 `docs/TOOL-VALIDATE-INVENTORY.md` + 控制台摘要，供下一步「双跑夹具」按工具挑样本。
 *
 * 分类口径（写死在这里，免得下一轮换口径重数）：
 *   机械 · required       `!String(a.x || '').trim()` / `x == null` 这类「没给」判断
 *   机械 · enum           `allowed.includes(...)` / `[...].includes(action)`（取值集合）
 *   机械 · type            `Array.isArray(a.x)` / `typeof a.x`
 *   机械 · range           `AGENT_LIMITS_DEFAULTS.x` 之类的上下限比较
 *   跨字段 · conditional   只在某个 action 下必填（`['create','apply'].includes(action) && !…`）
 *   语义 · 必须人写         正则/策略调用（`validateShellCommand` / `isHttpUrl` / `fsEditArgsPresent` /
 *                          `computerPointOk` / `looksLikeApplyPatchCommand` / `isMcpServerToolName` 等）
 *
 * 用法：node scripts/inventory-tool-validate.cjs [--json <path>]
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src', 'agent', 'tool-validate.js');
const OUT_MD = path.join(ROOT, 'docs', 'TOOL-VALIDATE-INVENTORY.md');

const SEMANTIC_MARKERS = [
  'validateShellCommand',
  'isHttpUrl(',
  'fsEditArgsPresent',
  'computerPointOk(',
  'looksLikeApplyPatchCommand(',
  'applyPatchUnsupported(',
  'isMcpServerToolName(',
  'validateMcpInputArgs(',
  'isRemoteTransport(',
  'MCP_MANAGE_ACTIONS',
  'GRAPH_OPERATIONS',
  'MODIFIER_NAMES',
  'mcpArgPresent('
];

const MECHANICAL = [
  { key: 'required', re: /!String\(a\.[a-zA-Z0-9_]+\s*\|\|\s*''\)\.trim\(\)/g },
  { key: 'required', re: /a\.[a-zA-Z0-9_]+\s*==\s*null/g },
  { key: 'enum', re: /allowed\.includes\(/g },
  { key: 'enum', re: /\[\s*'[^']+'\s*(?:,\s*'[^']+'\s*)+\]\.includes\(action\)/g },
  { key: 'type', re: /Array\.isArray\(a\.[a-zA-Z0-9_]+\)/g },
  { key: 'type', re: /typeof a\.[a-zA-Z0-9_]+\s*!==/g },
  { key: 'range', re: /AGENT_LIMITS_DEFAULTS\.[a-zA-Z0-9_]+/g }
];

/** 只在某个 action 下必填。 */
const CONDITIONAL = /\[[^\]]*\]\.includes\(action\)\s*&&\s*!String\(|action\s*===\s*'[a-z_]+'\s*&&\s*!String\(/g;

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
    if (ch === '/') {
      // 粗略跳过正则/字符串：交给引号处理，这里只处理块注释
      if (next === '*') {
        const end = text.indexOf('*/', i + 2);
        if (end < 0) break;
        i = end + 1;
        continue;
      }
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch;
      i += 1;
      while (i < text.length && text[i] !== quote) {
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

function countAll(text, re) {
  const m = text.match(re);
  return m ? m.length : 0;
}

function classify(block) {
  const out = { required: 0, enum: 0, type: 0, range: 0, conditional: 0, semantic: 0, delegates: 0 };
  for (const { key, re } of MECHANICAL) out[key] += countAll(block, re);
  out.conditional = countAll(block, CONDITIONAL);
  for (const marker of SEMANTIC_MARKERS) {
    if (block.includes(marker)) out.semantic += 1;
  }
  // 任何正则形状校验（绝对路径 / URL / 命令形状）都算语义 —— 用 `.test(` 判，不做正则解析
  // （正则字面量里常带 `/` 与 `{2,60}`，再写一层正则去认它只会漏）。
  out.semantic += countAll(block, /\.test\(/g);
  // 委托给语义函数的分支：本 case 只有几行，重量在 helper 里
  out.delegates = countAll(block, /validateComputerArgs\(|validateMcpInputArgs\(|validateComputerExtras\(|applyPatchUnsupported\(/g);
  return out;
}

function schemaSummary(name) {
  let tool = null;
  try {
    tool = require(path.join(ROOT, 'src', 'agent', 'tool-catalog')).getToolByName(name);
  } catch {
    tool = null;
  }
  const params = (tool && tool.function && tool.function.parameters) || {};
  const props = params.properties && typeof params.properties === 'object' ? params.properties : {};
  const required = Array.isArray(params.required) ? params.required : [];
  const enums = Object.entries(props).filter(
    ([, spec]) => spec && Array.isArray(spec.enum) && spec.enum.length
  ).length;
  return { props: Object.keys(props).length, required: required.length, enums };
}

function main() {
  const text = fs.readFileSync(SRC, 'utf8');
  // 文件是 CRLF：按 /\\r?\\n/ 切，否则 lines[i] === '}' 永远不成立（会退化成 1 行/函数）
  // 文件是 CRLF：按 \r?\n 切，否则 `lines[i] === '}'` 永远不成立（会退化成 1 行/函数）
  const lines = text.split(/\r?\n/);
  const total = lines.length;

  // 1) 独立函数（语义类）的行数
  // 顶层函数一律以顶格 `}` 收尾：按行切比按花括号配更稳（正则字面量里有 `{2,60}` 这类花括号）
  const fnRe = /^function ([a-zA-Z0-9_]+)\(/gm;
  const fns = [];
  let m;
  while ((m = fnRe.exec(text))) {
    const startLine = text.slice(0, m.index).split('\n').length;
    let endLine = startLine;
    for (let i = startLine; i < lines.length; i += 1) {
      if (lines[i] === '}') {
        endLine = i + 1;
        break;
      }
    }
    fns.push({
      name: m[1],
      loc: endLine - startLine + 1,
      body: lines.slice(startLine - 1, endLine).join('\n')
    });
  }
  // 上下限比较（`AGENT_LIMITS_DEFAULTS.*`）全在语义函数里（`validateComputerArgs` 等），
  // 不在 switch 分支里 —— 所以按工具表的 range 列恒为 0，这里单独记一笔。
  const rangeInFile = countAll(text, /AGENT_LIMITS_DEFAULTS\.[a-zA-Z0-9_]+/g);

  // 2) switch 分支
  const caseRe = /^ {4}case '([a-z_0-9]+)':/gm;
  const cases = [];
  while ((m = caseRe.exec(text))) {
    const bodyStart = m.index + m[0].length;
    // 分支到下一个 `    case '` 或 switch 收尾
    const nextCase = /^ {4}case '/gm;
    nextCase.lastIndex = bodyStart;
    const nm = nextCase.exec(text);
    const bodyEnd = nm ? nm.index : text.length;
    const block = text.slice(bodyStart, bodyEnd);
    const startLine = text.slice(0, m.index).split('\n').length;
    const endLine = text.slice(0, bodyEnd).split('\n').length;
    cases.push({
      name: m[1],
      loc: endLine - startLine,
      startLine,
      ...classify(block),
      schema: schemaSummary(m[1])
    });
  }

  const sum = (key) => cases.reduce((s, c) => s + c[key], 0);
  const switchLoc = cases.reduce((s, c) => s + c.loc, 0);
  const fnLoc = fns.reduce((s, f) => s + f.loc, 0);
  const mechanical = sum('required') + sum('enum') + sum('type') + sum('range');
  const semanticCases = cases.filter((c) => c.semantic > 0);
  const mechanicalCases = cases.filter((c) => c.semantic === 0);

  // 3) 输出
  const md = [];
  md.push('# `tool-validate.js` 盘点（N2.1 第一步）');
  md.push('');
  md.push('> **AUTO-GENERATED** by `scripts/inventory-tool-validate.cjs`（`npm run inventory:tool-validate`）。');
  md.push('> 这是**盘点的口径与数字**，不是计划：口径写在脚本里，重跑即复现（不手写数字）。');
  md.push('');
  md.push('## 规模');
  md.push('');
  md.push('| 项 | 数字 |');
  md.push('|---|---|');
  md.push(`| 文件总行数 | **${total}** |`);
  md.push(`| \`switch\` 分支（按工具名） | **${cases.length}** 个，共 ${switchLoc} 行 |`);
  md.push(`| 独立函数（语义校验 / 公共判定） | **${fns.length}** 个，共 ${fnLoc} 行 |`);
  md.push(`| 机械检查点（required / enum / type / range） | **${mechanical}** 处（required ${sum('required')} / enum ${sum('enum')} / type ${sum('type')} / range ${sum('range')}） |`);
  md.push(`| 跨字段条件必填（某个 action 下才必填） | **${sum('conditional')}** 处 |`);
  md.push(`| 文件内上下限比较（\`AGENT_LIMITS_DEFAULTS.*\`，均在语义函数里） | **${rangeInFile}** 处 |`);
  md.push(`| 含语义判定的分支 | **${semanticCases.length}** / ${cases.length} |`);
  md.push('');
  md.push('## 分类口径');
  md.push('');
  md.push('| 类别 | 判据 | schema 能否表达 |');
  md.push('|---|---|---|');
  md.push('| 机械 · required | `!String(a.x \\|\\| \'\').trim()` / `a.x == null` | **能**（`required`） |');
  md.push('| 机械 · enum | `allowed.includes(...)` / 字面量数组 `.includes(action)` | **能**（`enum`，且 action 枚举已从 schema 取） |');
  md.push('| 机械 · type | `Array.isArray(a.x)` / `typeof a.x !== …` | **能**（`type`） |');
  md.push('| 机械 · range | `AGENT_LIMITS_DEFAULTS.x` 参与的比较 | **能**（`minimum` / `maximum`） |');
  md.push('| 跨字段 · conditional | 只在某个 `action` 下必填 | **不能**（要 `if/then` 或继续手写） |');
  md.push('| 语义 · 必须人写 | 正则形状、策略调用、坐标/补丁/凭据判定 | **不能**（跨字段 / 外部知识） |');
  md.push('');
  md.push('## 按工具');
  md.push('');
  md.push('| 工具 | 行数 | schema props / required / enum | 机械 | 条件必填 | 语义 | 判定 |');
  md.push('|---|---|---|---|---|---|---|');
  for (const c of [...cases].sort((a, b) => b.loc - a.loc)) {
    const mech = c.required + c.enum + c.type + c.range;
    const verdict =
      c.delegates > 0
        ? '委托给语义函数'
        : c.semantic > 0
          ? '需保留语义'
          : c.conditional > 0
            ? '条件必填需保留'
            : '可全自动生成';
    md.push(
      `| \`${c.name}\` | ${c.loc} | ${c.schema.props} / ${c.schema.required} / ${c.schema.enums} | ${mech} | ${c.conditional} | ${c.semantic} | ${verdict} |`
    );
  }
  md.push('');
  md.push('## 独立函数（语义 / 公共判定，**不该被生成**）');
  md.push('');
  md.push('| 函数 | 行数 | 机械检查 | 语义点 | 性质 |');
  md.push('|---|---|---|---|---|');
  for (const f of [...fns].sort((a, b) => b.loc - a.loc)) {
    const cls = classify(f.body || '');
    const mech = cls.required + cls.enum + cls.type + cls.range;
    const kind =
      cls.semantic > 0 || cls.range > 0
        ? '语义判定（必须人写）'
        : mech > 0
          ? '机械/公共判定（可生成，或保留为公共函数）'
          : '待核实';
    md.push(`| \`${f.name}\` | ${f.loc} | ${mech} | ${cls.semantic} | ${kind} |`);
  }
  md.push('');
  md.push('## 预计可删行数（N2.1 的收益上限，先说清假设）');
  md.push('');
  const mechOnly = cases.filter((c) => c.delegates === 0 && c.semantic === 0);
  const mechOnlyLoc = mechOnly.reduce((s, c) => s + c.loc, 0);
  const PER_CHECK_LOC = 4; // 一条机械检查 = 一个 if + 一个 4 行 return 对象（实测中位数）
  const estLines = sum('required') * PER_CHECK_LOC + sum('enum') * PER_CHECK_LOC + sum('type') * PER_CHECK_LOC;
  md.push(`- 「纯机械」分支 **${mechOnly.length}** 个、共 **${mechOnlyLoc}** 行：这些能被生成器整体替掉；`);
  md.push(`- 机械检查 ${mechanical} 处 × 约 ${PER_CHECK_LOC} 行（if + return 对象）≈ **${estLines}** 行；`);
  md.push(`- 结论：**可删约 ${Math.min(estLines, mechOnlyLoc)}–${mechOnlyLoc} 行**，落到 ~${total - Math.min(estLines, mechOnlyLoc)}–${total - mechOnlyLoc} 行。`);
  md.push('  > 计划里「目标 < 500 行」只在**把条件必填也交给 schema（`if/then`）并且语义函数一起瘦身**时才成立；');
  md.push('  > 只做「机械部分生成」大概到 850–900 行。数字先摆在这里，别到时候拿目标当承诺。');
  md.push('');
  md.push('## 下一步（按这些数字挑双跑样本）');
  md.push('');
  md.push(`- 「**可全自动生成**」的分支共 ${mechanicalCases.length} 个（机械检查 ${mechanicalCases.reduce((s, c) => s + c.required + c.enum + c.type + c.range, 0)} 处）——先在这批上做双跑夹具；`);
  md.push(`- 「含语义判定」的 ${semanticCases.length} 个分支，生成器只出机械部分，语义块原样保留；`);
  md.push(
    `- 「条件必填」${sum('conditional')} 处：要么扩充 catalog schema（\`if/then\`），要么在生成器里显式列出 —— 二选一，别两边都写。`
  );
  md.push('');

  fs.writeFileSync(OUT_MD, `${md.join('\n')}\n`, 'utf8');

  const summary = {
    total,
    cases: cases.length,
    switchLoc,
    functions: fns.length,
    fnLoc,
    mechanical,
    breakdown: { required: sum('required'), enum: sum('enum'), type: sum('type'), range: sum('range') },
    conditional: sum('conditional'),
    semanticCases: semanticCases.length,
    mechanicalOnlyCases: mechanicalCases.length,
    perTool: cases
  };
  const jsonOut = process.argv.includes('--json')
    ? String(process.argv[process.argv.indexOf('--json') + 1] || '')
    : '';
  if (jsonOut && !jsonOut.startsWith('--')) {
    fs.writeFileSync(jsonOut, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  }

  console.log(`[tool-validate] ${total} 行 / ${cases.length} 个工具分支（${switchLoc} 行）/ ${fns.length} 个函数（${fnLoc} 行）`);
  console.log(
    `[tool-validate] 机械检查 ${mechanical} 处（required ${summary.breakdown.required} / enum ${summary.breakdown.enum} / type ${summary.breakdown.type} / range ${summary.breakdown.range}），条件必填 ${summary.conditional} 处`
  );
  console.log(
    `[tool-validate] 可全自动生成 ${summary.mechanicalOnlyCases} 个分支；含语义判定 ${summary.semanticCases} 个`
  );
  console.log(`[tool-validate] wrote ${path.relative(ROOT, OUT_MD)}`);
  return summary;
}

main();
