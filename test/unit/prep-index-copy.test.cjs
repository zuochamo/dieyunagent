'use strict';
/**
 * 准备区索引文案（`src/renderer/renderer-agent-prep.js:formatPrepIndexProgress`）。
 *
 * 守的是「别把两种状态说成一句话」：
 * 1. `indexed=false` 才是**创建**（从零建库）；`indexed=true` 只是**增量更新**，
 *    这时写「创建中」会让用户看到「面板上明明建好了、准备区却在创建」而当成 bug；
 * 2. 文案必须带主语：远端会话的索引在它自己的 worktree 里（另一份 `index.sqlite`），
 *    只写「创建中」看不出是哪一份，才导致 2026-10-29 那次误判；
 * 3. 有进度就带上（远端通常只有 done、没有 total，两种形态都要能显示）。
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = path.join(__dirname, '..', '..', 'src', 'renderer', 'renderer-agent-prep.js');

function loadFormatPrepIndexProgress() {
  const source = fs.readFileSync(SRC, 'utf8');
  const window = {};
  const factory = new Function('window', `${source}\n;return window.formatPrepIndexProgress;`);
  const fn = factory(window);
  assert.equal(typeof fn, 'function', 'formatPrepIndexProgress 必须挂到 window 上');
  return fn;
}

const format = loadFormatPrepIndexProgress();

describe('准备区索引文案', () => {
  it('库里没有索引 → 创建中', () => {
    const s = format({ indexed: false, indexing: true }, 'codebase', 'creating');
    assert.match(s, /本会话工作区代码索引创建中/);
    assert.match(s, /本次不等待/);
  });

  it('库里已有索引、只是在刷新 → 更新中（不是创建中）', () => {
    const s = format({ indexed: true, indexing: true }, 'graph', 'creating');
    assert.match(s, /本会话工作区结构索引更新中/);
    assert.doesNotMatch(s, /创建中/);
  });

  it('有进度就带上；只有 done 没有 total 也能显示', () => {
    // 不带括号：skipped 行整体会渲染成 `label（detail）`，detail 内再套括号就是双层
    assert.match(
      format({ indexed: false, indexing: true, filesDone: 12, filesTotal: 222 }, 'codebase', 'creating'),
      / · 12\/222 文件/
    );
    assert.match(
      format({ indexed: true, indexing: true, filesDone: 7 }, 'graph', 'creating'),
      / · 7 文件/
    );
    assert.doesNotMatch(format({ indexed: true, indexing: true }, 'graph', 'creating'), /文件/);
  });

  it('本轮刚发起（还没拿到状态）不说成「正在创建」', () => {
    const s = format(null, 'codebase', 'started');
    assert.match(s, /已发起本会话工作区代码索引建库/);
    assert.doesNotMatch(s, /创建中/);
  });
});
