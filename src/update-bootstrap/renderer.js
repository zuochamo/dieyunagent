const overlay = document.getElementById('update-overlay');
const titleEl = document.getElementById('update-title');
const verEl = document.getElementById('update-version');
const msgEl = document.getElementById('update-message');
const barEl = document.getElementById('update-progress-bar');
const labelEl = document.getElementById('update-progress-label');
const hintEl = document.getElementById('update-hint');

function applyState(state) {
  if (!state) return;
  const phase = state.phase || 'installing';
  if (overlay) overlay.dataset.phase = phase;

  const titles = {
    installing: '正在安装更新',
    done: '安装完成',
    error: '安装失败'
  };
  if (titleEl) titleEl.textContent = titles[phase] || '正在安装更新';

  const fromV = state.fromVersion || '';
  const toV = state.version || '';
  if (verEl) {
    if (fromV && toV) verEl.textContent = `v${fromV} → v${toV}`;
    else if (toV) verEl.textContent = `新版本 v${toV}`;
    else verEl.textContent = '';
  }

  if (msgEl) msgEl.textContent = state.message || '';
  const pct = Number.isFinite(state.percent) ? Math.max(0, Math.min(100, state.percent)) : 0;
  if (barEl) barEl.style.width = `${pct}%`;
  if (labelEl) {
    labelEl.textContent = phase === 'done' ? '100%' : `${pct.toFixed(0)}%`;
  }
  if (hintEl) {
    hintEl.textContent =
      phase === 'error'
        ? '请关闭此窗口后，从官网或内网更新源重新下载安装。'
        : phase === 'done'
          ? '应用即将自动启动…'
          : '安装过程中请勿关闭此窗口。';
  }
}

if (window.updateBootstrap && window.updateBootstrap.onState) {
  window.updateBootstrap.onState(applyState);
}
