'use strict';

/**
 * OS 级电脑控制服务（仅 Main 进程；经 LocalGateway 注入给 computer.* handler）。
 *
 * 职责：把 computer 工具的结构化动作编排成 Win32 输入 + desktopCapturer 截图。
 * 不做档位判定（sandbox-policy）也不做审批（gateway handler）——这里是纯执行体。
 * 动作枚举与它的性质在 computer/actions.js（唯一来源），这里只负责分发。
 *
 * 动作循环语义：每个输入动作都返回执行后的最新截图，模型「动一下看一眼」，无需再显式
 * 调 screenshot；坐标口径为「模型最近一次看到的截图」的像素（按会话记忆，
 * 多显示器时模型看到的哪块屏，下一步动作就落在哪块屏）。
 *
 * 诚实契约（模型只能靠结果判断现实，所以每条都不能含糊）：
 * - 注入被系统丢弃（UIPI / 锁屏 / 安全桌面）→ 抛 INPUT_DROPPED，绝不回 ok；
 * - 动作已执行但动作后截图失败 → `applied:true` + `screenshotError`，绝不回错误，
 *   否则模型会原样重试，变成重复点击/重复输入；
 * - 画面有没有变（`changed`）与是否已稳定（`stable`）如实回报，等不到就是等不到
 *   （`timedOut:true`），不拿猜的当事实；
 * - 看不到、判断不了的事（帧指纹不可用、窗口已关、前台抢不到）→ 明确说「判断不了/没成功」。
 */

const captureApi = require('./capture');
const win32Api = require('./win32-input');
const {
  displayPhysicalOrigin,
  displayPhysicalSize,
  fullView,
  physicalRectToViewRect,
  regionView,
  sameViewRect,
  sameViewSpace,
  screenPhysicalToViewPoint,
  viewPointToScreenPhysical,
  viewRectToPhysicalRect
} = require('./coordinate-map');
const { CLICK_ACTIONS, isComputerAction, actionMeta } = require('./actions');
const { AGENT_LIMITS_DEFAULTS } = require('../agent/agent-limits');

// 动作后等界面稳定的节奏（数字唯一来源：agent-limits，AGENTS.md §6）。
const SETTLE_DELAY_MS = AGENT_LIMITS_DEFAULTS.computerSettleDelayMs;
const SETTLE_POLL_MS = AGENT_LIMITS_DEFAULTS.computerSettlePollMs;
const SETTLE_MAX_MS = AGENT_LIMITS_DEFAULTS.computerSettleMaxMs;

const DEFAULT_SCROLL_NOTCHES = 3;
// 等待时长是护栏数字（AGENTS.md §6）：唯一来源在 agent-limits，这里只做别名。
const MIN_WAIT_MS = AGENT_LIMITS_DEFAULTS.computerWaitMinMs;
const MAX_WAIT_MS = AGENT_LIMITS_DEFAULTS.computerWaitMaxMs;
const WAIT_UNTIL_DEFAULT_MS = AGENT_LIMITS_DEFAULTS.computerWaitUntilDefaultMs;
const WAIT_UNTIL_MAX_MS = AGENT_LIMITS_DEFAULTS.computerWaitUntilMaxMs;
const WINDOW_LIST_MAX = AGENT_LIMITS_DEFAULTS.computerWindowListMax;

/** 会话视图记忆上限：防长跑进程累积。 */
const MAX_SESSION_VIEWS = 200;

/**
 * @param {{ log?: (msg: string) => void,
 *   capture?: { listDisplays: Function, getDisplay: Function, grabDisplay: Function,
 *     frameSignature: Function, encodeShot: Function },
 *   win32?: object }} [deps] `capture` / `win32` 只用于替换外部世界（单测），生产走默认实现。
 */
