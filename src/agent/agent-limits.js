'use strict';
// @ts-check

/**
 * Node-only 依赖入口：浏览器 / 裸脚本下为抛错桩，避免 esbuild 静态解析 fs / path / electron。
 * 所有调用点都位于 Node 专用路径（磁盘 I/O、model-settings 读取），renderer 侧不会触达。
 */
const nodeRequire =
  typeof require === 'function'
    ? require
    : function () {
        throw new Error('node-only dependency');
      };

// 纯 CJS 依赖：顶层 require 真源，替代原先「全局 → 运行期 require → 硬编码副本」三层兜底。
const {
  MODEL_RUNTIME_PRESETS,
  remapLegacyContextTierId,
  foldLegacyContextTierRecord
} = require('./model-runtime-presets');
const { isValidContextTierId, getEditingContextTierId } = require('./model-runtime-by-tier');

/** @typedef {{ key: string, label: string, hint?: string, type: 'number'|'boolean', min?: number, max?: number, step?: number, unit?: string, format?: 'int'|'ms'|'min'|'mb'|'ratio' }} AgentLimitSchemaItem */
/** @typedef {{ group: string, groupId: string, items: AgentLimitSchemaItem[] }} AgentLimitSchemaGroup */

const AGENT_LIMITS_DEFAULTS = {
  repeatToolStreakLimit: 9,
  repeatHistoryMax: 96,
  completionRepairAttempts: 6,
  verifyDiagMaxChars: 18000,
  transientMaxRetries: 3,
  retryBaseMs: 400,
  liveWriteDebounceMs: 120,
  artifactsUiFlushMs: 80,
  lspSyncDebounceMs: 500,
  monacoMaxChars: 200000,
  ctxAgentToolCallLimit: 150,
  toolResultMaxJson: 14000,
  writeSmellHintMaxItems: 3,
  writeSmellHintMaxChars: 480,
  writeSmellScanTimeoutMs: 1500,
  codebaseSnippetMax: 2400,
  codebaseAutoLimit: 12,
  openFilesMax: 12,
  filePreviewMaxChars: 4000,
  fsReadDefaultMaxBytes: 65536,
  // LSP 诊断只在这里限「注入字符数」；文件数与超时的唯一来源是 lsp-settings
  // （src/lsp/diagnostics-service.js 的 LSP_SETTINGS_DEFAULTS / lsp-settings.json）。
  lspDiagMaxChars: 10000,
  streamRoundMaxAttempts: 3,
  llmRetryBaseMs: 800,
  llmReconnectMaxWaitMs: 30 * 60 * 1000,
  llmFirstTokenTimeoutMs: 180000,
  // 流式「包间隔」容忍时长：开始出字后，静默超过该时长即 ETIMEDOUT idle 并交给重连层。
  // 与首包超时同属看门狗（同值 180s），且都只认有效 SSE data 行（keep-alive 空包不续命）。
  // 取 180s 是「不误杀」优先：一旦开始出字，正常包间隔是亚秒~几秒级，这里有几十倍余量；
  // 若上游确实是断流，最多也让用户等 3 分钟而不是原来的 10 分钟。
  llmStreamIdleTimeoutMs: 180000,
  synthesisTimeoutMs: 25000,
  synthesisReconnectMaxWaitMs: 8000,
  maxUndoSteps: 5,
  editorSelectionMax: 2400,
  editorVisibleLines: 40,
  maxDiffChars: 12000,
  diffFullTextCap: 120000,
  chatImagePreviewMaxMb: 15,
  // 视觉输入注入（浏览器截图 / 附件补看）：按来源分别限流。
  // 额度是「每轮在途」——缓冲在注入后即清空，因此每个 LLM 轮次都会重新给一份。
  visionShotsPerRound: 2,
  visionReattachPerRound: 2,
  visionMaxBase64Chars: 4 * 1024 * 1024,
  // 图片 part 计入上下文预算时的等效字符数。图片在请求里会换算成图片 token，
  // 不能按 base64 长度计；否则单张图就顶穿 chat 预算并触发无意义的压缩。
  // 注意：这是「账本折算系数」而非策略上限，故意不出现在设置页——
  // contentCharLen 没有 tier 上下文，只读全局默认值，做成可调项会「改了不生效」。
  visionPartEqChars: 6000,
  // 字符→token 折算系数（上下文账本 / 用量估算用）。与 visionPartEqChars 同为「折算系数」
  // 而非策略上限，故意不上设置页。Rust 侧同值见
  // crates/dieyun-core/src/compaction/tokens.rs::estimate_text_tokens。
  // renderer 侧经 agent-bundle-entry.js 的 compat 挂到 window.CHARS_PER_TOKEN /
  // window.CJK_CHARS_PER_TOKEN 后直接消费（这两个键不在 module.exports 中）。
  charsPerToken: 3.2,
  cjkCharsPerToken: 1.5,
  // 附件图片保留：超过容量后从最旧的图片开始原地降采样（不改名、不删除，历史引用不悬空）
  attachmentRetentionMaxMb: 500,
  attachmentDownsampleMaxPx: 1600,
  attachmentDownsampleMinKb: 120,
  completionHistoryMaxChars: 96000,
  completionMessageMaxChars: 8000,
  completionLastUserMaxChars: 24000,
  completionTurnRideMaxChars: 32000,
  completionRecentTurns: 24,
  completionFoldedMaxChars: 12000,
  userSystemMaxChars: 8000,
  systemStableMaxChars: 16000,
  llmRequestMaxChars: 800000,
  taskTierEnabled: true
};

