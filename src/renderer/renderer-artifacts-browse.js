/* global gatewayCall, gwState, isSidePanelOpen, openSidePanel, setSidePanelTab, getSidePanelTab, flatFolderIconSvg, flatFileIconSvg, flatDirUpIconSvg, revealMonacoLine, refreshWorkspaceProblemsPanel, startWorkspaceDiagnosticsScan, getActiveLiveWrite, isLiveWritePath, normWritePath, pathsMatch, syncLiveWriteFromTrace, clearLiveWrite, applyLiveWriteFileListMarks, refreshLiveWriteArtifactPreview, createMonacoArtifactDiffEditor, updateMonacoArtifactDiffEditor, disposeMonacoArtifactEditor, createMonacoArtifactEditor, canUseMonacoEditor, getAgentLimits, pickDiffDisplayText, getLastTraceEntryFileChanges, enrichLiveWriteDiffStats, updateProblemsPanel, renderChangesPane, lastAgentDisplayedTrace, computeLineDiffStats, toolDiffHasBody, formatInlineUnifiedDiffHtml, escapeHtml, isEditToolName, editToolFilePath, canonicalArtifactPathFromTool, resolveToolDiffBody, resolveArtifactDiffFromTrace, mammoth, XLSX, withSessionRpcScope, isMonacoAfterOnlyEditorMounted, isMonacoMountInFlight, isMonacoArtifactEditorMounted, updateMonacoArtifactEditorText, currentSessionId, resolveSessionWorkspacePathSync, resolveSessionWorkspacePathForRpc, readFallbackArtifactText */
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

/** SSH：把 Agent/本地格式路径规范到远程工作区根下，避免「路径不在远程工作空间内」 */
function canonicalizeArtifactPathForWorkspace(filePath, wsCtx) {
  const fp = String(filePath || '').trim();
  if (!fp || !wsCtx) return fp;
  if (wsCtx.kind !== 'ssh') return fp;
  const root = normalizePosixRoot(wsCtx.root);

  if (isRemoteWorkspacePath(fp)) {
    const extracted = extractRemotePathFromSshUri(fp);
    const norm = normalizePosixRoot(extracted || '/');
    if (isUnderPosixRoot(root, norm)) return norm;
  }

  const posix = fp.replace(/\\/g, '/');
  if (posix.startsWith('/') && isUnderPosixRoot(root, posix)) {
    return normalizePosixRoot(posix);
  }

  if (!posix.startsWith('/') && !/^[a-zA-Z]:\//.test(posix)) {
    return joinPosixPath(root, posix);
  }

  for (const row of artifactsDirEntries || []) {
    if (row.kind !== 'file' || !row.path) continue;
    if (typeof pathsMatch === 'function' && pathsMatch(row.path, fp)) return row.path;
    if (row.name && (posix.endsWith('/' + row.name) || posix.endsWith('\\' + row.name))) {
      return row.path;
    }
  }

  const rootParts = root.split('/').filter(Boolean);
  for (let n = Math.min(3, rootParts.length); n >= 1; n--) {
    const tail = rootParts.slice(-n).join('/');
    const escaped = tail.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`(?:^|[/:])${escaped}/(.+)$`, 'i');
    const m = posix.match(re);
    if (m && m[1]) return joinPosixPath(root, m[1]);
  }

  const base = posix.split('/').pop();
  if (base && /\.[a-zA-Z0-9]{1,16}$/.test(base)) {
    return joinPosixPath(root, base);
  }

  return posix.startsWith('/') ? normalizePosixRoot(posix) : joinPosixPath(root, posix);
}

function remoteWorkspaceCtxFromArtifacts() {
  if (!artifactsWorkspaceRoot) return null;
  if (artifactsWorkspaceKind !== 'ssh') return null;
  return { kind: artifactsWorkspaceKind, root: artifactsWorkspaceRoot };
}

function applyWorkspaceArtifactPath(filePath, wsCtx) {
  const ctx = wsCtx || remoteWorkspaceCtxFromArtifacts();
  if (!ctx) return String(filePath || '').trim();
  return canonicalizeArtifactPathForWorkspace(filePath, ctx);
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
        artifactsDirEntries = [];
        workspaceArtifacts = [];
        workspaceArtifactsLoaded = true;
        return true;
      }
      if (wsCtx.kind === 'ssh' && !wsCtx.sshConnected) {
        artifactsDirEntries = [];
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
      artifactsDirEntries = rows;
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
      artifactsDirEntries = [];
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

function mergeArtifactRows() {
  const map = new Map();
  function upsert(art, source) {
    if (!art || !art.path) return;
    const path = applyWorkspaceArtifactPath(art.path);
    const next = { ...art, path, source };
    for (const [key, existing] of map) {
      if (artifactPathsMatch(key, path)) {
        if (Number(next.ts || 0) >= Number(existing.ts || 0)) map.set(key, next);
        return;
      }
    }
    map.set(path, next);
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
window.canonicalizeArtifactPathForWorkspace = canonicalizeArtifactPathForWorkspace;