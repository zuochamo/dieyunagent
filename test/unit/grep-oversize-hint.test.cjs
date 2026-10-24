'use strict';
/**
 * grep 的「静默跳过」必须变成可诊断的提示。
 *
 * 背景（实测）：`rg --max-filesize 1M` 与 JS 兜底的 `scanOneFileForGrep` 都会跳过 >1MB 文件，
 * 且不给任何提示。工程里存在 571MB 的 UE 日志，模型搜报错原文拿到 0 命中后，
 * 会得出「日志里没有这个错误」的错误结论——比直接报错昂贵得多。
 *
 * 这里钉住三件事：
 *   1) 0 命中且存在超大文件 → 结果里带 oversizeSkipped + 可执行 note
 *   2) 有命中 → 不额外扫描、不加字段（零开销）
 *   3) 没有超大文件 → 不加字段（不制造噪音）
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { grepWorkspace, probeOversizeFiles, MAX_FILE_BYTES } = require('../../src/gateway/rg-search.js');

const ROOT = path.resolve(os.tmpdir(), 'dieyun-grep-oversize-test');

async function resetRoot() {
  await fsp.rm(ROOT, { recursive: true, force: true });
  await fsp.mkdir(ROOT, { recursive: true });
}

describe('grep 超大文件提示', () => {
  it('0 命中且有大文件时给出 oversizeSkipped 与可执行提示', async () => {
    await resetRoot();
    await fsp.writeFile(path.join(ROOT, 'small.txt'), 'nothing interesting\n', 'utf8');
    // 1.2MB：超过 MAX_FILE_BYTES，rg 与 JS 兜底都会跳过
    await fsp.writeFile(path.join(ROOT, 'huge.log'), 'x'.repeat(1.2 * 1024 * 1024), 'utf8');

    const res = await grepWorkspace(ROOT, { pattern: 'FATAL_ERROR_NOT_PRESENT' });
    assert.equal(res.ok, true);
    assert.equal(res.matches.length, 0);
    assert.ok(res.oversizeSkipped, '应带 oversizeSkipped 字段');
    assert.equal(res.oversizeSkipped.count, 1);
    assert.equal(res.oversizeSkipped.limitBytes, MAX_FILE_BYTES);
    assert.ok(res.oversizeSkipped.examples.includes('huge.log'), '示例里应有大文件名');
    assert.match(res.note, /没有参与搜索/);
    assert.match(res.note, /host_exec/);
  });

  it('有命中时不扫大文件、不加字段', async () => {
    await resetRoot();
    await fsp.writeFile(path.join(ROOT, 'small.txt'), 'needle here\n', 'utf8');
    await fsp.writeFile(path.join(ROOT, 'huge.log'), 'x'.repeat(1.2 * 1024 * 1024), 'utf8');

    const res = await grepWorkspace(ROOT, { pattern: 'needle' });
    assert.equal(res.ok, true);
    assert.ok(res.matches.length >= 1);
    assert.equal(res.oversizeSkipped, undefined);
    assert.equal(res.note, undefined);
  });

  it('没有大文件时即使 0 命中也不加字段', async () => {
    await resetRoot();
    await fsp.writeFile(path.join(ROOT, 'small.txt'), 'hello\n', 'utf8');

    const res = await grepWorkspace(ROOT, { pattern: 'absent' });
    assert.equal(res.matches.length, 0);
    assert.equal(res.oversizeSkipped, undefined);
  });

  it('probeOversizeFiles 跳过 node_modules 等目录', async () => {
    await resetRoot();
    const nm = path.join(ROOT, 'node_modules', 'pkg');
    await fsp.mkdir(nm, { recursive: true });
    await fsp.writeFile(path.join(nm, 'big.js'), 'y'.repeat(1.2 * 1024 * 1024), 'utf8');

    const probe = await probeOversizeFiles(ROOT, ROOT);
    assert.equal(probe.count, 0, 'node_modules 下的大文件不应计入');
    assert.equal(fs.existsSync(path.join(nm, 'big.js')), true);
  });
});
