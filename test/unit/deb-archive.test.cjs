/* globals describe, it, expect, beforeEach, afterEach */

/**
 * `scripts/lib/deb-archive.cjs`：deb 的读写与 apt 索引条目生成。
 *
 * 这里刻意用**我们自己的** tar-writer 造 control.tar.gz，再让 readControlText 读回来：
 * 打包（写）与发布（读）必须是同一份实现，测试要能抓住「两边理解不一致」。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  writeAr,
  readArMembers,
  readTarMembers,
  readControlText,
  parseControl,
  packagesStanza,
  releaseChecksums,
  compareVersions,
  indexDebDir,
  AR_MAGIC
} = require('../../scripts/lib/deb-archive.cjs');
const { writeTarGz } = require('../../scripts/lib/tar-writer.cjs');

const CONTROL = `Package: dieyun-headless
Version: 0.1.72
Architecture: amd64
Maintainer: dieyun <dev@dieyun.local>
Installed-Size: 154995
Depends: libc6 (>= 2.28)
Section: utils
Priority: optional
Description: dieyun agent, headless runtime (terminal / one-shot run / web UI)
 Same agent as the desktop app, without Electron.
 .
 Ships its own Node runtime.
`;

describe('deb-archive: ar 容器', () => {
  it('写入后能读回同样的成员名与内容，且以 !<arch> 开头', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'debar-'));
    const target = path.join(dir, 'x.deb');
    try {
      writeAr(target, [
        { name: 'debian-binary', data: Buffer.from('2.0\n', 'ascii') },
        { name: 'control.tar.gz', data: Buffer.from('ccc', 'ascii') } // 奇数长度：要补对齐字节
      ]);
      const raw = fs.readFileSync(target);
      expect(raw.subarray(0, 8).toString('ascii')).toBe(AR_MAGIC);
      const members = readArMembers(target);
      expect(members.map((m) => m.name)).toEqual(['debian-binary', 'control.tar.gz']);
      expect(members[0].data.toString('ascii')).toBe('2.0\n');
      expect(members[1].data.toString('ascii')).toBe('ccc');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('成员名带结尾 /、mode 字段 644（与 dpkg 产物同形）', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'debar-'));
    const target = path.join(dir, 'x.deb');
    try {
      writeAr(target, [{ name: 'debian-binary', data: Buffer.from('2.0\n', 'ascii') }]);
      const header = fs.readFileSync(target).subarray(8, 68).toString('ascii');
      expect(header.slice(0, 16)).toBe('debian-binary/  ');
      expect(header.slice(40, 48)).toBe('644     '); // ar: name16+mtime12+uid6+gid6+mode8+size10+magic2
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('不是 ar 容器就报错，不静默返回空', () => {
    expect(() => readArMembers(Buffer.from('not an ar'))).toThrow(/ar 容器/);
  });
});

describe('deb-archive: control 读取与索引条目', () => {
  let dir = '';
  let debPath = '';

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'debctl-'));
    const ctlDir = path.join(dir, 'control');
    fs.mkdirSync(ctlDir, { recursive: true });
    fs.writeFileSync(path.join(ctlDir, 'control'), CONTROL, 'utf8');
    const ctlTar = path.join(dir, 'control.tar.gz');
    writeTarGz({
      root: ctlDir,
      outFile: ctlTar,
      modeFor: (rel, isDir) => (isDir || rel !== 'control' ? 0o755 : 0o644)
    });
    debPath = path.join(dir, 'dieyun-headless_0.1.72_amd64.deb');
    writeAr(debPath, [
      { name: 'debian-binary', data: Buffer.from('2.0\n', 'ascii') },
      { name: 'control.tar.gz', data: fs.readFileSync(ctlTar) },
      { name: 'data.tar.gz', data: Buffer.from('x', 'ascii') }
    ]);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('readControlText 能从 control.tar.gz 里取出 control（纯 JS，不依赖 tar 命令）', () => {
    expect(readControlText(debPath)).toBe(CONTROL);
  });

  it('parseControl：多行 Description 的续行被还原成 \\n', () => {
    const fields = parseControl(readControlText(debPath));
    expect(fields.Package).toBe('dieyun-headless');
    expect(fields.Depends).toBe('libc6 (>= 2.28)');
    const desc = fields.Description.split('\n');
    expect(desc[0]).toMatch(/headless runtime/);
    expect(desc[1]).toBe('Same agent as the desktop app, without Electron.');
    expect(desc[2]).toBe('.');
  });

  it('packagesStanza 的 Description 续行必须以一个空格开头（否则 apt 报畸形 stanza）', () => {
    const fields = parseControl(readControlText(debPath));
    const stanza = packagesStanza({
      control: fields,
      filename: 'dieyun-headless_0.1.72_amd64.deb',
      size: 123,
      sha256: 'a'.repeat(64),
      md5: 'b'.repeat(32)
    });
    const lines = stanza.split('\n');
    const start = lines.findIndex((l) => l.startsWith('Description:'));
    expect(start).toBeGreaterThan(-1);
    for (const line of lines.slice(start + 1).filter(Boolean)) {
      expect(line.startsWith(' ')).toBe(true);
    }
    expect(stanza).toContain('Filename: dieyun-headless_0.1.72_amd64.deb');
    expect(stanza).toContain('Size: 123');
    expect(stanza).toContain(`SHA256: ${'a'.repeat(64)}`);
  });

  it('packagesStanza：Depends 为空时整行省略，不留裸字段名', () => {
    const stanza = packagesStanza({
      control: { Package: 'p', Version: '1', Architecture: 'amd64', Description: 'd' },
      filename: 'p_1_amd64.deb',
      size: 1,
      sha256: 'a'.repeat(64),
      md5: 'b'.repeat(32)
    });
    expect(stanza).not.toMatch(/^Depends:\s*$/m);
  });

  it('indexDebDir 会跳过别的包名，并带上 size/sha256（apt 校验要用）', () => {
    const entries = indexDebDir(dir, { packageName: 'dieyun-headless' });
    expect(entries).toHaveLength(1);
    expect(entries[0].control.Version).toBe('0.1.72');
    expect(entries[0].sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(entries[0].size).toBe(fs.statSync(debPath).size);
    expect(indexDebDir(dir, { packageName: 'other' })).toHaveLength(0);
  });
});

describe('deb-archive: Release 校验和与版本比较', () => {
  it('releaseChecksums 列出的字节数与磁盘一致', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rel-'));
    try {
      fs.writeFileSync(path.join(dir, 'Packages'), 'Package: x\n', 'utf8');
      const block = releaseChecksums(dir, ['Packages', 'Packages.gz']);
      expect(block).toContain('MD5Sum:');
      expect(block).toContain('SHA256:');
      const expected = String(fs.statSync(path.join(dir, 'Packages')).size);
      expect(block).toMatch(new RegExp(`Packages`));
      expect(block).toContain(expected);
      // 不存在的文件跳过，不写空行
      expect(block).not.toContain('Packages.gz');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('compareVersions 按数字段比较（0.1.9 < 0.1.72，不是字符串序）', () => {
    expect(compareVersions('0.1.9', '0.1.72')).toBeLessThan(0);
    expect(compareVersions('0.1.72', '0.1.9')).toBeGreaterThan(0);
    expect(compareVersions('0.1.72', '0.1.72')).toBe(0);
    expect(compareVersions('1.0.0', '0.99.99')).toBeGreaterThan(0);
  });

  it('readTarMembers 跳过目录项、只返回普通文件', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tar-'));
    try {
      fs.mkdirSync(path.join(dir, 'sub'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'sub', 'a.txt'), 'hello', 'utf8');
      const out = path.join(dir, 'x.tgz');
      writeTarGz({ root: dir, outFile: out });
      const members = readTarMembers(require('zlib').gunzipSync(fs.readFileSync(out)));
      const names = members.map((m) => m.name);
      expect(names).toContain('sub/a.txt');
      expect(names.some((n) => n.endsWith('/'))).toBe(false);
      expect(members.find((m) => m.name === 'sub/a.txt').data.toString('utf8')).toBe('hello');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
