/* global window, document, currentSessionId, sessionActiveRuns, stopAgentRun */

'use strict';

// 会话目标的 **UI**：侧栏「目标」页（进度 / 清单 / 检查事实 / 停止·继续）。
//
// 分工（同一个目标语义只有一份）：
//   - 目标是什么、进度怎么算、每条检查的最新事实、预算多少 —— 全部在 Main 侧成形
//     （`src/goals/session-goal.js#toPanelView`），Renderer 只负责显示；
//   - 这里不做任何「完成度」推断，也不解析命令输出：事实就是事实，措辞归模型。
//
// 为什么用轮询而不是事件推送：目标由模型在轮内随手改（goal_check / goal_update），
// 逐条埋事件等于把「目标变了」这层知识散到工具执行处。取视图是本地 RPC（微秒级），
// 只有面板可见时才起 2s 心跳 —— 面板收起后一次都不取（没有目标的普通会话零成本）。
//
// 气泡区上方的「目标条」（`#goal-bar`）已删除：同一份视图只在侧栏这一处看；它同时也是
// 「轮内事件驱动刷新」的唯一理由，所以那一拍（原 `scheduleGoalUiRefresh`）一并删了。

const GOAL_PANEL_POLL_MS = 2000;

let goalPanelTimer = null;
let goalPanelRendering = false;
/** 取数期间又来了一拍（切会话）：取完必须补一拍，否则这一拍被静默吃掉 */
let goalPanelPending = false;
let goalPanelVisible = false;

function goalPanelEl(id) {
  return document.getElementById(id);
}

function currentGoalSessionId() {
  return String(typeof currentSessionId !== 'undefined' ? currentSessionId || '' : '');
}

