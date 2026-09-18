'use strict';
// @ts-check

/**
 * Shared tool guardrail constants + pure logic (Main + Renderer).
 * Numeric limits always come from agent-limits.js via createGuardrailApi(getLimits).
 */

/**
 * 工具名别名 → 规范名。**全仓单一来源**（Main / Renderer / llm-tool-call-fallback 共用）。
 * 键一律小写，查询方自行 toLowerCase，勿再各自复制一份（见 docs/HARNESS-INVENTORY.md §D）。
 */
const TOOL_NAME_ALIASES = Object.freeze({
  exec: 'host_exec',
  shell: 'host_exec',
  bash: 'host_exec',
  terminal: 'host_exec',
  run_terminal_cmd: 'host_exec',
  run_command: 'host_exec',
  rg: 'grep',
  ripgrep: 'grep',
  read_file: 'fs_read_file',
  write_file: 'fs_write_file',
  list_dir: 'fs_list_dir',
  edit: 'fs_edit',
  str_replace: 'fs_edit',
  str_replace_editor: 'fs_edit',
  search_replace: 'fs_edit'
});

/** 旧七个 graph_* 工具名 → 统一 graph.operation */
const GRAPH_LEGACY_OPS = Object.freeze({
  graph_module_deps: 'module_deps',
  graph_find_symbol: 'find_symbol',
  graph_semantic_find_symbol: 'semantic_find',
  graph_callers: 'callers',
  graph_callees: 'callees',
  graph_impact: 'impact',
  graph_lsp_callers: 'lsp_callers'
});

const GRAPH_OPERATIONS = Object.freeze(
  new Set(['find_symbol', 'semantic_find', 'module_deps', 'callers', 'callees', 'impact', 'lsp_callers'])
);

/** 工具名归类单一来源（Main + Renderer 共用）。含 host_exec，调用方按命令内容细分。 */
const MUTATING_TOOL_NAMES = Object.freeze(
  new Set([
    'host_exec',
    // host_proc 可 kill 已登记进程，与 host_exec 同属 host 级副作用，故同样按工具名
    // 粗粒度判定（细粒度只读判断见 isWriteTool）。
    'host_proc',
    'fs_write_file',
    'fs_edit',
    'host_print_image',
    'skill_create',
    'plan_create',
    'plan_delete',
    'agents_md_propose',
    'playbook_propose'
  ])
);

/** 会写入本地文件的工具名（不含 host_exec，后者按命令内容判断）。 */
const FILE_WRITE_TOOL_NAMES = Object.freeze(
  new Set(['fs_write_file', 'fs_edit', 'skill_create', 'agents_md_propose', 'playbook_propose'])
);

/** 会改变页面状态的浏览器工具名前缀。 */
const BROWSER_MUTATING_PREFIXES = Object.freeze([
  'browser_click',
  'browser_evaluate',
  'browser_type',
  'browser_fill',
  'browser_select',
  'browser_press',
  'browser_scroll',
  'browser_hover',
  'browser_drag',
  'browser_double',
  'browser_right',
  'browser_navigate',
  'browser_reload',
  'browser_back',
  'browser_forward',
  'browser_import',
  'browser_cookies',
  'browser_route',
  'browser_emulate'
]);

/**
 * 上游对话 API（OpenAI 兼容）接受的图片 MIME。**全仓单一来源**：
 * Main（fs 嗅探 / 视觉注入）与 Renderer（附件发送 / 出站消息清洗）共用。
 * 其余格式（bmp / svg / heic / tiff / ico …）会被上游以 HTTP 400
 * "unsupported image" 打回整轮请求，因此必须在出站前拦掉。
 */
const VISION_IMAGE_MIME = Object.freeze(
  new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])
);

/** 归一化图片 MIME（大小写、image/jpg 别名）；非上游支持格式返回 ''。 */
function normalizeVisionImageMime(value) {
  const raw = String(value || '').trim().toLowerCase();
  const mime = raw === 'image/jpg' ? 'image/jpeg' : raw;
  return VISION_IMAGE_MIME.has(mime) ? mime : '';
}

