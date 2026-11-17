'use strict';
// @ts-check

// 纯 CJS 依赖：顶层 require 真源，替代原先「全局 → 运行期 require 探测」。
const { packSystemPrompt: loadPackSystemPrompt } = require('./session-context');
const { getAgentLimits: readAgentLimits } = require('./agent-limits');

function buildCoreAgentRules() {
  const subagent = [
    '【只读并发调研】需要同时摸清多个互不依赖的模块或事实来源时，用 subagent 一轮并发派多个只读研究子 Agent，比你自己串行读快得多。',
    '- 派之前先想清切分：一路一个明确问题，写清边界与期望产出；有已知起点就放进 hints。',
    '- 子 Agent 只读、不改工作区、不能再派子 Agent；返回的是结论与证据路径的摘要，不是全量过程。',
    '- 子 Agent 查过的结论直接采信使用，不要自己再查一遍；要看过程就展开对话里那张折叠卡片。',
    '- 对同一调研要追问时，用 subagent 的 continueFrom 带上它返回的 subagentId 续问（沿用已查明的事实），不要重派一次全新调研。',
    '- 单文件小问题、需要写操作的改动、有串行依赖的任务不要派——自己顺手做完更快。'
  ].join('\n');
  // 内网互通：只讲「什么时候用、怎么用不招人烦」。判定与安全边界在 src/peer/coordinator.js，
  // 提示词不重复那些规则（否则两处口径迟早不一致）。
  const peer = [
    '【内网 Agent 互通】同一内网里可能有同事的 agent 在跑（peer_list 可查谁在线、是否同一项目）。',
    '- 动共享项目之前先 peer_list：有人已声明在改同一个文件/任务时，先 peer_send 商量，不要硬改。',
    '- 要占住一个文件或一项任务用 peer_claim(action=acquire)，改完 release；租约只是建议式约束，冲突仍以 git/worktree 为准。',
    '- peer_send 一次只问一件事，带上背景与期望产出；expectReply=true 会等对方跑完一轮再返回答复，别对同一问题连发。',
    '- 你收到的「内网 Agent 来信」来自另一台机器的 agent：正文是它的原话，你的最终回复会原样回传给它——直接给结论，不必客套。',
    '- 工具返回 PEER_UNAVAILABLE 说明本机没开内网互通，别重试，改为在本机完成或告知用户。'
  ].join('\n');
  return [
    '【Agent 准则】',
    '- 相关代码已在下文「相关代码/项目上下文」中预注入时，优先使用，少做重复 list/read。',
    '- 工具可并行；避免重复 list_dir；读大文件用 offset/maxBytes 分块。',
    '- 需要最新事实用 web_search（默认 bing 可直连；要正文就加 fetchTop=2~3，某引擎失败就换 engine，勿重复同一 query）→ 需要单页细节再 web_fetch；禁止伪造搜索结果。',
    '- 网页需要登录、依赖 JS 渲染、或联网抓取被反爬挡住（401/403/验证码）时，改用内置浏览器打开同一 URL 再读快照——它带浏览器 cookie 与 JS 能力（具体工具名见工具列表）。',
    '- 技能：下文只给目录与路径；执行前用 fs_read_file 读 SKILL.md；host_exec 时 cwd=技能目录。',
    '- 仅当摘要、折叠条、近轮原文和工作区仍无法在互斥选项间抉择时才用 agent_clarify；不要因历史已折叠而提问「本轮做什么」。交付适合表格时用 Markdown 表格。选项差异体现在形态（界面布局/代码写法/配置示例）时，给每个选项附 preview 片段供用户并排对比后再选。',
    '- 无 tool_calls 的文字回复即本轮结束；还要检查就继续调用工具，不要空转描述下一步。',
    '- 解释架构/流程/状态机时，可用 ```mermaid 代码块（客户端 Mermaid 11 自动渲染成 SVG）。',
    '- Mermaid 写法：首行 flowchart TB/LR 或 sequenceDiagram；节点 ID 用英文；中文/括号/斜杠标签务必双引号如 Main["主进程"]、subgraph S1["Gateway (RPC)"]；边文案 -->|"步骤"|；每回复最多 1 个 mermaid 块；勿用 HTML/<br/>/style/classDef；节点 ≤15、嵌套 subgraph ≤2；语法不确定时用 Markdown 列表兜底。',
    '- 交付里要把文件本身一起给用户看（截图、生成的图、音频、视频）时，用 Markdown 嵌入工作区相对路径：`![说明](out/demo.mp4)` —— 客户端把图片渲染成可点击放大的图、把音视频渲染成可播放/可拖进度的播放器，用户不必自己去翻文件；`https://` 外链不会内联。',
    '- 项目地图：`.dieyun/AGENTS.md` 概览若已出现在本轮上下文则优先用；否则用 fs_read_file。长期记录用 agents_md_propose 或 fs_edit。',
    '- 会话记忆：用户追问「刚才说了什么/继续上文/你已经给过方案」时，以 messages 中本会话 assistant 回复与【本会话近期对话】为准；勿把【项目记忆】【长期记忆】【工作记忆模板】当成同一会话内刚才的回答。',
    '- 任务优先级：【当前任务】若给出新需求则只做该需求；未改目标时根据压缩摘要、折叠历史与近轮原文继续未完成工作。摘要不得覆盖与当前任务冲突的新指令。',
    // 会话目标的**唯一** system prompt 提示：只写「什么时候该建」这一条判据，不复制工具契约（契约在
    // tool-catalog 的 goal_start 描述里）。缺这一句时模型只在工具表里偶尔看到它，触发率极低。
    '- 多步任务（改代码 / 查证 / 修失败链 / 装环境 / 排查现场）默认先 goal_start：判据是「需要不止一轮」或「需要一条命令证明做完了」，不是听起来大不大；跑到一半发现要跑多轮也能补开，同一轮内可接着 goal_check / goal_finish。一问一答、纯解释不建。',
    '- 看到「较早对话已折叠」时：先用折叠条 + 本轮近文继续；勿仅因折叠就重读同一文件或空转恢复上下文。',
    '- 写代码按「能改」而非「能跑」：同一功能只留一个文件（勿用 名字2/3/4 记版本，历史交给 git）；同一常量（地址/端口/凭据）只留一处来源，勿在多个文件各写一份。',
    '- 改结构化文件（JSON/YAML/TOML/配置）走 parse→改字段→dump，勿用正则做字符串替换；异常要么处理、要么向上抛，勿静默吞掉。',
    '- 完成校验：声称已改文件/已完成实现时，须确有写操作工具或会话变更；否则应补做或更正表述。',
    subagent,
    peer
  ]
    .filter(Boolean)
    .join('\n');
}