/** Long-horizon run: multiply these guardrails (still hard-capped; not disabled). */
const LONG_HORIZON_GUARDRAIL_SCALE = Object.freeze({
  repeatToolStreakLimit: 2,
  repeatHistoryMax: 2,
  ctxAgentToolCallLimit: 2,
  completionRepairAttempts: 2,
  agentMaxRounds: 2
});

const LONG_HORIZON_HARD_CAP = Object.freeze({
  repeatToolStreakLimit: 36,
  repeatHistoryMax: 384,
  ctxAgentToolCallLimit: 600,
  completionRepairAttempts: 20,
  agentMaxRounds: 600
});

/**
 * @param {string} key
 * @param {unknown} value
 * @param {boolean} [longHorizon]
 * @returns {number}
 */
function scaleLimitForLongHorizon(key, value, longHorizon) {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return n;
  if (!longHorizon) return n;
  const mul = LONG_HORIZON_GUARDRAIL_SCALE[key];
  if (mul == null) return n;
  const scaled = Math.max(1, n * mul);
  const cap = LONG_HORIZON_HARD_CAP[key];
  return cap != null ? Math.min(cap, scaled) : scaled;
}

/**
 * @param {Record<string, unknown>} limits
 * @param {boolean} [longHorizon]
 */
function applyLongHorizonGuardrails(limits, longHorizon) {
  if (!longHorizon || !limits || typeof limits !== 'object') return limits;
  const out = { ...limits };
  for (const key of Object.keys(LONG_HORIZON_GUARDRAIL_SCALE)) {
    if (out[key] == null) continue;
    out[key] = scaleLimitForLongHorizon(key, out[key], true);
  }
  return out;
}

