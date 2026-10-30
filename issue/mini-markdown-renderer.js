/**
 * mini-markdown-renderer.js —— 无依赖迷你 Markdown → HTML（供叠云 Agent 回答区渲染用）
 *
 * 用法（渲染器源码里）：
 *   el.classList.add("msg-answer-rich");
 *   el.dataset.rawContent = text;
 *   el.innerHTML = renderMarkdownToHtml(text);   // 若已有 sanitize，可再过一层
 *
 * 支持：标题 #~######、无序/有序列表、引用、分割线、围栏代码块、GFM 表格、
 *       粗体 **x** / 斜体 *x* / 行内代码 `x` / 链接 [t](u)。
 * 设计取舍：流式阶段不要调用（半截语法会抖），等消息完成事件后一次性渲染。
 * 安全：先整体 HTML 转义，再生成受控标签，因此不会执行回答里的原始 HTML。
 */
function renderMarkdownToHtml(src) {
  const esc = (s) =>
    String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");

  // 行内：先转义，再替换语法；行内代码先抽出来占位，避免其中的 * 被误判
  const inline = (raw) => {
    const codes = [];
    let t = esc(raw).replace(/`([^`]+)`/g, (_, c) => {
      codes.push(c);
      return "\u0000C" + (codes.length - 1) + "\u0000";
    });
    t = t
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>")
      .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
    t = t.replace(/\u0000C(\d+)\u0000/g, (_, i) => "<code>" + codes[+i] + "</code>");
    return t;
  };

  const lines = String(src || "").replace(/\r\n?/g, "\n").split("\n");
  const out = [];
  let i = 0;

  const splitRow = (line) => {
    let s = line.trim();
    if (s.startsWith("|")) s = s.slice(1);
    if (s.endsWith("|")) s = s.slice(0, -1);
    return s.split("|").map((c) => c.trim());
  };
  const isSepRow = (line) => /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/.test(line) && line.includes("-");

  while (i < lines.length) {
    const line = lines[i];

    // 围栏代码块
    if (/^\s*```/.test(line)) {
      const fence = line.trim().slice(3).trim();
      i++;
      const buf = [];
      while (i < lines.length && !/^\s*```/.test(lines[i])) buf.push(lines[i++]);
      i++; // 跳过结束围栏
      const lang = fence ? ' data-lang="' + esc(fence) + '"' : "";
      out.push('<pre class="msg-md-pre"' + lang + "><code>" + esc(buf.join("\n")) + "</code></pre>");
      continue;
    }

    // 表格：当前行含 | 且下一行是分隔行
    if (line.includes("|") && i + 1 < lines.length && isSepRow(lines[i + 1])) {
      const head = splitRow(line);
      const aligns = splitRow(lines[i + 1]).map((c) => {
        const l = c.startsWith(":"), r = c.endsWith(":");
        return l && r ? "center" : r ? "right" : l ? "left" : "";
      });
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].includes("|") && lines[i].trim()) rows.push(splitRow(lines[i++]));
      const th = head
        .map((c, k) => "<th" + (aligns[k] ? ' style="text-align:' + aligns[k] + '"' : "") + ">" + inline(c) + "</th>")
        .join("");
      const tb = rows
        .map(
          (r) =>
            "<tr>" +
            head
              .map((_, k) => {
                const a = aligns[k] ? ' style="text-align:' + aligns[k] + '"' : "";
                return "<td" + a + ">" + inline(r[k] == null ? "" : r[k]) + "</td>";
              })
              .join("") +
            "</tr>"
        )
        .join("");
      out.push(
        '<div class="msg-md-table-wrap"><table class="msg-md-table"><thead><tr>' +
          th +
          "</tr></thead><tbody>" +
          tb +
          "</tbody></table></div>"
      );
      continue;
    }

    // 标题
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      const lv = h[1].length;
      out.push("<h" + lv + ' class="msg-md-h">' + inline(h[2]) + "</h" + lv + ">");
      i++;
      continue;
    }

    // 分割线
    if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) {
      out.push("<hr>");
      i++;
      continue;
    }

    // 引用块
    if (/^\s*>\s?/.test(line)) {
      const buf = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) buf.push(lines[i++].replace(/^\s*>\s?/, ""));
      out.push("<blockquote>" + inline(buf.join(" ")) + "</blockquote>");
      continue;
    }

    // 无序列表
    if (/^\s*[-*+]\s+/.test(line)) {
      const buf = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) buf.push(lines[i++].replace(/^\s*[-*+]\s+/, ""));
      out.push("<ul>" + buf.map((x) => "<li>" + inline(x) + "</li>").join("") + "</ul>");
      continue;
    }

    // 有序列表
    if (/^\s*\d+[.)]\s+/.test(line)) {
      const buf = [];
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) buf.push(lines[i++].replace(/^\s*\d+[.)]\s+/, ""));
      out.push("<ol>" + buf.map((x) => "<li>" + inline(x) + "</li>").join("") + "</ol>");
      continue;
    }

    // 空行
    if (!line.trim()) {
      i++;
      continue;
    }

    // 普通段落（连续非空行合并）
    const buf = [];
    while (i < lines.length && lines[i].trim() && !/^\s*(```|>|[-*+]\s|\d+[.)]\s|#{1,6}\s)/.test(lines[i])) {
      buf.push(lines[i++]);
    }
    out.push('<p class="msg-md-p">' + inline(buf.join("\n")).replace(/\n/g, "<br>") + "</p>");
  }

  return out.join("\n");
}

