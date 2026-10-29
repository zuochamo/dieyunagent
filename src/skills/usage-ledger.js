'use strict';

/**
 * 技能使用账本：记录「模型真的读了某个技能的 SKILL.md」这件事。
 *
 * 为什么需要：技能此前是纯建议 —— 注入的只是索引（名称 + 路径 + 简介），全文由模型
 * 自己 fs_read_file 读。于是出问题时无法区分两种完全不同的原因：
 *   ① 技能写错了（读了但没用）  ② 模型压根没读（技能等于没生效）
 * 工具 trace 里能翻到单次调用，但回答不了「这个技能到底有没有在用」。
 *
 * 记什么：只记**读取事实**（skillPath / 次数 / 最近时间 / 会话），不记内容、不做推断。
 * 谁消费：技能列表（skills:scan 合并后由 Renderer 展示「最近使用」）。
 *
 * 边界：写入失败一律吞掉 —— 账本坏掉不该让工具调用失败；它只是旁证，不是主链路。
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const USAGE_FILE = 'skill-usage.json';
/** 账本条目上限：只保留最近使用的这么多个技能，防止长期累积。 */
const MAX_ENTRIES = 200;

/** @param {string} userData */
function skillUsagePath(userData) {
  return path.join(String(userData || ''), USAGE_FILE);
}

/**
 * 是不是一个技能入口文件。只看结构（文件名），不做「这个路径像不像技能」的猜测。
 * @param {string} absPath
 */
function isSkillEntryPath(absPath) {
  return /(^|[\\/])SKILL\.md$/i.test(String(absPath || ''));
}

function normalizeKey(absPath) {
  const p = path.resolve(String(absPath || ''));
  return process.platform === 'win32' ? p.toLowerCase() : p;
}

/** 串行化写入：并行工具调用可能同时读到同一个技能，避免写文件互相覆盖。 */
let writeChain = Promise.resolve();

function readUsageSync(userData) {
  try {
    const data = JSON.parse(fs.readFileSync(skillUsagePath(userData), 'utf8'));
    if (data && typeof data === 'object' && data.entries && typeof data.entries === 'object') {
      return data;
    }
  } catch {
    // 缺文件 / 坏 JSON 都当空账本
  }
  return { version: 1, entries: {} };
}

/**
 * @param {string} userData
 * @returns {Promise<{ version: number, entries: Record<string, { path?: string, count: number, lastAt: number, lastSessionId?: string }> }>}
 */
async function readSkillUsage(userData) {
  return readUsageSync(userData);
}

/**
 * 记录一次 SKILL.md 读取。非技能文件的路径直接忽略。
 * 永不抛错、永不阻塞调用方（`void recordSkillRead(...)` 即可）。
 *
 * @param {{ userData?: string, skillPath?: string, sessionId?: string }} input
 * @returns {Promise<void>}
 */
function recordSkillRead(input) {
  const userData = String((input && input.userData) || '');
  const skillPath = String((input && input.skillPath) || '');
  if (!userData || !isSkillEntryPath(skillPath)) return Promise.resolve();
  const sessionId = input && input.sessionId ? String(input.sessionId) : '';
  const key = normalizeKey(skillPath);

  writeChain = writeChain
    .then(async () => {
      const usage = readUsageSync(userData);
      const prev = usage.entries[key] || { count: 0, lastAt: 0 };
      usage.entries[key] = {
        // 保留原始大小写路径：UI 要按它回显，key 只用于去重
        path: path.resolve(skillPath),
        count: Number(prev.count || 0) + 1,
        lastAt: Date.now(),
        lastSessionId: sessionId || prev.lastSessionId || ''
      };
      const keys = Object.keys(usage.entries);
      if (keys.length > MAX_ENTRIES) {
        keys
          .sort((a, b) => Number(usage.entries[a].lastAt || 0) - Number(usage.entries[b].lastAt || 0))
          .slice(0, keys.length - MAX_ENTRIES)
          .forEach((k) => delete usage.entries[k]);
      }
      await fsp.mkdir(userData, { recursive: true }).catch(() => {});
      await fsp.writeFile(skillUsagePath(userData), `${JSON.stringify(usage, null, 2)}\n`, 'utf8');
    })
    .catch(() => {
      // 账本写失败不影响任何主流程
    });
  return writeChain;
}

/**
 * 把账本里某个 skillPath 的最近使用信息取出来（供 scan 结果合并）。
 * @param {{ entries: object }} usage
 * @param {string} skillPath
 */
function usageFor(usage, skillPath) {
  if (!usage || !usage.entries || !skillPath) return null;
  return usage.entries[normalizeKey(skillPath)] || null;
}

module.exports = {
  USAGE_FILE,
  skillUsagePath,
  isSkillEntryPath,
  recordSkillRead,
  readSkillUsage,
  usageFor
};
