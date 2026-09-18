'use strict';

const { chatCompletion } = require('./runner');
const { normalizePlan, newId } = require('./store');

const PARSE_SYSTEM = `你是叠云 Agent 的计划解析器。用户用自然语言描述定时任务，你只输出一个 JSON 对象，不要 markdown 围栏。

字段：
- name: 简短中文名称
- rrule: iCalendar RRULE 字符串（不含 RRULE: 前缀）。示例：
  - 每天 9:00 → FREQ=DAILY;BYHOUR=9;BYMINUTE=0
  - 每周一 9:00 → FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=0
  - 每 30 分钟 → FREQ=MINUTELY;INTERVAL=30
- onceAt: 若仅执行一次，填 ISO8601 本地时间（如 2026-05-26T09:00:00），否则留空字符串
- prompt: 到点后交给 AI 执行的任务说明（完整、可执行）
- todos: 字符串数组，将任务拆成可勾选步骤；若用户未明确步骤，也要给出 2-6 个执行检查项
- skillIds: 字符串数组，可留空 []

规则：rrule 与 onceAt 二选一；默认时区 Asia/Shanghai；BYHOUR 用 24 小时制。`;

function extractJson(text) {
  const s = String(text || '').trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fence ? fence[1].trim() : s;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('模型未返回有效 JSON');
  return JSON.parse(body.slice(start, end + 1));
}

/**
 * 结构化直通：调用方（模型）已直接给出 rrule / onceAt 时，
 * 不再花一次 LLM 调用去「解析自然语言」——纯确定性落盘，可复现、可 trace。
 *
 * @returns {object | null} null 表示无法结构化确定，交由 LLM 解析兜底
 */
function planDraftFromStructured(input, opts = {}) {
  const src = input && typeof input === 'object' ? input : {};
  const rrule = String(src.rrule || '').trim();
  const onceAt = String(src.onceAt || '').trim();
  const prompt = String(src.prompt || src.description || '').trim();
  if ((!rrule && !onceAt) || !prompt) return null;

  const skillIds = Array.isArray(src.skillIds) && src.skillIds.length
    ? src.skillIds
    : Array.isArray(opts.skillIds)
      ? opts.skillIds
      : [];

  return normalizePlan({
    id: newId(),
    name: src.name,
    rrule: onceAt ? '' : rrule,
    onceAt,
    tz: 'Asia/Shanghai',
    dtstart: new Date().toISOString(),
    prompt,
    todos: Array.isArray(src.todos) ? src.todos : [],
    skillIds,
    deliver: {
      type: 'session',
      sessionId: opts.sessionId || ''
    },
    enabled: true
  });
}

/**
 * @param {string} userData
 * @param {string} text
 * @param {{ sessionId?: string, skillIds?: string[], structured?: object, route?: string, model?: string, signal?: object }} [opts]
 */
async function parsePlanFromText(userData, text, opts = {}) {
  const structured = planDraftFromStructured(opts.structured, opts);
  if (structured) return structured;

  const raw = await chatCompletion(
    userData,
    String(text || '').trim(),
    PARSE_SYSTEM,
    {
      route: opts.route,
      model: opts.model,
      signal: opts.signal
    }
  );
  const parsed = extractJson(raw);
  const plan = normalizePlan({
    id: newId(),
    name: parsed.name,
    rrule: parsed.onceAt ? '' : parsed.rrule,
    onceAt: parsed.onceAt || '',
    tz: 'Asia/Shanghai',
    dtstart: new Date().toISOString(),
    prompt: parsed.prompt,
    todos: Array.isArray(parsed.todos) ? parsed.todos : [],
    skillIds: parsed.skillIds && parsed.skillIds.length ? parsed.skillIds : opts.skillIds || [],
    deliver: {
      type: 'session',
      sessionId: opts.sessionId || ''
    },
    enabled: true
  });
  return plan;
}

module.exports = { parsePlanFromText, planDraftFromStructured, PARSE_SYSTEM };
