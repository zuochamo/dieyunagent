// @ts-check
'use strict';

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
  graph_callers: 'callers',
  graph_callees: 'callees',
  graph_impact: 'impact',
  graph_lsp_callers: 'lsp_callers'
});

const GRAPH_OPERATIONS = Object.freeze(
  new Set(['find_symbol', 'module_deps', 'callers', 'callees', 'impact', 'lsp_callers'])
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
    // computer（OS 级电脑控制）整体按名字进串行队列：动作天然必须串行
    // （截屏→点→看→点），并行投递只会互相踩；screenshot 也随工具名一同串行，代价可忽略。
    'computer',
    'skill_create',
    // 改技能正文：与创建/删除同属「写 ~/.dieyun/skills」，串行队列才不会被两次改写交叉
    'skill_update',
    // 删技能目录是物理删除（不可恢复），与 skill_create 一样进串行队列
    'skill_delete',
    'plan_create',
    'plan_delete',
    // `plan_run` / `plan_cancel` 刻意**不在**这里：
    //   - 「同一个计划不能同时跑两轮」由 `PlansScheduler.running` 自己挡（`runNow` 会抛「计划正在执行」），
    //     队列再加一层不是新的保证；
    //   - 而塞进 workspace 串行队列会**死锁**：`plan_run` 占着槽位等整段嵌套运行，
    //     嵌套运行自己的 `fs_edit` / `fs_write_file` 又要同一个槽位
    //     （2026-11-04 现场：`MUTATE_QUEUE_STALL ... tool=plan_run runningMs=720009`，
    //      12 分钟强开闸后才跑完；期间发起方对话轮一直「思考中…」）。
    // mcp_manage 改的是 MCP 服务配置并重建会话（进程级副作用），与 skill_create 同类
    'mcp_manage',
    // ssh 会改连接/端口转发状态，甚至把工作空间切到远端：同一时刻只能有一个在跑
    'ssh',
    // worktree 建/删副本、写回主工作区都是仓库级操作，串行才安全
    'worktree',
    'agents_md_propose'
  ])
);

/** 会写入本地文件的工具名（不含 host_exec，后者按命令内容判断）。 */
const FILE_WRITE_TOOL_NAMES = Object.freeze(
  new Set(['fs_write_file', 'fs_edit', 'skill_create', 'skill_update', 'agents_md_propose'])
);

/**
 * 只读作用域的白名单（`src/alive` 后台心跳轮专用）。
 *
 * 为什么是**白名单**而不是「拦掉写类工具」：黑名单永远漏 —— 出网（`web_fetch`）、
 * 跨机发消息（`peer_send`）、删记忆（`memory_forget`）、起子 loop（`subagent`，
 * 子 loop 的工具上下文不继承 readOnly）、跑计划（`plan_run`）、`goal_check`（内部会执行命令）
 * 都不是 `isWriteTool` 认为的"写"，但它们全都能产生真实副作用。
 *
 * 所以这条规则是：**清单外一律拒绝**。加一个工具进这份清单 = 明确表态
 * "心跳轮可以用它"，而不是"忘了把它加进黑名单"。
 *
 * **这份清单同时是心跳轮的「工具表」来源**（`aliveWakeToolNames`）：模型能不能看见某个工具，
 * 与它能不能调用它，必须是同一份数据。两边各写一份已经出过两种病（2026-11-12 实测）：
 * 清单写了 `grep / codebase_search / memory_recall / plan_list` 却没进工具表（允许了没给，
 * 它只能整文件读）；反过来 `web_search` 在工具表里、清单里没有（每轮撞一次 `READ_ONLY_SCOPE`）。
 */
const ALIVE_READ_ONLY_TOOL_NAMES = Object.freeze(
  new Set([
    // 读文件 / 找东西
    'fs_read_file',
    'fs_list_dir',
    'grep',
    'glob',
    'read_symbol',
    'codebase_search',
    'graph',
    'lsp',
    // 读记忆（不删）
    'memory_recall',
    'session_recall',
    // 只读地看一眼计划（不建、不跑）
    'plan_list',
    // 看一眼内网有谁在（只读；派活/领活是 `peer_send` / `peer_claim`，那两格永远不放）
    'peer_list',
    // 「眼睛」：看一眼现实（受 `senses.eyes` + 设置→权限 两道锁，见 ALIVE_SENSE_TOOLS）
    'camera_look',
    'desktop_camera_look'
  ])
);

