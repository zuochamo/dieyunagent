'use strict';
// @ts-check

// 纯 CJS 依赖：顶层 require 真源，替代原先「全局 → 运行期 require 探测」。
const { packSystemPrompt: loadPackSystemPrompt } = require('./session-context');
const { getAgentLimits: readAgentLimits } = require('./agent-limits');

function buildCoreAgentRules(opts = {}) {
  const plan =
    opts.composerMode === 'plan'
      ? '【编排】规划师产出 TODO；Explore 只读 → 多路执行器 worktree 隔离；可 Best-of-N；结束写回主工作区。'
      : '';
  const explore =
    opts.composerMode === 'explore'
      ? '【探索】Explore 只读勘察模式：目标是理解代码库、定位问题、梳理架构/依赖/数据流，最终输出分析报告（结论、证据路径、可行建议）。本模式未提供任何写文件/执行/保存类工具；上文中提及的写类工具条目在此不可用，勿尝试调用。不要声称已修改文件——只报告发现。报告收尾即交付，无需等待执行环节。'
      : '';
  return [
    '【Agent 准则】',
    '- 相关代码已在下文「相关代码/项目上下文」中预注入时，优先使用，少做重复 list/read。',
    '- 工具可并行；避免重复 list_dir；读大文件用 offset/maxBytes 分块。',
    '- 需要最新事实用 web_search → web_fetch 核验；禁止伪造搜索结果。',
    '- SQL：已知库/表勿重复 list；仅 SELECT。',
    '- 技能：下文只给目录与路径；执行前用 fs_read_file 读 SKILL.md；host_exec 时 cwd=技能目录。',
    '- 仅当摘要、折叠条、近轮原文和工作区仍无法在互斥选项间抉择时才用 agent_clarify；不要因历史已折叠而提问「本轮做什么」。交付适合表格时用 Markdown 表格。',
    '- 无 tool_calls 的文字回复即本轮结束；还要检查就继续调用工具，不要空转描述下一步。',
    '- 解释架构/流程/状态机时，可用 ```mermaid 代码块（客户端 Mermaid 11 自动渲染成 SVG）。',
    '- Mermaid 写法：首行 flowchart TB/LR 或 sequenceDiagram；节点 ID 用英文；中文/括号/斜杠标签务必双引号如 Main["主进程"]、subgraph S1["Gateway (RPC)"]；边文案 -->|"步骤"|；每回复最多 1 个 mermaid 块；勿用 HTML/<br/>/style/classDef；节点 ≤15、嵌套 subgraph ≤2；语法不确定时用 Markdown 列表兜底。',
    '- 项目地图：`.dieyun/AGENTS.md` 概览若已出现在本轮上下文则优先用；否则用 fs_read_file。长期记录用 agents_md_propose 或 fs_edit。',
    '- Playbook：`.dieyun/playbooks/` 存可复用 SOP；相关摘要已注入时优先按步骤执行，全文用 fs_read_file；保存流程用 playbook_propose 或直接写该目录。',
    '- Wiki：`.dieyun/wiki/` 给人查阅的项目说明；需要时用 fs_read_file 读对应页面，不要假设已注入。',
    '- 会话记忆：用户追问「刚才说了什么/继续上文/你已经给过方案」时，以 messages 中本会话 assistant 回复与【本会话近期对话】为准；勿把【项目记忆】【长期记忆】【工作记忆模板】当成同一会话内刚才的回答。',
    '- 任务优先级：【当前任务】若给出新需求则只做该需求；未改目标时根据压缩摘要、折叠历史与近轮原文继续未完成工作。摘要不得覆盖与当前任务冲突的新指令。',
    '- 看到「较早对话已折叠」时：先用折叠条 + 本轮近文继续；勿仅因折叠就重读同一文件或空转恢复上下文。',
    '- 写代码按「能改」而非「能跑」：同一功能只留一个文件（勿用 名字2/3/4 记版本，历史交给 git）；同一常量（地址/端口/凭据）只留一处来源，勿在多个文件各写一份。',
    '- 改结构化文件（JSON/YAML/TOML/配置）走 parse→改字段→dump，勿用正则做字符串替换；异常要么处理、要么向上抛，勿静默吞掉。',
    '- 完成校验：声称已改文件/已完成实现时，须确有写操作工具或会话变更；否则应补做或更正表述。',
    plan,
    explore
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
    '【技能/计划】技能在 ~/.dieyun/skills；定时计划用 plan_create / plan_list / plan_delete。';
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
        '\n远程可读写范围：$HOME（含 .dieyun/workspace 兜底目录）与 /tmp；需要绝对路径时先 host_exec 执行 echo $HOME';
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
    if (p.sqlRead) caps.push('SQL只读');
    // 「完全放开路径限制」开关（设置页，默认关）：显式告知模型，免得它按白名单惯性自我设限
    const pathNote =
      p.unrestrictedPaths === true
        ? '路径限制：已完全放开（本机所有磁盘、远程 / 下任意路径均可读写，含系统目录）。'
        : '';
    return (
      `【本机控制能力】已开启：${caps.join('、')}。${pathNote}` +
      `工具名与参数见 schema。Windows 的 host_exec 是 cmd，不是 PowerShell；python -c 双引号内不要写分号。` +
      `失败看 errorCode/suggestedFix；大输出看 outputFile。`
    );
  }
  if (p.webFetch !== false) {
    return '【联网抓取】web_search / web_fetch 已开启（无需本机文件权限）。';
  }
  if (p.sqlRead) {
    return '【本机控制能力】SQL Server 只读查询已开启。';
  }
  return '';
}

function formatSqlChunk(sqlConfig) {
  const sqlCfg = sqlConfig && typeof sqlConfig === 'object' ? sqlConfig : null;
  if (!sqlCfg || !sqlCfg.enabled) return '';
  let dbLine = '';
  if (sqlCfg.databases && sqlCfg.databases.length) {
    dbLine = `\n可访问数据库（${sqlCfg.databases.length} 个）：${sqlCfg.databases.join(', ')}`;
  }
  return (
    `【SQL Server 只读】已连接 ${sqlCfg.host}:${sqlCfg.port}，用户 ${sqlCfg.user}。仅允许 SELECT。` +
    `${dbLine}\n` +
    `优先 sql_query；跨库用 [库].[dbo].[表] 三段式；元数据可用 INFORMATION_SCHEMA。` +
    `勿重复 sql_list_databases；勿对同一库多次 list_tables。`
  );
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
    buildCoreAgentRules({ composerMode: opts.composerMode }),
    ...(Array.isArray(opts.stableDataChunks) ? opts.stableDataChunks : []),
    formatAgentHomeChunk(opts.agentHome),
    formatWorkspaceChunk(opts.workspaceInfo, opts.agentHome),
    formatPermissionsChunk(opts.permissions),
    formatSqlChunk(opts.sqlConfig)
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
  formatSqlChunk,
  capUserSystemText,
  assembleSystemPrompt
};

module.exports = agentSystemPromptApi;
