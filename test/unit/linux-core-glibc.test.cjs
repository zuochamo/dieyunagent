'use strict';
/**
 * 远端 core 的 GLIBC 下限：从「运行时预检」搬到「产物侧硬约束」。
 *
 * 老现场（P3 之前）：远端先 `ldd --version` 量宿主 glibc、再整文件扫二进制里的 `GLIBC_x.y`
 * 字面量，两者一比就弹「远端索引不可用」。两个毛病：
 *  1. 整文件扫字面量会把别的库（libssl 之类）自带的版本串算进来 → 误报；
 *  2. 症状归因错：产物要求 2.34，用户看到的是「你的服务器太老」，而真正该做的是重新打包。
 *
 * 现在：`assertCoreGlibcTarget()` 在打包时用 `.gnu.version_r`（Verneed）精确读「对 libc 家族
 * 要哪些符号版本」，高于 2.17 直接打包失败；运行时那套预检已删除。这个文件锁住解析器与那道闸。
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  CORE_GLIBC_TARGET,
  compareNeed,
  parseElfLibcVersions,
  glibcRequirementOf,
  assertCoreGlibcTarget
} = require('../../scripts/pack-dieyun-core-linux-lib.cjs');

const SHDR64 = 64;

/**
 * 造一个最小 ELF64：段落表 + `.gnu.version_r` + `.dynstr` + `.shstrtab`。
 * 只为喂给解析器，不要求可执行。
 * @param {{ libs?: Array<{ file: string, versions: string[] }>, withVerneed?: boolean }} [opts]
 */
function buildElf(opts = {}) {
  const libs = opts.libs || [];
  const withVerneed = opts.withVerneed !== false;

  // ---- .dynstr ----
  const dynParts = [Buffer.from('\0', 'latin1')];
  let dynLen = 1;
  const addDyn = (s) => {
    const off = dynLen;
    const b = Buffer.from(`${s}\0`, 'latin1');
    dynParts.push(b);
    dynLen += b.length;
    return off;
  };
  const libEntries = libs.map((lib) => ({
    file: addDyn(lib.file),
    versions: lib.versions.map((v) => addDyn(v))
  }));
  const dynstr = Buffer.concat(dynParts);

  // ---- .gnu.version_r ----
  const verChunks = [];
  let verLen = 0;
  libEntries.forEach((entry, idx) => {
    const auxStart = 16;
    const auxParts = [];
    let auxLen = 0;
    entry.versions.forEach((verOff, vi) => {
      const aux = Buffer.alloc(16);
      aux.writeUInt32LE(0, 0); // vna_hash
      aux.writeUInt16LE(0, 4); // vna_flags
      aux.writeUInt16LE(vi + 1, 6); // vna_other
      aux.writeUInt32LE(verOff, 8); // vna_name
      aux.writeUInt32LE(vi === entry.versions.length - 1 ? 0 : 16, 12); // vna_next
      auxParts.push(aux);
      auxLen += 16;
    });
    const head = Buffer.alloc(16);
    head.writeUInt16LE(1, 0); // vn_version
    head.writeUInt16LE(entry.versions.length, 2); // vn_cnt
    head.writeUInt32LE(entry.file, 4); // vn_file
    head.writeUInt32LE(auxStart, 8); // vn_aux（相对本条起点）
    head.writeUInt32LE(idx === libEntries.length - 1 ? 0 : 16 + auxLen, 12); // vn_next
    const chunk = Buffer.concat([head, ...auxParts]);
    verChunks.push(chunk);
    verLen += chunk.length;
  });
  const verneed = Buffer.concat(verChunks);

  // ---- .shstrtab ----
  const shParts = [Buffer.from('\0', 'latin1')];
  let shLen = 1;
  const addSh = (s) => {
    const off = shLen;
    const b = Buffer.from(`${s}\0`, 'latin1');
    shParts.push(b);
    shLen += b.length;
    return off;
  };
  const nameVerneed = addSh(withVerneed ? '.gnu.version_r' : '.gnu.dynsym');
  const nameDynstr = addSh('.dynstr');
  const nameShstr = addSh('.shstrtab');
  const shstr = Buffer.concat(shParts);

  // ---- 布局 ----
  const verneedOff = 64;
  const dynstrOff = verneedOff + verLen;
  const shstrOff = dynstrOff + dynstr.length;
  const bodyEnd = shstrOff + shstr.length;
  const shoff = Math.ceil(bodyEnd / 8) * 8;
  const shnum = 4;
  const total = shoff + shnum * SHDR64;
  const buf = Buffer.alloc(total);

  // ELF header
  buf.write('\u007fELF', 0, 'latin1');
  buf[4] = 2; // ELFCLASS64
  buf[5] = 1; // LSB
  buf[6] = 1; // EV_CURRENT
  buf.writeUInt16LE(2, 0x10); // e_type EXEC
  buf.writeUInt16LE(0x3e, 0x12); // e_machine x86-64
  buf.writeUInt32LE(1, 0x14); // e_version
  buf.writeBigUInt64LE(BigInt(shoff), 0x28);
  buf.writeUInt16LE(64, 0x34); // e_ehsize
  buf.writeUInt16LE(64, 0x3a); // e_shentsize
  buf.writeUInt16LE(shnum, 0x3c);
  buf.writeUInt16LE(3, 0x3e); // e_shstrndx

  verneed.copy(buf, verneedOff);
  dynstr.copy(buf, dynstrOff);
  shstr.copy(buf, shstrOff);

  const writeShdr = (i, { name, type, off, size, link }) => {
    const base = shoff + i * SHDR64;
    buf.writeUInt32LE(name, base);
    buf.writeUInt32LE(type, base + 4);
    buf.writeBigUInt64LE(BigInt(off), base + 24);
    buf.writeBigUInt64LE(BigInt(size), base + 32);
    buf.writeUInt32LE(link || 0, base + 40);
  };
  writeShdr(1, {
    name: nameVerneed,
    type: 0x6ffffffe,
    off: verneedOff,
    size: verLen,
    link: 2
  });
  writeShdr(2, { name: nameDynstr, type: 3, off: dynstrOff, size: dynstr.length });
  writeShdr(3, { name: nameShstr, type: 3, off: shstrOff, size: shstr.length });
  return buf;
}

