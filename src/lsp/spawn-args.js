'use strict';

/**
 * Windows 上必须走 `cmd.exe /d /s /c <cmdLine>` 时，命令行字符串的唯一拼装来源。
 *
 * 为什么要有这个文件：`lsp-client.js`（起 pyright/clangd 等 server）与
 * `cli-fallback.js`（起 `npx pyright` 兜底）各自写过一份 `[...].join(' ')`，
 * 两处都会在参数含空格时把路径劈成两个参数 —— 而 `--project <userData>/lsp-stubs/...`
 * 一旦劈开，pyright 直接参数错误退出，上层只看到「空诊断」，整条 Python 诊断静默消失。
 *
 * cmd.exe 的引号语义是**双写**（`""`）转义内部引号，不是反斜杠转义。
 */

/** cmd.exe 会解释的字符：空白、引号、重定向、管道、变量展开。 */
const CMD_UNSAFE_RE = /[\s"&|<>^]/;

function quoteCmdArg(value) {
  const s = value == null ? '' : String(value);
  if (!s) return '""';
  if (!CMD_UNSAFE_RE.test(s)) return s;
  return `"${s.replace(/"/g, '""')}"`;
}

/**
 * @param {string} command
 * @param {string[]} [args]
 * @returns {string} 可直接交给 `cmd.exe /d /s /c` 的命令行
 */
function buildCmdLine(command, args) {
  return [command, ...(args || [])].map(quoteCmdArg).join(' ');
}

module.exports = { quoteCmdArg, buildCmdLine, CMD_UNSAFE_RE };
