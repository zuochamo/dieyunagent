'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  hashText,
  embeddingSignature,
  vectorToBase64,
  base64ToVector,
  tokenize,
  keywordScore,
  readIndexFile,
  writeIndexFile,
  rankByKeyword,
  rankBySemantic
} = require('../../src/codebase/vector-index');

function tmpFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dy-vi-'));
  return path.join(dir, 'index.json');
}

describe('vector-index tokenize/keywordScore', () => {
  it('中文按单字 + 相邻双字切分', () => {
    const tokens = tokenize('重构');
    expect(tokens.has('重')).toBe(true);
    expect(tokens.has('构')).toBe(true);
    expect(tokens.has('重构')).toBe(true);
  });

  it('标识符整词 + 下划线/中划线子词都进词表', () => {
    // 驼峰不拆分：文本先小写化，`(?=[A-Z])` 永不命中（旧实现的死分支），
    // 这里锁定当前行为，避免 dedup 顺手改变召回打分。
    const tokens = tokenize('recallAgentTools');
    expect(tokens.has('recallagenttools')).toBe(true);

    const snake = tokenize('tool_vector_index');
    expect(snake.has('tool_vector_index')).toBe(true);
    expect(snake.has('tool')).toBe(true);
    expect(snake.has('vector')).toBe(true);
    expect(snake.has('index')).toBe(true);

    const kebab = tokenize('renderer-tool-defs');
    expect(kebab.has('renderer')).toBe(true);
    expect(kebab.has('tool')).toBe(true);
    expect(kebab.has('defs')).toBe(true);
  });

  it('完全相同词表得 1，无交集得 0，空集得 0', () => {
    const a = tokenize('playbook 召回');
    expect(keywordScore(a, tokenize('playbook 召回'))).toBeCloseTo(1, 6);
    expect(keywordScore(a, tokenize('unrelated'))).toBe(0);
    expect(keywordScore(new Set(), a)).toBe(0);
    expect(keywordScore(a, new Set())).toBe(0);
  });
});

describe('vector-index 向量编解码', () => {
  it('base64 往返保持数值与维度', () => {
    const values = [0.5, -1, 0, 2];
    const encoded = vectorToBase64(values);
    const decoded = base64ToVector(encoded, values.length);
    expect(decoded).not.toBeNull();
    expect(Array.from(decoded)).toEqual(values);
  });

  it('维度不符或缺失时返回 null', () => {
    expect(base64ToVector('', 4)).toBeNull();
    expect(base64ToVector(null, 4)).toBeNull();
    expect(base64ToVector(vectorToBase64([1, 0]), 4)).toBeNull();
  });

  it('embeddingSignature 在无可用后端时为空串', () => {
    expect(embeddingSignature(null)).toBe('');
    expect(embeddingSignature({ enabled: () => false, model: 'm', dimensions: 8 })).toBe('');
    expect(embeddingSignature({ enabled: () => true, model: 'm', dimensions: 8 })).toBe('m@8');
  });

  it('hashText 稳定且随内容变化', () => {
    expect(hashText('x')).toBe(hashText('x'));
    expect(hashText('x')).not.toBe(hashText('y'));
  });
});

describe('vector-index rankByKeyword', () => {
  const entries = [
    { id: 'a', tokens: ['alpha', 'beta'] },
    { id: 'b', tokens: ['alpha'] },
    { id: 'c', tokens: ['gamma'] }
  ];

  it('按命中度降序，零分条目被剔除，limit 生效', () => {
    const rows = rankByKeyword(entries, 'alpha beta', null, 10);
    expect(rows.map((r) => r.entry.id)).toEqual(['a', 'b']);
    expect(rows[0].keywordScore).toBeGreaterThan(rows[1].keywordScore);
    expect(rows[0].score).toBe(rows[0].keywordScore);
    expect(rows[0].semanticScore).toBe(0);

    expect(rankByKeyword(entries, 'alpha beta', null, 1)).toHaveLength(1);
  });

  it('allowedSet 为 null 时不过滤，非 null 时按 id 过滤', () => {
    expect(rankByKeyword(entries, 'alpha beta gamma', null, 10)).toHaveLength(3);
    const scoped = rankByKeyword(entries, 'alpha beta gamma', new Set(['b']), 10);
    expect(scoped.map((r) => r.entry.id)).toEqual(['b']);
  });
});

