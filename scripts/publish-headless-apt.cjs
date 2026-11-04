'use strict';

/**
 * 把 `dist/` 里的 headless deb 变成一个**能直接被 apt 用的内网源目录**：
 *
 *   <out>/pool/dieyun-headless_0.1.72_amd64.deb        ← 历次版本都留着（回滚只需指定版本号）
 *   <out>/pool/Packages  /Packages.gz                  ← apt 读的索引（含 Size / MD5sum / SHA256）
 *   <out>/pool/Release                                 ← Origin/Label/Suite/Date（flat 仓库只要这一份）
 *
 * 为什么是这个形状（而不是另写一个自更新客户端）：
 * 1. **更新是既有的系统能力**，不是本产品的新机制。服务器上已经有 apt、有 `unattended-upgrades`、
 *    有 `apt-daily.timer`；给它们一个源，就有「自动更新 + 校验 + 依赖解析 + 回滚到指定版本」，
 *    一行代码都不用写。自研「查版本 → 下载 → 替换运行中的二进制」是第二套更新真相，还会绕开 apt 的锁。
 * 2. **索引自己算，不依赖 `dpkg-scanpackages`**：发布机是 Windows。control 从 deb 本身读
 *    （`scripts/lib/deb-archive.cjs`，与打包同一份实现），Size/SHA256/MD5sum 现算，
 *    因此索引与产物永远一致；有 `dpkg-scanpackages` 时再交叉校验。
 * 3. **旧版本不删**：apt 源里留着历史 deb，所以回滚就是指定旧版本
 *    （注意 apt 降级必须带 `--allow-downgrades`，否则它直接拒绝：实测 `-y` 也不管用）。
 *
 * 用法：
 *   node scripts/publish-headless-apt.cjs                     # dist/ → release/headless-apt/
 *   node scripts/publish-headless-apt.cjs --out <目录>        # 自定义输出（例如内网 Web 根目录）
 *   node scripts/publish-headless-apt.cjs --from dist --print-only
 *   node scripts/publish-headless-apt.cjs --verify <目录>     # 只校验已有仓库
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execSync, execFileSync } = require('child_process');

const {
  indexDebDir,
  packagesStanza,
  parseControl,
  readControlText,
  releaseChecksums,
  compareVersions
} = require('./lib/deb-archive.cjs');

const ROOT = path.join(__dirname, '..');
const PKG = 'dieyun-headless';
const DEFAULT_OUT = path.join(ROOT, 'release', 'headless-apt');
const DEFAULT_FROM = path.join(ROOT, 'dist');

function parseArgs(argv) {
  const opts = { from: DEFAULT_FROM, out: DEFAULT_OUT, verify: '', printOnly: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--from') {
      opts.from = path.resolve(String(argv[i + 1] || ''));
      i += 1;
    } else if (a === '--out') {
      opts.out = path.resolve(String(argv[i + 1] || ''));
      i += 1;
    } else if (a === '--verify') {
      opts.verify = path.resolve(String(argv[i + 1] || ''));
      i += 1;
    } else if (a === '--print-only') opts.printOnly = true;
    else if (a === '-h' || a === '--help') opts.help = true;
    else throw new Error(`未知参数：${a}`);
  }
  return opts;
}

function printHelp() {
  const src = fs.readFileSync(__filename, 'utf8').split('\n');
  const end = src.findIndex((l, i) => i > 0 && l.trim() === '*/');
  console.log(src.slice(0, end + 1).join('\n'));
}

/** flat 仓库的 Release：没有 Date 过期问题（apt 只在有 Valid-Until 时才判断过期） */
function buildRelease({ poolDir, origin }) {
  const now = new Date().toUTCString();
  const head = [
    'Origin: dieyun',
    `Label: ${origin}`,
    `Suite: ${origin}`,
    `Codename: ${origin}`,
    'Architectures: amd64',
    'Components: main',
    'Description: dieyun agent headless builds (flat repository)',
    `Date: ${now}`
  ].join('\n');
  // 索引自身的校验和：缺它 apt update 会警告「Release 文件内无哈希条目」
  const sums = releaseChecksums(poolDir, ['Packages', 'Packages.gz']);
  return `${head}\n${sums}`;
}

/** 只列举 `--from` 里的 deb（不碰 pool）：`--print-only` 的唯一取数入口 */
function listDebs(fromDir) {
  if (!fs.existsSync(fromDir)) throw new Error(`--from 目录不存在：${fromDir}`);
  const debs = fs
    .readdirSync(fromDir)
    .filter((n) => new RegExp(`^${PKG}_.+_amd64\\.deb$`).test(n))
    .sort();
  if (!debs.length) {
    throw new Error(
      `${fromDir} 里没有 ${PKG}_<版本>_amd64.deb（先跑 npm run build:headless）`
    );
  }
  return debs;
}

