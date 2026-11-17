'use strict';

/**
 * 「醒来时它看到什么」—— 外部世界的**事实装配**（唯一来源）。
 *
 * 为什么需要这一层：状态块里原来只有内部体征（相位/张力/疲劳/清单）。它每次醒来面对的是
 * 「空张力 + 空清单」，于是只能 DEFER —— 不是它懒，是**这台机器上发生过什么它不知道**。
 *
 * 三条刻意的约定：
 * 1. **只读、不落盘**：全部来自 `memory.sessions_list` / `memory.messages_recent`，
 *    拼成一段文字塞进状态块；任何一步失败都回空（看不着不该让整轮醒不来）。
 * 2. **不猜「哪条重要」**：只按结构信号取（时间窗内更新过的会话、最后一条人类消息），
 *    不做关键词/意图判断（AGENTS 原则 3）。
 * 3. 它**不知道**用户在读什么：只给"最近发生过什么"，不给"谁在等你"（那是 `load` 的事）。
 *
 * 数字全在 `agent-limits`（`aliveRecap*`），本文件不留数字。
 */

const { unpackMessageMeta } = require('../agent/session-context');

/** 合成消息不是「人说的话」：体征块 / 目标续跑等代码写的正文都有 `[系统]` 前缀（结构信号，不是意图判断） */
const SYNTHETIC_PREFIXES = ['[系统]'];

/**
 * 落库消息 → `{ text, human }`。
 *
 * **正文要先剥掉 meta 封套**（`【叠云meta】{...}`，唯一实现在 `session-context.unpackMessageMeta`）：
 * 以前这里直接对 `row.content` 做前缀匹配，于是**每一条真人消息**都因为开头是
 * `【叠云meta】` 被判成"合成"——事实块里所有会话都写着「（没有可引用的内容）」，
 * 「你最后一次听到人说话」永远不存在。封套是存储形式，不是作者信号。
 *
 * 「不是人打的字」只有两个结构信号：user 行的 `meta.trigger`（定时 / 目标 / 心跳 = 机器；
 * 频道来信是人写的，算人），以及正文开头的 `[系统]` 合成前缀。
 */
function readMessage(row) {
  const r = row && typeof row === 'object' ? row : {};
  const unpacked = unpackMessageMeta(r.content);
  const text = String(unpacked.content || '').trim();
  if (!text) return { text: '', human: false };
  const trigger = unpacked.meta && unpacked.meta.trigger;
  const kind = trigger && typeof trigger === 'object' ? String(trigger.kind || '') : '';
  const machineAuthored = !!kind && kind !== 'channel';
  const human = String(r.role || '') === 'user' && !machineAuthored && !isSyntheticContent(text);
  return { text, human };
}

function isSyntheticContent(text) {
  const s = String(text || '').trim();
  if (!s) return true;
  return SYNTHETIC_PREFIXES.some((p) => s.startsWith(p));
}

function clip(text, max) {
  const s = String(text || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!(max > 0) || s.length <= max) return s;
  return `${s.slice(0, Math.max(0, max - 1))}…`;
}

/** 「12 分钟前 / 3 小时前」：页面与状态块同一套说法 */
function agoText(ms) {
  const s = Math.max(0, Math.floor(Number(ms) / 1000));
  if (s < 60) return `${s} 秒前`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} 分钟前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时前`;
  return `${Math.floor(h / 24)} 天前`;
}

/**
 * 收集「最近这台机器上在做什么」。
 *
 * @param {{ invokeRpc?: Function, selfSessionId?: string, limits?: object, nowMs?: number,
 *           listPlans?: () => Array<object> }} opts
 *   `selfSessionId` = 心跳会话自己（必须排除：否则它会看到"我自己刚醒过一次"这种噪声）
 *   `listPlans` = 计划清单的读取入口（`plans/store.js#list`；没有就只报会话）
 * @returns {Promise<{ sessions: Array<{title: string, agoText: string, tail: string}>,
 *                     plans: Array<{name: string, attempt: number, objective: string,
 *                                   check: string, lastOk: boolean|null, tail: string}>,
 *                     lastHuman: { agoText: string, tail: string, title: string }|null }>}
 */
async function collectRecap(opts = {}) {
  const empty = { sessions: [], plans: [], lastHuman: null };
  const invokeRpc = opts.invokeRpc;
  if (typeof invokeRpc !== 'function') return { ...empty, plans: collectOpenPlans(opts) };
  const limits = opts.limits || {};
  const nowMs = Number(opts.nowMs) || Date.now();
  const windowMs = Math.max(1, Number(limits.recapWindowHours) || 24) * 3600 * 1000;
  const maxSessions = Math.max(1, Number(limits.recapSessions) || 3);
  const tailChars = Math.max(20, Number(limits.recapTailChars) || 160);
  const selfSessionId = String(opts.selfSessionId || '');

  let rows = [];
  try {
    rows = await invokeRpc('memory.sessions_list', { limit: 40 });
  } catch {
    return empty;
  }
  const recent = (Array.isArray(rows) ? rows : [])
    .filter((row) => row && row.id && String(row.id) !== selfSessionId)
    .filter((row) => {
      // `memory.sessions_list` 的返回是 Rust `SessionRow`（serde camelCase）→ 字段名是 `updatedAt`。
      // 读 `row.updated_at` 会恒为 undefined → 每条会话都被时间窗滤掉 → 事实块永远写
      // 「最近这台机器上没有别的会话动静」（它每次醒来面对一个空世界，只能 DEFER）。
      const at = Number(row.updatedAt || row.updated_at || 0);
      return at > 0 && nowMs - at <= windowMs;
    })
    .sort((a, b) => Number(b.updatedAt || b.updated_at || 0) - Number(a.updatedAt || a.updated_at || 0))
    .slice(0, maxSessions);

  const sessions = [];
  /** @type {{agoText: string, tail: string, title: string}|null} */
  let lastHuman = null;
  for (const row of recent) {
    const title = clip(row.title, 40) || '（未命名会话）';
    const ago = agoText(nowMs - Number(row.updatedAt || row.updated_at || nowMs));
    let tail = '';
    let humanTail = '';
    try {
      const msgs = await invokeRpc('memory.messages_recent', { sessionId: row.id, limit: 6 });
      const list = (Array.isArray(msgs) ? msgs : []).map((m) => ({ ...readMessage(m), role: String((m && m.role) || '') }));
      // 尾句优先取它（模型）最后说的那句人话；没有就退到人说的最后一句
      const lastAssistant = [...list].reverse().find((m) => m.role === 'assistant' && m.text);
      const lastUser = [...list].reverse().find((m) => m.role === 'user' && m.human);
      if (lastAssistant) tail = clip(lastAssistant.text, tailChars);
      else if (lastUser) tail = clip(lastUser.text, tailChars);
      if (lastUser) humanTail = clip(lastUser.text, tailChars);
    } catch {
      // 单个会话取不到就只报标题，不拖垮整块
    }
    sessions.push({ title, agoText: ago, tail });
    if (!lastHuman && humanTail) lastHuman = { agoText: ago, tail: humanTail, title };
  }
  return { sessions, plans: collectOpenPlans(opts), lastHuman };
}

