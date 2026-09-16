'use strict';

const fs = require('fs');
const path = require('path');
const { parsePorcelainStatus, isGitRepo, gitExec } = require('./worktree-service');

/** Avoid multi-minute undo.turn_begin on repos with thousands of dirty paths. */
const MAX_BASELINE_FILES = 120;

/**
 * 捕获 turn 开始前工作区相对 git 根的脏文件内容（用于 git 策略撤回）。
 * @param {string} repoPath
 * @returns {Promise<{ head: string, files: Record<string, { before: string|null, encoding: 'utf8'|'base64' }> }>}
 */
async function captureGitWorkingBaseline(repoPath) {
  const files = {};
  if (!(await isGitRepo(repoPath))) {
    return { head: '', files };
  }
  const head = await gitExec(repoPath, ['rev-parse', 'HEAD']).catch(() => '');
  const out = await gitExec(repoPath, ['status', '--porcelain', '-u']).catch(() => '');
  const items = parsePorcelainStatus(out);
  for (const item of items) {
    if (Object.keys(files).length >= MAX_BASELINE_FILES) break;
    const rel = item.path.replace(/\\/g, '/');
    const full = path.join(repoPath, rel);
    if (item.kind === 'deleted') {
      files[rel] = { before: null, encoding: 'utf8' };
      continue;
    }
    if (!fs.existsSync(full) || !fs.statSync(full).isFile()) continue;
    try {
      const buf = fs.readFileSync(full);
      if (buf.length > 4 * 1024 * 1024) continue;
      const isBinary = buf.includes(0);
      files[rel] = isBinary
        ? { before: buf.toString('base64'), encoding: 'base64' }
        : { before: buf.toString('utf8'), encoding: 'utf8' };
    } catch {
      // ignore unreadable
    }
  }
  return { head, files };
}

/**
 * 将 baseline 文件合并进 turn 快照（不覆盖已有 path，保留最早 checkpoint 内容）。
 * @param {Record<string, { before: string|null, encoding: 'utf8'|'base64', remote?: boolean }>} target
 * @param {Record<string, { before: string|null, encoding: 'utf8'|'base64', remote?: boolean }>} incoming
 */
function mergeBaselineFilesInto(target, incoming) {
  let merged = 0;
  /** @type {string[]} */
  const mergedKeys = [];
  for (const [key, meta] of Object.entries(incoming || {})) {
    if (!key || target[key]) continue;
    target[key] = {
      before: meta.before == null ? null : String(meta.before),
      encoding: meta.encoding === 'base64' ? 'base64' : 'utf8',
      remote: !!meta.remote
    };
    mergedKeys.push(key);
    merged += 1;
  }
  return { merged, mergedKeys };
}

module.exports = { captureGitWorkingBaseline, mergeBaselineFilesInto, MAX_BASELINE_FILES };
