'use strict';

/**
 * git diff 文本产出的公共部分。
 *
 * 新增文件（未跟踪 / 刚 add）git 不会直接产出 patch，得自己拼 diff 头。
 * 这段拼装过去在 diff-context 里写了一遍、源码管理里干脆没写（只给 before/after），
 * 同一件事两种表达 —— 统一到这里。
 */

/** 单个新增文件的正文上限 */
const NEW_FILE_BODY_MAX_CHARS = 12000;

/**
 * 为新文件合成 unified diff 文本。
 * @param {string} relPath 仓库相对路径
 * @param {string} text 文件内容
 * @param {{ maxChars?: number }} [opts]
 */
function synthesizeNewFilePatch(relPath, text, opts) {
  const rel = String(relPath || '').replace(/\\/g, '/');
  if (!rel) return '';
  const maxChars = Number(opts && opts.maxChars) || NEW_FILE_BODY_MAX_CHARS;
  const raw = String(text == null ? '' : text);
  const clipped = raw.length > maxChars ? `${raw.slice(0, maxChars)}\n...(truncated)` : raw;
  const body = clipped
    .split(/\r?\n/)
    .map((line) => (line ? `+${line}` : '+'))
    .join('\n');
  return [
    `diff --git a/${rel} b/${rel}`,
    'new file mode 100644',
    '--- /dev/null',
    `+++ b/${rel}`,
    '@@ -0,0 +1 @@',
    body
  ].join('\n');
}

module.exports = { synthesizeNewFilePatch, NEW_FILE_BODY_MAX_CHARS };
