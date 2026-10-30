# [Renderer] 正式回复不渲染 Markdown（仅 Mermaid 特判），表格/粗体/标题全部显示为源码

- 状态：待修复
- 严重度：中高（影响所有结构化回答的可读性）
- 客户端：叠云 Agent 桌面端（Electron / Windows）
- 代码基线：`C:\Users\admin\AppData\Local\Programs\dieyunagent\resources\app.asar`（2026-10-30 解包，客户端版本以安装包为准）
- 提出：用户（日报表格无法阅读）／定位与复现：Agent

## TL;DR

正式回复气泡 `.msg-answer` 的正文只有两条渲染路径：**含 ```mermaid 块 → 走 SVG 渲染；否则 → `textContent` 纯文本直出**。项目里没有任何 Markdown 解析器，也没有生成 `<table>` 的回答区代码，所以 GFM 表格、`**粗体**`、`` `行内代码` ``、`#` 标题、列表全部以源码形式显示。

修复思路：在 `appendTextSegment()` 这一个文本出口接入 Markdown 渲染，并把「无 mermaid 直接 return false」的守卫改成「无 mermaid 但有 Markdown 时也渲染」。本文附了可直接使用的无依赖渲染器（已自测 10/10）。

## 现象

- 回复里写 GFM 表格 → 显示为 `| 序号 | 客户 |` 与 `| --- | --- |` 的竖线文本，宽表折行严重，无法对齐阅读；
- `**加粗**`、`` `代码` ``、`## 标题`、`- 列表` 全部原样露出符号；
- 同一段回复里的 ```mermaid 代码块**能**正常渲染为流程图 —— 说明不是「渲染管线整体崩了」，而是「按块特判 Mermaid」。

## 复现步骤

1. 让 Agent 正式回复以下内容：

```md
| 名称 | 数值 |
| --- | --- |
| 测试行 | 123 |

**加粗** 与 `行内代码`

## 小标题

