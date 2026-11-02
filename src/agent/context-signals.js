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

/**
 * 是否值得拿**用户这句话**去自动检索代码库。
 *
 * 这里曾经要求「用户已经点名了某个文件/路径/选区」才允许检索 —— 而那正是
 * `request_snapshots` 里 947 轮请求、0 次代码注入的直接原因：用户给了路径时，
 * 模型读那个文件就够了，语义检索本来就不需要；用户没给路径时（真正需要检索的场景）
 * 反而完全不放行。索引于是「建了没人用」。
 *
 * 现在的判定全部是**结构信号**（禁止意图关键词表）：
 *  - 有工作区、SSH 已连接（`workspaceInfo`）——没工作区就没有索引可查；
 *  - 消息长度 >= 4 ——太短的消息没有可检索词元（Rust 侧只收 >=2 字符词元）；
 *  - 没有 `@Codebase` ——显式提及走 explicit 分支（不同 limit 与标签）；
 *  - 编辑器里已有打开文件/产物 ——那部分内容已经随「当前关注文件」进上下文，再检索是重复。
 *
 * 放行之后**是否真的注入**由召回决定：检索无命中就返回空块（`formatCodebaseBlock` 空结果返回 ''），
 * 不再靠前置关键词猜测。
 */
function shouldAutoCodebaseSearch(userQuery, workspaceInfo, editor) {
  if (!workspaceInfo || !workspaceInfo.workspacePath) return false;
  if (workspaceInfo.kind === 'ssh' && !workspaceInfo.sshConnected) return false;
  const q = String(userQuery || '').trim();
  if (!q || q.length < 4) return false;
  if (textHasCodebaseMention(q)) return false;
  if (editor && (editor.hasActiveFile || editor.hasArtifact)) return false;
  return true;
}

/**
 * 代码召回块。
 *
 * **0 命中必须说清是「哪种 0」**：旧实现命中为空直接返回 `''`，于是
 * 「本工作区没建索引」「建了但没建向量（中文自然语言基本不会命中子串通道）」
 * 「确实没有相关代码」在模型眼里长得一模一样——它只会得出最后一个结论然后放弃检索。
 * 这三种状态的价格差着几十倍，必须分开说；只在第三种返回空。
 */
function formatCodebaseBlock(query, data, snippetMax, label) {
  const results = Array.isArray(data && data.results) ? data.results : [];
  // v4 起词法通道是子串扫描（没有 FTS，也没有 grep 兜底），两态即可
  const vector = !!(data && data.vectorSearch);
  const mode = vector ? '向量+子串' : '子串';
  const head = label || '【相关代码 · 自动检索】';
  if (!results.length) {
    if (data && data.needsIndex) {
      return `${head}\n查询：${query}\n状态：本工作区还没有可检索的代码索引，改用 grep / host_exec 直接查。`;
    }
    if (!vector) {
      return `${head}\n查询：${query}\n状态：0 命中。本工作区索引未建向量，中文自然语言查询在子串通道上基本不会命中，改用 grep / host_exec。`;
    }
    return '';
  }
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
