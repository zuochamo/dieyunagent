'use strict';

const fs = require('fs');
const path = require('path');
const {
  isVirtualWorkspacePath,
  hostSidecarRoots,
  workspaceRelativeSpillPath
} = require('./host-sidecar');

const SPILL_CHAR_THRESHOLD = 8192;
const PREVIEW_LINES = 40;

function resolveSpillRoot(workspacePath, userDataPath) {
  const ws = workspacePath ? String(workspacePath).trim() : '';
  if (ws && !isVirtualWorkspacePath(ws)) {
    return path.join(ws, '.dieyun', 'tool-output');
  }
  return hostSidecarRoots(userDataPath).toolOutput;
}

function tailLines(text, maxLines) {
  const lines = String(text || '').split(/\r?\n/);
  if (lines.length <= maxLines) return lines.join('\n');
  return lines.slice(-maxLines).join('\n');
}

/** 取头部若干行：代码体/列表型输出里，开头的信息最相关（tailLines 会丢掉函数签名） */
function headLines(text, maxLines) {
  const lines = String(text || '').split(/\r?\n/);
  if (lines.length <= maxLines) return lines.join('\n');
  return lines.slice(0, maxLines).join('\n');
}

function extractSpillText(name, payload) {
  if (!payload || typeof payload !== 'object') return '';
  const parts = [];
  if (name === 'host_exec') {
    if (payload.stdout) parts.push(String(payload.stdout));
    if (payload.stderr) parts.push(String(payload.stderr));
  } else if (name === 'web_fetch') {
    if (payload.text) parts.push(String(payload.text));
    else if (payload.content) parts.push(String(payload.content));
  } else if (name === 'browser_snapshot') {
    if (payload.textPreview) parts.push(String(payload.textPreview));
    else if (payload.text) parts.push(String(payload.text));
  } else if (String(name).startsWith('mcp_')) {
    if (payload.content) parts.push(String(payload.content));
  } else if (name === 'codebase_search' && Array.isArray(payload.results)) {
    parts.push(JSON.stringify(payload.results, null, 2));
  } else if (name === 'grep' && Array.isArray(payload.matches)) {
    parts.push(JSON.stringify(payload.matches, null, 2));
  } else if (name === 'glob' && Array.isArray(payload.files)) {
    parts.push(JSON.stringify(payload.files, null, 2));
  } else if (name === 'read_symbol' && typeof payload.code === 'string') {
    parts.push(payload.code);
  } else if (payload.data && typeof payload.data === 'string') {
    parts.push(payload.data);
  }
  return parts.join('\n').trim();
}

/**
 * 大工具输出写入 .dieyun/tool-output/，返回带 preview 的精简对象。
 */
function spillToolOutputIfLarge(name, payload, opts = {}) {
  if (!payload || typeof payload !== 'object' || payload.error) return payload;
  const text = extractSpillText(name, payload);
  if (!text || text.length < SPILL_CHAR_THRESHOLD) return payload;

  const runKey = String(opts.runId || opts.sessionId || 'run').replace(/[^\w.-]+/g, '_');
  const seq = Number(opts.spillSeq) || 0;
  const root = resolveSpillRoot(opts.workspacePath, opts.userDataPath);
  const dir = path.join(root, runKey);
  const safeName = String(name).replace(/[^\w.-]+/g, '_').slice(0, 48);
  const fileName = `${safeName}-${seq}.log`;
  const absPath = path.join(dir, fileName);

  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(absPath, text, 'utf8');
  } catch (e) {
    return {
      ...payload,
      spillFailed: true,
      preview: tailLines(text, PREVIEW_LINES),
      bytes: text.length,
      note: `输出过大但写入文件失败：${e.message || e}`
    };
  }

  let relPath = absPath;
  const ws = opts.workspacePath ? String(opts.workspacePath).trim() : '';
  if (isVirtualWorkspacePath(ws)) {
    relPath = workspaceRelativeSpillPath(runKey, fileName);
  } else if (ws && absPath.startsWith(ws)) {
    relPath = absPath.slice(ws.length).replace(/^[/\\]+/, '');
  }

  const out = { ...payload };
  if (name === 'host_exec') {
    delete out.stdout;
    delete out.stderr;
  } else if (name === 'web_fetch') {
    delete out.text;
    delete out.content;
  } else if (name === 'browser_snapshot') {
    delete out.textPreview;
    delete out.text;
  } else if (String(name).startsWith('mcp_')) {
    delete out.content;
    delete out.raw;
  } else if (name === 'codebase_search') {
    out.results = (payload.results || []).slice(0, 3);
    out.resultsTruncated = true;
  } else if (name === 'grep') {
    out.matches = (payload.matches || []).slice(0, 8);
    out.matchesTruncated = true;
  } else if (name === 'glob') {
    out.files = (payload.files || []).slice(0, 20);
    out.filesTruncated = true;
  } else if (name === 'read_symbol') {
    // 符号体开头是签名，比结尾重要
    out.code = headLines(String(payload.code || ''), PREVIEW_LINES);
    out.codeTruncated = true;
  } else if (out.data && typeof out.data === 'string') {
    delete out.data;
  }

  out.outputFile = relPath;
  out.outputBytes = text.length;
  out.preview =
    name === 'read_symbol' ? headLines(text, PREVIEW_LINES) : tailLines(text, PREVIEW_LINES);
  out.note =
    '完整输出已写入 outputFile；需要更多内容请 fs_read_file 读取该文件（可指定 offset/maxBytes）。';
  return out;
}

module.exports = {
  SPILL_CHAR_THRESHOLD,
  spillToolOutputIfLarge,
  resolveSpillRoot,
  tailLines,
  headLines
};