- 列表项
```

2. 观察回复气泡：表格为竖线源码，加粗带星号，标题带 `#`。
3. 对照：同一回复追加一个 ```mermaid 块 → 图正常渲染成 SVG，表格仍是源码。

**实际**：除 Mermaid 外全部纯文本。
**期望**：表格渲染为真实 `<table>`，粗体/行内代码/标题/列表正常排版。

## 根因与加载链路

### 1) 正式版实际加载的是打包产物

`/src/main/window-tray.js` L11-25：

```js
function resolveRendererIndexHtml(opts = {}) {
  const forceLegacy = env.DIEYUN_LEGACY_RENDERER_SCRIPTS === '1' || env.DEV_LEGACY_SCRIPTS === '1';
  const forceBundle = env.DIEYUN_USE_RENDERER_BUNDLE === '1';
  const bundled = path.join(rendererDir, 'index.bundled.html');
  const bundleJs = path.join(rendererDir, 'dist', 'bundle.js');
  const preferBundle = forceBundle || isPackaged;
  if (!forceLegacy && preferBundle && existsSync(bundled) && existsSync(bundleJs)) {
    return bundled;              // ← 安装版走这里
  }
  return path.join(rendererDir, 'index.html');
}
```

即：**安装版（isPackaged=true）加载 `index.bundled.html` + `dist/bundle.js`**；开发态（或设 `DIEYUN_LEGACY_RENDERER_SCRIPTS=1`）才逐文件加载 `index.html`。两个入口的渲染逻辑一一对应，改源码后必须重新构建 bundle 才会生效。

### 2) 唯一富文本入口只处理 Mermaid

`/src/renderer/renderer-mermaid.js`（源码，bundle 内对应 line 32）：

```js
async function renderAssistantAnswerContent(answerEl, content) {   // L348
  const text = String(content || '');
  if (!hasMermaidBlock(text)) return false;                        // L350 ← 无 mermaid 直接放弃
  const segments = splitMermaidBlocks(text);
  if (!segments.some((s) => s.type === 'mermaid')) return false;    // L353 ← 无 mermaid 段再放弃一次
  answerEl.replaceChildren();
  answerEl.classList.add('msg-answer-rich');                       // white-space: normal
  answerEl.dataset.rawContent = text;
  for (const seg of segments) {
    if (seg.type === 'text') { appendTextSegment(answerEl, seg.value); continue; }  // L363
    // …mermaid 段渲染 SVG
  }
}
```

文本出口（唯一的「写正文」函数）：

```js
function appendTextSegment(container, text) {                      // L205
  const chunk = String(text || '').replace(/^\s+|\s+$/g, '');
  if (!chunk) return;
  const el = document.createElement('div');
  el.className = 'msg-answer-text';
  el.textContent = chunk;                                          // L210 ← 纯文本，不解析 Markdown
  container.appendChild(el);
}
```

### 3) 调用点：无 mermaid 时 `textContent` 兜底

`/src/renderer/renderer-thinking-trace.js` L387-399：

```js
if (content && !hitRoundLimit) {
  const answer = document.createElement('div');
  answer.className = 'msg-answer';
  div.appendChild(answer);
  if (typeof renderAssistantAnswerContent === 'function' && hasMermaidBlock(content)) {  // L392
    void renderAssistantAnswerContent(answer, content).then((rendered) => {
      if (!rendered) answer.textContent = content;
    });
  } else {
    answer.textContent = content;                                  // L397 ← 常规路径：纯文本
    if (content) answer.dataset.rawContent = content;
  }
}
```

`/src/renderer/dist/bundle.js` L125 有同构实现（打包态实际执行此份）。

### 4) 关键词统计（证明「没有解析器」）

在 `dist/bundle.js`（1,123,245 字符）中：

| 关键词 | 命中 | 说明 |
| --- | --- | --- |
| `<table` | 0 | 回答区没有表格生成代码 |
| `marked` / `gfm` / `markdown-it` / `showdown` / `remark` | 0 | 未打包任何 Markdown 解析器 |
| `agent-clarify-table` | 2 | 仅用于 clarify 选项表（第 257 行），**证明表格 DOM 能力本身具备** |
| `renderAssistantAnswerContent` | 5 | 唯一富文本入口，只特判 mermaid |
| `.msg-md-` | 0 | 无 Markdown 专用样式类 |

> 补充：`/src/renderer/renderer-dieyun-md.js` 名字容易误导，它负责「把 dieyun.md 注入系统提示」，与渲染无关。

## 修改锚点一览

| 序 | 文件（源码） | 行 | 内容 |
| --- | --- | --- | --- |
| 1 | `/src/renderer/renderer-mermaid.js` | L205-212 | `appendTextSegment()` —— 文本唯一出口，**主改点** |
| 2 | `/src/renderer/renderer-mermaid.js` | L348-353 | `renderAssistantAnswerContent()` 的两道 mermaid 守卫 |
| 3 | `/src/renderer/renderer-thinking-trace.js` | L392 | 调用点守卫 `hasMermaidBlock(content)` |
| 4 | `/src/renderer/styles.css` | L2765-2774 | `.msg-answer` / `.msg-answer-rich` / `.msg-answer-text`（`pre-wrap` 是源码观感的另一半原因） |
| 5 | `/src/renderer/styles.css` | L3639-3667 | `.agent-clarify-table` 样式，可复用为表格基底 |
| 6 | 构建产物 | `dist/bundle.js` L32 / L125 | 改完源码需重新构建，否则安装版不生效 |
| 7 | 打包入口 | `index.bundled.html` | 构建产物，勿手改 |

## 修复方案 A（推荐：接入 Markdown 渲染）

配套实现见 `issues/mini-markdown-renderer.js`（无依赖，约 190 行，导出 `renderMarkdownToHtml` / `hasAnswerMarkdown` / `MINI_MD_CSS`）。自测结果（`.tmp/test_md.js`）：h1 / strong / inlineCode / table / theadCells / tbodyRows / preKeepsPipe / ul / detect / xss **10 项全 PASS**，含「代码块内 `a|b` 不被误判为表格」与「`<img onerror>` 被转义」。

### 改动 1：`renderer-mermaid.js` 的 `appendTextSegment`（L205）

```js
function appendTextSegment(container, text) {
  const chunk = String(text || '').replace(/^\s+|\s+$/g, '');
  if (!chunk) return;
  const el = document.createElement('div');
  el.className = 'msg-answer-text';
  if (typeof renderMarkdownToHtml === 'function' && hasAnswerMarkdown(chunk)) {
    el.innerHTML = renderMarkdownToHtml(chunk);   // 内部先整体 HTML 转义，再生成受控标签
  } else {
    el.textContent = chunk;                       // 纯文本回答保持原行为
  }
  container.appendChild(el);
}
```

### 改动 2：放宽 `renderAssistantAnswerContent` 守卫（L350-353）

```js
async function renderAssistantAnswerContent(answerEl, content) {
  const text = String(content || '');
  const withMermaid = hasMermaidBlock(text);
  const withMd = typeof hasAnswerMarkdown === 'function' && hasAnswerMarkdown(text);
  if (!withMermaid && !withMd) return false;      // ← 原：if (!hasMermaidBlock(text)) return false;

  const segments = splitMermaidBlocks(text);
  if (withMermaid && !segments.some((s) => s.type === 'mermaid')) return false;  // ← 原：无条件判断
  // 以下不变：replaceChildren / classList.add('msg-answer-rich') / dataset.rawContent / 逐段处理
}
```

### 改动 3：调用点守卫（`renderer-thinking-trace.js` L392）

```js
const wantRich =
  hasMermaidBlock(content) ||
  (typeof hasAnswerMarkdown === 'function' && hasAnswerMarkdown(content));
