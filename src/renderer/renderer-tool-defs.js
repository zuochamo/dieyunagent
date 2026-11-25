/* global window, $, fetch, escapeHtml, gwState, gatewayCall, currentSessionId, loadEnabledSkillIds, showAgentToast, getAgentsMdMode, CTX_LIMITS, openDatabaseSettingsModal, getAgentLimits */
const toolDefsApi = window.diecloud || {};

const _tc = typeof DieyunToolCatalog !== 'undefined' ? DieyunToolCatalog : {};
const HOST_TOOLS = _tc.HOST_TOOLS || [];
const WEB_TOOLS = _tc.WEB_TOOLS || [];
const BROWSER_TOOLS = _tc.BROWSER_TOOLS || [];
// 浏览器工具两层：CORE 常驻；ADVANCED（验收/调试/凭据/导出）仅在浏览器任务上下文中注册。
const BROWSER_CORE_TOOLS = Array.isArray(_tc.BROWSER_CORE_TOOLS) ? _tc.BROWSER_CORE_TOOLS : BROWSER_TOOLS;
const BROWSER_ADVANCED_TOOLS = Array.isArray(_tc.BROWSER_ADVANCED_TOOLS) ? _tc.BROWSER_ADVANCED_TOOLS : [];
const CODEBASE_TOOL = _tc.CODEBASE_TOOL;
const GREP_TOOL = _tc.GREP_TOOL;
const GLOB_TOOL = _tc.GLOB_TOOL;
const READ_SYMBOL_TOOL = _tc.READ_SYMBOL_TOOL;
const LSP_TOOL = _tc.LSP_TOOL;
const GRAPH_TOOL = _tc.GRAPH_TOOL;
const AGENTS_MD_PROPOSE_TOOL = _tc.AGENTS_MD_PROPOSE_TOOL;
const MEMORY_TOOLS = Array.isArray(_tc.MEMORY_TOOLS) ? _tc.MEMORY_TOOLS : [];
const SKILL_CREATE_TOOL = _tc.SKILL_CREATE_TOOL;
// 删除技能：schema 单一来源同上，删除判定在 src/agent-home.js#deleteUserSkill。
const SKILL_DELETE_TOOL = _tc.SKILL_DELETE_TOOL || null;
// 改技能正文：单一来源同上，判定与写盘在 src/agent-home.js#updateUserSkill。
const SKILL_UPDATE_TOOL = _tc.SKILL_UPDATE_TOOL || null;
const PLAN_TOOLS = _tc.PLAN_TOOLS || [];
// 会话级目标：goal_start 常驻（模型可自主开目标），推进期工具按会话是否有目标动态给（见下方 buildAgentTools）。
const GOAL_START_TOOL = _tc.GOAL_START_TOOL || null;
const GOAL_TOOLS = Array.isArray(_tc.GOAL_TOOLS) ? _tc.GOAL_TOOLS : [];
const GOAL_UPDATE_TOOL = _tc.GOAL_UPDATE_TOOL || null;
const MCP_TOOL_SCHEMA_TOOL = _tc.MCP_TOOL_SCHEMA_TOOL;
// 装/改/启停 MCP 服务：schema 单一来源同 tool-catalog，执行在 Main（mcp/manage.js）。
// 只给桌面聊天路径（计划/频道那档静态工具集刻意不含它 —— 后台轮次不该改用户配置）。
const MCP_MANAGE_TOOL = _tc.MCP_MANAGE_TOOL || null;
const CLARIFY_TOOL = _tc.CLARIFY_TOOL;
// 新建对话 + 挂工作空间：schema 单一来源同上，执行在 Renderer（会话状态归 Renderer 所有）。
const SESSION_TOOL = _tc.SESSION_TOOL || null;
// 只改当前对话的工作空间（不新建对话）：同样由 Renderer 执行，复用工作空间选择器那条流程。
// 频道那条路由 Main 自己执行同一个工具名（`channels/workspace-switch.js`），这里不参与。
const SESSION_WORKSPACE_TOOL = _tc.SESSION_WORKSPACE_TOOL || null;
// 只读并发调研子 Agent：schema 单一来源在 src/agent/tool-catalog.js（Main 执行）。
const SUBAGENT_TOOL = _tc.SUBAGENT_TOOL;
const FAN_OUT_TOOL = _tc.FAN_OUT_TOOL;
const SUBAGENT_STATUS_TOOL = _tc.SUBAGENT_STATUS_TOOL;
// 「看一眼自己」：档位 / 真实可写根 / 生效预算 / 最近失败面 —— schema 单一来源在 catalog/self.js。
const AGENT_INSPECT_TOOL = _tc.AGENT_INSPECT_TOOL || null;
// 申请一项能力（开权限开关 / 填 MCP 凭据）：同源同上。它不能提权，只把请求送到界面。
const AGENT_CAPABILITY_TOOL = _tc.AGENT_CAPABILITY_TOOL || null;
// OS 级电脑控制（截屏 + 鼠标键盘）：schema 单一来源同上，注入受 osControl 开关控制。
const COMPUTER_TOOL = _tc.COMPUTER_TOOL || null;
// 手机摄像头（拍一张现实画面）：schema 单一来源同上，注入受 camera 权限开关控制（默认关）。
const CAMERA_TOOL = _tc.CAMERA_TOOL || null;
// 本机摄像头（电脑上接的 UVC，如 OBSBOT Tiny 2）：schema 单一来源同上，
// 注入受 desktopCamera 权限开关控制（默认关，理由同手机摄像头）。
const DESKTOP_CAMERA_TOOL = _tc.DESKTOP_CAMERA_TOOL || null;
// 本机云台转向（desktop_camera_ptz）：schema 单一来源同上。与取帧**共用** desktopCamera 开关 ——
// 转的是同一台摄像头，多一个开关只会造出「能拍但不能转 1°」这种没有安全收益的状态。
const DESKTOP_CAMERA_PTZ_TOOL = _tc.DESKTOP_CAMERA_PTZ_TOOL || null;
// 身体（点点）：schema 单一来源 `agent/catalog/pet.js`。桌面版才有 —— `petGetSettings` 是桌面
// preload 的接口（网页版 / headless 没有）。聊天轮**常驻**：用户在聊天里说「改成 256 个点 /
// 换个形态」时，模型要靠它调参数；以前它只在心跳轮的工具表里，聊天轮没有 → 模型去改源码。
// 宠物没显示时不靠「工具不存在」表达，执行端回 PET_DISABLED 结构化错误（与 peer_* 同一取舍）。
const PET_TOOLS = Array.isArray(_tc.PET_TOOLS) ? _tc.PET_TOOLS : [];
// SSH 远程主机（连/断/端口转发/切远端工作空间）：schema 单一来源同上，执行在 Main（ssh/actions.js）。
const SSH_TOOL = _tc.SSH_TOOL || null;
// Worktree 副本（开/清/写回）：schema 单一来源同上，执行在 Main（worktree/actions.js）。
const WORKTREE_TOOL = _tc.WORKTREE_TOOL || null;
// 内网 agent 互通（peer_list / peer_send / peer_claim）：schema 单一来源同上，
// 执行在 Main 的 peer coordinator（Bot 面板读的是同一份语义）。
const PEER_TOOLS = Array.isArray(_tc.PEER_TOOLS) ? _tc.PEER_TOOLS : [];
const isWeakToolCallerModel = _tc.isWeakToolCallerModel || function () { return false; };
const compactMcpToolDef = _tc.compactMcpToolDef || function (entry) { return entry && entry.tool; };
const mcpToolDescription = _tc.mcpToolDescription;
const mcpCandidate = _tc.mcpCandidate;

