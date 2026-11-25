'use strict';

const fs = require('fs/promises');
const fsSync = require('fs');
const path = require('path');
const { DEFLIKE_RE, breEscape, firstIdentifier, inferBlockEnd } = require('../symbol-text');
const { ABSOLUTE_READ_MAX_BYTES } = require('../fs-read-limits');
const { isRemoteAgentUsable } = require('../remote-agent-client');
// 「本机」路径语义（`local:` 前缀）的唯一来源：判定在 rpc.js:resolveFsTarget，
// 这里只用它的解析/提示函数，不自己写 startsWith('local:')。
const { splitLocalGlob, isLocalPathRef, annotateLocalPathMiss } = require('../host-local');
const { recordSkillRead } = require('../../skills/usage-ledger');
// 「这条路径确实不存在」的唯一判据（本机 ENOENT / SFTP NO_SUCH_FILE / 远端 RPC ENOENT）
const { isPathMissingError } = require('../path-policy');

/**
 * 撤回快照读不到原文：**必须失败**，不能让这次写「照常成功、撤回时删文件」。
 *
 * 撤回侧对 `before == null` 的解释是「这个文件写之前不存在」（`rpc.js:restoreUndoFile`），
 * 所以读失败时唯一安全的做法是把这次写判为失败 —— 用户宁可这次写没发生，也不要撤回删文件。
 */
function undoSnapshotUnavailable(targetPath, cause) {
  const e = new Error(
    `写入前的原文读取失败，撤回快照不可用，已放弃本次写入（${targetPath}）：` +
      `${(cause && cause.message) || cause}`
  );
  e.code = 'UNDO_SNAPSHOT_UNAVAILABLE';
  e.path = targetPath;
  e.cause = cause;
  return e;
}

/**
 * 远程 read_symbol 走 LSP 时的超时。
 *
 * 曾经是 20000ms：每次冷启动都等满 20 秒才回落结构索引，而结构索引 50–100ms 就能答
 * （遥测里 20012ms / 20017ms 的「成功」调用就是这段空等，见 docs/INDEX-VALUE-REVIEW.md §7.5）。
 * 远程 LSP 只在「按行定位、没给符号名」时才有结构索引替代不了的作用（见 locateSymbolForRead），
 * 这种场景 3 秒答不出来就等于不可用 —— 再等 17 秒买不到任何东西。
 */
const REMOTE_READ_SYMBOL_LSP_TIMEOUT_MS = 3000;
/** 通知远端索引「文件变了」的 RPC 预算：只做调度，很快；超时也不影响这次写 */
const REMOTE_INDEX_NOTIFY_TIMEOUT_MS = 8000;

/**
 * 通知远端进程「这个文件变了」。
 *
 * 桌面端的远端写入走 SFTP（`remote-fs`），**不经过**远端进程的 `fs.write_file`，
 * 于是远端的增量索引调度永远不触发 —— 远端 `codebase.grep` / 图谱会一直照着旧内容答。
 * 调度规则不在这里判断：远端 `index.notify_change` 用与 `fs.write_file` 同一份规则决定要不要索引。
 *
 * fire-and-forget：索引新鲜度是次生效果，不许拖慢、更不许弄失败这次写。
 */
function notifyRemoteIndexChange({ getRemoteAgentInfo, getRemoteAgentClient }, params) {
  try {
    if (typeof getRemoteAgentClient !== 'function') return;
    const info = typeof getRemoteAgentInfo === 'function' ? getRemoteAgentInfo() : null;
    if (!isRemoteAgentUsable(info)) return;
    void Promise.resolve(
      getRemoteAgentClient(info).call('index.notify_change', params || {}, REMOTE_INDEX_NOTIFY_TIMEOUT_MS)
    ).catch(() => {});
  } catch {
    // 远端 agent 不可用：这轮索引不更新，下一次写入或状态轮询会补上
  }
}


