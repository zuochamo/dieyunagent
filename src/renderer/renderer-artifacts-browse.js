/* global gatewayCall, gwState, isSidePanelOpen, openSidePanel, setSidePanelTab, getSidePanelTab, flatFolderIconSvg, flatFileIconSvg, flatDirUpIconSvg, revealMonacoLine, refreshWorkspaceProblemsPanel, startWorkspaceDiagnosticsScan, normWritePath, pathsMatch, disposeMonacoArtifactEditor, createMonacoArtifactEditor, canUseMonacoEditor, getAgentLimits, pickDiffDisplayText, getLastTraceEntryFileChanges, updateProblemsPanel, renderChangesPane, lastAgentDisplayedTrace, computeLineDiffStats, toolDiffHasBody, formatInlineUnifiedDiffHtml, escapeHtml, isEditToolName, editToolFilePath, canonicalArtifactPathFromTool, resolveToolDiffBody, resolveArtifactDiffFromTrace, mammoth, XLSX, withSessionRpcScope, isMonacoArtifactEditorMounted, currentSessionId, resolveSessionWorkspacePathSync, resolveSessionWorkspacePathForRpc, readFallbackArtifactText, artifactRpcParams */
'use strict';

function normalizeRelPath(p) {
  return String(p || '')
    .replace(/\\/g, '/')
    .replace(/^\/+|\/+$/g, '');
}

function joinRelPath(base, name) {
  const b = normalizeRelPath(base);
  const n = String(name || '').replace(/^\/+/, '');
  return b ? `${b}/${n}` : n;
}

function parentRelPath(rel) {
  const p = normalizeRelPath(rel);
  if (!p) return '';
  const idx = p.lastIndexOf('/');
  return idx < 0 ? '' : p.slice(0, idx);
}

function toRelativePath(absPath, root) {
  if (!absPath) return '';
  const a = String(absPath).replace(/\\/g, '/');
  if (!root) return a.split('/').pop() || a;
  const r = String(root).replace(/\\/g, '/').replace(/\/+$/, '');
  const prefix = `${r}/`;
  if (a.toLowerCase() === r.toLowerCase()) return '';
  if (a.toLowerCase().startsWith(prefix.toLowerCase())) {
    return a.slice(prefix.length);
  }
  return a.split('/').pop() || a;
}

function resolveBrowseDirAbs(root, rel, kind) {
  if (!root) return null;
  if (kind === 'ssh') return joinPosixPath(root, rel);
  const r = normalizeRelPath(rel);
  return r ? joinArtifactPath(root, r) : root;
}

function isSshWorkspacePath(p) {
  return /^ssh:/i.test(String(p || ''));
}

function isRemoteWorkspacePath(p) {
  return isSshWorkspacePath(p);
}

function extractRemotePathFromSshUri(uri) {
  const s = String(uri || '');
  const m = s.match(/^ssh:(?:\/\/)?[^@/]+@[^/:]+(?::\d+)?(\/.*)?$/i);
  if (!m) return '';
  const raw = m[1] || '/';
  return raw.replace(/\\/g, '/').replace(/\/+$/, '') || '/';
}

function normalizePosixRoot(p) {
  const s = String(p || '/').replace(/\\/g, '/');
  if (!s || s === '/') return '/';
  const withSlash = s.startsWith('/') ? s : `/${s}`;
  return withSlash.replace(/\/+$/, '') || '/';
}

function joinPosixPath(base, rel) {
  const root = normalizePosixRoot(base);
  const r = normalizeRelPath(rel);
  if (!r) return root;
  return root === '/' ? `/${r}` : `${root}/${r}`;
}

function isUnderPosixRoot(root, candidate) {
  const r = normalizePosixRoot(root);
  const c = normalizePosixRoot(String(candidate || '').replace(/\\/g, '/'));
  return c === r || c.startsWith(`${r}/`);
}

function remoteWorkspaceCtxFromArtifacts() {
  if (!artifactsWorkspaceRoot) return null;
  if (artifactsWorkspaceKind !== 'ssh') return null;
  return { kind: artifactsWorkspaceKind, root: artifactsWorkspaceRoot };
}