/**
 * 「感官」工具 → 需要的感受开关。
 *
 * 心跳轮拿到的是**只读**作用域，但"只读"不等于"看不见"：摄像头能看到现实世界，
 * 它比写盘更需要一道显式授权。所以这类工具除了在白名单里，还要 `senses` 逐项打开
 * （默认全关，页面上的三个开关就是它）。
 */
const ALIVE_SENSE_TOOLS = Object.freeze({
  camera_look: 'eyes',
  desktop_camera_look: 'eyes'
});

/**
 * 心跳轮的**三档权力 → 可调用工具**（唯一清单；`src/alive/store.js#WAKE_POWERS` 是档位枚举）。
 *
 * 默认 `read` = 原来那份白名单。放开是显式开关（`alive/settings.json#wakePower`）：
 *   - `write`：多两个改文件的工具（`fs_write_file` / `fs_edit`）；
 *   - `exec`：再多 `host_exec`（跑命令）与 `web_search` / `web_fetch`（出网），
 *     外加**会占用你屏幕和键鼠**的两类：`browser_*`（核心那批，见 `alivePlaybackToolNames`）
 *     与 `computer` —— 它们还要过「有没有别的任务在跑」的避让闸（`WAKE_YIELD`，
 *     判据是 `getActiveAgentLoopCount() > 1`：这一轮自己算一条，多出来就是别人）。
 * 加工具只改这里；越界判定（根目录 / 次数 / 审批 / 避让）在 `tool-gate` 的 `read-only-scope` 关卡。
 *
 * **为什么出网跟着 `exec` 档走，而不是单独一格**：`exec` 档的 `host_exec` 本身就能出网 ——
 * `sandbox-policy` 在 `workspace-write` 下对「不落盘的联网命令」（`curl` 无 `-o`、`Invoke-WebRequest`…）
 * 判的是 allow。所以在这一档挡住 `web_*` 并不构成安全边界，只是把出网挤到另一条路上：
 * 命令行拿回来的是**原始 HTML**（翻页、编码、反爬全得模型自己扛，token 更贵），
 * 而且绕过了 `src/gateway/web/` 里唯一的 SSRF 校验（`url-safety.assertSafeUrl`）与引擎解析。
 * 放开这两格 = 让这一档仅有的出网走正规通道；**跨机**（`peer_send`）、**子 loop**（`subagent`）、
 * **计划**（`plan_run` / `goal_check`）仍然一律不放 —— 它们绕过 `wakeRoot` 与次数闸。
 */
const ALIVE_WAKE_POWER_TOOL_NAMES = Object.freeze({
  read: ALIVE_READ_ONLY_TOOL_NAMES,
  write: new Set([...ALIVE_READ_ONLY_TOOL_NAMES, 'fs_write_file', 'fs_edit']),
  exec: new Set([
    ...ALIVE_READ_ONLY_TOOL_NAMES,
    'fs_write_file',
    'fs_edit',
    'host_exec',
    'web_search',
    'web_fetch'
  ])
});

/** 唤醒轮里**要过路径闸门**的工具（目标必须落在 wakeWorkspace 之下；参数名是 filePath） */
const ALIVE_WAKE_WRITE_TOOL_NAMES = Object.freeze(new Set(['fs_write_file', 'fs_edit']));

/**
 * `exec` 档额外放开的「会占屏 / 抢键鼠」工具：整个浏览器核心批 + `computer`。
 *
 * 为什么单独一张表而不是塞进 `ALIVE_WAKE_POWER_TOOL_NAMES.exec`：这 30 多个 schema 很占字数，
 * 而它们只在 `exec` 档、且**另一件事没在跑**的时候才该出现；塞进静态 Set 会让"放行"与"发下去"
 * 又分成两处判。名字直接取自 `tool-catalog`（`BROWSER_CORE_TOOLS` 是既有的核心/高级切分，
 * 不另造名单）；懒 require 是为了不让 guardrails 在加载期依赖整套工具 schema。
 */
