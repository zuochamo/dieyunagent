'use strict';
/**
 * 远端「清理占库进程」的归属判定：只允许清理**孤儿**（父进程已是 init）。
 *
 * 背景：`fuser <index.sqlite>` 只回答「谁持有这个文件」。按 PID 盲杀会把另一个
 * App 实例正在用的 core 也杀掉，两边互相重启 —— 原事故的加速器。
 */
const assert = require('node:assert/strict');
const {
  selectStaleCoreHolders
} = require('../../src/remote/remote-index-core');

const CORE = '/home/u/.dieyun/remote-agent/1.2.3/bin/dieyun-core serve-stdio';

/** @param {Record<number, {cmdline?: string, ppid?: number} | null>} table */
function probeFrom(table) {
  return (pid) => (Object.prototype.hasOwnProperty.call(table, pid) ? table[pid] : null);
}

describe('selectStaleCoreHolders', () => {
  it('孤儿 core（ppid=1）才清', () => {
    const r = selectStaleCoreHolders({
      pids: ['42'],
      selfPid: 999,
      probe: probeFrom({ 42: { cmdline: CORE, ppid: 1 } })
    });
    assert.deepEqual(r.kill, [42]);
    assert.deepEqual(r.skip, []);
  });

  it('有监督者的 core 不碰（那是别的实例正在用的）', () => {
    const r = selectStaleCoreHolders({
      pids: [42],
      selfPid: 999,
      probe: probeFrom({ 42: { cmdline: CORE, ppid: 1234 } })
    });
    assert.deepEqual(r.kill, []);
    assert.deepEqual(r.skip, [{ pid: 42, reason: 'supervised' }]);
  });

  it('不是 dieyun-core 的持库者不碰（sqlite3 / 备份脚本）', () => {
    const r = selectStaleCoreHolders({
      pids: [7, 8],
      selfPid: 999,
      probe: probeFrom({
        7: { cmdline: 'sqlite3 /home/u/proj/.dieyun/index.sqlite', ppid: 1 },
        8: { cmdline: '/bin/tar -czf backup.tgz .dieyun', ppid: 1 }
      })
    });
    assert.deepEqual(r.kill, []);
    assert.deepEqual(
      r.skip.map((s) => s.reason),
      ['not_dieyun_core', 'not_dieyun_core']
    );
  });

  it('不杀自己', () => {
    const r = selectStaleCoreHolders({
      pids: [process.pid],
      selfPid: process.pid,
      probe: probeFrom({ [process.pid]: { cmdline: CORE, ppid: 1 } })
    });
    assert.deepEqual(r.kill, []);
    assert.deepEqual(r.skip, [{ pid: process.pid, reason: 'self' }]);
  });

  it('读不到 /proc（非 Linux、无权限、已退出）一律不杀', () => {
    const r = selectStaleCoreHolders({
      pids: [42, 43],
      selfPid: 999,
      probe: (pid) => (pid === 42 ? null : { cmdline: CORE, ppid: 1 })
    });
    assert.deepEqual(r.kill, [43], '读不到的那个必须放过，能读到的孤儿才清');
    assert.deepEqual(r.skip, [{ pid: 42, reason: 'unknown_pid' }]);
  });

  it('ppid 缺失当成「有监督者」，宁可不杀', () => {
    const r = selectStaleCoreHolders({
      pids: [42],
      selfPid: 999,
      probe: probeFrom({ 42: { cmdline: CORE } })
    });
    assert.deepEqual(r.kill, []);
  });

  it('脏输入（重复、0、负数、非数字）不影响判定', () => {
    const r = selectStaleCoreHolders({
      pids: ['42', 42, 0, -5, 'abc', '', null],
      selfPid: 999,
      probe: probeFrom({ 42: { cmdline: CORE, ppid: 1 } })
    });
    assert.deepEqual(r.kill, [42], '同一个 pid 只清一次');
  });

  it('probe 抛错不许把整次清理搞崩', () => {
    const r = selectStaleCoreHolders({
      pids: [42],
      selfPid: 999,
      probe: () => {
        throw new Error('boom');
      }
    });
    assert.deepEqual(r.kill, []);
  });

  it('空列表返回空结果', () => {
    const r = selectStaleCoreHolders({ pids: [], selfPid: 1, probe: () => null });
    assert.deepEqual(r, { kill: [], skip: [] });
    assert.deepEqual(selectStaleCoreHolders({ pids: null, probe: () => null }).kill, []);
  });
});
