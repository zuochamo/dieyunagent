'use strict';

/**
 * 一轮结束后的「独立 Reviewer」验收：**判据与提示词的唯一来源**（Main 层）。
 *
 * 为什么在这里而不是 Renderer：Reviewer 的结论是**交付状态的一部分**（不通过 → 气泡终态
 * 与托盘文案都变），属于「完成验收」这条判定链，与 `completion-readiness.js` 同源。
 * 之前这套 prompt / payload / 判据长在 `src/renderer/renderer-agent-reviewer.js` 里，
 * 于是「一轮做完了没」有两个判定出处 —— Renderer 判一次、Main 再判一次，谁生效看调用顺序。
 *
 * 分层（**请求也已经在 Main**）：
 * - 本模块只有**纯函数**：提示词 / 输入装配 / 结论整形 / 与证据判定的合并；
 * - 请求、超时与退避在 `turn-reviewer-run.js`（Main，读 `model-settings.json`）；
 * - Renderer 侧已无 Reviewer 代码：它只渲染 `readiness.note`。
 *
 * 配置来源：`model-settings.json` 的 `reviewerEnabled` / `reviewerModel` /
 * `reviewerBaseUrl` / `reviewerApiKey`（设置页保存时随整份 settings 镜像进 Main）。
 *
 * 硬约束（与「验收只提示、不挡交付」一致）：
 *   1. **任何一步失败都跳过验收**（ok:true + skipped），绝不因为验收把交付搞挂；
 *   2. **结论只压给渲染层一句 note**（`completion-readiness` 的同一形状），Renderer 不判；
 *   3. **没有文件 diff 就不跑**：没有 diff 的 Review 只会让模型凭聊天记录想象，反而更不可靠。
 */

/** Reviewer 单次调用的总时长上限：超时即跳过验收，不拖住收尾。 */
const REVIEWER_TIMEOUT_MS = 60000;
/** 送进 Reviewer 的证据上限：diff 文件数与每段字符数（再多就是让模型读整个仓库）。 */
const REVIEWER_MAX_FILES = 12;
const REVIEWER_MAX_SNIPPET_CHARS = 3500;

/** 主判定提示词（模型看到的那一份）。改口径只改这里。 */
const REVIEWER_SYSTEM_PROMPT =
  '你是叠云 Agent 的独立 Reviewer。根据用户目标和文件 diff 判断是否满足目标，不要依据聊天过程或模型自称完成。只输出一个合法 JSON 对象，不要 Markdown。格式固定为：{"accepted":true,"acceptancePlan":["验收项"],"reason":"一句话原因","missing":[],"nextAction":""}。若未通过，accepted=false，并填写 missing 与 nextAction。不要要求不必要的额外工作；diff 已覆盖用户目标则 accepted=true。' +
  '额外：若 browser 证据显示页面运行时错误（consoleErrors / networkFailures 大于 0）或最后一次断言失败（lastAssertion="failed"），且与本次改动相关，则不应 accepted=true，需在 missing 与 nextAction 中说明；若证据为空或明显与本任务无关，则不因此扣分。';

/** 修复提示词：模型没给出合法 JSON 时，只让它改写，不重新判断。 */
const REVIEWER_REPAIR_SYSTEM_PROMPT =
  '你只负责把输入改写成合法 JSON 对象。只输出 JSON，不要 Markdown。字段固定为：{"accepted":boolean,"acceptancePlan":string[],"reason":string,"missing":string[],"nextAction":string}。如果原文无法判断是否通过，则 accepted=true，reason 写“Reviewer 格式修复无法可靠判断，跳过验收”。';

/** 与 Renderer 的 `compactPlainText` 同语义的本地实现（本模块要能被 bundle 独立打包）。 */
function compact(text, max) {
  return String(text == null ? '' : text)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, Math.max(1, Number(max) || 360));
}

/**
 * 从设置对象里取 Reviewer 配置。
 *
 * 缺 model 或缺 baseUrl 就当「没配」—— 半套配置发出去只会得到 401，
 * 而用户会以为是验收逻辑坏了。
 *
 * @param {any} settings Renderer settings 同构对象
 * @returns {{enabled: boolean, model: string, apiConfig: {baseUrl: string, apiKey: string}} | null}
 */
function resolveReviewerConfig(settings) {
  const s = settings && typeof settings === 'object' ? settings : {};
  const model = String(s.reviewerModel || '').trim();
  const baseUrl = String(s.reviewerBaseUrl || '').trim();
  if (!model || !baseUrl) return null;
  return {
    enabled: s.reviewerEnabled === true,
    model,
    apiConfig: { baseUrl, apiKey: String(s.reviewerApiKey || '').trim() }
  };
}

/**
 * 这次要不要跑 Reviewer。
 * @param {{settings?: any, files?: any[]}} input
 */
function shouldRunReviewer(input = {}) {
  const cfg = resolveReviewerConfig(input.settings);
  if (!cfg || !cfg.enabled) return false;
  // 没有 diff 就别跑：让模型凭聊天记录想象「改没改对」，比不验收更糟。
  return Array.isArray(input.files) && input.files.length > 0;
}

/** 浏览器证据：只留计数与样本（Main 的 `completion-readiness` 采，这里只改名）。 */
function buildReviewerBrowserEvidence(browser) {
  const src = browser && typeof browser === 'object' ? browser : null;
  if (!src) return null;
  const out = {
    consoleErrors: Number(src.consoleErrorCount) || 0,
    networkFailures: Number(src.networkErrorCount) || 0
  };
  if (Array.isArray(src.errors) && src.errors.length) {
    out.errorSamples = src.errors.slice(0, 3).map((e) => compact(String(e || ''), 160));
  }
  if (src.lastAssertion) {
    out.lastAssertion = String(src.lastAssertion);
    if (src.assertionSummary) out.assertionSummary = compact(String(src.assertionSummary), 160);
  }
  return out;
}

