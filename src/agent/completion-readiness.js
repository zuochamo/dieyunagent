// @ts-check
'use strict';

/**
 * 单轮「完成验收」的**唯一来源**（Main）。
 *
 * 为什么在 Main：证据全是 Main 的事实 —— Rust 循环账本的 trace（每个工具的名字 + 结构化结果）、
 * 写入后由 Gateway `workspace.diagnostics` 给出的静态诊断、`browser.console/network` 的运行时
 * 证据。这些**都不需要 Renderer 参与**。以前这份判定住在 `src/renderer/agent-guardrails.js`，
 * 是「JS 循环在渲染进程」时代的产物；现在它得用 `summary` 文本正则抠 exit code、还得把
 * 一次诊断采集伪造成一条 trace 轮次才能让证据可见，属于重复实现 + 错误职责。
 *
 * 判定纪律：
 * - 证据只看**结构字段**：工具名（`guardrails-shared` 的工具名归类）、`result.code` 数字退出码、
 *   结果对象的 `ok === false` / `error`、`browser_expect` 的 `failed` 计数、trace 里是否用过
 *   `browser_*`。**不从 summary 文本里抠数字**，也不读 `failed` 标志（那是 Renderer 展示层
 *   映射时才加的字段，Rust 账本 trace 里没有 —— 见 `crates/dieyun-core/src/agent/loop_run.rs`
 *   的 `TraceTool`：只有 name / args / result / error）。
 * - 对技术栈零感知：不按工程类型/文件后缀分支；唯一的技术判断是「退出码是不是 0」。
 * - 验证类按**命令的最后一次结果**判定：先失败后通过=通过（修好了），先通过后失败=失败。
 * - 只出结论与一句话提示，**不自动续跑、不挡交付**（AGENTS.md 循环哲学）。
 * - 采集失败（Gateway 不可用 / LSP 未启用 / 浏览器服务没起）一律降级成「没有这条证据」，
 *   绝不因此拦住交付。
 *
 * 与目标型验收（`src/plans/goal-run.js`）的关系：那是**轮次之间**由调度器跑的「会失败的命令」，
 * 是硬尺子；这里是**单轮之内**「模型自称做完 vs 实际留下证据」的提示门。两者不共用判定，
 * 但同样只认命令/工具的客观结果，不认模型自述。
 *
 * 作用范围只有**对话单轮**（`agent:run` 返回前调一次）。计划模式与定时计划没有这道门：
 * 它们的产出走计划审阅（reviewer）+ worktree 应用，判定点不在「这一轮做完没」。
 */

const shared = require('./guardrails-shared');
const { AGENT_LIMITS_DEFAULTS } = require('./agent-limits');

/**
 * 数字上限的唯一来源是 `agent-limits.js`（AGENTS.md 护栏单一来源）。
 * 这里只读默认值，与 `tool-result-cap.js` 同一做法：验收预算不跟着用户的护栏配置变，
 * 否则「提示会不会出现」会取决于一份跟它无关的设置。
 */
const MAX_DIAG_FILES = AGENT_LIMITS_DEFAULTS.readinessMaxDiagFiles;
const RPC_TIMEOUT_MS = AGENT_LIMITS_DEFAULTS.readinessRpcTimeoutMs;
const BROWSER_EVIDENCE_LIMIT = AGENT_LIMITS_DEFAULTS.readinessBrowserQueryLimit;
const BROWSER_EVIDENCE_TIMEOUT_MS = AGENT_LIMITS_DEFAULTS.readinessBrowserQueryTimeoutMs;
/** 提示里最多引用几条错误样本 */
const MAX_ERROR_SAMPLES = AGENT_LIMITS_DEFAULTS.readinessMaxErrorSamples;
const MAX_ERROR_SAMPLE_CHARS = AGENT_LIMITS_DEFAULTS.readinessErrorSampleChars;

function toolArgs(tool) {
  const a = tool && (tool.toolArgs || tool.args);
  return a && typeof a === 'object' ? a : {};
}

function toolCommand(tool) {
  const a = toolArgs(tool);
  return String(a.command || tool?.command || '').trim();
}

