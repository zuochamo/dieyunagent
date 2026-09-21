'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

/**
 * 原子替换文件：先写同目录临时文件，再 rename 覆盖目标。
 *
 * **全仓单一来源**。直接写目标路径时，中途崩溃 / 断电会留下半截文件 ——
 * 而两处使用者覆盖的分别是「用户的正式代码」（worktree apply）与「可恢复检查点」
 * （subagent checkpoint），半截文件比不写更糟。新增原子写场景请复用这里，勿再各自
 * 复制一份 tmp + rename。
 */
/** 目标同目录下的临时文件名（同目录才能保证 rename 落在同一文件系统，才是原子的）。 */
function tmpPathFor(dest) {
  return path.join(
    path.dirname(dest),
    `.dieyun-atomic-${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.tmp`
  );
}

function renameOver(tmp, dest) {
  try {
    fs.renameSync(tmp, dest);
  } catch (e) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // 清理临时文件失败不应掩盖真正的错误
    }
    throw e;
  }
}

/**
 * 内容版原子写。
 * @param {string} dest 目标路径
 * @param {string | Buffer} data 内容
 * @param {import('fs').WriteFileOptions} [opts] 透传给 fs.writeFileSync
 */
function atomicWriteFileSync(dest, data, opts) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = tmpPathFor(dest);
  try {
    fs.writeFileSync(tmp, data, opts);
  } catch (e) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // ignore
    }
    throw e;
  }
  renameOver(tmp, dest);
}

/**
 * 拷贝版原子写（避免把大文件整块读进内存，用于 worktree 产物覆盖主工作区）。
 * @param {string} dest 目标路径
 * @param {string} src 源文件路径
 */
function atomicCopyFileSync(dest, src) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = tmpPathFor(dest);
  try {
    fs.copyFileSync(src, tmp);
  } catch (e) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // ignore
    }
    throw e;
  }
  renameOver(tmp, dest);
}

module.exports = { atomicWriteFileSync, atomicCopyFileSync };