function tempFile(buf, name = 'core.bin') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dy-glibc-'));
  const p = path.join(dir, name);
  fs.writeFileSync(p, buf);
  return p;
}

describe('parseElfLibcVersions（只认 libc 家族）', () => {
  it('读出 libc.so.6 要求的最高版本', () => {
    const buf = buildElf({
      libs: [{ file: 'libc.so.6', versions: ['GLIBC_2.2.5', 'GLIBC_2.17', 'GLIBC_2.34'] }]
    });
    const r = parseElfLibcVersions(buf);
    assert.equal(r.ok, true);
    assert.equal(r.maxGlibc, '2.34');
  });

  it('别的库自带的 GLIBC 串不算数（老实现会误报成 2.99）', () => {
    const buf = buildElf({
      libs: [
        { file: 'libc.so.6', versions: ['GLIBC_2.17'] },
        { file: 'libssl.so.3', versions: ['GLIBC_2.99'] }
      ]
    });
    const r = parseElfLibcVersions(buf);
    assert.equal(r.maxGlibc, '2.17');
    assert.deepEqual(
      r.libs.map((l) => l.file),
      ['libc.so.6', 'libssl.so.3'],
      '仍然把全部 verneed 记下来，只是不参与取最大'
    );
  });

  it('libm / libpthread / ld-linux 都算 libc 家族', () => {
    const buf = buildElf({
      libs: [
        { file: 'libc.so.6', versions: ['GLIBC_2.17'] },
        { file: 'libm.so.6', versions: ['GLIBC_2.29'] },
        { file: 'ld-linux-x86-64.so.2', versions: ['GLIBC_2.2.5'] },
        { file: 'libpthread.so.0', versions: ['GLIBC_2.3.4'] }
      ]
    });
    assert.equal(parseElfLibcVersions(buf).maxGlibc, '2.29');
  });

  it('没有 .gnu.version_r（静态链接）→ 空要求，且解析成功', () => {
    const buf = buildElf({ libs: [], withVerneed: false });
    const r = parseElfLibcVersions(buf);
    assert.equal(r.ok, true);
    assert.equal(r.maxGlibc, '');
  });

  it('不是 ELF → ok:false（调用方必须失败，不能当成「没要求」）', () => {
    assert.equal(parseElfLibcVersions(Buffer.from('not an elf at all')).ok, false);
    assert.equal(parseElfLibcVersions(Buffer.alloc(0)).ok, false);
  });
});