/** 回答文本是否含值得走 Markdown 渲染的语法（不含 mermaid 时的判定） */
function hasAnswerMarkdown(text) {
  const s = String(text || "");
  if (!s) return false;
  if (/\|\s*-{2,}/.test(s)) return true; // 表格分隔行
  if (/^\s*```/m.test(s)) return true; // 代码块
  if (/^\s*#{1,6}\s+/m.test(s)) return true; // 标题
  if (/^\s*[-*+]\s+/m.test(s)) return true; // 列表
  if (/\*\*[^*\n]+\*\*/.test(s)) return true; // 粗体
  if (/`[^`\n]+`/.test(s)) return true; // 行内代码
  return false;
}

/** 配套 CSS（建议并入 renderer_index.html 的样式段） */
const MINI_MD_CSS = `
.msg-md-h{margin:.8em 0 .4em;font-weight:600;line-height:1.35}
h1.msg-md-h{font-size:1.35em}h2.msg-md-h{font-size:1.22em}h3.msg-md-h{font-size:1.1em}
.msg-md-p{margin:.45em 0;line-height:1.65}
.msg-md-pre{margin:.6em 0;padding:.7em .85em;overflow:auto;border-radius:8px;background:rgba(127,127,127,.12);font-size:.92em}
.msg-md-pre code{font-family:ui-monospace,Consolas,Menlo,monospace;white-space:pre}
.msg-md-table-wrap{margin:.6em 0;overflow-x:auto;border:1px solid rgba(127,127,127,.28);border-radius:8px}
table.msg-md-table{border-collapse:collapse;width:100%;font-size:.94em}
table.msg-md-table th,table.msg-md-table td{padding:.42em .6em;border-bottom:1px solid rgba(127,127,127,.22);white-space:nowrap}
table.msg-md-table th{background:rgba(127,127,127,.14);font-weight:600;text-align:left}
table.msg-md-table tbody tr:last-child td{border-bottom:none}
.msg-answer ul,.msg-answer ol{margin:.45em 0;padding-left:1.4em}
.msg-answer blockquote{margin:.5em 0;padding:.2em 0 .2em .8em;border-left:3px solid rgba(127,127,127,.35);color:inherit;opacity:.9}
.msg-answer code{font-family:ui-monospace,Consolas,Menlo,monospace;background:rgba(127,127,127,.15);padding:.1em .32em;border-radius:4px}
`;

if (typeof module !== "undefined" && module.exports) {
  module.exports = { renderMarkdownToHtml, hasAnswerMarkdown, MINI_MD_CSS };
}
