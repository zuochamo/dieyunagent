/* global $, closeAllMenus */
'use strict';

const updateApi = window.diecloud || {};

const UPDATE_BAR_WIDTH = 14;
let titlebarUpdateInstallBound = false;

function formatUpdateBytes(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return '';
  if (v < 1024) return `${v} B`;
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`;
  return `${(v / (1024 * 1024)).toFixed(1)} MB`;
}

function formatUpdateProgressBar(percent, width = UPDATE_BAR_WIDTH) {
  const p = Math.max(0, Math.min(100, Math.round(Number(percent) || 0)));
  const filled = Math.round((p / 100) * width);
  return `${'█'.repeat(filled)}${'▒'.repeat(Math.max(0, width - filled))} ${p}%`;
}

async function installReadyUpdateFromTitlebar() {
  if (!updateApi.installUpdate) return;
  try {
    await updateApi.installUpdate();
  } catch {
    // ignore; main process will report update state if launch fails
  }
}

function bindTitlebarUpdateInstall() {
  if (titlebarUpdateInstallBound) return;
  const wrap = $('titlebar-update-progress-wrap');
  if (!wrap) return;
  titlebarUpdateInstallBound = true;
  wrap.addEventListener('click', () => {
    if (wrap.dataset.phase === 'ready') installReadyUpdateFromTitlebar();
  });
  wrap.addEventListener('keydown', (event) => {
    if (wrap.dataset.phase !== 'ready') return;
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    installReadyUpdateFromTitlebar();
  });
}

function setTitlebarUpdateProgress(state) {
  const wrap = $('titlebar-update-progress-wrap');
  const el = $('titlebar-update-progress');
  if (!wrap || !el) return;

  const phase = state && state.phase ? state.phase : 'idle';
  const showTitlebar = phase === 'downloading' || phase === 'installing' || phase === 'ready';

  if (!showTitlebar) {
    wrap.hidden = true;
    wrap.dataset.indeterminate = 'false';
    wrap.dataset.phase = 'idle';
    wrap.removeAttribute('role');
    wrap.removeAttribute('tabindex');
    el.textContent = '';
    el.title = '';
    return;
  }

  wrap.hidden = false;
  wrap.dataset.phase = phase;

  if (phase === 'ready') {
    const title = state.version ? `新版本 v${state.version} 已下载，点击安装` : '更新已下载，点击安装';
    wrap.dataset.indeterminate = 'false';
    wrap.setAttribute('role', 'button');
    wrap.setAttribute('tabindex', '0');
    el.textContent = 'update';
    el.title = title;
    return;
  }

  wrap.removeAttribute('role');
  wrap.removeAttribute('tabindex');
  const indeterminate = phase === 'installing' && !Number.isFinite(state.percent);
  wrap.dataset.indeterminate = indeterminate ? 'true' : 'false';

  let bar = '';
  if (indeterminate) {
    bar = `${'▒'.repeat(UPDATE_BAR_WIDTH)} …`;
  } else {
    bar = formatUpdateProgressBar(state.percent);
  }

  let suffix = '';
  if (phase === 'downloading' && state.transferred && state.total) {
    suffix = ` · ${formatUpdateBytes(state.transferred)} / ${formatUpdateBytes(state.total)}`;
  } else if (phase === 'installing' && state.message) {
    suffix = ` · ${state.message}`;
  } else if (state.version && phase === 'downloading') {
    suffix = ` · v${state.version}`;
  }

  const line = `update: ${bar}${suffix}`;
  el.textContent = line;
  el.title = line;
}
function applyAppUpdateState(state) {
  if (!state) return;
  setTitlebarUpdateProgress(state);
}

function initUpdateUI() {
  bindTitlebarUpdateInstall();
  if (updateApi.onAppUpdateState) {
    updateApi.onAppUpdateState(applyAppUpdateState);
  }
  if (updateApi.getUpdateState) {
    updateApi
      .getUpdateState()
      .then((st) => {
        if (!st) return;
        if (st.pending || st.phase === 'ready') {
          applyAppUpdateState({
            phase: 'ready',
            version: st.version,
            currentVersion: st.currentVersion,
            message: st.version ? `新版本 v${st.version} 已下载，可安装并重启` : '更新包已下载，可安装并重启',
            percent: 100
          });
          return;
        }
        if (st.phase && st.phase !== 'idle') {
          applyAppUpdateState(st);
        }
      })
      .catch(() => {});
  }
  const menuCheckUpdate = $('menu-check-update');
  if (menuCheckUpdate) {
    menuCheckUpdate.addEventListener('click', async () => {
      closeAllMenus();
      if (updateApi.checkForUpdates) {
        await updateApi.checkForUpdates();
      }
    });
  }
}