/**
 * 把外部输入的路径解析成「当前工作区内的确定路径」—— 路径进入系统的**唯一映射点**。
 *
 * 只做确定性解析，四种情况：
 *   1. ssh: URI         → 提取远程路径，必须落在工作区根下；
 *   2. 远程绝对路径      → 必须落在工作区根下；
 *   3. 相对路径          → 拼到工作区根下（确定映射）；
 *   4. 其它（本地盘符）  → **明确失败**。
 *
 * 刻意删掉了旧实现里的三段猜测（按当前目录同名文件认领 / 按工作区根尾段正则匹配 /
 * 按有扩展名就丢到根下）。它们看似「能多打开一些文件」，实际代价是：
 *   - 打开**另一个文件**（同名目录 / 同名文件随处可见），且面板标题显示的是猜出来的路径，
 *     用户无法察觉；
 *   - 那个路径会被交给编辑器的保存按钮 → **保存即覆盖错误的远程文件**，不可逆；
 *   - 猜测结果还会进入 artifactPathsMatch，污染产物去重与变更匹配。
 * 所以这里坚持「宁可打不开并说明原因，也不猜」。
 *
 * @returns {{ ok: true, path: string } | { ok: false, path: string, reason: string, input: string }}
 */
function resolveArtifactPathInWorkspace(filePath, wsCtx) {
  const fp = String(filePath || '').trim();
  const ctx = wsCtx || remoteWorkspaceCtxFromArtifacts();
  const fail = (reason) => ({
    ok: false,
    path: fp,
    reason,
    input: fp
  });
  if (!fp) return fail('路径为空');
  // 非远程工作区：路径就是真实路径，原样通过
  if (!ctx || ctx.kind !== 'ssh') return { ok: true, path: fp };

  const root = normalizePosixRoot(ctx.root);

  if (isRemoteWorkspacePath(fp)) {
    const norm = normalizePosixRoot(extractRemotePathFromSshUri(fp) || '/');
    if (isUnderPosixRoot(root, norm)) return { ok: true, path: norm };
    return fail(`该远程路径不在当前工作区内（${root}）`);
  }

  const posix = fp.replace(/\\/g, '/');
  if (posix.startsWith('/')) {
    if (isUnderPosixRoot(root, posix)) return { ok: true, path: normalizePosixRoot(posix) };
    return fail(`该路径不在当前远程工作区内（${root}）`);
  }
  if (/^[a-zA-Z]:\//.test(posix)) {
    return fail('这是本地路径，而当前工作区在远程主机上：请从左侧文件列表中选择对应文件');
  }
  // 相对路径：确定映射到工作区根下
  return { ok: true, path: joinPosixPath(root, posix) };
}

/**
 * 兼容包装：解析成功返回映射结果，失败原样返回（由读取侧明确拒绝）。
 * 需要区分「成功 / 失败」并给用户可读提示的调用点，请直接用 resolveArtifactPathInWorkspace。
 */
function applyWorkspaceArtifactPath(filePath, wsCtx) {
  const resolved = resolveArtifactPathInWorkspace(filePath, wsCtx);
  if (resolved.ok) return resolved.path;
  return String(filePath || '').trim();
}

/**
 * 权威解析：本地确定性映射失败后，问 Gateway「这个路径在远程可能对应谁」。
 *
 * Gateway 持有真实文件系统，它能 stat 原路径、也能用远程 rg 按尾部特征找候选；
 * Renderer 只有一份文件列表**副本**，用它推断映射就是猜。判断权归持有文件系统的那一层。
 *
 * 只在**用户主动打开**时调用：后台流式刷新也走这条路会变成远程 rg 风暴。
 *
 * @param {string} inputPath 来路不明的路径（本地盘符 / 别的机器 / 相对路径）
 * @returns {Promise<{ok: boolean, exact?: boolean, path?: string, candidates?: object[], reason?: string, code?: string}>}
 */
