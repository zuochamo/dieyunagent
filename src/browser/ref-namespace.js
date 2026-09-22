'use strict';

/**
 * 浏览器元素引用（ref）命名空间 —— 唯一来源。
 *
 * 背景（缺陷 P1-3）：ref 过去是裸计数 `ref-<n>`。两套引擎每次 snapshot 都从 0 重新编号，
 * 而 DOM 上的 `data-dieyun-ref` 只是可被覆盖的普通属性。后果是「上一次 snapshot 拿到的 ref」
 * 可能静默命中「这一次 snapshot 的另一个元素」，或者只报一句笼统的「元素未找到」，
 * 调用方无从判断这个 ref 是否已经过期。
 *
 * 现在 ref 自带 origin 身份：
 *
 *     ref-<seq>@<snapshotId>          例：ref-3@s1
 *
 * · snapshotId 由 Node 侧在每次 snapshot 之前铸造（全进程单调递增、base36），同一次 snapshot
 *   的所有 frame 共用同一个 id（Playwright 逐 frame evaluate 也不会串号）；
 * · 解析 ref 时必须同时校验它仍属于「该会话当前的 snapshot」，否则明确报 REF_EXPIRED，
 *   绝不退化成「悄悄打到另一个元素上」。
 *
 * 本模块同时是 in-page 注入脚本（frame-script / snapshot-script）的格式来源：REF_PATTERN 会被
 * 字符串拼进脚本，保证两端只有一份格式定义。
 */

/** snapshotId 形状：s + base36 计数 */
const SNAPSHOT_ID_PATTERN = 's[0-9a-z]{1,12}';
const REF_PREFIX = 'ref-';
const REF_ORIGIN_SEPARATOR = '@';
/** ref 形状：ref-<seq>@<snapshotId>；seq 限 6 位，避免被塞进超长字符串 */
const REF_PATTERN = `ref-(\\d{1,6})${REF_ORIGIN_SEPARATOR}(${SNAPSHOT_ID_PATTERN})`;

const REF_RE = new RegExp(`^${REF_PATTERN}$`);
const SNAPSHOT_ID_RE = new RegExp(`^${SNAPSHOT_ID_PATTERN}$`);

/** ref 失效原因（错误码是契约，message 只是给人看）。 */
const REF_FAILURE = Object.freeze({
  MALFORMED: 'REF_MALFORMED',
  NO_SNAPSHOT: 'REF_NO_SNAPSHOT',
  EXPIRED: 'REF_EXPIRED'
});

const REF_FAILURE_CODES = Object.freeze([
  REF_FAILURE.MALFORMED,
  REF_FAILURE.NO_SNAPSHOT,
  REF_FAILURE.EXPIRED
]);

/**
 * 该错误码是否属于「ref origin 失效」。
 * 这类失败换引擎重试没有意义——ref 属于某一次 snapshot，换引擎只会命中另一个 DOM 的旧状态，
 * 恰好是这次整改要消灭的「静默打到另一个元素」。
 */
function isRefFailureError(value) {
  const code = typeof value === 'string' ? value : value && value.errorCode;
  return REF_FAILURE_CODES.indexOf(String(code || '')) >= 0;
}

const REF_FORMAT_HINT = `${REF_PREFIX}0${REF_ORIGIN_SEPARATOR}s1`;

let snapshotCounter = 0;

/**
 * 铸造一个新的 snapshot 身份。全进程单调递增，因此跨会话也不会撞号。
 * @returns {string} 形如 `s1` / `s2` … `sa`
 */
function mintSnapshotId() {
  snapshotCounter += 1;
  return `s${snapshotCounter.toString(36)}`;
}

