'use strict';
/**
 * 远程诊断「没跑起来」必须与「跑完没问题」可区分。
 *
 * 背景（2026-10-23 改进清单 AGT-01）：`[diagnostics] project scan ssh://… files=0 errors=0`
 * 被读成「一个文件都没扫到」，实际 `files=` 是「有诊断的文件数」。真正的缺陷在别处：
 *   1) 每条远程命令都拼 `; exit 0`，退出码被丢掉；
 *   2) eslint/ruff 的 JSON 解析失败直接返回 `[]`，与「零问题」不可区分；
 *   3) 四个引擎无条件全跑，非 JS/Python 仓库必然产出四个空结果。
 * 修法：保留退出码 + 要求 JSON 数组存在 + 探测项目类型后再选引擎。
 *
 * 这里钉住 1、2 两条（3 在 diagnostics-service 里，靠一次 ls 探测）。
 */
const assert = require('node:assert/strict');

const {
  runRemoteEslintProjectScan,
  runRemoteRuffProjectScan,
  runRemoteTscProjectScan,
  runRemotePrettierProjectScan,
  runRemoteEslintBatch,
  runRemoteRuffBatch,
  runRemoteTscBatch,
  runRemotePrettierBatch
} = require('../../src/lsp/cli-fallback.js');

const ROOT = '/srv/app';
const base = { projectRoot: ROOT, workspaceRoot: ROOT, timeoutMs: 5000 };

function execReturning(text, code) {
  return async () => ({ stdout: text, stderr: '', code });
}

describe('远程 eslint/ruff：没有 JSON = 没跑起来', () => {
  it('eslint 干净时输出 [] → ok，items 为空，scannedFiles=0', async () => {
    const r = await runRemoteEslintProjectScan({ ...base, exec: execReturning('[]', 0) });
    assert.equal(r.ok, true);
    assert.deepEqual(r.items, []);
    assert.equal(r.scannedFiles, 0);
  });

  it('eslint 有诊断 → 正常解析', async () => {
    const json = JSON.stringify([
      { filePath: `${ROOT}/a.js`, messages: [{ severity: 2, line: 3, column: 1, message: 'boom', ruleId: 'x/y' }] }
    ]);
    const r = await runRemoteEslintProjectScan({ ...base, exec: execReturning(json, 1) });
    assert.equal(r.ok, true);
    assert.equal(r.items.length, 1);
    assert.equal(r.items[0].file, `${ROOT}/a.js`);
  });

  it('eslint 只吐 npx 报错 → ok:false（以前这里会被当成 0 个问题）', async () => {
    const err = 'npm error could not determine executable to run\nnpm error A complete log...';
    const r = await runRemoteEslintProjectScan({ ...base, exec: execReturning(err, 1) });
    assert.equal(r.ok, false);
    assert.equal(r.engine, 'eslint');
    assert.match(r.error, /未产生 JSON/);
    assert.match(r.detail, /could not determine executable/);
    assert.equal(r.exitCode, 1);
  });

  it('ruff 没有 JSON → ok:false', async () => {
    const r = await runRemoteRuffProjectScan({ ...base, exec: execReturning('npx: command not found', 127) });
    assert.equal(r.ok, false);
    assert.match(r.error, /未产生 JSON/);
  });

  it('ruff 干净 → ok', async () => {
    const r = await runRemoteRuffProjectScan({ ...base, exec: execReturning('[]', 0) });
    assert.equal(r.ok, true);
    assert.deepEqual(r.items, []);
  });
});

describe('远程 tsc / prettier：用退出码判定，不靠关键词', () => {
  it('tsc 零输出 + exit 0 → 干净', async () => {
    const r = await runRemoteTscProjectScan({ ...base, exec: execReturning('', 0) });
    assert.equal(r.ok, true);
    assert.deepEqual(r.items, []);
  });

  it('tsc 零诊断但 exit 127 → ok:false', async () => {
    const r = await runRemoteTscProjectScan({ ...base, exec: execReturning('sh: npx: not found', 127) });
    assert.equal(r.ok, false);
    assert.match(r.error, /退出码 127/);
  });

  it('tsc 有诊断且 exit 1 → ok（有错是正常结果）', async () => {
    const out = 'a.ts(3,1): error TS2322: Type is not assignable.';
    const r = await runRemoteTscProjectScan({ ...base, exec: execReturning(out, 1) });
    assert.equal(r.ok, true);
    assert.equal(r.items.length, 1);
  });

  it('prettier exit 1（有文件待格式化）不算失败', async () => {
    const r = await runRemotePrettierProjectScan({ ...base, exec: execReturning('a.js\n', 1) });
    assert.equal(r.ok, true);
  });

  it('prettier exit 2（执行出错）→ ok:false', async () => {
    const r = await runRemotePrettierProjectScan({ ...base, exec: execReturning('Cannot find module prettier', 2) });
    assert.equal(r.ok, false);
    assert.match(r.error, /退出码 2/);
  });
});

