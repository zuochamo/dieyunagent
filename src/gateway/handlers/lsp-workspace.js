'use strict';

const path = require('path');
const {
  breEscape,
  identifierAt,
  firstIdentifier,
  DEFLIKE_RE,
  DEF_KEYWORD_BRE,
  DEF_NAME_RE,
  KIND_BY_KEYWORD
} = require('../symbol-text');

/** 远程 LSP 首次调用要等 server 启动（rust-analyzer 首次会索引整个 crate） */
const REMOTE_LSP_TIMEOUT_MS = 60000;

function createLspWorkspaceHandlers(d) {
  const {
    perms,
    ctx,
    lspDiagnostics,
    normalizeFilePathInput,
    cwdForCall,
    assertAllowedPath,
    readRootsForCall,
    isSshConnectedForCall,
    resolveSshManager,
    requireSshForCall,
    defaultCwd,
    getWorkspaceGitDiffContext,
    getWorkspaceGitChangedAbsPaths,
    currentSshWorkspaceRoot,
    resolveCodebaseContext,
    invokeIndexCore,
    getRemoteAgentInfo,
    getRemoteAgentClient,
    getRemoteFs,
    grepViaRemoteExec,
  } = d;

  /** 读远程文件文本（SFTP），失败返回 '' */
  async function readRemoteText(filePath) {
    const remote = typeof getRemoteFs === 'function' ? getRemoteFs() : null;
    if (!remote || !filePath) return '';
    try {
      const r = await remote.readFile(String(filePath), 'utf8');
      if (typeof r === 'string') return r;
      if (r && r.data != null) return String(r.data);
      if (r && r.content != null) return String(r.content);
      return '';
    } catch {
      return '';
    }
  }

  /**
   * goToDefinition 这类操作只给 filePath+line，没有符号名。
   * 先用 SFTP 读目标行，再从光标处/行首取标识符，作为 grep 降级的输入。
   */
  async function symbolNameAtRemote(filePath, line, character) {
    const text = await readRemoteText(filePath);
    if (!text) return '';
    const rows = text.split(/\r?\n/);
    const row = rows[Math.max(0, (Number(line) || 1) - 1)] || '';
    if (character != null && Number(character) > 1) {
      const at = identifierAt(row, Number(character) - 1);
      if (at) return at;
    }
    return firstIdentifier(row);
  }

  /** 远程无 LSP 时的 grep 降级：把「名字出现的位置」映射成 locations */
  async function remoteGrepLocations(opName, symbolName) {
    if (!symbolName || typeof grepViaRemoteExec !== 'function') return null;
    const g = await grepViaRemoteExec(cwdForCall(), {
      pattern: `\\b${breEscape(symbolName)}\\b`,
      maxResults: 80
    });
    const rows = (g && g.matches) || [];
    if (!rows.length) return null;
    const isDefOp =
      opName === 'goToDefinition' ||
      opName === 'typeDefinition' ||
      opName === 'goToImplementation';
    let pool = rows;
    if (isDefOp) {
      // 定义类查询：优先「像定义」的行，否则同名引用会排在定义前面
      const defs = rows.filter((m) => DEFLIKE_RE.test(String(m.text || '')));
      if (defs.length) pool = defs;
    }
    const out = [];
    const seen = new Set();
    for (const m of pool) {
      const p = String(m.path || '').replace(/\\/g, '/');
      const line = Number(m.line) || 1;
      const key = `${p}:${line}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const col = String(m.text || '').indexOf(symbolName);
      out.push({ path: p, line, character: col >= 0 ? col + 1 : 1 });
      if (out.length >= 80) break;
    }
    return out.length ? out : null;
  }

  /** 远程 documentSymbol 降级：按定义关键字列出该文件内的符号行 */
  async function remoteDocumentSymbols(filePath) {
    if (!filePath || typeof grepViaRemoteExec !== 'function') return null;
    const g = await grepViaRemoteExec(cwdForCall(), {
      pattern: DEF_KEYWORD_BRE,
      path: String(filePath),
      maxResults: 200
    });
    const rows = (g && g.matches) || [];
    const out = [];
    for (const m of rows) {
      const match = String(m.text || '').match(DEF_NAME_RE);
      if (!match) continue;
      out.push({
        name: match[2],
        kind: KIND_BY_KEYWORD[match[1]] || 'unknown',
        path: String(m.path || filePath).replace(/\\/g, '/'),
        line: Number(m.line) || 1,
        endLine: Number(m.line) || 1,
        character: 1,
        container: '',
        depth: 0
      });
      if (out.length >= 120) break;
    }
    return out.length ? out : null;
  }

  return {
    'lsp.query': async ({
      operation,
      op,
      filePath,
      file_path,
      path: symbolPath,
      line,
      character,
      column,
      col,
      query
    }) => {
      if (!perms.hostControl || !perms.fsRead) {
        const e = new Error('文件读取未授权');
        e.code = 'FS_READ_DISABLED';
        throw e;
      }
      const opName = operation || op;
      const charArg = character != null ? character : column != null ? column : col;
      const fpArg = filePath || file_path || symbolPath;
      const target =
        typeof ctx.getWorkspaceTarget === 'function' ? ctx.getWorkspaceTarget() : null;
      if (target && target.kind === 'ssh') {
        // 远程 LSP：远程 agent 用它自己环境里的 Language Server
        // （rust-analyzer / gopls 走 PATH，ts/py 走远程工作区的 node_modules）。
        const remoteInfo = typeof getRemoteAgentInfo === 'function' ? getRemoteAgentInfo() : null;
        if (remoteInfo && remoteInfo.url && opName) {
          if (opName !== 'workspaceSymbol' && (!fpArg || !String(fpArg).trim())) {
            return {
              ok: false,
              errorCode: 'MISSING_PATH',
              error: 'filePath 必填（定义/引用/hover 类操作需要 filePath + line）'
            };
          }
          try {
            const r = await getRemoteAgentClient(remoteInfo).call(
              'lsp.query',
              {
                operation: opName,
                filePath: fpArg ? String(fpArg) : undefined,
                line,
                character: charArg,
                query
              },
              REMOTE_LSP_TIMEOUT_MS
            );
            if (r && r.ok !== false) return r;
            // 仅「远程确实没有 server」才继续降级；其他错误原样返回，便于定位问题
            if (r && r.errorCode && r.errorCode !== 'LSP_UNAVAILABLE') return r;
          } catch {
            /* 远程 LSP 调用失败 → 落到下面的降级路径 */
          }
        }
        // 降级：workspaceSymbol 用远程结构索引兜底（远程 agent 上跑着同一份 dieyun-core）
        if (opName === 'workspaceSymbol') {
          const q = String(query || '').trim();
          if (!q) {
            return {
              ok: false,
              errorCode: 'LSP_MISSING_QUERY',
              error: 'workspaceSymbol 需要 query（符号名）'
            };
          }
          try {
            const ctxInfo = resolveCodebaseContext(undefined);
            const g = await invokeIndexCore(
              ctxInfo,
              'graph.symbol_search',
              { query: q, limit: 30 },
              30000
            );
            return {
              ok: true,
              kind: 'symbols',
              symbols: ((g && g.results) || []).map((s) => ({
                name: s.name,
                kind: s.kind,
                path: s.path,
                line: Number(s.startLine) || 1,
                endLine: Number(s.endLine) || Number(s.startLine) || 1,
                container: '',
                depth: 0
              })),
              servers: ['graph(remote)'],
              query: q,
              degraded: true
            };
          } catch (err) {
            return {
              ok: false,
              errorCode: 'LSP_UNAVAILABLE',
              error: `远程结构索引不可用：${err && err.message ? err.message : String(err)}`
            };
          }
        }
        // 二级降级：远程 LSP 与结构索引都不可用时，用远程 grep 给出候选位置。
        // 语义精度不如 LSP，但至少让「这个符号在哪」不必退化成人手多轮 grep。
        try {
          if (opName === 'documentSymbol') {
            const syms = await remoteDocumentSymbols(fpArg);
            if (syms) {
              return {
                ok: true,
                kind: 'symbols',
                symbols: syms,
                servers: ['grep(remote)'],
                degraded: true,
                note: '远程无 Language Server，已用 grep 按定义关键字列出符号，非语义结果。'
              };
            }
          } else if (opName !== 'hover') {
            let name = String(query || '').trim();
            if (!name) name = await symbolNameAtRemote(fpArg, line, charArg);
            if (name) {
              const locs = await remoteGrepLocations(opName, name);
              if (locs) {
                return {
                  ok: true,
                  kind: 'locations',
                  locations: locs,
                  servers: ['grep(remote)'],
                  degraded: true,
                  query: name,
                  note:
                    '远程无 Language Server，已用 grep 按名匹配（可能混入引用或同名符号），非语义结果；建议再用 grep 带 context 复核。'
                };
              }
            }
          }
        } catch {
          /* 兜底失败 → 落到下面的不可用提示 */
        }
        return {
          ok: false,
          errorCode: 'LSP_UNAVAILABLE',
          error:
            '远程没有可用的 Language Server（需在远程安装 rust-analyzer / gopls，或让工作区 node_modules 带上 ts/py server）。workspaceSymbol 已尝试远程结构索引；其他定位请用 grep / graph / read_symbol。'
        };
      }
      if (!lspDiagnostics || typeof lspDiagnostics.queryPosition !== 'function') {
        return { ok: false, errorCode: 'LSP_UNAVAILABLE', error: 'LSP 未启用' };
      }
      const fp = filePath || file_path || symbolPath;
      // workspaceSymbol 是纯名字查询，不需要文件；其余 operation 需要 filePath(+line)
      const needsFile = opName !== 'workspaceSymbol';
      if (needsFile && (!fp || !String(fp).trim())) {
        return {
          ok: false,
          errorCode: 'MISSING_PATH',
          error: 'filePath 必填（定义/引用/hover 类操作需要 filePath + line）'
        };
      }
      const safe = fp && String(fp).trim() ? assertAllowedPath(normalizeFilePathInput(fp, cwdForCall()), readRootsForCall()) : '';
      const cwd = cwdForCall();
      const workspaceRoot = cwd ? path.resolve(cwd) : safe ? path.dirname(safe) : '';
      return lspDiagnostics.queryPosition({
        operation: opName,
        workspaceRoot,
        absPath: safe || undefined,
        line,
        character: charArg,
        query
      });
    },

    'workspace.diagnostics': async (params) => {
      if (!lspDiagnostics) {
        return { ok: false, error: 'LSP 未启用', items: [], skipped: [] };
      }
      const target =
        typeof ctx.getWorkspaceTarget === 'function' ? ctx.getWorkspaceTarget() : null;
      const fileList = Array.isArray(params.files) ? params.files : [];
      if (!perms.hostControl || !perms.fsRead) {
        const e = new Error('文件读取未授权');
        e.code = 'FS_READ_DISABLED';
        throw e;
      }

      if (target && target.kind === 'ssh') {
        const connected = isSshConnectedForCall();
        if (!connected) {
          return {
            ok: true,
            enabled: false,
            mode: 'ssh_cli',
            items: [],
            skipped: fileList.map((f) => ({ file: f, reason: 'ssh_not_connected' }))
          };
        }
        if (!resolveSshManager()) {
          return {
            ok: true,
            enabled: false,
            mode: 'ssh_cli',
            items: [],
            skipped: fileList.map((f) => ({ file: f, reason: 'ssh_unavailable' }))
          };
        }
        if (!perms.shellExec) {
          return {
            ok: true,
            enabled: false,
            mode: 'ssh_cli',
            items: [],
            skipped: fileList.map((f) => ({ file: f, reason: 'shell_exec_disabled' }))
          };
        }
        const remoteRoot = String(target.remotePath || defaultCwd || '')
          .replace(/\\/g, '/')
          .replace(/\/$/, '');
        const useDiagnosticStore = params.useDiagnosticStore !== false;
        if (useDiagnosticStore && typeof lspDiagnostics.getAgentDiagnosticsContext === 'function') {
          return lspDiagnostics.getAgentDiagnosticsContext({
            workspaceRoot: remoteRoot,
            files: fileList,
            maxFiles: params.maxFiles,
            maxPerFile: params.maxPerFile,
            minSeverity: params.minSeverity,
            timeoutMs: params.timeoutMs,
            storeStaleMs: params.storeStaleMs,
            sshExec: (command, cwd, timeoutMs) => requireSshForCall().exec(command, cwd, timeoutMs)
          });
        }
        return lspDiagnostics.diagnoseFilesRemote({
          sshExec: (command, cwd, timeoutMs) => requireSshForCall().exec(command, cwd, timeoutMs),
          workspaceRoot: remoteRoot,
          files: fileList,
          maxFiles: params.maxFiles,
          maxPerFile: params.maxPerFile,
          minSeverity: params.minSeverity,
          timeoutMs: params.timeoutMs
        });
      }

      const workspaceRoot = params.workspaceRoot
        ? path.resolve(String(params.workspaceRoot))
        : cwdForCall()
          ? path.resolve(cwdForCall())
          : defaultCwd
            ? path.resolve(defaultCwd)
            : null;
      if (!workspaceRoot) {
        return { ok: false, error: '未设置工作区', items: [], skipped: [] };
      }

      const useDiagnosticStore = params.useDiagnosticStore !== false;
      if (useDiagnosticStore && typeof lspDiagnostics.getAgentDiagnosticsContext === 'function') {
        let gitDirtyFiles = [];
        if (params.includeGitDirty !== false) {
          try {
            const remoteRoot = currentSshWorkspaceRoot();
            gitDirtyFiles = await getWorkspaceGitChangedAbsPaths(remoteRoot || workspaceRoot, {
              maxFiles: params.maxFiles || 16,
              remote: !!remoteRoot,
              sshExec: remoteRoot
                ? (command, cwd, timeoutMs) => requireSshForCall().exec(command, cwd, timeoutMs)
                : undefined
            });
          } catch {
            gitDirtyFiles = [];
          }
        }
        return lspDiagnostics.getAgentDiagnosticsContext({
          workspaceRoot,
          files: fileList,
          gitDirtyFiles,
          maxFiles: params.maxFiles,
          maxPerFile: params.maxPerFile,
          minSeverity: params.minSeverity,
          timeoutMs: params.timeoutMs,
          storeStaleMs: params.storeStaleMs,
          assertReadable: async (absPath) => {
            const resolved = normalizeFilePathInput(absPath, cwdForCall() || defaultCwd);
            return assertAllowedPath(resolved, readRootsForCall());
          }
        });
      }

      return lspDiagnostics.diagnoseFiles({
        workspaceRoot,
        files: fileList,
        maxFiles: params.maxFiles,
        maxPerFile: params.maxPerFile,
        minSeverity: params.minSeverity,
        timeoutMs: params.timeoutMs,
        assertReadable: async (absPath) => {
          const resolved = normalizeFilePathInput(absPath, cwdForCall() || defaultCwd);
          return assertAllowedPath(resolved, readRootsForCall());
        }
      });
    },

    'workspace.diagnostics_status': async () => {
      if (!lspDiagnostics) {
        return { ok: false, error: 'LSP 未启用' };
      }
      const status = await lspDiagnostics.getStatus();
      return { ok: true, ...status };
    },

    'workspace.git_diff': async (params) => {
      if (!perms.hostControl || !perms.fsRead) {
        const e = new Error('文件读取未授权');
        e.code = 'FS_READ_DISABLED';
        throw e;
      }
      const workspaceRoot = params.workspaceRoot
        ? path.resolve(String(params.workspaceRoot))
        : cwdForCall()
          ? path.resolve(cwdForCall())
          : defaultCwd
            ? path.resolve(defaultCwd)
            : null;
      if (!workspaceRoot) {
        return { ok: false, error: '未设置工作区', text: '' };
      }
      const remoteRoot = currentSshWorkspaceRoot();
      if (!remoteRoot) {
        await assertAllowedPath(workspaceRoot, readRootsForCall());
      }
      const focusFiles = Array.isArray(params.files) ? params.files : [];
      const resolvedFocus = [];
      for (const f of focusFiles) {
        try {
          resolvedFocus.push(remoteRoot ? String(f || '') : normalizeFilePathInput(f, workspaceRoot));
        } catch {
          // skip invalid paths
        }
      }
      return getWorkspaceGitDiffContext(remoteRoot || workspaceRoot, resolvedFocus, {
        maxChars: params.maxChars,
        maxFiles: params.maxFiles,
        remote: !!remoteRoot,
        sshExec: remoteRoot
          ? (command, cwd, timeoutMs) => requireSshForCall().exec(command, cwd, timeoutMs)
          : undefined
      });
    },

    'lsp.settings_get': async () => {
      if (!lspDiagnostics) {
        return {
          ok: true,
          settings: {
            enabled: true,
            timeoutMs: 8000,
            maxFiles: 6,
            maxPerFile: 20,
            minSeverity: 'warning'
          }
        };
      }
      return { ok: true, settings: lspDiagnostics.loadLspSettings() };
    },

    'lsp.settings_set': async (params) => {
      if (!lspDiagnostics) {
        const e = new Error('LSP 未启用');
        e.code = 'LSP_DISABLED';
        throw e;
      }
      const settings = lspDiagnostics.saveLspSettings(params || {});
      return { ok: true, settings };
    },

    'lsp.document_sync': async (params) => {
      if (!lspDiagnostics) {
        return { ok: false, error: 'LSP 未启用', diagnostics: [] };
      }
      const target =
        typeof ctx.getWorkspaceTarget === 'function' ? ctx.getWorkspaceTarget() : null;
      if (target && target.kind === 'ssh') {
        return { ok: true, enabled: false, diagnostics: [], skipped: 'ssh_workspace' };
      }
      if (!perms.hostControl || !perms.fsRead) {
        const e = new Error('文件读取未授权');
        e.code = 'FS_READ_DISABLED';
        throw e;
      }
      const workspaceRoot = params.workspaceRoot
        ? path.resolve(String(params.workspaceRoot))
        : cwdForCall()
          ? path.resolve(cwdForCall())
          : defaultCwd
            ? path.resolve(defaultCwd)
            : null;
      if (!workspaceRoot) {
        return { ok: false, error: '未设置工作区', diagnostics: [] };
      }
      return lspDiagnostics.syncLiveDocument({
        workspaceRoot,
        filePath: params.filePath,
        text: params.text,
        close: params.close === true,
        timeoutMs: params.timeoutMs,
        minSeverity: params.minSeverity,
        maxPerFile: params.maxPerFile,
        assertReadable: async (absPath) => {
          const resolved = normalizeFilePathInput(absPath, cwdForCall() || defaultCwd);
          return assertAllowedPath(resolved, readRootsForCall());
        }
      });
    },

    'lsp.diagnostics_snapshot': async () => {
      if (!lspDiagnostics) {
        return { ok: false, error: 'LSP 未启用', items: [] };
      }
      return { ok: true, items: lspDiagnostics.getLiveDiagnosticsSnapshot() };
    },

    'lsp.diagnostics_report': async (params) => {
      if (!lspDiagnostics || typeof lspDiagnostics.reportDiagnostics !== 'function') {
        return { ok: false, error: 'LSP 未启用' };
      }
      if (!perms.hostControl || !perms.fsRead) {
        const e = new Error('文件读取未授权');
        e.code = 'FS_READ_DISABLED';
        throw e;
      }
      const workspaceRoot = params.workspaceRoot
        ? path.resolve(String(params.workspaceRoot))
        : cwdForCall()
          ? path.resolve(cwdForCall())
          : defaultCwd
            ? path.resolve(defaultCwd)
            : null;
      if (!workspaceRoot) {
        return { ok: false, error: '未设置工作区' };
      }
      const filePath = params.filePath
        ? normalizeFilePathInput(params.filePath, cwdForCall() || defaultCwd)
        : '';
      if (filePath) await assertAllowedPath(filePath, readRootsForCall());
      return lspDiagnostics.reportDiagnostics(workspaceRoot, filePath || params.filePath, params.diagnostics, {
        language: params.language,
        server: params.server,
        source: params.source || 'renderer'
      });
    },

    'workspace.diagnostics_store': async (params) => {
      if (!lspDiagnostics || typeof lspDiagnostics.getWorkspaceStoreSnapshot !== 'function') {
        return { ok: false, error: 'LSP 未启用', items: [] };
      }
      const workspaceRoot = params.workspaceRoot
        ? path.resolve(String(params.workspaceRoot))
        : cwdForCall()
          ? path.resolve(cwdForCall())
          : defaultCwd
            ? path.resolve(defaultCwd)
            : null;
      if (!workspaceRoot) {
        return { ok: false, error: '未设置工作区', items: [] };
      }
      const items = lspDiagnostics.getWorkspaceStoreSnapshot(workspaceRoot);
      const minSeverity = params.minSeverity || 'warning';
      const problems = [];
      for (const row of items) {
        for (const d of row.diagnostics || []) {
          if (minSeverity === 'error' && d.severity !== 'error') continue;
          if (minSeverity === 'warning' && d.severity !== 'error' && d.severity !== 'warning') {
            continue;
          }
          problems.push({
            file: row.file,
            line: d.line,
            col: d.col,
            severity: d.severity,
            message: d.message,
            code: d.code,
            source: d.source || row.source
          });
        }
      }
      problems.sort((a, b) => {
        const ae = a.severity === 'error' ? 0 : 1;
        const be = b.severity === 'error' ? 0 : 1;
        if (ae !== be) return ae - be;
        return String(a.file).localeCompare(String(b.file)) || (a.line || 0) - (b.line || 0);
      });
      const scan =
        typeof lspDiagnostics.getProjectScanStatus === 'function'
          ? lspDiagnostics.getProjectScanStatus(workspaceRoot)
          : null;
      return {
        ok: true,
        workspaceRoot,
        items,
        problems:
          params.maxProblems != null && Number(params.maxProblems) > 0
            ? problems.slice(0, Number(params.maxProblems))
            : problems,
        projectScan: scan
      };
    },

    'workspace.diagnostics_scan': async (params) => {
      if (!lspDiagnostics || typeof lspDiagnostics.runWorkspaceProjectScan !== 'function') {
        return { ok: false, error: 'LSP 未启用' };
      }
      if (!perms.hostControl || !perms.fsRead) {
        const e = new Error('文件读取未授权');
        e.code = 'FS_READ_DISABLED';
        throw e;
      }
      const target =
        typeof ctx.getWorkspaceTarget === 'function' ? ctx.getWorkspaceTarget() : null;
      const isSsh = !!(target && target.kind === 'ssh');
      const workspaceRoot = isSsh
        ? String(params.workspaceRoot || cwdForCall() || defaultCwd || target.remotePath || '')
            .replace(/\\/g, '/')
            .replace(/\/$/, '')
        : params.workspaceRoot
          ? path.resolve(String(params.workspaceRoot))
          : cwdForCall()
            ? path.resolve(cwdForCall())
            : defaultCwd
              ? path.resolve(defaultCwd)
              : null;
      if (!workspaceRoot) {
        return { ok: false, error: '未设置工作区' };
      }
      if (!isSsh) {
        await assertAllowedPath(workspaceRoot, readRootsForCall());
      } else if (!isSshConnectedForCall() || !perms.shellExec) {
        return { ok: false, error: 'SSH shell 不可用' };
      }

      const scanOpts = {
        workspaceRoot,
        force: params.force === true,
        minSeverity: params.minSeverity,
        maxFiles: params.maxFiles,
        maxPerFile: params.maxPerFile,
        timeoutMs: params.timeoutMs
      };
      if (isSsh && isSshConnectedForCall()) {
        scanOpts.sshExec = (command, cwd, timeoutMs) => requireSshForCall().exec(command, cwd, timeoutMs);
      }

      if (params.background === true) {
        void lspDiagnostics.scheduleWorkspaceProjectScan(workspaceRoot, scanOpts).catch(() => {});
        return {
          ok: true,
          started: true,
          projectScan: lspDiagnostics.getProjectScanStatus(workspaceRoot)
        };
      }
      return lspDiagnostics.runWorkspaceProjectScan(scanOpts);
    },
  };
}

module.exports = { createLspWorkspaceHandlers };
