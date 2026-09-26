'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  recordToolTelemetry,
  summarizeTelemetry,
  clearToolTelemetry,
  telemetryPath
} = require('../../src/agent/tool-telemetry');

function tempUserDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tool-telemetry-'));
}

describe('summarizeTelemetry', () => {
  it('文件不存在时返回全零（不抛）', () => {
    const s = summarizeTelemetry(tempUserDir());
    expect(s).toMatchObject({ total: 0, ok: 0, failed: 0, successRate: 0, byTool: [], topErrors: [] });
  });

  it('按工具聚合成功率，重复拦截与错误码单独计数', () => {
    const dir = tempUserDir();
    recordToolTelemetry(dir, { tool: 'fs_read_file', ok: true });
    recordToolTelemetry(dir, { tool: 'fs_read_file', ok: true });
    recordToolTelemetry(dir, { tool: 'fs_read_file', ok: false, errorCode: 'FS_READ_FAILED' });
    recordToolTelemetry(dir, { tool: 'rp', ok: false, errorCode: 'REPEAT_BLOCK' });

    const s = summarizeTelemetry(dir);
    expect(s.total).toBe(4);
    expect(s.ok).toBe(2);
    expect(s.failed).toBe(2);
    expect(s.successRate).toBe(50);
    expect(s.repeatBlocks).toBe(1);
    expect(s.byTool).toEqual([
      { tool: 'fs_read_file', total: 3, ok: 2, failed: 1, repeatBlocks: 0, successRate: 66.7 },
      { tool: 'rp', total: 1, ok: 0, failed: 1, repeatBlocks: 1, successRate: 0 }
    ]);
    expect(s.topErrors).toEqual([
      { errorCode: 'FS_READ_FAILED', count: 1 },
      { errorCode: 'REPEAT_BLOCK', count: 1 }
    ]);
  });
});

describe('clearToolTelemetry', () => {
  it('清空后汇总归零，缓冲里未落盘的行不会回灌，且后续记录照常可读', () => {
    const dir = tempUserDir();
    for (let i = 0; i < 5; i += 1) recordToolTelemetry(dir, { tool: 'fs_read_file', ok: true });
    expect(summarizeTelemetry(dir).total).toBe(5);

    expect(clearToolTelemetry(dir)).toBe(true);
    // 关键回归点：清空若只 truncate 不 flush，缓冲里的 5 行会被 summarize 的 flushLog
    // 写回来，这里就会读到 5 而不是 0。
    expect(summarizeTelemetry(dir).total).toBe(0);

    recordToolTelemetry(dir, { tool: 'rp', ok: true });
    expect(summarizeTelemetry(dir).total).toBe(1);
    expect(fs.readFileSync(telemetryPath(dir), 'utf8').trim().split('\n')).toHaveLength(1);
  });

  it('没有 userDataPath 时不动手，返回 false', () => {
    expect(clearToolTelemetry('')).toBe(false);
  });
});
