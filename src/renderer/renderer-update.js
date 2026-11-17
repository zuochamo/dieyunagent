/* global $ */
'use strict';

/**
 * 更新状态 UI（**唯一渲染点**）。
 *
 * 状态来源只有一个：Main 的 `app-updater.js` 通过 `app:update-state` 广播的 `{phase, ...}`。
 * 两处显示都由 `applyAppUpdateState` 分发，不要在别处再拼一份文案：
 * - 标题栏那行文字：只在「正在下 / 正在装 / 可安装 / 失败」时出现（每次自动检查都闪一下会变噪音）；
 * - 帮助 → 关于：「检查更新」按钮 + 状态行，**所有**阶段都显示。
 *
 * 为什么「关于」页必须有按钮和状态行：托盘菜单是 Windows 的主要入口，Ubuntu（GNOME）默认
 * 不显示托盘图标，就等于没有任何可点的检查入口；而 checking / idle / error 原先一律不渲染，
 * 用户点完更新看不到任何反应 —— 失败也静默，只能去翻日志。
 */

const updateApi = window.diecloud || {};

const UPDATE_BAR_WIDTH = 14;
/** 失败/已是最新这类终态在标题栏停留的时间 */
const UPDATE_NOTICE_MS = 12000;

let titlebarUpdateInstallBound = false;
let updateNoticeTimer = null;
/** @type {Record<string, unknown> | null} */
let lastUpdateState = null;

function clearUpdateNoticeTimer() {
  if (updateNoticeTimer) {
    clearTimeout(updateNoticeTimer);
    updateNoticeTimer = null;
  }
}

