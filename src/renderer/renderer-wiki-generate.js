/* global window, gatewayCall, gwState, fetchChatCompletion, streamChatCompletion,
   resolveComposerModelForSend, getTextModelId, getCustomModelApiConfig, settings */
'use strict';

const WIKI_GEN_SLUG = 'knowledge-base';
const WIKI_GEN_TITLE = '项目知识库';

function isWikiAbortError(err) {
  return !!(err && (err.name === 'AbortError' || err.code === 'ABORT_ERR'));
}

function throwWikiAborted(signal) {
  if (signal && signal.aborted) {
    const err = new Error('已取消');
    err.name = 'AbortError';
    throw err;
  }
}

function wikiWsExtra(workspacePath) {
  const root = String(workspacePath || '').trim();
  return root ? { runWorkspaceRoot: root } : {};
}

async function wikiReadFile(relPath, maxBytes, workspacePath, signal) {
  throwWikiAborted(signal);
  if (!gwState || !gwState.authed) return '';
  try {
    const r = await gatewayCall('fs.read_file', {
      filePath: relPath,
      maxBytes: maxBytes || 12000,
      ...wikiWsExtra(workspacePath)
    });
    throwWikiAborted(signal);
    if (!r || r.encoding === 'base64') return '';
    return String(r.data || '');
  } catch (err) {
    if (isWikiAbortError(err)) throw err;
    return '';
  }
}

async function wikiListNames(dirPath, limit, workspacePath, signal) {
  throwWikiAborted(signal);
  try {
    const listing = await gatewayCall('fs.list_dir', {
      dirPath: dirPath || '.',
      ...wikiWsExtra(workspacePath)
    });
    throwWikiAborted(signal);
    return (listing || [])
      .filter((e) => e && e.name && !String(e.name).startsWith('.'))
      .slice(0, limit || 40)
      .map((e) => (e.isDirectory ? `${e.name}/` : e.name));
  } catch (err) {
    if (isWikiAbortError(err)) throw err;
    return [];
  }
}

/**
 * 收集有限工作区快照，供模型生成 Wiki。
 * @param {string} workspacePath
 * @param {{ signal?: AbortSignal }} [opts]
 */
async function buildWikiProjectSnapshot(workspacePath, opts = {}) {
  const signal = opts && opts.signal;
  const chunks = [];
  chunks.push(`工作区：${workspacePath}`);

  const rootNames = await wikiListNames('.', 48, workspacePath, signal);
  if (rootNames.length) chunks.push(`【根目录】\n${rootNames.join('\n')}`);

  for (const dir of rootNames.filter((n) => n.endsWith('/')).slice(0, 8)) {
    throwWikiAborted(signal);
    const child = await wikiListNames(dir.replace(/\/$/, ''), 24, workspacePath, signal);
    if (child.length) chunks.push(`【${dir}】\n${child.join('\n')}`);
  }

  for (const name of [
    'README.md',
    'package.json',
    'AGENTS.md',
    'dieyun.md',
    '.dieyun/AGENTS.md',
    'Cargo.toml',
    'go.mod',
    'pyproject.toml'
  ]) {
    throwWikiAborted(signal);
    const text = await wikiReadFile(name, 8000, workspacePath, signal);
    if (text) chunks.push(`【${name}】\n${text.slice(0, 3500)}`);
  }

  try {
    throwWikiAborted(signal);
    const st = await gatewayCall('codebase.status', { workspaceRoot: workspacePath }, 20000);
    throwWikiAborted(signal);
    if (st) {
      chunks.push(
        `【代码索引】indexed=${!!st.indexed} files=${st.fileCount || 0} chunks=${st.chunkCount || 0} vectors=${st.vectorCount || 0}`
      );
    }
  } catch (err) {
    if (isWikiAbortError(err)) throw err;
  }

  try {
    throwWikiAborted(signal);
    const st = await gatewayCall('graph.status', { workspaceRoot: workspacePath }, 20000);
    throwWikiAborted(signal);
    if (st) {
      chunks.push(
        `【结构索引】indexed=${!!st.indexed} files=${st.fileCount || 0} symbols=${st.symbolCount || 0} edges=${st.edgeCount || 0} calls=${st.callCount || 0}`
      );
    }
  } catch (err) {
    if (isWikiAbortError(err)) throw err;
  }

  try {
    throwWikiAborted(signal);
    const hits = await gatewayCall(
      'codebase.search',
      { workspaceRoot: workspacePath, query: 'export function OR class OR module.exports', limit: 6, autoIndex: false },
      45000
    );
    throwWikiAborted(signal);
    const rows = hits && Array.isArray(hits.results) ? hits.results : [];
    if (rows.length) {
      const lines = rows.slice(0, 6).map((h) => `- ${h.path}:${h.startLine} ${String(h.snippet || '').slice(0, 120)}`);
      chunks.push(`【代码检索样例】\n${lines.join('\n')}`);
    }
  } catch (err) {
    if (isWikiAbortError(err)) throw err;
  }

  try {
    throwWikiAborted(signal);
    const hits = await gatewayCall(
      'graph.symbol_search',
      { workspaceRoot: workspacePath, query: 'create', limit: 12 },
      30000
    );
    throwWikiAborted(signal);
    const rows = hits && Array.isArray(hits.results) ? hits.results : [];
    if (rows.length) {
      const lines = rows
        .slice(0, 12)
        .map((h) => `- ${h.kind || 'sym'} ${h.name || h.qualifiedName} @ ${h.path}:${h.startLine}`);
      chunks.push(`【符号样例】\n${lines.join('\n')}`);
    }
  } catch (err) {
    if (isWikiAbortError(err)) throw err;
  }

  return chunks.join('\n\n').slice(0, 16000);
}

