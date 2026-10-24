'use strict';

/**
 * Windows 下 `cmd.exe /d /s /c` 的命令行拼装（2026-10-17 修复）。
 *
 * 事故形态：`['npx', ...args].join(' ')` 在 `--project C:\Users\John Smith\...`
 * 这类路径上把参数劈成两个，pyright 参数错误退出 → 上层只看到空诊断，
 * Python 的 CLI 兜底链路整条静默消失。
 */

const { quoteCmdArg, buildCmdLine } = require('../../src/lsp/spawn-args');

describe('cmd 命令行引号', () => {
  it('含空格的参数加引号', () => {
    expect(quoteCmdArg('C:\\Users\\John Smith\\a.json')).toBe('"C:\\Users\\John Smith\\a.json"');
  });

  it('不含特殊字符的参数保持原样', () => {
    expect(quoteCmdArg('pyright')).toBe('pyright');
    expect(quoteCmdArg('--project')).toBe('--project');
    expect(quoteCmdArg('C:\\tmp\\a.json')).toBe('C:\\tmp\\a.json');
  });

  it('中文路径不加引号也是安全的（无空格无 cmd 元字符）', () => {
    expect(quoteCmdArg('C:\\用户\\配置.json')).toBe('C:\\用户\\配置.json');
  });

  it('cmd 元字符（& | < > ^）也必须加引号', () => {
    expect(quoteCmdArg('a&b')).toBe('"a&b"');
    expect(quoteCmdArg('a|b')).toBe('"a|b"');
  });

  it('内部双引号按 cmd 语义双写转义', () => {
    expect(quoteCmdArg('a"b')).toBe('"a""b"');
  });

  it('空参数给出空串占位，避免吞掉位置', () => {
    expect(quoteCmdArg('')).toBe('""');
  });

  it('整条命令行：路径带空格的 --project 仍是一个参数', () => {
    const line = buildCmdLine('npx', ['pyright', '--project', 'C:\\Users\\John Smith\\lsp-stubs\\c.json']);
    expect(line).toBe('npx pyright --project "C:\\Users\\John Smith\\lsp-stubs\\c.json"');
  });
});