/** @type {AgentLimitSchemaGroup[]} */
const AGENT_LIMITS_SCHEMA = [
  {
    group: '工具护栏',
    groupId: 'guardrails',
    items: [
      {
        key: 'repeatToolStreakLimit',
        label: '重复工具止损',
        hint: '连续完全相同的工具+参数才止损；读不同偏移或换搜索词不计入',
        type: 'number',
        min: 6,
        max: 18,
        step: 1,
        unit: '次'
      },
      {
        key: 'repeatHistoryMax',
        label: '指纹历史长度',
        type: 'number',
        min: 48,
        max: 192,
        step: 1,
        unit: '条'
      },
      {
        key: 'writeSmellHintMaxItems',
        label: '写入坏味道提示条数',
        hint: '文件写成功后附加的结构性提示条数上限；0 = 关闭。只提示，不阻断交付',
        type: 'number',
        min: 0,
        max: 10,
        step: 1,
        unit: '条'
      },
      {
        key: 'writeSmellHintMaxChars',
        label: '写入坏味道提示字符上限',
        hint: '单次工具结果里结构性提示的总字符上限',
        type: 'number',
        min: 0,
        max: 2000,
        step: 40,
        unit: '字'
      },
      {
        key: 'writeSmellScanTimeoutMs',
        label: '坏味道目录查询超时',
        hint: '查同目录同胞文件的最长等待；超时即降级为只看得见本轮，不阻塞工具结果',
        type: 'number',
        min: 200,
        max: 10000,
        step: 100,
        format: 'ms',
        unit: 'ms'
      },
      {
        key: 'completionRepairAttempts',
        label: '完成验收修复轮次',
        type: 'number',
        min: 0,
        max: 15,
        step: 1,
        unit: '次'
      },
      {
        key: 'verifyDiagMaxChars',
        label: '改后校验诊断上限',
        type: 'number',
        min: 6000,
        max: 36000,
        step: 200,
        unit: '字'
      },
      {
        key: 'taskTierEnabled',
        label: '发送前任务分级',
        hint: '用结构信号（路径/选区/@Codebase）推断规模并跳过多余自动检索；不另打分级 LLM，不据此强迫写入',
        type: 'boolean'
      }
    ]
  },
  {
    group: '工具 Harness',
    groupId: 'harness',
    items: [
      {
        key: 'transientMaxRetries',
        label: '瞬态错误重试',
        type: 'number',
        min: 0,
        max: 9,
        step: 1,
        unit: '次'
      },
      {
        key: 'retryBaseMs',
        label: '重试基础间隔',
        type: 'number',
        min: 100,
        max: 2000,
        step: 50,
        format: 'ms',
        unit: 'ms'
      }
    ]
  },
  {
    group: 'UI 联动',
    groupId: 'ui-link',
    items: [
      {
        key: 'liveWriteDebounceMs',
        label: '写入联动防抖',
        type: 'number',
        min: 50,
        max: 500,
        step: 10,
        format: 'ms',
        unit: 'ms'
      },
      {
        key: 'artifactsUiFlushMs',
        label: '产物区刷新防抖',
        type: 'number',
        min: 40,
        max: 300,
        step: 10,
        format: 'ms',
        unit: 'ms'
      },
      {
        key: 'lspSyncDebounceMs',
        label: 'LSP 同步防抖',
        type: 'number',
        min: 100,
        max: 2000,
        step: 50,
        format: 'ms',
        unit: 'ms'
      },
      {
        key: 'monacoMaxChars',
        label: 'Monaco 最大字符',
        type: 'number',
        min: 50000,
        max: 400000,
        step: 10000,
        unit: '字'
      }
    ]
  },
  {
    group: '上下文注入',
    groupId: 'context',
    items: [
      {
        key: 'ctxAgentToolCallLimit',
        label: '上下文工具段上限',
        hint: '与「编码参数 → 模型与段预算 → 工具调用段上限」取较大值生效',
        type: 'number',
        min: 30,
        max: 600,
        step: 1,
        unit: '次'
      },
      {
        key: 'toolResultMaxJson',
        label: '工具结果 JSON 上限',
        hint: '写入循环 messages 前截断；UI 仍可见完整结果',
        type: 'number',
        min: 4000,
        max: 30000,
        step: 500,
        unit: '字'
      },
      {
        key: 'codebaseSnippetMax',
        label: '代码片段字符上限',
        type: 'number',
        min: 400,
        max: 3000,
        step: 100,
        unit: '字'
      },
      {
        key: 'codebaseAutoLimit',
        label: '自动检索条数',
        type: 'number',
        min: 2,
        max: 24,
        step: 1,
        unit: '条'
      },
      {
        key: 'openFilesMax',
        label: '打开文件注入上限',
        type: 'number',
        min: 4,
        max: 24,
        step: 1,
        unit: '个'
      },
      {
        key: 'filePreviewMaxChars',
        label: '文件预览字符上限',
        type: 'number',
        min: 1000,
        max: 12000,
        step: 200,
        unit: '字'
      },
      {
        key: 'fsReadDefaultMaxBytes',
        label: 'Agent 读文件默认字节',
        hint: '省略 maxBytes 时的块大小；索引/UI 读文件仍可用更大上限',
        type: 'number',
        min: 8192,
        max: 2097152,
        step: 8192,
        unit: 'B'
      },
      {
        key: 'completionHistoryMaxChars',
        label: '近期原文历史字符上限',
        hint: '近 N 条原文 + 折叠条合计；更早轮次不再整段进 messages',
        type: 'number',
        min: 16000,
        max: 200000,
        step: 4000,
        unit: '字'
      },
      {
        key: 'completionRecentTurns',
        label: '近轮原文条数',
        hint: '仅计当前任务用户及更早的书本消息；本轮工具链不计入、也不被折叠',
        type: 'number',
        min: 4,
        max: 48,
        step: 1,
        unit: '条'
      },
      {
        key: 'completionFoldedMaxChars',
        label: '较早对话折叠上限',
        type: 'number',
        min: 2000,
        max: 32000,
        step: 500,
        unit: '字'
      },
      {
        key: 'completionMessageMaxChars',
        label: '单条历史消息上限',
        type: 'number',
        min: 2000,
        max: 24000,
        step: 500,
        unit: '字'
      },
      {
        key: 'completionLastUserMaxChars',
        label: '本轮用户文本上限',
        type: 'number',
        min: 4000,
        max: 80000,
        step: 2000,
        unit: '字'
      },
      {
        key: 'completionTurnRideMaxChars',
        label: '本轮 Turn-ride 上限',
        hint: '开文件/代码库等临时上下文；与本轮用户问题分开截断，避免砍掉当前任务',
        type: 'number',
        min: 8000,
        max: 80000,
        step: 2000,
        unit: '字'
      },
      {
        key: 'userSystemMaxChars',
        label: '用户系统提示上限',
        hint: '设置里的自定义 system；不进 turn-ride',
        type: 'number',
        min: 1000,
        max: 24000,
        step: 500,
        unit: '字'
      },
      {
        key: 'systemStableMaxChars',
        label: '稳定 system 总帽',
        hint: '准则/用户 system/MCP 目录等合计，不含 turn-ride',
        type: 'number',
        min: 4000,
        max: 48000,
        step: 1000,
        unit: '字'
      },
      {
        key: 'llmRequestMaxChars',
        label: '单次 LLM 请求字符硬顶',
        hint: 'messages 合计上限，须低于中转 Input length（约 1,048,566）',
        type: 'number',
        min: 200000,
        max: 1040000,
        step: 20000,
        unit: '字'
      },
      {
        key: 'lspDiagMaxChars',
        label: 'LSP 诊断字符上限',
        type: 'number',
        min: 2000,
        max: 20000,
        step: 500,
        unit: '字'
      },
      {
        key: 'visionShotsPerRound',
        label: '浏览器截图注入张数',
        hint: '每个 LLM 轮次最多在途几张浏览器截图；仅多模态模型生效，注入后即清空、下一轮重新计',
        type: 'number',
        min: 0,
        max: 6,
        step: 1,
        unit: '张'
      },
      {
        key: 'visionReattachPerRound',
        label: '附件补看张数',
        hint: '每个 LLM 轮次最多在途几张历史附件（模型用 fs_read_file 设 encoding=base64 触发）；注入后即清空、下一轮重新计',
        type: 'number',
        min: 0,
        max: 6,
        step: 1,
        unit: '张'
      },
      {
        key: 'visionMaxBase64Chars',
        label: '单张图片 base64 上限',
        hint: '超过即不注入，避免单次请求顶爆',
        type: 'number',
        min: 262144,
        max: 8388608,
        step: 262144,
        unit: '字'
      }
    ]
  },
  {
    group: 'LLM 重试',
    groupId: 'llm',
    items: [
      {
        key: 'streamRoundMaxAttempts',
        label: '流式轮次重试',
        hint: '仅在「模型重连总时长上限」为 0 时生效：单次采样遇到瞬时断线时的重试次数（不含首次请求）',
        type: 'number',
        min: 1,
        max: 5,
        step: 1,
        unit: '次'
      },
      {
        key: 'llmReconnectMaxWaitMs',
        label: '模型重连总时长上限',
        hint: '瞬时断线持续自动重连的最长等待（显示为分钟，实际按毫秒存储），期间次数不限（不会要你手动点继续）；设为 0 则退回「流式轮次重试」次数模式',
        type: 'number',
        min: 0,
        max: 60 * 60 * 1000,
        step: 60000,
        format: 'min'
      },
      {
        key: 'llmRetryBaseMs',
        label: 'LLM 重试基础间隔',
        hint: '瞬时错误退避：base × 2^(n-1)，单次等待不超过 60s；不再整轮连等十几分钟',
        type: 'number',
        min: 200,
        max: 3000,
        step: 100,
        format: 'ms',
        unit: 'ms'
      },
      {
        key: 'llmFirstTokenTimeoutMs',
        label: '流式首包超时',
        hint: 'headers 后无有效 SSE data 则超时重试；可用环境变量 LLM_FIRST_TOKEN_TIMEOUT_MS 覆盖进程默认',
        type: 'number',
        min: 30000,
        max: 600000,
        step: 10000,
        format: 'ms',
        unit: 'ms'
      },
      {
        key: 'llmStreamIdleTimeoutMs',
        label: '流式包间隔超时',
        hint: '开始出字后，相邻两包之间超过该时长无有效 SSE data 即判定上游断流并自动重连（keep-alive 空包不算）；调小可更快发现断流',
        type: 'number',
        min: 30000,
        max: 600000,
        step: 10000,
        format: 'ms',
        unit: 'ms'
      },
      {
        key: 'synthesisTimeoutMs',
        label: '最终汇总超时',
        hint: '工具轮结束后补一轮用户向总结的最长等待；超时用已流出文本或思考区兜底，避免气泡停在「生成回答中」',
        type: 'number',
        min: 5000,
        max: 120000,
        step: 1000,
        format: 'ms',
        unit: 'ms'
      },
      {
        key: 'synthesisReconnectMaxWaitMs',
        label: '最终汇总重连上限',
        hint: '汇总轮遇到瞬时断线时的重连等待，短于普通对话重连',
        type: 'number',
        min: 1000,
        max: 60000,
        step: 1000,
        format: 'ms',
        unit: 'ms'
      }
    ]
  },
  {
    group: '编辑器与 Diff',
    groupId: 'editor',
    items: [
      {
        key: 'editorSelectionMax',
        label: '选区注入字符上限',
        type: 'number',
        min: 500,
        max: 5000,
        step: 100,
        unit: '字'
      },
      {
        key: 'editorVisibleLines',
        label: '可见行上下文',
        type: 'number',
        min: 10,
        max: 80,
        step: 5,
        unit: '行'
      },
      {
        key: 'maxDiffChars',
        label: 'Diff 上下文上限',
        type: 'number',
        min: 4000,
        max: 30000,
        step: 500,
        unit: '字'
      },
      {
        key: 'diffFullTextCap',
        label: 'Diff 全文上限',
        type: 'number',
        min: 40000,
        max: 200000,
        step: 5000,
        unit: '字'
      },
      {
        key: 'maxUndoSteps',
        label: '撤回步数上限',
        type: 'number',
        min: 1,
        max: 10,
        step: 1,
        unit: '步'
      },
      {
        key: 'chatImagePreviewMaxMb',
        label: '聊天图片预览上限',
        type: 'number',
        min: 5,
        max: 50,
        step: 1,
        format: 'mb',
        unit: 'MB'
      },
      {
        key: 'attachmentRetentionMaxMb',
        label: '附件图片总量上限',
        hint: '超过后从最旧的图片开始原地降采样（不改名、不删除，历史引用仍然有效）',
        type: 'number',
        min: 50,
        max: 5000,
        step: 50,
        format: 'mb',
        unit: 'MB'
      },
      {
        key: 'attachmentDownsampleMaxPx',
        label: '附件降采样最长边',
        hint: '降采样时按最长边等比缩到该像素',
        type: 'number',
        min: 640,
        max: 4096,
        step: 80,
        unit: 'px'
      },
      {
        key: 'attachmentDownsampleMinKb',
        label: '附件降采样最小体积',
        hint: '小于该体积的图片不再降采样，避免反复重编码',
        type: 'number',
        min: 20,
        max: 1024,
        step: 20,
        unit: 'KB'
      }
    ]
  }
];

