'use strict';

// @ts-check

const path = require('path');
/**
 * 沙箱档位策略：**「什么能做、什么要问、什么永远不行」的唯一来源**。
 *
 * 三档（对齐 DSH 的 read-only / workspace-write / danger-full-access）：
 *
 * | 档位 | 可写根 | 只读命令 | 写/装依赖命令 | 网络命令 | 高危命令 |
 * |---|---|---|---|---|---|
 * | read-only | 仅本机内部目录* | 放行 | 问一次 | 问一次 | 拒 |
 * | workspace-write | 内部目录 + 工作区 | 放行 | 工作区内放行，越界问一次 | 放行 | 拒 |
 * | danger-full-access | 内部目录 + 工作区 + 用户目录/临时目录 | 放行 | 放行 | 放行 | 拒 |
 *
 * \* 「内部目录」= userDataPath（DB / 日志 / 撤销栈）、`~/.dieyun`（skills / 记忆）。
 *   它们不是用户代码，锁掉只会让 Agent 连账本都写不了。
 *
 * 不变量：
 * 1. **拒绝永远是拒绝**：`SANDBOX_DENY_LIST`（磁盘格式化、关机、提权、系统目录写入）
 *    在任何档位都不放行，也不给"问一次"的机会 —— 否则档位形同虚设。
 * 2. **判定只看结构**：路径、重定向符、已知会落盘/联网的执行器。不做「用户想干什么」的
 *    意图猜测（仓规禁用意图词表）。同一个命令在任何上下文里结论一致。
 * 3. **档位只影响"写/联网越界"**：读的能力不随档位变（read-only 也要能读代码才能干活）。
 */

/** 三档。顺序即设置界面里的展示顺序（从严到宽）。 */
const SANDBOX_MODES = Object.freeze(['read-only', 'workspace-write', 'danger-full-access']);

/** 默认档位：能改代码，但出不了工作区。 */
const DEFAULT_SANDBOX_MODE = 'workspace-write';

const SANDBOX_MODE_META = Object.freeze({
  'read-only': {
    id: 'read-only',
    label: '只读',
    desc: '只看不改：写文件和跑改文件的命令都会先问你一次。',
    allowsWorkspaceWrite: false,
    asksOutsideWorkspaceWrite: true,
    allowsNetwork: false
  },
  'workspace-write': {
    id: 'workspace-write',
    label: '工作区内可写（默认）',
    desc: '工作区里随便改；写工作区之外、装到系统目录这类动作会先问你一次。',
    allowsWorkspaceWrite: true,
    asksOutsideWorkspaceWrite: true,
    allowsNetwork: true
  },
  'danger-full-access': {
    id: 'danger-full-access',
    label: '完全放开',
    desc: '整盘可写可跑，适合装环境/改系统。只在你完全信任当前任务时用。',
    allowsWorkspaceWrite: true,
    asksOutsideWorkspaceWrite: false,
    allowsNetwork: true
  }
});

/**
 * 永远拒绝：与档位无关。**全仓唯一的高危命令词表**（`exec-policy.js` 也走它，
 * 不要再在别处维护第二份 —— 两份词表早晚会分叉，届时"被 exec 拦住"和"被沙箱拦住"会给出不同答案）。
 *
 * 分两种匹配方式，区别是「匹配位置」：
 * - 正则：命中**任意位置**即高危（`format c:`、`rm -rf /` 这种串不会正常出现在检索词里）。
 * - `DENY_COMMAND_WORDS`：只在**命令位置**（子命令 argv0）命中才算。否则 `grep -rn shutdown src/`、
 *   `git commit -m "fix reboot loop"` 会被当成关机杀掉 —— 那是纯只读命令，误杀的代价比漏检更高
 *   （用户会以为沙箱坏了）。关机/重启本来也不会写在别的命令的参数里。
 */