let alivePlaybackNamesCache = null;
function alivePlaybackToolNames() {
  if (!alivePlaybackNamesCache) {
    const catalog = require('./tool-catalog');
    const core = Array.isArray(catalog.BROWSER_CORE_TOOLS) ? catalog.BROWSER_CORE_TOOLS : [];
    alivePlaybackNamesCache = core
      .map((t) => (t && t.function && t.function.name) || '')
      .filter(Boolean)
      .concat('computer');
  }
  return alivePlaybackNamesCache;
}

/** 这些工具会占屏 / 抢键鼠：有别的任务在跑时必须让路（`WAKE_YIELD`） */
const ALIVE_YIELD_TOOL_PREFIXES = Object.freeze(['browser_']);
const ALIVE_YIELD_TOOL_NAMES = Object.freeze(new Set(['computer']));

function isAliveYieldTool(name) {
  const n = String(name || '');
  return ALIVE_YIELD_TOOL_NAMES.has(n) || ALIVE_YIELD_TOOL_PREFIXES.some((p) => n.startsWith(p));
}

/**
 * 这一档**能不能调用**这个工具（`tool-gate` 的白名单判据；工具表也从它派生，见下）。
 * 判据只有两份：档位清单 + `exec` 档的占屏/键鼠批。
 */
function isAliveWakeToolAllowed(power, name) {
  const tier = power || 'read';
  if ((ALIVE_WAKE_POWER_TOOL_NAMES[tier] || ALIVE_WAKE_POWER_TOOL_NAMES.read).has(name)) return true;
  if (tier !== 'exec') return false;
  const playback = alivePlaybackToolNames();
  return playback.includes(String(name || ''));
}

/**
 * 心跳轮**这一轮真正发给模型的工具表**：该档清单 ∩ 开关开着的。
 *
 * 单一来源只有两份数据 —— 档位清单（`ALIVE_WAKE_POWER_TOOL_NAMES`，`exec` 档另加
 * `alivePlaybackToolNames`）与开关表。以前工具表在 `main-agent-tools` 里按
 * `PLAN_RUNTIME_TOOL_NAMES` 另拼一份，与清单互不知道，于是同一件事出现两种病：
 * 清单里有但模型看不见（`grep` / `codebase_search` / `memory_recall` / `session_recall` /
 * `plan_list` / `peer_list` 全都没发下去，它的"读"只剩整文件读），工具表里有但清单没有
 * （`web_search` 每轮撞一次 `READ_ONLY_SCOPE`，白烧一轮）。
 *
 * `caps` 是开关表（缺省一律按关）：`eyes`（感官，摄像头）、`browserAutomation`、`osControl`（本机权限）。
 * 关着的工具不注入：发一个注定被拒的工具，等于让它每轮试一次再失败。
 */
function aliveWakeToolNames(power, caps) {
  const on = (key) => !!(caps && caps[key] === true);
  const names = [...(ALIVE_WAKE_POWER_TOOL_NAMES[power] || ALIVE_WAKE_POWER_TOOL_NAMES.read)];
  if (power === 'exec') names.push(...alivePlaybackToolNames());
  return names.filter((name) => {
    const sense = ALIVE_SENSE_TOOLS[name];
    if (sense) return on(sense);
    if (ALIVE_YIELD_TOOL_NAMES.has(name)) return on('osControl');
    if (isAliveYieldTool(name)) return on('browserAutomation');
    return true;
  });
}

/**
 * 单次调用可能**合法运行很久**的工具（工具级 stall 看门狗要给更长窗口）。
 *
 * `subagent` 是一次完整的子 loop run（一轮调研常常十几分钟），用通用 stall 窗口会误杀。
 * 这是按**工具身份**分类（结构信号），不是按用户意图猜。
 */
const LONG_RUNNING_TOOL_NAMES = Object.freeze(new Set(['subagent']));

function isLongRunningAgentTool(name) {
  const n = String(name || '')
    .trim()
    .toLowerCase();
  return LONG_RUNNING_TOOL_NAMES.has(n);
}

/**
 * 入参携带 `filePath`、可据此「按文件串行」的写入工具名。
 * 与 FILE_WRITE_TOOL_NAMES 是**包含关系而非同一概念**：后者含 skill_create /
 * agents_md_propose 等无 filePath 的写入工具，无法按文件分组，故单列此更窄的集合
 * （delegate-batch 分组用）。新增「写文件且带 filePath」的工具时改这里。
 */
