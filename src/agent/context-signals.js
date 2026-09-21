'use strict';
/**
 * 「消息结构信号 → 是否注入代码 / 是否自动检索」判定的唯一来源（纯函数）。
 *
 * Main（src/agent/system-prompt-prep.js）直接 require；
 * Renderer 经 src/renderer/agent/agent-bundle-entry.js 镜像到 window，
 * 供 renderer-editor-context.js / renderer-agent-system-message.js 消费。
 *
 * 编辑器状态一律由调用方以 snapshot.editor = { hasActiveFile, hasSelection, hasArtifact }
 * 传入（Renderer 读 Monaco、Main 读上报快照），本模块不含任何平台分支或关键词表。
 * 曾与 renderer-context-engine.js 各存一份、靠注释维系一致，现已收敛到这里。
 */
const { AGENT_LIMITS_DEFAULTS } = require('./agent-limits');

function textHasCodebaseMention(text) {
  return /(^|\s)@Codebase\b/i.test(String(text || ''));
}

function extractPathHintsFromText(text) {
  const t = String(text || '');
  const paths = [];
  const re =
    /(?:^|[\s"'`(])((?:[\w.-]+\/)+[\w.-]+\.\w{1,8}|[A-Za-z]:\\(?:[^\\:\n"]+\\)*[^\\:\n"]+\.\w{1,8})(?=[\s"'`,]|$)/gi;
  let m;
  while ((m = re.exec(t))) {
    const p = String(m[1] || '').trim();
    if (p && !paths.includes(p)) paths.push(p);
  }
  return paths.slice(0, 6);
}

function shouldInjectCodeContext(userQuery, snapshot = {}) {
  const t = String(userQuery || '').trim();
  if (!t) return false;
  if (textHasCodebaseMention(t)) return true;
  if (extractPathHintsFromText(t).length) return true;
  if (snapshot.forceCodeContext === true) return true;
  const ed = snapshot.editor || {};
  if (snapshot.includeEditor !== false) {
    if (ed.hasActiveFile && ed.hasSelection) return true;
    if (ed.hasArtifact) return true;
  }
  return false;
}

function shouldAutoCodebaseSearch(userQuery, workspaceInfo, editor) {
  if (!workspaceInfo || !workspaceInfo.workspacePath) return false;
  if (workspaceInfo.kind === 'ssh' && !workspaceInfo.sshConnected) return false;
  const q = String(userQuery || '').trim();
  if (!q || q.length < 4) return false;
  if (textHasCodebaseMention(q)) return false;
  if (editor && (editor.hasActiveFile || editor.hasArtifact)) return false;
  return shouldInjectCodeContext(q, { workspaceInfo, includeEditor: false, editor });
}

function formatCodebaseBlock(query, data, snippetMax, label) {
  const results = Array.isArray(data && data.results) ? data.results : [];
  const mode = data && data.vectorSearch ? '向量+全文' : data && data.grepFallback ? 'grep' : '全文/词元';
  const head = label || '【相关代码 · 自动检索】';
  if (!results.length) return '';
  const maxSnip = snippetMax || AGENT_LIMITS_DEFAULTS.codebaseSnippetMax;
  const lines = results.map((r, i) => {
    const loc = `${r.path || ''}:${r.startLine || 1}-${r.endLine || r.startLine || 1}`;
    const snippet = String(r.snippet || '').trim().slice(0, maxSnip);
    return `### ${i + 1}. ${loc}\n${snippet}`;
  });
  return [head, `查询：${query}`, `模式：${mode}`, `候选：${data.totalCandidates ?? results.length}`, '', ...lines].join(
    '\n'
  );
}

function extractCodebasePathsFromBlock(block) {
  const paths = [];
  const re = /^###\s+\d+\.\s+([^:\n]+):/gm;
  let m;
  while ((m = re.exec(String(block || '')))) {
    paths.push(m[1].trim());
  }
  return paths;
}

module.exports = {
  textHasCodebaseMention,
  extractPathHintsFromText,
  shouldInjectCodeContext,
  shouldAutoCodebaseSearch,
  formatCodebaseBlock,
  extractCodebasePathsFromBlock
};
