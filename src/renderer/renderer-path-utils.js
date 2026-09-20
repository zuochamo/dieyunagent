/* global isEditToolName */
'use strict';

/**
 * 路径 / 工具参数工具函数（思考区、产物面板、工具结果摘要共用）。
 *
 * 历史：本文件曾叫 `renderer-live-write.js`，除这些纯函数外还承载「边写边预览」的
 * live-write 引擎。该引擎与思考区是双向联动的（trace → 面板实时预览，面板 → 思考区工具行
 * 高亮），链路已整体移除，这里只保留仍被复用的纯函数。
 */

function normWritePath(p) {
  return String(p || '')
    .trim()
    .replace(/\\/g, '/')
    .toLowerCase();
}

/**
 * 两个路径是否指向同一个文件。
 *
 * 只承认两种确定性等价：
 *   1. 规范化后完全相等；
 *   2. 一方是另一方的「/ 边界后缀」—— 覆盖「相对路径 vs 工作区绝对路径」这一合法场景。
 *
 * 刻意不做「只看文件名」的兜底：同名文件在不同目录极其常见（config.json / index.ts），
 * 那种宽松匹配会让 src/a/config.json 与 lib/b/config.json 被判为同一个文件，进而污染
 * 产物去重、变更行匹配、编辑器挂载判断 —— 表现为「认错文件」。
 * 语义与 renderer-problems.js 的 pathsMatchProblems 保持一致（它一直如此且工作正常）。
 */
function pathsMatch(a, b) {
  if (!a || !b) return false;
  const na = normWritePath(a);
  const nb = normWritePath(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  return na.endsWith('/' + nb) || nb.endsWith('/' + na);
}

function extractPathFieldsFromArgsBrief(brief) {
  const out = {};
  const raw = String(brief || '').trim();
  if (!raw) return out;
  const filePath = raw.match(/"filePath"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  if (filePath) out.filePath = filePath[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  const path = raw.match(/"path"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  if (path) out.path = path[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  return out;
}

function resolveToolArgsFromTrace(tool) {
  if (!tool) return {};
  const pickArgs = (obj) => {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
    return Object.keys(obj).length ? { ...obj } : null;
  };
  const args = pickArgs(tool.toolArgs) || pickArgs(tool.args);
  if (args) {
    if (!args.filePath && args.path) args.filePath = args.path;
    if (!args.filePath && args.file) args.filePath = args.file;
    if (!args.filePath && args.filename) args.filePath = args.filename;
    return args;
  }
  const brief = String(tool.argsBrief || '').trim();
  if (brief.startsWith('{') || brief.startsWith('[')) {
    try {
      const parsed = JSON.parse(brief);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        if (!parsed.filePath && parsed.path) parsed.filePath = parsed.path;
        return parsed;
      }
    } catch {
      const partial = extractPathFieldsFromArgsBrief(brief);
      if (partial.filePath || partial.path) return partial;
    }
  } else if (brief && isEditToolName(tool.name)) {
    const pathOnly = brief.replace(/\s+→[\s\S]*$/, '').replace(/^\((.*)\)$/, '$1').trim();
    if (pathOnly && !/[\r\n]/.test(pathOnly)) return { filePath: pathOnly };
  }
  return {};
}

window.normWritePath = normWritePath;
window.pathsMatch = pathsMatch;
window.resolveToolArgsFromTrace = resolveToolArgsFromTrace;
window.extractPathFieldsFromArgsBrief = extractPathFieldsFromArgsBrief;