/**
 * Reviewer 的输入装配（模型看到的那一坨）。
 *
 * @param {{
 *   userTask?: string, files?: any[], diagnostics?: any, planSummary?: string, browser?: any
 * }} facts
 */
function buildReviewerPayload(facts = {}) {
  const diagnostics = facts.diagnostics && typeof facts.diagnostics === 'object' ? facts.diagnostics : null;
  const diagnosticsText = diagnostics
    ? String(
        diagnostics.text ||
          (Array.isArray(diagnostics.samples) && diagnostics.samples.length
            ? `error ${Number(diagnostics.errorCount) || diagnostics.samples.length} 处：${diagnostics.samples.join('；')}`
            : '')
      )
    : '';
  return {
    userTask: compact(facts.userTask || '', 1800),
    files: Array.isArray(facts.files) ? facts.files : [],
    diagnostics: diagnostics
      ? { hasErrors: !!diagnostics.hasErrors, text: compact(diagnosticsText, 800) }
      : null,
    planSummary: compact(facts.planSummary || '', 600),
    browser: buildReviewerBrowserEvidence(facts.browser)
  };
}

/** 一次 Review 的 messages（主判定）。 */
function buildReviewerMessages(payload) {
  return [
    { role: 'system', content: REVIEWER_SYSTEM_PROMPT },
    { role: 'user', content: `请审查以下变更是否满足用户目标：\n\n${JSON.stringify(payload, null, 2)}` }
  ];
}

/** 修复一次（主判定没给出合法 JSON 时）。 */
function buildRepairMessages(rawText) {
  return [
    { role: 'system', content: REVIEWER_REPAIR_SYSTEM_PROMPT },
    { role: 'user', content: compact(rawText || '', 2400) }
  ];
}

/**
 * 把 Reviewer 的解析结果整形成**与 `evaluateTurnReadiness` 同形状**的结论。
 *
 * 这是「验收只有一处判定」的落点：Reviewer 不通过 → `ok:false` + 一句 note；
 * 通过 → `ok:true`（把原判附带回去，便于 trace/日志看到是谁过的）。
 *
 * @param {any} parsed Reviewer 的 JSON（`extractReviewerJson` 的产物）
 */
function judgeReviewerOutcome(parsed) {
  if (!parsed || typeof parsed !== 'object') {
    return { ok: true, skipped: true, reason: 'reviewer_no_json' };
  }
  if (parsed.accepted === true) {
    return { ok: true, accepted: true, reason: 'reviewer_accepted', reviewer: parsed };
  }
  const missing = Array.isArray(parsed.missing) ? parsed.missing.filter(Boolean) : [];
  const reason = compact(parsed.reason || parsed.note || 'Reviewer 判定目标尚未可靠完成。', 500);
  const nextAction = compact(parsed.nextAction || '', 500);
  const note =
    'Reviewer 目标验收未通过：' +
    reason +
    (missing.length ? `\n缺失项：${missing.join('；')}` : '') +
    (nextAction ? `\n下一步：${nextAction}` : '');
  return {
    ok: false,
    shouldRetry: false,
    surfaceToUser: true,
    reason: 'reviewer_validation_failed',
    note,
    reviewer: parsed
  };
}

/**
 * 合并「证据判定」与「Reviewer 判定」：**唯一合并规则**。
 *
 * - Reviewer 没跑 / 跳过 / 通过 → 原判不动（验收是补充，不是否决权）；
 * - Reviewer 明确不通过 → 它压过证据判定（证据说「改了并有验证」不等于「改对了」）；
 * - 原判已经是「不通过」时保留原判，只把 Reviewer 的 note 追加进去（两种原因都要让人看见）。
 *
 * @param {any} readiness `evaluateTurnReadiness` 的结论
 * @param {any} reviewerVerdict `judgeReviewerOutcome` 的结论
 */
function mergeReviewerIntoReadiness(readiness, reviewerVerdict) {
  const base = readiness && typeof readiness === 'object' ? readiness : { ok: true };
  const rev = reviewerVerdict && typeof reviewerVerdict === 'object' ? reviewerVerdict : null;
  if (!rev || rev.skipped || rev.ok !== false) return base;
  if (base.ok === false) {
    const notes = [base.note, rev.note].filter(Boolean);
    return {
      ...base,
      note: notes.join('\n'),
      // 两条原因都要留住：`reasons` 是本轮所有不通过理由的集合（首条 = 主判）
      reasons: [...new Set([...(Array.isArray(base.reasons) ? base.reasons : []), base.reason, rev.reason].filter(Boolean))],
      reviewer: rev.reviewer || null
    };
  }
  return {
    ...rev,
    evidence: base.evidence || null,
    reasons: [rev.reason].filter(Boolean)
  };
}

module.exports = {
  REVIEWER_TIMEOUT_MS,
  REVIEWER_MAX_FILES,
  REVIEWER_MAX_SNIPPET_CHARS,
  REVIEWER_SYSTEM_PROMPT,
  REVIEWER_REPAIR_SYSTEM_PROMPT,
  resolveReviewerConfig,
  shouldRunReviewer,

  buildReviewerPayload,
  buildReviewerMessages,
  buildRepairMessages,
  judgeReviewerOutcome,
  mergeReviewerIntoReadiness
};