const SANDBOX_DENY_LIST = Object.freeze([
  // 磁盘/系统级破坏
  /\brm\s+-rf\s+\/\s/,
  /\brm\s+-rf\s+\/\s*$/i,
  /\bdel\s+\/[sfq]/i,
  /\bformat\s+[a-z]:/i,
  /\bmkfs(\.|\s)/i,
  /\bdiskpart\b/i,
  /\bbcdedit\b/i,
  /\bvssadmin\b.*\bdelete\b/i,
  />\s*\/dev\/sd[a-z]/i,
  /:\(\)\s*\{\s*:\|:&\s*\};:/,
  // 提权 / 绕过审计
  /\bpowershell\b[^\n]*\s-enc(odedcommand)?\b/i,
  /\bschtasks\b[^\n]*\/create\b/i,
  /\breg\s+(add|delete)\b[^\n]*(HKLM|HKEY_LOCAL_MACHINE)/i,
  // 直接写入系统目录（正常开发不需要；要装环境请用 danger-full-access 并走安装器）
  /\bcopy\b[^\n]*\bC:\\Windows\\/i,
  /\bmove\b[^\n]*\bC:\\Windows\\/i,
  /\bSet-Content\b[^\n]*\bC:\\Windows\\/i,
  /\bRemove-Item\b[^\n]*\bC:\\Windows\\/i
]);

/** 只在命令位置才拒（见上）：关机 / 重启。 */
const DENY_COMMAND_WORDS = Object.freeze(['shutdown', 'reboot', 'restart-computer']);

/** 这些词只是包装器，真正的命令在它后面（`sudo -u root shutdown /s`）。 */
const DENY_WRAPPER_WORDS = new Set([
  'sudo',
  'doas',
  'env',
  'exec',
  'command',
  'call',
  'start',
  'nohup',
  'timeout',
  'runas',
  'su',
  'xargs',
  'cmd',
  'cmd.exe'
]);

const SHELL_SEGMENT_SPLIT_RE = /\s*(?:&&|\|\||;|\||&|\n)\s*/;

/** 剥掉引号段的内容（`grep "shutdown"` → `grep ""`）：引号里的是数据，不是命令。 */
function stripShellQuotedSegments(cmd) {
  return String(cmd || '')
    .replace(/'(?:\\.|[^'\\])*'/g, "''")
    .replace(/"(?:\\.|[^"\\])*"/g, '""');
}

