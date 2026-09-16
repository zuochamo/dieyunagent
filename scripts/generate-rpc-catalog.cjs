'use strict';

/**
 * Generate docs/rpc-catalog.json + docs/rpc-catalog.md from Gateway + Rust RPC registrations.
 * Usage:
 *   node scripts/generate-rpc-catalog.cjs
 *   node scripts/generate-rpc-catalog.cjs --check   # fail if committed catalog is stale
 */

const fs = require('fs');
const path = require('path');
const {
  collectGatewayMethods,
  collectRustMethods,
  mergeCatalog,
  groupByNamespace
} = require('./lib/extract-rpc-methods.cjs');

const ROOT = path.join(__dirname, '..');
const JSON_OUT = path.join(ROOT, 'docs', 'rpc-catalog.json');
const MD_OUT = path.join(ROOT, 'docs', 'rpc-catalog.md');

function buildCatalog() {
  const gatewayMap = collectGatewayMethods(ROOT);
  const rustMap = collectRustMethods(ROOT);
  const methods = mergeCatalog(gatewayMap, rustMap);
  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    description: 'Auto-generated RPC method index for dieyunagent Gateway + dieyun-core',
    stats: {
      total: methods.length,
      gatewayOnly: methods.filter((m) => m.layer === 'gateway').length,
      rustOnly: methods.filter((m) => m.layer === 'rust').length,
      both: methods.filter((m) => m.layer === 'both').length
    },
    methods
  };
}

function renderMarkdown(catalog) {
  const lines = [
    '# RPC Catalog（自动生成）',
    '',
    '> 勿手改。更新 RPC 注册后运行 `npm run generate:rpc-catalog`，CI 用 `npm run verify:rpc-catalog` 校验。',
    '',
    `生成时间：${catalog.generatedAt}`,
    '',
    '| 统计 | 数量 |',
    '|------|------|',
    `| 总计 | ${catalog.stats.total} |`,
    `| Gateway only | ${catalog.stats.gatewayOnly} |`,
    `| Rust only | ${catalog.stats.rustOnly} |`,
    `| Both | ${catalog.stats.both} |`,
    '',
    '## 按命名空间',
    ''
  ];

  for (const [ns, rows] of groupByNamespace(catalog.methods)) {
    lines.push(`### ${ns} (${rows.length})`);
    lines.push('');
    lines.push('| Method | Layer | Gateway source | Rust |');
    lines.push('|--------|-------|----------------|------|');
    for (const row of rows) {
      lines.push(
        `| \`${row.method}\` | ${row.layer} | ${row.gateway.join(', ') || '—'} | ${row.rust.length ? 'yes' : '—'} |`
      );
    }
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}

function normalizeJson(obj) {
  return `${JSON.stringify(obj, null, 2)}\n`;
}

function main() {
  const check = process.argv.includes('--check');
  const catalog = buildCatalog();
  const jsonText = normalizeJson(catalog);
  const mdText = renderMarkdown(catalog);

  if (check) {
    const existingJson = fs.existsSync(JSON_OUT) ? fs.readFileSync(JSON_OUT, 'utf8') : '';
    const existingMd = fs.existsSync(MD_OUT) ? fs.readFileSync(MD_OUT, 'utf8') : '';
    const jsonOk = existingJson.replace(/"generatedAt": "[^"]+"/, '"generatedAt": "…"') ===
      jsonText.replace(/"generatedAt": "[^"]+"/, '"generatedAt": "…"');
    const mdOk =
      existingMd.replace(/生成时间：[^\n]+/, '生成时间：…') ===
      mdText.replace(/生成时间：[^\n]+/, '生成时间：…');
    if (!jsonOk || !mdOk) {
      console.error('[dieyun:rpc] catalog is stale — run: npm run generate:rpc-catalog');
      process.exit(1);
    }
    console.log('[dieyun:rpc] catalog OK');
    return;
  }

  fs.mkdirSync(path.dirname(JSON_OUT), { recursive: true });
  fs.writeFileSync(JSON_OUT, jsonText, 'utf8');
  fs.writeFileSync(MD_OUT, mdText, 'utf8');
  console.log(`[dieyun:rpc] wrote ${path.relative(ROOT, JSON_OUT)} (${catalog.stats.total} methods)`);
  console.log(`[dieyun:rpc] wrote ${path.relative(ROOT, MD_OUT)}`);
}

main();
