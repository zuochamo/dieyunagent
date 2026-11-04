'use strict';
/**
 * 回答里的媒体判定（`src/renderer/renderer-answer-figures.js`）。
 *
 * 守的语义：
 * 1. 只有「本地 / 工作区里的媒体路径」才当媒体渲染：外链、data:、file:、协议相对一律不渲染；
 * 2. 一条工具记录能渲染的媒体有三个来源（结构化 imagePaths / 落盘 path / base64 读图），
 *    失败与进行中的调用一律不算；
 * 3. 扩展名决定渲染体：图片走 `<img>`，音视频走 `<video>/<audio>` 的占位 + 可 seek URL；
 * 4. 一条回答最多显示 ANSWER_FIGURE_MAX 个（留**最后**几个），同图去重，其余给隐藏计数。
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const FIGURES_SRC = path.join(__dirname, '..', '..', 'src', 'renderer', 'renderer-answer-figures.js');
/** 与 renderer-artifacts.js:IMAGE_ARTIFACT_RE / MEDIA_ARTIFACT_RE 同口径（渲染器里它们是全局 var） */
const IMAGE_ARTIFACT_RE = /\.(png|jpe?g|gif|webp|bmp|svg|heic|tiff?|ico|avif)$/i;
const MEDIA_ARTIFACT_RE = /\.(mp4|m4v|webm|ogv|mov|mkv|mp3|wav|m4a|aac|ogg|oga|opus|flac)$/i;

function createElement(tag) {
  return {
    tagName: String(tag || 'div').toUpperCase(),
    dataset: {},
    children: [],
    appendChild(child) {
      this.children.push(child);
      return child;
    }
  };
}

function loadFigures(extra = {}) {
  const source = fs.readFileSync(FIGURES_SRC, 'utf8');
  const factory = new Function(
    'window',
    'document',
    'IMAGE_ARTIFACT_RE',
    'MEDIA_ARTIFACT_RE',
    'isImagePreviewToolCall',
    'toolArtifactPath',
    `${source}
     return { isRenderableAnswerMediaPath, answerFigurePlaceholderHtml, answerMediaKind,
              traceToolMediaPaths, answerMediaPathsForTrace, ANSWER_FIGURE_MAX };`
  );
  return factory(
    {},
    { createElement },
    IMAGE_ARTIFACT_RE,
    MEDIA_ARTIFACT_RE,
    extra.isImagePreviewToolCall,
    extra.toolArtifactPath
  );
}

const figures = loadFigures();

test('只认本地/工作区媒体路径，协议前缀一律不渲染', () => {
  const ok = figures.isRenderableAnswerMediaPath;
  assert.equal(ok('out/shot.png'), true);
  assert.equal(ok('.dieyun/tool-output/vision/ab/deadbeef.png'), true);
  assert.equal(ok('C:\\ws\\shot.png'), true);
  assert.equal(ok('/home/u/shot.png'), true);
  assert.equal(ok('  out/shot.png  '), true);
  assert.equal(ok('out/demo.mp4'), true);
  assert.equal(ok('out/voice.mp3'), true);

  assert.equal(ok('https://example.com/a.png'), false);
  assert.equal(ok('http://example.com/a.png'), false);
  assert.equal(ok('https://cdn.example.com/a.mp4'), false);
  assert.equal(ok('data:image/png;base64,AAAA'), false);
  assert.equal(ok('file:///C:/ws/shot.png'), false);
  assert.equal(ok('//cdn.example.com/a.png'), false);
  assert.equal(ok('notes.txt'), false);
  assert.equal(ok(''), false);
  assert.equal(ok(null), false);
});

