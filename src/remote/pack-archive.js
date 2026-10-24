'use strict';

/**
 * 远程 Agent 部署包的 tar.gz 构建器（零依赖，Main 进程内使用）。
 *
 * 为什么不用系统 tar：Windows 侧没有可依赖的原生 tar（Git Bash 的 tar 不随 Electron
 * 分发）；为什么不用 npm tar 库：只需要「写」ustar 这一种极简场景，且打包必须
 * 确定性（固定 mtime / 排序 / mode 白名单），引一个通用库反而不可控。
 * 解压侧用远端 tar（preflight 显式检查），本模块只负责生成。
 *
 * 完整性模型：上传前对最终 .tar.gz 计算 sha256，远端 sha256sum 比对一致才算
 * 传输成功 —— 一个密码学断言取代「版本 + 大小 ±4KB + manifest hash」三口径拼合。
 * 跳过重传的判定不走本文件（那是 remote-pack-layout 的 contentHash）。
 */

const fs = require('fs');
const fsp = require('fs/promises');
const crypto = require('crypto');
const zlib = require('zlib');
const { walkPackFiles, remotePackTarMode } = require('./remote-pack-layout');

const BLOCK = 512;
/** ustar name 字段 100 字节，末尾必须留 NUL。超过就显式失败，不静默截断。 */
const MAX_NAME = 99;

/** 定长八进制字段（len-1 位数字 + NUL） */
function fieldOctal(num, len) {
  const digits = Math.max(0, len - 1);
  const text = Number(num || 0).toString(8).padStart(digits, '0').slice(0, digits);
  return Buffer.from(`${text}\0`, 'ascii');
}

/** ustar 文件头（512 字节）。mtime 固定 0：同一份内容永远生成同一颗 tar。 */
function ustarHeader(rel, size, mode) {
  const name = Buffer.from(rel, 'utf8');
  if (name.length > MAX_NAME) {
    throw new Error(`pack 内相对路径过长（${name.length} > ${MAX_NAME} 字节）: ${rel}`);
  }
  const h = Buffer.alloc(BLOCK);
  name.copy(h, 0);
  fieldOctal(mode, 8).copy(h, 100);
  fieldOctal(0, 8).copy(h, 108); // uid
  fieldOctal(0, 8).copy(h, 116); // gid
  fieldOctal(size, 12).copy(h, 124);
  fieldOctal(0, 12).copy(h, 136); // mtime = 0（确定性）
  h.fill(' ', 148, 156); // chksum 字段先按空格参与求和
  h.write('0', 156, 'ascii'); // typeflag: 普通文件
  h.write('ustar\0', 257, 'binary');
  h.write('00', 263, 'ascii');
  fieldOctal(0, 8).copy(h, 329); // devmajor
  fieldOctal(0, 8).copy(h, 337); // devminor
  const sum = h.reduce((acc, b) => acc + b, 0);
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'ascii');
  return h;
}

function padding(size) {
  const rem = size % BLOCK;
  return rem ? Buffer.alloc(BLOCK - rem) : null;
}

/**
 * 把 pack 目录打成单个确定性 .tar.gz。
 * 逐文件整读（最大单文件即内置 Node，~几十 MB，短暂驻留可接受），换掉
 * 逐 chunk 的读流背压处理；压缩流带统一错误通道，任一环节失败立即抛出。
 *
 * @param {string} packRoot 最终部署包目录（lite 直用或缓存装配目录）
 * @param {string} destPath 输出 .tar.gz 路径（失败时已清理，成功由调用方清理）
 * @param {{ onBytes?: (packedBytes: number, totalBytes: number) => void }} [opts]
 *   进度口径是「已送入压缩的未压缩字节数 / 全部未压缩字节」。
 * @returns {Promise<{ sha256: string, sizeBytes: number, fileCount: number }>}
 */
async function buildPackTarGz(packRoot, destPath, opts = {}) {
  const onBytes = typeof opts.onBytes === 'function' ? opts.onBytes : () => {};
  const files = await walkPackFiles(packRoot);
  if (!files.length) throw new Error('部署包目录为空');

  let totalBytes = 0;
  for (const f of files) {
    totalBytes += (await fsp.stat(f.abs)).size;
  }

  const hash = crypto.createHash('sha256');
  let written = 0;
  const out = fs.createWriteStream(destPath);
  const gzip = zlib.createGzip({ level: 6 });
  const sink = new (require('stream').Transform)({
    transform(chunk, _enc, cb) {
      hash.update(chunk);
      written += chunk.length;
      cb(null, chunk);
    }
  });
  gzip.pipe(sink).pipe(out);

  let failed = null;
  const fail = (err) => {
    if (!failed) failed = err || new Error('tar.gz 写出失败');
  };
  gzip.on('error', fail);
  sink.on('error', fail);
  out.on('error', fail);

  const write = async (buf) => {
    if (failed) throw failed;
    if (!gzip.write(buf)) {
      await new Promise((resolve) => gzip.once('drain', resolve));
    }
    if (failed) throw failed;
  };

  let fed = 0;
  try {
    for (const f of files) {
      const content = await fsp.readFile(f.abs);
      await write(ustarHeader(f.rel, content.length, remotePackTarMode(f.rel)));
      await write(content);
      const pad = padding(content.length);
      if (pad) await write(pad);
      fed += content.length;
      onBytes(fed, totalBytes);
    }
    await write(Buffer.alloc(BLOCK * 2)); // 归档结束标记
    if (failed) throw failed;
    await new Promise((resolve, reject) => {
      gzip.end((err) => (err || failed ? reject(err || failed) : resolve()));
    });
    await new Promise((resolve, reject) => {
      if (failed) return reject(failed);
      out.on('close', resolve);
      out.on('error', reject);
    });
  } catch (e) {
    try {
      gzip.destroy();
    } catch {
      // ignore
    }
    try {
      out.destroy();
    } catch {
      // ignore
    }
    try {
      await fsp.unlink(destPath);
    } catch {
      // ignore
    }
    throw e;
  }

  return { sha256: hash.digest('hex'), sizeBytes: written, fileCount: files.length };
}

module.exports = { buildPackTarGz };
