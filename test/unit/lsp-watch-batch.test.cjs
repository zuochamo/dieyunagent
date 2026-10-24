'use strict';

/**
 * watch 批量诊断的队列语义（2026-10-17 卡死修复）。
 *
 * 背景：旧实现是「每个文件一个 450ms 定时器」，批量写文件时成百上千个定时器同一刻到期，
 * 串行跑完每个文件的完整诊断往返 —— 实测 855 个 .py 连跑约 90 秒，主线程排队到界面卡死。
 *
 * 这里守的是三个不变量：
 * 1. 多次事件合并进一个队列（pending 语义＝待诊断文件数，不是定时器数）；
 * 2. 同一文件重复触发只算一次；
 * 3. 单批不超过 WATCH_BATCH_MAX_FILES，队列总量不超过 WATCH_DIRTY_MAX_QUEUE。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { createLspDiagnosticsService } = require('../../src/lsp/diagnostics-service');

const BATCH_MAX = 24;
const QUEUE_MAX = 400;

let tmpRoot = '';
let userData = '';
let workspace = '';
let logs = [];
let service = null;

function makeService() {
  logs = [];
  return createLspDiagnosticsService({
    userDataPath: userData,
    log: (msg) => logs.push(String(msg))
  });
}

/** 造一批「看起来像代码、但实际不存在」的路径：drain 时 stat 失败会立刻返回，不起 LSP */
function fakeFiles(count, prefix) {
  const out = [];
  for (let i = 0; i < count; i += 1) {
    out.push(path.join(workspace, `${prefix}_${String(i).padStart(4, '0')}.py`));
  }
  return out;
}

async function waitUntil(fn, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return fn();
}

beforeAll(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dieyun-lsp-batch-'));
  userData = path.join(tmpRoot, 'userData');
  workspace = path.join(tmpRoot, 'ws');
  fs.mkdirSync(userData, { recursive: true });
  fs.mkdirSync(workspace, { recursive: true });
});

afterAll(() => {
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

beforeEach(() => {
  if (service) service.shutdown();
  service = makeService();
});

describe('LSP watch 批量诊断队列', () => {
  it('多个文件的同批事件合并进一个队列，pending 等于文件数', async () => {
    const files = fakeFiles(30, 'merge');
    for (const f of files) {
      await service.scheduleFileDiagnosticsRefresh(workspace, f, { debounceMs: 10 });
    }
    const status = service.getWatchStatus(workspace);
    expect(status.pending).toBe(30);
    // 队列入口同步返回，说明没有为每个文件单独安排一次等待
    expect(logs.filter((l) => l.includes('watch batch')).length).toBe(0);
  });

  it('同一文件重复触发只入队一次', async () => {
    const target = path.join(workspace, 'repeat.py');
    for (let i = 0; i < 5; i += 1) {
      await service.scheduleFileDiagnosticsRefresh(workspace, target, { debounceMs: 10 });
    }
    expect(service.getWatchStatus(workspace).pending).toBe(1);
  });

  it('排空时按单批上限切片，并留下汇总日志', async () => {
    const files = fakeFiles(30, 'batch');
    for (const f of files) {
      await service.scheduleFileDiagnosticsRefresh(workspace, f, { debounceMs: 10 });
    }
    // 注意：pending 在「批次元素被摘出队列」时就归零，此刻文件还在处理中，
    // 所以要等汇总日志出现，不能只等 pending === 0（否则会偶发读到空日志）。
    const done = await waitUntil(() => logs.some((l) => l.includes('watch batch')), 8000);
    expect(done).toBe(true);
    expect(service.getWatchStatus(workspace).pending).toBe(0);

    const batchLines = logs.filter((l) => l.includes('watch batch'));
    // 一次 drain 只留一条汇总行（不是每批一条），批次数写在同一行里
    expect(batchLines.length).toBe(1);
    const line = batchLines[0];
    expect(Number((line.match(/files=(\d+)/) || [])[1] || 0)).toBe(30);
    // 30 个文件 / 单批 24 ⇒ 2 批
    expect(Number((line.match(/batches=(\d+)/) || [])[1] || 0)).toBe(Math.ceil(30 / BATCH_MAX));
  });

  it('队列总量有硬上限，超出丢最旧的', async () => {
    const files = fakeFiles(QUEUE_MAX + 60, 'overflow');
    for (const f of files) {
      await service.scheduleFileDiagnosticsRefresh(workspace, f, { debounceMs: 60_000 });
    }
    expect(service.getWatchStatus(workspace).pending).toBe(QUEUE_MAX);
  });

  it('immediate 刷新会把该文件从队列里摘掉', async () => {
    const files = fakeFiles(3, 'imm');
    for (const f of files) {
      await service.scheduleFileDiagnosticsRefresh(workspace, f, { debounceMs: 60_000 });
    }
    expect(service.getWatchStatus(workspace).pending).toBe(3);
    await service.scheduleFileDiagnosticsRefresh(workspace, files[0], { immediate: true });
    expect(service.getWatchStatus(workspace).pending).toBe(2);
  });

  it('工作区外的路径不入队', async () => {
    const outside = path.join(tmpRoot, 'outside.py');
    await service.scheduleFileDiagnosticsRefresh(workspace, outside, { debounceMs: 10 });
    expect(service.getWatchStatus(workspace).pending).toBe(0);
  });

  it('stop 会清空队列，drain 不会再动它', async () => {
    const files = fakeFiles(40, 'stop');
    for (const f of files) {
      await service.scheduleFileDiagnosticsRefresh(workspace, f, { debounceMs: 5 });
    }
    service.stopWorkspaceDiagnosticsWatch(workspace);
    expect(service.getWatchStatus(workspace).pending).toBe(0);
    await new Promise((r) => setTimeout(r, 200));
    expect(service.getWatchStatus(workspace).active).toBe(false);
  });
});