/** 写入类工具落盘的文件路径（trace 里的入参或结果路径） */
function toolFilePath(tool) {
  const a = toolArgs(tool);
  for (const key of ['filePath', 'file_path', 'path', 'file', 'dirPath']) {
    const v = String(a[key] || '').trim();
    if (v) return v;
  }
  const r = toolResult(tool) || {};
  return String(r.path || r.filePath || '').trim();
}

/** 工具结果对象（不是字符串、不是 null） */
function toolResult(tool) {
  const r = tool && tool.result;
  return r && typeof r === 'object' ? r : null;
}

/**
 * `host.exec` 的结构化退出码。
 *
 * 只认结果对象里的数字 `code` —— 这里此前是 `String(summary).match(/\bexit\s+(-?\d+)\b/)`，
 * 而 `host.exec` 早就返回了结构化字段，文本解析纯属冗余且会被输出内容里的 "exit N" 骗到。
 */
function structuredExitCode(tool) {
  const r = toolResult(tool);
  if (!r) return null;
  const raw = r.code !== undefined && r.code !== null ? r.code : r.exitCode;
  const n = typeof raw === 'number' ? raw : Number(raw);
  return Number.isFinite(n) ? n : null;
}

function toolErrorText(tool) {
  const e = tool && tool.error;
  return e && String(e).trim() ? String(e) : '';
}

/** 这一次工具调用算不算失败：传输层 `error` / 结果对象的 `ok === false` 或 `error` / host_exec 非 0 退出码 */
function toolFailed(tool, name) {
  if (toolErrorText(tool)) return true;
  // 已映射成界面条目的 trace 会带上结构化的 failed 标志（`live-loop-trace.mapLoopToolToUi`）；
  // 它本身也是从 result/error 推出来的，跟下面的判断同源，读它比回读 summary 文案可靠。
  if (tool && tool.failed === true) return true;
  const r = toolResult(tool);
  if (r) {
    if (r.ok === false) return true;
    if (toolErrorText({ error: r.error })) return true;
  }
  if (name === 'host_exec') {
    const code = structuredExitCode(tool);
    return code != null && code !== 0;
  }
  return false;
}

/** 这次调用是否可能改动了工作区（工具名归类是单一来源，host_exec 按命令内容细分） */
function isWritingTool(tool, name) {
  if (name === 'host_exec') return shared.hostExecLooksFileWriting(toolCommand(tool));
  return shared.MUTATING_TOOL_NAMES.has(name);
}

/**
 * 名义上是「验证」的工具（按**工具身份**，不看名字里的子串）。
 *
 * `host_exec` 由模型自己在入参里声明 `verify`（见 `hostExecLooksValidation`）；
 * `browser_expect` 不在此列 —— 它的结论单独按 `failed` 计数读（`readExpectation`），
 * 混进来会被判成一条「验证命令」的退出码。
 */
const VALIDATION_TOOL_NAMES = Object.freeze(new Set(['goal_check']));

/** 这次调用是否属于「验证」类（host_exec 看模型声明，其余按工具身份） */
function isValidationTool(tool, name) {
  if (name === 'host_exec') return shared.hostExecLooksValidation(toolArgs(tool));
  return VALIDATION_TOOL_NAMES.has(name);
}

function eachTool(trace, fn) {
  for (const entry of Array.isArray(trace) ? trace : []) {
    const tools = (entry && entry.tools) || [];
    for (const tool of tools) {
      const name = String(tool?.name || '').trim();
      if (!name) continue;
      fn(tool, name);
    }
  }
}

/**
 * 验证命令的身份：`host_exec` 按命令内容分（`npm test` 和 `npm run lint` 是两条腿），
 * 其余工具按工具名。同一身份的多次调用只保留最后一次结果。
 */
function validationKey(tool, name) {
  if (name !== 'host_exec') return name;
  const cmd = toolCommand(tool).replace(/\s+/g, ' ');
  return cmd ? `host_exec:${cmd}` : name;
}

/** 提示里怎么称呼这条验证（host_exec 报命令本身，否则报工具名）。 */
function validationLabel(tool, name) {
  if (name !== 'host_exec') return name;
  return toolCommand(tool).replace(/\s+/g, ' ').slice(0, 120) || name;
}