/** 解码 base64 头部若干字节（Node 走 Buffer，Renderer 走 atob）；失败返回 null。 */
function decodeBase64Head(base64, bytes) {
  const payload = String(base64 || '').replace(/\s+/g, '');
  if (!payload) return null;
  // 取 4 的整数倍字符：atob 对长度为 4n+1 的输入直接抛错，不能让它变成「图片被判成非法」
  const chars = Math.max(8, Math.ceil((Math.max(1, bytes) * 4) / 3));
  const head = payload.slice(0, Math.floor(chars / 4) * 4 || 4);
  try {
    if (typeof Buffer !== 'undefined' && typeof Buffer.from === 'function') {
      return Buffer.from(head, 'base64');
    }
    if (typeof atob === 'function') {
      const bin = atob(head);
      const out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
      return out;
    }
  } catch {
    return null;
  }
  return null;
}

function bytesToLatin1(bytes, start, end) {
  let s = '';
  for (let i = start; i < end && i < bytes.length; i += 1) s += String.fromCharCode(bytes[i]);
  return s;
}

/**
 * 用文件头魔数判定图片真实格式；只返回上游支持的 MIME，
 * 判定不出（bmp/svg/heic/tiff/ico、坏 base64、空串）一律返回 ''。
 */
function sniffVisionImageMime(base64) {
  const head = decodeBase64Head(base64, 16);
  if (!head || head.length < 3) return '';
  if (head.length >= 8 && head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47) {
    return 'image/png';
  }
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'image/jpeg';
  const sig6 = bytesToLatin1(head, 0, 6);
  if (sig6 === 'GIF87a' || sig6 === 'GIF89a') return 'image/gif';
  if (head.length >= 12 && bytesToLatin1(head, 0, 4) === 'RIFF' && bytesToLatin1(head, 8, 12) === 'WEBP') {
    return 'image/webp';
  }
  return '';
}

/** 拆 data URL → { mime, base64 }；非 data: URL 返回 null。 */
function parseImageDataUrl(url) {
  const m = /^data:([^;,]*)(?:;[^,]*)?,(.*)$/is.exec(String(url || '').trim());
  if (!m) return null;
  return {
    mime: String(m[1] || '').trim().toLowerCase(),
    base64: String(m[2] || '').replace(/\s+/g, '')
  };
}

