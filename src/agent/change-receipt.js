'use strict';

/**
 * 「我把自己改成了什么」的回执：**形状 + 唯一落盘**。
 *
 * 为什么要有它：配置类工具（装 MCP 服务、建/改技能、改计划、改项目地图）都改的是
 * 「下一轮我按什么跑」，但改完只回一句「已创建 / 已更新」——模型不知道**何时生效**、
 * 拿什么**验证生效**，用户事后也查不到「这条配置是谁、什么时候、从什么改成什么」。
 *
 * 三条边界：
 * 1. **不存全文**：只存 `hash + 字符数`（AGENTS.md / SKILL.md 全文进日志会让日志暴涨，
 *    而且那些内容本来就在文件里、有 git 有 undo）。
 * 2. **不并进 `tool-telemetry.jsonl`**：那个文件的口径是「每次工具调用的成败」，
 *    混进配置 diff 会让成功率统计失真（compaction 遥测单独一条流，同一个理由）。
 * 3. **不改工具语义**：回执只是附在结果上的一个字段，工具该做的写操作一点不变。
 */

const crypto = require('crypto');
const path = require('path');
const { getRotatingLog, flushLog, DEFAULT_MAX_BYTES } = require('../logs/rotating-file-log');

const SELF_CHANGES_FILE = 'self-changes.jsonl';

/** 指纹：同一份内容 → 同一个 hash；空内容 → `null`（区分「没有过」和「是空串」）。 */
function fingerprintText(text) {
  const s = text == null ? null : String(text);
  if (s === null) return null;
  const hash = crypto.createHash('sha1').update(s).digest('hex').slice(0, 12);
  return { hash, chars: s.length };
}

/** JSON 指纹（结构类配置：计划、MCP 服务列表）。 */
function fingerprintJson(value) {
  try {
    return fingerprintText(JSON.stringify(value === undefined ? null : value));
  } catch {
    return null;
  }
}

/**
 * 造一条回执。字段都可选，但 `target` 必填 —— 一条说不出「改的是哪个东西」的回执没有意义。
 *
 * `effectiveFrom` 是**人话常量**，别自创：
 * - `'immediate'`：立刻生效（MCP 服务重挂、计划重新上钟）；
 * - `'next-round'`：下一轮装配时才生效（工作空间、系统提示里的事实）；
 * - `'user-accept'`：等用户采纳（AGENTS.md 的 Diff 预览）；
 * - `'next-wake'`：后台唤醒轮才用得上（生命感相关）。
 *
 * `verifyWith` 是「怎么确认它真的生效了」的一句话（通常是某个工具调用）。
 *
 * @param {{ target: string, before?: object|null, after?: object|null, effectiveFrom?: string, verifyWith?: string }} input
 * @returns {{ target: string, before: object|null, after: object|null, effectiveFrom: string, verifyWith: string, at: string }}
 */
function makeReceipt(input = {}) {
  const target = String(input.target || '').trim();
  if (!target) throw new Error('change receipt 需要 target');
  return {
    target,
    before: input.before || null,
    after: input.after || null,
    effectiveFrom: String(input.effectiveFrom || 'immediate'),
    verifyWith: String(input.verifyWith || ''),
    at: new Date().toISOString()
  };
}

function selfChangesPath(userDataPath) {
  return path.join(String(userDataPath || ''), SELF_CHANGES_FILE);
}

/**
 * 记一条到 `<userData>/self-changes.jsonl`。写失败**不影响**工具结果 ——
 * 回执是附加事实，不该让「改完了但没记上」变成「改失败」。
 *
 * @param {string} userDataPath
 * @param {object} receipt `makeReceipt` 的产物
 * @returns {boolean} 是否写成功
 */
function recordSelfChange(userDataPath, receipt) {
  if (!userDataPath || !receipt || !receipt.target) return false;
  const file = selfChangesPath(userDataPath);
  const log = getRotatingLog(file, { maxBytes: DEFAULT_MAX_BYTES });
  if (!log) return false;
  try {
    log.write(`${JSON.stringify({ ts: Date.now(), ...receipt })}\n`);
    // 配置改动是低频事件（不是每次工具调用）：当场落盘，排查时不必等缓冲。
    flushLog(file);
    return true;
  } catch {
    return false;
  }
}

/**
 * 造 + 记 + 返回：调用点只写一行。
 * @param {string} userDataPath
 * @param {object} fields `makeReceipt` 的入参
 * @returns {object|null} 回执（userDataPath 缺失时也返回回执，只是不落盘）
 */
function changeReceipt(userDataPath, fields) {
  let receipt = null;
  try {
    receipt = makeReceipt(fields);
  } catch {
    return null;
  }
  recordSelfChange(userDataPath, receipt);
  return receipt;
}

module.exports = {
  SELF_CHANGES_FILE,
  fingerprintText,
  fingerprintJson,
  makeReceipt,
  recordSelfChange,
  changeReceipt,
  selfChangesPath
};