const SCHEMA_BY_KEY = new Map();
for (const group of AGENT_LIMITS_SCHEMA) {
  for (const item of group.items) {
    SCHEMA_BY_KEY.set(item.key, item);
  }
}

function clampSchemaValue(item, value) {
  const def = AGENT_LIMITS_DEFAULTS[item.key];
  if (item.type === 'boolean') return !!value;
  const v = Number(value);
  if (!Number.isFinite(v)) return def;
  const min = item.min != null ? item.min : def;
  const max = item.max != null ? item.max : def;
  const step = item.step != null ? item.step : 1;
  let n = Math.min(max, Math.max(min, v));
  if (step >= 1) n = Math.round(n);
  return n;
}

function normalizeAgentLimits(raw) {
  const out = { ...AGENT_LIMITS_DEFAULTS };
  if (!raw || typeof raw !== 'object') return out;
  for (const [key, item] of SCHEMA_BY_KEY) {
    if (raw[key] === undefined) continue;
    out[key] = clampSchemaValue(item, raw[key]);
  }
  return out;
}

function formatAgentLimitValue(item, value) {
  if (item.type === 'boolean') return value ? '开' : '关';
  const n = Number(value);
  if (item.format === 'min') return `${Math.round(n / 60000)} 分钟`;
  if (item.format === 'ms') return `${Math.round(n)} ms`;
  if (item.format === 'mb') return `${Math.round(n)} MB`;
  if (item.step != null && item.step < 1) return Number(n).toFixed(2);
  return Math.round(n).toLocaleString('zh-CN') + (item.unit ? ` ${item.unit}` : '');
}