/** 远端 URL 明显指向不受支持的图片格式（无法嗅探远端字节，只能看扩展名）。 */
const UNSUPPORTED_IMAGE_EXT_RE = /\.(bmp|svg|heic|heif|tiff?|ico|avif|jxl)(?:$|[?#])/i;

/**
 * 出站图片 URL 的最后一道闸：以实际字节修正 MIME（声明 mime 与内容不符时也能救回），
 * 嗅探不出（空 / 坏 base64 / 非上游支持格式）返回 ''，调用方必须省略该图，
 * 否则整轮请求会被上游 400 打回（".messages[N].image[0]: unsupported image"）。
 *
 * 三类 URL 的处理：
 * - `data:`：解码头部按魔数修正/校验；
 * - `http(s)`：由上游自行抓取，原样放行；但扩展名明显是不支持格式时提前拦掉；
 * - 其它（裸 base64 / blob: / file: / 本地路径）：裸 base64 按魔数补 data: 前缀救回，
 *   其余一律判为不可用——上游既取不到这些本地引用，也认不出裸 base64。
 */
function sanitizeImageUrlForApi(url) {
  const raw = String(url || '').trim();
  if (!raw) return '';
  if (/^https?:/i.test(raw)) return UNSUPPORTED_IMAGE_EXT_RE.test(raw) ? '' : raw;
  if (!/^data:/i.test(raw)) {
    const bare = raw.replace(/\s+/g, '');
    const mime = sniffVisionImageMime(bare);
    return mime ? `data:${mime};base64,${bare}` : '';
  }
  const parsed = parseImageDataUrl(raw);
  if (!parsed || !parsed.base64) return '';
  const mime = sniffVisionImageMime(parsed.base64);
  return mime ? `data:${mime};base64,${parsed.base64}` : '';
}

/** 图片不合法时替换成的文字说明（出站请求里不能留空 part）。 */
const UNSUPPORTED_IMAGE_PLACEHOLDER = '（图片格式不受模型接口支持，已省略；仅支持 png/jpeg/gif/webp）';

/**
 * 上游明确拒绝图片时的文字说明。与「格式闸门」不同：这张图已经发出去了，说明接口
 * 判定它不可用（中转截断、远端 URL 抓到的不是图、上游不认某种容器…）。必须让模型
 * 知道「这张图没看成」，否则它会继续把没见过的画面当事实来源。
 */
const REJECTED_IMAGE_PLACEHOLDER =
  '（图片被模型接口拒绝，本轮已省略。该接口只接受完整可解码的 png/jpeg/gif/webp；' +
  '如需查看，请让用户压缩或转为 png/jpeg 后重发）';

/**
 * 上游把「图片不合规」当整轮错误打回时的文案特征。
 * 各中转措辞不一（unsupported image / invalid image / unsupported media type），
 * 但只要 HTTP 400 / 415 命中这些词，就属于「丢图重发即可继续」的一类；
 * 其它 400（参数错、额度、审核…）照旧上抛，不做自愈。
 */
const IMAGE_REJECT_ERROR_RE =
  /unsupported image|invalid image|unsupported media type|unsupported media|image format/i;

/** 是否为「图片被上游拒绝」类错误（HTTP 400/415 + 图片文案）。 */
function isLlmImageRejectedError(err) {
  if (!err) return false;
  const msg = String(err.message || err);
  const status = Number(err.statusCode) || 0;
  const m = msg.match(/\bHTTP\s+(\d{3})\b/i);
  const code = status || (m ? Number(m[1]) : 0);
  if (code && code !== 400 && code !== 415) return false;
  return IMAGE_REJECT_ERROR_RE.test(msg);
}

/**
 * 从上游错误文案里解析被拒图片所在的 message 下标。
 * 上游路径写作 `.messages[27].image[0]` / `.messages[27].content[0]`（也有点号写法）；
 * 解析不到时返回空数组，调用方应理解为「定位不到 → 整轮丢图」。
 */
function parseRejectedImageMessageIndices(message) {
  const out = new Set();
  const re = /messages\s*(?:\[\s*(\d+)\s*\]|\.\s*(\d+))\s*\.\s*(?:content|image)\b/gi;
  let m;
  while ((m = re.exec(String(message || '')))) {
    const idx = Number(m[1] != null ? m[1] : m[2]);
    if (Number.isInteger(idx) && idx >= 0) out.add(idx);
  }
  return [...out];
}

/**
 * content part 是否为图片。
 * OpenAI chat：image_url；Responses：input_image；另有 Anthropic 风格 image（source）。
 * 上游报错路径写作 `.messages[N].image[0]`，故这三种形状都要覆盖。
 */
function isChatImagePart(part) {
  if (!part || typeof part !== 'object') return false;
  return part.type === 'image_url' || part.type === 'input_image' || part.type === 'image';
}

/** Anthropic 风格 image part（source.type = base64 | url）→ 等效 URL。 */
function anthropicImagePartUrl(part) {
  const src = part && part.source;
  if (!src || typeof src !== 'object') return '';
  if (src.type === 'base64') {
    const data = String(src.data || '').replace(/\s+/g, '');
    if (!data) return '';
    const mime = String(src.media_type || '').trim() || 'application/octet-stream';
    return `data:${mime};base64,${data}`;
  }
  if (src.type === 'url') return String(src.url || '');
  return '';
}

/** 取图片 part 的 URL（image_url 可能是字符串或 { url }；也兼容 part.url / source）。 */
function chatImagePartUrl(part) {
  const holder = part && part.image_url;
  if (typeof holder === 'string') return holder;
  if (holder && typeof holder === 'object' && typeof holder.url === 'string') return holder.url;
  if (part && typeof part.url === 'string') return part.url;
  return anthropicImagePartUrl(part);
}

/**
 * 统一遍历出站 body 的图片 part，按 decide 的返回值改写。
 * 「格式闸门」（sanitizeChatBodyImagesForApi）与「上游已拒绝」修复
 * （dropRejectedChatImagesForApi）共用这一份遍历，避免两边对 part 形状的判定漂移。
 *
 * decide(part, { messageIndex, url }) 返回：
 * - `null` / 原 part：原样保留；
 * - 其它 part 对象：替换该 part。
 * @returns {boolean} 是否有改写
 */
function mapChatImages(body, decide) {
  if (!body || typeof body !== 'object' || !Array.isArray(body.messages)) return false;
  let changed = false;
  body.messages.forEach((msg, messageIndex) => {
    if (!msg || typeof msg !== 'object' || !Array.isArray(msg.content)) return;
    const out = [];
    let msgChanged = false;
    for (const part of msg.content) {
      if (!isChatImagePart(part)) {
        out.push(part);
        continue;
      }
      const next = decide(part, { messageIndex, url: chatImagePartUrl(part) });
      if (!next || next === part) {
        out.push(part);
        continue;
      }
      msgChanged = true;
      out.push(next);
    }
    if (msgChanged) {
      msg.content = out;
      changed = true;
    }
  });
  return changed;
}

/**
 * 出站 chat body 的图片闸门（Main 侧最后一道）。
 *
 * 为什么必须在这里兜底：Rust 消息账本 / 会话历史可能残留旧版本落库的 bmp/svg/heic
 * 或坏 base64（Renderer 侧清洗在 agent-bundle 未重建时会降级放行，见 renderer-utils）。
 * 这类图会被每轮重发，上游以 HTTP 400 ".messages[N].image[0]: unsupported image"
 * 打回整轮请求——用户侧表现为「对话忽然全挂」。这里按实际字节校正 MIME；
 * 判不出（非 png/jpeg/gif/webp、坏 base64、空图）则把该 part 降级为文字说明。
 *
 * 原地修改 body.messages，返回是否发生改动（调用方可据此决定要不要回写账本）。
 */
function sanitizeChatBodyImagesForApi(body) {
  return mapChatImages(body, (part, { url }) => {
    const safe = sanitizeImageUrlForApi(url);
    if (!safe) return { type: 'text', text: UNSUPPORTED_IMAGE_PLACEHOLDER };
    // Anthropic 风格 image（source）：形状不由本仓产生，只剔除不合法项，不改写形状
    if (part.type === 'image') return null;
    if (safe === url) return null;
    // 只在原字段上改写，避免把 part.url 变形出 image_url 字段
    if (typeof part.image_url === 'string') return { ...part, image_url: safe };
    if (part.image_url && typeof part.image_url === 'object') {
      return { ...part, image_url: { ...part.image_url, url: safe } };
    }
    return { ...part, url: safe };
  });
}

/**
 * 「上游已拒绝」修复闸：把图片 part 换成文字说明，让同一轮请求丢图后能原样重发。
 *
 * 与 sanitizeChatBodyImagesForApi 的分工：那道闸只能看出「声明/字节是否合法」，
 * 看不出上游自己的判定（中转截断、远端 http URL 抓到的不是图、上游不认某种容器）。
 * 这类图每轮重发都会把整轮请求打成 HTTP 400，只能在收到 400 后按需丢弃。
 *
 * @param {object} body 出站 chat body（原地修改 messages）
 * @param {{ messageIndices?: number[], placeholder?: string }} [opts]
 *   `messageIndices` 缺省 = 丢弃所有消息里的图片；给数组则只丢这些下标的消息。
 * @returns {{ dropped: number }} 被降级为文字说明的图片数
 */
function dropRejectedChatImagesForApi(body, opts = {}) {
  const only = Array.isArray(opts.messageIndices)
    ? new Set(opts.messageIndices.map(Number).filter((n) => Number.isInteger(n) && n >= 0))
    : null;
  const text =
    typeof opts.placeholder === 'string' && opts.placeholder
      ? opts.placeholder
      : REJECTED_IMAGE_PLACEHOLDER;
  let dropped = 0;
  mapChatImages(body, (part, { messageIndex }) => {
    if (only && !only.has(messageIndex)) return null;
    dropped += 1;
    return { type: 'text', text };
  });
  return { dropped };
}

/**
 * 字符串版闸门（llm-proxy 的 body 已是 JSON 串）。只在含图片 part 时解析，
 * 避免给每轮请求都加一次 parse/stringify 开销。解析失败原样返回。
 */
function sanitizeChatRequestJsonForApi(rawJson) {
  const raw = typeof rawJson === 'string' ? rawJson : '';
  const hasImagePart =
    raw.includes('"image_url"') || raw.includes('"input_image"') || /"type"\s*:\s*"image"/.test(raw);
  if (!hasImagePart) return raw;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return raw;
  }
  return sanitizeChatBodyImagesForApi(parsed) ? JSON.stringify(parsed) : raw;
}

function isMutatingAgentToolName(name) {
  const n = String(name || '');
  if (MUTATING_TOOL_NAMES.has(n)) return true;
  return BROWSER_MUTATING_PREFIXES.some((p) => n === p || n.startsWith(`${p}_`));
}

/** fs_edit 参数是否可用（legacy oldString/newString 或 edits 数组）。 */
function fsEditArgsPresent(args) {
  const a = args && typeof args === 'object' ? args : {};
  const oldString = a.oldString != null ? a.oldString : a.old_string;
  const newString = a.newString != null ? a.newString : a.new_string;
  const hasLegacy =
    typeof oldString === 'string' && oldString.length > 0 && typeof newString === 'string';
  const hasEdits = a.edits != null && a.edits !== '';
  return { ok: hasLegacy || hasEdits, hasLegacy, hasEdits, oldString, newString };
}

const HOST_EXEC_FILE_WRITE_RE =
  /(?:^|[\s;&|])(?:set-content|add-content|out-file|new-item|copy-item|move-item|remove-item|ren(?:ame)?|del|erase|mkdir|rmdir|md|rd|touch|tee|cp|mv|rm|git\s+(?:apply|commit|merge|rebase|checkout|switch|restore|reset|clean)|patch)\b|(?:>|>>)|\b(?:writefile|appendfile|unlink|rename|mkdir|rmdir|rmSync|writeFileSync|appendFileSync)\b|(?:^|[\s;&|])sed\s+-[^-\s]*i/i;

const HOST_EXEC_VALIDATION_RE =
  /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|check|lint|typecheck|build)\b|\b(?:cargo|go)\s+(?:test|check|build)\b|\b(?:pytest|ruff|mypy|tsc|eslint|vitest|jest)\b|workspace\.diagnostics/i;

