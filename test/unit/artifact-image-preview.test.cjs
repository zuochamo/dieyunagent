'use strict';
/**
 * 「聊天里展示过的图片」必须进产物区。
 *
 * 复现的问题：Agent 让 UE 渲染 / ffmpeg / PIL 生成了一张图，通过 `fs_read_file`
 * 以 base64 读进视觉通道展示给用户 —— 聊天里能看到图，但产物区（`sessionArtifacts`）
 * 只收 `fs_write_file` / `fs_edit`，图片不在列表里。
 *
 * `src/renderer/renderer-artifacts.js` 是纯浏览器脚本，这里用 `new Function`
 * 造环境，把真实的 `trackArtifactsFromTrace` 取出来，断言哪些调用会被收录。
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = path.join(__dirname, '..', '..', 'src', 'renderer', 'renderer-artifacts.js');
const IMAGE_RE = /\.(png|jpe?g|gif|webp|bmp|svg|heic|tiff?|ico|avif)$/i;

function loadTracker() {
  const tracked = [];
  const source = fs.readFileSync(SRC, 'utf8');

  // renderer 脚本共享全局作用域：文件末尾 `window.X = Y` 会引用别的文件里的 Y。
  // 单独加载本文件时，这些 Y 必须作为桩注入，否则顶层语句直接 ReferenceError。
  const declared = new Set();
  for (const m of source.matchAll(/^(?:function|var|const|let)\s+(\w+)/gm)) declared.add(m[1]);
  const externals = [];
  for (const m of source.matchAll(/^window\.(\w+) = (\w+);/gm)) {
    if (!declared.has(m[2]) && !externals.includes(m[2])) externals.push(m[2]);
  }

  const stubs = {
    isEditToolName: (name) => ['fs_write_file', 'fs.edit_file'].indexOf(String(name)) >= 0,
    isDeleteToolName: () => false,
    artifactPathFromTool: (tool) => String((tool.toolArgs && tool.toolArgs.filePath) || ''),
    resolveArtifactSessionId: () => 's-test',
    isVisibleArtifactSession: () => true,
    refreshLastRoundFileChangesForSession: () => {},
    trackArtifact: (p, meta) => tracked.push({ path: p, ...meta }),
    toolDiffHasBody: (d) => !!(d && (d.beforeSnippet || d.afterSnippet)),
    parseDiffFromSummary: () => null,
    scheduleArtifactsUiRefresh: () => {},
    followArtifactEditorOnWrite: () => {}
  };

  const names = Array.from(new Set([...externals, ...Object.keys(stubs)]));
  const factory = new Function(
    'window',
    'document',
    ...names,
    `${source}
     return { track: trackArtifactsFromTrace, isPreview: isImagePreviewToolCall };`
  );
  const args = names.map((n) => stubs[n] || function () {});
  const api = factory({}, { getElementById: () => null, querySelectorAll: () => [] }, ...args);
  return { api, tracked };
}

function traceWith(tool) {
  return [{ round: 1, tools: [tool] }];
}

describe('产物区采集：展示过的图片', () => {
  test('base64 读图片成功 → 收录', () => {
    const { api, tracked } = loadTracker();
    api.track(
      traceWith({
        name: 'fs_read_file',
        failed: false,
        pending: false,
        toolArgs: { filePath: 'reference/ue5/ep02/preview-main-small.jpg', encoding: 'base64' }
      })
    );
    assert.deepEqual(
      tracked.map((t) => t.path),
      ['reference/ue5/ep02/preview-main-small.jpg']
    );
    assert.equal(tracked[0].diff, null, '图片没有 diff');
    assert.equal(tracked[0].countTotals, false, '不参与文件变更统计');
  });

  test('读图失败（IMAGE_TOO_LARGE）→ 不收录', () => {
    const { api, tracked } = loadTracker();
    api.track(
      traceWith({
        name: 'fs_read_file',
        failed: true,
        pending: false,
        toolArgs: { filePath: 'reference/ue5/ep02/preview-main.png', encoding: 'base64' }
      })
    );
    assert.deepEqual(tracked, []);
  });

  test('非 base64 读（只取文本）→ 不收录', () => {
    const { api, tracked } = loadTracker();
    api.track(
      traceWith({
        name: 'fs_read_file',
        failed: false,
        toolArgs: { filePath: 'shot.png', encoding: 'utf8' }
      })
    );
    assert.deepEqual(tracked, []);
  });

  test('base64 读非图片 → 不收录', () => {
    const { api, tracked } = loadTracker();
    api.track(
      traceWith({
        name: 'fs_read_file',
        failed: false,
        toolArgs: { filePath: 'notes.md', encoding: 'base64' }
      })
    );
    assert.deepEqual(tracked, []);
  });

  test('写工具行为不变（回归）', () => {
    const { api, tracked } = loadTracker();
    api.track(
      traceWith({
        name: 'fs_write_file',
        failed: false,
        toolArgs: { filePath: 'shows/ep02/SCENE.md' }
      })
    );
    assert.deepEqual(
      tracked.map((t) => t.path),
      ['shows/ep02/SCENE.md']
    );
  });

  test('isImagePreviewToolCall 只认 base64 + 图片扩展名', () => {
    const { api } = loadTracker();
    assert.equal(
      api.isPreview({ name: 'fs_read_file', toolArgs: { filePath: 'a.PNG', encoding: 'base64' } }, 'a.PNG'),
      true
    );
    assert.equal(
      api.isPreview({ name: 'fs_read_file', toolArgs: { filePath: 'a.md', encoding: 'base64' } }, 'a.md'),
      false
    );
    assert.equal(
      api.isPreview({ name: 'fs_write_file', toolArgs: { filePath: 'a.png', encoding: 'base64' } }, 'a.png'),
      false
    );
  });

  test('图片扩展名正则覆盖常见格式', () => {
    for (const ext of ['png', 'jpg', 'jpeg', 'webp', 'svg', 'bmp', 'avif']) {
      assert.equal(IMAGE_RE.test('x.' + ext), true, ext);
    }
    assert.equal(IMAGE_RE.test('x.md'), false);
  });
});
