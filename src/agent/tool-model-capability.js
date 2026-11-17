'use strict';

/**
 * 模型能力启发式（与工具 schema 无关，所以不在 catalog 里）：
 * 判断「这个模型的工具调用能力弱不弱」，供 renderer-tool-defs 决定要不要精简工具表。
 */

/**
 * 判断模型是否「工具调用能力弱」——只依据可量化的规模信号，禁止按厂商名（deepseek/mimo/qwen 等）
 * 一刀切：同一厂商既有弱模型也有强模型，命中厂商子串会误伤强模型（如 DeepSeek-V4.1-Flash）。
 * 命中条件：模型 id 标注了 ≤8B 参数量，或带 tiny/small/nano/micro/mini 等小模型后缀。
 */function isWeakToolCallerModel(modelId) {
  const m = String(modelId || '').toLowerCase();
  if (!m) return false;
  // 参数量标记（1.8b / 7b / 8b …）：仅 ≤8B 视为弱；排除 8x7b 这类 MoE 总参数写法
  for (const token of m.match(/(?<![x*])\d+(?:[._]\d+)?\s*b(?![a-z0-9])/g) || []) {
    const n = parseFloat(token.replace(/[._](?=\d)/g, '.').replace(/\s*b$/, ''));
    if (Number.isFinite(n) && n > 0 && n <= 8) return true;
  }
  // 显式小模型标记：要求被分隔符/边界包裹，避免 MiniMax 等强模型被误伤
  if (/(^|[-_/.: ])(tiny|small|nano|micro|mini)$/.test(m)) return true;
  if (/(^|[-_/.: ])(tinyllama|phi-?2|gemma-?1?2b)([-_/.: ]|$)/.test(m)) return true;
  return false;
}

module.exports = {
  isWeakToolCallerModel
};