test('扩展名决定渲染体：图片给 <img>，音视频给媒体占位（不塞 <img>）', () => {
  assert.equal(figures.answerMediaKind('out/a.mp4'), 'video');
  assert.equal(figures.answerMediaKind('out/a.mkv'), 'video');
  assert.equal(figures.answerMediaKind('out/a.mp3'), 'audio');
  assert.equal(figures.answerMediaKind('out/a.wav'), 'audio');
  assert.equal(figures.answerMediaKind('out/a.png'), '');

  const imgHtml = figures.answerFigurePlaceholderHtml('截图', 'out/a.png');
  assert.match(imgHtml, /<img class="answer-figure-img"/);
  assert.match(imgHtml, /data-answer-figure-src="out\/a\.png"/);
  assert.doesNotMatch(imgHtml, /data-answer-media-kind/);

  const videoHtml = figures.answerFigurePlaceholderHtml('演示', 'out/demo.mp4');
  assert.match(videoHtml, /data-answer-media-kind="video"/);
  assert.doesNotMatch(videoHtml, /<img/);
  assert.match(videoHtml, /answer-figure-cap">演示</);

  const audioHtml = figures.answerFigurePlaceholderHtml('', 'out/voice.mp3');
  assert.match(audioHtml, /data-answer-media-kind="audio"/);

  // 不能渲染的引用返回空串（交给正常文本/链接逻辑）
  assert.equal(figures.answerFigurePlaceholderHtml('', 'https://example.com/a.mp4'), '');
  assert.equal(figures.answerFigurePlaceholderHtml('', 'notes.txt'), '');
});

test('traceToolMediaPaths：结构化凭证 / 落盘路径 / 失败与进行中调用', () => {
  const fromHandles = figures.traceToolMediaPaths({
    name: 'computer',
    result: { imagePaths: ['.dieyun/tool-output/vision/ab/one.png', 'notes.txt'] }
  });
  assert.deepEqual(fromHandles, ['.dieyun/tool-output/vision/ab/one.png'], '非媒体扩展名要滤掉');

  const fromSave = figures.traceToolMediaPaths({
    name: 'browser_screenshot',
    result: { path: 'out/shot.png', savePath: 'out/shot.png' }
  });
  assert.deepEqual(fromSave, ['out/shot.png'], 'path 与 savePath 是同一张图，去重');

  // 音视频同样认结构化凭证（例如某个工具落了 mp4）
  assert.deepEqual(
    figures.traceToolMediaPaths({ name: 'computer', result: { imagePaths: ['out/demo.mp4'] } }),
    ['out/demo.mp4']
  );

  assert.deepEqual(figures.traceToolMediaPaths({ name: 'computer', failed: true, result: { imagePaths: ['a.png'] } }), []);
  assert.deepEqual(figures.traceToolMediaPaths({ name: 'computer', pending: true, result: { imagePaths: ['a.png'] } }), []);
  assert.deepEqual(figures.traceToolMediaPaths(null), []);
});

test('traceToolMediaPaths：账本里没有 result 时，截图工具靠 args 的存盘路径重建', () => {
  // 真实约束：agent_traces.trace_json 落库时会丢掉 result，只留 args。
  const replay = figures.traceToolMediaPaths({
    name: 'browser_screenshot',
    toolArgs: { filePath: 'out/shot.png' }
  });
  assert.deepEqual(replay, ['out/shot.png'], '历史 replay 也要能出图');

  // 非截图工具只因为 args 里带个 png 不算产图（读文件另有 base64 判定）
  assert.deepEqual(
    figures.traceToolMediaPaths({ name: 'grep', toolArgs: { filePath: 'out/shot.png' } }),
    []
  );
});

test('traceToolMediaPaths：base64 读图（模型把图给用户看过）走既有判定', () => {
  const withPreview = loadFigures({
    isImagePreviewToolCall: (tool) => tool && tool.name === 'fs_read_file',
    toolArtifactPath: () => 'out/chart.png'
  });
  const paths = withPreview.traceToolMediaPaths({ name: 'fs_read_file', toolArgs: { encoding: 'base64' } });
  assert.deepEqual(paths, ['out/chart.png']);

  // 判定不成立（例如文本模型读图）时不出图
  const without = figures.traceToolMediaPaths({ name: 'fs_read_file', toolArgs: { encoding: 'base64' } });
  assert.deepEqual(without, []);
});

test('answerMediaPathsForTrace：去重 + 只留最后几个 + 隐藏计数', () => {
  const trace = [
    { tools: [{ name: 'computer', result: { imagePaths: ['a.png'] } }] },
    { tools: [{ name: 'computer', result: { imagePaths: ['b.png'] } }] },
    { tools: [{ name: 'computer', result: { imagePaths: ['a.png', 'c.png'] } }] },
    { tools: [{ name: 'computer', result: { imagePaths: ['d.png'] } }] },
    { tools: [{ name: 'computer', result: { imagePaths: ['e.png'] } }] }
  ];
  const r = figures.answerMediaPathsForTrace(trace);
  assert.equal(r.paths.length, figures.ANSWER_FIGURE_MAX, '一条回答最多显示 ANSWER_FIGURE_MAX 个');
  assert.deepEqual(r.paths, ['c.png', 'd.png', 'e.png'], '保留最后几个（最新画面）');
  assert.equal(r.hidden, 2, '超出上限的数量要能提示去产物面板');

  assert.deepEqual(figures.answerMediaPathsForTrace(null), { paths: [], hidden: 0 });
  assert.deepEqual(figures.answerMediaPathsForTrace([]), { paths: [], hidden: 0 });
});
