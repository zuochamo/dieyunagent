'use strict';

/**
 * pack-archive（tar.gz 构建器）与 remote-pack-layout（内容 hash / 遍历 / 模式位）
 * 的圆桌测试：注入链改成「单归档 + sha256 + .pack-ok 标记」后，这里守住三件事：
 *   1. 同一份 pack 永远打出同一颗 tar（否则跳过判定会漂移）；
 *   2. 产物能被远端真实的 tar 解压，内容逐字节一致（ustar 头自己手写，不能只信自己）；
 *   3. contentHash 与 tar 遍历同一份文件清单（walkPackFiles），对内容变化敏感。
 */

const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const {
  buildPackTarGz
} = require('../../src/remote/pack-archive');
const {
  computePackContentHash,
  remotePackTarMode,
  walkPackFiles
} = require('../../src/remote/remote-pack-layout');

async function makePack(root) {
  await fsp.mkdir(path.join(root, 'remote'), { recursive: true });
  await fsp.mkdir(path.join(root, 'bin'), { recursive: true });
  await fsp.mkdir(path.join(root, 'node_modules', 'ws', 'lib'), { recursive: true });
  await fsp.writeFile(path.join(root, 'remote', 'run-cli.js'), 'console.log(1)\n');
  await fsp.writeFile(path.join(root, 'remote', 'minimal-gateway-host.js'), '// host\n');
  await fsp.writeFile(path.join(root, 'bin', 'node'), Buffer.alloc(2048, 7));
  await fsp.writeFile(path.join(root, 'node_modules', 'ws', 'lib', 'x.js'), 'module.exports=1\n');
  // 打包期残留目录，必须被跳过（与旧 walkFiles 同语义）
  await fsp.writeFile(path.join(root, '.tmp-node'), 'junk');
}

let packDir;
let outDir;

beforeEach(async () => {
  packDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dy-pack-'));
  outDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dy-out-'));
  await makePack(packDir);
});

afterEach(async () => {
  await fsp.rm(packDir, { recursive: true, force: true });
  await fsp.rm(outDir, { recursive: true, force: true });
});

describe('pack-archive 构建器', () => {
  it('同一份内容两次构建 sha256 一致（确定性），sizeBytes 与产物一致', async () => {
    const a1 = await buildPackTarGz(packDir, path.join(outDir, 'a1.tar.gz'));
    const a2 = await buildPackTarGz(packDir, path.join(outDir, 'a2.tar.gz'));
    expect(a1.sha256).toBe(a2.sha256);
    expect(a1.sizeBytes).toBe(fs.statSync(path.join(outDir, 'a1.tar.gz')).size);
    // remote/ 两个 + bin/node + node_modules/ws/lib/x.js，.tmp-node 不算
    expect(a1.fileCount).toBe(4);
  });

  it('系统 tar 可解压，内容逐字节一致，.tmp-node 不在归档里', async () => {
    // GNU tar 会把绝对路径里的盘符冒号当远程主机（见 pack-remote-gateway 的同款坑），
    // 这里用 cwd + 相对路径调本机 tar
    const archive = path.join(outDir, 'p.tar.gz');
    await buildPackTarGz(packDir, archive);
    await fsp.copyFile(archive, path.join(outDir, 'x.tar.gz'));
    const extract = path.join(outDir, 'extract');
    await fsp.mkdir(extract, { recursive: true });
    // 远端同款命令：tar -xzpf（-p 保留执行位）
    execFileSync('tar', ['-xzpf', 'x.tar.gz', '-C', 'extract'], { cwd: outDir, stdio: 'pipe' });
    expect(await fsp.readFile(path.join(extract, 'remote', 'run-cli.js'), 'utf8')).toBe('console.log(1)\n');
    const nodeBuf = await fsp.readFile(path.join(extract, 'bin', 'node'));
    expect(nodeBuf.length).toBe(2048);
    expect(nodeBuf[0]).toBe(7);
    await expect(fsp.stat(path.join(extract, '.tmp-node'))).rejects.toThrow();
  });

  it('空目录拒绝打包', async () => {
    const empty = await fsp.mkdtemp(path.join(os.tmpdir(), 'dy-empty-'));
    try {
      await expect(buildPackTarGz(empty, path.join(outDir, 'e.tar.gz'))).rejects.toThrow(/为空/);
    } finally {
      await fsp.rm(empty, { recursive: true, force: true });
    }
  });

  it('超长相对路径显式拒绝（ustar name 字段 100 字节）', async () => {
    const deep = path.join(packDir, 'x'.repeat(100));
    await fsp.mkdir(deep);
    await fsp.writeFile(path.join(deep, 'f.txt'), 'x');
    await expect(buildPackTarGz(packDir, path.join(outDir, 'long.tar.gz'))).rejects.toThrow(/过长/);
  });
});

describe('remotePackTarMode 执行位白名单', () => {
  it('只有 node / dieyun-core / run-cli 是 0755，其余 0644', () => {
    expect(remotePackTarMode('bin/node')).toBe(0o755);
    expect(remotePackTarMode('bin/dieyun-core')).toBe(0o755);
    expect(remotePackTarMode('remote/run-cli.js')).toBe(0o755);
    expect(remotePackTarMode('remote/minimal-gateway-host.js')).toBe(0o644);
    expect(remotePackTarMode('node_modules/ws/lib/x.js')).toBe(0o644);
  });
});

describe('walkPackFiles 与 computePackContentHash', () => {
  it('walkPackFiles 字典序稳定 + 跳过 .tmp-node', async () => {
    const files = await walkPackFiles(packDir);
    const rels = files.map((f) => f.rel);
    expect(rels).toEqual([...rels].sort());
    expect(rels).not.toContain('.tmp-node');
    expect(rels).toContain('bin/node');
  });

  it('contentHash 稳定，且对任一文件内容变化敏感', async () => {
    const h1 = await computePackContentHash(packDir);
    const h2 = await computePackContentHash(packDir);
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
    await fsp.writeFile(path.join(packDir, 'remote', 'run-cli.js'), 'console.log(2)\n');
    const h3 = await computePackContentHash(packDir);
    expect(h3).not.toBe(h1);
  });
});