function extractJsonObject(text) {
  const raw = String(text || '').trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)```/i.exec(raw);
  const body = fence ? fence[1].trim() : raw;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(body.slice(start, end + 1));
  } catch {
    return null;
  }
}

function extractGeneratedMarkdown(parsed, rawText) {
  if (parsed && typeof parsed.body === 'string' && parsed.body.trim()) {
    return parsed.body.trim();
  }
  if (parsed && typeof parsed.markdown === 'string' && parsed.markdown.trim()) {
    return parsed.markdown.trim();
  }
  if (parsed && Array.isArray(parsed.pages) && parsed.pages.length) {
    const parts = [];
    for (const row of parsed.pages) {
      if (!row) continue;
      const title = String(row.title || row.slug || '').trim();
      const body = String(row.body || row.markdown || '').trim();
      if (!body) continue;
      if (title) parts.push(`## ${title}\n\n${body}`);
      else parts.push(body);
    }
    if (parts.length) return parts.join('\n\n---\n\n');
  }
  const raw = String(rawText || '').trim();
  if (!raw) return '';
  if (raw.startsWith('{') || /^```json/i.test(raw)) return '';
  const fence = /^```(?:markdown|md)?\s*([\s\S]*?)```/i.exec(raw);
  return (fence ? fence[1] : raw).trim();
}

function titleFromWikiMarkdown(body, fallback) {
  const m = /^#\s+(.+)\s*$/m.exec(String(body || ''));
  if (m && m[1].trim()) return m[1].trim();
  return fallback || WIKI_GEN_TITLE;
}

/** 是否已有 mermaid flowchart / graph 架构图 */
function hasArchitectureFlowchart(md) {
  return /```\s*mermaid\b[\s\S]*?\b(?:flowchart|graph)\b[\s\S]*?```/i.test(String(md || ''));
}

/**
 * 从快照抽几个顶层目录名，拼一份保底架构图。
 * @param {string} snapshot
 */
function buildFallbackArchitectureSection(snapshot) {
  const dirs = [];
  const rootBlock = /【根目录】\n([\s\S]*?)(?=\n\n【|\n*$)/.exec(String(snapshot || ''));
  if (rootBlock) {
    for (const line of rootBlock[1].split('\n')) {
      const name = String(line || '').trim();
      if (!name.endsWith('/')) continue;
      const id = name
        .replace(/\/$/, '')
        .replace(/[^a-zA-Z0-9_-]+/g, '_')
        .replace(/^_+|_+$/g, '') || `dir${dirs.length + 1}`;
      if (!/^[A-Za-z_]/.test(id)) continue;
      dirs.push({ id: id.slice(0, 24), label: name.replace(/\/$/, '') });
      if (dirs.length >= 6) break;
    }
  }
  const nodes = [
    'User["用户与 Agent"]',
    'Entry["应用入口"]',
    ...dirs.map((d) => `${d.id}["${String(d.label).replace(/"/g, '')}"]`),
    'Out["产出与能力"]'
  ];
  const edges = ['User --> Entry'];
  if (dirs.length) {
    for (const d of dirs) edges.push(`Entry --> ${d.id}`);
    edges.push(`${dirs[0].id} --> Out`);
  } else {
    edges.push('Entry --> Out');
  }
  return [
    '## 架构流程图',
    '',
    '```mermaid',
    'flowchart TB',
    ...nodes.map((n) => `    ${n}`),
    '',
    ...edges.map((e) => `    ${e}`),
    '```',
    ''
  ].join('\n');
}

/**
 * 硬性保证正文含架构流程图；缺失则插入保底图。
 * @param {string} body
 * @param {string} snapshot
 */