// --- browser cache (legacy flat cache, kept for node fallback) ---
const AGENT_LIMITS_STORAGE_KEY = 'dieyun.agent-limits.v1';
const AGENT_LIMITS_BY_TIER_FILE = 'agent-limits-by-tier.json';
/** @type {Record<string, unknown>|null} */
let browserCache = null;
/** @type {string|null} */
let nodeCacheUserData = null;
/** @type {Record<string, Record<string, unknown>>|null} */
let nodeByTierCache = null;

/**
 * agent-limits ↔ agent-limits-by-tier 互为依赖（后者需要本文件的 AGENT_LIMITS_DEFAULTS /
 * normalizeAgentLimits），顶层互相 require 会成环，故对 by-tier 用惰性 require 打破环。
 * esbuild 仍能在构建期静态解析这个字面路径。
 */
function limitsByTierModule() {
  return require('./agent-limits-by-tier');
}

/**
 * 跨层钩子：renderer 的 renderer-model-settings.js 把 resolveContextTierId 挂到 window。
 * 它不是 agent 层模块、无法 require，只能运行期取（Node 下不存在 → 落到 default）。
 */
function crossLayerGlobalFn(name) {
  const g = typeof globalThis !== 'undefined' ? globalThis : {};
  return typeof g[name] === 'function' ? g[name] : null;
}