describe('vector-index rankBySemantic', () => {
  const dims = 4;
  const entries = [
    { id: 'a', tokens: ['alpha'], vector: vectorToBase64([1, 0, 0, 0]), dims },
    { id: 'b', tokens: ['beta'], vector: vectorToBase64([0, 1, 0, 0]), dims },
    { id: 'c', tokens: ['gamma'], vector: null, dims: 0 }
  ];

  it('语义命中优先，无向量的条目被跳过', () => {
    const keywordRows = rankByKeyword(entries, 'alpha', null, 10);
    const rows = rankBySemantic({
      entries,
      keywordRows,
      queryVec: [1, 0, 0, 0],
      max: 10,
      minSemantic: 0.18,
      minKeyword: 0
    });
    expect(rows.map((r) => r.entry.id)).toEqual(['a']);
    expect(rows[0].semanticScore).toBeCloseTo(1, 6);
    expect(rows[0].score).toBeCloseTo(1.25, 6);
  });

  it('语义正交但关键词达标时仍被保留（|| 语义）', () => {
    const keywordRows = rankByKeyword(entries, 'beta', null, 10);
    const rows = rankBySemantic({
      entries,
      keywordRows,
      queryVec: [1, 0, 0, 0],
      max: 10,
      minSemantic: 0.18,
      minKeyword: 0
    });
    // a 因语义命中(1.0)保留，b 与查询向量正交、仅靠关键词兜底
    expect(rows.map((r) => r.entry.id)).toEqual(['a', 'b']);
    const b = rows.find((r) => r.entry.id === 'b');
    expect(b.semanticScore).toBe(0);
    expect(b.keywordScore).toBeGreaterThan(0);
    expect(b.score).toBeCloseTo(b.keywordScore * 0.25, 6);
  });

  it('提高 minKeyword 后仅靠关键词兜底的条目被剔除', () => {
    const weak = [{ id: 'w', tokens: ['alpha', 'beta', 'gamma'], vector: vectorToBase64([0, 1, 0, 0]), dims }];
    const keywordRows = rankByKeyword(weak, 'alpha beta gamma', null, 10);
    const withLowGate = rankBySemantic({
      entries: weak,
      keywordRows,
      queryVec: [1, 0, 0, 0],
      max: 10,
      minSemantic: 0.18,
      minKeyword: 0
    });
    expect(withLowGate).toHaveLength(1);
    const withHighGate = rankBySemantic({
      entries: weak,
      keywordRows,
      queryVec: [1, 0, 0, 0],
      max: 10,
      minSemantic: 0.18,
      minKeyword: 1.01
    });
    expect(withHighGate).toHaveLength(0);
  });

  it('allowedSet 过滤在语义分支同样生效', () => {
    const keywordRows = rankByKeyword(entries, 'alpha beta', null, 10);
    const rows = rankBySemantic({
      entries,
      keywordRows,
      queryVec: [1, 0, 0, 0],
      max: 10,
      minSemantic: 0.18,
      minKeyword: 0,
      allowedSet: new Set(['b'])
    });
    expect(rows.map((r) => r.entry.id)).toEqual(['b']);
  });
});

describe('vector-index 索引文件读写', () => {
  it('写入后可读回，缺失/损坏/结构不符时回退 fallback', async () => {
    const file = tmpFile();
    const fallback = { version: 1, entries: [] };

    expect(await readIndexFile(file, fallback)).toEqual(fallback);

    await writeIndexFile(file, { version: 1, entries: [{ id: 'a' }] });
    expect(await readIndexFile(file, fallback)).toEqual({ version: 1, entries: [{ id: 'a' }] });

    fs.writeFileSync(file, '{ not json', 'utf8');
    expect(await readIndexFile(file, fallback)).toEqual(fallback);

    fs.writeFileSync(file, JSON.stringify({ version: 1 }), 'utf8');
    expect(await readIndexFile(file, fallback)).toEqual(fallback);
  });

  it('写入时自动创建父目录', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dy-vi-'));
    const file = path.join(dir, 'nested', 'deep', 'index.json');
    await writeIndexFile(file, { version: 1, entries: [] });
    expect(fs.existsSync(file)).toBe(true);
  });
});