function ensureArchitectureFlowchart(body, snapshot) {
  let md = String(body || '').trim();
  if (!md) return md;
  if (hasArchitectureFlowchart(md)) {
    if (!/^##\s*架构流程图\s*$/m.test(md)) {
      // 有图但无标题：在首个 mermaid 前补标题
      md = md.replace(/(```\s*mermaid\b)/i, '## 架构流程图\n\n$1');
    }
    return md;
  }
  const section = buildFallbackArchitectureSection(snapshot);
  if (/^##\s*项目概览\s*$/m.test(md)) {
    return md.replace(/(##\s*项目概览\b[\s\S]*?)(?=\n##\s+|\s*$)/, (block) => `${block.trimEnd()}\n\n${section}`);
  }
  if (/^##\s*/m.test(md)) {
    return md.replace(/\n##\s+/, `\n\n${section}\n## `);
  }
  return `${md}\n\n${section}`;
}

/**
 * 流式过程中抽出可读正文（兼容 JSON body 半成品或纯 Markdown）。
 * @param {string} raw
 */
function extractStreamingWikiText(raw) {
  const s = String(raw || '');
  if (!s) return '';
  const trimmed = s.trimStart();
  if (!trimmed.startsWith('{') && !/^```json/i.test(trimmed)) {
    return s.replace(/^```(?:markdown|md)?\r?\n?/i, '');
  }
  const key = /"body"\s*:\s*"/;
  const km = key.exec(s);
  if (!km) return '';
  let i = km.index + km[0].length;
  let out = '';
  while (i < s.length) {
    const ch = s[i];
    if (ch === '\\' && i + 1 < s.length) {
      const n = s[i + 1];
      if (n === 'n') out += '\n';
      else if (n === 'r') out += '\r';
      else if (n === 't') out += '\t';
      else if (n === '"' || n === '\\' || n === '/') out += n;
      else out += n;
      i += 2;
      continue;
    }
    if (ch === '"') break;
    out += ch;
    i += 1;
  }
  return out;
}

/**
 * @param {string} workspacePath
 * @param {{ signal?: AbortSignal, onProgress?: (msg: string) => void, onStream?: (text: string) => void }} opts
 * @returns {Promise<{ slug: string, title: string, path?: string, body?: string }>}
 */
async function generateWikiKnowledgeBase(workspacePath, opts = {}) {
  const root = String(workspacePath || '').trim();
  if (!root) throw new Error('未选工作区');
  if (!gwState || !gwState.authed) throw new Error('Gateway 未连接');

  const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : () => {};
  const onStream = typeof opts.onStream === 'function' ? opts.onStream : () => {};
  const throwIfAborted = () => throwWikiAborted(opts.signal);

  onProgress('扫描项目…');
  await gatewayCall('wiki.ensure', { workspacePath: root }).catch(() => {});
  throwIfAborted();
  const snapshot = await buildWikiProjectSnapshot(root, { signal: opts.signal });
  throwIfAborted();
  if (!snapshot || snapshot.length < 40) throw new Error('无法读取工作区内容');

  let model = '';
  let apiConfig = null;
  if (typeof resolveComposerModelForSend === 'function') {
    const pick = resolveComposerModelForSend('生成项目知识库文档', {});
    model = pick && pick.model ? pick.model : '';
    apiConfig = pick && pick.apiConfig ? pick.apiConfig : null;
  }
  if (!model && typeof getTextModelId === 'function') model = getTextModelId(settings);
  if (!apiConfig && typeof getCustomModelApiConfig === 'function') {
    apiConfig = getCustomModelApiConfig();
  }
  if (!model || !apiConfig || !apiConfig.baseUrl) {
    throw new Error('未配置可用的文本模型');
  }
  onProgress('模型生成文档…');
  onStream(''); // 进入流式阶段：立刻显示等候光标，避免空白像卡住
  const messages = [
    {
      role: 'system',
      content:
        '你是项目文档生成器。根据快照直接输出一份完整的项目知识库 Markdown。' +
        '不要输出 JSON、不要用代码围栏包裹全文、不要输出 HTML。' +
        '第一行必须是一级标题（# 项目名或「项目知识库」）；' +
        '须包含这些二级标题：## 项目概览、## 架构流程图、## 模块说明、## 接口文档、## 依赖与调用链；' +
        '【硬性要求】「## 架构流程图」下必须有一个 ```mermaid flowchart TB ... ``` 代码块，画出项目主要模块/数据流关系；' +
        '节点用英文 ID、中文标签一律双引号（如 UI["界面"]），连线只用 A --> B 或 A -->|"说明"| B；不要 style/classDef/click；' +
        '缺架构流程图视为不合格。使用标题、列表、表格；勿编造不存在的路径/脚本；信息不足时写明“根据目录推断”。'
    },
    {
      role: 'user',
      content: `请为该工作区生成一份项目知识库文档（必须含架构流程图）。\n\n${snapshot}`
    }
  ];

  async function runLlmOnce(msgs, stream = true) {
    throwIfAborted();
    let text = '';
    if (streamFn && stream) {
      const result = await streamFn(
        {
          model,
          messages: msgs,
          temperature: 0.25,
          max_tokens: 7000,
          _apiBaseUrl: apiConfig.baseUrl,
          _apiKey: apiConfig.apiKey
        },
        opts.signal,
        (delta) => {
          text = delta && delta.content != null ? String(delta.content) : '';
          const display = extractStreamingWikiText(text) || text;
          onStream(display);
          if (text.length > 0) onProgress(`模型生成文档… ${text.length} 字`);
        },
        {
          maxWaitMs: 4 * 60 * 1000,
          onReconnectWait: (info) => {
            const sec = Math.max(1, Math.round((info.waitMs || 0) / 1000));
            onProgress(`模型连接中断，${sec}s 后重试（第 ${info.attempt} 次）…`);
          }
        }
      );
      text = result && result.content != null ? String(result.content) : text;
      throwIfAborted();
      return text;
    }
    const chat =
      typeof fetchChatCompletion === 'function'
        ? fetchChatCompletion
        : typeof window.fetchChatCompletion === 'function'
          ? window.fetchChatCompletion
          : null;
    if (!chat) throw new Error('LLM 接口不可用');
    text = await chat({
      model,
      apiConfig,
      temperature: 0.25,
      max_tokens: 7000,
      signal: opts.signal,
      messages: msgs
    });
    throwIfAborted();
    onStream(extractStreamingWikiText(text) || text);
    return text;
  }

  const streamFn =
    typeof streamChatCompletion === 'function'
      ? streamChatCompletion
      : typeof window.streamChatCompletion === 'function'
        ? window.streamChatCompletion
        : null;

  let llmText = await runLlmOnce(messages, true);
  throwIfAborted();

  const parsed = extractJsonObject(llmText);
  let body = extractGeneratedMarkdown(parsed, llmText);
  if (!body) body = extractStreamingWikiText(llmText).trim();
  if (!body) {
    throw new Error('模型未返回有效文档，请重试或检查模型配置');
  }

  if (!hasArchitectureFlowchart(body)) {
    onProgress('补全架构流程图…');
    try {
      const repairText = await runLlmOnce(
        [
          {
            role: 'system',
            content:
              '你只负责补「## 架构流程图」段落。只输出该二级标题及其下的一个 ```mermaid flowchart TB``` 代码块，不要其它章节。' +
              '英文节点 ID、中文双引号标签、简单 A --> B。'
          },
          {
            role: 'user',
            content:
              `现有文档缺少架构流程图。请根据项目快照补全。\n\n【现有文档】\n${body.slice(0, 4000)}\n\n【快照】\n${snapshot.slice(0, 8000)}`
          }
        ],
        false
      );
      const repairBody = extractGeneratedMarkdown(extractJsonObject(repairText), repairText) ||
        extractStreamingWikiText(repairText).trim() ||
        String(repairText || '').trim();
      if (hasArchitectureFlowchart(repairBody)) {
        if (/^##\s*架构流程图\b/m.test(repairBody)) {
          body = `${body.trim()}\n\n${repairBody.trim()}\n`;
        } else {
          body = `${body.trim()}\n\n## 架构流程图\n\n${repairBody.trim()}\n`;
        }
      }
    } catch (err) {
      if (isWikiAbortError(err)) throw err;
      // 下方 ensure 会注入保底图
    }
  }

  throwIfAborted();
  body = ensureArchitectureFlowchart(body, snapshot);
  if (!hasArchitectureFlowchart(body)) {
    throw new Error('知识库缺少架构流程图（硬性要求）');
  }
  onStream(body);

  const title =
    (parsed && String(parsed.title || '').trim()) || titleFromWikiMarkdown(body, WIKI_GEN_TITLE);

  throwIfAborted();
  onProgress('写入知识库…');
  const res = await gatewayCall('wiki.write', {
    workspacePath: root,
    runWorkspaceRoot: root,
    slug: WIKI_GEN_SLUG,
    title,
    body
  });
  throwIfAborted();
  onProgress('完成');
  return {
    slug: WIKI_GEN_SLUG,
    title,
    body,
    path: (res && res.path) || `.dieyun/wiki/${WIKI_GEN_SLUG}.md`
  };
}

window.buildWikiProjectSnapshot = buildWikiProjectSnapshot;
window.generateWikiKnowledgeBase = generateWikiKnowledgeBase;
window.extractStreamingWikiText = extractStreamingWikiText;
window.hasArchitectureFlowchart = hasArchitectureFlowchart;
window.ensureArchitectureFlowchart = ensureArchitectureFlowchart;
window.WIKI_GEN_SLUG = WIKI_GEN_SLUG;