/**
 * `browser_expect` 的结论。
 *
 * 断言未通过时工具结果是 `{ok:false,total,passed,failed,results}` 且**刻意不带 `error`**
 * （见 `src/browser/expect.js`：不让工具 harness 把「页面没达标」判成「工具执行失败」）。
 * 所以这里只认 `failed` 计数与结果里的 `error`：
 * - `failed > 0` → 没验完，摘要取第一条未通过断言的期望/实际；
 * - 有 `error`（ref 过期 / frame 找不到 / 工具异常）→ 断言根本没跑起来，同样算没验完；
 * - `total === 0`（模型传了空断言）→ 不是失败，只是没有断言可看。
 */
function readExpectation(tool) {
  const r = toolResult(tool);
  const failedRaw = r && r.failed != null ? Number(r.failed) : null;
  const failedCount = Number.isFinite(failedRaw) ? failedRaw : null;
  const execError = String((r && r.error) || toolErrorText(tool) || '').trim();
  if (failedCount != null && failedCount > 0) {
    return { used: true, lastFailed: true, lastSummary: firstFailedAssertion(r, failedCount).slice(0, 160) };
  }
  if (execError) return { used: true, lastFailed: true, lastSummary: execError.slice(0, 160) };
  return { used: true, lastFailed: false, lastSummary: '' };
}

function firstFailedAssertion(r, failedCount) {
  const rows = r && Array.isArray(r.results) ? r.results : [];
  const bad = rows.find((x) => x && x.pass === false);
  if (!bad) return `未通过 ${failedCount} 条断言`;
  const target = String(bad.id || bad.kind || '').trim();
  const expected = bad.expected == null ? '' : `期望 ${String(bad.expected)}`;
  const actual = bad.actual == null ? '' : `实际 ${String(bad.actual)}`;
  return [target, expected, actual].filter(Boolean).join('，');
}

/**
 * 从循环账本的 trace 里收证据（纯函数）。
 *
 * @param {object[]} trace
 * @returns {{
 *   writeTools: string[],
 *   filePaths: string[],
 *   hasWriteSignal: boolean,
 *   failedValidations: Array<{ label: string, exitCode: number|null }>,
 *   passedValidation: number,
 *   browserToolUsed: boolean,
 *   expectation: { used: boolean, lastFailed: boolean, lastSummary: string }
 * }}
 */
function collectEvidence(trace) {
  const filePaths = [];
  const seenPaths = new Set();
  const writeTools = [];
  /** @type {Map<string, { label: string, failed: boolean, exitCode: number|null }>} */
  const validations = new Map();
  let browserToolUsed = false;
  let expectation = { used: false, lastFailed: false, lastSummary: '' };

  eachTool(trace, (tool, name) => {
    const failed = toolFailed(tool, name);
    if (isWritingTool(tool, name)) {
      if (!writeTools.includes(name)) writeTools.push(name);
      // 写失败的文件不进诊断清单：这次它没被改过，里面的既有 error 不是本轮的账
      if (shared.FILE_WRITE_TOOL_NAMES.has(name) && !failed) {
        const p = toolFilePath(tool);
        if (p && !seenPaths.has(p)) {
          seenPaths.add(p);
          filePaths.push(p);
        }
      }
    }
    if (name.startsWith('browser_')) browserToolUsed = true;
    // 同一验证命令只留最后一次结果：修完重跑通过不该被判成没做完，
    // 而「先跑通、后面另一条腿挂了」也不能被前面那次通过压住。
    if (isValidationTool(tool, name)) {
      validations.set(validationKey(tool, name), {
        label: validationLabel(tool, name),
        failed,
        exitCode: structuredExitCode(tool)
      });
    }
    if (name === 'browser_expect') expectation = readExpectation(tool);
  });

  const rows = [...validations.values()];
  return {
    writeTools,
    filePaths,
    hasWriteSignal: writeTools.length > 0,
    failedValidations: rows.filter((r) => r.failed).map((r) => ({ label: r.label, exitCode: r.exitCode })),
    passedValidation: rows.filter((r) => !r.failed).length,
    browserToolUsed,
    expectation
  };
}

function sampleText(text) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_ERROR_SAMPLE_CHARS);
}

function failResult(reason, note, evidence) {
  return { ok: false, skipped: false, reason, note, shouldRetry: false, surfaceToUser: true, evidence };
}