describe('assertCoreGlibcTarget（打包期的硬闸）', () => {
  it('2.17 放行，并把实测值带回来', () => {
    const p = tempFile(buildElf({ libs: [{ file: 'libc.so.6', versions: ['GLIBC_2.17'] }] }));
    const r = assertCoreGlibcTarget(p);
    assert.equal(r.maxGlibc, '2.17');
    assert.equal(r.source, 'verneed');
  });

  it('2.34 直接拒绝，并说清该做什么', () => {
    const p = tempFile(buildElf({ libs: [{ file: 'libc.so.6', versions: ['GLIBC_2.34'] }] }));
    assert.throws(
      () => assertCoreGlibcTarget(p),
      (err) => {
        assert.equal(err.code, 'CORE_GLIBC_TOO_NEW');
        assert.equal(err.needed, '2.34');
        assert.equal(err.target, CORE_GLIBC_TARGET);
        assert.match(err.message, /pack:dieyun-core:linux/);
        return true;
      }
    );
  });

  it('读不懂的产物不许静默通过', () => {
    const p = tempFile(Buffer.from('garbage GLIBC_2.99 garbage', 'latin1'));
    const r = glibcRequirementOf(p);
    assert.equal(r.source, 'scan', '退化成保守整文件扫描时必须自报');
    assert.throws(() => assertCoreGlibcTarget(p), (err) => err.code === 'CORE_GLIBC_UNVERIFIED');
  });

  it('产物不存在 → CORE_ELF_UNREADABLE', () => {
    assert.throws(
      () => assertCoreGlibcTarget(path.join(os.tmpdir(), 'definitely-missing-core-xyz')),
      (err) => err.code === 'CORE_ELF_UNREADABLE'
    );
  });

  it('目标是 2.17（Rust std 下限，不再随编译机漂）', () => {
    assert.equal(CORE_GLIBC_TARGET, '2.17');
    assert.equal(compareNeed('2.17', '2.17'), 0);
    assert.equal(compareNeed('2.9', '2.17'), -1, '版本比较按数字而非字典序');
  });
});

describe('运行时预检必须彻底消失（防止回归）', () => {
  it('不再有 linux-elf-compat.js，也没人 require 它', () => {
    const srcRoot = path.join(__dirname, '..', '..', 'src');
    const hits = [];
    const walk = (dir) => {
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, ent.name);
        if (ent.isDirectory()) walk(full);
        else if (/\.(js|cjs|mjs)$/.test(ent.name)) {
          const text = fs.readFileSync(full, 'utf8');
          if (/linux-elf-compat|hostGlibcVersion|glibcMismatchHint/.test(text)) hits.push(full);
        }
      }
    };
    walk(srcRoot);
    assert.deepEqual(hits, []);
    assert.equal(fs.existsSync(path.join(srcRoot, 'remote', 'linux-elf-compat.js')), false);
  });

  it('远端 pack 清单里也没有它', () => {
    const { REMOTE_GATEWAY_SOURCE_PATHS } = require('../../src/remote/remote-pack-layout.js');
    assert.equal(
      REMOTE_GATEWAY_SOURCE_PATHS.some((p) => /linux-elf-compat/.test(p)),
      false
    );
  });

  it('index.ping 不再报 incompatible（诊断归因交回启动失败本身）', () => {
    const text = fs.readFileSync(
      path.join(__dirname, '..', '..', 'src', 'remote', 'remote-index-core.js'),
      'utf8'
    );
    assert.equal(/incompatible/.test(text), false);
    assert.equal(/REMOTE_INDEX_CORE_INCOMPATIBLE/.test(text), false);
  });
});