function copyDebsIntoPool(fromDir, poolDir) {
  const debs = listDebs(fromDir);
  fs.mkdirSync(poolDir, { recursive: true });
  const copied = [];
  for (const name of debs) {
    const src = path.join(fromDir, name);
    const dst = path.join(poolDir, name);
    const srcHash = crypto.createHash('sha256').update(fs.readFileSync(src)).digest('hex');
    const exists = fs.existsSync(dst);
    const dstHash = exists
      ? crypto.createHash('sha256').update(fs.readFileSync(dst)).digest('hex')
      : '';
    if (srcHash !== dstHash) {
      fs.copyFileSync(src, dst);
      copied.push(name);
    }
  }
  return { debs, copied };
}

function writeIndex(poolDir) {
  const entries = indexDebDir(poolDir, { packageName: PKG });
  if (!entries.length) throw new Error(`${poolDir} 里没有可索引的 deb`);
  entries.sort((a, b) => compareVersions(a.control.Version, b.control.Version));

  const stanzas = entries.map((e) =>
    packagesStanza({
      control: e.control,
      filename: e.file,
      size: e.size,
      sha256: e.sha256,
      md5: e.md5
    })
  );
  // apt 的 Packages 用「空行分隔的 stanza」；末尾多一个空行是惯例
  const text = `${stanzas.join('\n')}\n`;
  fs.writeFileSync(path.join(poolDir, 'Packages'), text, 'utf8');
  execSyncCompress(path.join(poolDir, 'Packages'), path.join(poolDir, 'Packages.gz'));
  const release = buildRelease({ poolDir, origin: 'headless' });
  fs.writeFileSync(path.join(poolDir, 'Release'), release, 'utf8');
  return { entries, packagesText: text };
}

/** gzip 用 zlib（打包机可能没有 gzip 命令）；保持与 `gzip -9` 等价的产物形态 */
function execSyncCompress(src, dst) {
  const zlib = require('zlib');
  const out = zlib.gzipSync(fs.readFileSync(src), { level: 9 });
  fs.writeFileSync(dst, out);
}

/**
 * 索引自检：每条 stanza 的 Size / SHA256 必须与磁盘上的文件一致，
 * 否则 apt 会在客户端报 `Hash Sum mismatch`（这类错误极难从服务器日志上看出来）。
 */
function verifyIndex(poolDir) {
  const problems = [];
  const packagesPath = path.join(poolDir, 'Packages');
  if (!fs.existsSync(packagesPath)) return { ok: false, problems: [`${packagesPath} 不存在`] };
  const text = fs.readFileSync(packagesPath, 'utf8');
  const blocks = text.split(/\n\s*\n/).filter((b) => b.trim());

  const seen = new Set();
  for (const block of blocks) {
    const fields = parseControl(block);
    const file = fields.Filename;
    if (!file) {
      problems.push('有条目缺 Filename');
      continue;
    }
    const abs = path.join(poolDir, file);
    if (!fs.existsSync(abs)) {
      problems.push(`索引里的 ${file} 在 pool 里不存在`);
      continue;
    }
    if (seen.has(file)) problems.push(`重复索引同一个文件：${file}`);
    seen.add(file);
    const size = fs.statSync(abs).size;
    if (Number(fields.Size) !== size) problems.push(`${file} 的 Size 不符（索引 ${fields.Size} / 实际 ${size}）`);
    const sha = crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex');
    if (fields.SHA256 !== sha) problems.push(`${file} 的 SHA256 不符`);
    const control = parseControl(readControlText(abs));
    if (control.Package !== PKG) problems.push(`${file} 的 control.Package 是 ${control.Package}，不是 ${PKG}`);
    if (control.Version !== fields.Version) problems.push(`${file} 的 Version 与索引不一致`);
    for (const required of ['Package', 'Version', 'Architecture', 'Filename', 'Size']) {
      if (!fields[required]) problems.push(`${file} 的索引条目缺字段 ${required}`);
    }
  }
  const missing = fs
    .readdirSync(poolDir)
    .filter((n) => n.endsWith('.deb'))
    .filter((n) => !seen.has(n));
  if (missing.length) problems.push(`pool 里有未进索引的 deb：${missing.join(', ')}`);

  // 有 dpkg-scanpackages 时交叉校验（Windows 上没有，跳过）。
  // 「装没装」与「数出来对不对」要分开判：合成一个 catch 会把真实不一致当成没装。
  if (!problems.length) {
    let hasScan = true;
    try {
      // 用 execFileSync 而不是 execSync：Windows 上 execSync 走 cmd.exe，命令不存在时退出码是 1、
      // 和「命令存在但报用法」分不开（发布机就是 Windows，build:headless 会卡在这一步）。
      // 不经 shell 起进程，命令不存在一律是 ENOENT。
      execFileSync('dpkg-scanpackages', ['--help'], { stdio: 'ignore' });
    } catch (err) {
      if ((err && err.code === 'ENOENT') || (err && err.status) === 127) hasScan = false;
      // 其它非零退出（--help 的用法提示）说明命令存在
    }
    if (hasScan) {
      try {
        const out = execSync(`dpkg-scanpackages . /dev/null 2>/dev/null | grep -c '^Package:'`, {
          cwd: poolDir,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore']
        });
        const n = Number(String(out).trim());
        if (!Number.isFinite(n) || n !== seen.size) {
          problems.push(`dpkg-scanpackages 数到 ${String(out).trim() || 0} 个包，索引里有 ${seen.size} 个`);
        }
      } catch (err) {
        problems.push(
          `dpkg-scanpackages 交叉校验失败：${String((err && (err.message || err)) || err).split('\n')[0]}`
        );
      }
    }
  }
  return { ok: problems.length === 0, problems, count: seen.size, latest: latestVersion(blocks) };
}