if (typeof renderAssistantAnswerContent === 'function' && wantRich) {
  void renderAssistantAnswerContent(answer, content).then((rendered) => {
    if (!rendered) answer.textContent = content;
  });
} else {
  answer.textContent = content;
  if (content) answer.dataset.rawContent = content;
}
```

> 注意流式阶段：`updateIncrementalTextContent()`（renderer-thinking-trace-dom.js L70-82）用 `textContent` 增量追加，`renderAssistantAnswerContent` 只在 `loading === false` 后调用。所以「流式纯文本、结束一次性渲染」的现状天然成立，不需要额外改造，代价是结束时有一次性重排（Mermaid 已是同样行为）。

### 改动 4：样式（`styles.css`）

把 `MINI_MD_CSS` 并入 `styles.css`，关键三条：

```css
.msg-md-table-wrap { margin: .6em 0; overflow-x: auto; border: 1px solid var(--border); border-radius: 8px; }
table.msg-md-table { border-collapse: collapse; width: 100%; }
table.msg-md-table th, table.msg-md-table td { padding: .42em .6em; border-bottom: 1px solid var(--border); white-space: nowrap; }
table.msg-md-table th { background: rgba(128,128,128,.1); font-weight: 600; text-align: left; }
```

`.msg-answer-rich { white-space: normal; }` 已存在（L2768），接入后无需再动；`.msg-answer-text` 的 `pre-wrap` 对已渲染的 HTML 无影响，但建议渲染分支改用 `.msg-answer-md` 类避免继承 `pre-wrap` 造成的多余空行。

### 改动 5：重新构建

改完源码需重建 `dist/bundle.js` + `index.bundled.html`（安装版入口）。仅改源码不重建，正式版行为不变，容易误判「改了没用」。

## 修复方案 B（最小改动，不引入渲染器）

只处理三件事，改动量最小：

1. 围栏代码块：` ``` ` 段落包成 `<pre>`，等宽字体、`overflow-x:auto`；
2. GFM 表格：按 `|` 与分隔行识别，生成 `<table class="agent-clarify-table">` 复用已有样式；
3. 行内 `**x**` / `` `x` `` 用正则替换为 `<strong>` / `<code>`。

缺点：标题、列表、引用、链接仍为源码，长期还是方案 A 更完整。

## 附加缺陷：Mermaid 误触发与错误呈现（2026-10-30 10:20 实测补充）

### 现象

在回答的 `text` 代码块里引用「三个反引号 + mermaid」字样（用于讲解语法）时，客户端 `hasMermaidBlock()` 全文命中，把整条回答送进 Mermaid 渲染管线，后面的中文说明被当成图语句解析，气泡顶部出现：

~~~~text
流程图渲染失败：Lexical error on line 2. Unrecognized text.
~~~~

### 已核实：原文并没有丢失（原先设想的建议撤回）

失败分支 `appendMermaidFallback(e, n, i)`（`dist/bundle.js` L32，与 `renderer-mermaid.js` 同名函数）实现为：

~~~~js
function appendMermaidFallback(e, n, i) {
  if (!e) return;
  const o = document.createElement('div');
  o.className = 'msg-mermaid msg-mermaid-error';
  const r = document.createElement('div');
  r.className = 'msg-mermaid-error-title';
  r.textContent = `流程图渲染失败：${formatMermaidError(i)}`;   // 红标题
  const s = document.createElement('pre');
  s.className = 'msg-mermaid-fallback';
  s.textContent = n;                                            // ← 原始文本仍在
  o.appendChild(r);
  o.appendChild(s);
  e.appendChild(o);
}
~~~~

