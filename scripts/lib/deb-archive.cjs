'use strict';

/**
 * .deb 的读写（ar 容器 + control 字段 / Packages 索引条目）—— **唯一来源**。
 *
 * 为什么在 Node 里做，而不是 shell 出 `dpkg-deb`：
 * 打包与发布都在 Windows 构建机上跑，那里没有 dpkg。而 deb 的结构本身与平台无关：
 *   `!<arch>\n` + [60 字节头 + 内容] × {debian-binary, control.tar.gz, data.tar.gz}
 * 打包（写）与发布（读 control、算 Size/SHA256 生成 apt 索引）用的是同一份实现，
 * 免得「打包按一种理解、发布按另一种理解」。
 *
 * 有 `dpkg-deb` 时调用方仍会拿它交叉校验（见 pack-headless.cjs），这里不假设它存在。
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const AR_MAGIC = '!<arch>\n';
const HEADER_SIZE = 60;
const MEMBER_ORDER = ['debian-binary', 'control.tar.gz', 'data.tar.gz'];

/**
 * 写 ar 容器。成员名带结尾 `/`、mode 写 `644`，与 dpkg 自己产出的 deb 一致
 * （dpkg 的 ar 读器两种写法都宽容，但「与真实产物同形」才让 `dpkg-deb -c` / `apt install` 行为可预期）。
 */
function writeAr(target, members) {
  const chunks = [Buffer.from(AR_MAGIC, 'ascii')];
  for (const { name, data } of members) {
    const memberName = `${name}/`;
    if (memberName.length > 16) throw new Error(`ar 成员名太长：${memberName}`);
    const header = Buffer.from(
      [
        memberName.padEnd(16, ' '),
        '0'.padEnd(12, ' '), // mtime 固定 0：可重复构建
        '0'.padEnd(6, ' '),
        '0'.padEnd(6, ' '),
        '644'.padEnd(8, ' '),
        String(data.length).padEnd(10, ' '),
        '`\n'
      ].join(''),
      'ascii'
    );
    if (header.length !== HEADER_SIZE) throw new Error(`ar 头长度异常：${header.length}`);
    chunks.push(header, data);
    if (data.length % 2 === 1) chunks.push(Buffer.from('\n', 'ascii'));
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, Buffer.concat(chunks));
}

/** 读 ar 容器 → [{ name, data }]（不依赖 dpkg / ar 命令） */
function readArMembers(target) {
  const buf = Buffer.isBuffer(target) ? target : fs.readFileSync(target);
  if (buf.subarray(0, 8).toString('ascii') !== AR_MAGIC) {
    throw new Error('不是 ar 容器（缺少 !<arch> 头）');
  }
  const members = [];
  let off = 8;
  while (off + HEADER_SIZE <= buf.length) {
    const header = buf.subarray(off, off + HEADER_SIZE).toString('ascii');
    const name = header.slice(0, 16).trim().replace(/\/$/, '');
    const size = Number(header.slice(48, 58).trim());
    if (!name || !Number.isFinite(size)) break;
    const start = off + HEADER_SIZE;
    members.push({ name, data: buf.subarray(start, start + size) });
    off = start + size + (size % 2);
  }
  return members;
}

/**
 * 读 ustar 成员（够读 control.tar.gz 用：它只有 `./` `./control` `./md5sums` 这类短名字）。
 * 自带读取器的理由与 tar-writer 相同：**不假设构建机有 `tar` 命令**，
 * 且让 control 的读取（发布）与写入（打包）留在同一份实现里。
 */