/**
 * 未收尾的**目标型计划**（`trigger==='goal'` 且 `outcome` 为空）。
 *
 * 为什么它该出现在唤醒轮的事实块里：这是「有什么没收口」的**唯一现成原料**。它自己
 * 声明未闭合事项时本来只能对着画面瞎猜；有了这份清单，声明才有依据（"那个计划第 3 轮
 * 还没过检查"）。唤醒轮是只读的：它跑不了计划，只能记着 —— 所以这里只给事实，不给指令。
 *
 * 失败一律回空：计划存储不可用不该让整轮醒不来。
 */
function collectOpenPlans(opts = {}) {
  const limits = opts.limits || {};
  const max = Math.max(0, Number(limits.recapPlans) || 0);
  if (!max || typeof opts.listPlans !== 'function') return [];
  let rows = [];
  try {
    rows = opts.listPlans();
  } catch {
    return [];
  }
  const tailChars = Math.max(20, Number(limits.recapTailChars) || 160);
  return (Array.isArray(rows) ? rows : [])
    .filter((p) => p && p.trigger === 'goal' && !p.outcome)
    .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))
    .slice(0, max)
    .map((p) => {
      const goal = p.goal && typeof p.goal === 'object' ? p.goal : {};
      const checks = Array.isArray(goal.checks) ? goal.checks : [];
      const firstCheck = checks.length ? String((checks[0] && checks[0].command) || '') : '';
      return {
        name: clip(p.name, 40) || '（未命名计划）',
        attempt: Math.max(0, Number(p.attempt) || 0),
        objective: clip(goal.objective, tailChars),
        check: clip(firstCheck, 80),
        lastOk: p.lastRunOk == null ? null : p.lastRunOk === true,
        tail: clip(p.lastRunSummary, tailChars)
      };
    });
}

/**
 * 「拿什么去搜记忆」—— 用**它当前面对的具体事**拼查询，而不是拿体征块去碰运气。
 *
 * 为什么不能拿体征块去召回：`[系统] 生命体征 · 相位 SETTLE · 张力 40.7 …` 里没有一个
 * 具体的名词，向量召回只会捞回一堆泛泛的"用户偏好"条目（实测就是那几条 #1774/#1854）。
 * 而这台机器上真正在发生的事，`recap` 里全都有（会话标题 + 尾句 + 未收尾计划 + 它自己抽屉里的话）。
 *
 * 只拼事实、不做意图判断（AGENTS 原则 3）：不过滤关键词、不猜哪条"更重要"，
 * 按顺序拼、按字数截断，剩下的交给向量相似度。
 *
 * @param {{ sessions?: Array<object>, plans?: Array<object> }|null} recap
 * @param {string[]|null} note 它抽屉里最近写的几行
 * @param {number} maxChars 查询串上限（`agent-limits.aliveRecallQueryMaxChars`）
 * @returns {string}
 */
function buildRecallQuery(recap, note, maxChars) {
  const sessions = (recap && Array.isArray(recap.sessions) ? recap.sessions : []).slice(0, 3);
  const plans = (recap && Array.isArray(recap.plans) ? recap.plans : []).slice(0, 2);
  const parts = [];
  // 1) 关键词密度最高的先放：会话标题 / 计划名 / 它自己抽屉里的字（截断时先保住这些）
  for (const s of sessions) if (s && s.title) parts.push(String(s.title));
  for (const p of plans) if (p && p.name) parts.push(String(p.name));
  for (const line of Array.isArray(note) ? note : []) parts.push(String(line));
  // 2) 再把长句（尾句/目标）接在后面：它们是细节，被截掉不致命
  for (const s of sessions) if (s && s.tail) parts.push(String(s.tail));
  for (const p of plans) if (p && p.objective) parts.push(String(p.objective));
  const joined = parts
    .join(' ')
    .replace(/\s+/gu, ' ')
    .trim();
  const max = Math.max(0, Number(maxChars) || 0);
  return max > 0 ? joined.slice(0, max) : joined;
}

module.exports = {
  collectRecap,
  collectOpenPlans,
  buildRecallQuery,
  agoText,
  clip,
  isSyntheticContent,
  SYNTHETIC_PREFIXES
};