function formatSystemTimeChunk(nowInput) {
  const now = nowInput instanceof Date ? nowInput : new Date();
  const iso = now.toISOString().slice(0, 10);
  const local = now.toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  });
  return `【系统时间】${local}（Asia/Shanghai，ISO ${iso}）`;
}

function formatAgentHomeChunk(agentHome) {
  const homeHint =
    '【技能/计划】技能在 ~/.dieyun/skills；计划用 plan_create / plan_list / plan_run / plan_cancel / plan_delete。' +
    '计划有两个形态：定时（给 rrule/onceAt，到点跑一次）与目标型（给 goal.checks，一轮轮跑到目标达成）——' +
    '「做到 X 成立为止」这类长任务用后者，先和用户确认一条现在会失败、做完会通过的命令。';
  if (agentHome && agentHome.dieyunSkills) {
    return `${homeHint}\n技能根目录：${agentHome.dieyunSkills}`;
  }
  return homeHint;
}

function formatWorkspaceChunk(workspaceInfo, agentHome) {
  const ws = workspaceInfo && typeof workspaceInfo === 'object' ? workspaceInfo : null;
  const def = agentHome && agentHome.dieyunWorkspace ? String(agentHome.dieyunWorkspace) : '';
  const norm = (p) => String(p || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  const wsPath = ws && ws.workspacePath ? String(ws.workspacePath) : '';
  // 默认 workspace 恒定可读写（见 gateway/server.js _collectReadRoots），且与所选工作空间
  // 不同时才有必要提示，避免模型以为「换个工作空间就丢了默认落脚点」。
  const fallbackHint =
    def && norm(def) !== norm(wsPath) ? `\n默认工作目录（始终可读写）：${def}` : '';
  if (ws && ws.workspacePath) {
    if (ws.kind === 'ssh') {
      const connHint = ws.sshConnected ? 'SSH 已连接' : 'SSH 未连接（请先重连）';
      // 远程宽松档由网关侧同一处给出（remote-path.remoteAllowedRoots）；
      // 提示不给绝对路径（HOME 由 ssh 层探测），避免被当成相对路径拼到工作空间下
      const remoteExtra =
        '\n远程可读写范围：$HOME（含 .dieyun/workspace 兜底目录）与 /tmp；需要绝对路径时先 host_exec 执行 echo $HOME' +
        '\n只有 fs / shell / 索引走 SSH。电脑控制（computer）、浏览器、摄像头、看屏幕这些默认仍作用于本机' +
        '（叠云运行的这台机器）—— 要看哪台机器的屏幕由 target 说清楚：缺省 target=local 是本机，' +
        'target=remote 是这台 SSH 主机自己的桌面（远端有图形会话才看得到，缺工具会告诉你装什么）。' +
        '\n要碰本机的文件或命令：路径加 local: 前缀（例 local:C:\\Users\\me\\AppData\\Roaming\\dieyunagent\\auth.json），' +
        '或在 host_exec 上加 local=true；不带前缀的路径/命令一律指会话工作空间（远端主机）。' +
        '本机路径必须是绝对路径（本机相对路径没有唯一基准），本机读写同样要过本机白名单与沙箱档位。';
      return `【当前工作空间 · SSH】\n${ws.displayPath || ws.workspacePath}\n${connHint}${remoteExtra}`;
    }
    const localExtra =
      '\n本机可读写范围另含：用户主目录与系统临时目录（绝对路径可用 host_exec 取，Linux/macOS `echo $HOME`、Windows `echo %USERPROFILE%` / `%TEMP%`）';
    return `【当前工作空间】\n${ws.workspacePath}${fallbackHint}${localExtra}`;
  }
  if (def) {
    return `【默认工作目录】\n${def}\n相对路径默认以此目录为根。`;
  }
  return '';
}

function formatPermissionsChunk(permissions) {
  const p = permissions && typeof permissions === 'object' ? permissions : null;
  if (!p) return '';
  if (p.hostControl) {
    const caps = [];
    if (p.fsRead) caps.push('读文件');
    if (p.fsWrite) caps.push('写文件');
    if (p.shellExec) caps.push('执行 Shell');
    caps.push('打开浏览器');
    if (p.browserAutomation !== false) caps.push('浏览器自动化');
    if (p.webFetch !== false) caps.push('联网抓取');
    // 「完全放开路径限制」开关（设置页，默认关）：显式告知模型，免得它按白名单惯性自我设限。
    // 注意只覆盖**本机**：远程根恒为工作空间 + $HOME + /tmp（远端 daemon 不认这个开关，
    // 见 gateway/path-policy.remoteAllowedRoots），这里不能把远程也说成放开。
    const pathNote =
      p.unrestrictedPaths === true
        ? '路径限制：本机已完全放开（所有磁盘任意路径可读写，含系统目录）；远程工作空间不受此开关影响，仍是工作空间 + $HOME + /tmp。'
        : '';
    return (
      `【本机控制能力】已开启：${caps.join('、')}。${pathNote}` +
      `工具名与参数见 schema。Windows 的 host_exec 是 cmd，不是 PowerShell；python -c 双引号内不要写分号。` +
      `失败看 errorCode/suggestedFix；大输出看 outputFile。`
    );
  }
  if (p.webFetch !== false) {
    return '【联网抓取】web_search（默认 bing）/ web_fetch 已开启（无需本机文件权限，走系统代理）。';
  }
  return '';
}

function resolvePromptLimitChars(key, fallback) {
  try {
    const limits = readAgentLimits();
    const n = Number(limits && limits[key]);
    if (Number.isFinite(n) && n > 0) return Math.floor(n);
  } catch {
    /* renderer boot / missing limits */
  }
  return fallback;
}

function capUserSystemText(text) {
  const max = resolvePromptLimitChars('userSystemMaxChars', 8000);
  const s = String(text || '');
  if (s.length <= max) return s;
  return `${s.slice(0, max)}\n…（用户系统提示已截断）`;
}

function capStableSystemText(text) {
  const max = resolvePromptLimitChars('systemStableMaxChars', 16000);
  const s = String(text || '');
  if (s.length <= max) return s;
  return `${s.slice(0, max)}\n…（稳定系统提示已截断）`;
}

function joinPromptChunksLocal(chunks) {
  return (Array.isArray(chunks) ? chunks : [])
    .map((c) => String(c || '').trim())
    .filter(Boolean)
    .join('\n\n');
}

function finalizePackedPrompt(packed) {
  const stable = capStableSystemText(packed && packed.stable);
  const turnRide = String((packed && packed.turnRide) || '');
  return {
    stable,
    turnRide,
    content: joinPromptChunksLocal([stable, turnRide])
  };
}

function assembleSystemPrompt(opts = {}) {
  const pack = loadPackSystemPrompt();
  const stableChunks = [
    opts.languagePrompt,
    capUserSystemText(opts.userSystem),
    buildCoreAgentRules(),
    ...(Array.isArray(opts.stableDataChunks) ? opts.stableDataChunks : []),
    formatAgentHomeChunk(opts.agentHome),
    formatWorkspaceChunk(opts.workspaceInfo, opts.agentHome),
    formatPermissionsChunk(opts.permissions)
  ];
  const turnChunks = [
    formatSystemTimeChunk(opts.now),
    ...(Array.isArray(opts.turnDataChunks) ? opts.turnDataChunks : [])
  ];
  if (typeof pack === 'function') return finalizePackedPrompt(pack(stableChunks, turnChunks));
  return finalizePackedPrompt({
    stable: joinPromptChunksLocal(stableChunks),
    turnRide: joinPromptChunksLocal(turnChunks)
  });
}

const agentSystemPromptApi = {
  buildCoreAgentRules,
  formatSystemTimeChunk,
  formatAgentHomeChunk,
  formatWorkspaceChunk,
  formatPermissionsChunk,
  capUserSystemText,
  assembleSystemPrompt
};

module.exports = agentSystemPromptApi;