function readTarMembers(buf) {
  const members = [];
  let off = 0;
  while (off + 512 <= buf.length) {
    const header = buf.subarray(off, off + 512);
    if (header.every((b) => b === 0)) break; // 结束块
    const rawName = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
    if (!rawName) break;
    const size = parseInt(header.subarray(124, 136).toString('ascii').replace(/\0.*$/, '').trim(), 8) || 0;
    const prefix = header.subarray(345, 500).toString('utf8').replace(/\0.*$/, '');
    const type = String.fromCharCode(header[156] || 0x30);
    const name = prefix && rawName.indexOf('/') !== 0 && !rawName.startsWith('./') ? `${prefix}/${rawName}` : rawName;
    const start = off + 512;
    if (type === '0' || type === '\0' || type === '7') {
      members.push({ name: name.replace(/^\.\//, ''), size, data: buf.subarray(start, start + size) });
    }
    off = start + Math.ceil(size / 512) * 512;
  }
  return members;
}

/** 解出 control.tar.gz 里的 `control` 原文（纯 JS：gunzip + ustar） */
function readControlText(debPath) {
  const members = readArMembers(debPath);
  const controlMember = members.find((m) => m.name === 'control.tar.gz');
  if (!controlMember) throw new Error(`${debPath} 里没有 control.tar.gz`);
  const tarMembers = readTarMembers(zlib.gunzipSync(controlMember.data));
  const control = tarMembers.find((m) => m.name === 'control');
  if (!control) throw new Error(`${debPath} 的 control.tar.gz 里没有 control`);
  return control.data.toString('utf8');
}

/**
 * 解析 control 文本 → { fields, description }
 * 只做 deb 的规则：`Field: value`，续行以单个空格开头，`.` 表示空行。
 */
function parseControl(text) {
  const fields = {};
  let current = null;
  for (const line of String(text).split(/\r?\n/)) {
    if (!line.trim()) continue;
    if (line.startsWith(' ') || line.startsWith('\t')) {
      if (current) fields[current] += `\n${line.slice(1)}`;
      continue;
    }
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    current = line.slice(0, idx).trim();
    fields[current] = line.slice(idx + 1).trim();
  }
  return fields;
}

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function md5File(file) {
  return crypto.createHash('md5').update(fs.readFileSync(file)).digest('hex');
}

function debFilename(control) {
  return `${control.Package}_${control.Version}_${control.Architecture}.deb`;
}

/**
 * 生成 apt `Packages` 里的**一个** stanza。
 *
 * 字段取舍：`Filename` / `Size` / 校验和是 apt 真正要用的（缺校验和 apt 会拒装），
 * 其余从 control 原样搬运，避免「索引比 control 少信息」导致客户端看不到描述。
 *
 * 注意多行 `Description`：deb822 的续行**必须以一个空格开头**，而 `parseControl` 会把
 * control 里那个空格吃掉 —— 写回索引时必须补上，否则 apt 会把 `Same agent as ...`
 * 当成一个畸形字段丢掉描述（甚至报 `Malformed stanza`）。
 */
function packagesStanza({ control, filename, size, sha256, md5 }) {
  const lines = [
    `Package: ${control.Package}`,
    `Version: ${control.Version}`,
    `Architecture: ${control.Architecture}`,
    `Maintainer: ${control.Maintainer || 'unknown'}`,
    `Installed-Size: ${control['Installed-Size'] || '0'}`
  ];
  if (control.Depends) lines.push(`Depends: ${control.Depends}`);
  lines.push(`Section: ${control.Section || 'utils'}`);
  lines.push(`Priority: ${control.Priority || 'optional'}`);
  lines.push(`Filename: ${filename}`);
  lines.push(`Size: ${size}`);
  lines.push(`MD5sum: ${md5}`);
  lines.push(`SHA256: ${sha256}`);

  const descLines = String(control.Description || control.Package).split('\n');
  lines.push(`Description: ${descLines[0]}`);
  for (const extra of descLines.slice(1)) lines.push(` ${extra}`.trimEnd());
  return `${lines.join('\n')}\n`;
}

/** 扫描目录里的 deb（只要文件名符合 <pkg>_<ver>_<arch>.deb），返回索引条目 */
function indexDebDir(dir, { packageName = '' } = {}) {
  const entries = [];
  const names = fs
    .readdirSync(dir)
    .filter((n) => /\.deb$/i.test(n))
    .sort();
  for (const name of names) {
    const abs = path.join(dir, name);
    const control = parseControl(readControlText(abs));
    if (packageName && control.Package !== packageName) continue;
    entries.push({
      file: name,
      absPath: abs,
      control,
      size: fs.statSync(abs).size,
      sha256: sha256File(abs),
      md5: md5File(abs)
    });
  }
  return entries;
}

/** 版本比较（Debian 规则的最小子集：数字段按数字比，其余按字节序；够区分 0.1.9 < 0.1.72） */
function compareVersions(a, b) {
  const split = (v) => String(v).split(/([0-9]+)/).filter((x) => x !== '');
  const as = split(a);
  const bs = split(b);
  const len = Math.max(as.length, bs.length);
  for (let i = 0; i < len; i += 1) {
    const x = as[i];
    const y = bs[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const nx = /^[0-9]+$/.test(x);
    const ny = /^[0-9]+$/.test(y);
    if (nx && ny) {
      const d = Number(x) - Number(y);
      if (d !== 0) return d > 0 ? 1 : -1;
    } else if (x !== y) {
      return x > y ? 1 : -1;
    }
  }
  return 0;
}

/**
 * Release 里的索引校验和块（`MD5Sum:` / `SHA256:` 下面每行是「哈希 字节数 文件名」）。
 *
 * 缺这两块时 `apt update` 会警告「Release 文件内无哈希条目」：只影响索引自身的完整性校验
 * （包本身还有 Packages 里的哈希兜着），但发布一个会刷警告的源是不专业的，成本也只有几行。
 */
function releaseChecksums(dir, files) {
  const rows = files
    .filter((name) => fs.existsSync(path.join(dir, name)))
    .map((name) => {
      const abs = path.join(dir, name);
      return {
        name,
        size: fs.statSync(abs).size,
        md5: md5File(abs),
        sha256: sha256File(abs)
      };
    });
  const block = (hashKey) =>
    rows.map((r) => ` ${hashKey === 'md5' ? r.md5 : r.sha256} ${String(r.size).padStart(16)} ${r.name}`).join('\n');
  return `MD5Sum:\n${block('md5')}\nSHA256:\n${block('sha256')}\n`;
}

module.exports = {
  AR_MAGIC,
  MEMBER_ORDER,
  writeAr,
  readArMembers,
  readTarMembers,
  readControlText,
  parseControl,
  packagesStanza,
  releaseChecksums,
  indexDebDir,
  sha256File,
  md5File,
  debFilename,
  compareVersions
};