function stableStringifyArgs(args) {
  if (args == null) return '';
  if (typeof args !== 'object') return String(args);
  try {
    const sorted = {};
    for (const k of Object.keys(args).sort()) sorted[k] = args[k];
    return JSON.stringify(sorted);
  } catch {
    return String(args);
  }
}

function toolCallFingerprint(name, args) {
  return `${String(name || '').trim()}\0${stableStringifyArgs(args)}`;
}

function parseFingerprint(fp) {
  const sep = String(fp || '').indexOf('\0');
  if (sep < 0) return { name: fp, args: {} };
  try {
    return { name: fp.slice(0, sep), args: JSON.parse(fp.slice(sep + 1)) };
  } catch {
    return { name: fp.slice(0, sep), args: {} };
  }
}

function countRecentStreak(history, fingerprint) {
  let streak = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i] === fingerprint) streak += 1;
    else break;
  }
  return streak;
}

function normalizeAgentToolName(name, args) {
  const raw = String(name || '').trim();
  const key = raw.toLowerCase();
  const mapped = TOOL_NAME_ALIASES[key] || raw;
  const next = { ...(args || {}) };
  if (mapped === 'codebase_search' && !next.query) {
    next.query = String(next.pattern || next.q || next.search || next.path || next.filePath || raw).slice(
      0,
      500
    );
  }
  if (mapped === 'grep' && !next.pattern) {
    next.pattern = String(next.query || next.q || next.search || '').slice(0, 500);
  }
  if (mapped === 'glob' && !next.pattern) {
    next.pattern = String(next.glob || next.query || next.q || '').slice(0, 500);
  }
  if (mapped === 'lsp') {
    if (!next.operation) next.operation = next.op || next.method;
    // workspaceSymbol 是纯名字查询，path 可能是工作区目录而非文件，不搬运
    if (!next.filePath && next.operation !== 'workspaceSymbol') {
      next.filePath = next.file_path || next.path || next.file;
    }
    if (next.character == null && next.column != null) next.character = next.column;
    if (next.character == null && next.col != null) next.character = next.col;
  }
  if (mapped === 'read_symbol') {
    if (!next.filePath && (next.file_path || next.path)) next.filePath = next.file_path || next.path;
    if (!next.name) next.name = next.symbol || next.symbolName || next.symbol_name || next.query;
    if (next.maxLines == null) next.maxLines = next.max_lines;
  }
  if (mapped === 'fs_read_file' && !next.filePath) {
    next.filePath = next.path || next.file || next.filename;
  }
  if (mapped === 'fs_list_dir' && !next.dirPath) {
    next.dirPath = next.path || next.dir || next.directory;
  }
  if (mapped === 'fs_write_file' && !next.filePath) {
    next.filePath = next.path || next.file || next.filename;
  }
  if (mapped === 'fs_edit') {
    if (!next.filePath) next.filePath = next.path || next.file || next.filename;
    if (next.oldString == null) next.oldString = next.old_string;
    if (next.newString == null) next.newString = next.new_string;
    if (next.replaceAll == null) next.replaceAll = next.replace_all;
  }
  const legacyGraphOp = GRAPH_LEGACY_OPS[key] || GRAPH_LEGACY_OPS[mapped];
  if (legacyGraphOp) {
    if (!next.operation) next.operation = next.op || legacyGraphOp;
    return { name: 'graph', args: next };
  }
  if (mapped === 'graph') {
    if (!next.operation) next.operation = next.op;
  }
  return { name: mapped, args: next };
}