即「红色错误标题 + `<pre>` 原文」两者都输出，用户不会丢内容。因此**「失败时应显示原文」这条不成立，撤回**；真正要改的是下面两条。

### 问题 1（真实缺陷）：`hasMermaidBlock()` 全文检测过于宽松

只要回答任意位置出现「三反引号 + mermaid」，哪怕它被包在别的围栏里引用、或只是在讲解语法，也会触发整条回答的 Mermaid 路径。文档/技术类回答极易误伤，且表现为「回答坏了」。

建议：按行扫描维护围栏状态，**只有围栏深度为 0 的顶层** mermaid 块才计入检测；或在 `validateMermaidCode()` 失败时把该块降级为普通代码块（不报红、不替换整段）。

### 问题 2：错误文案对用户不可理解

`Lexical error on line 2. Unrecognized text.` 是 Mermaid 内部错误，直接拼在标题里。建议标题改为「流程图语法错误（第 2 行），以下为原始文本」，完整堆栈进可折叠「详情」或 `console.warn`，`<pre class="msg-mermaid-fallback">` 保持不变。

### 本节的验收

- [ ] 在普通代码块里引用 mermaid 围栏字样时，不触发渲染、不报红；
- [ ] 真语法错误的图块：显示友好提示 + 原文，控制台可见完整错误；
- [ ] 同一回答内「1 个合法图 + 1 段引用文字」只渲染合法图。

## 验收标准

- [ ] 标准 GFM 表格渲染为 `<table>`：表头有底色、有边框、列对齐遵循 `:---`/`---:`；
- [ ] `**粗体**`、`*斜体*`、`` `行内代码` ``、`# 标题`、有序/无序列表、引用、`[链接](url)` 正常渲染；
- [ ] 超宽表格（≥8 列）在气泡内横向滚动，不撑破布局、不出现整屏横向滚动；
- [ ] 代码围栏内出现 `|`、`**`、`#` 时不被误判为表格/强调（已由 `hasAnswerMarkdown` + 解析顺序保证）；
- [ ] 回答含原始 HTML（如 `<img onerror=...>`）时按文本显示，不执行；
- [ ] Mermaid 渲染不回归（含 mermaid + 表格混合内容，两者都对）；
- [ ] 代码块内引用 mermaid 围栏字样不触发渲染（顶层围栏检测）；Mermaid 语法错误时提示可读且保留原文；
- [ ] 流式输出期间仍是纯文本增量，结束后无闪烁、无重复内容、无高度抖动导致滚动跳底；
- [ ] `dataset.rawContent` 保留原始 Markdown（复制/导出不失真）；
- [ ] 超长回答（>100KB）渲染耗时 < 50ms，必要时按长度跳过渲染。

## 回归风险

| 风险 | 说明 | 缓解 |
| --- | --- | --- |
| 流式抖动 | 结束后一次性渲染，高度突变导致滚动跳变 | 渲染前后各调一次 `nudgeChatFollowSettle()`（函数已存在） |
| XSS | 回答内容进 `innerHTML` | 渲染器先整体转义，只生成白名单标签；不要接 `marked` 时不关 `sanitize` |
| 性能 | 日报类回答 35KB / 488 行 | 单次渲染实测 <10ms；建议超 200KB 走纯文本并提示 |
| 复制失真 | 渲染后 `textContent` 丢失语法 | 保留 `dataset.rawContent`，复制按钮读它 |
| Mermaid 混合 | 文本段与图段交替 | 逐段调用同一渲染器，顺序与分段逻辑不变 |

## 备注：修复前的临时规避

Agent 侧约定（已写入工作空间 `.dieyun/AGENTS.md`、`.dieyun/memory.md`、`日报输出格式.md`）：聊天区**不使用 Markdown 表格**，结构化数据改用代码块「一行一客户」对齐文本；需要表格时另出 CSV/xlsx。

## 附件

| 文件 | 说明 |
| --- | --- |
| `issues/mini-markdown-renderer.js` | 可直接复用的无依赖渲染器 + `hasAnswerMarkdown` 判定 + 配套 CSS |
| `.tmp/test_md.js` / `.tmp/test_md.out` | 10 项自测（含 XSS、代码块内 `|` 误判） |
| `.tmp/asar_src/renderer_renderer-mermaid.js` | 解包出的源码，含本次引用的行号 |
| `.tmp/probe_md_anchors.py` | 锚点定位脚本，可复跑核对行号 |