const FILE_PATH_KEYED_WRITE_TOOL_NAMES = Object.freeze(new Set(['fs_write_file', 'fs_edit']));

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
 * 判定不出（bmp/svg/heic/tiff/ico、空串）一律返回 ''。
 *
 * **唯一判型实现**：base64 版（`sniffVisionImageMime`）与「拿到原始字节」的调用方
 * （频道多媒体下载、本机/手机摄像头）都走这里 —— 以前 `channels/wecom-media.js`
 * 照抄过一份同样的四格式魔数，两边会各自先支持新格式。
 *
 * @param {Buffer|Uint8Array|null} bytes 原始字节（前 16 字节足够）
 * @returns {string} `image/jpeg` / `image/png` / `image/webp` / `image/gif`，认不出 ''
 */
function sniffImageMimeFromBytes(bytes) {
  const b = bytes && bytes.length ? bytes : null;
  if (!b || b.length < 3) return '';
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
    return 'image/png';
  }
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  const sig6 = bytesToLatin1(b, 0, 6);
  if (sig6 === 'GIF87a' || sig6 === 'GIF89a') return 'image/gif';
  if (b.length >= 12 && bytesToLatin1(b, 0, 4) === 'RIFF' && bytesToLatin1(b, 8, 12) === 'WEBP') {
    return 'image/webp';
  }
  return '';
}

/**
 * 用文件头魔数判定图片真实格式；只返回上游支持的 MIME，
 * 判定不出（bmp/svg/heic/tiff/ico、坏 base64、空串）一律返回 ''。
 */