function hostExecCommand(args) {
  return String(args?.command || '').trim();
}

function hostExecLooksFileWriting(commandOrArgs) {
  const cmd =
    typeof commandOrArgs === 'string'
      ? commandOrArgs
      : hostExecCommand(commandOrArgs);
  return !!cmd && HOST_EXEC_FILE_WRITE_RE.test(cmd);
}

function hostExecLooksValidation(commandOrArgs) {
  const cmd =
    typeof commandOrArgs === 'string'
      ? commandOrArgs
      : hostExecCommand(commandOrArgs);
  return !!cmd && HOST_EXEC_VALIDATION_RE.test(cmd);
}

function isWriteTool(name, args) {
  const n = String(name || '').trim();
  if (n === 'fs_write_file' || n === 'fs_edit') return true;
  if (n === 'host_exec') return hostExecLooksFileWriting(args);
  return false;
}

// 单一来源：agent-limits.js（原先这里是「全局 → 运行期 require」两层兜底）
const { AGENT_LIMITS_DEFAULTS } = require('./agent-limits');

/**
 * @param {() => object} getLimits returns agent-limits merged object
 */
function createGuardrailApi(getLimits) {
  function lims() {
    return typeof getLimits === 'function' ? getLimits() : {};
  }

  return {
    shouldBlockRepeatToolCall(name, args, history, limit) {
      const raw = limit != null ? limit : lims().repeatToolStreakLimit;
      const n = Number(raw);
      const fallback = Number(AGENT_LIMITS_DEFAULTS.repeatToolStreakLimit);
      // 缺失时必须退回默认阈值，否则 Math.max(2, undefined) = NaN 会让比较恒为 false，
      // 重复调用止损静默失效
      const lim = Number.isFinite(n)
        ? Math.max(2, Math.floor(n))
        : Number.isFinite(fallback) && fallback >= 2
          ? Math.floor(fallback)
          : 2;
      const fp = toolCallFingerprint(name, args);
      const streak = countRecentStreak(history, fp);
      return streak >= lim - 1;
    },
    recordToolCallFingerprint(history, name, args) {
      const fp = toolCallFingerprint(name, args);
      history.push(fp);
      const maxHist = lims().repeatHistoryMax;
      while (history.length > maxHist) history.shift();
      return fp;
    },
    repeatToolBlockMessage(name, argsBrief, limit) {
      const arg = argsBrief ? `(${argsBrief})` : '';
      const lim = limit != null ? limit : lims().repeatToolStreakLimit;
      return (
        `重复工具调用已止损：连续 ${lim} 次相同调用 ${name}${arg}。` +
        '请换思路、换参数，或直接向用户说明卡点。'
      );
    }
  };
}

