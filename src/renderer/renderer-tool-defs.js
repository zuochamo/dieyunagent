/* global window, $, fetch, escapeHtml, gwState, gatewayCall, currentSessionId, loadEnabledSkillIds, showAgentToast, getAgentsMdMode, CTX_LIMITS, openDatabaseSettingsModal, buildExploreTools */
const toolDefsApi = window.diecloud || {};

// Explore / Shell / Build 工具白名单与采集函数的唯一来源是
// src/agent/planner-tool-filters.js：Main 侧直接 require，Renderer 侧经
// agent-bundle-entry.js 的 compat 镜像为全局（buildExploreTools 等）。
// 此处不再自抄白名单——白名单里「不得加入 subagent」的不变式只维护一处。

/**
 * 协调者工具集 = Explore 只读白名单 + subagent（可再派只读研究子 Agent）。
 * 只有「协调者」拿这个集合：Agent 主循环、Explore 模式、Plan 的 explore 阶段。
 * 研究子 Agent 只拿 buildExploreTools —— 白名单里没有 subagent，
 * 因此「子 Agent 不能再派」是工具层面的物理约束，不需要运行期判断。
 *
 * 白名单来源缺失（agent-bundle 未产出或未加载）时降级为空集，与调用点
 * renderer-agent-send.js 的降级策略一致：宁可不给工具，也不给写工具。
 */
function buildExploreCoordinatorTools(allTools) {
  if (typeof buildExploreTools !== 'function') return [];
  const base = buildExploreTools(allTools);
  return SUBAGENT_TOOL ? base.concat([SUBAGENT_TOOL]) : base;
}

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
const PLAN_TOOLS = _tc.PLAN_TOOLS || [];
const MCP_TOOL_SCHEMA_TOOL = _tc.MCP_TOOL_SCHEMA_TOOL;
const CLARIFY_TOOL = _tc.CLARIFY_TOOL;
// 新建对话 + 挂工作空间：schema 单一来源同上，执行在 Renderer（会话状态归 Renderer 所有）。
const SESSION_TOOL = _tc.SESSION_TOOL || null;
// 只改当前对话的工作空间（不新建对话）：同样由 Renderer 执行，复用工作空间选择器那条流程。
// 频道那条路由 Main 自己执行同一个工具名（`channels/workspace-switch.js`），这里不参与。
const SESSION_WORKSPACE_TOOL = _tc.SESSION_WORKSPACE_TOOL || null;
// 只读并发调研子 Agent：schema 单一来源在 src/agent/tool-catalog.js（Main 执行）。
const SUBAGENT_TOOL = _tc.SUBAGENT_TOOL;
// OS 级电脑控制（截屏 + 鼠标键盘）：schema 单一来源同上，注入受 osControl 开关控制。
const COMPUTER_TOOL = _tc.COMPUTER_TOOL || null;
// 手机摄像头（拍一张现实画面）：schema 单一来源同上，注入受 camera 权限开关控制（默认关）。
const CAMERA_TOOL = _tc.CAMERA_TOOL || null;
const isWeakToolCallerModel = _tc.isWeakToolCallerModel || function () { return false; };
const compactMcpToolDef = _tc.compactMcpToolDef || function (entry) { return entry && entry.tool; };

async function getHostToolFlags() {
  if (!gwState.authed || !toolDefsApi.getPermissions) {
    return { openUrl: false, exec: false, fsRead: false, fsWrite: false, webFetch: false, browser: false, osControl: false, camera: false };
  }
  try {
    const p = await toolDefsApi.getPermissions();
    const webFetch = p?.webFetch !== false;
    const browser = p?.browserAutomation !== false;
    const osControl = p?.osControl === true;
    // 摄像头拍的是现实世界，默认关：只有用户显式打开才注入 camera_look。
    const camera = p?.camera === true;
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
      camera
    };
  } catch {
    return { openUrl: false, exec: false, fsRead: false, fsWrite: false, webFetch: false, browser: false, osControl: false, camera: false };
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
  if (gwState.authed) {
    tools.push(CODEBASE_TOOL);
    // 记忆读写都在 Gateway：召回（只读）与软归档（可恢复）跟 codebase 同条件暴露。
    tools.push(...MEMORY_TOOLS);
    if (await shouldExposeGraphTools()) pushGraphTools(tools);
  }
  tools.push(...PLAN_TOOLS);
  tools.push(CLARIFY_TOOL);
  // 建会话 / 换工作空间：与「新对话」按钮同一条渲染器流程，不依赖 host 权限开关。
  if (SESSION_TOOL) tools.push(SESSION_TOOL);
  if (SESSION_WORKSPACE_TOOL) tools.push(SESSION_WORKSPACE_TOOL);
  // Agent 主循环是协调者：可派只读研究子 Agent（深度恒为 1）。
  if (SUBAGENT_TOOL) tools.push(SUBAGENT_TOOL);

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
        optionalEntries.push({
          id: item.agentName,
          tool: {
            type: 'function',
            function: {
              name: item.agentName,
              description: `[MCP · ${item.serverId}] ${item.description || item.toolName}`,
              parameters:
                item.inputSchema && typeof item.inputSchema === 'object'
                  ? item.inputSchema
                  : { type: 'object', properties: {} }
            }
          },
          candidate: {
            id: item.agentName,
            name: item.agentName,
            description: `[MCP · ${item.serverId}] ${item.description || item.toolName}`,
            source: 'mcp',
            serverId: item.serverId || ''
          }
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
