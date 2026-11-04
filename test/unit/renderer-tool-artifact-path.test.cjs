'use strict';
/**
 * `toolArtifactPath()` 的「读类工具也要给路径」契约（`src/renderer/renderer-artifacts-session.js`）。
 *
 * 守的是一个真实翻过的车：它先无条件 `return artifactPathFromTool(tool)`，而那个函数
 * 只认写/删工具、对 `fs_read_file` 按设计返回空 —— 于是任何依赖它拿「读过的文件路径」的
 * 功能都静默失效（首当其冲是「用户看过的图片」：base64 读完图能显示，但永远拿不到路径）。
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const DIR = path.join(__dirname, '..', '..', 'src', 'renderer');

function fakeEl() {
  return {
    dataset: {},
    style: {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    appendChild(c) {
      return c;
    },
    append() {},
    replaceChildren() {},
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {},
    removeEventListener() {},
    setAttribute() {},
    remove() {},
    insertBefore() {},
    getBoundingClientRect: () => ({ top: 0, left: 0, width: 0, height: 0 })
  };
}

function load(file, returnExpr, globals = {}) {
  const source = fs.readFileSync(path.join(DIR, file), 'utf8');
  const names = ['window', 'document', ...Object.keys(globals)];
  const values = [globals.window || zeroWindow(), fakeDocument(), ...Object.values(globals)];
  const factory = new Function(...names, `${source}\nreturn { ${returnExpr} };`);
  return factory(...values);
}

function zeroWindow() {
  return { addEventListener() {}, removeEventListener() {} };
}

function fakeDocument() {
  return {
    createElement: () => fakeEl(),
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {},
    body: fakeEl(),
    documentElement: fakeEl()
  };
}

const toolResults = load('renderer-tool-results.js', 'isPlausibleArtifactPath, editToolFilePath, isEditToolName');
// `isDeleteToolName` 住在 artifacts-session 里，而 artifacts-session 又依赖 artifactPathFromTool：
// 先单独取它一次，再按真实依赖顺序装配（沙箱互相独立，重复加载不共享状态）。
const namesOnly = load('renderer-artifacts-session.js', 'isDeleteToolName');
const diffView = load('renderer-artifact-diff-view.js', 'artifactPathFromTool', {
  isEditToolName: toolResults.isEditToolName,
  isDeleteToolName: namesOnly.isDeleteToolName,
  editToolFilePath: toolResults.editToolFilePath
});
const sessions = load('renderer-artifacts-session.js', 'toolArtifactPath', {
  artifactPathFromTool: diffView.artifactPathFromTool,
  isPlausibleArtifactPath: toolResults.isPlausibleArtifactPath,
  editToolFilePath: toolResults.editToolFilePath,
  isEditToolName: toolResults.isEditToolName,
  isDeleteToolName: namesOnly.isDeleteToolName,
  sessionArtifacts: []
});

test('读类工具（fs_read_file 看图）的路径来自 args，不会被写/删工具的分支挡掉', () => {
  const p = sessions.toolArtifactPath({
    name: 'fs_read_file',
    toolArgs: { encoding: 'base64', filePath: '数据导入/shots/03-发票开具.png' }
  });
  assert.equal(p, '数据导入/shots/03-发票开具.png');
});

test('写工具的路径仍归 artifactPathFromTool（唯一来源不变）', () => {
  const p = sessions.toolArtifactPath({
    name: 'fs_edit',
    toolArgs: { filePath: 'src/a.js', edits: [] }
  });
  assert.equal(p, 'src/a.js');
});

test('结果里带 path 时优先用结果，且明显不像路径的文本被拒', () => {
  assert.equal(
    sessions.toolArtifactPath({ name: 'browser_screenshot', result: { path: 'out/shot.png' } }),
    'out/shot.png'
  );
  assert.equal(
    sessions.toolArtifactPath({ name: 'fs_read_file', toolArgs: { filePath: 'const x = 1;' } }),
    ''
  );
});