function passResult(evidence, skipped) {
  return {
    ok: true,
    skipped: !!skipped,
    reason: null,
    note: '',
    shouldRetry: false,
    surfaceToUser: false,
    evidence
  };
}

/** 静态诊断的证据摘要（一句话，够在提示里指名） */
function diagnosticsBrief(diagnostics) {
  const d = diagnostics && typeof diagnostics === 'object' ? diagnostics : null;
  if (!d || !d.hasErrors) return '';
  const count = Number(d.errorCount) || 0;
  const sample = Array.isArray(d.samples) && d.samples.length ? String(d.samples[0] || '') : '';
  const parts = [];
  if (count > 0) parts.push(`共 ${count} 处`);
  if (sample) parts.push(`首条：${sample}`);
  return parts.length ? `（${parts.join('，')}）` : '';
}

/**
 * 判定（纯函数）：有没有证据说"这一轮其实没做完"。
 *
 * 顺序即优先级：浏览器运行时错误 → 断言未通过 → 无写入信号（跳过）
 * → 静态诊断 error → 验证失败。
 *
 * @param {ReturnType<typeof collectEvidence>} evidence
 * @param {{ diagnostics?: object|null, browser?: object|null }} [ctx]
 */
function evaluateReadiness(evidence, ctx = {}) {
  const e = evidence || collectEvidence([]);
  const diagnostics = ctx.diagnostics && typeof ctx.diagnostics === 'object' ? ctx.diagnostics : null;
  const browser = ctx.browser && typeof ctx.browser === 'object' ? ctx.browser : null;

  // 纯浏览器任务没有写入信号，运行时错误必须在"无证据即跳过"之前判
  if (browser && Number(browser.errorCount) > 0) {
    const samples = (Array.isArray(browser.errors) ? browser.errors : [])
      .map(sampleText)
      .filter(Boolean)
      .slice(0, MAX_ERROR_SAMPLES);
    const detail = samples.length ? `：${samples.join('；')}` : '';
    return failResult(
      'browser_runtime_errors',
      `浏览器操作后检测到页面运行时错误（console error / 未捕获异常 / 失败请求）${detail}。` +
        '请用 browser_console / browser_network 确认并修复后再交付；若与本任务无关，请明确说明。',
      { diagnostics, browser }
    );
  }

  if (e.expectation && e.expectation.used && e.expectation.lastFailed) {
    const detail = e.expectation.lastSummary ? `：${e.expectation.lastSummary}` : '';
    return failResult(
      'browser_expect_failed',
      `最后一次 browser_expect 断言未通过${detail}。请修复页面状态或修正断言，确认通过后再交付。`,
      { diagnostics, browser }
    );
  }

  if (!e.hasWriteSignal) return passResult({ diagnostics, browser }, true);

  if (diagnostics && diagnostics.hasErrors) {
    return failResult(
      'diagnostic_errors',
      `写入后这些文件仍有 error 级静态诊断${diagnosticsBrief(diagnostics)}（可能是既有问题，不一定是本轮引入的）。` +
        '请确认是否与本次改动相关：相关就继续修，无关也在答复里点明，别让它混进「已完成」。',
      { diagnostics, browser }
    );
  }

  // 静态诊断干净不等于验证通过：诊断只覆盖写过的文件，跑挂的测试/build 不会出现在里面。
  // 因此这里只认「最后一次验证结果」，不再用「有任何通过」去抵消失败。
  if (e.failedValidations.length > 0) {
    const first = e.failedValidations[0];
    const detail =
      first && first.exitCode != null ? `（${first.label} exit ${first.exitCode}）` : first && first.label ? `（${first.label}）` : '';
    return failResult(
      'validation_failed',
      `检测到验证命令失败${detail}。请先修复失败项；如果失败与本任务无关，请明确说明。`,
      { diagnostics, browser }
    );
  }

  return passResult({ diagnostics, browser }, false);
}

/**
 * LSP 设置（`maxPerFile` / `minSeverity` / 是否启用）的唯一来源就是 LSP 服务自己；
 * 这里只读不写，读失败视为"没有诊断能力"。
 */