async function resolveArtifactPathViaGateway(inputPath) {
  const fp = String(inputPath || '').trim();
  if (!fp) return { ok: false, code: 'INVALID_PATH', reason: '路径为空' };
  if (typeof gatewayCall !== 'function' || !gwState || !gwState.authed) {
    return { ok: false, code: 'GATEWAY_UNAVAILABLE', reason: 'Gateway 未连接' };
  }
  try {
    const params =
      typeof artifactRpcParams === 'function'
        ? await artifactRpcParams({ inputPath: fp })
        : { inputPath: fp };
    const r = await gatewayCall('workspace.resolve_path', params);
    if (r && typeof r === 'object') return r;
    return { ok: false, code: 'BAD_RESPONSE', reason: '解析服务返回异常' };
  } catch (err) {
    return { ok: false, code: 'RPC_FAILED', reason: String((err && err.message) || err) };
  }
}

async function probeRemoteConnectedFlags() {
  const out = { sshConnected: false };
  if (!artifactsApi.getWorkspace) return out;
  try {
    const ws = await artifactsApi.getWorkspace();
    if (ws) {
      out.sshConnected = !!ws.sshConnected;
    }
  } catch {
    // ignore
  }
  return out;
}

/** 由工作区路径构造文件区上下文（不依赖 Main 当前 activeSession） */
async function buildWorkspaceContextFromPath(workspacePath) {
  const viewPath = String(workspacePath || '').trim();
  if (!viewPath) return null;
  if (/^ssh:/i.test(viewPath) || isSshWorkspacePath(viewPath)) {
    const flags = await probeRemoteConnectedFlags();
    const remoteRoot = extractRemotePathFromSshUri(viewPath) || '/';
    return {
      kind: 'ssh',
      root: normalizePosixRoot(remoteRoot),
      workspacePath: viewPath,
      sshConnected: flags.sshConnected
    };
  }
  return {
    kind: 'local',
    root: viewPath,
    workspacePath: viewPath,
    sshConnected: false
  };
}

/**
 * 文件区工作区解析：优先当前视图会话路径，避免切历史时 Main getWorkspace 仍指向旧会话。
 */
async function getWorkspaceContext(opts = {}) {
  try {
    const explicit =
      (opts && (opts.expectedRoot || opts.workspacePath)) ||
      null;
    if (explicit) {
      return await buildWorkspaceContextFromPath(explicit);
    }

    const viewPath =
      typeof window !== 'undefined' && window.activeViewSessionWorkspacePath
        ? window.activeViewSessionWorkspacePath
        : null;
    if (viewPath) {
      return await buildWorkspaceContextFromPath(viewPath);
    }

    if (
      typeof resolveSessionWorkspacePathSync === 'function' &&
      typeof currentSessionId !== 'undefined' &&
      currentSessionId
    ) {
      const syncPath = resolveSessionWorkspacePathSync(currentSessionId);
      if (syncPath) return await buildWorkspaceContextFromPath(syncPath);
    }

    if (artifactsApi.getWorkspace) {
      const ws = await artifactsApi.getWorkspace();
      if (ws && ws.workspacePath) {
        return await buildWorkspaceContextFromPath(ws.workspacePath);
      }
    }
    return null;
  } catch {
    return null;
  }
}

function isDirectChild(relPath, dirRel) {
  const rel = normalizeRelPath(relPath);
  const dir = normalizeRelPath(dirRel);
  if (!rel) return false;
  if (!dir) return !rel.includes('/');
  if (!rel.startsWith(`${dir}/`)) return false;
  const rest = rel.slice(dir.length + 1);
  return rest.length > 0 && !rest.includes('/');
}

function artifactRelPath(art) {
  if (!art) return '';
  if (art.relativePath) return normalizeRelPath(art.relativePath);
  return toRelativePath(art.path, artifactsWorkspaceRoot);
}

