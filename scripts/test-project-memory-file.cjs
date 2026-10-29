'use strict';

/**
 * `.dieyun/memory.md`（项目记忆唯一真相）的文件层测试。
 *
 * 这里只测纯函数：解析 / 合并去重 / 上限 / 注入裁剪 / secret 过滤。
 * 「谁来写、写到哪个工作空间」在 test-knowledge-maintainer.cjs 里按调用路径验。
 */

const assert = require('assert');
const {
  PROJECT_MEMORY_REL_PATH,
  parseProjectMemoryEntries,
  mergeProjectMemoryEntries,
  renderProjectMemoryFile,
  formatProjectMemoryBlock,
  filterEntriesForFile,
  entryKey
} = require('../src/agent/project-memory-file');

function check(name, fn) {
  try {
    fn();
    console.log('ok -', name);
  } catch (err) {
    console.error('not ok -', name + ':', err && err.message);
    process.exitCode = 1;
  }
}

check('path: 约定位置固定为 .dieyun/memory.md', () => {
  assert.strictEqual(PROJECT_MEMORY_REL_PATH, '.dieyun/memory.md');
});

check('parse: 只认 "- " 开头的行，忽略标题/引用/说明', () => {
  const text = [
    '# 项目记忆',
    '',
    '> 说明行不算条目',
    '',
    '- 第一条',
    '-   第二条   ',
    '## 小节标题',
    '不是条目',
    '- '
  ].join('\n');
  assert.deepStrictEqual(parseProjectMemoryEntries(text), ['第一条', '第二条']);
});

check('merge: 归一化去重（大小写/标点/空白不算新条目），新的在前', () => {
  const merged = mergeProjectMemoryEntries(['旧条目', 'Camera 导出走 runtime'], [
    'camera 导出走 runtime。',
    '新条目'
  ]);
  assert.deepStrictEqual(merged, ['camera 导出走 runtime。', '新条目', '旧条目']);
  // 最后一条不能因为去重被整个吞掉
  assert.strictEqual(entryKey('A b, c.'), entryKey('a b c'));
});

check('render: 带头部说明，条目按给定顺序', () => {
  const text = renderProjectMemoryFile(['第一条', '第二条']);
  assert.ok(text.startsWith('# 项目记忆'));
  assert.ok(text.includes('- 第一条\n- 第二条\n'));
});

check('merge: 超上限丢最旧的（保留前 200 条）', () => {
  const many = Array.from({ length: 260 }, (_, i) => `条目 ${i}`);
  const merged = mergeProjectMemoryEntries(many, ['最新条目']);
  assert.strictEqual(merged.length, 200);
  assert.strictEqual(merged[0], '最新条目');
});

check('block: 按字符预算截断并说明还有多少条没注入', () => {
  const text = renderProjectMemoryFile(['一'.repeat(200), '二'.repeat(200), '三'.repeat(200)]);
  const block = formatProjectMemoryBlock(text, { maxChars: 400, workspacePath: 'D:/proj' });
  assert.ok(block.includes('【项目记忆 · .dieyun/memory.md'));
  assert.ok(block.includes('D:/proj'));
  assert.ok(block.includes('一'.repeat(200)));
  assert.ok(!block.includes('三'.repeat(200)), '超出预算的条目不应注入');
  assert.ok(/还有 \d+ 条更早的条目未注入/.test(block), '要告诉模型还有未注入条目');
});

check('block: 空文件不产生注入块', () => {
  assert.strictEqual(formatProjectMemoryBlock('', {}), '');
  assert.strictEqual(formatProjectMemoryBlock('# 项目记忆\n\n> 只有说明\n', {}), '');
});

check('filter: secret / private 绝不进文件（会进版本库）', () => {
  const { kept, dropped } = filterEntriesForFile([
    { content: '正常约定', kind: 'normal' },
    { content: '数据库口令 hunter2', kind: 'secret' },
    { content: '个人隐私', kind: 'private' },
    { content: '   ', kind: 'normal' }
  ]);
  assert.deepStrictEqual(kept, ['正常约定']);
  assert.strictEqual(dropped, 2);
});

check('filter: 单条超长正文截断（记忆是一句话，不是散文）', () => {
  const { kept } = filterEntriesForFile([{ content: 'x'.repeat(900), kind: 'normal' }]);
  assert.strictEqual(kept[0].length, 300);
});

console.log('\ntest-project-memory-file.cjs ok');
