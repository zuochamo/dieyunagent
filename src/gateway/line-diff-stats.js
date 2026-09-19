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
 * 真实逐行差异统计（绿加红减口径）。
 * 先掐掉公共前后缀；剩余中间块在 LCS 上限内按最长公共子序列精确计数，
 * 两处插入点之间未变更的行不会被误记为删除。超上限（超大文件）退回
 * 块级行数——删除量会被高估，但不会卡死主进程。
 */
function computeLineDiffStats(beforeText, afterText) {
  const before = beforeText == null ? [] : String(beforeText).split(/\r?\n/);
  const after = String(afterText || '').split(/\r?\n/);
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let beforeEnd = before.length - 1;
  let afterEnd = after.length - 1;
  while (beforeEnd >= start && afterEnd >= start && before[beforeEnd] === after[afterEnd]) {
    beforeEnd--;
    afterEnd--;
  }
  const beforeMid = before.slice(start, beforeEnd + 1);
  const afterMid = after.slice(start, afterEnd + 1);
  if (
    beforeMid.length + afterMid.length > LINE_DIFF_MAX_LINE_SUM ||
    beforeMid.length * afterMid.length > LINE_DIFF_MAX_LINE_PRODUCT
  ) {
    return { added: afterMid.length, removed: beforeMid.length };
  }
  const lcs = lcsLineCount(beforeMid, afterMid);
  return { added: afterMid.length - lcs, removed: beforeMid.length - lcs };
}

module.exports = { computeLineDiffStats };
