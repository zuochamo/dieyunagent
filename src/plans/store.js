'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const FILE_NAME = 'plans.json';

function newId() {
  return crypto.randomBytes(8).toString('hex');
}

/**
 * 运行边界标记（唯一权威的「这次运行已经开始、但还没收尾」记录）。
 *
 * 进程被杀时 Main 的收尾代码不会执行，只有落盘的标记能告诉下次启动
 * 「会话里那条用户轮次还没有回复」，从而补写中断回执。
 */
function normalizeRunState(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const runId = String(raw.runId || '').trim();
  const sessionId = String(raw.sessionId || '').trim();
  if (!runId && !sessionId) return null;
  return {
    runId,
    sessionId,
    startedAt: String(raw.startedAt || '').trim() || new Date().toISOString()
  };
}

function normalizePlan(raw) {
  const p = raw && typeof raw === 'object' ? raw : {};
  const deliver = p.deliver && typeof p.deliver === 'object' ? p.deliver : {};
  const todos = Array.isArray(p.todos)
    ? p.todos.map((x) => String(x || '').trim()).filter(Boolean).slice(0, 50)
    : [];
  return {
    id: p.id || newId(),
    name: String(p.name || '未命名计划').trim() || '未命名计划',
    enabled: p.enabled !== false,
    rrule: String(p.rrule || '').trim(),
    onceAt: p.onceAt ? String(p.onceAt).trim() : '',
    tz: String(p.tz || 'Asia/Shanghai').trim() || 'Asia/Shanghai',
    dtstart: p.dtstart ? String(p.dtstart).trim() : new Date().toISOString(),
    prompt: String(p.prompt || '').trim(),
    todos,
    skillIds: Array.isArray(p.skillIds)
      ? p.skillIds.map((x) => String(x).trim()).filter(Boolean).slice(0, 8)
      : [],
    // 计划绑定的模型路由（custom:<id> / builtin:<supplierId>:<modelId>）。
    // 只存路由，绝不存 apiKey：执行时按路由现算配置，避免密钥落盘。
    model: String(p.model || '').trim(),
    modelRoute: String(p.modelRoute || '').trim(),
    deliver: {
      type: deliver.type === 'session' ? 'session' : 'session',
      sessionId: String(deliver.sessionId || p.sessionId || '').trim()
    },
    createdAt: p.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    lastRunAt: p.lastRunAt || null,
    lastRunOk: p.lastRunOk == null ? null : !!p.lastRunOk,
    lastRunSummary: String(p.lastRunSummary || '').slice(0, 4000),
    // 运行边界标记：只在 beginRun/endRun 中维护，normalize 只负责保留合法值
    runState: normalizeRunState(p.runState)
  };
}

class PlansStore {
  constructor(userData) {
    this.filePath = path.join(userData, FILE_NAME);
    this.plans = [];
    this._load();
  }

  _load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      const list = Array.isArray(raw.plans) ? raw.plans : [];
      this.plans = list.map(normalizePlan);
    } catch {
      this.plans = [];
    }
  }

  _save() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(
      this.filePath,
      JSON.stringify({ version: 1, plans: this.plans }, null, 2),
      'utf8'
    );
  }

  list() {
    return this.plans.map((p) => ({ ...p }));
  }

  get(id) {
    const hit = this.plans.find((p) => p.id === id);
    return hit ? { ...hit } : null;
  }

  upsert(patch) {
    const plan = normalizePlan(patch);
    if (!plan.rrule && !plan.onceAt) {
      const err = new Error('rrule 或 onceAt 至少填一项');
      err.code = 'INVALID_SCHEDULE';
      throw err;
    }
    if (!plan.prompt) {
      const err = new Error('prompt 必填');
      err.code = 'INVALID_PROMPT';
      throw err;
    }
    const idx = this.plans.findIndex((p) => p.id === plan.id);
    if (idx >= 0) {
      plan.createdAt = this.plans[idx].createdAt;
      if (!patch.dtstart) plan.dtstart = this.plans[idx].dtstart;
      // 运行态不是表单字段：UI 保存不应清掉正在运行的边界标记，只由 beginRun/endRun 维护
      if (!patch || !('runState' in patch)) plan.runState = this.plans[idx].runState;
      this.plans[idx] = plan;
    } else {
      this.plans.push(plan);
    }
    this._save();
    return plan;
  }

  delete(id) {
    const before = this.plans.length;
    this.plans = this.plans.filter((p) => p.id !== id);
    if (this.plans.length !== before) this._save();
    return { ok: true };
  }

  updateRunResult(id, result) {
    const p = this.plans.find((x) => x.id === id);
    if (!p) return;
    p.lastRunAt = new Date().toISOString();
    p.lastRunOk = !!(result && result.ok);
    p.lastRunSummary = result
      ? result.summary || result.error || ''
      : '';
    p.updatedAt = p.lastRunAt;
    if (p.onceAt && p.lastRunOk) p.enabled = false;
    this._save();
  }

  /**
   * 运行边界开始：本次触发的用户轮次已写入会话后调用。
   *
   * 必须在用户轮次落库之后落盘 —— 这之后无论进程怎么死，
   * 下次启动都能从这条标记知道「哪条用户轮次还没有回复」。
   *
   * @returns {object|null} 写入的 runState
   */
  beginRun(id, info) {
    const p = this.plans.find((x) => x.id === id);
    if (!p) return null;
    p.runState = normalizeRunState({ ...info, startedAt: new Date().toISOString() });
    this._save();
    return p.runState;
  }

  /** 运行边界结束：assistant 轮次已落库（或已确认无法落库）后调用 */
  endRun(id) {
    const p = this.plans.find((x) => x.id === id);
    if (!p || !p.runState) return false;
    p.runState = null;
    this._save();
    return true;
  }

  /** 上次进程退出时仍在运行的计划，供启动恢复补写中断回执 */
  listRunning() {
    return this.plans
      .filter((p) => p && p.runState)
      .map((p) => ({ plan: { ...p }, runState: { ...p.runState } }));
  }
}

module.exports = { PlansStore, normalizePlan, newId };