function getSessionArtsInDir(dirRel) {
  const map = new Map();
  for (const art of sessionArtifacts) {
    if (!art || !art.path) continue;
    const rel = artifactRelPath(art);
    if (!isDirectChild(rel, dirRel)) continue;
    map.set(art.path, { ...art, relativePath: rel, source: 'trace' });
  }
  return map;
}

function normalizeListDirResult(raw) {
  if (Array.isArray(raw)) return raw;
  if (raw && Array.isArray(raw.entries)) return raw.entries;
  return [];
}

async function getWorkspaceRootPath() {
  const ctx = await getWorkspaceContext();
  return ctx ? ctx.workspacePath : null;
}

async function refreshArtifactsDirectory(force, opts = {}) {
  if (!gwState.authed) return false;
  const myGen = ++artifactsDirRefreshGen;
  const expectedRoot = opts.expectedRoot || opts.workspacePath || null;
  const sessionId = opts.sessionId || undefined;

  artifactsDirLoading = true;
  workspaceArtifactsLoading = true;

  const run = (async () => {
    try {
      const wsCtx = await getWorkspaceContext({
        expectedRoot,
        workspacePath: expectedRoot
      });
      if (myGen !== artifactsDirRefreshGen) return false;

      const wsPath = wsCtx ? wsCtx.workspacePath : null;
      const source = expectedArtifactsSourceKey(wsPath, artifactsBrowseRel);
      if (!force && workspaceArtifactsLoaded && workspaceArtifactsSource === source) {
        return true;
      }

      workspaceArtifactsSource = source;
      workspaceArtifactsError = '';
      artifactsWorkspaceRoot = wsCtx ? wsCtx.root : null;
      artifactsWorkspaceKind = wsCtx ? wsCtx.kind : 'local';

      if (!wsCtx) {
        setArtifactsDirEntries([]);
        workspaceArtifacts = [];
        workspaceArtifactsLoaded = true;
        return true;
      }
      if (wsCtx.kind === 'ssh' && !wsCtx.sshConnected) {
        setArtifactsDirEntries([]);
        workspaceArtifacts = [];
        workspaceArtifactsLoaded = true;
        workspaceArtifactsError = 'SSH 未连接，请在工作空间菜单中重新连接远程主机';
        return true;
      }

      const dirAbs = resolveBrowseDirAbs(wsCtx.root, artifactsBrowseRel, wsCtx.kind);
      const listParams = await artifactRpcParams({ dirPath: dirAbs }, sessionId);
      if (myGen !== artifactsDirRefreshGen) return false;
      if (!listParams.runWorkspaceRoot && wsPath) {
        listParams.runWorkspaceRoot = wsPath;
      }
      const entries = normalizeListDirResult(await gatewayCall('fs.list_dir', listParams));
      if (myGen !== artifactsDirRefreshGen) return false;

      const sessionInDir = getSessionArtsInDir(artifactsBrowseRel);
      const rows = [];
      const seenPaths = new Set();

      for (const ent of entries || []) {
        if (!ent || !ent.name || ent.name.startsWith('~$')) continue;
        if (ent.isDirectory && ARTIFACT_SKIP_DIRS.has(ent.name)) continue;
        const rel = joinRelPath(artifactsBrowseRel, ent.name);
        const full =
          wsCtx.kind === 'ssh'
            ? joinPosixPath(wsCtx.root, rel)
            : joinArtifactPath(wsCtx.root, rel);
        seenPaths.add(full);
        if (ent.isDirectory) {
          rows.push({
            kind: 'dir',
            name: ent.name,
            path: full,
            relativePath: rel,
            ts: Number(ent.mtimeMs) || 0,
            diff: null,
            source: 'workspace'
          });
          continue;
        }
        const traced = sessionInDir.get(full);
        rows.push({
          kind: 'file',
          name: ent.name,
          path: full,
          relativePath: rel,
          size: Number(ent.size) || 0,
          ts: Number(ent.mtimeMs) || 0,
          diff: traced && traced.diff ? traced.diff : null,
          source: traced ? 'trace' : 'workspace',
          remote: !!ent.remote
        });
        if (traced) sessionInDir.delete(full);
      }

      for (const art of sessionInDir.values()) {
        const roundChange = findLastRoundChange(art.path);
        if (!shouldShowVirtualArtifactRow(art.path, { pending: roundChange && roundChange.pending })) {
          continue;
        }
        const name = art.relativePath.split('/').pop() || art.path;
        rows.push({
          kind: 'file',
          name,
          path: art.path,
          relativePath: art.relativePath,
          ts: Number(art.ts) || 0,
          diff: art.diff || null,
          source: 'trace',
          virtual: true,
          pending: !!(roundChange && roundChange.pending)
        });
      }

      rows.sort(function (a, b) {
        if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1;
        return String(a.name || '').localeCompare(String(b.name || ''), undefined, {
          sensitivity: 'base'
        });
      });

      if (myGen !== artifactsDirRefreshGen) return false;
      setArtifactsDirEntries(rows);
      workspaceArtifacts = rows
        .filter(function (r) {
          return r.kind === 'file';
        })
        .map(function (r) {
          return {
            path: r.path,
            relativePath: r.relativePath,
            size: r.size || 0,
            ts: r.ts || 0,
            diff: r.diff,
            source: r.source,
            remote: !!r.remote
          };
        });
      workspaceArtifactsLoaded = true;
      return true;
    } catch (e) {
      if (myGen !== artifactsDirRefreshGen) return false;
      setArtifactsDirEntries([]);
      workspaceArtifacts = [];
      workspaceArtifactsLoaded = true;
      workspaceArtifactsError = e && e.message ? e.message : String(e || '加载失败');
      return false;
    } finally {
      if (myGen === artifactsDirRefreshGen) {
        artifactsDirLoading = false;
        workspaceArtifactsLoading = false;
      }
    }
  })();

  artifactsDirRefreshPromise = run;
  try {
    return await run;
  } finally {
    if (artifactsDirRefreshPromise === run) artifactsDirRefreshPromise = null;
  }
}