/**
 * 读 LSP 诊断设置（唯一来源是 `../lsp/diagnostics-service`）。
 *
 * 这里只声明本文件真正读的字段：`enabled` 与 `timeoutMs`（诊断预算）。
 *
 * @param {string} [userDataPath]
 * @returns {{ enabled?: boolean, timeoutMs?: number, maxFiles?: number, maxPerFile?: number, minSeverity?: string } | null}
 */
function loadLspSettingsFor(userDataPath) {
  if (!userDataPath) return { enabled: false, maxPerFile: null };
  try {
    return require('../lsp/diagnostics-service').loadLspSettings(userDataPath);
  } catch {
    return { enabled: false, maxPerFile: null };
  }
}

/**
 * 写入后的静态诊断证据（走 Gateway `workspace.diagnostics`，与问题面板同一条链路）。
 *
 * @returns {Promise<{ hasErrors: boolean, errorCount: number, samples: string[] } | null>}
 */
async function collectDiagnostics(gateway, evidence, opts = {}) {
  if (!gateway || typeof gateway.invokeRpc !== 'function') return null;
  const files = [
    ...new Set(((evidence && evidence.filePaths) || []).map((p) => String(p || '').trim()).filter(Boolean))
  ].slice(0, MAX_DIAG_FILES);
  if (!files.length) return null;

  const lspSettings = loadLspSettingsFor(opts.userDataPath);
  if (!lspSettings || lspSettings.enabled === false) return null;

  const diagBudgetMs = Number(lspSettings.timeoutMs) > 0 ? Number(lspSettings.timeoutMs) : RPC_TIMEOUT_MS;
  /** @type {Record<string, unknown>} */
  const params = {
    files,
    maxFiles: files.length,
    maxPerFile: lspSettings.maxPerFile,
    // 这里只统计 error 级，所以请求也只要 error 级：诊断服务是「先按 severity 过滤、再按
    // maxPerFile 截断」，请求 warning 级会让上限被 warning 占满，排在后面的 error 反而被截掉。
    minSeverity: 'error',
    timeoutMs: diagBudgetMs
  };
  const workspaceRoot = String(opts.workspacePath || '').trim();
  if (workspaceRoot) params.workspaceRoot = workspaceRoot;
  if (opts.sessionId) params.sessionId = String(opts.sessionId);

  let data = null;
  try {
    data = await gateway.invokeRpc('workspace.diagnostics', params, { timeoutMs: RPC_TIMEOUT_MS });
  } catch {
    return null;
  }
  if (!data || data.ok !== true) return null;

  const items = Array.isArray(data.items) ? data.items : [];
  const samples = [];
  let errorCount = 0;
  for (const item of items) {
    const file = String((item && item.file) || '');
    for (const d of (item && Array.isArray(item.diagnostics) ? item.diagnostics : [])) {
      if (!d || d.severity !== 'error') continue;
      errorCount += 1;
      if (samples.length < MAX_ERROR_SAMPLES) {
        const line = Number(d.line) > 0 ? `:${Number(d.line)}` : '';
        samples.push(`${file}${line} ${sampleText(d.message)}`.trim());
      }
    }
  }
  return { hasErrors: errorCount > 0, errorCount, samples };
}

/**
 * 浏览器侧证据：只有 trace 里用过 `browser_*` 才查询。
 *
 * 观察账本（`src/browser/journal-scope.js`）是**按会话**分桶、且只由显式
 * `browser.reset_logs` 清空的 —— 并没有「每轮开始自动 reset」这回事。所以要限定到本轮，
 * 只能用本轮开始时刻切时间窗（`sinceMs`，两个 collector 都支持），否则上一页面/上一轮的
 * console 报错会一直算到后面每一轮头上。
 *
 * console error / 未捕获异常 / 5xx 或请求级失败 → errorCount（触发提示）；
 * 4xx 只作上下文不单独触发（favicon、统计接口等常见噪声）。
 *
 * @returns {Promise<object|null>}
 */
