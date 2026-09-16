'use strict';

/**
 * Lightweight unit checks for sanitizeMermaidCode (no DOM).
 * Run: node scripts/test-mermaid-sanitize.cjs
 */

function loadSanitize() {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(
    path.join(__dirname, '../src/renderer/renderer-mermaid.js'),
    'utf8'
  );
  const fn = src.match(/function sanitizeMermaidCode\(raw\) \{[\s\S]*?\n\}/);
  if (!fn) throw new Error('sanitizeMermaidCode not found');
  // hoist helpers used by sanitize
  const helpers = [];
  for (const name of ['labelNeedsQuotes', 'quoteLabel']) {
    const m = src.match(new RegExp(`function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`));
    if (!m) throw new Error(`${name} not found`);
    helpers.push(m[0]);
  }
  const seq = 'let mermaidSubgraphSeq = 0;';
  // eslint-disable-next-line no-new-func
  return new Function(`${seq}\n${helpers.join('\n')}\n${fn[0]}\nreturn sanitizeMermaidCode;`)();
}

const sanitize = loadSanitize();
let failed = 0;

function assert(cond, msg) {
  if (!cond) {
    failed += 1;
    console.error('FAIL:', msg);
  } else {
    console.log('ok', msg);
  }
}

{
  const out = sanitize(`flowchart TB
A[准备阶段]
B[Gateway (RPC)]
A --> B`);
  assert(out.includes('A["准备阶段"]'), 'quote Chinese node');
  assert(out.includes('B["Gateway (RPC)"]'), 'quote paren node');
}

{
  const out = sanitize(`flowchart TB
subgraph Gateway (RPC)
  A --> B
end`);
  assert(/subgraph\s+sg\d+\["Gateway \(RPC\)"\]/.test(out), 'quote subgraph title');
}

{
  const out = sanitize(`flowchart LR
A -->|发消息| B`);
  assert(out.includes('-->|"发消息"|'), 'quote edge label');
}

{
  const out = sanitize(`flowchart TB
A[ok]<br/>B[中文]`);
  assert(!/<br/i.test(out), 'strip br');
  assert(out.includes('B["中文"]'), 'quote after strip');
}

{
  const out = sanitize(`A --> B\nB --> C`);
  assert(/^flowchart TB/m.test(out), 'inject diagram type');
}

{
  const out = sanitize(`graph TD
A --> B`);
  assert(/^flowchart\b/m.test(out), 'graph to flowchart');
}

if (failed) {
  console.error(`\n${failed} failed`);
  process.exit(1);
}
console.log('\nALL OK');
