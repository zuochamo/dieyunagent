/* global window, document, gatewayCall, gwState, revealMonacoLine, refreshWorkspaceProblemsPanel */
'use strict';

/** @type {HTMLElement | null} */
let problemsRoot = null;
let currentFilePath = '';
let workspaceProblemsMode = true;
let workspaceScanPollTimer = null;

function severityClass(sev) {
  if (sev === 'error') return 'is-error';
  if (sev === 'warning') return 'is-warning';
  if (sev === 'info') return 'is-info';
  return 'is-hint';
}

function severityLabel(sev) {
  if (sev === 'error') return '错误';
  if (sev === 'warning') return '警告';
  if (sev === 'info') return '信息';
  return '提示';
}

function basename(filePath) {
  const p = String(filePath || '').replace(/\\/g, '/');
  const i = p.lastIndexOf('/');
  return i >= 0 ? p.slice(i + 1) : p;
}

function formatScanMeta(scan, errors, warnings) {
  if (scan && scan.running) return '工作区 · 扫描中…';
  const watchActive = scan && scan.watch && scan.watch.active;
  const last = scan && scan.lastResult ? scan.lastResult : null;
  const engines =
    last && Array.isArray(last.engines) && last.engines.length
      ? last.engines.join('+')
      : last && last.engine
        ? String(last.engine)
        : '';
  const enginePart = engines ? `${engines} · ` : '';
  const watchPart = watchActive ? (scan && scan.watch && scan.watch.mode === 'ssh' ? ' · ssh-poll' : ' · watch') : '';
  return `工作区 · ${enginePart}${errors} 错误 / ${warnings} 警告${watchPart}`;
}

function pathsMatchProblems(a, b) {
  if (!a || !b) return false;
  const na = String(a).replace(/\\/g, '/').toLowerCase();
  const nb = String(b).replace(/\\/g, '/').toLowerCase();
  if (na === nb) return true;
  return na.endsWith('/' + nb) || nb.endsWith('/' + na);
}

function relDisplayPath(filePath, workspaceRoot) {
  const file = String(filePath || '').replace(/\\/g, '/');
  const root = String(workspaceRoot || '')
    .replace(/\\/g, '/')
    .replace(/\/$/, '');
  if (!root) return basename(file);
  const prefix = `${root.toLowerCase()}/`;
  if (file.toLowerCase().startsWith(prefix)) {
    return file.slice(root.length + 1);
  }
  return basename(file);
}

function initProblemsPanel(containerEl) {
  if (!containerEl) return null;
  if (problemsRoot && problemsRoot.parentElement === containerEl) return problemsRoot;

  problemsRoot = document.createElement('div');
  problemsRoot.className = 'artifacts-problems';
  problemsRoot.innerHTML =
    '<div class="artifacts-problems-head">' +
    '<span class="artifacts-problems-title">Problems</span>' +
    '<span class="artifacts-problems-meta"></span>' +
    '<span class="artifacts-problems-count">0</span>' +
    '</div>' +
    '<div class="artifacts-problems-list agent-scroll"></div>';
  containerEl.appendChild(problemsRoot);
  return problemsRoot;
}

function renderProblemsRows(listEl, rows, workspaceRoot) {
  listEl.innerHTML = '';
  for (const d of rows) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = `artifacts-problems-item ${severityClass(d.severity)}`;
    const code = d.code ? ` ${d.code}` : '';
    const loc = workspaceProblemsMode
      ? `${relDisplayPath(d.filePath || d.file, workspaceRoot)}:${d.line || 1}:${d.col || 1}${code}`
      : `${basename(d.filePath || currentFilePath)}:${d.line || 1}:${d.col || 1}${code}`;
    row.title = String(d.message || '');
    row.innerHTML =
      `<span class="artifacts-problems-sev">${severityLabel(d.severity)}</span>` +
      `<span class="artifacts-problems-loc">${loc.replace(/</g, '&lt;')}</span>` +
      `<span class="artifacts-problems-msg">${String(d.message || '').replace(/</g, '&lt;')}</span>`;
    row.addEventListener('click', () => {
      const fp = d.filePath || d.file || currentFilePath;
      if (fp && typeof window.openArtifactFileAtLine === 'function') {
        void window.openArtifactFileAtLine(fp, d.line, d.col);
        return;
      }
      if (typeof revealMonacoLine === 'function') {
        revealMonacoLine(d.line, d.col);
      }
    });
    listEl.appendChild(row);
  }
}

