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

function pathsMatch(a, b) {
  if (!a || !b) return false;
  const na = normWritePath(a);
  const nb = normWritePath(b);
  if (na === nb) return true;
  if (na.endsWith('/' + nb) || nb.endsWith('/' + na)) return true;
  const ba = na.includes('/') ? na.slice(na.lastIndexOf('/') + 1) : na;
  const bb = nb.includes('/') ? nb.slice(nb.lastIndexOf('/') + 1) : nb;
  return !!(ba && ba === bb);
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