function latestVersion(blocks) {
  let latest = '';
  for (const block of blocks) {
    const v = parseControl(block).Version;
    if (v && (!latest || compareVersions(v, latest) > 0)) latest = v;
  }
  return latest;
}

function printClientConfig({ poolDir, latest }) {
  const rel = path.relative(ROOT, poolDir).replace(/\\/g, '/');
  console.log('');
  console.log('[apt] 内网源目录已就绪：' + poolDir);
  console.log('[apt] 把它通过 nginx / 内网 Web 暴露（只读静态），例如 http://apt.internal/dieyun/');
  console.log('[apt] 服务器上一次性配置：');
  console.log(`        echo 'deb [trusted=yes] http://apt.internal/dieyun ./' | sudo tee /etc/apt/sources.list.d/dieyun-headless.list`);
  console.log('[apt] 之后：');
  console.log('        sudo apt update && sudo apt install dieyun-headless            # 或 apt upgrade');
  console.log('        sudo apt install dieyun-headless=<旧版本> --allow-downgrades   # 回滚（降级必须带 --allow-downgrades）');
  console.log('[apt] 想全自动更新（不改本仓一行代码）：');
  console.log('        sudo apt install unattended-upgrades');
  console.log('        # /etc/apt/apt.conf.d/20auto-upgrades 里把 Update-Package-Lists / Unattended-Upgrade 设为 "1"');
  console.log('        # 只想自动装 dieyun-headless：在 50unattended-upgrades 的 Origins-Pattern 里放 origin=dieyun');
  console.log('[apt] 也可用已挂载目录（NFS/SMB）：deb [trusted=yes] file:/mnt/dieyun-apt ./');
  if (latest) console.log(`[apt] 索引里的最新版本：${latest}`);
  if (rel && !path.isAbsolute(rel)) console.log(`[apt] 本机位置：${rel}`);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) return printHelp();

  if (opts.verify) {
    const res = verifyIndex(opts.verify);
    if (!res.ok) {
      console.error(`[apt] 校验失败：\n  ${res.problems.join('\n  ')}`);
      process.exit(1);
    }
    console.log(`[apt] 校验通过：${opts.verify}（${res.count} 个包，最新 ${res.latest}）`);
    return;
  }

  // `--print-only` 必须先于任何写入：以前先 copy 再判，等于「只想看一眼」也改了发布目录
  // （pool 里的同名 deb 被替换，而 Packages/Release 没更新 → 源进入索引不一致状态）。
  if (opts.printOnly) {
    const debs = listDebs(opts.from);
    console.log(`[apt] 待入源（--print-only，不写盘）：${debs.join(', ')}`);
    return;
  }
  const poolDir = path.join(opts.out, 'pool');
  const { debs, copied } = copyDebsIntoPool(opts.from, poolDir);
  const { entries } = writeIndex(poolDir);
  const res = verifyIndex(poolDir);
  if (!res.ok) {
    console.error(`[apt] 索引自检失败：\n  ${res.problems.join('\n  ')}`);
    process.exit(1);
  }
  console.log(
    `[apt] 索引已更新：${entries.length} 个包（本次新增/替换 ${copied.length} 个：${
      copied.join(', ') || '无'
    }）`
  );
  printClientConfig({ poolDir, latest: res.latest });
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`[apt] 失败：${(err && err.stack) || err}`);
    process.exit(1);
  });
}

module.exports = { writeIndex, verifyIndex, buildRelease, copyDebsIntoPool, PKG, DEFAULT_OUT };