/** 终态提示（失败 / 已是最新）：显示一会儿再收起来，不长期占着标题栏 */
function scheduleUpdateNoticeHide() {
  clearUpdateNoticeTimer();
  updateNoticeTimer = setTimeout(() => {
    updateNoticeTimer = null;
    const wrap = $('titlebar-update-progress-wrap');
    if (wrap) {
      wrap.hidden = true;
      wrap.dataset.phase = 'idle';
      wrap.dataset.indeterminate = 'false';
    }
  }, UPDATE_NOTICE_MS);
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

function hideTitlebarUpdateProgress() {
  const wrap = $('titlebar-update-progress-wrap');
  const el = $('titlebar-update-progress');
  if (wrap) {
    wrap.hidden = true;
    wrap.dataset.indeterminate = 'false';
    wrap.dataset.phase = 'idle';
    wrap.removeAttribute('role');
    wrap.removeAttribute('tabindex');
  }
  if (el) {
    el.textContent = '';
    el.title = '';
  }
}

function setTitlebarUpdateProgress(state) {
  const wrap = $('titlebar-update-progress-wrap');
  const el = $('titlebar-update-progress');
  if (!wrap || !el) return;

  const phase = state && state.phase ? state.phase : 'idle';
  // 「已是最新」「检查中」不进标题栏（自动检查每 20 分钟一次，闪一下纯噪音）；失败要进 —— 不能静默
  const showTitlebar = phase === 'downloading' || phase === 'installing' || phase === 'ready' || phase === 'error';

  if (!showTitlebar) {
    clearUpdateNoticeTimer();
    hideTitlebarUpdateProgress();
    return;
  }

  clearUpdateNoticeTimer();
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

  if (phase === 'error') {
    const detail = String(state.message || '更新失败');
    wrap.dataset.indeterminate = 'false';
    el.textContent = 'update: 失败';
    el.title = `${detail}\n（详情见 帮助 → 关于 / 日志）`;
    scheduleUpdateNoticeHide();
    return;
  }

  const indeterminate = phase === 'installing' && !Number.isFinite(state.percent);
  wrap.dataset.indeterminate = indeterminate ? 'true' : 'false';

  let bar = '';
  if (indeterminate) {
    bar = `${'▒'.repeat(UPDATE_BAR_WIDTH)} …`;
  } else {
    bar = fmtBar(state.percent);
  }

  let suffix = '';
  if (phase === 'downloading' && state.transferred && state.total) {
    suffix = ` · ${fmtBytes(state.transferred)} / ${fmtBytes(state.total)}`;
  } else if (phase === 'installing' && state.message) {
    suffix = ` · ${state.message}`;
  } else if (state.version && phase === 'downloading') {
    suffix = ` · v${state.version}`;
  }

  const line = `update: ${bar}${suffix}`;
  el.textContent = line;
  el.title = line;
}

/** 帮助 → 关于 的状态行文案（所有阶段都说话，不再「点了没反应」） */
function aboutUpdateLabel(state) {
  const phase = state && state.phase ? state.phase : 'idle';
  const ver = state && state.version ? String(state.version) : '';
  const pct = state && Number.isFinite(state.percent) ? Math.max(0, Math.min(100, Math.round(state.percent))) : null;
  if (phase === 'checking') return '正在检查更新…';
  if (phase === 'downloading') {
    const size =
      state && state.transferred && state.total
        ? `（${fmtBytes(state.transferred)} / ${fmtBytes(state.total)}）`
        : '';
    return `正在下载${ver ? ` v${ver}` : ''}… ${pct == null ? '' : `${pct}%`}${size}`.trim();
  }
  if (phase === 'ready') return `${ver ? `v${ver} ` : ''}已下载，可以安装并重启`;
  if (phase === 'installing') return '正在启动安装程序…（可能要求输入管理员密码）';
  if (phase === 'error') return `失败：${String((state && state.message) || '未知错误')}`;
  // idle 默认「已是最新版本」；服务器版（headless 走 apt）会把真实结论放在 message 里
  // —— 例如「发现新版本 0.1.76（当前 0.1.75）；升级：sudo apt install dieyun-headless」
  if (phase === 'idle') return String((state && state.message) || '已是最新版本');
  return '未检查';
}

function updateAboutUpdatePanel(state) {
  const stateEl = $('help-update-state');
  const btn = $('help-update-check');
  if (!stateEl || !btn) return;
  const phase = state && state.phase ? String(state.phase) : 'idle';
  stateEl.textContent = aboutUpdateLabel(state);
  stateEl.dataset.phase = phase;
  const ready = phase === 'ready';
  btn.textContent = ready ? '安装并重启' : '检查更新';
  btn.dataset.phase = phase;
  // 下载/安装进行中别再让人点第二次；ready 时按钮变成安装
  btn.disabled = phase === 'checking' || phase === 'downloading' || phase === 'installing';
}

function applyAppUpdateState(state) {
  if (!state) return;
  lastUpdateState = state;
  setTitlebarUpdateProgress(state);
  updateAboutUpdatePanel(state);
}

/** 回源刷新一次（打开「关于」页时调用：面板可能是在后台检查完之后才打开的） */
async function refreshUpdateState() {
  if (!updateApi.getUpdateState) return;
  try {
    const st = await updateApi.getUpdateState();
    if (!st) return;
    const phase = st.phase ? String(st.phase) : '';
    if (st.pending && phase !== 'ready') {
      applyAppUpdateState({ phase: 'ready', version: st.version, currentVersion: st.currentVersion, percent: 100 });
      return;
    }
    // Main 还没跑过任何一次检查（没有 phase）：保持「未检查」，不要替它编一个「已是最新」
    if (!phase) return;
    applyAppUpdateState(st);
  } catch {
    // 读不到状态不影响面板其余部分
  }
}

/** 「检查更新」点了之后等结果的上限：超时就如实说没结果，不让人对着「正在检查…」干等 */
const UPDATE_CHECK_WATCHDOG_MS = 20000;

async function handleAboutUpdateClick() {
  const btn = $('help-update-check');
  const phase = btn && btn.dataset.phase ? btn.dataset.phase : 'idle';
  try {
    if (phase === 'ready') {
      if (updateApi.installUpdate) await updateApi.installUpdate();
      return;
    }
    if (!updateApi.checkForUpdates) return;
    updateAboutUpdatePanel({ phase: 'checking' });
    const res = await updateApi.checkForUpdates();
    // 已有下载好的包：Main 会直接推 ready
    if (res && res.pending) {
      applyAppUpdateState({ phase: 'ready', version: res.version, percent: 100 });
      return;
    }
    // checkForUpdates 只是「发起检查」，真正的阶段靠 Main 推送（checking → downloading / idle / error）。
    // 若一直停在 checking（开发模式不检查更新，或更新源不可达），把话说明白。
    setTimeout(() => {
      const cur = lastUpdateState;
      const curPhase = cur && cur.phase ? String(cur.phase) : '';
      if (!curPhase || curPhase === 'checking') {
        updateAboutUpdatePanel({
          phase: 'error',
          message: '没有收到结果：开发模式不检查更新，或更新源不可达（详见 帮助 → 日志）'
        });
      }
    }, UPDATE_CHECK_WATCHDOG_MS);
  } catch (e) {
    updateAboutUpdatePanel({ phase: 'error', message: String((e && e.message) || e) });
  }
}

function initUpdateUI() {
  bindTitlebarUpdateInstall();
  if (updateApi.onAppUpdateState) {
    updateApi.onAppUpdateState(applyAppUpdateState);
  }
  const aboutBtn = $('help-update-check');
  if (aboutBtn && !aboutBtn.dataset.bound) {
    aboutBtn.dataset.bound = '1';
    aboutBtn.addEventListener('click', () => {
      void handleAboutUpdateClick();
    });
  }
  void refreshUpdateState();
}