async function collectBrowser(gateway, evidence, opts = {}) {
  if (!evidence || !evidence.browserToolUsed) return null;
  if (!gateway || typeof gateway.invokeRpc !== 'function') return null;

  /** @type {Record<string, unknown>} */
  const scope = {};
  if (opts.sessionId) scope.sessionId = String(opts.sessionId);
  const startedAt = Number(opts.startedAt);
  if (Number.isFinite(startedAt) && startedAt > 0) {
    scope.sinceMs = Math.max(0, Date.now() - startedAt);
  }
  const out = {
    used: true,
    sinceMs: scope.sinceMs != null ? scope.sinceMs : null,
    consoleErrorCount: 0,
    networkErrorCount: 0,
    errorCount: 0,
    errors: [],
    lastAssertion: null,
    assertionSummary: ''
  };

  try {
    const con = await gateway.invokeRpc(
      'browser.console',
      {
        action: 'list',
        errorsOnly: true,
        limit: BROWSER_EVIDENCE_LIMIT,
        ...scope
      },
      { timeoutMs: BROWSER_EVIDENCE_TIMEOUT_MS }
    );
    const rows = con && Array.isArray(con.entries) ? con.entries : [];
    out.consoleErrorCount = rows.length;
    out.errors.push(
      ...rows
        .slice(-5)
        .map((e) => `[${(e && e.source) || 'console'}] ${sampleText(e && e.text)}`.trim())
        .filter(Boolean)
    );
  } catch {
    /* 浏览器服务不可用时忽略 */
  }

  try {
    const net = await gateway.invokeRpc(
      'browser.network',
      {
        action: 'list',
        errorsOnly: true,
        limit: BROWSER_EVIDENCE_LIMIT,
        ...scope
      },
      { timeoutMs: BROWSER_EVIDENCE_TIMEOUT_MS }
    );
    const rows = net && Array.isArray(net.entries) ? net.entries : [];
    // 4xx 只作上下文（favicon、统计接口常见噪声）；`failed`（请求级失败）与 5xx 才算硬错误
    const hard = rows.filter((e) => {
      if (!e) return false;
      if (e.failed) return true;
      const status = Number(e.status);
      return !Number.isFinite(status) || status === 0 || status >= 500;
    });
    out.networkErrorCount = hard.length;
    out.errors.push(
      ...hard
        .slice(-5)
        .map((e) =>
          `${(e && e.method) || 'GET'} ${String((e && e.url) || '').slice(0, 100)} → ${
            (e && (e.status || e.error)) || 'failed'
          }`.slice(0, 160)
        )
    );
  } catch {
    /* ignore */
  }

  out.errorCount = out.consoleErrorCount + out.networkErrorCount;

  const exp = (evidence && evidence.expectation) || null;
  if (exp && exp.used) {
    out.lastAssertion = exp.lastFailed ? 'failed' : 'passed';
    out.assertionSummary = exp.lastSummary || '';
  }
  return out;
}

/**
 * 一轮跑完之后调用一次：收证据 → 判定 → 返回结论（Renderer 只负责渲染 note）。
 *
 * 任何一步失败都不抛：验收是提示，不是交付闸门。
 *
 * @param {{
 *   gateway?: object|null,
 *   trace?: object[],
 *   sessionId?: string|null,
 *   workspacePath?: string|null,
 *   userDataPath?: string|null,
 *   startedAt?: number|null
 * }} opts
 */
async function evaluateTurnReadiness(opts = {}) {
  let evidence;
  try {
    evidence = collectEvidence(opts.trace);
  } catch {
    evidence = collectEvidence([]);
  }

  // 两段证据互不依赖（一个查 LSP、一个查浏览器账本），并行采：
  // 串行会把「最坏 8s + 2×5s」叠在收尾之前，而验收只是提示，不该拖交付。
  const [diagnostics, browser] = await Promise.all([
    collectDiagnostics(opts.gateway, evidence, opts).catch(() => null),
    collectBrowser(opts.gateway, evidence, opts).catch(() => null)
  ]);

  const verdict = evaluateReadiness(evidence, { diagnostics, browser });
  return {
    ...verdict,
    evidence: {
      writeTools: evidence.writeTools,
      filePaths: evidence.filePaths,
      hasWriteSignal: evidence.hasWriteSignal,
      failedValidations: evidence.failedValidations,
      passedValidation: evidence.passedValidation,
      diagnostics,
      browser
    }
  };
}

module.exports = {
  collectEvidence,
  evaluateReadiness,
  evaluateTurnReadiness,
  toolFailed
};