function renderProblemsList(filePath, diagnostics) {
  if (!problemsRoot) return;
  const listEl = problemsRoot.querySelector('.artifacts-problems-list');
  const countEl = problemsRoot.querySelector('.artifacts-problems-count');
  const metaEl = problemsRoot.querySelector('.artifacts-problems-meta');
  if (!listEl || !countEl) return;

  if (workspaceProblemsMode) {
    void refreshWorkspaceProblemsPanel({ filterFilePath: filePath || currentFilePath });
    return;
  }

  const diags = Array.isArray(diagnostics) ? diagnostics : [];
  countEl.textContent = String(diags.length);
  if (metaEl) metaEl.textContent = basename(filePath);
  problemsRoot.classList.toggle('is-empty', diags.length === 0);

  if (!diags.length) {
    listEl.innerHTML = '<div class="artifacts-problems-empty">无诊断</div>';
    return;
  }

  renderProblemsRows(
    listEl,
    diags.map((d) => ({ ...d, filePath: filePath })),
    null
  );
}

async function refreshWorkspaceProblemsPanel(opts = {}) {
  if (!problemsRoot || !gwState.authed) return;
  const listEl = problemsRoot.querySelector('.artifacts-problems-list');
  const countEl = problemsRoot.querySelector('.artifacts-problems-count');
  const metaEl = problemsRoot.querySelector('.artifacts-problems-meta');
  if (!listEl || !countEl) return;

  let workspaceRoot = opts.workspaceRoot || null;
  if (!workspaceRoot && window.diecloud && typeof window.diecloud.getWorkspace === 'function') {
    try {
      const ws = await window.diecloud.getWorkspace();
      workspaceRoot = ws && ws.workspacePath ? ws.workspacePath : null;
    } catch {
      workspaceRoot = null;
    }
  }

  if (!workspaceRoot) {
    countEl.textContent = '0';
    if (metaEl) metaEl.textContent = '';
    listEl.innerHTML = '<div class="artifacts-problems-empty">未绑定工作区</div>';
    return;
  }

  try {
    const data = await gatewayCall('workspace.diagnostics_store', {
      workspaceRoot,
      minSeverity: 'warning'
    });
    const problemsAll = Array.isArray(data.problems) ? data.problems : [];
    const filterPath = opts.filterFilePath || currentFilePath;
    const problems = filterPath
      ? problemsAll.filter((p) => pathsMatchProblems(p.file, filterPath))
      : problemsAll;
    const errors = problems.filter((p) => p.severity === 'error').length;
    const warnings = problems.filter((p) => p.severity === 'warning').length;
    countEl.textContent = String(problems.length);
    if (metaEl) {
      metaEl.textContent = filterPath
        ? `${formatScanMeta(data.projectScan, errors, warnings)} · ${basename(filterPath)}`
        : formatScanMeta(data.projectScan, errors, warnings);
    }
    problemsRoot.classList.toggle('is-empty', problems.length === 0);
    if (!problems.length) {
      listEl.innerHTML = filterPath
        ? '<div class="artifacts-problems-empty">当前文件无诊断</div>'
        : '<div class="artifacts-problems-empty">无诊断</div>';
      return;
    }
    renderProblemsRows(
      listEl,
      problems.map((p) => ({ ...p, filePath: p.file })),
      workspaceRoot
    );

    if (data.projectScan && data.projectScan.running) {
      scheduleWorkspaceProblemsPoll(workspaceRoot);
    } else if (data.projectScan && data.projectScan.watch && data.projectScan.watch.refreshing > 0) {
      scheduleWorkspaceProblemsPoll(workspaceRoot);
    } else {
      stopWorkspaceProblemsPoll();
    }
  } catch (e) {
    if (metaEl) metaEl.textContent = '加载失败';
    listEl.innerHTML = `<div class="artifacts-problems-empty">${String(e.message || e)}</div>`;
  }
}

function scheduleWorkspaceProblemsPoll(workspaceRoot) {
  stopWorkspaceProblemsPoll();
  workspaceScanPollTimer = setTimeout(() => {
    void refreshWorkspaceProblemsPanel({ workspaceRoot });
  }, 2500);
}

function stopWorkspaceProblemsPoll() {
  if (workspaceScanPollTimer) {
    clearTimeout(workspaceScanPollTimer);
    workspaceScanPollTimer = null;
  }
}

function updateProblemsPanel(filePath, diagnostics) {
  currentFilePath = String(filePath || '');
  if (!problemsRoot) return;
  if (Array.isArray(diagnostics)) {
    workspaceProblemsMode = false;
    renderProblemsList(currentFilePath, diagnostics);
    return;
  }
  workspaceProblemsMode = true;
  renderProblemsList(currentFilePath, diagnostics);
}

async function startWorkspaceDiagnosticsScan(workspaceRoot, opts = {}) {
  if (!gwState.authed || !workspaceRoot) return null;
  try {
    return await gatewayCall('workspace.diagnostics_scan', {
      workspaceRoot,
      background: opts.background !== false,
      force: opts.force === true
    });
  } catch {
    return null;
  }
}

window.initProblemsPanel = initProblemsPanel;
window.updateProblemsPanel = updateProblemsPanel;
window.refreshWorkspaceProblemsPanel = refreshWorkspaceProblemsPanel;
window.startWorkspaceDiagnosticsScan = startWorkspaceDiagnosticsScan;