function getContextFilePathsForAgent(sessionId) {
  const out = [];
  const seen = new Set();
  function add(p) {
    const key = String(p || '').trim();
    if (!key || seen.has(key)) return;
    seen.add(key);
    out.push(key);
  }
  const sid =
    sessionId != null && String(sessionId).trim()
      ? String(sessionId).trim()
      : resolveArtifactSessionId();
  const visible = !sid || isVisibleArtifactSession(sid);
  if (visible) {
    if (selectedArtifactPath) add(selectedArtifactPath);
    for (let i = sessionArtifacts.length - 1; i >= 0; i--) {
      add(sessionArtifacts[i] && sessionArtifacts[i].path);
    }
    for (let i = workspaceArtifacts.length - 1; i >= 0 && out.length < 20; i--) {
      add(workspaceArtifacts[i] && workspaceArtifacts[i].path);
    }
    return out.slice(0, 12);
  }
  const bucket = getArtifactBucket(sid, false);
  if (bucket) {
    if (bucket.selectedArtifactPath) add(bucket.selectedArtifactPath);
    for (let i = (bucket.sessionArtifacts || []).length - 1; i >= 0; i--) {
      add(bucket.sessionArtifacts[i] && bucket.sessionArtifacts[i].path);
    }
  }
  return out.slice(0, 12);
}

/**
 * 产物行合并：同一文件的不同写法（相对 / 绝对 / 大小写 / 反斜杠）并成一行。
 *
 * 匹配规则就是 `pathsMatch` 的三条（见 renderer-path-utils.js）：归一化后相等、
 * 或一方是另一方「/ 边界后缀」。原来每来一行都对着整张表逐对重算归一化（O(n²) 次
 * 字符串处理）；这里按「相等 / 更短后缀 / 更长后缀」三种情形各建一份索引，逐对扫描
 * 变成按路径段数查表。命中仍取**最先插入**的那一条，与顺序扫描的语义一致；
 * `pathsMatch` 不可用时退回原来的顺序扫描（行为不变）。
 */
