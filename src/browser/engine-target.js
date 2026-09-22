'use strict';

/**
 * 浏览器引擎契约（唯一来源）。
 *
 * 历史：engine 由 activeEngine / forcePlaywrightUrl / activeViewSessionId 三处全局状态 + URL 字符串
 * 比较决定，决策散在 pickEngine / resolveEngine / resolveAutoInteractionEngine 三处，导致显式 engine
 * 被静默改道、auto 落点漂移。现在只有两条规则：
 *   1. 显式 engine 永远优先；被改道必须 downgraded=true + reason；
 *   2. auto 跟随「当前页面归属引擎」（navigation owner，由 service 按会话记录），不再猜 URL。
 *
 * 结果契约：所有 browser_* 返回值带 target = { engine, requested, explicit, reason, downgraded,
 * backgroundSession, sessionId, instanceId }。结果里的 engine 是「实际执行者」，与 target.engine 不一致即发生降级。
 *
 * instanceId 是「这次调用打到哪个浏览器实例」的稳定标识（唯一来源就是 instanceIdFor）：
 * 换引擎（含运行期改道）或换会话即换实例，同一操作序列（snapshot → click）内保持一致。
 * 调用方不必再靠「引擎名是否变了」猜落点。
 */

const ENGINE_BROWSERVIEW = 'browserview';
const ENGINE_PLAYWRIGHT = 'playwright';
const ENGINE_AUTO = 'auto';

const ENGINES = [ENGINE_BROWSERVIEW, ENGINE_PLAYWRIGHT];

/** 决策依据（target.reason）与运行期改道原因（downgradeReason）的枚举。 */
const REASON = Object.freeze({
  EXPLICIT: 'explicit_request',
  AUTO_OWNER: 'auto_follows_navigation_owner',
  AUTO_DEFAULT: 'auto_default_browserview',
  BACKGROUND_SESSION: 'browserview_singleton_background_session',
  INVALID_REQUEST: 'invalid_engine_request',
  BLANK_CAPTURE: 'browserview_blank_capture',
  CAPTURE_SURFACE: 'browserview_capture_surface_error',
  NAVIGATE_FAILED: 'browserview_navigate_failed',
  CROSS_FRAME: 'cross_frame_iframe',
  PDF_HEADLESS: 'playwright_pdf_headless_only'
});

const REASON_NOTE = Object.freeze({
  [REASON.BACKGROUND_SESSION]: '后台会话不能用 BrowserView（前台会话单例），已改用 Playwright。',
  [REASON.BLANK_CAPTURE]: 'BrowserView 画面全黑且页面无可见内容（确认未渲染），已改用 Playwright 重试。',
  [REASON.CAPTURE_SURFACE]: 'BrowserView 抓取面不可用，已改用 Playwright 重试。',
  [REASON.NAVIGATE_FAILED]: 'BrowserView 导航失败，已改用 Playwright。',
  [REASON.CROSS_FRAME]: '元素在主 frame 未找到且页面存在跨域 iframe，已改用 Playwright（支持跨 frame 定位）。',
  [REASON.PDF_HEADLESS]: 'Playwright 无头模式不支持 PDF，已改用 BrowserView。'
});

/** 工具 schema 里 engine 参数的唯一文案来源（tool-catalog.js 必须引用它）。 */
const ENGINE_PARAM_DESCRIPTION =
  'auto | browserview | playwright。auto（默认）= 跟随当前页面归属引擎，不猜 URL；' +
  '显式指定不会被静默改道，若因后台会话（BrowserView 是前台单例）或依赖缺失而改道，' +
  '返回体会带 downgraded=true、downgradeReason 与处理建议。';

const ENGINE_PARAM_SCHEMA = Object.freeze({ type: 'string', description: ENGINE_PARAM_DESCRIPTION });

function isEngine(value) {
  return ENGINES.includes(value);
}

/**
 * 实例身份唯一来源：同一 (engine, sessionId) 恒等；换引擎或换会话即换实例。
 * 派生而非铸造，因此无需持久状态，也不会因为调用顺序不同而串号。
 *
 * sessionId 必须由调用方按 session-scope.resolveEffectiveSessionId 归一后再传：
 * 显式 sessionId 与「前台 BrowserView 会话」指的是同一个实例，不能一个叫
 * `browserview#s-1790…`、另一个叫 `browserview#default`。
 * `#default` 只在「确实还没绑定任何会话」时出现（那条缺省归属键也与前台缺省账本同义）。
 * @param {string} engine
 * @param {string | null | undefined} sessionId
 * @returns {string} 形如 `playwright#sess-3` / `browserview#default`
 */