/** 仅测试用：把计数器推到已知位置，让断言可预测。 */
function __resetSnapshotCounter(value = 0) {
  const n = Number(value);
  snapshotCounter = Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/** 只接受合法 snapshotId，其余一律 null（不抛错，调用方自行决定兜底）。 */
function normalizeSnapshotId(raw) {
  const sid = raw == null ? '' : String(raw).trim();
  return SNAPSHOT_ID_RE.test(sid) ? sid : null;
}

/**
 * 组装一个 ref。seq 与 snapshotId 都必须合法——脏输入在这里就暴露，不留给下游。
 * @param {number} seq
 * @param {string} snapshotId
 */
function formatRef(seq, snapshotId) {
  const n = Number(seq);
  if (!Number.isInteger(n) || n < 0) throw new Error(`ref seq 必须是非负整数：${seq}`);
  const sid = normalizeSnapshotId(snapshotId);
  if (!sid) throw new Error(`snapshotId 非法：${snapshotId}`);
  return `${REF_PREFIX}${n}${REF_ORIGIN_SEPARATOR}${sid}`;
}

/**
 * 解析 ref。
 * @param {unknown} raw
 * @returns {{ seq: number, snapshotId: string } | null}
 */
function parseRef(raw) {
  if (raw == null) return null;
  const m = REF_RE.exec(String(raw).trim());
  if (!m) return null;
  return { seq: Number(m[1]), snapshotId: m[2] };
}

function isRef(raw) {
  return !!parseRef(raw);
}

/** 取出 ref 的 origin（snapshot 身份）；非法 ref 返回 null。 */
function refSnapshotId(raw) {
  const parsed = parseRef(raw);
  return parsed ? parsed.snapshotId : null;
}

function refSeq(raw) {
  const parsed = parseRef(raw);
  return parsed ? parsed.seq : null;
}

function malformedFailure(raw) {
  const shown = raw == null ? '' : String(raw);
  return {
    ok: false,
    reason: 'malformed',
    errorCode: REF_FAILURE.MALFORMED,
    ref: shown,
    error: `ref 格式非法："${shown}"；应直接使用 browser_snapshot 返回的 ref（形如 ${REF_FORMAT_HINT}）`
  };
}

/**
 * 校验 ref 是否属于「当前 snapshot」。这是 ref 失效的唯一判定点。
 * @param {unknown} raw 模型传回的 ref
 * @param {string | null | undefined} currentSnapshotId 该会话当前 snapshot 的 id
 * @returns {{ ok: true, seq: number, snapshotId: string }
 *   | { ok: false, reason: 'malformed' | 'no_snapshot' | 'expired', errorCode: string, error: string }}
 */
function checkRefOrigin(raw, currentSnapshotId) {
  const parsed = parseRef(raw);
  if (!parsed) return malformedFailure(raw);
  const current = normalizeSnapshotId(currentSnapshotId);
  if (!current) {
    return {
      ok: false,
      reason: 'no_snapshot',
      errorCode: REF_FAILURE.NO_SNAPSHOT,
      ref: String(raw),
      snapshotId: parsed.snapshotId,
      error: `本会话尚无有效的 snapshot（ref 来自 ${parsed.snapshotId} 已不可用）；请先调用 browser_snapshot 再操作 ref`
    };
  }
  if (parsed.snapshotId !== current) {
    return {
      ok: false,
      reason: 'expired',
      errorCode: REF_FAILURE.EXPIRED,
      ref: String(raw),
      snapshotId: parsed.snapshotId,
      currentSnapshotId: current,
      error: `ref 已失效：它来自 snapshot ${parsed.snapshotId}，当前已是 ${current}；请重新 browser_snapshot 取新 ref，或改用 CSS selector`
    };
  }
  return { ok: true, seq: parsed.seq, snapshotId: parsed.snapshotId };
}

/** ref 失效时给调用方/模型的唯一「下一步」文案。 */
const REF_FAILURE_FIX =
  'ref 属于产生它的那次 snapshot：页面跳转或再次 snapshot 后即失效。请重新 browser_snapshot 取新 ref，或改用 CSS selector。';

/**
 * 「旧 ref 失效时到底会报哪个 code、为什么」的唯一文案来源。
 * 两个 code 的触发条件不同，不写清楚会让人以为文案与实现不一致：
 *   · REF_NO_SNAPSHOT —— 页面已跳转（新文档里没有 snapshot 印章）或本会话还没 snapshot 过；
 *   · REF_EXPIRED     —— 同一文档内又 snapshot 了一次（旧 ref 的 origin 不再是当前 snapshot）。
 * 两套引擎的 snapshot note 都引用这里，避免各自维护一份说法。
 * @param {{ example?: string }} [opts] 示例 ref（Playwright 会用真实 snapshotId 举例）
 * @returns {string}
 */
function refLifecycleNote(opts = {}) {
  const example = opts.example || REF_FORMAT_HINT;
  return (
    `ref 自带 origin 身份（形如 ${example}），只对产生它的那次 snapshot 有效：` +
    '页面跳转后旧 ref 报 REF_NO_SNAPSHOT（新文档里没有 snapshot 印章），' +
    '同一文档内再次 snapshot 后旧 ref 报 REF_EXPIRED（origin 已不是当前 snapshot）；' +
    '两种情况都请重新 browser_snapshot 取新 ref'
  );
}

/**
 * 把「ref 失效」补全成调用方与模型都能直接行动的失败体 —— 这是 ref 失效错误体的唯一组装点。
 * 引擎侧只负责判定「这个 ref 不属于当前 snapshot」，身份/世代/是否导航过由上层喂进来，
 * 因此 BrowserView 与 Playwright 两套引擎不会各写一份诊断。
 *
 * 约定：结构化事实进 diagnostics（失败信封归一化时保留的唯一结构字段）；
 * 给人看的下一条动作进 suggestedFix（渲染层已按此字段展示）。
 * 非 ref 失效错误原样返回。
 *
 * @param {object} result 引擎返回体（含 errorCode / snapshotId / currentSnapshotId）
 * @param {{ engine?: string, instanceId?: string, url?: string,
 *           refEpoch?: number, navigatedSinceSnapshot?: boolean }} [ctx]
 */
function enrichRefFailure(result, ctx = {}) {
  if (!result || typeof result !== 'object') return result;
  if (!isRefFailureError(result)) return result;
  const prevDiagnostics = result.diagnostics || {};
  const url = result.url || prevDiagnostics.url || ctx.url || '';
  // 逐字段回退：ctx 没给的事实不能以 undefined 盖掉引擎/上游已经报上来的同名字段
  const instanceId = ctx.instanceId || result.instanceId || prevDiagnostics.instanceId;
  // 引擎以「谁自报」为准，ctx 只作为兜底；顶层与 diagnostics 用同一个值，避免两处口径不一
  const engine = result.engine || ctx.engine || prevDiagnostics.engine;
  const refEpoch = ctx.refEpoch != null ? ctx.refEpoch : result.refEpoch != null ? result.refEpoch : prevDiagnostics.refEpoch;
  const navigatedSinceSnapshot =
    ctx.navigatedSinceSnapshot != null ? !!ctx.navigatedSinceSnapshot : !!result.navigatedSinceSnapshot;
  const facts = {
    engine,
    instanceId,
    url,
    snapshotId: result.snapshotId || prevDiagnostics.snapshotId,
    currentSnapshotId: result.currentSnapshotId || prevDiagnostics.currentSnapshotId,
    refEpoch,
    navigatedSinceSnapshot
  };
  return {
    ...result,
    engine,
    instanceId,
    url,
    refEpoch,
    navigatedSinceSnapshot,
    // ref 失效不是暂时故障：换引擎或原样重试都只会再打一次同一个旧 ref
    retryable: false,
    suggestedFix: result.suggestedFix || REF_FAILURE_FIX,
    diagnostics: { ...prevDiagnostics, ...facts }
  };
}

/**
 * ref → CSS 选择器。非法 ref 返回 null（由调用方转成明确错误），
 * 避免把脏字符串拼进选择器后得到一句看不懂的语法错误。
 */
function refSelector(raw) {
  const parsed = parseRef(raw);
  if (!parsed) return null;
  return `[data-dieyun-ref="${String(raw).trim().replace(/"/g, '\\"')}"]`;
}

/** 工具 schema 里 ref 参数的唯一文案来源。 */
const REF_PARAM_DESCRIPTION =
  `browser_snapshot 返回的元素引用，形如 ${REF_FORMAT_HINT}（自带 origin 身份）。` +
  '仅对产生它的那次 snapshot 有效；页面跳转或再次 snapshot 后旧 ref 会明确报已失效，需重新 snapshot。';

const REF_PARAM_SCHEMA = Object.freeze({ type: 'string', description: REF_PARAM_DESCRIPTION });

module.exports = {
  SNAPSHOT_ID_PATTERN,
  REF_PREFIX,
  REF_ORIGIN_SEPARATOR,
  REF_PATTERN,
  REF_RE,
  SNAPSHOT_ID_RE,
  REF_FAILURE,
  REF_FAILURE_CODES,
  REF_FAILURE_FIX,
  refLifecycleNote,
  REF_FORMAT_HINT,
  REF_PARAM_DESCRIPTION,
  REF_PARAM_SCHEMA,
  mintSnapshotId,
  __resetSnapshotCounter,
  normalizeSnapshotId,
  formatRef,
  parseRef,
  isRef,
  refSnapshotId,
  refSeq,
  checkRefOrigin,
  refSelector,
  isRefFailureError,
  enrichRefFailure
};