function resolveAgentLimitsTierId(opts = {}) {
  if (opts && opts.tierId) {
    const id = String(opts.tierId).trim();
    if (limitsByTierModule().isValidLimitsTierId(id)) return id;
    if (isValidContextTierId(id)) return id;
  }
  if (opts && opts.editing === true) {
    return getEditingContextTierId();
  }
  const resolveContext = crossLayerGlobalFn('resolveContextTierId');
  if (resolveContext) {
    return resolveContext(opts || {});
  }
  return 'default';
}

function isUserDataPath(value) {
  // 只有绝对路径才当作 Node 的 userData 目录。此前用「含分隔符」判断，
  // 任何带斜杠的普通字符串（URL 片段、自定义 id 等）都会被误判进磁盘分支
  if (typeof value !== 'string' || !value) return false;
  try {
    return nodeRequire('path').isAbsolute(value);
  } catch {
    // renderer 无 require：退化为旧判断，保证打包环境仍可用
    return /[\\/]/.test(value);
  }
}

function listKnownTierIds() {
  return MODEL_RUNTIME_PRESETS.map((p) => p.id);
}

function remapLimitsTierId(id) {
  return remapLegacyContextTierId(id);
}

function foldLimitsTierRecord(raw) {
  return foldLegacyContextTierRecord(raw, (tid) => listKnownTierIds().includes(tid));
}

function isAgentLimitsByTierShape(raw) {
  if (!raw || typeof raw !== 'object') return false;
  const tierIds = listKnownTierIds();
  return Object.keys(raw).some((k) => tierIds.includes(remapLimitsTierId(k)));
}

function extractLimitOverridesFromNormalized(values) {
  return limitsByTierModule().extractLimitOverrides(values);
}

function readBrowserStorage() {
  if (typeof window === 'undefined' || !window.localStorage) return {};
  try {
    return JSON.parse(window.localStorage.getItem(AGENT_LIMITS_STORAGE_KEY) || '{}');
  } catch {
    return {};
  }
}

function writeBrowserStorage(limits) {
  if (typeof window === 'undefined' || !window.localStorage) return;
  window.localStorage.setItem(AGENT_LIMITS_STORAGE_KEY, JSON.stringify(limits));
}

function syncLimitsToMainProcess() {
  if (typeof window === 'undefined') return;
  /** @type {any} */
  const w = window;
  if (!w.diecloud || !w.diecloud.syncAgentLimits) return;
  const getAll = limitsByTierModule().getAllLimitsByTier;
  const payload = getAll ? getAll() : getAgentLimits();
  w.diecloud.syncAgentLimits(payload).catch(() => {});
}

function getAgentLimits(arg, tierIdArg) {
  if (isUserDataPath(arg)) {
    const tierId = tierIdArg || 'default';
    return getAgentLimitsForNodeTier(arg, tierId);
  }

  const opts = arg && typeof arg === 'object' && !Array.isArray(arg) ? arg : {};
  const tierId = resolveAgentLimitsTierId(opts);
  const getForTier = limitsByTierModule().getLimitsForTier;
  if (getForTier) {
    return getForTier(tierId);
  }

  if (!browserCache) {
    browserCache = normalizeAgentLimits(readBrowserStorage());
  }
  return { ...browserCache };
}

function getAgentLimit(key, userDataPathOrOpts, tierIdArg) {
  return getAgentLimits(userDataPathOrOpts, tierIdArg)[key];
}

function setAgentLimits(partial, opts = {}) {
  const tierId = resolveAgentLimitsTierId(opts);
  let merged;
  const setForTier = limitsByTierModule().setLimitsForTier;
  if (setForTier) {
    merged = setForTier(tierId, partial || {});
  } else {
    merged = normalizeAgentLimits({ ...getAgentLimits(), ...(partial || {}) });
    browserCache = merged;
    writeBrowserStorage(merged);
  }
  if (!opts.skipSync) syncLimitsToMainProcess();
  if (typeof window !== 'undefined') {
    window.dispatchEvent(
      new CustomEvent('dieyun:agent-limits-change', {
        detail: { ...merged, contextTierId: tierId }
      })
    );
  }
  return merged;
}