function mergeArtifactRows() {
  const map = new Map();
  /** 归一化路径 -> 该路径首次插入的行键与插入序号 */
  const byNorm = new Map();
  /** 某个后缀 -> 以它为 / 边界后缀的已有行里插入最早的那条 */
  const bySuffix = new Map();
  const canIndex = typeof pathsMatch === 'function' && typeof normWritePath === 'function';
  let seq = 0;

  function normOf(p) {
    const n = normWritePath(applyWorkspaceArtifactPath(p));
    return n == null ? '' : String(n);
  }

  /** 'a/b/c' -> ['b/c', 'c']（不含自身） */
  function properSuffixes(n) {
    const out = [];
    let i = n.indexOf('/');
    while (i !== -1) {
      out.push(n.slice(i + 1));
      i = n.indexOf('/', i + 1);
    }
    return out;
  }

  function remember(key, norm) {
    const entry = { key, seq: seq++ };
    if (!byNorm.has(norm)) byNorm.set(norm, entry);
    for (const suffix of properSuffixes(norm)) {
      const prev = bySuffix.get(suffix);
      if (!prev || entry.seq < prev.seq) bySuffix.set(suffix, entry);
    }
  }

  /** 第一个匹配到的已有行键（与顺序扫描同语义），没有则返回 null */
  function findKey(path) {
    if (!canIndex) {
      for (const key of map.keys()) {
        if (artifactPathsMatch(key, path)) return key;
      }
      return null;
    }
    const np = normOf(path);
    // 归一化后为空不参与匹配（pathsMatch 对空串一律返回 false）
    if (!np) return null;
    let best = byNorm.get(np) || null;
    for (const suffix of properSuffixes(np)) {
      const hit = byNorm.get(suffix);
      if (hit && (!best || hit.seq < best.seq)) best = hit;
    }
    const longer = bySuffix.get(np);
    if (longer && (!best || longer.seq < best.seq)) best = longer;
    return best ? best.key : null;
  }

  function upsert(art, source) {
    if (!art || !art.path) return;
    const path = applyWorkspaceArtifactPath(art.path);
    const next = { ...art, path, source };
    const key = findKey(path);
    if (key != null) {
      const existing = map.get(key);
      if (existing && Number(next.ts || 0) >= Number(existing.ts || 0)) map.set(key, next);
      return;
    }
    map.set(path, next);
    if (canIndex) remember(path, normOf(path));
  }
  for (const art of sessionArtifacts) upsert(art, 'trace');
  for (const art of workspaceArtifacts) upsert(art, 'workspace');
  return Array.from(map.values()).sort(function (a, b) {
    return Number(b.ts || 0) - Number(a.ts || 0);
  });
}

function getSessionChangeRowsForAgent(sessionId) {
  const sid =
    sessionId != null && String(sessionId).trim()
      ? String(sessionId).trim()
      : resolveArtifactSessionId();
  if (!sid) return [];
  if (isVisibleArtifactSession(sid)) {
    return mergeArtifactRows().filter((r) => r && r.path);
  }
  const bucket = getArtifactBucket(sid, false);
  const rows = bucket ? bucket.sessionArtifacts : [];
  return rows.filter((r) => r && r.path).map((r) => ({ ...r, source: 'trace' }));
}

function isMissingRpcHandlerError(err) {
  const msg = String((err && err.message) || err || '');
  return /No handler|handler registered|未知 RPC|unknown/i.test(msg);
}

function joinArtifactPath(base, name) {
  const b = String(base || '').replace(/[\\/]+$/, '');
  const n = String(name || '').replace(/^[\\/]+/, '');
  const sep = b.includes('\\') ? '\\' : '/';
  return b ? `${b}${sep}${n}` : n;
}

async function refreshWorkspaceArtifacts(force) {
  return refreshArtifactsDirectory(force);
}

window.applyWorkspaceArtifactPath = applyWorkspaceArtifactPath;
window.resolveArtifactPathInWorkspace = resolveArtifactPathInWorkspace;
window.resolveArtifactPathViaGateway = resolveArtifactPathViaGateway;