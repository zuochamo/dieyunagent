'use strict';

// 与 renderer-tool-results.js 的 LINE_DIFF_MAX_* 同一组上限：上限内算真实逐行差异，
// 保证「+N -M」徽标与思考区 diff 图形（同一条 LCS）口径一致；超限退回块级行数
const LINE_DIFF_MAX_LINE_SUM = 4000;
const LINE_DIFF_MAX_LINE_PRODUCT = 400000;

function lcsLineCount(aLines, bLines) {
  const m = bLines.length;
  const dp = new Array(m + 1).fill(0);
  for (let i = 1; i <= aLines.length; i++) {
    const ai = aLines[i - 1];
    let prev = 0;
    for (let j = 1; j <= m; j++) {
      const tmp = dp[j];
      if (ai === bLines[j - 1]) dp[j] = prev + 1;
      else dp[j] = Math.max(dp[j], dp[j - 1]);
      prev = tmp;
    }
  }
  return dp[m];
}

/**
 * 切分为行数组。
 * `null` 表示「文件原本不存在」（0 行），空串仍算 1 行 —— 调用方按行数报「新建」时依赖这个区别。
 */
function diffLineArrays(beforeText, afterText) {
  return {
    before: beforeText == null ? [] : String(beforeText).split(/\r?\n/),
    after: String(afterText || '').split(/\r?\n/)
  };
}

/** 掐掉公共前后缀：未变更的行不进入 LCS，窗口只留真正变化的中段。 */
function trimDiffWindow(before, after) {
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let beforeEnd = before.length - 1;
  let afterEnd = after.length - 1;
  while (beforeEnd >= start && afterEnd >= start && before[beforeEnd] === after[afterEnd]) {
    beforeEnd--;
    afterEnd--;
  }
  return { start, beforeEnd, afterEnd };
}

/** 窗口内真实逐行差异；超上限（超大文件）退回块级行数，删除量会被高估但不会卡死主进程。 */
function statsInWindow(before, after, window) {
  const beforeMid = before.slice(window.start, window.beforeEnd + 1);
  const afterMid = after.slice(window.start, window.afterEnd + 1);
  if (!withinLineDiffBudget(beforeMid.length, afterMid.length)) {
    return { added: afterMid.length, removed: beforeMid.length };
  }
  const lcs = lcsLineCount(beforeMid, afterMid);
  return { added: afterMid.length - lcs, removed: beforeMid.length - lcs };
}

/**
 * 「这份 diff 还算得动吗」—— 行数上限的唯一判据。
 *
 * 徽标计数（`computeLineDiffStats`）与 Renderer 的逐行 op 表（`renderer-tool-results.js#buildLineDiffOps`）
 * 都要在同一组上限下决定「算真实逐行差异 / 退回块级」。以前这两处各写一份 4000 / 400000，
 * 改一个忘一个就会出现「徽标说 +1 −1、展开却是块级差」。
 *
 * @param {number} beforeLines
 * @param {number} afterLines
 */
function withinLineDiffBudget(beforeLines, afterLines) {
  const a = Math.max(0, Number(beforeLines) || 0);
  const b = Math.max(0, Number(afterLines) || 0);
  return a + b <= LINE_DIFF_MAX_LINE_SUM && a * b <= LINE_DIFF_MAX_LINE_PRODUCT;
}

/**
 * 一次切分 + 一次裁剪，同时给出片段窗口与 +/- 计数。
 *
 * 徽标计数（`computeLineDiffStats`）与「变更片段」摘要（`rpc.js:summarizeLineDiff`）
 * 原本各自把两个文本切分、裁一遍再算 —— 同一份活干两次。这里做成单一来源：
 * 调用方拿 `before/after/start/beforeEnd/afterEnd` 切片段，拿 `added/removed` 当徽标。
 */
function prepareLineDiff(beforeText, afterText) {
  const { before, after } = diffLineArrays(beforeText, afterText);
  const window = trimDiffWindow(before, after);
  const { added, removed } = statsInWindow(before, after, window);
  return { before, after, ...window, added, removed };
}

/**
 * 真实逐行差异统计（绿加红减口径）。
 * 先掐掉公共前后缀；剩余中间块在 LCS 上限内按最长公共子序列精确计数，
 * 两处插入点之间未变更的行不会被误记为删除。
 */
function computeLineDiffStats(beforeText, afterText) {
  const { added, removed } = prepareLineDiff(beforeText, afterText);
  return { added, removed };
}

module.exports = { computeLineDiffStats, prepareLineDiff, withinLineDiffBudget };