function escapeGoalText(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 状态词：目标的生命周期只有这几种可判定取值（与 session-goal.STATUSES 对应） */
function goalStatusLabel(view) {
  if (!view) return '';
  if (view.outcome === 'complete') return '已完成';
  if (view.outcome === 'blocked' || view.status === 'blocked') return '已阻塞';
  if (view.status === 'paused') return '已暂停';
  if (view.status === 'stalled') return '预算用尽';
  return '进行中';
}

/** 已收尾（完成 / 阻塞）—— 这两种状态的目标不再「推进」，措辞与轮次都要跟着变 */
function goalIsClosed(view) {
  return !!view && (view.outcome === 'complete' || view.outcome === 'blocked');
}

/**
 * 面板头那一行（状态词 + 轮次）。
 *
 * 收尾过的目标不再报「第 N/M 轮」：那个数字是**预算用掉多少**，只对还在推进的目标有意义；
 * 挂到已收尾的目标上读起来就是「还在跑」，这正是「面板和对话对不上」的一半来源
 * （另一半是清单没勾却已完成，见 `toPanelView.progressFrom` 的口径）。收尾之后用户又说了话
 * （`superseded`，判据在 Main），前缀「历史目标」并说明之后对话已继续。
 */
function goalStateText(view) {
  if (!view) return '';
  const label = goalStatusLabel(view);
  const when = fmtMonthDayClock(view.completedAt);
  const closedTail = when ? ` · 收尾于 ${when}` : '';
  if (goalIsClosed(view)) {
    return view.superseded
      ? `历史目标 · ${label}${closedTail}（之后对话已继续）`
      : `${label}${closedTail}`;
  }
  return `${label} · 第 ${Number(view.attempt) || 0}/${Number(view.maxAttempts) || 0} 轮`;
}

/** 进度条：比例由 Main 的 `toPanelView.progress` 给（验收 → 清单 → 收尾 0/1），这里只画 */
function goalProgressBar(view, cells = 12) {
  const ratio = Math.max(0, Math.min(1, Number(view && view.progress) || 0));
  const filled = Math.round(ratio * cells);
  return '▓'.repeat(filled) + '░'.repeat(Math.max(0, cells - filled));
}

/**
 * 进度条右侧那半句：**文案跟着来源走**，不自己判比例（来源由 `toPanelView.progressFrom` 定）。
 *
 * - `checks`：`验收通过 2/3` —— 客观，来自代码记录的事实；
 * - `todos`：`清单 4/6 项` —— 模型自述的计划，只作参考；
 * - `outcome`：没有检查也没有清单，只能给状态词（收尾了/进行中），不编造百分比。
 *
 * 「最近一次检查未通过」这条后缀不是重复：`judgeGoalFinish` 除「每条声明检查最新结果都要通过」外，
 * 还要求**最近一条事实**是绿的（模型临时跑的另一条命令刚报红时不许收尾）。少了这句，
 * 会出现「进度 3/3 通过 + 收尾被打回」的自相矛盾。
 */
function goalProgressText(view) {
  if (!view) return '';
  const lastRed = !!(view.lastFact && view.lastFact.ok === false);
  const suffix = lastRed ? ' · 最近一次检查未通过' : '';
  if (view.progressFrom === 'checks' && Number(view.checksTotal) > 0) {
    return `验收通过 ${Number(view.checksPassed) || 0}/${Number(view.checksTotal)}${suffix}`;
  }
  if (Number(view.todosTotal) > 0) {
    return `清单 ${Number(view.todosDone) || 0}/${Number(view.todosTotal)} 项${suffix}`;
  }
  return goalStatusLabel(view);
}

/**
 * 一条检查的「最新状态」标记：通过 / 未通过 / 没跑成 / 还没跑过。
 *
 * 四态而不是两态：声明了却从没跑过是「未验证」，被沙箱拒了或超时是「没执行成」——
 * 这两种都不是「检查没通过」，画成 ❌ 会让人以为模型改坏了东西。
 */
function goalCheckMark(check) {
  if (!check) return '⬜';
  if (check.ok === true) return '✅';
  if (check.ok === false) return goalFactNoteWord(check.note) ? '⚠' : '❌';
  return '⬜';
}

/** 非「跑完得结论」的事实原因（`ok:false` 只说明没通过，为什么没通过看这个） */
function goalFactNoteWord(note) {
  const n = String(note || '');
  if (n === 'blocked') return '未执行（沙箱或审批拒绝）';
  if (n === 'timeout') return '超时';
  if (n === 'error' || n === 'missing') return '执行出错';
  return '';
}

function goalCheckMeta(check) {
  const c = check || {};
  const runs = Number(c.runs) || 0;
  if (!runs) return '还没跑过';
  const why = goalFactNoteWord(c.note);
  if (why) return `${why} · 共 ${runs} 次 · 最近第 ${Number(c.round) || 0} 轮`;
  const code = c.exitCode == null ? '' : ` exit=${c.exitCode}`;
  return `跑过 ${runs} 次${code} · 最近第 ${Number(c.round) || 0} 轮`;
}

function goalFactsHtml(view) {
  const facts = Array.isArray(view.evidence) ? view.evidence : [];
  if (!facts.length) return '<p class="goal-panel-empty">还没有检查事实（goal_check 会落一条）</p>';
  const rows = facts
    .slice()
    .reverse()
    .map((f) => {
      const why = goalFactNoteWord(f.note);
      // 「没跑成」直接把原因写在标记处；「跑完没通过」才写「未通过」
      const mark = f.ok ? '通过' : why || '未通过';
      const code = f.exitCode == null ? '' : ` exit=${f.exitCode}`;
      return `<li class="goal-fact ${f.ok ? 'is-ok' : why ? 'is-todo' : 'is-fail'}">
        <span class="goal-fact-mark">${mark}${code}</span>
        <code class="goal-fact-cmd">${escapeGoalText(f.command)}</code>
        <span class="goal-fact-round">第 ${Number(f.round) || 0} 轮</span>
      </li>`;
    });
  return `<ul class="goal-fact-list">${rows.join('')}</ul>`;
}

function goalTodoHtml(view) {
  const todos = Array.isArray(view.todos) ? view.todos : [];
  if (!todos.length) return '';
  const items = todos
    .map(
      (t) =>
        `<li class="goal-todo ${t.done ? 'is-done' : ''}">${
          t.done ? '✅' : '⬜'
        }<span>${escapeGoalText(t.text)}</span></li>`
    )
    .join('');
  return `<div class="goal-section">
    <div class="goal-section-title">推进清单（${view.todosDone}/${view.todosTotal}）</div>
    <ul class="goal-todo-list">${items}</ul>
  </div>`;
}

/** 每条声明检查一行：状态 + 命令 + 最近一次退出码 + 跑过几次（事实的按检查聚合） */
function goalChecksHtml(view) {
  const checks = Array.isArray(view.checks) ? view.checks : [];
  if (!checks.length) {
    return `<div class="goal-section">
      <div class="goal-section-title">验收命令</div>
      <p class="goal-panel-empty">未声明检查（未验证模式：能跑，但完成申请不会被代码核对）</p>
    </div>`;
  }
  const items = checks
    .map(
      (c) => `<li class="goal-check ${c.ok === true ? 'is-ok' : c.ok === false ? 'is-fail' : 'is-todo'}">
        <span class="goal-check-mark">${goalCheckMark(c)}</span>
        <code>${escapeGoalText(c.command)}</code>
        <span class="goal-check-meta">${escapeGoalText(goalCheckMeta(c))}</span>
      </li>`
    )
    .join('');
  return `<div class="goal-section">
    <div class="goal-section-title">验收命令（退出码 0 = 通过）</div>
    <ul class="goal-check-list">${items}</ul>
  </div>`;
}

/** 目标视图的唯一读取口（其它模块要 objective / 状态时也走这里，别自己拼 IPC） */
async function sessionGoalPanelView(sessionId) {
  const sid = String(sessionId || '');
  const api = (window.diecloud || {}).sessionGoalPanel;
  if (!sid || typeof api !== 'function') return null;
  try {
    const res = await api({ sessionId: sid });
    return res && res.ok ? res.goal : null;
  } catch {
    return null;
  }
}

/**
 * 暂停（用户按停止）：只改「自动推进」这一个开关，事实与清单全留。
 * 不暂停的话，下一条消息结束时目标还会自动续跑 —— 那是「代码比人更坚持」。
 */
async function pauseSessionGoal(sessionId) {
  const sid = String(sessionId || '');
  const api = (window.diecloud || {}).sessionGoalPanel;
  if (!sid || typeof api !== 'function') return;
  try {
    await api({ sessionId: sid, action: 'pause' });
  } catch {
    // 失败保持现状：下一轮判定会重新落一次真实状态
  }
}

/** 「继续」= 重置轮次预算后开下一轮（预算与状态都在 Main 改，这里只发意图） */
async function continueSessionGoal() {
  const sessionId = currentGoalSessionId();
  const api = (window.diecloud || {}).sessionGoalPanel;
  if (!sessionId || typeof api !== 'function') return;
  try {
    await api({ sessionId, action: 'resume' });
  } catch {
    return;
  }
  refreshGoalPanel();
  if (typeof window.startGoalTurn === 'function') {
    await window.startGoalTurn({ sessionId });
  }
}

/** 这一轮是不是正在跑（据此决定显示「停止」还是「继续」） */
function goalSessionRunning(sessionId) {
  const sid = String(sessionId || '');
  if (!sid || typeof sessionActiveRuns === 'undefined' || !sessionActiveRuns) return false;
  const live = sessionActiveRuns.get(sid);
  // 与聊天区同一判据：登记的 run 可能已经 finished 但还没被清掉，
  // 那时候显示「停止」等于给用户一颗按了没反应的按钮。
  return !!(live && !live.finished);
}

/** 「继续」只在**没在跑**且还能推进时出现：收尾过的目标没有「继续」可言 */
function goalCanContinue(view, running) {
  return !!view && !running && view.outcome !== 'complete' && view.outcome !== 'blocked';
}

/**
 * 写 HTML 但内容没变就不动 DOM：面板是滚动容器，2s 轮询里每次重建 innerHTML
 * 会把用户的阅读位置顶回顶部（目标越推进、事实越多，这个毛病越明显）。
 */
function writeGoalHtml(el, html) {
  if (el && el.innerHTML !== html) el.innerHTML = html;
}

function renderGoalPanel(view, note) {
  const body = goalPanelEl('goal-panel-body');
  const meta = goalPanelEl('goal-panel-meta');
  const clearBtn = goalPanelEl('goal-panel-clear');
  const stopBtn = goalPanelEl('goal-panel-stop');
  const continueBtn = goalPanelEl('goal-panel-continue');
  const sessionId = currentGoalSessionId();
  const running = goalSessionRunning(sessionId);
  if (stopBtn) stopBtn.hidden = !!view ? !running : true;
  if (continueBtn) continueBtn.hidden = !goalCanContinue(view, running);
  if (!body) return;
  if (!view) {
    if (meta) meta.textContent = '本会话暂无目标';
    if (clearBtn) clearBtn.hidden = true;
    body.innerHTML = `<p class="artifacts-empty">${escapeGoalText(
      note ||
        '还没有目标。需要多轮推进时，Agent 会自己开一个（goal_start）；也可以直接说清「做到什么算完成」。'
    )}</p>`;
    return;
  }
  if (meta) meta.textContent = goalStateText(view);
  if (clearBtn) clearBtn.hidden = false;
  // `is-tail`：输出尾部是唯一「可以长、也可以占满剩余高度」的段（见 styles.css .goal-section.is-tail）
  const tail =
    view.lastFact && view.lastFact.tail
      ? `<div class="goal-section is-tail">
          <div class="goal-section-title">最近一次输出尾部</div>
          <pre class="goal-tail agent-scroll">${escapeGoalText(view.lastFact.tail)}</pre>
        </div>`
      : '';
  writeGoalHtml(body, `<div class="goal-panel">
    <div class="goal-objective">${escapeGoalText(view.objective)}</div>
    <div class="goal-progress-line">
      <span class="goal-progress-bar">${goalProgressBar(view)}</span>
      <span class="goal-progress-text">${escapeGoalText(goalProgressText(view))}</span>
    </div>
    ${note ? `<p class="goal-panel-note">${escapeGoalText(note)}</p>` : ''}
    ${goalTodoHtml(view)}
    ${goalChecksHtml(view)}
    <div class="goal-section">
      <div class="goal-section-title">检查事实（代码记录，不可编辑）</div>
      ${goalFactsHtml(view)}
    </div>
    ${tail}
  </div>`);
}

/** 面板可见才有心跳；不可见立即停（普通会话零成本） */
function syncGoalPoll() {
  if (goalPanelVisible && !goalPanelTimer) {
    goalPanelTimer = setInterval(() => refreshGoalPanel(), GOAL_PANEL_POLL_MS);
  } else if (!goalPanelVisible && goalPanelTimer) {
    clearInterval(goalPanelTimer);
    goalPanelTimer = null;
  }
}

/**
 * 取一次视图并渲染面板。取不到不是错误：面板显示空态即可（比如 Gateway 还没热）。
 * 只有面板可见时才有人看这份结果，所以失败直接写在面板上（没有「静默拍」这一说）。
 */
async function refreshGoalPanel() {
  if (goalPanelRendering) {
    // 正在取。这一拍不能丢：切会话正是最容易撞上的时刻（旧会话的心跳还在飞），
    // 丢掉它就意味着新会话要等到下一次心跳才看到目标。取完补一拍。
    goalPanelPending = true;
    return;
  }
  const sessionId = currentGoalSessionId();
  const api = (window.diecloud || {}).sessionGoalPanel;
  if (!sessionId || typeof api !== 'function') {
    renderGoalPanel(null, '选择会话后显示该会话的目标');
    syncGoalPoll();
    return;
  }
  goalPanelRendering = true;
  try {
    const res = await api({ sessionId });
    // 取数期间切了会话：这份视图已经属于上一个会话，丢掉并给新会话补一拍
    if (currentGoalSessionId() !== sessionId) {
      goalPanelPending = true;
      return;
    }
    renderGoalPanel(res && res.ok ? res.goal : null, res && !res.ok ? '目标读取失败' : '');
  } catch {
    renderGoalPanel(null, '目标读取失败');
  } finally {
    goalPanelRendering = false;
    if (goalPanelPending) {
      goalPanelPending = false;
      // 让出当前栈再补：这一拍很可能正是刚才被挡掉的那次调用
      setTimeout(() => void refreshGoalPanel(), 0);
    } else {
      syncGoalPoll();
    }
  }
}

/** 面板可见时的首刷 + 心跳启动（唯一入口，与 context / index 面板同构） */
function onGoalPanelShown() {
  goalPanelVisible = true;
  refreshGoalPanel();
  syncGoalPoll();
}

function onGoalPanelHidden() {
  goalPanelVisible = false;
  syncGoalPoll();
}

/**
 * 切会话 / 重绘后的重取（`finalizeChatRenderAfterMessages` 调）。
 *
 * 面板不在前台就不打这次 IPC：可见性只有一个来源（本模块的 `goalPanelVisible`），
 * 而面板可见时本来就有 2s 心跳 —— 再按渲染次数补一次只是白打一次本地 RPC。
 */
function refreshGoalPanelIfVisible() {
  if (goalPanelVisible) refreshGoalPanel();
}

/** 清除本会话目标（纯存储操作：目标语义不在这里，删除即删除） */
async function clearSessionGoalFromPanel() {
  const sessionId = currentGoalSessionId();
  const api = (window.diecloud || {}).sessionGoalPanel;
  if (!sessionId || typeof api !== 'function') return;
  try {
    await api({ sessionId, action: 'clear' });
  } catch {
    // 失败保持现状，下次轮询会显示真实状态
  }
  refreshGoalPanel();
}

function stopGoalTurn() {
  // 停止复用对话区那颗停止（中断本轮 + 目标转「已暂停」，见 renderer-agent-abort.js）
  if (typeof stopAgentRun === 'function') stopAgentRun(currentGoalSessionId());
  refreshGoalPanel();
}

function initGoalPanel() {
  const refreshBtn = goalPanelEl('goal-panel-refresh');
  if (refreshBtn) refreshBtn.addEventListener('click', () => refreshGoalPanel());
  const clearBtn = goalPanelEl('goal-panel-clear');
  if (clearBtn) clearBtn.addEventListener('click', () => clearSessionGoalFromPanel());
  const continueBtn = goalPanelEl('goal-panel-continue');
  if (continueBtn) continueBtn.addEventListener('click', () => void continueSessionGoal());
  const stopBtn = goalPanelEl('goal-panel-stop');
  if (stopBtn) stopBtn.addEventListener('click', () => stopGoalTurn());
}

window.initGoalPanel = initGoalPanel;
window.onGoalPanelShown = onGoalPanelShown;
window.onGoalPanelHidden = onGoalPanelHidden;
window.refreshGoalPanel = refreshGoalPanel;
window.refreshGoalPanelIfVisible = refreshGoalPanelIfVisible;
window.sessionGoalPanelView = sessionGoalPanelView;
window.pauseSessionGoal = pauseSessionGoal;
window.continueSessionGoal = continueSessionGoal;