/**
 * 批量路径（单文件/多文件诊断）此前完全不判失败：上层 `.catch(() => new Map())`
 * 把「引擎没跑起来」变成「这个文件没有诊断」⇒ 面板显示干净。
 * 现在批量函数返回 `{ok, byFile}`，失败必须显式化。
 */
describe('远程批量路径：失败必须显式，不许回空 Map', () => {
  const batchBase = { projectRoot: ROOT, timeoutMs: 5000 };

  it('eslint 批量：npx 报错（无 JSON）→ ok:false', async () => {
    const r = await runRemoteEslintBatch({
      ...batchBase,
      absPaths: [`${ROOT}/a.js`],
      exec: execReturning('npm error could not determine executable to run', 1)
    });
    assert.equal(r.ok, false);
    assert.equal(r.engine, 'eslint');
    assert.equal(r.byFile.size, 0);
    assert.match(r.error, /未产生 JSON/);
  });

  it('eslint 批量：干净时输出 [] → ok 且该文件诊断为空', async () => {
    const r = await runRemoteEslintBatch({
      ...batchBase,
      absPaths: [`${ROOT}/a.js`],
      exec: execReturning('[]', 0)
    });
    assert.equal(r.ok, true);
    assert.deepEqual(r.byFile.get(`${ROOT}/a.js`), []);
  });

  it('ruff 批量：无 JSON → ok:false', async () => {
    const r = await runRemoteRuffBatch({
      ...batchBase,
      absPaths: [`${ROOT}/a.py`],
      exec: execReturning('npx: command not found', 127)
    });
    assert.equal(r.ok, false);
    assert.equal(r.engine, 'ruff');
  });

  it('tsc 批量：零诊断 + exit 127 → ok:false（以前返回空 Map）', async () => {
    const r = await runRemoteTscBatch({
      ...batchBase,
      absPaths: [`${ROOT}/a.ts`],
      exec: execReturning('sh: npx: not found', 127)
    });
    assert.equal(r.ok, false);
    assert.match(r.error, /退出码 127/);
  });

  it('tsc 批量：正常诊断 → ok，按文件归位', async () => {
    const out = 'a.ts(3,1): error TS2322: Type is not assignable.';
    const r = await runRemoteTscBatch({
      ...batchBase,
      absPaths: [`${ROOT}/a.ts`],
      exec: execReturning(out, 1)
    });
    assert.equal(r.ok, true);
    assert.equal(r.byFile.get(`${ROOT}/a.ts`).length, 1);
  });

  it('prettier 批量：exit 1（待格式化）是正常结果', async () => {
    const r = await runRemotePrettierBatch({
      ...batchBase,
      absPaths: [`${ROOT}/a.js`],
      exec: execReturning('[warn] a.js\n[warn] Code style issues found', 1)
    });
    assert.equal(r.ok, true);
    assert.equal(r.byFile.get(`${ROOT}/a.js`).length, 1);
  });

  it('prettier 批量：exit 2（执行出错）→ ok:false', async () => {
    const r = await runRemotePrettierBatch({
      ...batchBase,
      absPaths: [`${ROOT}/a.js`],
      exec: execReturning('Cannot find module prettier', 2)
    });
    assert.equal(r.ok, false);
    assert.match(r.error, /执行失败/);
  });
});

describe('scannedFiles 口径：按文件去重，不按诊断条数', () => {
  it('ruff 一个文件 2 条诊断 → scannedFiles=1（以前报 2）', async () => {
    const json = JSON.stringify([
      { filename: `${ROOT}/a.py`, code: 'E501', message: 'line too long', location: { row: 1, column: 1 } },
      { filename: `${ROOT}/a.py`, code: 'F401', message: 'unused import', location: { row: 2, column: 1 } }
    ]);
    const r = await runRemoteRuffProjectScan({ ...base, exec: execReturning(json, 1) });
    assert.equal(r.ok, true);
    assert.equal(r.rawCount, 2);
    assert.equal(r.scannedFiles, 1);
  });

  it('eslint 两个文件 → scannedFiles=2', async () => {
    const json = JSON.stringify([
      { filePath: `${ROOT}/a.js`, messages: [{ severity: 2, line: 1, column: 1, message: 'x', ruleId: 'r' }] },
      { filePath: `${ROOT}/b.js`, messages: [{ severity: 1, line: 1, column: 1, message: 'y', ruleId: 'r' }] }
    ]);
    const r = await runRemoteEslintProjectScan({ ...base, exec: execReturning(json, 1) });
    assert.equal(r.ok, true);
    assert.equal(r.scannedFiles, 2);
  });
});