function resetAgentLimits(opts = {}) {
  const tierId = resolveAgentLimitsTierId(opts);
  let merged;
  const resetForTier = limitsByTierModule().resetLimitsForTier;
  if (resetForTier) {
    merged = resetForTier(tierId);
  } else {
    merged = normalizeAgentLimits({});
    browserCache = merged;
    writeBrowserStorage(merged);
  }
  if (!opts.skipSync) syncLimitsToMainProcess();
  if (typeof window !== 'undefined') {
    window.dispatchEvent(
      new CustomEvent('dieyun:agent-limits-change', {
        detail: { ...merged, contextTierId: tierId }
      })
    );
  }
  return { ...merged };
}

function hydrateAgentLimitsFromDisk(limits) {
  if (limitsByTierModule().hydrateLimitsByTier(limits)) {
    if (typeof window !== 'undefined') {
      window.dispatchEvent(
        new CustomEvent('dieyun:agent-limits-change', {
          detail: {
            ...getAgentLimits({ editing: true }),
            contextTierId: resolveAgentLimitsTierId({ editing: true })
          }
        })
      );
    }
    return;
  }
  browserCache = normalizeAgentLimits(limits || {});
  writeBrowserStorage(browserCache);
}

function agentLimitsFilePath(userDataPath) {
  const path = nodeRequire('path');
  return path.join(userDataPath, AGENT_LIMITS_BY_TIER_FILE);
}

function legacyAgentLimitsFilePath(userDataPath) {
  const path = nodeRequire('path');
  return path.join(userDataPath, 'agent-limits.json');
}

function loadLimitsByTierFromDisk(userDataPath) {
  if (!userDataPath) return {};
  const fs = nodeRequire('fs');
  const byTierFile = agentLimitsFilePath(userDataPath);
  try {
    const raw = JSON.parse(fs.readFileSync(byTierFile, 'utf8'));
    if (raw && typeof raw === 'object' && isAgentLimitsByTierShape(raw)) {
      return foldLimitsTierRecord(raw);
    }
  } catch {
    // fall through
  }

  try {
    const legacyRaw = JSON.parse(fs.readFileSync(legacyAgentLimitsFilePath(userDataPath), 'utf8'));
    if (legacyRaw && typeof legacyRaw === 'object' && !isAgentLimitsByTierShape(legacyRaw)) {
      const migrated = { default: extractLimitOverridesFromNormalized(legacyRaw) };
      saveLimitsByTierToDisk(userDataPath, migrated);
      return migrated;
    }
  } catch {
    // ignore
  }
  return {};
}

function getNodeLimitsByTier(userDataPath) {
  if (userDataPath !== nodeCacheUserData || !nodeByTierCache) {
    nodeByTierCache = loadLimitsByTierFromDisk(userDataPath);
    nodeCacheUserData = userDataPath;
  }
  return nodeByTierCache;
}

function getAgentLimitsForNodeTier(userDataPath, tierId) {
  const key = listKnownTierIds().includes(remapLimitsTierId(tierId))
    ? remapLimitsTierId(tierId)
    : 'default';
  const byTier = getNodeLimitsByTier(userDataPath);
  const overrides = byTier[key] || {};
  return normalizeAgentLimits(overrides);
}

function saveLimitsByTierToDisk(userDataPath, byTier) {
  if (!userDataPath) return {};
  const fs = nodeRequire('fs');
  const path = nodeRequire('path');
  const file = agentLimitsFilePath(userDataPath);
  const cleaned = /** @type {Record<string, Record<string, unknown>>} */ ({});
  const folded = foldLimitsTierRecord(byTier || {});
  for (const [tierId, values] of Object.entries(folded)) {
    if (!listKnownTierIds().includes(tierId) || !values || typeof values !== 'object') continue;
    const overrides = extractLimitOverridesFromNormalized(values);
    if (Object.keys(overrides).length) cleaned[tierId] = overrides;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(cleaned, null, 2), 'utf8');
  if (userDataPath === nodeCacheUserData) nodeByTierCache = cleaned;
  return cleaned;
}

function saveAgentLimitsToDisk(userDataPath, limits) {
  if (!userDataPath) return normalizeAgentLimits(limits || {});
  if (limits && typeof limits === 'object' && isAgentLimitsByTierShape(limits)) {
    return saveLimitsByTierToDisk(userDataPath, limits);
  }
  const byTier = getNodeLimitsByTier(userDataPath);
  byTier.default = extractLimitOverridesFromNormalized(limits || {});
  if (!Object.keys(byTier.default).length) delete byTier.default;
  return saveLimitsByTierToDisk(userDataPath, byTier);
}