function sniffVisionImageMime(base64) {
  const head = decodeBase64Head(base64, 16);
  if (!head || head.length < 3) return '';
  return sniffImageMimeFromBytes(head);
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
 * 各中转措辞不一（unsupported image / invalid image / unsupported media type / image data rejected），
 * 但只要 HTTP 400 / 415 命中这些词，就属于「丢图重发即可继续」的一类；
 * 其它 400（参数错、额度、审核…）照旧上抛，不做自愈。
 *
 * `image data rejected` / `replace the image` 来自实测的一条中转文案：
 * `{"code":11135,"msg":"Please start a new conversation, replace the image, and try again."}`
 * —— 措辞里既没有 unsupported 也没有 invalid image，过去整轮直接失败（见
 * fitVisionShotToBudget 的注释：图太大就根本不该发出去，这是第二道兜底）。
 */
const IMAGE_REJECT_ERROR_RE =
  /unsupported image|invalid image|unsupported media type|unsupported media|image format|image data rejected|replace the image|image (?:is )?too large|image size|image dimensions/i;

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

/** 未声明 `verify` 时的兜底词表（**不是**主判据：自有脚本猜不出来，见 `hostExecLooksValidation`）。 */
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

/**
 * 这条 host_exec 是否属于「验证」（测试 / 类型检查 / lint / 构建 / 冒烟）。
 *
 * 判断归模型：`host_exec` 的 `verify` 布尔参数就是模型自己声明的结论（显式 true/false 都算数）。
 * 下面的正则只是**模型没声明时**的兜底 —— 它帮不上自有脚本（`make verify`、`npm run smoke`、
 * `cargo clippy` 都猜不出来），所以不能当主判据，也不该继续往词表里塞命令名。
 */
function hostExecLooksValidation(commandOrArgs) {
  const declared =
    commandOrArgs && typeof commandOrArgs === 'object' ? commandOrArgs.verify : undefined;
  if (typeof declared === 'boolean') return declared;
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

/**
 * 「能力型」工具：执行前必须由用户显式授权（键 = `permissions-store` 里的字段）。
 *
 * 为什么注入之外还要拦一道：工具不在模型清单里 ≠ 模型不会调用它 ——
 * 上一轮开着、这一轮用户关掉（或历史里留着同名调用）时，模型仍可能发出这个名字。
 * 摄像头拍的是现实世界，用户关掉就是关掉，执行前必须在同一处再确认一次。
 */
const PERMISSION_GATED_TOOLS = Object.freeze({
  camera_look: 'camera',
  desktop_camera_look: 'desktopCamera',
  /**
   * 云台转向用**同一个**开关，不另开一个权限键：转的是同一台摄像头、同一间屋子，
   * 只是把镜头的朝向改了 —— 「能拍到什么」与「能不让它拍」是同一件事。
   * 多一个开关只会造出「能拍但不能转 1°」这种没有安全收益的状态，还要用户点两次同意。
   * 真正的分寸在额度与文案上：一次一动、转完必须读回、生命感心跳轮**拿不到**这个工具
   * （它不在 `ALIVE_READ_ONLY_TOOL_NAMES` 里 —— 移动物理姿态不是「看一眼」）。
   */
  desktop_camera_ptz: 'desktopCamera',
  /**
   * 键鼠 / 截屏：`osControl` 本来就在 `rpc.js` 那道闸上（`computer` 的每个动作都要它）；
   * 收到这里是为了**在关卡层就说清楚**（同一份 `host-permissions.json`，不另写一套判定），
   * 而不是让模型跑到 RPC 才吃到一句通用错误。
   */
  computer: 'osControl'
});

/** 权限键 → 给人看的名字（新增权限键时只改这里） */
const PERMISSION_LABELS = Object.freeze({
  camera: '手机摄像头',
  desktopCamera: '本机摄像头',
  osControl: '电脑控制（键鼠 / 截屏）',
  browserAutomation: '浏览器自动化'
});

/** 能力未授权时的拦截文案（模型据此换策略，不要反复试）。 */
function permissionGateBlockMessage(name, key) {
  const label = PERMISSION_LABELS[key] || key;
  return (
    `工具 ${name} 没有执行：用户没有打开「${label}」权限（默认关）。` +
    '这不是故障，重试也不会成功。请改用其它方式（文字问用户、computer 看屏幕、browser_snapshot），' +
    '或请用户到「设置 → 本机权限」里打开后再说。'
  );
}

/**
 * 「完成验收」提示（`> ⚠️ **完成验收**：…`）是**当轮 UI 提醒**，不属于模型正文。
 *
 * 落库的 `content` 里带着它 → 下一轮作为历史上行 → 模型原样复述一遍 →
 * 与新一轮追加的提示叠成两段（2026-10-17 实测 `messages.id=4834` 同一提示出现两次）。
 * 历史投影与追加点都先过这里，保证全仓只有一种「什么算验收提示」的判定。
 */
const READINESS_NOTE_RE = /(?:^|\n+)-{3,}\n+>\s*\u26A0\uFE0F?\s*\*\*完成验收\*\*[：:][^\n]*/g;

/** 剥掉正文里的验收提示段（幂等；不含该文案时原样返回）。 */
function stripReadinessNotes(text) {
  const s = String(text == null ? '' : text);
  if (!s.includes('完成验收')) return s;
  return s.replace(READINESS_NOTE_RE, '').trim();
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
  ALIVE_READ_ONLY_TOOL_NAMES,
  ALIVE_SENSE_TOOLS,
  ALIVE_WAKE_POWER_TOOL_NAMES,
  ALIVE_WAKE_WRITE_TOOL_NAMES,
  aliveWakeToolNames,
  isAliveWakeToolAllowed,
  isAliveYieldTool,
  alivePlaybackToolNames,
  LONG_RUNNING_TOOL_NAMES,
  isLongRunningAgentTool,
  FILE_PATH_KEYED_WRITE_TOOL_NAMES,
  BROWSER_MUTATING_PREFIXES,
  VISION_IMAGE_MIME,
  REJECTED_IMAGE_PLACEHOLDER,
  normalizeVisionImageMime,
  sniffImageMimeFromBytes,
  sniffVisionImageMime,
  sanitizeImageUrlForApi,
  sanitizeChatBodyImagesForApi,
  mapChatImages,
  // 图片 part 形状判定的单一来源：计费（token-estimate.js）与出站闸门共用同一套形状，
  // 否则会出现「闸门拦下了、账本还把 base64 当正文算」这种两边不认同一件事的漂移。
  isChatImagePart,
  isLlmImageRejectedError,
  parseRejectedImageMessageIndices,
  dropRejectedChatImagesForApi,
  isMutatingAgentTool: isMutatingAgentToolName,
  PERMISSION_GATED_TOOLS,
  permissionGateBlockMessage,
  fsEditArgsPresent,
  createGuardrailApi,
  READINESS_NOTE_RE,
  stripReadinessNotes
};

module.exports = SHARED_EXPORTS;
