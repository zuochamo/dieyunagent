'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const FILE_NAME = 'plans.json';

function newId() {
  return crypto.randomBytes(8).toString('hex');
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
    deliver: {
      type: deliver.type === 'session' ? 'session' : 'session',
      sessionId: String(deliver.sessionId || p.sessionId || '').trim()
    },
    createdAt: p.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    lastRunAt: p.lastRunAt || null,
    lastRunOk: p.lastRunOk == null ? null : !!p.lastRunOk,
    lastRunSummary: String(p.lastRunSummary || '').slice(0, 4000)
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
}

module.exports = { PlansStore, normalizePlan, newId };
