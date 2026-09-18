'use strict';

const fs = require('fs/promises');
const fsSync = require('fs');
const path = require('path');
const { DEFLIKE_RE, breEscape, firstIdentifier, inferBlockEnd } = require('../symbol-text');
const { ABSOLUTE_READ_MAX_BYTES } = require('../fs-read-limits');

/** 远程 read_symbol 走 LSP 时的超时（远程 LSP 可能冷启动，超时即回落结构索引） */
const REMOTE_READ_SYMBOL_LSP_TIMEOUT_MS = 20000;

function createFsHandlers(d) {
  const {
    perms,
    getRemoteFs,
    resolveHostSidecarLocalPath,
    sidecarReadOpts,
    readSidecarFileAt,
    normalizeFilePathInput,
    cwdForCall,
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
    globViaRemoteExec,
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

    // 远程 LSP：只在「按键行定位」时尝试——结构索引按名搜，无法定位包含某行的最内层符号。
    // 其余场景直接走结构索引，避免为常见查询付远程 LSP 冷启动的代价。
    if (isSsh && wantLine > 0 && relHint && getRemoteAgentInfo && getRemoteAgentClient) {
      try {
        const info = getRemoteAgentInfo();
        if (info && info.url) {
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
    'fs.read_file': async ({ filePath, encoding, offset, maxBytes }) => {
      if (!perms.hostControl || !perms.fsRead) {
        const e = new Error('文件读取未授权');
        e.code = 'FS_READ_DISABLED';
        throw e;
      }
      const sidecar = resolveHostSidecarLocalPath(filePath, sidecarReadOpts());
      if (sidecar) return readSidecarFileAt(sidecar, encoding, { offset, maxBytes });
      const remote = getRemoteFs();
      if (remote) return remote.readFile(filePath, encoding, { offset, maxBytes });
      const resolved = normalizeFilePathInput(filePath, cwdForCall());
      const safe = assertAllowedPath(resolved, readRootsForCall());
      const rustRead = await invokeRustCore('fs.read_file', {
        filePath: safe,
        encoding,
        offset,
        maxBytes
      });
      if (rustRead) return rustRead;
      return readAllowedTextFile(filePath, encoding, { offset, maxBytes });
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

      const target =
        typeof ctx.getWorkspaceTarget === 'function' ? ctx.getWorkspaceTarget() : null;
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
          error: symName
            ? `没找到符号「${symName}」的精确范围。可先用 grep 确认名字，或 graph find_symbol 看结构索引里是否有该符号${isSsh ? '（远程需已建结构索引）' : ''}。`
            : '该位置未识别出符号，请改用 fs_read_file 配合行号读取。'
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
        truncated,
        code: body.join('\n')
      };
    },

    'fs.write_file': async ({ filePath, data, encoding, undoSessionId, undoTurnId }) => {
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
      const remote = getRemoteFs();
      if (remote) {
        let beforeText = null;
        try {
          if (enc === 'utf8') {
            const prev = await remote.readFile(filePath, 'utf8');
            beforeText = prev.data;
          }
        } catch {
          beforeText = null;
        }
        const r = await remote.writeFile(filePath, data, encoding);
        if (
          lspDiagnostics &&
          enc === 'utf8' &&
          typeof lspDiagnostics.scheduleFileDiagnosticsRefresh === 'function' &&
          isSshConnectedForCall() &&
          perms.shellExec
        ) {
          const remoteRoot = String(cwdForCall() || '').replace(/\\/g, '/').replace(/\/$/, '');
          void lspDiagnostics
            .scheduleFileDiagnosticsRefresh(remoteRoot, r.path || filePath, {
              immediate: true,
              mode: 'ssh',
              sshExec: (command, cwd, timeoutMs) => requireSshForCall().exec(command, cwd, timeoutMs)
            })
            .catch(() => {});
        }
        captureUndoWrite({
          undoSessionId,
          undoTurnId,
          filePath: r.path || filePath,
          beforeText,
          encoding: enc,
          remote: true
        });
        return r;
      }
      const resolved = normalizeFilePathInput(filePath, cwdForCall());
      const safe = assertAllowedPath(resolved, writeRootsForCall());
      const buf = enc === 'base64' ? Buffer.from(String(data), 'base64') : Buffer.from(String(data), 'utf8');
      let beforeText = null;
      try {
        if (enc === 'utf8' && fsSync.existsSync(safe)) {
          beforeText = await fs.readFile(safe, 'utf8');
        }
      } catch {
        beforeText = null;
      }
      await fs.mkdir(path.dirname(safe), { recursive: true });
      await fs.writeFile(safe, buf);
      if (lspDiagnostics) {
        const workspaceRoot = cwdForCall() ? path.resolve(cwdForCall()) : null;
        if (
          workspaceRoot &&
          typeof lspDiagnostics.scheduleFileDiagnosticsRefresh === 'function'
        ) {
          void lspDiagnostics
            .scheduleFileDiagnosticsRefresh(workspaceRoot, safe, { immediate: enc === 'utf8' })
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
        const graphRoot = cwdForCall() ? path.resolve(cwdForCall()) : null;
        graphIncremental.notifyFileSaved(safe, graphRoot);
      }
      if (codebaseIncremental && enc === 'utf8') {
        const codeRoot = cwdForCall() ? path.resolve(cwdForCall()) : null;
        codebaseIncremental.notifyFileSaved(safe, codeRoot);
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
        writeUtf8: (filePath, data) =>
          handlers['fs.write_file']({
            filePath,
            data,
            encoding: 'utf8',
            undoSessionId,
            undoTurnId
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
      const remote = getRemoteFs();
      if (remote) return remote.mkdir(dirPath);
      const resolved = normalizeFilePathInput(dirPath, cwdForCall());
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
      const remote = getRemoteFs();
      if (remote) return remote.listDir(dirPath);
      const resolved = normalizeFilePathInput(dirPath, cwdForCall());
      const safe = assertAllowedPath(resolved, readRootsForCall());
      const rustList = await invokeRustCore('fs.list_dir', { dirPath: safe });
      if (rustList) return rustList;
      const names = await fs.readdir(safe, { withFileTypes: true });
      const out = [];
      for (const ent of names) {
        const full = path.join(safe, ent.name);
        let st;
        try {
          st = await fs.stat(full);
        } catch {
          continue;
        }
        out.push({
          name: ent.name,
          isDirectory: st.isDirectory(),
          size: st.size,
          mtimeMs: st.mtimeMs
        });
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
      const agentInfo = getRemoteAgentInfo();
      if (agentInfo && agentInfo.url) {
        try {
          const client = getRemoteAgentClient(agentInfo);
          return await client.call('fs.grep', {
            pattern: pat,
            glob,
            path: searchPath,
            regex: regex === true,
            caseInsensitive: ci,
            ...ctxArgs,
            maxResults
          });
        } catch {
          try {
            const fb = await getRemoteAgentClient(agentInfo).call('codebase.grep', {
              pattern: pat,
              glob,
              maxResults
            });
            // codebase.grep 是降级路径（basename 级 --include、无 -i/regex/上下文）：
            // 空结果继续往下走，否则会把「降级查不到」当成最终「0 命中」
            if (fb && Array.isArray(fb.matches) && fb.matches.length) return fb;
          } catch {
            /* fall through */
          }
        }
      }
      if (getRemoteFs()) {
        const via = await grepViaRemoteExec(cwdForCall(), {
          pattern: pat,
          glob,
          path: searchPath,
          regex: regex === true,
          caseInsensitive: ci,
          type: type || undefined,
          multiline: multiline === true,
          context,
          beforeContext: ctxBefore,
          afterContext: ctxAfter,
          count: count === true,
          maxResults
        });
        if (via) return via;
      }
      const root = cwdForCall();
      if (!root) {
        const e = new Error('未设置工作区');
        e.code = 'INVALID_WORKSPACE';
        throw e;
      }
      assertAllowedPath(path.resolve(root), readRootsForCall());
      return grepWorkspace(root, {
        pattern: pat,
        glob,
        path: searchPath,
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
      const agentInfo = getRemoteAgentInfo();
      if (agentInfo && agentInfo.url) {
        try {
          return await getRemoteAgentClient(agentInfo).call('fs.glob', { pattern: pat, maxResults });
        } catch {
          /* fall through */
        }
      }
      if (getRemoteFs()) {
        const via = await globViaRemoteExec(cwdForCall(), { pattern: pat, maxResults });
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
      const remote = getRemoteFs();
      if (remote) return remote.stat(filePath);
      const resolved = normalizeFilePathInput(filePath, cwdForCall());
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

module.exports = { createFsHandlers };
