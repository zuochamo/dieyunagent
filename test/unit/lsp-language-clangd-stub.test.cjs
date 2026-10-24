'use strict';

/**
 * B3：C/C++（clangd）语言注册 + Python 类型存根（bpy）注入。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  getLanguageIdForPath,
  getServerKeyForLanguage,
  getServerSpec,
  isLanguageServable,
  pythonStubDir
} = require('../../src/lsp/language-registry');
const { pyrightProjectArgs, hasOwnPyrightConfig } = require('../../src/lsp/cli-fallback');

describe('C/C++ 语言注册（clangd）', () => {
  it('常见源码扩展名都归到 cpp/c/cuda', () => {
    expect(getLanguageIdForPath('a.cpp')).toBe('cpp');
    expect(getLanguageIdForPath('a.h')).toBe('cpp');
    expect(getLanguageIdForPath('a.hpp')).toBe('cpp');
    expect(getLanguageIdForPath('a.c')).toBe('c');
    expect(getLanguageIdForPath('kernel.cu')).toBe('cuda');
  });

  it('cpp 映射到 clangd，且 spec 是可覆盖的 PATH 命令', () => {
    expect(getServerKeyForLanguage('cpp')).toBe('clangd');
    const spec = getServerSpec('clangd', os.tmpdir(), os.tmpdir());
    expect(spec.command).toBe('clangd');
    expect(spec.shell).toBe(false);
  });

  it('isLanguageServable 取代旧的 ts+python 白名单', () => {
    expect(isLanguageServable('D:/proj/Source/A.cpp')).toBe(true);
    expect(isLanguageServable('D:/proj/main.py')).toBe(true);
    expect(isLanguageServable('D:/proj/main.rs')).toBe(true);
    expect(isLanguageServable('D:/proj/readme.md')).toBe(false);
    // tsserver 把工程配置当文档打开会报 Unexpected resource
    expect(isLanguageServable('D:/proj/tsconfig.json')).toBe(false);
  });
});

describe('Python 类型存根（bpy stub）', () => {
  let stubDir;
  let bareProject;
  let configuredProject;

  beforeEach(() => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'dy-stub-'));
    stubDir = pythonStubDir(base);
    fs.mkdirSync(path.join(stubDir, 'bpy-stubs'), { recursive: true });
    fs.writeFileSync(path.join(stubDir, 'bpy-stubs', '__init__.pyi'), 'ops: object\n', 'utf8');

    bareProject = fs.mkdtempSync(path.join(os.tmpdir(), 'dy-bare-'));
    configuredProject = fs.mkdtempSync(path.join(os.tmpdir(), 'dy-conf-'));
    fs.writeFileSync(path.join(configuredProject, 'pyrightconfig.json'), '{}', 'utf8');
  });

  it('存根目录存在且项目没有自己的配置 → 注入 --project', () => {
    const args = pyrightProjectArgs(bareProject, stubDir);
    expect(args[0]).toBe('--project');
    const cfg = JSON.parse(fs.readFileSync(args[1], 'utf8'));
    expect(cfg.stubPath).toBe(stubDir);
    expect(cfg.extraPaths).toContain(stubDir);
    // stub-only 包没有 .py 实现，必须关掉这条误报
    expect(cfg.reportMissingModuleSource).toBe('none');
  });

  it('项目自己有 pyrightconfig.json 时不覆盖（交回项目口径）', () => {
    expect(hasOwnPyrightConfig(configuredProject)).toBe(true);
    expect(pyrightProjectArgs(configuredProject, stubDir)).toEqual([]);
  });

  it('存根目录不存在时返回空参数', () => {
    expect(pyrightProjectArgs(bareProject, path.join(stubDir, 'not-exist'))).toEqual([]);
    expect(pyrightProjectArgs(bareProject, '')).toEqual([]);
  });
});
