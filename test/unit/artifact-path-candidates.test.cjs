'use strict';

/**
 * SSH 工作区路径「权威解析」的纯算法部分（Gateway 侧 workspace.resolve_path 用）。
 *
 * 回归点：Agent / 会话记录 / 本地剪贴板带来的路径常常是「别的视角」的
 * （`C:\Users\me\proj\src\a.ts`、另一台机器的 `/home/other/proj/src/a.ts`），
 * 在当前远程工作区里原样不存在。原先 Renderer 靠本地文件列表副本**猜**映射，
 * 猜错会打开另一个文件、并让保存按钮写向错误位置。
 * 现在改为：提取尾部特征 → 去远程查 → 把候选交给用户。
 */

const {
  normalizeResolveInput,
  extractTailSegments,
  buildCandidateGlobs,
  rankPathCandidates,
  MAX_CANDIDATE_LIMIT
} = require('../../src/workspace/resolve-path-candidates');

describe('normalizeResolveInput', () => {
  it('反斜杠统一为正斜杠，去首尾引号', () => {
    expect(normalizeResolveInput('C:\\Users\\me\\proj\\a.ts')).toBe('C:/Users/me/proj/a.ts');
    expect(normalizeResolveInput('"src/a.ts"')).toBe('src/a.ts');
    expect(normalizeResolveInput("'src/a.ts'")).toBe('src/a.ts');
  });

  it('剥离 ssh: URI，只保留远程路径部分', () => {
    expect(normalizeResolveInput('ssh://deploy@10.0.0.5:22/srv/app/a.ts')).toBe('/srv/app/a.ts');
    expect(normalizeResolveInput('ssh:deploy@10.0.0.5/srv/app/a.ts')).toBe('/srv/app/a.ts');
    expect(normalizeResolveInput('ssh://deploy@host')).toBe('/');
  });

  it('空输入返回空串（不抛异常）', () => {
    expect(normalizeResolveInput('')).toBe('');
    expect(normalizeResolveInput('   ')).toBe('');
    expect(normalizeResolveInput(null)).toBe('');
    expect(normalizeResolveInput(undefined)).toBe('');
  });
});

describe('extractTailSegments', () => {
  it('取尾部若干段，过滤盘符段', () => {
    expect(extractTailSegments('C:\\Users\\me\\proj\\src\\renderer\\agent\\foo.js', 3)).toEqual([
      'renderer',
      'agent',
      'foo.js'
    ]);
  });

  it('默认最多 3 段', () => {
    expect(extractTailSegments('/a/b/c/d/e/f.ts')).toEqual(['d', 'e', 'f.ts']);
  });

  it('过滤 . 与 .. 段，且不因过滤而少取有效段', () => {
    expect(extractTailSegments('src/./lib/../util/a.ts', 3)).toEqual(['lib', 'util', 'a.ts']);
  });

  it('全部段都无意义时返回空数组', () => {
    expect(extractTailSegments('C:/')).toEqual([]);
    expect(extractTailSegments('')).toEqual([]);
    expect(extractTailSegments('/')).toEqual([]);
  });

  it('超长段（疑似哈希/base64 目录名）被丢弃，不作为匹配特征', () => {
    const long = 'x'.repeat(200);
    expect(extractTailSegments(`root/${long}/a.ts`, 3)).toEqual(['root', 'a.ts']);
  });

  it('段数不足 limit 时全取', () => {
    expect(extractTailSegments('a.ts', 3)).toEqual(['a.ts']);
  });
});

describe('buildCandidateGlobs', () => {
  it('由长到短生成，命中即停可避免同名噪音', () => {
    expect(buildCandidateGlobs(['renderer', 'agent', 'foo.js'])).toEqual([
      '**/renderer/agent/foo.js',
      '**/agent/foo.js',
      '**/foo.js'
    ]);
  });

  it('单段时只生成一条最宽的', () => {
    expect(buildCandidateGlobs(['foo.js'])).toEqual(['**/foo.js']);
  });

  it('空输入返回空数组', () => {
    expect(buildCandidateGlobs([])).toEqual([]);
    expect(buildCandidateGlobs(null)).toEqual([]);
  });
});

describe('rankPathCandidates', () => {
  const mk = (path, mtimeMs) => ({ path, mtimeMs, relativePath: path.replace(/^\//, '') });

  it('按 mtime 降序（最近改动的更可能是目标）', () => {
    const r = rankPathCandidates([mk('/a/old.ts', 100), mk('/a/new.ts', 900)]);
    expect(r.candidates.map((c) => c.path)).toEqual(['/a/new.ts', '/a/old.ts']);
  });

  it('mtime 相同时路径更短者优先', () => {
    const r = rankPathCandidates([mk('/a/b/c/deep.ts', 500), mk('/x.ts', 500)]);
    expect(r.candidates.map((c) => c.path)).toEqual(['/x.ts', '/a/b/c/deep.ts']);
  });

  it('同 mtime 同长度时按字典序，保证结果稳定可复现', () => {
    const r = rankPathCandidates([mk('/b.ts', 500), mk('/a.ts', 500)]);
    expect(r.candidates.map((c) => c.path)).toEqual(['/a.ts', '/b.ts']);
  });

  it('按规范化路径去重（反斜杠视为同一文件）', () => {
    const r = rankPathCandidates([
      { path: 'C:\\a\\b.ts', mtimeMs: 1 },
      { path: 'C:/a/b.ts', mtimeMs: 2 }
    ]);
    expect(r.candidates).toHaveLength(1);
    expect(r.total).toBe(1);
  });

  it('丢弃无路径的条目', () => {
    const r = rankPathCandidates([{ path: '' }, { path: '   ' }, mk('/ok.ts', 1), null]);
    expect(r.candidates.map((c) => c.path)).toEqual(['/ok.ts']);
  });

  it('按 maxCandidates 截断并报告 truncated / total', () => {
    const many = Array.from({ length: 30 }, (_, i) => mk(`/f${i}.ts`, i));
    const r = rankPathCandidates(many, { maxCandidates: 5 });
    expect(r.candidates).toHaveLength(5);
    expect(r.total).toBe(30);
    expect(r.truncated).toBe(true);
  });

  it('maxCandidates 受硬上限约束（防止超大列表拖垮 UI）', () => {
    const many = Array.from({ length: 200 }, (_, i) => mk(`/f${i}.ts`, i));
    const r = rankPathCandidates(many, { maxCandidates: 999 });
    expect(r.candidates).toHaveLength(MAX_CANDIDATE_LIMIT);
  });

  it('空输入返回空结果而不是抛错', () => {
    expect(rankPathCandidates([]).candidates).toEqual([]);
    expect(rankPathCandidates(null).candidates).toEqual([]);
  });
});