async function getHostToolFlags() {
  if (!gwState.authed || !toolDefsApi.getPermissions) {
    return { openUrl: false, exec: false, fsRead: false, fsWrite: false, webFetch: false, browser: false, osControl: false, camera: false, desktopCamera: false };
  }
  try {
    const p = await toolDefsApi.getPermissions();
    const webFetch = p?.webFetch !== false;
    const browser = p?.browserAutomation !== false;
    const osControl = p?.osControl === true;
    // 摄像头拍的是现实世界，默认关：只有用户显式打开才注入 camera_look / desktop_camera_look。
    const camera = p?.camera === true;
    const desktopCamera = p?.desktopCamera === true;
    if (!p || !p.hostControl) {
      return {
        openUrl: false,
        exec: false,
        fsRead: false,
        fsWrite: false,
        webFetch,
        browser: false,
        osControl: false,
        camera: false,
        desktopCamera: false,
        hostControl: false
      };
    }
    return {
      hostControl: true,
      openUrl: true,
      exec: !!p.shellExec,
      fsRead: !!p.fsRead,
      fsWrite: !!p.fsWrite,
      webFetch,
      browser,
      osControl,
      camera,
      desktopCamera
    };
  } catch {
    return { openUrl: false, exec: false, fsRead: false, fsWrite: false, webFetch: false, browser: false, osControl: false, camera: false, desktopCamera: false };
  }
}