function instanceIdFor(engine, sessionId) {
  const sid = sessionId == null ? '' : String(sessionId).trim();
  return `${engine}#${sid || 'default'}`;
}

/** 归一化 engine 请求。未知取值按 auto 处理并留 warning，不再静默沿用上一次的引擎。 */
function normalizeRequested(requested) {
  const raw = requested == null ? '' : String(requested).trim().toLowerCase();
  if (!raw || raw === ENGINE_AUTO) return { requested: ENGINE_AUTO, explicit: false };
  if (raw === ENGINE_BROWSERVIEW || raw === 'embedded' || raw === 'view' || raw === 'browser') {
    return { requested: ENGINE_BROWSERVIEW, explicit: true };
  }
  if (raw === ENGINE_PLAYWRIGHT || raw === 'pw') return { requested: ENGINE_PLAYWRIGHT, explicit: true };
  return {
    requested: ENGINE_AUTO,
    explicit: false,
    warning: `未知 engine 取值 "${raw}"，已按 auto 处理`
  };
}

/**
 * 唯一引擎决策点。
 * @param {{
 *   requested?: string,
 *   sessionId?: string | null,
 *   ownerEngine?: string,
 *   isBackgroundSession?: boolean
 * }} input
 * @returns {{ engine: string, requested: string, explicit: boolean, reason: string,
 *             downgraded: boolean, backgroundSession: boolean, sessionId: string | null, warning?: string }}
 */
function resolveTarget(input = {}) {
  const norm = normalizeRequested(input.requested);
  const sessionId = input.sessionId ? String(input.sessionId) : null;
  const backgroundSession = !!input.isBackgroundSession;
  const owner = isEngine(input.ownerEngine) ? input.ownerEngine : ENGINE_BROWSERVIEW;

  let engine = norm.explicit ? norm.requested : owner;
  let reason = norm.explicit
    ? REASON.EXPLICIT
    : owner === ENGINE_PLAYWRIGHT
      ? REASON.AUTO_OWNER
      : REASON.AUTO_DEFAULT;
  let downgraded = false;

  // BrowserView 是前台会话的单例：后台会话只能用 Playwright。
  if (backgroundSession) {
    if (engine === ENGINE_BROWSERVIEW) {
      engine = ENGINE_PLAYWRIGHT;
      downgraded = norm.explicit;
      reason = REASON.BACKGROUND_SESSION;
    } else if (!norm.explicit) {
      reason = REASON.BACKGROUND_SESSION;
    }
  }

  if (norm.warning) {
    reason = REASON.INVALID_REQUEST;
  }

  const target = {
    engine,
    requested: norm.requested,
    explicit: norm.explicit,
    reason,
    downgraded,
    backgroundSession,
    sessionId,
    instanceId: instanceIdFor(engine, sessionId)
  };
  if (norm.warning) target.warning = norm.warning;
  return target;
}

/** 把决策结果回填到返回值（唯一回填点）。结果自报的 engine 是实际执行者，不覆盖。 */
function applyTarget(result, target) {
  if (!result || typeof result !== 'object') return result;
  const out = { ...result, target };
  if (result.engine == null) out.engine = target.engine;
  if (target.instanceId) out.instanceId = target.instanceId;
  if (target.backgroundSession) out.backgroundSession = true;
  if (target.downgraded) {
    out.downgraded = true;
    out.downgradeReason = target.reason;
    const note = REASON_NOTE[target.reason];
    if (note) out.downgradeNote = note;
  }
  if (target.warning) out.warning = target.warning;
  return out;
}

/**
 * 运行期改道（硬失败兜底 / 空白兜底 / 跨 frame 重试）后同步 target。
 * 实际执行者已换成另一个引擎，必须让模型看见，而不是继续报原引擎。
 */
function retarget(result, target, { engine, reason } = {}) {
  const nextEngine = engine || (result && result.engine) || target.engine;
  const next = {
    ...target,
    engine: nextEngine,
    reason: reason || target.reason,
    downgraded: true,
    // 实际执行者换了，实例身份必须跟着换，否则调用方看到旧 instanceId 会误判落点没变
    instanceId: instanceIdFor(nextEngine, target.sessionId)
  };
  const out = applyTarget(result, next);
  delete out.warning;
  return out;
}

module.exports = {
  ENGINE_BROWSERVIEW,
  ENGINE_PLAYWRIGHT,
  ENGINE_AUTO,
  ENGINES,
  REASON,
  REASON_NOTE,
  ENGINE_PARAM_DESCRIPTION,
  ENGINE_PARAM_SCHEMA,
  isEngine,
  instanceIdFor,
  normalizeRequested,
  resolveTarget,
  applyTarget,
  retarget
};