function createFsHandlers(d) {
  const {
    perms,
    getRemoteFs,
    resolveFsTarget,
    resolveHostSidecarLocalPath,
    sidecarReadOpts,
    readSidecarFileAt,
    normalizeFilePathInput,
    cwdForCall,
    resolveCallWorkspaceTarget,
    assertAllowedPath,
    readRootsForCall,
    invokeRustCore,
    invokeIndexCore,
    resolveCodebaseContext,
    readAllowedTextFile,
    assertHostEnabled,
    ctx,
    captureUndoWrite,
    writeRootsForCall,
    assertSandboxWritable,
    lspDiagnostics,
    isSshConnectedForCall,
    requireSshForCall,
    graphIncremental,
    codebaseIncremental,
    summarizeLineDiff,
    runEditFile,
    listSidecarDirAt,
    getRemoteAgentInfo,
    getRemoteAgentClient,
    grepViaRemoteExec,
    grepWorkspace,
    globWorkspace,
  } = d;
  /**
   * read_symbol 的符号定位：
   * - 本地：LSP documentSymbol（精确、可按键行命中）优先，回退结构索引；
   * - 远程(SSH)：没有 LSP，直接走结构索引——远程 agent 上跑的就是同一份
   *   dieyun-core，所以 graph.symbol_search 在远程同样可用。
   * 返回 { name, kind, relPath, startLine, endLine, source } 或 null。
   */
  async function locateSymbolForRead({ safe, symName, wantLine, root, isSsh, relHint }) {
    const candidates = [];

    if (!isSsh && safe && lspDiagnostics && typeof lspDiagnostics.queryPosition === 'function') {
      try {
        const res = await lspDiagnostics.queryPosition({
          operation: 'documentSymbol',
          workspaceRoot: root,
          absPath: safe
        });
        if (res && res.ok && Array.isArray(res.symbols)) {
          for (const s of res.symbols) {
            candidates.push({
              name: s.name,
              kind: s.kind,
              relPath: s.path,
              startLine: Number(s.line) || 1,
              endLine: Number(s.endLine) || Number(s.line) || 1,
              source: 'lsp'
            });
          }
        }
      } catch {
        /* 回退结构索引 */
      }
    }

    // 远程 LSP：只在「按键行定位且没给符号名」时尝试 —— 这是结构索引唯一替代不了的场景：
    // 按名搜不到「包含第 N 行的最内层符号」。只要给了 `name`，结构索引返回的候选自带
    // startLine/endLine（实测 20/20 命中，见 docs/INDEX-VALUE-REVIEW.md §7.2），
    // 下面 wantLine 的「取包含该行且范围最小者」照样成立，LSP 只是同一条结论的更慢路径。
    if (isSsh && !symName && wantLine > 0 && relHint && getRemoteAgentInfo && getRemoteAgentClient) {
      try {
        const info = getRemoteAgentInfo();
        if (isRemoteAgentUsable(info)) {
          const res = await getRemoteAgentClient(info).call(
            'lsp.query',
            { operation: 'documentSymbol', filePath: String(relHint) },
            REMOTE_READ_SYMBOL_LSP_TIMEOUT_MS
          );
          if (res && res.ok && Array.isArray(res.symbols)) {
            for (const s of res.symbols) {
              candidates.push({
                name: s.name,
                kind: s.kind,
                relPath: s.path || relHint,
                startLine: Number(s.line) || 1,
                endLine: Number(s.endLine) || Number(s.line) || 1,
                source: 'lsp-remote'
              });
            }
          }
        }
      } catch {
        /* 远程 LSP 不可用 → 落到结构索引 */
      }
    }

    // 结构索引：本地调本地 core，远程经 remote agent 调远程 core（invokeIndexCore 自动分流）
    if (invokeIndexCore && resolveCodebaseContext) {
      const relHintNorm = String(relHint || '')
        .replace(/\\/g, '/')
        .replace(/^\.?\//, '');
      // 只有本地才退化用文件名当查询词；SSH 下它必然搜不到，纯粹浪费一次远程往返
      const query =
        symName ||
        (!isSsh && safe ? path.basename(safe) : '') ||
        (!isSsh && relHintNorm ? path.basename(relHintNorm) : '');
      if (query) {
        try {
          const ctxInfo = resolveCodebaseContext(undefined);
          const g = await invokeIndexCore(
            ctxInfo,
            'graph.symbol_search',
            { query, limit: 30 },
            30000
          );
          for (const s of (g && g.results) || []) {
            candidates.push({
              name: s.name,
              kind: s.kind,
              relPath: s.path,
              startLine: Number(s.startLine) || 1,
              endLine: Number(s.endLine) || Number(s.startLine) || 1,
              source: 'graph'
            });
          }
        } catch {
          /* 保持候选为空 */
        }
      }
    }

    // SSH 最终兜底：远程结构索引可能压根没建，此时前面两条路都是空。
    // 退到远程 grep 按名找「像定义」的行；只给出行号，符号体范围交给 handler 推断。
    if (
      isSsh &&
      !candidates.length &&
      (symName || (relHint && wantLine > 0)) &&
      typeof grepViaRemoteExec === 'function'
    ) {
      const hint = String(relHint || '')
        .replace(/\\/g, '/')
        .replace(/^\.?\//, '');
      let targetName = symName;
      // 只给了 filePath+line：读远程文件该行，取行内标识符当名字
      if (!targetName && hint && wantLine > 0) {
        const remote = typeof getRemoteFs === 'function' ? getRemoteFs() : null;
        if (remote) {
          try {
            const r = await remote.readFile(hint, 'utf8');
            const text =
              typeof r === 'string' ? r : r && r.data != null ? String(r.data) : '';
            targetName = firstIdentifier(text.split(/\r?\n/)[wantLine - 1] || '');
          } catch {
            /* 读不到就放弃这条兜底 */
          }
        }
      }
      if (targetName) {
        try {
          const g = await grepViaRemoteExec(cwdForCall(), {
            pattern: `\\b${breEscape(targetName)}\\b`,
            path: hint || undefined,
            maxResults: 60
          });
          const rows = (g && g.matches) || [];
          if (rows.length) {
            const ranked = rows
              .map((m) => ({ m, def: DEFLIKE_RE.test(String(m.text || '')) ? 0 : 1 }))
              .sort((a, b) => a.def - b.def || (Number(a.m.line) || 0) - (Number(b.m.line) || 0));
            const hit = ranked[0].m;
            candidates.push({
              name: targetName,
              kind: 'symbol(grep)',
              relPath: String(hit.path || hint || '').replace(/\\/g, '/'),
              startLine: Number(hit.line) || 1,
              endLine: Number(hit.line) || 1,
              source: 'grep-remote'
            });
          }
        } catch {
          /* 兜底也失败则保持为空，由调用方给出提示 */
        }
      }
    }

    if (!candidates.length) return null;

    // 远程没有本地绝对路径，用工具传入的相对路径做文件范围限定
    const normRel =
      safe && root
        ? path.relative(root, safe).replace(/\\/g, '/')
        : String(relHint || '')
            .replace(/\\/g, '/')
            .replace(/^\.?\//, '');

    const pathMatches = (candidate) => {
      if (!normRel) return true;
      const c = String(candidate || '')
        .replace(/\\/g, '/')
        .replace(/^\.?\//, '');
      if (!c) return true;
      if (c === normRel) return true;
      // core 返回的 path 可能带目录前缀差异，用后缀双向匹配兜底
      return c.endsWith(`/${normRel}`) || normRel.endsWith(`/${c}`);
    };

    // 按位置命中：取包含该行且范围最小的符号
    if (wantLine > 0) {
      const enclosing = candidates
        .filter((c) => c.startLine <= wantLine && c.endLine >= wantLine)
        .filter((c) => pathMatches(c.relPath))
        .sort((a, b) => a.endLine - a.startLine - (b.endLine - b.startLine));
      if (enclosing.length) return enclosing[0];
    }

    if (symName) {
      const named = candidates.filter((c) => c.name === symName);
      const pool = named.length ? named : candidates.filter((c) => c.name.includes(symName));
      if (pool.length) {
        const scoped = pool.filter((c) => pathMatches(c.relPath));
        const use = scoped.length ? scoped : pool;
        // 同名多处时取范围最小者（通常是真正的定义而非外层容器）
        return use.slice().sort((a, b) => a.endLine - a.startLine - (b.endLine - b.startLine))[0];
      }
    }

    // 只给了 filePath/line 但没名字：取该文件范围最小的顶层符号
    if (normRel) {
      const scoped = candidates.filter((c) => pathMatches(c.relPath));
      if (scoped.length) {
        const first = scoped.slice().sort((a, b) => a.startLine - b.startLine)[0];
        if (wantLine > 0) return first;
      }
    }
    return null;
  }

  const handlers = {
    'fs.read_file': async ({ filePath, encoding, offset, maxBytes, sessionId }) => {
      if (!perms.hostControl || !perms.fsRead) {
        const e = new Error('文件读取未授权');
        e.code = 'FS_READ_DISABLED';
        throw e;
      }
      const sidecar = resolveHostSidecarLocalPath(filePath, sidecarReadOpts());
      if (sidecar) return readSidecarFileAt(sidecar, encoding, { offset, maxBytes });
      const target = resolveFsTarget(filePath);
      if (target.remote) {
        try {
          return await target.remote.readFile(target.path, encoding, { offset, maxBytes });
        } catch (err) {
          throw annotateLocalPathMiss(err, target.path);
        }
      }
      const resolved = normalizeFilePathInput(target.path, target.base);
      const safe = assertAllowedPath(resolved, readRootsForCall());
      // 技能使用账本：这条读的是 SKILL.md 就记一笔（只记事实，不记内容）。
      // 记录点必须在「读成功」之后，且自己吞错 —— 账本是旁证，不许影响读取本身。
      const noteSkillRead = () => {
        void recordSkillRead({ userData: ctx.userDataPath, skillPath: safe, sessionId });
      };
      const rustRead = await invokeRustCore('fs.read_file', {
        filePath: safe,
        encoding,
        offset,
        maxBytes
      });
      if (rustRead) {
        noteSkillRead();
        return rustRead;
      }
      // 传已解析的绝对路径：readAllowedTextFile 内部还会按 `cwdForCall()` 再解析一次，
      // 而 SSH 会话里那是**远端**路径 —— 把 `local:…` 原样递进去会被拼成另一台机器上的位置。
      const textRead = await readAllowedTextFile(safe, encoding, { offset, maxBytes });
      noteSkillRead();
      return textRead;
    },

    'fs.read_symbol': async ({ filePath, name, line, maxLines }) => {
      if (!perms.hostControl || !perms.fsRead) {
        const e = new Error('文件读取未授权');
        e.code = 'FS_READ_DISABLED';
        throw e;
      }
      const symName = String(name || '').trim();
      const wantLine = Number(line) > 0 ? Math.floor(Number(line)) : 0;
      const cap = Math.min(2000, Math.max(20, Number(maxLines) || 400));
      const hasPath = !!(filePath && String(filePath).trim());
      if (!hasPath && !symName) {
        const e = new Error('需要 filePath 或 name');
        e.code = 'MISSING_PARAM';
        throw e;
      }
      // 只给 filePath 是无效输入：符号定位只有「按 name 找」与「按包含某行的最小符号」
      // 两条路（见 locateSymbolForRead 末尾 wantLine > 0 的分支），裸路径必返回 null。
      // 在此快速失败，避免白跑一趟 LSP + 结构索引后回一句不指向病因的 SYMBOL_NOT_FOUND。
      if (hasPath && !symName && !wantLine) {
        const e = new Error(
          '需要 name 或 line：只给 filePath 无法定位符号。读整个文件请用 fs_read_file（可配 offset/maxBytes）。'
        );
        e.code = 'MISSING_PARAM';
        throw e;
      }
      // read_symbol 靠 LSP / 会话结构索引定位，本机文件不在会话索引里（SSH 会话尤其）：
      // 直接说清楚，别让它带着 local: 前缀去查远端索引空手而归。
      if (hasPath && isLocalPathRef(filePath)) {
        const e = new Error(
          'read_symbol 只覆盖会话工作空间的符号（LSP / 结构索引），不支持 local: 本机路径'
        );
        e.code = 'LOCAL_PATH_UNSUPPORTED';
        e.retryable = false;
        e.suggestedFix =
          '读本机文件用 fs_read_file（路径可带 local: 前缀，配 offset/maxBytes 分块读），本机不进会话索引。';
        throw e;
      }

      const target =
        typeof resolveCallWorkspaceTarget === 'function' ? resolveCallWorkspaceTarget() : null;
      const isSsh = !!(target && target.kind === 'ssh');

      // 远程走 SFTP，不能套本地白名单校验
      const root = !isSsh && cwdForCall() ? path.resolve(cwdForCall()) : '';
      const safe =
        !isSsh && hasPath
          ? assertAllowedPath(normalizeFilePathInput(filePath, cwdForCall()), readRootsForCall())
          : '';

      const pick = await locateSymbolForRead({
        safe,
        symName,
        wantLine,
        root,
        isSsh,
        relHint: hasPath ? filePath : ''
      });
      if (!pick) {
        return {
          ok: false,
          errorCode: 'SYMBOL_NOT_FOUND',
          retryable: false,
          // 远程本来就没有 LSP、结构索引也常未建：这不是「符号不存在」，
          // 而是「这个能力在远程降级」。标出来，模型才不会一个名字反复重试。
          degraded: isSsh,
          error: symName
            ? `没找到符号「${symName}」的精确范围${isSsh ? '（远程工作区无 LSP，结构索引可能未建）' : ''}。`
            : `第 ${wantLine} 行没有可定位的符号（该文件类型可能没有 Language Server，或结构索引未覆盖）。`,
          suggestedFix: isSsh
            ? '远程请改走两步：① grep 搜符号名（给 path / glob 限定范围拿到 file:line）② fs_read_file 配 offset/maxBytes 读定义附近。不要用同一个名字重复 read_symbol。'
            : '先用 grep 确认名字拼写，或 graph find_symbol 看结构索引是否覆盖该类型；读整段代码用 fs_read_file + offset/maxBytes。'
        };
      }

      let text = '';
      let displayPath = pick.relPath || '';
      if (isSsh) {
        const remote = getRemoteFs();
        if (!remote) {
          return {
            ok: false,
            errorCode: 'REMOTE_FS_UNAVAILABLE',
            error: '远程文件服务未就绪（SSH 未连接）'
          };
        }
        const rel = pick.relPath || String(filePath || '');
        try {
          const r = await remote.readFile(rel, 'utf8', { maxBytes: ABSOLUTE_READ_MAX_BYTES });
          if (r && r.truncated === true) {
            return {
              ok: false,
              errorCode: 'SYMBOL_FILE_TOO_LARGE',
              error: `远程文件 ${rel} 超过 ${ABSOLUTE_READ_MAX_BYTES} 字节，read_symbol 无法整读。请改用 fs_read_file 指定 offset/maxBytes 分块读取。`
            };
          }
          text =
            typeof r === 'string'
              ? r
              : r && r.data != null
                ? String(r.data)
                : r && r.content != null
                  ? String(r.content)
                  : '';
        } catch (err) {
          return {
            ok: false,
            errorCode: 'FS_READ_FAILED',
            error: err && err.message ? String(err.message) : String(err)
          };
        }
        displayPath = rel;
      } else {
        const abs = safe || (root && pick.relPath ? path.join(root, pick.relPath) : '');
        if (!abs) {
          return { ok: false, errorCode: 'SYMBOL_NOT_FOUND', error: '无法解析符号所在文件路径' };
        }
        try {
          const st = await fs.stat(abs);
          if (st.size > ABSOLUTE_READ_MAX_BYTES) {
            return {
              ok: false,
              errorCode: 'SYMBOL_FILE_TOO_LARGE',
              error: `文件 ${abs} 过大（${st.size} 字节），read_symbol 无法整读。请改用 fs_read_file 指定 offset/maxBytes 分块读取。`
            };
          }
          text = await fs.readFile(abs, 'utf8');
        } catch (err) {
          return {
            ok: false,
            errorCode: 'FS_READ_FAILED',
            error: err && err.message ? String(err.message) : String(err)
          };
        }
        displayPath =
          root && abs.startsWith(root)
            ? path.relative(root, abs).replace(/\\/g, '/')
            : pick.relPath || abs;
      }

      const lines = text.split(/\r?\n/);
      const startLine = Math.max(1, pick.startLine);
      // 结构索引可能已过期（文件被改短）：越界就直接说明，避免拼出 undefined 行
      if (startLine > lines.length) {
        return {
          ok: false,
          errorCode: 'SYMBOL_STALE',
          error: `符号定位在 ${displayPath}:${startLine}，但文件只有 ${lines.length} 行（索引可能已过期）。请用 grep 重新确认位置。`
        };
      }
      let endLine = Math.max(startLine, pick.endLine);
      // grep 兜底只给出定义行，符号体范围按花括号/缩进启发式补全
      if (pick.source === 'grep-remote') {
        endLine = Math.max(startLine, inferBlockEnd(lines, startLine, cap));
      }
      if (endLine > lines.length) endLine = lines.length;
      let truncated = false;
      if (endLine - startLine + 1 > cap) {
        endLine = startLine + cap - 1;
        truncated = true;
      }
      const body = [];
      for (let i = startLine; i <= endLine; i++) {
        body.push(`${String(i).padStart(5, ' ')}| ${lines[i - 1]}`);
      }
      return {
        ok: true,
        path: displayPath,
        name: pick.name,
        kind: pick.kind,
        startLine,
        endLine,
        source: pick.source,
        // grep-remote 只拿到定义行、符号体范围是启发式推的，必须自报降级，
        // 否则模型会把它当成 LSP 级精度去依赖（漏掉花括号之外的代码）。
        ...(pick.source === 'grep-remote'
          ? {
              degraded: true,
              note: '远程无 LSP/结构索引，符号体范围由 grep 命中行 + 缩进推理得到，末尾可能不精确；需要完整定义请 fs_read_file 多读几行。'
            }
          : null),
        truncated,
        code: body.join('\n')
      };
    },

    'fs.write_file': async ({
      filePath,
      data,
      encoding,
      undoSessionId,
      undoTurnId,
      undoBeforeText
    }) => {
      assertHostEnabled(ctx);
      if (!perms.fsWrite) {
        const e = new Error('文件写入未授权');
        e.code = 'FS_WRITE_DISABLED';
        throw e;
      }
      const enc = encoding === 'base64' ? 'base64' : 'utf8';
      if (enc === 'utf8' && (data == null || typeof data !== 'string')) {
        const e = new Error('fs.write_file 缺少有效 data（字符串）');
        e.code = 'FS_WRITE_INVALID_DATA';
        throw e;
      }
      if (enc === 'base64' && data == null) {
        const e = new Error('fs.write_file 缺少 data');
        e.code = 'FS_WRITE_INVALID_DATA';
        throw e;
      }
      const target = resolveFsTarget(filePath);
      if (target.remote) {
        const remote = target.remote;
        const remotePath = target.path;
        // 远端写入与本地同一条档位链：路径按远端绝对路径判（工作区外要问、read-only 一律问），
        // 再受远端传输允许根约束。曾经这里「刻意不过本机沙箱」—— 结果是 SSH 会话里只读档名存实亡。
        const remoteAbs = remote.resolve(remotePath, remote.root);
        await assertSandboxWritable(remoteAbs, 'fs.write_file', { remote: true });
        // 调用方（fs.edit_file）刚读过同一文件时直接复用，省掉一次整读。
        let beforeText = typeof undoBeforeText === 'string' ? undoBeforeText : null;
        if (beforeText == null && enc === 'utf8') {
          try {
            const prev = await remote.readFile(remotePath, 'utf8');
            beforeText = prev.data;
          } catch (err) {
            // 只有「远端确实没有这个文件」才是「新建」。读失败当 null 的代价是撤回删文件
            // （`rpc.js:restoreUndoFile` 对 before == null 走删除分支）。
            if (!isPathMissingError(err)) throw undoSnapshotUnavailable(remotePath, err);
          }
        }
        let r;
        try {
          r = await remote.writeFile(remotePath, data, encoding);
        } catch (err) {
          throw annotateLocalPathMiss(err, remotePath);
        }
        // SFTP 写入远端看不见 → 必须补一条通知，否则远端索引停在旧内容，
        // 同一回合里 grep / 图谱都按旧代码答。走 RPC 时远端 handler 自己已经按
        // 同一份规则调度过了，再通知一遍只是多一次往返。
        if (remote.transport === 'sftp') {
          notifyRemoteIndexChange(
            { getRemoteAgentInfo, getRemoteAgentClient },
            { filePath: r.path || remotePath, encoding: enc, op: 'write' }
          );
        }
        if (
          lspDiagnostics &&
          enc === 'utf8' &&
          typeof lspDiagnostics.scheduleFileDiagnosticsRefresh === 'function' &&
          isSshConnectedForCall() &&
          perms.shellExec
        ) {
          const remoteRoot = String(cwdForCall() || '').replace(/\\/g, '/').replace(/\/$/, '');
          void lspDiagnostics
            .scheduleFileDiagnosticsRefresh(remoteRoot, r.path || remotePath, {
              immediate: true,
              mode: 'ssh',
              sshExec: (command, cwd, timeoutMs) => requireSshForCall().exec(command, cwd, timeoutMs)
            })
            .catch(() => {});
        }
        captureUndoWrite({
          undoSessionId,
          undoTurnId,
          filePath: r.path || remotePath,
          beforeText,
          encoding: enc,
          remote: true
        });
        return r;
      }
      const resolved = normalizeFilePathInput(target.path, target.base);
      await assertSandboxWritable(resolved, 'fs.write_file');
      const safe = assertAllowedPath(resolved, writeRootsForCall());
      // 本机索引 / 图谱的根：显式本机写（SSH 会话里写本机文件）不属于会话工作空间，
      // 塞 cwdForCall()（远端路径）给它只会 resolve 出一个假根。
      const localIndexRoot = target.explicitLocal
        ? null
        : cwdForCall()
          ? path.resolve(cwdForCall())
          : null;
      const buf = enc === 'base64' ? Buffer.from(String(data), 'base64') : Buffer.from(String(data), 'utf8');
      let beforeText = typeof undoBeforeText === 'string' ? undoBeforeText : null;
      // 「本来没有这个文件」与「读不出来」必须分开：撤回侧对 `before == null` 走的是删除分支
      // （`rpc.js:restoreUndoFile`），把读失败当 null 会把用户文件删掉。
      if (beforeText == null && enc === 'utf8' && fsSync.existsSync(safe)) {
        try {
          beforeText = await fs.readFile(safe, 'utf8');
        } catch (err) {
          throw undoSnapshotUnavailable(safe, err);
        }
      }
      await fs.mkdir(path.dirname(safe), { recursive: true });
      await fs.writeFile(safe, buf);
      if (lspDiagnostics) {
        const workspaceRoot = localIndexRoot;
        if (
          workspaceRoot &&
          typeof lspDiagnostics.scheduleFileDiagnosticsRefresh === 'function'
        ) {
          // 走 watch 队列（不再 immediate）：Agent 批量写文件时每次写都同步诊断一次，
          // 会把成百上千个 LSP 往返同时压到主进程（实测一轮 855 个 .py 卡死界面）。
          // 队列内部是「单定时器合并 + 分批」，单文件保存最多延后一个 debounce 周期。
          void lspDiagnostics
            .scheduleFileDiagnosticsRefresh(workspaceRoot, safe)
            .catch(() => {});
        } else if (typeof lspDiagnostics.invalidateCacheForPath === 'function') {
          lspDiagnostics.invalidateCacheForPath(safe);
        }
      }
      captureUndoWrite({
        undoSessionId,
        undoTurnId,
        filePath: safe,
        beforeText,
        encoding: enc,
        remote: false
      });
      if (graphIncremental && enc === 'utf8') {
        graphIncremental.notifyFileSaved(safe, localIndexRoot);
      }
      if (codebaseIncremental && enc === 'utf8') {
        codebaseIncremental.notifyFileSaved(safe, localIndexRoot);
      }
      let diff = null;
      if (enc === 'utf8') {
        diff = summarizeLineDiff(beforeText, data);
      }
      return { ok: true, path: safe, diff };
    },

    'fs.edit_file': async (params) => {
      assertHostEnabled(ctx);
      if (!perms.fsWrite) {
        const e = new Error('文件写入未授权');
        e.code = 'FS_WRITE_DISABLED';
        throw e;
      }
      const undoSessionId = params && params.undoSessionId;
      const undoTurnId = params && params.undoTurnId;
      return runEditFile(params, {
        readUtf8: (filePath, maxBytes) =>
          handlers['fs.read_file']({
            filePath,
            encoding: 'utf8',
            maxBytes
          }),
        writeUtf8: (filePath, data, writeOpts) =>
          handlers['fs.write_file']({
            filePath,
            data,
            encoding: 'utf8',
            undoSessionId,
            undoTurnId,
            // runEditFile 已经把原文读进来了：写入侧不必为撤销再整读一遍
            ...(writeOpts && typeof writeOpts.undoBeforeText === 'string'
              ? { undoBeforeText: writeOpts.undoBeforeText }
              : {})
          })
      });
    },

    'fs.mkdir': async ({ dirPath }) => {
      assertHostEnabled(ctx);
      if (!perms.fsWrite) {
        const e = new Error('文件写入未授权');
        e.code = 'FS_WRITE_DISABLED';
        throw e;
      }
      const target = resolveFsTarget(dirPath);
      if (target.remote) {
        try {
          const remoteAbs = target.remote.resolve(target.path, target.remote.root);
          await assertSandboxWritable(remoteAbs, 'fs.mkdir', { remote: true });
          return await target.remote.mkdir(target.path);
        } catch (err) {
          throw annotateLocalPathMiss(err, target.path);
        }
      }
      const resolved = normalizeFilePathInput(target.path, target.base);
      await assertSandboxWritable(resolved, 'fs.mkdir');
      const safe = assertAllowedPath(resolved, writeRootsForCall());
      await fs.mkdir(safe, { recursive: true });
      return { ok: true, path: safe };
    },

    'fs.list_dir': async ({ dirPath }) => {
      if (!perms.hostControl || !perms.fsRead) {
        const e = new Error('文件读取未授权');
        e.code = 'FS_READ_DISABLED';
        throw e;
      }
      const sidecar = resolveHostSidecarLocalPath(dirPath, sidecarReadOpts());
      if (sidecar) return listSidecarDirAt(sidecar);
      const target = resolveFsTarget(dirPath);
      if (target.remote) {
        try {
          return await target.remote.listDir(target.path);
        } catch (err) {
          throw annotateLocalPathMiss(err, target.path);
        }
      }
      const resolved = normalizeFilePathInput(target.path, target.base);
      const safe = assertAllowedPath(resolved, readRootsForCall());
      const rustList = await invokeRustCore('fs.list_dir', { dirPath: safe });
      if (Array.isArray(rustList) && rustList.length > 0) return rustList;
      // 空列表必须先证明「目录真的存在且真的是目录」，否则 `[]` 会把
      // 「路径写错 / 盘符不在 / 无权限」伪装成「空目录」：
      // 模型据此判「产物没生成」→ 重复生成、重复写入，代价远大于一次明确报错。
      const st = await fs.stat(safe).catch(() => null);
      if (!st) {
        const e = new Error(`目录不存在或无法访问: ${safe}`);
        e.code = 'FS_LIST_FAILED';
        e.path = safe;
        throw e;
      }
      if (!st.isDirectory()) {
        const e = new Error(`不是目录（是文件）: ${safe}`);
        e.code = 'FS_LIST_FAILED';
        e.path = safe;
        throw e;
      }
      // 目录确实为空：Rust 已给出权威答案，直接用，不必再走 Node 兜底。
      if (Array.isArray(rustList)) return rustList;
      const names = await fs.readdir(safe, { withFileTypes: true });
      // 逐条 stat 一次往返，但不必串行：分批并发（批次上限 32，避免几千条目打爆线程池）
      const out = [];
      const STAT_CONCURRENCY = 32;
      for (let i = 0; i < names.length; i += STAT_CONCURRENCY) {
        const rows = await Promise.all(
          names.slice(i, i + STAT_CONCURRENCY).map(async (ent) => {
            const full = path.join(safe, ent.name);
            const st = await fs.stat(full).catch(() => null);
            if (!st) return null;
            return {
              name: ent.name,
              isDirectory: st.isDirectory(),
              size: st.size,
              mtimeMs: st.mtimeMs
            };
          })
        );
        for (const row of rows) if (row) out.push(row);
      }
      return out;
    },

    'fs.grep': async ({
      pattern,
      glob,
      path: searchPath,
      regex,
      caseInsensitive,
      case_insensitive,
      context,
      beforeContext,
      before_context,
      afterContext,
      after_context,
      multiline,
      type,
      count,
      maxResults
    }) => {
      if (!perms.hostControl || !perms.fsRead) {
        const e = new Error('文件读取未授权');
        e.code = 'FS_READ_DISABLED';
        throw e;
      }
      const pat = String(pattern || '').trim();
      if (!pat) {
        const e = new Error('pattern 必填');
        e.code = 'MISSING_PATTERN';
        throw e;
      }
      const ci = caseInsensitive === true || case_insensitive === true;
      const ctxBefore = beforeContext != null ? beforeContext : before_context;
      const ctxAfter = afterContext != null ? afterContext : after_context;
      const ctxArgs = {
        context,
        beforeContext: ctxBefore,
        afterContext: ctxAfter,
        multiline: multiline === true,
        type: type || undefined,
        count: count === true
      };
      // 去哪台机器：`local:` 前缀明确指本机，其余跟随会话工作空间（见 rpc.js:resolveFsTarget）
      const target = resolveFsTarget(searchPath);
      // 适配器可能没实现 grep（老远端包 / 单测假对象）：按「这条传输做不了」回落本机搜索。
      if (target.remote && typeof target.remote.grep === 'function') {
        // 「远端怎么搜」由适配器决定（RPC 走远端 rg；SFTP 走 *ViaRemoteExec）。
        // handler 不再自己判「有没有 Agent / 是不是 SFTP」—— 那条判断的唯一位置是 rpc.js:getRemoteFs()。
        const via = await target.remote.grep({
          pattern: pat,
          glob,
          path: target.path,
          regex: regex === true,
          caseInsensitive: ci,
          ...ctxArgs,
          maxResults
        });
        if (via) return via;
      }
      // 本机搜索：显式 local: 时根就是它自己，否则是会话工作区
      const root = target.explicitLocal ? target.path : cwdForCall();
      if (!root) {
        const e = new Error('未设置工作区');
        e.code = 'INVALID_WORKSPACE';
        throw e;
      }
      assertAllowedPath(path.resolve(root), readRootsForCall());
      return grepWorkspace(root, {
        pattern: pat,
        glob,
        path: target.explicitLocal ? undefined : target.path,
        regex: regex === true,
        caseInsensitive: ci,
        ...ctxArgs,
        maxResults
      });
    },

    'fs.glob': async ({ pattern, maxResults }) => {
      if (!perms.hostControl || !perms.fsRead) {
        const e = new Error('文件读取未授权');
        e.code = 'FS_READ_DISABLED';
        throw e;
      }
      const pat = String(pattern || '').trim();
      if (!pat) {
        const e = new Error('pattern 必填');
        e.code = 'MISSING_PATTERN';
        throw e;
      }
      // 本机 glob：pattern 自带 `local:` 前缀（rg 的 -g 是相对 cwd 的，
      // 整条绝对 pattern 丢进去永远匹配不到，所以 root 由前缀里的字面目录定）
      const localGlob = splitLocalGlob(pat);
      if (localGlob) {
        assertAllowedPath(path.resolve(localGlob.root), readRootsForCall());
        return globWorkspace(localGlob.root, { pattern: localGlob.pattern, maxResults });
      }
      // 同 fs.grep：远端怎么 glob 由适配器决定，handler 不再自判传输。
      const remote = getRemoteFs();
      if (remote && typeof remote.glob === 'function') {
        const via = await remote.glob({ pattern: pat, maxResults });
        if (via) return via;
      }
      const root = cwdForCall();
      if (!root) {
        const e = new Error('未设置工作区');
        e.code = 'INVALID_WORKSPACE';
        throw e;
      }
      assertAllowedPath(path.resolve(root), readRootsForCall());
      return globWorkspace(root, { pattern: pat, maxResults });
    },

    'fs.stat': async ({ filePath }) => {
      if (!perms.hostControl || !perms.fsRead) {
        const e = new Error('文件读取未授权');
        e.code = 'FS_READ_DISABLED';
        throw e;
      }
      const target = resolveFsTarget(filePath);
      if (target.remote) {
        try {
          return await target.remote.stat(target.path);
        } catch (err) {
          throw annotateLocalPathMiss(err, target.path);
        }
      }
      const resolved = normalizeFilePathInput(target.path, target.base);
      const safe = assertAllowedPath(resolved, readRootsForCall());
      const st = await fs.stat(safe);
      return {
        isFile: st.isFile(),
        isDirectory: st.isDirectory(),
        size: st.size,
        mtimeMs: st.mtimeMs
      };
    },
  };
  return handlers;
}

module.exports = { createFsHandlers, notifyRemoteIndexChange };