function hostToolByName(name) {
  return HOST_TOOLS.find((t) => t && t.function && t.function.name === name);
}

async function shouldExposeGraphTools() {
  if (!gwState.authed) return false;
  return true;
}

function pushGraphTools(tools) {
  if (GRAPH_TOOL) tools.push(GRAPH_TOOL);
}

/**
 * 会话是否已进入浏览器任务：以「本会话确实调用过 browser_* 工具」为准。
 * 用的是已发生的工具调用（结构信号），不做意图关键词/寒暄词判断。
 */
const sessionBrowserToolUsed = new Set();

function noteBrowserToolUse(sessionId) {
  const sid = String(sessionId || '').trim();
  if (sid) sessionBrowserToolUsed.add(sid);
}

if (typeof window !== 'undefined') {
  window.noteBrowserToolUse = noteBrowserToolUse;
}

/** 浏览器是否已有活跃页面（BrowserView 有视图，或 Playwright 可用且 URL 非空）。 */
async function hasActiveBrowserPage() {
  if (!gwState.authed) return false;
  try {
    const st = await Promise.race([
      gatewayCall('browser.status', {}),
      new Promise((resolve) => setTimeout(() => resolve(null), 800))
    ]);
    if (!st || st.ok === false) return false;
    const bv = st.browserview || {};
    const pw = st.playwright || {};
    const url = String((bv.hasView ? bv.url : '') || (pw.available ? pw.url : '') || '').trim();
    return !!url && url !== 'about:blank';
  } catch {
    return false;
  }
}

async function shouldExposeAdvancedBrowserTools(sessionId) {
  const fallback = typeof currentSessionId !== 'undefined' ? currentSessionId : '';
  const sid = String(sessionId || fallback || '').trim();
  if (sid && sessionBrowserToolUsed.has(sid)) return true;
  return hasActiveBrowserPage();
}