function createComputerService(deps = {}) {
  const log = typeof deps.log === 'function' ? deps.log : () => {};
  const capture = deps.capture || captureApi;
  const win32 = deps.win32 || win32Api;

  /**
   * sessionId → { displayIndex, view, signature }
   * - `view` 是模型最近一次看到的那张图的坐标空间（全屏或一块 region，见 coordinate-map）；
   * - `signature` 是那张图的帧指纹，用来回答「这一下画面变了没有」。
   */
  const viewBySession = new Map();

  function input() {
    // koffi 在 win32-input 内部惰性加载；非 Windows 在这一步就报 OS_CONTROL_UNSUPPORTED，
    // 而不是「截屏成功之后再炸在光标回报上」。
    if (!win32.isSupported()) throw win32.unsupportedError();
    return win32;
  }

  /**
   * 回报类调用（光标 / 前台窗口标题）不允许把**已经执行过的动作**变成错误：
   * 读不到就是读不到，结果里少一个字段，比让模型以为「动作没发生、要重试」便宜得多。
   */
  function probe(fn, fallback) {
    try {
      return fn();
    } catch {
      return fallback;
    }
  }

  function rememberView(sessionId, displayIndex, view, signature) {
    const sid = String(sessionId || '').trim() || '-';
    if (viewBySession.has(sid)) viewBySession.delete(sid);
    viewBySession.set(sid, { displayIndex, view, signature: signature || '' });
    while (viewBySession.size > MAX_SESSION_VIEWS) {
      const oldest = viewBySession.keys().next().value;
      viewBySession.delete(oldest);
    }
  }

  function lastView(sessionId) {
    return viewBySession.get(String(sessionId || '').trim() || '-') || null;
  }

  /**
   * 模型当前的坐标空间：它最近看到的那张图；没有（或属于别的屏）时按整屏物理像素 1:1。
   */
  function currentView(sessionId, display) {
    const remembered = lastView(sessionId);
    if (remembered && remembered.displayIndex === display.index && remembered.view) return remembered.view;
    return fullView(display);
  }

  /**
   * 目标屏解析：显式 display 越界要报错（让模型自己纠正）；视图记忆里的屏可能
   * 已经被拔掉，失效时回落到主屏，不能把后续每个动作都卡死。
   */
  function resolveDisplay(explicit, rememberedIndex) {
    if (explicit != null) return capture.getDisplay(explicit);
    if (rememberedIndex != null) {
      try {
        return capture.getDisplay(rememberedIndex);
      } catch {
        /* 屏拔了：忽略记忆 */
      }
    }
    return capture.getDisplay(undefined);
  }

  function buildResult(action, display, shot, cursorPhys, extra = {}) {
    const out = {
      ok: true,
      action,
      display: display.index,
      primary: display.primary,
      screen: { width: shot.width, height: shot.height },
      activeWindow: extra.activeWindow || ''
    };
    // 光标回报必须落在「模型看到的那套像素」里：同一张图的尺寸参与换算，
    // 否则图被放大/缩小/裁剪过时，cursor 与 coordinate 不是同一个空间。
    if (cursorPhys && extra.view) out.cursor = screenPhysicalToViewPoint(extra.view, cursorPhys);
    if (extra.typed != null) out.typed = extra.typed;
    if (extra.changed != null) out.changed = extra.changed;
    if (extra.stable != null) out.stable = extra.stable;
    if (extra.timedOut != null) out.timedOut = extra.timedOut;
    if (extra.waitedMs != null) out.waitedMs = extra.waitedMs;
    if (extra.note) out.note = extra.note;
    return { ...out, ...shot };
  }

  /**
   * 输入动作的结果装配：**动作已经执行**这件事必须写进结果，哪怕动作后截图失败。
   *
   * 为什么：过去这里只有一个出口（截图失败就抛 CAPTURE_FAILED），模型看到「失败」
   * 就会原样重试 —— 重复点击、重复回车、重复输入都是这么产生的。动作已执行的唯一
   * 诚实表述是 applied:true + screenshotError，并明说「不要重复这个动作」。
   */
  function buildActionResult(act, display, shot, cursorPhys, extra = {}) {
    if (shot) return { ...buildResult(act, display, shot, cursorPhys, extra), applied: true };
    const out = {
      ok: true,
      action: act,
      applied: true,
      display: display.index,
      primary: display.primary,
      activeWindow: extra.activeWindow || '',
      screenshotError: extra.screenshotError || '截图失败',
      screenshotErrorCode: extra.screenshotErrorCode || 'CAPTURE_FAILED'
    };
    // 没有截图就没有「模型坐标空间」，只能按整屏物理像素回报光标（口径写清楚）。
    if (cursorPhys) out.cursor = screenPhysicalToViewPoint(fullView(display), cursorPhys);
    if (extra.typed != null) out.typed = extra.typed;
    out.note =
      `「${act}」已经执行，但动作后的截图没取到（${out.screenshotError}）。` +
      '不要重复执行同一个动作（会变成重复点击/重复输入）；先 action=screenshot 重新看一眼画面再决定下一步。';
    return out;
  }

  /**
   * 「画面变了没有」：只有同一坐标空间（同屏 + 同区域 + 同图尺寸）的两张图才可比。
   * 拿不到可比证据时返回 undefined —— 宁可不说，也不给假信号（模型的下一步全靠它）。
   */
  function changedAgainst(remembered, display, nextView, signature) {
    if (!remembered || !remembered.signature || !signature) return undefined;
    if (remembered.displayIndex !== display.index) return undefined;
    if (!sameViewSpace(remembered.view, nextView)) return undefined;
    return remembered.signature !== signature;
  }

  /**
   * 从原生帧里裁出一块物理矩形（region 截图 / 动作后保持同一块放大区域）。
   * @returns {{ image: object, view: object }} 裁出的图 + 它自己的坐标空间
   */
  function cropToPhysicalRect(display, frame, rect) {
    const origin = displayPhysicalOrigin(display);
    const phys = displayPhysicalSize(display);
    // 原生帧的左上是「屏左上」，rect 是全局物理：先减原点，再按「帧像素/物理像素」换算
    const kx = frame.width / Math.max(1, phys.width);
    const ky = frame.height / Math.max(1, phys.height);
    const local = {
      x: Math.max(0, Math.round((rect.x - origin.x) * kx)),
      y: Math.max(0, Math.round((rect.y - origin.y) * ky)),
      width: Math.max(1, Math.round(rect.width * kx)),
      height: Math.max(1, Math.round(rect.height * ky))
    };
    local.width = Math.max(1, Math.min(local.width, frame.width - local.x));
    local.height = Math.max(1, Math.min(local.height, frame.height - local.y));
    let image = null;
    try {
      image = frame.image.crop(local);
    } catch {
      image = null;
    }
    if (!image || (typeof image.isEmpty === 'function' && image.isEmpty())) {
      const e = new Error(
        `区域截图失败：按 [x, y, 宽, 高] 裁出的是空图（屏 ${display.index}，请求 ${JSON.stringify(rect)}）`
      );
      e.code = 'CAPTURE_FAILED';
      e.retryable = false;
      e.suggestedFix = 'region 用 [x, y, 宽, 高]（坐标相对你最近一次看到的截图）；不传 region 就截整屏。';
      throw e;
    }
    return { image, view: regionView(rect) };
  }

  /**
   * 抓一帧 → 按视图裁剪 → 编码：**唯一取图口径**（screenshot / 动作后 / wait_until 共用）。
   *
   * 视图即模型坐标空间：交付的图尺寸决定 `coordinate` 的像素口径，所以 width/height
   * 必须用编码后的真实尺寸回填，而不是物理尺寸。
   *
   * @param {object} display
   * @param {object} view 目标坐标空间（全屏或一块区域）
   * @param {object} [visionBudget] 编码预算（长边 + base64 上限）
   * @param {object} [frame] 已抓到的帧（稳定帧判定已经抓过就不再重复截屏）
   */
  async function captureView(display, view, visionBudget, frame) {
    const grabbed = frame || (await capture.grabDisplay(display));
    const full = fullView(display);
    const rect = sameViewRect(view, full)
      ? null
      : { x: view.originX, y: view.originY, width: view.nativeWidth, height: view.nativeHeight };
    const source = rect ? cropToPhysicalRect(display, grabbed, rect) : { image: grabbed.image, view: full };
    const shot = capture.encodeShot(source.image, visionBudget);
    return {
      shot,
      view: { ...source.view, width: shot.width, height: shot.height },
      signature: capture.frameSignature(source.image)
    };
  }

  /**
   * 动作后的取帧：等到「连续两帧相同」再交付。
   *
   * 为什么不能只 sleep 固定 180ms：慢弹窗/列表加载/动画会截到半截，模型按半截画面点下一步
   * 就是误点；而固定等久了又是纯浪费。这里只等稳定、不等久：超过上限如实回 `stable:false`，
   * 让模型自己决定「再等一下」，而不是拿一帧糊的当事实。
   *
   * `stable:null` = 平台给不了位图指纹（无法判断），此时不连拍也不谎报。
   */
  async function settleFrames(inp, display) {
    await inp.sleep(SETTLE_DELAY_MS);
    let frame = await capture.grabDisplay(display);
    let signature = capture.frameSignature(frame.image);
    if (!signature) return { frame, signature: null, stable: null };
    const deadline = Date.now() + SETTLE_MAX_MS;
    // 双边界：既看时间也看次数（sleep 很便宜时不能靠时间兜底去狂拍屏）。
    const maxPolls = maxWaitPolls(SETTLE_MAX_MS, SETTLE_POLL_MS);
    for (let poll = 0; poll < maxPolls && Date.now() < deadline; poll += 1) {
      await inp.sleep(SETTLE_POLL_MS);
      const next = await capture.grabDisplay(display);
      const nextSig = capture.frameSignature(next.image);
      frame = next;
      if (!nextSig) return { frame, signature, stable: null };
      if (nextSig === signature) return { frame, signature: nextSig, stable: true };
      signature = nextSig;
    }
    return { frame, signature, stable: false };
  }

  /** 轮询次数上限（时间与次数双边界：sleep 很便宜时也不能靠时间兜底去狂拍屏）。 */
  function maxWaitPolls(budgetMs, pollMs) {
    return Math.max(1, Math.ceil(Math.max(1, budgetMs) / Math.max(1, pollMs)));
  }

  function clampWaitUntilMs(ms) {
    const n = Number(ms);
    const raw = Number.isFinite(n) && n > 0 ? n : WAIT_UNTIL_DEFAULT_MS;
    return Math.min(WAIT_UNTIL_MAX_MS, Math.max(SETTLE_POLL_MS, Math.round(raw)));
  }

  async function screenshot(params = {}) {
    const inp = input();
    const remembered = lastView(params.sessionId);
    const display = resolveDisplay(params.display, remembered ? remembered.displayIndex : null);
    const base = currentView(params.sessionId, display);
    // 没给 region 就是整屏视图；给了就把「模型当前坐标空间里的这块」裁出来，
    // 裁出来的图**成为新的坐标空间**（以后 click 的 coordinate 就相对它）。
    const target = params.region != null ? regionView(viewRectToPhysicalRect(base, params.region)) : fullView(display);
    const { shot, view, signature } = await captureView(display, target, params.visionBudget);
    const changed = changedAgainst(remembered, display, view, signature);
    rememberView(params.sessionId, display.index, view, signature);
    log(
      `COMPUTER_SHOT display=${display.index} ${shot.width}x${shot.height}` +
        (params.region != null ? ` region@${view.originX},${view.originY} ${view.nativeWidth}x${view.nativeHeight}` : '')
    );
    return buildResult('screenshot', display, shot, probe(() => inp.getPhysicalCursorPos(), null), {
      activeWindow: probe(() => inp.foregroundWindowTitle(), ''),
      view,
      changed
    });
  }

  /**
   * 等「画面变化 / 界面稳定」——用**看**代替**猜**。
   *
   * 为什么需要它：过去模型只能 `wait(2000)` 然后截图，猜一个数字；慢就说「还没好」，
   * 快就白等。这里把「等到了没有」变成可观测事实：等到就返回变化后的画面，
   * 等不到就 `timedOut:true` 并明说「你等的那个变化没发生」——后者是更重要的信号，
   * 它通常意味着上一步的输入没生效或界面弹了别的东西。
   *
   * @param {{ condition?: string, ms?: number, sessionId?: string, visionBudget?: object }} params
   */
  async function waitUntil(params, inp, display, view) {
    const wantStable = String(params.condition || 'changed') === 'stable';
    const budgetMs = clampWaitUntilMs(params.ms);
    const startedAt = Date.now();
    const remembered = lastView(params.sessionId);
    const comparable =
      remembered && remembered.displayIndex === display.index && sameViewSpace(remembered.view, view);
    // 变化基线 = 模型上次看到的那张图；没有可比基线就从「现在这帧」算起（并在 note 里说清）
    const baseline = !wantStable && comparable ? remembered.signature || null : null;
    let last = await captureView(display, view, params.visionBudget);

    const done = (extra) => {
      rememberView(params.sessionId, display.index, last.view, last.signature);
      const waitedMs = Date.now() - startedAt;
      return buildResult('wait_until', display, last.shot, probe(() => inp.getPhysicalCursorPos(), null), {
        activeWindow: probe(() => inp.foregroundWindowTitle(), ''),
        view: last.view,
        waitedMs,
        ...extra
      });
    };

    if (!last.signature) {
      // 平台给不出帧指纹：不烧预算假装在等，直接说「判断不了」
      return done({
        timedOut: false,
        note: '这台机器给不了帧指纹（无法逐帧比对），所以不能判断画面有没有变化；请直接 action=screenshot 看画面，或用 wait 按经验等待。'
      });
    }

    const fromStart = !baseline;
    const base = baseline || last.signature;
    let changed = false;
    let stable = null;
    let timedOut = true;
    const maxPolls = maxWaitPolls(budgetMs, SETTLE_POLL_MS);
    for (let poll = 0; poll < maxPolls && Date.now() - startedAt < budgetMs; poll += 1) {
      await inp.sleep(SETTLE_POLL_MS);
      const next = await captureView(display, view, params.visionBudget);
      if (!next.signature) {
        last = next;
        return done({
          timedOut: false,
          note: '等待过程中这台机器不再提供帧指纹（无法比对），已返回当前画面；请直接 action=screenshot 判断。'
        });
      }
      stable = next.signature === last.signature;
      changed = next.signature !== base;
      last = next;
      if (wantStable ? stable : changed) {
        timedOut = false;
        break;
      }
    }

    const note = describeWait(wantStable, { changed, stable, timedOut, fromStart });
    return done({ changed, stable, timedOut, note });
  }

  function describeWait(wantStable, { changed, stable, timedOut, fromStart }) {
    const tail = fromStart ? '（你此前没有可比的画面，这次是从开始等待那一帧算起的。）' : '';
    if (wantStable) {
      return (
        (timedOut
          ? '画面还在变（stable=false）：加载/动画可能没结束，这张图未必是最终状态。'
          : '画面已稳定（连续两帧相同）。')
        + tail
      );
    }
    return (
      (timedOut
        ? '等了这么久画面没有任何变化（changed=false）：你等的那个变化没发生 —— 不要原样重复上一步，先看这张截图确认界面到底停在哪。'
        : '画面已经变化，这是变化后的最新画面。')
      + tail
    );
  }

  /** 窗口矩形落在哪块屏（取中心点归属；跨屏窗口按中心算）。 */
  function displayIndexOfRect(displays, rect) {
    const cx = rect.x + rect.width / 2;
    const cy = rect.y + rect.height / 2;
    for (const d of displays) {
      const o = displayPhysicalOrigin(d);
      const s = displayPhysicalSize(d);
      if (cx >= o.x && cx < o.x + s.width && cy >= o.y && cy < o.y + s.height) return d.index;
    }
    return -1;
  }

  /**
   * 列顶层窗口：模型不必再「为了看标题截一张全屏图」，切窗口也不必靠点任务栏猜位置。
   *
   * `rect` 换算到**模型当前的坐标空间**（和 click 的 coordinate 同一套像素）：
   * 这样列表里的位置可以直接拿去点。窗口在截图之外时数值会越界 —— 那正是
   * 「它在别的地方/别的屏」的如实表达。
   */
  async function listWindows(params, inp, display, view) {
    const displays = capture.listDisplays();
    const rows = inp.listWindows({ max: WINDOW_LIST_MAX });
    const windows = rows.map((w) => ({
      handle: w.handle,
      title: w.title,
      // 最小化窗口没有可用位置（rect=null）：位置报 null，display 报 -1，别编一个坐标出来
      display: w.rect ? displayIndexOfRect(displays, w.rect) : -1,
      rect: w.rect ? physicalRectToViewRect(view, w.rect) : null,
      minimized: Boolean(w.minimized),
      active: Boolean(w.active)
    }));
    const active = windows.find((w) => w.active);
    const hasMinimized = windows.some((w) => !w.rect);
    return {
      ok: true,
      action: 'list_windows',
      count: windows.length,
      activeWindow: active ? active.title : probe(() => inp.foregroundWindowTitle(), ''),
      windows,
      note:
        '窗口按 z 序（最上层在前）；rect 与你当前截图的像素同一套口径，可直接用于 click。' +
        '切换窗口用 action=activate_window + handle（比点任务栏稳）。' +
        (hasMinimized ? 'rect 为 null 的是最小化窗口（没有位置），要操作它先 activate_window。' : '') +
        (windows.length >= WINDOW_LIST_MAX ? `已截断到前 ${WINDOW_LIST_MAX} 个窗口。` : '')
    };
  }

  /**
   * 窗口句柄必须来自**最近一次 list_windows**（挡住编造的句柄、以及提示注入里塞的句柄），
   * 顺带挡住「窗口已关、句柄过期」这种最常见的失效。
   */
  function unknownWindowError(handle) {
    const e = new Error(
      `窗口句柄 ${JSON.stringify(handle)} 不在当前窗口清单里（可能已关闭，或不是从 list_windows 拿到的）`
    );
    e.code = 'INVALID_WINDOW';
    e.retryable = false;
    e.suggestedFix = '先 action=list_windows 重新取清单，再用它返回的 handle。';
    return e;
  }

  /** 定位到模型坐标（当前视图空间）；返回全局物理坐标。 */
  async function locate(inp, view, point) {
    const phys = viewPointToScreenPhysical(view, point);
    inp.moveMouseToPhysical(phys.x, phys.y);
    await inp.sleep(40);
    return phys;
  }

  async function performInputAction(act, a, inp, view) {
    let touched = null;
    switch (true) {
      case act === 'move': {
        touched = await locate(inp, view, a.coordinate);
        break;
      }
      case CLICK_ACTIONS.has(act): {
        // 键位映射也来自动作表（right_click/middle_click 自带 button），避免在这里再列一遍动作名
        const button = actionMeta(act).button || a.button || 'left';
        // 修饰键在整次点击期间按住：shift=区间选择 / ctrl=多选 / alt=特殊点击
        await inp.withModifiers(a.modifiers, async () => {
          if (a.coordinate) touched = await locate(inp, view, a.coordinate);
          inp.clickMouseButton(button);
          if (act === 'double_click') {
            await inp.sleep(80);
            inp.clickMouseButton(button);
          }
        });
        break;
      }
      case act === 'drag': {
        const from = await locate(inp, view, a.coordinate);
        const to = viewPointToScreenPhysical(view, a.to);
        await inp.withModifiers(a.modifiers, () => inp.dragMouse(from, to, a.button || 'left'));
        touched = to;
        break;
      }
      case act === 'type': {
        const sent = await inp.typeText(a.text);
        touched = { typed: sent };
        break;
      }
      case act === 'key': {
        inp.pressKeyCombo(inp.parseKeyCombo(a.key));
        break;
      }
      case act === 'scroll': {
        if (a.coordinate) await locate(inp, view, a.coordinate);
        inp.scrollWheel(a.direction || 'down', Number(a.amount) || DEFAULT_SCROLL_NOTCHES);
        break;
      }
      default:
        break;
    }
    return touched;
  }

  /**
   * 执行一个动作并返回最新画面。
   * @param {{ action: string, coordinate?: number[], to?: number[], button?: string,
   *   modifiers?: string[], text?: string, key?: string, direction?: string, amount?: number,
   *   ms?: number, condition?: string, handle?: number, region?: number[],
   *   display?: number, sessionId?: string }} params
   */
  async function action(params = {}) {
    const act = String(params.action || '');
    if (!isComputerAction(act)) {
      const e = new Error(`未知动作「${act}」`);
      e.code = 'INVALID_ACTION';
      e.retryable = false;
      throw e;
    }
    const inp = input();
    const sessionId = params.sessionId || '';
    if (act === 'screenshot') return screenshot(params);

    const remembered = lastView(sessionId);
    const display = resolveDisplay(params.display, remembered ? remembered.displayIndex : null);
    // 模型当前的坐标空间：可能是整屏，也可能是它上一张 region 截出来的那块。
    const view = currentView(sessionId, display);

    // 只读动作不出图也不改动系统：走各自的报告路径，不进「动作 + 稳定帧」流程。
    if (act === 'wait_until') return waitUntil(params, inp, display, view);
    if (act === 'list_windows') return listWindows(params, inp, display, view);

    // 动作已执行 ⇒ 即便后面截图失败也要如实回报 applied（见 buildActionResult）。
    let typed = null;
    let note = '';
    if (act === 'wait') {
      const raw = Number(params.ms);
      if (!Number.isFinite(raw) || raw <= 0) {
        const e = new Error(`wait 需要 ms（${MIN_WAIT_MS}–${MAX_WAIT_MS}）`);
        e.code = 'INVALID_ACTION';
        e.retryable = false;
        throw e;
      }
      await inp.sleep(Math.min(MAX_WAIT_MS, Math.max(MIN_WAIT_MS, Math.round(raw))));
    } else if (act === 'activate_window') {
      const wanted = Number(params.handle);
      const known = inp.listWindows({ max: WINDOW_LIST_MAX }).find((w) => Number(w.handle) === wanted);
      if (!known) throw unknownWindowError(params.handle);
      await inp.activateWindow(wanted);
      note = `已切到「${known.title}」。`;
    } else {
      const touched = await performInputAction(act, params, inp, view);
      if (touched && Number.isFinite(touched.typed)) typed = touched.typed;
    }

    // 截图失败不代表动作失败：输入已经投递出去了。分开处理，交给 buildActionResult
    // 如实区分「动作生效了」和「这一帧没截到」。
    let frame = null;
    let signature = null;
    let stable = null;
    let shotError = null;
    try {
      const settled = await settleFrames(inp, display);
      frame = settled.frame;
      signature = settled.signature;
      stable = settled.stable;
    } catch (e) {
      shotError = e;
    }

    let shot = null;
    let view2 = null;
    if (frame) {
      try {
        // 模型上次看的是某块放大区域（region）就继续给同一块的新画面：
        // 一串精细动作（点小按钮/看小字）的坐标空间因此保持不变，不用每步重新对全屏坐标。
        const captured = await captureView(display, view, params.visionBudget, frame);
        shot = captured.shot;
        view2 = captured.view;
        signature = captured.signature;
      } catch (e) {
        shotError = e;
        shot = null;
      }
    }

    const changed = view2 ? changedAgainst(remembered, display, view2, signature) : undefined;
    if (view2) rememberView(sessionId, display.index, view2, signature);
    log(
      `COMPUTER_ACTION ${act} display=${display.index}` +
        (shot
          ? ` ${shot.width}x${shot.height}${changed === false ? ' unchanged' : ''}${stable === false ? ' unstable' : ''}`
          : ` shot_failed=${(shotError && shotError.code) || 'CAPTURE_FAILED'}`)
    );
    return buildActionResult(act, display, shot, probe(() => inp.getPhysicalCursorPos(), null), {
      activeWindow: probe(() => inp.foregroundWindowTitle(), ''),
      view: view2 || view,
      typed,
      changed,
      stable,
      note,
      screenshotError: shotError ? String(shotError.message || shotError) : '',
      screenshotErrorCode: shotError ? String(shotError.code || 'CAPTURE_FAILED') : ''
    });
  }

  return {
    action,
    screenshot,
    /** 多显示器清单（模型问「有几块屏」时可用，暂未出 schema）。 */
    listDisplays: capture.listDisplays,
    supported: win32.isSupported()
  };
}

module.exports = { createComputerService };
