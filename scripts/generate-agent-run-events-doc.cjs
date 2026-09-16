'use strict';

/**
 * Generate docs/agent-run-events.json + docs/agent-run-events.md from run-events.js metadata.
 * Usage:
 *   node scripts/generate-agent-run-events-doc.cjs
 *   node scripts/generate-agent-run-events-doc.cjs --check
 */

const fs = require('fs');
const path = require('path');
const {
  AGENT_RUN_EVENT_TYPES,
  AGENT_RUN_EVENT_TYPE_DOCS,
  AGENT_RUN_EVENT_FIELDS,
  MOBILE_SERVICE_EVENT_MAP,
  MOBILE_PROGRESS_FIELD_MAP
} = require('../src/agent/run-events');

const ROOT = path.join(__dirname, '..');
const JSON_OUT = path.join(ROOT, 'docs', 'agent-run-events.json');
const MD_OUT = path.join(ROOT, 'docs', 'agent-run-events.md');

function buildDoc() {
  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    source: 'src/agent/run-events.js',
    eventTypes: Object.values(AGENT_RUN_EVENT_TYPES).map((type) => ({
      type,
      ...(AGENT_RUN_EVENT_TYPE_DOCS[type] || {})
    })),
    fields: AGENT_RUN_EVENT_FIELDS,
    mobileServiceEventMap: MOBILE_SERVICE_EVENT_MAP,
    mobileProgressFieldMap: MOBILE_PROGRESS_FIELD_MAP
  };
}

function renderMarkdown(doc) {
  const lines = [
    '# AgentRunEvent 契约（自动生成）',
    '',
    '> 源文件：[`src/agent/run-events.js`](../src/agent/run-events.js)。更新后运行 `npm run generate:agent-events`。',
    '',
    `生成时间：${doc.generatedAt}`,
    '',
    '## 事件类型',
    '',
    '| type | 说明 | Producer | Consumer |',
    '|------|------|----------|----------|',
    ...doc.eventTypes.map(
      (e) => `| \`${e.type}\` | ${e.description || ''} | ${e.producer || '—'} | ${e.consumer || '—'} |`
    ),
    '',
    '## 公共字段（`createAgentRunEvent`）',
    '',
    '| 字段 | 类型 | 必填 | 说明 |',
    '|------|------|------|------|',
    ...doc.fields.map(
      (f) =>
        `| \`${f.name}\` | ${f.type} | ${f.required ? '是' : '否'} | ${f.description || ''} |`
    ),
    '',
    '## Mobile AgentService 映射',
    '',
    '| service type | AgentRunEvent.type |',
    '|--------------|-------------------|',
    ...Object.entries(doc.mobileServiceEventMap).map(([k, v]) => `| \`${k}\` | \`${v}\` |`),
    '',
    '## PC → Mobile `task.progress` 字段',
    '',
    '| 字段 | 路径 |',
    '|------|------|',
    ...Object.entries(doc.mobileProgressFieldMap).map(([k, v]) => `| \`${k}\` | ${v} |`),
    '',
    '## 数据流',
    '',
    '```',
    'Rust/Main loop → dispatchAgentRunEvent (Renderer)',
    '  → pushAgentServiceProgress → AgentService.progressTask',
    '  → mobile bridge WebSocket → mobile app task.progress',
    '```',
    ''
  ];
  return `${lines.join('\n')}\n`;
}

function normalizeForCheck(text) {
  return text.replace(/"generatedAt": "[^"]+"/, '"generatedAt": "…"').replace(/生成时间：[^\n]+/, '生成时间：…');
}

function main() {
  const check = process.argv.includes('--check');
  const doc = buildDoc();
  const jsonText = `${JSON.stringify(doc, null, 2)}\n`;
  const mdText = renderMarkdown(doc);

  if (check) {
    const jsonOk =
      normalizeForCheck(fs.existsSync(JSON_OUT) ? fs.readFileSync(JSON_OUT, 'utf8') : '') ===
      normalizeForCheck(jsonText);
    const mdOk =
      normalizeForCheck(fs.existsSync(MD_OUT) ? fs.readFileSync(MD_OUT, 'utf8') : '') ===
      normalizeForCheck(mdText);
    if (!jsonOk || !mdOk) {
      console.error('[dieyun:events] agent-run-events docs stale — run: npm run generate:agent-events');
      process.exit(1);
    }
    console.log('[dieyun:events] agent-run-events docs OK');
    return;
  }

  fs.writeFileSync(JSON_OUT, jsonText, 'utf8');
  fs.writeFileSync(MD_OUT, mdText, 'utf8');
  console.log(`[dieyun:events] wrote docs/agent-run-events.json (${doc.eventTypes.length} types)`);
  console.log('[dieyun:events] wrote docs/agent-run-events.md');
}

main();