async function buildAgentTools(userQuery = '', opts = {}) {
  if (opts.signal?.aborted) {
    const err = new Error('已停止');
    err.name = 'AbortError';
    throw err;
  }
  const prepSid = opts.prepSessionId ? String(opts.prepSessionId) : '';
  if (prepSid && typeof agentPrepStepStart === 'function') agentPrepStepStart(prepSid, 'tools');
  try {
  const tools = [];
  const weakModel = isWeakToolCallerModel(opts.model);
  const host = await getHostToolFlags();
  if (host.openUrl) tools.push(hostToolByName('host_open_url'));
  if (host.exec) {
    tools.push(hostToolByName('host_print_image'));
    tools.push(hostToolByName('host_exec'));
    tools.push(hostToolByName('host_proc'));
  }
  if (host.fsRead) {
    tools.push(hostToolByName('fs_read_file'));
    tools.push(hostToolByName('fs_list_dir'));
    tools.push(GREP_TOOL);
    tools.push(GLOB_TOOL);
    tools.push(READ_SYMBOL_TOOL);
    tools.push(LSP_TOOL);
  }
  if (host.fsWrite) {
    tools.push(hostToolByName('fs_edit'));
    tools.push(hostToolByName('fs_write_file'));
  }
  if (host.fsWrite && getAgentsMdMode() !== 'off') tools.push(AGENTS_MD_PROPOSE_TOOL);
  if (host.hostControl) tools.push(SKILL_CREATE_TOOL);
  if (host.hostControl && SKILL_DELETE_TOOL) tools.push(SKILL_DELETE_TOOL);
  // 改技能正文：与创建/删除同一闸（都是写 ~/.dieyun/skills）。没有它，模型只能「删了重建」，
  // 而重建会派生 name-1 目录并丢掉启用状态（见 agent-home#updateUserSkill 的注释）。
  if (host.hostControl && SKILL_UPDATE_TOOL) tools.push(SKILL_UPDATE_TOOL);
  if (host.webFetch) tools.push(...WEB_TOOLS);
  if (host.browser && !weakModel) tools.push(...BROWSER_CORE_TOOLS);
  else if (host.browser && weakModel) {
    const weakBrowser = new Set(['browser_navigate', 'browser_snapshot', 'browser_a11y_snapshot', 'browser_network', 'browser_console', 'browser_frames', 'browser_timeline', 'browser_observe', 'browser_status', 'browser_close']);
    tools.push(...BROWSER_TOOLS.filter((t) => weakBrowser.has(t.function.name)));
  }
  if (host.browser && !weakModel && (await shouldExposeAdvancedBrowserTools(prepSid))) {
    tools.push(...BROWSER_ADVANCED_TOOLS);
  }
  // 电脑控制：开关即同意读屏；坐标点击对弱模型不可靠，与 browser 高级工具同样不给弱模型。
  if (host.osControl && !weakModel && COMPUTER_TOOL) {
    tools.push(COMPUTER_TOOL);
  }
  // 手机摄像头：拍一张看一眼，无坐标、无参数依赖，弱模型也能用，故不按 weakModel 收窄。
  if (host.camera && CAMERA_TOOL) {
    tools.push(CAMERA_TOOL);
  }
  // 本机摄像头：同上（电脑上那台固定机位），同样不按 weakModel 收窄。
  if (host.desktopCamera && DESKTOP_CAMERA_TOOL) {
    tools.push(DESKTOP_CAMERA_TOOL);
  }
  // 本机云台：开关同上（同一台设备）。没有电机的机型执行端会回 NO_PTZ，不靠「工具不存在」表达。
  if (host.desktopCamera && DESKTOP_CAMERA_PTZ_TOOL) {
    tools.push(DESKTOP_CAMERA_PTZ_TOOL);
  }
  // 身体（点点）：只有桌面版有这具身体（`petGetSettings` 由桌面 preload 提供）。
  // 与相机不同，它不受 host 权限开关管：改的是用户自己的宠物外观，不读现实世界、不碰文件。
  if (typeof toolDefsApi.petGetSettings === 'function' && PET_TOOLS.length) {
    tools.push(...PET_TOOLS);
  }
  // SSH 远端：与 host 权限开关无关（连接参数/凭据由用户在界面上给），常驻。
  if (SSH_TOOL) tools.push(SSH_TOOL);
  // Worktree 会写回主工作区（apply_run 落的是本机仓库里的文件），所以跟「文件写入」同一个闸：
  // 用户关掉写入后还能让 Agent 通过副本把文件塞进仓库，这个开关就等于没关。
  if (host.fsWrite && WORKTREE_TOOL) tools.push(WORKTREE_TOOL);
  // 内网 agent 互通：常驻，与 host 权限开关无关（对端是同一内网里别人那台机器上的 agent）。
  // 互通没启用时不靠「工具不存在」表达 —— 执行端返回 PEER_UNAVAILABLE 结构化错误，
  // 与 goal_* 同一取舍：模型能从错误里读到该去哪儿开，而不是以为自己没有这个能力。
  tools.push(...PEER_TOOLS);
  if (gwState.authed) {
    tools.push(CODEBASE_TOOL);
    // 记忆读写都在 Gateway：召回（只读）与软归档（可恢复）跟 codebase 同条件暴露。
    tools.push(...MEMORY_TOOLS);
    if (await shouldExposeGraphTools()) pushGraphTools(tools);
  }
  tools.push(...PLAN_TOOLS);
  // 会话级目标（goal_start / goal_check / goal_finish / goal_update）**常驻**：
  // 要不要把任务当成「做到 X 成立为止」是模型自己的判断；而且一轮之内可能「先开目标、
  // 接着跑检查、再收尾」—— 按「本会话已有目标」条件暴露会让同一轮里开出来的目标无法当场推进
  // （工具表在轮次开始时定好，轮内不再变）。没有目标时这四件工具给结构化错误（NO_SESSION_GOAL），
  // 那比「工具不存在」更准确。
  if (GOAL_START_TOOL) tools.push(GOAL_START_TOOL);
  tools.push(...GOAL_TOOLS);
  if (GOAL_UPDATE_TOOL) tools.push(GOAL_UPDATE_TOOL);
  tools.push(CLARIFY_TOOL);
  // MCP 服务管理（装/改/启停）：不需要 MCP 已启用 —— 它的用途正是「还没有服务时把服务接进来」，
  // 所以不放在 line 下方 hasMcpOptional 的条件里。
  if (MCP_MANAGE_TOOL) tools.push(MCP_MANAGE_TOOL);
  // 建会话 / 换工作空间：与「新对话」按钮同一条渲染器流程，不依赖 host 权限开关。
  if (SESSION_TOOL) tools.push(SESSION_TOOL);
  if (SESSION_WORKSPACE_TOOL) tools.push(SESSION_WORKSPACE_TOOL);
  // Agent 主循环是协调者：可派只读研究子 Agent（深度恒为 1），并可查本轮的
  // 子 Agent 账本（哪些还能 continueFrom 追问 —— 追问的 id 不能靠记忆猜）。
  if (SUBAGENT_TOOL) tools.push(SUBAGENT_TOOL);
  // 中途改道（把这一轮交给多路并行）：只有「多 Agent 并行执行」开着才给 ——
  // 关着时宿主不会接手 planner，给了就是空承诺。
  if (FAN_OUT_TOOL && typeof getAgentLimits === 'function' && getAgentLimits().plannerMultiAgentEnabled === true) {
    tools.push(FAN_OUT_TOOL);
  }
  if (SUBAGENT_STATUS_TOOL) tools.push(SUBAGENT_STATUS_TOOL);
  // 看一眼自己（档位 / 可写根 / 生效预算 / 最近失败面）：只读、常驻。
  // 它不进 optionalEntries（不参与 MCP 召回），也不受 host 权限开关管 —— 关着某些能力时，
  // 它恰恰是模型唯一能问「到底关了什么」的地方。
  if (AGENT_INSPECT_TOOL) tools.push(AGENT_INSPECT_TOOL);
  // 申请一项能力（权限开关 / MCP 凭据）：常驻、不受 host 权限开关管 ——
  // 关着某些能力时，它恰恰是模型把请求送到用户眼前的唯一通道。
  if (AGENT_CAPABILITY_TOOL) tools.push(AGENT_CAPABILITY_TOOL);

  const optionalEntries = [];

  const mcpApi = window.diecloud || {};
  const toolRecallLimit =
    typeof CTX_LIMITS !== 'undefined' && CTX_LIMITS.TOOL_RECALL_LIMIT
      ? CTX_LIMITS.TOOL_RECALL_LIMIT
      : 10;
  const effectiveRecallLimit = weakModel ? Math.min(5, toolRecallLimit) : toolRecallLimit;
  let mcpCatalogTools = [];
  let enabledMcpIds = new Set();

  if (mcpApi.getMcpRuntimeTools) {
    try {
      if (mcpApi.listMcpServers) {
        const servers = await mcpApi.listMcpServers();
        enabledMcpIds = new Set(
          (servers || []).filter((s) => s && s.enabled).map((s) => String(s.id))
        );
      }
      const catalog = await Promise.race([
        mcpApi.getMcpRuntimeTools({ catalogOnly: true }),
        new Promise((_, reject) => {
          setTimeout(() => reject(new Error('MCP 目录读取超时')), 8000);
        })
      ]);
      mcpCatalogTools = (catalog.tools || []).filter((item) =>
        enabledMcpIds.size ? enabledMcpIds.has(String(item.serverId)) : true
      );
      for (const item of mcpCatalogTools) {
        // 描述模板与候选项形状都取自单一来源（bundle 里由 tool-catalog 再导出）；
        // 末尾的兜底只在产物未重建时生效，与 `compactMcpToolDef` 的兜底同一口径。
        const describe = mcpToolDescription || ((it) => `[MCP · ${it.serverId}] ${it.description || it.toolName}`);
        const candidateOf = mcpCandidate || ((it) => ({
          id: it.agentName,
          name: it.agentName,
          description: describe(it),
          source: 'mcp',
          serverId: it.serverId || ''
        }));
        optionalEntries.push({
          id: item.agentName,
          tool: {
            type: 'function',
            function: {
              name: item.agentName,
              description: describe(item),
              parameters:
                item.inputSchema && typeof item.inputSchema === 'object'
                  ? item.inputSchema
                  : { type: 'object', properties: {} }
            }
          },
          candidate: candidateOf(item)
        });
      }
    } catch {
      // MCP 连接失败时不阻塞其它工具
    }
  }

  let selectedOptional = optionalEntries;
  if (optionalEntries.length > effectiveRecallLimit && typeof mcpApi.recallAgentTools === 'function') {
    try {
      const recalled = await mcpApi.recallAgentTools({
        query: String(userQuery || ''),
        limit: effectiveRecallLimit,
        candidates: optionalEntries.map((entry) => entry.candidate)
      });
      const picked = new Set((recalled.tools || []).map((row) => row.id));
      if (picked.size) {
        selectedOptional = optionalEntries.filter((entry) => picked.has(entry.id));
      } else {
        selectedOptional = optionalEntries.slice(0, effectiveRecallLimit);
      }
    } catch {
      selectedOptional = optionalEntries.slice(0, effectiveRecallLimit);
    }
  } else if (optionalEntries.length > effectiveRecallLimit) {
    selectedOptional = optionalEntries.slice(0, effectiveRecallLimit);
  }

  const hasMcpOptional = selectedOptional.some((e) => e.candidate && e.candidate.source === 'mcp');
  if (hasMcpOptional) {
    tools.push(MCP_TOOL_SCHEMA_TOOL);
  }

  for (const entry of selectedOptional) {
    if (entry.candidate && entry.candidate.source === 'mcp' && hasMcpOptional) {
      tools.push(compactMcpToolDef(entry));
    } else {
      tools.push(entry.tool);
    }
  }
  return tools;
  } finally {
    if (prepSid && typeof agentPrepStepDone === 'function') agentPrepStepDone(prepSid, 'tools');
  }
}

window.isWeakToolCallerModel = isWeakToolCallerModel;