function resolveLoopToolCallLimit(settings, userDataPath, tierId) {
  const schema = SCHEMA_BY_KEY.get('ctxAgentToolCallLimit') || {};
  const max = schema.max != null ? schema.max : 600;
  const clamp = (n) => {
    const x = Math.floor(Number(n));
    if (!Number.isFinite(x) || x < 1) return null;
    return Math.min(max, x);
  };
  const fromSettings = clamp(settings && settings.agentToolCallLimit);
  if (fromSettings != null) return fromSettings;
  const fromLimits = clamp(getAgentLimit('ctxAgentToolCallLimit', userDataPath, tierId));
  if (fromLimits != null) return fromLimits;
  return AGENT_LIMITS_DEFAULTS.ctxAgentToolCallLimit;
}

function resolveFirstTokenTimeoutMs(userDataPath, tierId) {
  try {
    const n = Number(getAgentLimit('llmFirstTokenTimeoutMs', userDataPath, tierId));
    if (Number.isFinite(n) && n >= 10000) return n;
  } catch {
    // ignore
  }
  return undefined;
}

/** 流式包间隔容忍时长；未配置时返回 undefined，由 llm-proxy 的模块兜底值生效。 */
function resolveStreamIdleTimeoutMs(userDataPath, tierId) {
  try {
    const n = Number(getAgentLimit('llmStreamIdleTimeoutMs', userDataPath, tierId));
    if (Number.isFinite(n) && n >= 10000) return n;
  } catch {
    // ignore
  }
  return undefined;
}

/** Resolve loop tunables before run — do not hide defaults inside the loop body. */
function resolveAgentLoopSpec(settings, userDataPath, tierId) {
  const limits = getAgentLimitsForNodeTier(userDataPath, tierId || 'default');
  const maxRetries = Number(limits.streamRoundMaxAttempts);
  const retryBaseMs = Number(limits.llmRetryBaseMs);
  const reconnectMaxWaitMs = Number(limits.llmReconnectMaxWaitMs);
  return {
    maxToolCalls: resolveLoopToolCallLimit(settings, userDataPath, tierId),
    firstTokenTimeoutMs: resolveFirstTokenTimeoutMs(userDataPath, tierId),
    streamIdleTimeoutMs: resolveStreamIdleTimeoutMs(userDataPath, tierId),
    llmMaxRetries: Number.isFinite(maxRetries) && maxRetries > 0 ? maxRetries : 3,
    llmRetryBaseMs: Number.isFinite(retryBaseMs) && retryBaseMs >= 200 ? retryBaseMs : 800,
    llmMaxRetryDelayMs: 60000,
    // >0 时进入时间驱动的无限次重连；0 时退回 llmMaxRetries 次数模式
    llmReconnectMaxWaitMs:
      Number.isFinite(reconnectMaxWaitMs) && reconnectMaxWaitMs >= 0
        ? reconnectMaxWaitMs
        : AGENT_LIMITS_DEFAULTS.llmReconnectMaxWaitMs
  };
}

function resolveContextTierIdForNode(userDataPath, modelRouteOrId) {
  try {
    const { loadModelSettings } = nodeRequire('../model-settings');
    const { resolveContextTierIdFromSettings } = require('./model-runtime-by-tier');
    const settings = loadModelSettings(userDataPath);
    return resolveContextTierIdFromSettings(settings, modelRouteOrId);
  } catch {
    try {
      const { inferContextTierFromModelName } = require('./model-runtime-by-tier');
      return inferContextTierFromModelName(modelRouteOrId);
    } catch {
      return 'default';
    }
  }
}

const agentLimitsApi = {
  AGENT_LIMITS_DEFAULTS,
  AGENT_LIMITS_SCHEMA,
  LONG_HORIZON_GUARDRAIL_SCALE,
  LONG_HORIZON_HARD_CAP,
  scaleLimitForLongHorizon,
  applyLongHorizonGuardrails,
  SCHEMA_BY_KEY,
  normalizeAgentLimits,
  formatAgentLimitValue,
  resolveAgentLimitsTierId,
  getAgentLimits,
  getAgentLimit,
  setAgentLimits,
  resetAgentLimits,
  hydrateAgentLimitsFromDisk,
  saveAgentLimitsToDisk,
  saveLimitsByTierToDisk,
  loadLimitsByTierFromDisk,
  resolveContextTierIdForNode,
  resolveLoopToolCallLimit,
  resolveFirstTokenTimeoutMs,
  resolveStreamIdleTimeoutMs,
  resolveAgentLoopSpec,
  isAgentLimitsByTierShape
};

module.exports = agentLimitsApi;