const SHARED_EXPORTS = {
  TOOL_NAME_ALIASES,
  GRAPH_LEGACY_OPS,
  GRAPH_OPERATIONS,
  HOST_EXEC_FILE_WRITE_RE,
  HOST_EXEC_VALIDATION_RE,
  stableStringifyArgs,
  toolCallFingerprint,
  parseFingerprint,
  countRecentStreak,
  normalizeAgentToolName,
  hostExecCommand,
  hostExecLooksFileWriting,
  hostExecLooksValidation,
  isWriteTool,
  MUTATING_TOOL_NAMES,
  FILE_WRITE_TOOL_NAMES,
  BROWSER_MUTATING_PREFIXES,
  VISION_IMAGE_MIME,
  REJECTED_IMAGE_PLACEHOLDER,
  normalizeVisionImageMime,
  sniffVisionImageMime,
  sanitizeImageUrlForApi,
  sanitizeChatBodyImagesForApi,
  sanitizeChatRequestJsonForApi,
  mapChatImages,
  isLlmImageRejectedError,
  parseRejectedImageMessageIndices,
  dropRejectedChatImagesForApi,
  isMutatingAgentTool: isMutatingAgentToolName,
  fsEditArgsPresent,
  createGuardrailApi
};

module.exports = SHARED_EXPORTS;