/** 一条命令里各子命令的 argv0（已剥引号、跳过 sudo/cmd/timeout 这类包装器及其取值）。 */
function commandWords(cmd) {
  const out = [];
  for (const seg of stripShellQuotedSegments(cmd).split(SHELL_SEGMENT_SPLIT_RE)) {
    const tokens = seg.trim().split(/\s+/).filter(Boolean);
    let i = 0;
    while (i < tokens.length && DENY_WRAPPER_WORDS.has(tokens[i].toLowerCase())) {
      i += 1;
      // 跳过包装器的取值：`sudo -u root`、`timeout 30`、`cmd /c`
      while (i < tokens.length && /^(?:[-\/]\S*|\d+)$/.test(tokens[i])) i += 1;
    }
    if (i < tokens.length) {
      out.push(tokens[i].toLowerCase().replace(/^["']|["']$/g, '').replace(/\.exe$/, ''));
    }
  }
  return out;
}

/**
 * 解释器/脚本执行器：**按程序位 basename 认，不按字面量认**。
 *
 * 为什么必须这样：以前写 `\bnode\s+-e\b`、`python3?\s+-c\b` 这类字面量，
 * 只覆盖"裸命令名"。一旦是绝对路径 —— `"C:\Program Files\nodejs\node.exe" -e ...`、
 * `/usr/bin/python3 -c ...`、`node.exe script.js` —— 全部漏判，read-only 档会把它们当只读命令放行
 * （实测：read-only 下 `"…\node.exe" -e "…"` 0 次询问直接跑，档位形同虚设）。
 */
const INTERPRETER_BASENAMES = new Set([
  'node',
  'nodejs',
  'deno',
  'bun',
  'tsx',
  'ts-node',
  'python',
  'python3',
  'py',
  'perl',
  'ruby',
  'php',
  'sh',
  'bash',
  'zsh',
  'dash',
  'fish',
  'powershell',
  'pwsh',
  'cmd',
  'wscript',
  'cscript',
  'mshta',
  'osascript'
]);

/** 纯信息开关（`node -v` / `python --version` / `go help`）：不落盘，别弹窗。 */
const INFO_ONLY_ARG_RE = /^--?(?:v|version|h|help|version=|help=)$/i;

const SHELL_SEPARATOR_TOKENS = new Set(['&&', '||', ';', '|', '&']);

/** 宿主 shell：它们的参数**本身又是一条命令行**，要递归判（`cmd /c "node -e …"`）。 */
const SHELL_HOST_BASENAMES = new Set(['cmd', 'powershell', 'pwsh', 'sh', 'bash', 'zsh', 'dash', 'fish']);

/** 引号感知的粗分词：引号内整段算一个 token，且**不剥引号**（要取路径的 basename）。 */
function splitArgv(cmd) {
  const out = [];
  // 双引号内允许反斜杠转义（`cmd /c "node -e \"…\""` 这种嵌套引号必须整段算一个 token）
  const re = /"((?:\\.|[^"\\])*)"|'([^']*)'|(\S+)/g;
  let hit;
  while ((hit = re.exec(String(cmd || '')))) {
    if (hit[1] != null) out.push(hit[1].replace(/\\"/g, '"'));
    else out.push(hit[2] != null ? hit[2] : hit[3]);
  }
  return out;
}

function baseNameOf(token) {
  const s = String(token || '').trim();
  if (!s) return '';
  return s
    .split(/[\\/]/)
    .pop()
    .toLowerCase()
    .replace(/\.exe$/, '')
    .replace(/\.(?:cmd|bat|ps1)$/, '');
}

/** 程序位下标：跳过 sudo/cmd/timeout 一类包装器及其取值，遇到 shell 分隔符重新开始。 */
function programIndexOf(tokens) {
  let expectProgram = true;
  for (let i = 0; i < tokens.length; i += 1) {
    const raw = tokens[i];
    if (SHELL_SEPARATOR_TOKENS.has(raw)) {
      expectProgram = true;
      continue;
    }
    if (!expectProgram) continue;
    if (DENY_WRAPPER_WORDS.has(baseNameOf(raw))) {
      while (i + 1 < tokens.length && /^(?:[-\/]\S*|\d+)$/.test(tokens[i + 1])) i += 1;
      continue;
    }
    return i;
  }
  return -1;
}

/**
 * 这条命令是不是「跑解释器/脚本」。是 → 可能落盘（写什么由脚本决定，判定层看不到）。
 * 只认**程序位**：`grep -rn node src/` 里的 `node` 是参数，不是执行。
 */
function runsScriptInterpreter(cmd, depth = 0) {
  if (depth > 4) return true; // 嵌套过深时宁可问一次
  const tokens = splitArgv(cmd);
  const idx = programIndexOf(tokens);
  if (idx < 0) return false;
  const programToken = tokens[idx];
  const base = baseNameOf(programToken);
  if (!INTERPRETER_BASENAMES.has(base)) {
    // 程序位上是"一整条被引号包住的命令行"（`cmd /c "node -e …"`，包装器已跳过后落到这里）：
    // 里面那串自己就是命令，递归判。注意**不能先看有没有空格** —— 带空格的绝对路径
    // （`C:\Program Files\nodejs\node.exe`）也含空格，那样会把路径当命令行拆。
    if (/\s/.test(programToken)) return runsScriptInterpreter(programToken, depth + 1);
    return false;
  }
  const args = tokens.slice(idx + 1);
  // 无参数会进 REPL（也能落盘）；只有纯信息开关时才认为不落盘
  if (!args.length) return true;
  // 宿主 shell：参数本身就是命令行，递归判；否则 `bash -c "node x.js"` 只看到"bash 有个参数"
  if (SHELL_HOST_BASENAMES.has(base)) {
    const inner = args.filter((a) => !/^[-\/]\S*$/.test(a));
    if (!inner.length) return false; // `cmd /?` 这类只有开关
    // 内层是单段脚本时直接按命令行判；多段（`bash -c "a; b"`）整体判
    return runsScriptInterpreter(inner.join(' '), depth + 1);
  }
  return args.some((a) => !INFO_ONLY_ARG_RE.test(a));
}

/** 命中即为「任何档位都拒绝」；返回命中的模式（排查看用）。 */
function matchDangerousCommand(command) {
  const cmd = String(command || '');
  const hit = SANDBOX_DENY_LIST.find((re) => re.test(cmd));
  if (hit) return hit;
  const word = commandWords(cmd).find((w) => DENY_COMMAND_WORDS.includes(w));
  return word ? `命令位置: ${word}` : null;
}

/** 会写盘的执行器（argv0 或命令里的动词）。用词是**命令语义**，不是用户意图。 */
const WRITE_COMMAND_RE =
  /(^|[\s;&|(])(rm|rmdir|del|erase|mv|move|cp|copy|xcopy|robocopy|mkdir|md|touch|tee|chmod|chown|ln|truncate|dd|git\s+(add|commit|checkout|reset|clean|apply|stash|merge|rebase|pull)|npm\s+(i|install|ci|uninstall|update)|pnpm\s+(i|install|add|remove|update)|yarn\s+(add|install|remove)|pip3?\s+(install|uninstall)|cargo\s+(build|run|test|install|fix|fmt)|go\s+(build|install|run)|dotnet\s+(build|run|publish)|mvn\s|gradle\s|make\b|cmake\s|csc\b|tsc\b|eslint\b|prettier\b|jest\b|vitest\b|pytest\b|node\s+.*>|python3?\s+.*>)([\s;&|)]|$)/i;

/**
 * 会改动磁盘的**中介**：跑别人的脚本 / 内联代码 / 解包 / 删除。
 *
 * 为什么要单独一份：`node -e "..."`、`npm run build`、`tar -xf` 的 argv0 本身没有写动词，
 * 但它们的产物落在哪由脚本决定 —— read-only 档如果把它们当"只读命令"放行，
 * 档位就是纸面上的（实测 `node writer.js` 能无声写进主目录）。这里只按**命令形态**归类，
 * 不判断意图：任何内联代码/脚本/包管理器脚本一律算「可能落盘」，该问就问。
 */
const WRITE_TOOL_RE =
  /(^|[\s;&|(])(sed\s+-i|tar\b[^\n]*\s-[a-zA-Z]*x|unzip\b|Expand-Archive\b|Remove-Item\b|ri\b|New-Item\b|taskkill\b|npm\s+run\b|npm\s+exec\b|pnpm\s+run\b|pnpm\s+dlx\b|yarn\s+run\b|npx\b|bunx\b|choco\s+install\b|winget\s+install\b|scoop\s+install\b|apt(-get)?\s+(install|remove|purge)\b|yum\s+(install|remove)\b|brew\s+(install|upgrade)\b|curl\b[^\n]*\s(-o|-O|--output)\b|wget\b[^\n]*\s(-O|--output-document)\b)([\s;&|)]|$)/i;

/**
 * 重定向/落地写入的结构信号（Shell 层面，与上面动词互补）。
 * `(?!&)` 是为了不让 `2>&1`（fd 复制，不落盘）被判成写 —— 那是最常见的"只读命令被误弹"来源。
 */
const WRITE_REDIRECT_RE =
  /(?:\d?>>?)(?!&)|Out-File|Set-Content|Add-Content|New-Item|Tee-Object|Export-Csv/i;

/** 这条命令是否可能落盘（动词 / 中介 / 解释器 / 重定向任一命中）。 */
function commandMayWrite(cmd) {
  const s = String(cmd || '');
  return (
    WRITE_COMMAND_RE.test(s) ||
    WRITE_TOOL_RE.test(s) ||
    runsScriptInterpreter(s) ||
    WRITE_REDIRECT_RE.test(s)
  );
}

/** 联网执行器。 */
const NETWORK_COMMAND_RE =
  /(^|[\s;&|(])(curl|wget|Invoke-WebRequest|Invoke-RestMethod|iwr|irm|ftp|scp|sftp|ssh|telnet|nc|ncat|npm\s+(view|search|install|i|ci|update)|pnpm\s+(view|add|install)|pip3?\s+(install|download)|git\s+(clone|fetch|pull|push|remote)|git\s+ls-remote)([\s;&|)]|$)/i;

function normalizeSandboxMode(value) {
  const v = String(value || '').trim().toLowerCase();
  return SANDBOX_MODES.includes(v) ? v : DEFAULT_SANDBOX_MODE;
}

function sandboxModeMeta(mode) {
  return SANDBOX_MODE_META[normalizeSandboxMode(mode)];
}

/** 判定分类。`allow` 直接放行；`ask` 需要用户批一次；`deny` 恒拒。 */
const SANDBOX_CATEGORIES = Object.freeze({
  READ: 'read',
  WRITE: 'write',
  NETWORK: 'network',
  DANGEROUS: 'dangerous',
  /** computer 工具的鼠标/键盘输入动作（截屏属于读，走开关即同意，不进审批）。 */
  OS_CONTROL: 'os-control'
});

function normPath(p) {
  return String(p || '').replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
}

function isUnder(target, root) {
  const t = normPath(target);
  const r = normPath(root);
  if (!t || !r) return false;
  if (t === r) return true;
  return t.startsWith(r.endsWith('\\') ? r : `${r}\\`);
}

/** 路径是否落在任一允许根下。 */
function isUnderAny(target, roots) {
  return (roots || []).some((r) => isUnder(target, r));
}

/**
 * 命令里出现的、看起来像路径的片段（绝对路径 / 卷根 / 带分隔符的相对路径）。
 * 不含分隔符的裸词（`package.json`、`dist`）视为工作区相对路径 —— cwd 已被限到工作区，
 * 所以它们天然落在工作区内，不需要也不应该猜测。
 */
function extractPathTokens(command) {
  const out = [];
  const cmdText = String(command || '');
  // 有 Windows 痕迹（盘符/反斜杠）时，`/E`、`/Y` 这类多半是命令行开关而不是 POSIX 绝对路径。
  const windowsish = /[a-zA-Z]:[\\/]|\\/.test(cmdText);
  const re = /("[^"]+"|'[^']+'|\S+)/g;
  let m;
  while ((m = re.exec(cmdText))) {
    const raw = m[1].replace(/^["']|["']$/g, '');
    if (!raw || raw.length > 400) continue;
    // `robocopy src dist /E`、`copy a b /Y`：开关不是写入目标，当路径解析会造出 `C:\E` 这种假越界
    if (/^\/[A-Za-z]{1,2}$/.test(raw) || (windowsish && /^\/[A-Za-z]{1,4}$/.test(raw))) continue;
    const looksAbs = /^[a-zA-Z]:[\\/]/.test(raw) || raw.startsWith('\\\\') || raw.startsWith('/');
    const looksRel = !looksAbs && /[\\/]/.test(raw) && !raw.startsWith('-');
    if (!looksAbs && !looksRel) continue;
    const cleaned = raw.replace(/^[>&|]+|[>&|;,)]+$/g, '');
    if (!cleaned || /^[-\/]/.test(cleaned) === false && cleaned.length < 2) continue;
    out.push(cleaned);
  }
  return out;
}

/**
 * 写入这些位置等于丢弃输出，不算越界（`echo x > /dev/null` 遍地都是）。
 */
const HARMLESS_WRITE_TARGETS = Object.freeze([
  '/dev/null',
  '/dev/stdout',
  '/dev/stderr',
  'nul',
  '$null'
]);

function isHarmlessWriteTarget(token) {
  const t = String(token || '').trim().toLowerCase();
  return HARMLESS_WRITE_TARGETS.includes(t) || HARMLESS_WRITE_TARGETS.includes(t.replace(/\\/g, '/'));
}

/**
 * 把命令里的路径片段落成绝对路径：相对路径按 `cwd`（默认工作区根）解析，
 * 因为 cwd 已经被限到工作区，`./dist/a.txt` 事实上就在工作区里。
 */
function resolveToken(token, base) {
  const raw = String(token || '');
  try {
    if (/^[a-zA-Z]:[\\/]/.test(raw) || raw.startsWith('\\\\')) return path.win32.resolve(raw);
    if (raw.startsWith('/')) return path.resolve(raw);
    return path.resolve(base || process.cwd(), raw);
  } catch {
    return raw;
  }
}

/**
 * 命令的分类与决策。
 *
 * @param {string} command
 * @param {{ mode?: string, workspaceRoots?: string[], internalRoots?: string[], cwd?: string, remote?: boolean }} [opts]
 * @returns {{ action: 'allow'|'ask'|'deny', category: string, reason: string, mode: string, detail?: string }}
 */
function decideShellCommand(command, opts = {}) {
  const mode = normalizeSandboxMode(opts.mode);
  const meta = SANDBOX_MODE_META[mode];
  const cmd = String(command || '');
  const workspaceRoots = opts.workspaceRoots || [];
  const internalRoots = opts.internalRoots || [];
  const allowedWriteRoots = [...workspaceRoots, ...internalRoots];
  const baseDir = opts.cwd || workspaceRoots[0] || process.cwd();

  const denyHit = matchDangerousCommand(cmd);
  if (denyHit) {
    return {
      action: 'deny',
      category: SANDBOX_CATEGORIES.DANGEROUS,
      reason: '这条命令属于任何档位都不放行的高危操作（磁盘/系统/关机/提权类）。',
      mode,
      detail: String(denyHit)
    };
  }

  const wantsWrite = commandMayWrite(cmd);
  const wantsNetwork = NETWORK_COMMAND_RE.test(cmd);

  if (mode === 'danger-full-access') {
    return {
      action: 'allow',
      category: wantsWrite ? SANDBOX_CATEGORIES.WRITE : wantsNetwork ? SANDBOX_CATEGORIES.NETWORK : SANDBOX_CATEGORIES.READ,
      reason: '当前为完全放开档，直接放行。',
      mode
    };
  }

  if (!wantsWrite) {
    if (wantsNetwork && !meta.allowsNetwork) {
      return {
        action: 'ask',
        category: SANDBOX_CATEGORIES.NETWORK,
        reason: `当前档位「${meta.label}」默认不出网；这条命令会联网。`,
        mode,
        detail: cmd.slice(0, 200)
      };
    }
    return {
      action: 'allow',
      category: SANDBOX_CATEGORIES.READ,
      reason: '只读命令，直接放行。',
      mode
    };
  }

  // 远程（SSH）命令：路径是远端路径，本机既没有这些根也无法解析 —— 按本地根判定只会造出
  // `C:\home\...` 这种假越界和假 detail。这里据实说明"看不到远端"，让用户确认一次。
  if (opts.remote) {
    return {
      action: 'ask',
      category: SANDBOX_CATEGORIES.WRITE,
      reason: '远程（SSH）命令会落盘；本机沙箱看不到远端路径，执行前确认一次。',
      mode,
      detail: cmd.slice(0, 200)
    };
  }

  // 想写：先看写哪儿
  const paths = extractPathTokens(cmd).filter((p) => !isHarmlessWriteTarget(p));
  const absPaths = paths.map((p) => resolveToken(p, baseDir));
  const outside = absPaths.filter((p) => !isUnderAny(p, allowedWriteRoots) && !/^[a-zA-Z]:\\?$/.test(p));
  const writesOutside = outside.length > 0;

  if (!meta.allowsWorkspaceWrite) {
    return {
      action: 'ask',
      category: SANDBOX_CATEGORIES.WRITE,
      reason: `当前档位「${meta.label}」不写文件；这条命令会落盘。`,
      mode,
      detail: (outside[0] || paths[0] || cmd).slice(0, 200)
    };
  }

  if (writesOutside) {
    return {
      action: 'ask',
      category: SANDBOX_CATEGORIES.WRITE,
      reason: `这条命令会写工作区之外的路径；当前档位「${meta.label}」需要你同意一次。`,
      mode,
      detail: outside.slice(0, 5).join(', ')
    };
  }

  return {
    action: 'allow',
    category: SANDBOX_CATEGORIES.WRITE,
    reason: '写操作落在工作区内，直接放行。',
    mode
  };
}

/**
 * 文件路径写操作的决策（fs.write_file / fs.mkdir / fs.edit_file 这类）。
 *
 * 与 shell 的区别：路径是确定的，不需要从字符串里猜，所以「工作区外」判定是精确的。
 *
 * @param {string} absPath
 * @param {{ mode?: string, workspaceRoots?: string[], internalRoots?: string[] }} [opts]
 */
function decideFsWrite(absPath, opts = {}) {
  const mode = normalizeSandboxMode(opts.mode);
  const meta = SANDBOX_MODE_META[mode];
  const workspaceRoots = opts.workspaceRoots || [];
  const internalRoots = opts.internalRoots || [];
  const target = String(absPath || '');

  if (mode === 'danger-full-access') {
    return {
      action: 'allow',
      category: SANDBOX_CATEGORIES.WRITE,
      reason: '当前为完全放开档，直接放行。',
      mode
    };
  }
  if (isUnderAny(target, internalRoots)) {
    return {
      action: 'allow',
      category: SANDBOX_CATEGORIES.WRITE,
      reason: '本机内部目录（账本/日志/技能），直接放行。',
      mode
    };
  }
  if (!meta.allowsWorkspaceWrite) {
    return {
      action: 'ask',
      category: SANDBOX_CATEGORIES.WRITE,
      reason: `当前档位「${meta.label}」不写文件。`,
      mode,
      detail: target
    };
  }
  if (isUnderAny(target, workspaceRoots)) {
    return {
      action: 'allow',
      category: SANDBOX_CATEGORIES.WRITE,
      reason: '写入落在工作区内，直接放行。',
      mode
    };
  }
  return {
    action: 'ask',
    category: SANDBOX_CATEGORIES.WRITE,
    reason: `目标不在工作区内；当前档位「${meta.label}」需要你同意一次。`,
    mode,
    detail: target
  };
}

/**
 * computer 工具中**只读**的动作：screenshot 是读屏、wait 只是等时间，不改变系统状态。
 *
 * 白名单**倒置**是刻意的：除这两个之外的一切 action（包括以后新增的、被拼错的、
 * 上游校验漏掉的）一律按「会改变系统状态」处理。动作枚举在 tool-validate 与
 * computer/service 各有一份，若在此正列为「输入动作」集合，任何一处新增动作忘了同步
 * 这里就会变成无审批直通；倒置后最坏结果只是「多问用户一次」。
 */
const OS_CONTROL_READ_ONLY_ACTIONS = new Set(['screenshot', 'wait']);

/**
 * computer 工具（OS 级电脑控制）的档位判定。结构化动作、无路径语义，
 * 所以这是第三个判定入口（前两个：shell 文本 decideShellCommand、fs 路径 decideFsWrite）。
 *
 * 口径：
 * - screenshot / wait 是只读 —— 电脑控制总开关（permissions.osControl）本身就是用户同意，
 *   档位不再拦（否则 read-only 档连「看一眼」都做不到，开关形同虚设）；
 * - 其余动作改变系统状态 —— 非 danger-full-access 档问一次，
 *   审批记忆是「会话 × os-control 类别」（无路径，scope='-'）；
 * - SANDBOX_DENY_LIST 是 shell 命令词表，与本判定正交（computer 不走 shell）。
 *
 * @param {string} action computer 工具的 action 值
 * @param {{ mode?: string }} [opts]
 */
function decideOsControlAction(action, opts = {}) {
  const mode = normalizeSandboxMode(opts.mode);
  const meta = SANDBOX_MODE_META[mode];
  const act = String(action || '');
  const isReadOnly = OS_CONTROL_READ_ONLY_ACTIONS.has(act);

  if (isReadOnly || mode === 'danger-full-access') {
    return {
      action: 'allow',
      category: SANDBOX_CATEGORIES.OS_CONTROL,
      reason: isReadOnly
        ? '截屏/等待属只读，电脑控制开关已同意。'
        : '当前为完全放开档，直接放行。',
      mode
    };
  }
  return {
    action: 'ask',
    category: SANDBOX_CATEGORIES.OS_CONTROL,
    reason: `当前档位「${meta.label}」下，操作本机鼠标/键盘需要你同意一次（本会话有效）。`,
    mode,
    detail: `动作：${act}`
  };
}

/**
 * 越界被拒后给模型的话术：**必须包含"不要重试"**，否则模型会反复撞同一堵墙，
 * 把步数预算烧在不可能成功的调用上（这也是判定结果要带 category 的原因）。
 */
function sandboxErrorFor(decision, opts = {}) {
  const meta = SANDBOX_MODE_META[normalizeSandboxMode(decision.mode)];
  const declined = opts.declined === true;
  const noChannel = opts.noChannel === true;
  const expired = opts.expired === true;
  // 三种「没被执行」要能分开：真的被用户拒 / 没人可问 / 问了没回。混成一个码会让排查
  // 一直卡在「用户明明允许了」和「用户明明没点」之间。
  const code = noChannel
    ? 'SANDBOX_NO_CHANNEL'
    : expired
      ? 'SANDBOX_APPROVAL_TIMEOUT'
      : declined
        ? 'SANDBOX_DECLINED'
        : 'SANDBOX_DENIED';
  const head = noChannel
    ? '这个操作需要用户确认，但当前没有可用的确认通道（界面未连接/已关闭）。'
    : expired
      ? '等待用户确认超时，按拒绝处理。'
      : declined
        ? '用户拒绝了一次越界操作。'
        : `当前沙箱档位「${meta.label}」拒绝了这个操作。`;
  const why = decision.reason ? `（${decision.reason}）` : '';
  const detail = decision.detail ? ` 目标：${String(decision.detail).slice(0, 200)}` : '';
  const next =
    declined || noChannel || expired
      ? '不要重试同一操作；把你要做什么、为什么需要它说清楚，让用户手动执行，或请用户调整档位。'
      : meta.allowsWorkspaceWrite
        ? '不要重试；把操作限制在工作区内，或者请用户同意/调整档位。'
        : '不要重试；改成只读做法，或者请用户切到「工作区内可写」/「完全放开」档。';
  return { ok: false, errorCode: code, error: `${head}${why}${detail} ${next}`, retryable: false, sandboxMode: meta.id };
}

module.exports = {
  SANDBOX_MODES,
  DEFAULT_SANDBOX_MODE,
  SANDBOX_MODE_META,
  SANDBOX_CATEGORIES,
  SANDBOX_DENY_LIST,
  DENY_COMMAND_WORDS,
  matchDangerousCommand,
  commandWords,
  commandMayWrite,
  runsScriptInterpreter,
  INTERPRETER_BASENAMES,
  stripShellQuotedSegments,
  normalizeSandboxMode,
  sandboxModeMeta,
  isUnder,
  isUnderAny,
  extractPathTokens,
  decideShellCommand,
  decideFsWrite,
  decideOsControlAction,
  sandboxErrorFor
};
