'use strict';

/**
 * 回归（2026-11-19 审计 P0-6）：主工作区脏文件与待应用变更的**路径口径必须能对上**。
 *
 * 主工作区的脏路径来自 `git status`（`-unormal`），未跟踪目录被折叠成一行 `docs/new/`；
 * 待应用的变更逐文件枚举（`ls-files --others` → `docs/new/note.md`）。
 * 精确匹配会让 `MAIN_DIRTY` 闸门恒不命中 → 静默覆盖用户还没提交的文件。
 */

const { isMainDirtyPath } = require('../../src/git/worktree-service');

describe('worktree main-dirty 判定', () => {
  it('精确同名命中', () => {
    expect(isMainDirtyPath(new Set(['src/a.js']), 'src/a.js')).toBe(true);
  });

  it('未跟踪目录被折叠成 docs/new/ 时，逐文件变更仍算命中', () => {
    expect(isMainDirtyPath(new Set(['docs/new/']), 'docs/new/note.md')).toBe(true);
    expect(isMainDirtyPath(new Set(['docs/new/']), 'docs/new/a/b/c.md')).toBe(true);
  });

  it('只共享前缀的兄弟目录不算命中（别把闸门开太大）', () => {
    expect(isMainDirtyPath(new Set(['docs/new/']), 'docs/newer/note.md')).toBe(false);
    expect(isMainDirtyPath(new Set(['docs/new/note.md']), 'docs/new/other.md')).toBe(false);
  });

  it('空集合 / 空路径安全', () => {
    expect(isMainDirtyPath(new Set(), 'src/a.js')).toBe(false);
    expect(isMainDirtyPath(null, 'src/a.js')).toBe(false);
    expect(isMainDirtyPath(new Set(['src/a.js']), '')).toBe(false);
  });
});
