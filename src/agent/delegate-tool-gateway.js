'use strict';

const fs = require('fs');
const path = require('path');
const { normalizeAgentToolName } = require('./tool-guardrails');
const { fsEditArgsPresent } = require('./guardrails-shared');
const { applyPatchUnsupported } = require('./tool-validate');
// `local:` 前缀 = 模型显式指「本机」（跑叠云这台机器）：路径语义唯一来源在 gateway/host-local
const { isLocalPathRef, isLocalFlag } = require('../gateway/host-local');
// 远端（SSH）路径的唯一解析口径：`ssh://` URI 里那段 POSIX 路径只有 target.js 会解
const {
  normalizeRemotePath,
  isRemoteWorkspacePath,
  parseWorkspaceInput,
  stripWorktreeSuffix
} = require('../workspace/target');
// 护栏数字单一来源（AGENTS.md §5）：fs 读取字节上限只改 agent-limits。
const { AGENT_LIMITS_DEFAULTS, getAgentLimits } = require('./agent-limits');

/** p 是否等于 root 或位于 root 之下（两者都按本机绝对路径解析后的语义比较）。 */
function isSameOrUnder(root, p) {
  const rel = path.relative(root, p);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** POSIX 版同语义（远端路径必须按 POSIX 比，不能用 win32 的 path.relative）。 */
function isSameOrUnderPosix(root, p) {
  const r = String(root || '').replace(/\/+$/, '') || '/';
  const t = String(p || '').replace(/\/+$/, '') || '/';
  if (r === '/') return t.startsWith('/');
  return t === r || t.startsWith(`${r}/`);
}

/**
 * 工作区 / worktree 的「远端 POSIX 形态」：`ssh://u@h/srv/x` → `/srv/x`；
 * 已经是纯 POSIX 的（远端 per-role 副本路径就是这样传下来的）→ 归一化即可。
 */
function remotePosixOf(p) {
  const s = String(p || '').trim();
  if (!s) return '';
  if (isRemoteWorkspacePath(s)) {
    const t = parseWorkspaceInput(s);
    if (t && t.kind === 'ssh') return normalizeRemotePath(t.remotePath);
    // 没有 `user@` 的 `ssh://host/path` 形态：`parseWorkspaceInput` 不认，这里只把 scheme+authority 剥掉
    return normalizeRemotePath(s.replace(/^ssh:\/\/(?:[^@/]*@)?[^/:]+(?::\d+)?/i, ''));
  }
  return normalizeRemotePath(s);
}

/**
 * planner 并行 worker 的**写作用域**（唯一来源）。
 *
 * 为什么必须有它：worker 各拿一个 git worktree，但 system prompt 开头是父级的
 * `sys_content` —— 里面写着主工作区路径，模型十有八九用绝对路径。裸放行两条后果：
 * ① 改动写回主工作区，worktree 隔离形同虚设（并行 worker 互相覆盖）；
 * ② 收尾「变更」面板看不到任何东西（它读的是 worktree 相对基线的 diff），
 *    用户以为任务没做，其实文件被写到了另一处。
 *
 * 语义（**写收口、读跟随**）：worktree 存在时，
 * - 写：落在 worktree 内 → 原样；落在主工作区内 → **重映射**到 worktree 的同名相对路径
 *   （模型写绝对路径也能正确隔离）；两者之外 → 拒绝（结构化错误 `WORKER_SCOPE_DENIED`，
 *   不静默放行、也不静默改名）。
 * - 读：副本里有对应文件就读副本（否则「写完再读回」看到的是旧内容，模型会无限重试），
 *   副本里没有（node_modules / 构建产物 / 未跟踪文件）就读主工作区那一份；工作区之外的
 *   读取不拦 —— 能不能读由宿主权限与沙箱管，与普通轮同口径，读也不会破坏隔离。
 *
 * 没有 worktreePath 的运行（普通对话 / Plan 的只读勘察）返回 null，调用点行为零变化。
 * 远端（SSH）会话按 **POSIX 语义**做同一套规则：主侧 = 会话副本 + 它所属的仓库根
 *（远端 worker 的绝对路径通常写在仓库根下），映射目标是 per-role 副本路径。
 */
function createWorkerWriteScope(workspacePath, worktreePath) {
  const ws = String(workspacePath || '').trim();
  const wt = String(worktreePath || '').trim();
  if (!wt || !ws) return null;
  // 远端（SSH）：路径是 POSIX，**不能**走 `path.resolve`（win32 会解析出 `E:\srv\x` 假路径，
  // 见 docs/SANDBOX.md §1.1）。以前这里直接 `return null` ⇒ 远端并行修好之后，隔离只剩
  // 「提示词保证」（2026-11-19 审计）。现在用 POSIX 语义做同一套规则：
  // 写落在副本里 → 原样；落在会话副本 / 它所属的仓库里 → 重映射到副本同名相对路径；其余 → 拒绝。
  if (isRemoteWorkspacePath(ws) || isRemoteWorkspacePath(wt)) {
    const wsRoot = remotePosixOf(ws);
    const wtRoot = remotePosixOf(wt);
    if (!wsRoot || !wtRoot || wsRoot === wtRoot) return null;
    // 会话副本与「它所属的仓库根」都算主侧：远端 worker 常见的绝对路径是仓库根下的文件。
    const repoRoot = stripWorktreeSuffix(wsRoot) || '';
    const mainRoots = [...new Set([wsRoot, repoRoot])].filter((r) => r && r !== wtRoot);
    const wtPrefix = wtRoot.replace(/\/+$/, '');
    return {
      root: wtRoot,
      mainRoot: wsRoot,
      mainRoots,
      remote: true,
      map(target) {
        let s = String(target == null ? '' : target);
        if (!s) return { path: target };
        if (isLocalPathRef(s)) s = s.replace(/^local:[\\/]*/i, '');
        if (!s.startsWith('/')) return { path: target }; // 相对路径已由 resolvePath 拼到副本上
        const p = normalizeRemotePath(s);
        if (isSameOrUnderPosix(wtRoot, p)) return { path: p };
        for (const root of mainRoots) {
          if (!isSameOrUnderPosix(root, p)) continue;
          const rel = p.slice(root.replace(/\/+$/, '').length).replace(/^\/+/, '');
          return { path: rel ? `${wtPrefix}/${rel}` : wtPrefix };
        }
        return {
          denied: {
            error:
              `本轮是远端（SSH）副本里的执行器，只能写 ${wtRoot} 之内` +
              `（会话副本 ${wsRoot} 及其仓库下的路径会自动映射到副本）。${p} 落在这两处之外，未执行。`,
            errorCode: 'WORKER_SCOPE_DENIED',
            retryable: false
          }
        };
      },
      // 读不做重映射：远端没有本机文件系统可 `existsSync`，判断「副本里有没有这个文件」
      // 需要再开一次 SFTP/exec，代价远大于收益；读本身不破坏隔离。
      mapRead(target) {
        return target;
      }
    };
  }
  const wsRoot = path.resolve(ws);
  const wtRoot = path.resolve(wt);
  if (wtRoot === wsRoot) return null;

  /**
   * @param {string} target 已经过 resolvePath 的路径（相对路径此时已落在 worktree 上）
   * @returns {{ path: string } | { denied: { error: string, errorCode: string, retryable: boolean } }}
   */
  function map(target) {
    let s = String(target == null ? '' : target);
    if (!s) return { path: target };
    if (isLocalPathRef(s)) s = s.replace(/^local:[\\/]*/i, '');
    if (!path.isAbsolute(s)) return { path: target }; // 非绝对：resolvePath 已按 worktree 拼过
    const abs = path.resolve(s);
    if (isSameOrUnder(wtRoot, abs)) return { path: abs };
    if (isSameOrUnder(wsRoot, abs)) {
      return { path: path.join(wtRoot, path.relative(wsRoot, abs)) };
    }
    return {
      denied: {
        error:
          `本轮是 worktree 里的执行器，只能写 ${wtRoot} 之内（主工作区 ${wsRoot} 下的路径会自动映射到副本）。` +
          `${abs} 落在这两处之外，未执行。`,
        errorCode: 'WORKER_SCOPE_DENIED',
        retryable: false
      }
    };
  }

  /**
   * 读目标：**写完必须能读回来**。
   *
   * 写已被映射到副本，如果读还指着主工作区，模型「写文件 → 读一遍确认」会看到旧内容，
   * 于是判定写入失败、再写一遍、再读…… 表现是无限重试。
   * 规则：目标在副本里有对应文件就读副本；没有（node_modules、构建产物、未跟踪文件）
   * 就读主工作区那一份 —— worktree 只是 git 快照，这些天然不存在于副本里。
   * 工作区之外的读取不拦（是否可读由宿主权限/沙箱管，与普通轮同口径）。
   *
   * @param {string} target 已经过 resolvePath 的路径
   * @param {(p: string) => boolean} exists
   */
  function mapRead(target, exists) {
    let s = String(target == null ? '' : target);
    if (!s) return target;
    if (isLocalPathRef(s)) s = s.replace(/^local:[\\/]*/i, '');
    if (!path.isAbsolute(s)) return target;
    const abs = path.resolve(s);
    if (isSameOrUnder(wtRoot, abs)) return abs;
    if (!isSameOrUnder(wsRoot, abs)) return abs;
    const counterpart = path.join(wtRoot, path.relative(wsRoot, abs));
    return exists(counterpart) ? counterpart : abs;
  }

  return { root: wtRoot, mainRoot: wsRoot, map, mapRead };
}

/**
 * `host_exec` 命令正文里有没有**主工作区根路径**（用来堵「绕开副本直接写主工作区」）。
 *
 * 为什么只做这一条窄检查：`resolveExecCwdScoped` 只收口了 `cwd`，命令正文里的绝对路径
 * 完全不受约束 —— `sed -i C:\ws\src\a.js`、`cp x C:\ws\y` 会直接落到主工作区，
 * 绕过 worktree 隔离与「变更」面板。完整 shell 解析在这里既做不到也不划算（变量拼接、
 * base64、管道都能绕），但「模型直接写主工作区绝对路径」是绝大多数情况，用一条
 * 可解释的检查堵掉，并给结构化错误让它改用相对路径或 fs_*（那条路会自动映射到副本）。
 *
 * 两个必须成立的边界（否则这条检查自己就是故障源）：
 * 1. **本副本自己的路径不算越界**：本地 worktree 就建在主工作区里
 *    （`<ws>/.dieyun/worktrees/<runId>/<role>`），`node <副本>/scripts/build.js`、
 *    `git -C <副本> status` 的主工作区前缀是天然的，不能拒。
 * 2. **按路径段边界匹配**，不是纯子串：`C:\ws\app` 不能命中 `C:\ws\app-data\...`。
 *
 * @param {string} command
 * @param {string} mainRoot 主工作区绝对路径
 * @param {string} [ownRoot] 本副本根路径（命中它的前缀时放行）
 * @returns {string} 命中的形态（空 = 没命中）
 */
function findMainWorkspacePathInCommand(command, mainRoot, ownRoot) {
  const cmd = String(command || '').toLowerCase();
  const root = String(mainRoot || '').trim();
  if (!cmd || !root) return '';
  // 分隔符两种写法都要认：模型可能写 `C:\ws\x`，也可能写 `C:/ws/x`
  const variantsOf = (p) => {
    const base = String(p || '').trim().replace(/[\\/]+$/, '');
    if (!base) return [];
    return [...new Set([base, base.replace(/\\/g, '/'), base.replace(/\//g, '\\')])].map((s) =>
      s.toLowerCase()
    );
  };
  const ownVariants = variantsOf(ownRoot);
  const isBeforeBoundary = (ch) => !ch || /[\s"'`=<>|&;(]/.test(ch);
  const isAfterBoundary = (ch) => !ch || /[\\/\s"'`<>|&;),]/.test(ch);

  for (const needle of variantsOf(root)) {
    let from = 0;
    for (;;) {
      const idx = cmd.indexOf(needle, from);
      if (idx < 0) break;
      from = idx + 1;
      // 命中的是本副本自己的路径 → 放行（继续找下一个出现位置：命令里可能同时写了主工作区别处）
      if (ownVariants.some((own) => cmd.startsWith(own, idx))) continue;
      if (
        isBeforeBoundary(idx === 0 ? '' : cmd.charAt(idx - 1)) &&
        isAfterBoundary(cmd.charAt(idx + needle.length))
      ) {
        return needle;
      }
    }
  }
  return '';
}

function resolveFsReadMaxBytes(args, ctx) {
  const explicit = Number(args && args.maxBytes);
  if (Number.isFinite(explicit) && explicit > 0) return Math.floor(explicit);
  try {
    const n = Number(
      (getAgentLimits(ctx && ctx.userDataPath, ctx && ctx.contextTierId) || {}).fsReadDefaultMaxBytes
    );
    if (Number.isFinite(n) && n > 0) return Math.floor(n);
  } catch {
    /* defaults */
  }
  return AGENT_LIMITS_DEFAULTS.fsReadDefaultMaxBytes;
}

/**
 * Main 进程：将 agent 工具名映射到 Gateway RPC（Rust loop delegate 用）。
 * @param {{ invokeRpc: Function } | null} gateway
 * @param {string} name
 * @param {object} args
 * @param {{ workspacePath?: string, worktreePath?: string }} [ctx]
 */
async function delegateAgentToolViaGateway(gateway, name, args, ctx = {}) {
  if (!gateway || typeof gateway.invokeRpc !== 'function') {
    throw new Error('Gateway 未就绪');
  }
  const norm = normalizeAgentToolName(name, args);
  name = norm.name;
  const a = { ...(norm.args || {}) };
  const wt = ctx.worktreePath || '';
  const ws = ctx.workspacePath || '';

  function withRunWorkspace(params) {
    const out = { ...(params || {}) };
    if (ws) out.runWorkspaceRoot = ws;
    if (ctx.sessionId) out.sessionId = String(ctx.sessionId);
    return out;
  }

  function resolvePath(p) {
    if (p == null) return p;
    const fp = String(p);
    // `local:` 是本机绝对路径的显式标记：绝不能当相对路径拼到工作空间上
    //（SSH 会话里会拼出 `ssh://…/local:C:\…` 这种永远不存在的假路径）
    if (isLocalPathRef(fp)) return fp;
    if (/^[a-zA-Z]:[\\/]/.test(fp) || fp.startsWith('\\\\')) return fp;
    const base = wt || ws;
    if (!base || /^ssh:\/\//i.test(String(base))) return fp;
    const sep = base.includes('\\') ? '\\' : '/';
    // POSIX 宿主上 `/var/lib/x` 就是**绝对路径**，不能再拼一次工作区。
    // 之前无条件 `base + '/' + fp去头斜杠`，在 Linux/macOS 上把绝对路径拼成了
    // `/ws/var/lib/x` 这种幻觉路径（真机 headless 首跑就炸在 fs_list_dir：
    // `/var/lib/dieyun-agent/.dieyun/workspace/var/lib/dieyun-agent/.dieyun/workspace`）。
    // Windows 侧保持原语义：`/src/main.js` 是模型常写的「工作区相对」，去掉头斜杠再拼。
    if (sep === '/' && fp.startsWith('/')) return fp;
    return `${base.replace(/[\\/]+$/, '')}${sep}${fp.replace(/^\.?[\\/]/, '')}`;
  }

  function resolveExecCwd(explicit) {
    if (explicit) return explicit;
    if (wt) return wt;
    const w = ws ? String(ws).trim() : '';
    if (!w || /^ssh:\/\//i.test(w)) return undefined;
    return w;
  }

  // 写目标的作用域（worktree 优先、越界拒绝）：只对有 worktreePath 的运行生效。
  const writeScope = createWorkerWriteScope(ws, wt);

  /**
   * 写目标的路径解析：先按既有规则解析（相对 → worktree），再过写作用域。
   * @returns {{ path?: string } | { denied: object }}
   */
  function resolveWriteTarget(p) {
    const resolved = resolvePath(p);
    if (!writeScope) return { path: resolved };
    return writeScope.map(resolved);
  }

  /**
   * 读目标的路径解析：相对路径本就落在 worktree；绝对路径「副本里有就读副本」。
   * @param {string} p
   */
  function resolveReadTarget(p) {
    const resolved = resolvePath(p);
    if (!writeScope) return resolved;
    return writeScope.mapRead(resolved, (candidate) => {
      try {
        return fs.existsSync(candidate);
      } catch {
        return false;
      }
    });
  }

  /** `host_exec` 的 cwd：绝对/相对都收口到副本（相对 cwd 不处理就会被 Gateway 按主工作区解析）。 */
  function resolveExecCwdScoped(explicit) {
    if (!explicit) return { path: resolveExecCwd(null) };
    const s = String(explicit);
    if (!writeScope) return { path: resolveExecCwd(s) };
    const isAbs = /^[a-zA-Z]:[\\/]/.test(s) || path.isAbsolute(s);
    const base = isAbs ? s : path.join(writeScope.root, s.replace(/^\.?[\\/]/, ''));
    return writeScope.map(resolvePath(base));
  }

  /** 浏览器工具的落盘参数（screenshot / pdf / har_export / visual_diff）：空值保持 undefined。 */
  function writeFileArg(p) {
    if (p == null || String(p).trim() === '') return { path: undefined };
    return resolveWriteTarget(p);
  }

  function browserRpc(method, params) {
    return gateway.invokeRpc(method, withRunWorkspace(params || {}));
  }

  /**
   * frame 家族参数统一透传。
   * 每个 case 手抄一份必然漏（漏了就静默失效、模型以为是工具不支持），所以集中一处。
   */
  function frameArgs(a = {}) {
    const out = { frame: a.frame };
    if (a.force === true) out.force = true;
    if (a.mode) out.mode = a.mode;
    if (a.annotate != null) out.annotate = a.annotate;
    return out;
  }

  switch (name) {
    case 'host_open_url':
      return gateway.invokeRpc('host.open_url', { url: a.url });
    case 'host_print_image':
      return gateway.invokeRpc('host.print_image', withRunWorkspace({ filePath: resolvePath(a.filePath) }));
    case 'computer': {
      const params = {
        action: a.action,
        button: a.button,
        text: a.text,
        key: a.key,
        direction: a.direction,
        amount: a.amount,
        ms: a.ms,
        display: a.display,
        // 两台机器：缺省 local（叠云这台机器）；remote = 会话 SSH 主机的屏幕
        target: a.target
      };
      if (Array.isArray(a.coordinate)) params.coordinate = a.coordinate;
      if (Array.isArray(a.to)) params.to = a.to;
      // 这几个是工具描述里承诺过的参数，过去在这里被静默吞掉：
      // schema 允许、模型传了、执行端永远收不到（区域裁剪 / 修饰键 / wait_until 条件 / 窗口句柄全失效）
      if (Array.isArray(a.modifiers)) params.modifiers = a.modifiers;
      if (Array.isArray(a.region)) params.region = a.region;
      if (a.condition != null) params.condition = a.condition;
      if (a.handle != null) params.handle = a.handle;
      if (a.clickCount != null) params.clickCount = a.clickCount;
      return gateway.invokeRpc('computer.action', withRunWorkspace(params));
    }
    case 'host_exec': {
      // cwd 是命令的写落地：绝对路径要按写作用域收口（否则 `cd` 到主工作区就绕过了 worktree）
      const cwdTarget = resolveExecCwdScoped(a.cwd);
      if (cwdTarget.denied) return cwdTarget.denied;
      // 命令**正文**里的主工作区绝对路径同样会绕过隔离（cwd 收口挡不住 `sed -i <主工作区路径>`）
      if (writeScope && writeScope.mainRoot) {
        // 第三参数是本副本根：副本就在主工作区里，它自己的路径前缀是合法的
        const leaked = findMainWorkspacePathInCommand(a.command, writeScope.mainRoot, writeScope.root);
        if (leaked) {
          // 与同分支其它拒绝（`return cwdTarget.denied`）同一形状：摊平的错误信封。
          // 套一层 `denied` 会让 tool-harness 判不出失败（它只认 ok/error），这次调用被记成成功。
          return {
            error:
              `命令里写了主工作区路径（${leaked}），本轮是 worktree 里的执行器，不能直接改主工作区。` +
              '本轮的改动要落在副本里 —— 用相对路径（cwd 已在副本），' +
              '或用 fs_edit / fs_write_file 写同一文件（这两个会自动映射到副本）。',
            errorCode: 'WORKER_SCOPE_DENIED',
            retryable: false
          };
        }
      }
      return gateway.invokeRpc(
        'host.exec',
        withRunWorkspace({
          command: a.command,
          cwd: cwdTarget.path,
          // local:true = 在叠云这台机器上跑（SSH 会话里默认是远端主机）
          ...(isLocalFlag(a.local) ? { local: true } : {}),
          detached: !!a.detached,
          timeoutMs: a.timeoutMs,
          waitMs: a.waitMs,
          keepOnTimeout: a.keepOnTimeout === true,
          runId: ctx.runId || undefined,
          sessionId: ctx.sessionId || undefined
        })
      );
    }
    case 'host_proc': {
      const action = a.action === 'kill' ? 'kill' : a.action === 'output' ? 'output' : 'list';
      // local:true = 看/管本机那张句柄表（SSH 会话里起过本机后台进程时用）
      const localFlag = isLocalFlag(a.local) ? { local: true } : {};
      if (action === 'kill') {
        return gateway.invokeRpc(
          'host.proc_kill',
          withRunWorkspace({ id: a.id, pid: a.pid, sessionId: ctx.sessionId || undefined, ...localFlag })
        );
      }
      if (action === 'output') {
        return gateway.invokeRpc(
          'host.proc_output',
          withRunWorkspace({
            id: a.id,
            pid: a.pid,
            offset: a.offset,
            tailBytes: a.tailBytes,
            waitMs: a.waitMs,
            sessionId: ctx.sessionId || undefined,
            ...localFlag
          })
        );
      }
      return gateway.invokeRpc(
        'host.proc_list',
        withRunWorkspace({
          includeFinished: a.includeFinished === true,
          sessionId: ctx.sessionId || undefined,
          ...localFlag
        })
      );
    }
    case 'fs_read_file':
      return gateway.invokeRpc(
        'fs.read_file',
        withRunWorkspace({
          filePath: resolveReadTarget(a.filePath),
          encoding: a.encoding || 'utf8',
          offset: a.offset,
          maxBytes: resolveFsReadMaxBytes(a, ctx)
        })
      );
    case 'fs_write_file': {
      if (a.content == null || typeof a.content !== 'string') {
        return { error: 'fs_write_file 缺少有效 content（字符串）' };
      }
      const target = resolveWriteTarget(a.filePath);
      if (target.denied) return target.denied;
      return gateway.invokeRpc(
        'fs.write_file',
        withRunWorkspace({
          filePath: target.path,
          data: a.content,
          undoSessionId: ctx.sessionId || undefined,
          undoTurnId: ctx.undoTurnId || undefined
        })
      );
    }
    case 'fs_edit': {
      const { hasLegacy, hasEdits, oldString, newString } = fsEditArgsPresent(a);
      if (!hasLegacy && !hasEdits) {
        return { error: 'fs_edit 缺少 oldString 或 edits' };
      }
      const target = resolveWriteTarget(a.filePath || a.path);
      if (target.denied) return target.denied;
      const payload = withRunWorkspace({
        filePath: target.path,
        replaceAll: a.replaceAll === true || a.replace_all === true,
        undoSessionId: ctx.sessionId || undefined,
        undoTurnId: ctx.undoTurnId || undefined
      });
      if (hasLegacy) {
        payload.oldString = oldString;
        payload.newString = newString;
      }
      if (hasEdits) payload.edits = a.edits;
      return gateway.invokeRpc('fs.edit_file', payload);
    }
    case 'fs_list_dir':
      return gateway.invokeRpc(
        'fs.list_dir',
        withRunWorkspace({ dirPath: resolveReadTarget(a.dirPath) })
      );
    case 'grep':
      return gateway.invokeRpc(
        'fs.grep',
        withRunWorkspace({
          pattern: a.pattern,
          glob: a.glob,
          path: a.path ? resolveReadTarget(a.path) : a.path,
          regex: a.regex === true,
          caseInsensitive: a.caseInsensitive === true || a.case_insensitive === true,
          context: a.context,
          beforeContext: a.beforeContext != null ? a.beforeContext : a.before_context,
          afterContext: a.afterContext != null ? a.afterContext : a.after_context,
          multiline: a.multiline === true,
          type: a.type || a.fileType || a.file_type,
          count: a.count === true,
          maxResults: a.maxResults || a.limit
        })
      );
    case 'read_symbol': {
      const fp = a.filePath || a.file_path || a.path;
      return gateway.invokeRpc(
        'fs.read_symbol',
        withRunWorkspace({
          filePath: fp ? resolveReadTarget(fp) : undefined,
          name: a.name || a.symbol || a.query || a.symbolName,
          line: a.line,
          maxLines: a.maxLines || a.max_lines
        })
      );
    }
    case 'glob':
      return gateway.invokeRpc(
        'fs.glob',
        withRunWorkspace({
          pattern: a.pattern,
          maxResults: a.maxResults || a.limit
        })
      );
    case 'lsp': {
      const op = a.operation || a.op;
      // workspaceSymbol 是纯名字查询，path 可能是工作区而非文件，不搬运
      const fp = a.filePath || a.file_path || (op === 'workspaceSymbol' ? null : a.path);
      const params = {
        operation: op,
        line: a.line,
        character: a.character != null ? a.character : a.column != null ? a.column : a.col,
        query: a.query != null ? a.query : a.symbol || a.name
      };
      if (fp != null && String(fp).trim()) params.filePath = resolveReadTarget(fp);
      return gateway.invokeRpc('lsp.query', withRunWorkspace(params));
    }
    case 'web_fetch':
      return gateway.invokeRpc('web.fetch', { url: a.url, maxChars: a.maxChars });
    case 'web_search':
      return gateway.invokeRpc('web.search', {
        query: a.query,
        engine: a.engine,
        site: a.site,
        page: a.page,
        fetchTop: a.fetchTop,
        maxChars: a.maxChars
      });
    case 'codebase_search':
      return gateway.invokeRpc(
        'codebase.search',
        withRunWorkspace({
          query: a.query,
          limit: a.limit,
          workspaceRoot: a.workspaceRoot || ws || wt || undefined
        })
      );
    case 'graph': {
      const op = String(a.operation || a.op || '').trim();
      const wr = a.workspaceRoot || ws || wt || undefined;
      if (op === 'module_deps') {
        return gateway.invokeRpc(
          'graph.module_deps',
          withRunWorkspace({
            path: a.path,
            depth: a.depth,
            workspaceRoot: wr,
            autoIndex: false
          })
        );
      }
      if (op === 'find_symbol') {
        return gateway.invokeRpc(
          'graph.symbol_search',
          withRunWorkspace({
            query: a.query,
            kind: a.kind,
            limit: a.limit,
            workspaceRoot: wr,
            autoIndex: false
          })
        );
      }
      if (op === 'callers') {
        return gateway.invokeRpc(
          'graph.callers',
          withRunWorkspace({
            path: a.path,
            name: a.name,
            symbolId: a.symbolId,
            workspaceRoot: wr,
            autoIndex: false
          })
        );
      }
      if (op === 'callees') {
        return gateway.invokeRpc(
          'graph.callees',
          withRunWorkspace({
            path: a.path,
            name: a.name,
            symbolId: a.symbolId,
            workspaceRoot: wr,
            autoIndex: false
          })
        );
      }
      if (op === 'impact') {
        return gateway.invokeRpc(
          'graph.impact',
          withRunWorkspace({
            path: a.path,
            depth: a.depth,
            workspaceRoot: wr,
            autoIndex: false
          })
        );
      }
      if (op === 'lsp_callers') {
        return gateway.invokeRpc(
          'graph.lsp_resolve',
          withRunWorkspace({
            path: a.path,
            name: a.name,
            symbolId: a.symbolId,
            persist: a.persist,
            workspaceRoot: wr
          })
        );
      }
      return { error: `未知 graph.operation: ${op || '(空)'}` };
    }
    case 'browser_navigate':
      return browserRpc('browser.navigate', {
        url: a.url,
        engine: a.engine,
        waitUntil: a.waitUntil
      });
    case 'browser_reload':
      return browserRpc('browser.reload', {
        engine: a.engine,
        waitUntil: a.waitUntil,
        timeoutMs: a.timeoutMs
      });
    case 'browser_back':
      return browserRpc('browser.back', {
        engine: a.engine,
        waitUntil: a.waitUntil,
        timeoutMs: a.timeoutMs
      });
    case 'browser_forward':
      return browserRpc('browser.forward', {
        engine: a.engine,
        waitUntil: a.waitUntil,
        timeoutMs: a.timeoutMs
      });
    case 'browser_import_storage':
      return browserRpc('browser.import_storage', {
        cookies: a.cookies,
        localStorage: a.localStorage,
        engine: a.engine
      });
    case 'browser_snapshot':
      return browserRpc('browser.snapshot', {
        interactive: a.interactive !== false,
        engine: a.engine,
        delayMs: a.delayMs,
        mode: a.mode,
        maxElements: a.maxElements,
        frame: a.frame
      });
    case 'browser_frames':
      return browserRpc('browser.frames', { engine: a.engine });
    case 'browser_timeline':
      return browserRpc('browser.timeline', {
        action: a.action,
        limit: a.limit,
        sinceMs: a.sinceMs,
        types: a.types,
        type: a.type,
        source: a.source,
        frame: a.frame,
        urlPattern: a.urlPattern,
        includeInput: a.includeInput,
        engine: a.engine
      });
    case 'browser_a11y_snapshot':
      return browserRpc('browser.a11y_snapshot', {
        maxNodes: a.maxNodes,
        delayMs: a.delayMs,
        engine: a.engine,
        frame: a.frame
      });
    case 'browser_network':
      return browserRpc('browser.network', {
        action: a.action,
        limit: a.limit,
        urlPattern: a.urlPattern,
        errorsOnly: a.errorsOnly,
        sinceMs: a.sinceMs,
        engine: a.engine
      });
    case 'browser_console':
      return browserRpc('browser.console', {
        action: a.action,
        limit: a.limit,
        level: a.level,
        errorsOnly: a.errorsOnly,
        urlPattern: a.urlPattern,
        sinceMs: a.sinceMs,
        engine: a.engine
      });
    case 'browser_click':
      return browserRpc('browser.click', {
        ref: a.ref,
        selector: a.selector,
        button: a.button,
        clickCount: a.clickCount,
        engine: a.engine,
        ...frameArgs(a)
      });
    case 'browser_double_click':
      return browserRpc('browser.click', {
        ref: a.ref,
        selector: a.selector,
        clickCount: 2,
        engine: a.engine,
        ...frameArgs(a)
      });
    case 'browser_right_click':
      return browserRpc('browser.click', {
        ref: a.ref,
        selector: a.selector,
        button: 'right',
        engine: a.engine,
        ...frameArgs(a)
      });
    case 'browser_type':
      return browserRpc('browser.type', {
        ref: a.ref,
        selector: a.selector,
        text: a.text,
        clear: a.clear,
        engine: a.engine,
        ...frameArgs(a)
      });
    case 'browser_fill':
      return browserRpc('browser.fill', {
        ref: a.ref,
        selector: a.selector,
        text: a.text,
        engine: a.engine,
        ...frameArgs(a)
      });
    case 'browser_select_option':
      return browserRpc('browser.select_option', {
        ref: a.ref,
        selector: a.selector,
        value: a.value,
        label: a.label,
        engine: a.engine,
        ...frameArgs(a)
      });
    case 'browser_hover':
      return browserRpc('browser.hover', { ref: a.ref, selector: a.selector, engine: a.engine, ...frameArgs(a) });
    case 'browser_drag':
      return browserRpc('browser.drag', {
        ref: a.ref,
        selector: a.selector,
        toRef: a.toRef,
        toSelector: a.toSelector,
        dx: a.dx,
        dy: a.dy,
        engine: a.engine,
        ...frameArgs(a)
      });
    case 'browser_scroll':
      return browserRpc('browser.scroll', {
        direction: a.direction,
        amount: a.amount,
        ref: a.ref,
        selector: a.selector,
        engine: a.engine,
        ...frameArgs(a)
      });
    case 'browser_press_key':
      return browserRpc('browser.press_key', {
        key: a.key,
        modifiers: a.modifiers,
        engine: a.engine,
        ...frameArgs(a)
      });
    case 'browser_screenshot': {
      const out = writeFileArg(a.filePath);
      if (out.denied) return out.denied;
      return browserRpc('browser.screenshot', {
        ref: a.ref,
        selector: a.selector,
        fullPage: a.fullPage,
        filePath: out.path,
        engine: a.engine,
        frame: a.frame,
        annotate: a.annotate
      });
    }
    case 'browser_viewport':
      return browserRpc('browser.viewport', {
        width: a.width,
        height: a.height,
        deviceScaleFactor: a.deviceScaleFactor,
        mobile: a.mobile,
        reset: a.reset,
        engine: a.engine
      });
    case 'browser_wait_for':
      return browserRpc('browser.wait_for', {
        kind: a.kind || a.type,
        value: a.value,
        selector: a.selector,
        text: a.text,
        url: a.url,
        expression: a.expression,
        state: a.state,
        engine: a.engine,
        timeoutMs: a.timeoutMs,
        intervalMs: a.intervalMs,
        frame: a.frame
      });
    case 'browser_tabs':
      return browserRpc('browser.tabs', {
        action: a.action,
        tabId: a.tabId,
        url: a.url,
        engine: a.engine,
        waitUntil: a.waitUntil,
        timeoutMs: a.timeoutMs
      });
    case 'browser_downloads':
      return browserRpc('browser.downloads', { action: a.action, engine: a.engine, timeoutMs: a.timeoutMs });
    case 'browser_upload_file':
      return browserRpc('browser.upload_file', {
        ref: a.ref,
        selector: a.selector,
        filePath: resolvePath(a.filePath),
        mime: a.mime,
        engine: a.engine,
        timeoutMs: a.timeoutMs,
        frame: a.frame
      });
    case 'browser_evaluate':
      return browserRpc('browser.evaluate', {
        script: a.script,
        maxChars: a.maxChars,
        timeoutMs: a.timeoutMs,
        engine: a.engine,
        frame: a.frame
      });
    case 'browser_visual_diff': {
      const out = writeFileArg(a.filePath);
      if (out.denied) return out.denied;
      return browserRpc('browser.visual_diff', {
        baselinePath: a.baselinePath ? resolvePath(a.baselinePath) : undefined,
        filePath: out.path,
        ref: a.ref,
        selector: a.selector,
        threshold: a.threshold,
        fullPage: a.fullPage,
        reset: a.reset,
        engine: a.engine
      });
    }
    case 'browser_expect':
      return browserRpc('browser.expect', {
        assertions: a.assertions,
        timeoutMs: a.timeoutMs,
        engine: a.engine,
        frame: a.frame
      });
    case 'browser_pdf': {
      const out = writeFileArg(a.filePath);
      if (out.denied) return out.denied;
      return browserRpc('browser.pdf', {
        filePath: out.path,
        format: a.format,
        landscape: a.landscape,
        printBackground: a.printBackground,
        engine: a.engine
      });
    }
    case 'browser_export_storage':
      // 会话分区由 withRunWorkspace 注入当前 run 的 sessionId，无需模型传参
      return browserRpc('browser.export_storage', {
        cookies: a.cookies,
        localStorage: a.localStorage,
        url: a.url,
        engine: a.engine
      });
    case 'browser_cookies':
      return browserRpc('browser.cookies', {
        action: a.action,
        url: a.url,
        name: a.name,
        value: a.value,
        domain: a.domain,
        path: a.path,
        secure: a.secure,
        httpOnly: a.httpOnly,
        sameSite: a.sameSite,
        cookies: a.cookies,
        engine: a.engine
      });
    case 'browser_dialog':
      return browserRpc('browser.dialog', {
        action: a.action,
        accept: a.accept,
        promptText: a.promptText,
        policy: a.policy,
        engine: a.engine
      });
    case 'browser_route':
      return browserRpc('browser.route', {
        action: a.action,
        urlPattern: a.urlPattern,
        type: a.type,
        status: a.status,
        body: a.body,
        headers: a.headers,
        contentType: a.contentType,
        errorReason: a.errorReason,
        id: a.id,
        engine: a.engine
      });
    case 'browser_emulate':
      return browserRpc('browser.emulate', {
        action: a.action,
        geolocation: a.geolocation,
        timezone: a.timezone,
        locale: a.locale,
        permissions: a.permissions,
        engine: a.engine
      });
    case 'browser_har_export': {
      const out = writeFileArg(a.filePath);
      if (out.denied) return out.denied;
      return browserRpc('browser.har_export', {
        filePath: out.path,
        engine: a.engine
      });
    }
    case 'browser_observe':
      return browserRpc('browser.observe', {
        interactive: a.interactive !== false,
        maxElements: a.maxElements,
        delayMs: a.delayMs,
        screenshot: a.screenshot !== false,
        fullPage: a.fullPage,
        mode: a.mode,
        annotate: a.annotate,
        frame: a.frame,
        engine: a.engine
      });
    case 'browser_status':
      return browserRpc('browser.status', {});
    case 'browser_close':
      return browserRpc('browser.close', {});
    default:
      if (name === 'apply_patch') {
        const blocked = applyPatchUnsupported();
        return { error: blocked.error, errorCode: blocked.errorCode, suggestedFix: blocked.suggestedFix };
      }
      // 插件不再提供工具（只保留事件钩子）：第三方工具一律走 MCP。
      return { error: `未知工具: ${name}` };
  }
}

module.exports = {
  delegateAgentToolViaGateway,
  resolveFsReadMaxBytes,
  createWorkerWriteScope,
  findMainWorkspacePathInCommand
};
