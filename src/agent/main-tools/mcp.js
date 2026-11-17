'use strict';

/**
 * MCP：mcp_tool_schema（按提问召回运行时 schema）与 mcp_manage（增删改服务）。语义全在 src/mcp/manage.js，这里只做参数翻译与形状转换。
 *
 * 从 `tool-bridge-main.js` 的 1036 行 switch 里拆出（曾零直测）：现在由
 * `scripts/test-tool-bridge-handlers.cjs` 覆盖参数翻译与形状转换。
 * 依赖一律由 `shared` 传入（不 require），所以本文件能被单测直接装进沙箱。
 *
 * @param {object} shared 工具桥闭包里的依赖与取值器（见 main-tools/index.js）
 */
function createMcpHandlers(shared) {
  const {
    userDataPath,
    recallAgentTools,
    slimMcpInputSchema,
    loadModelSettings,
    getEmbeddingConfig,
    mcpRuntime,
    mcpManager,
    webContents
  } = shared;

  /**
   * 按 query 检索「本轮工具表里没有」的 MCP 工具，返回可直接调用的 agentName + 精简 schema。
   *
   * 为什么需要它：mcp_* 工具是每个用户回合按提问召回的子集（renderer-tool-defs.js），
   * run 内不再刷新。任务中途换向时，未被召回的工具对模型完全不可见 —— 它连名字都不知道，
   * 无法补救。此函数把「渐进披露」的最后一步交给模型自己触发：披露要能按需再发生。
   *
   * 召回走 tools/tool-vector-index 的同一份实现；召回不可用（无向量模型 / 全被阈值挡掉）时
   * 退到名字与描述的子串匹配 —— 宁可粗排，也不能让「有工具却找不到」。
   */
  async function searchMcpToolSchemas(query, limit) {
    if (!mcpRuntime || typeof mcpRuntime.listAgentTools !== 'function') {
      return { error: 'MCP 运行时未就绪', errorCode: 'MCP_UNAVAILABLE', retryable: false };
    }
    const listed = await mcpRuntime.listAgentTools({ catalogOnly: true });
    const all = Array.isArray(listed.tools) ? listed.tools : [];
    if (!all.length) {
      return {
        ok: true,
        matched: [],
        total: 0,
        note: '已启用的 MCP 服务当前没有任何缓存工具；请先在 MCP 设置页刷新工具目录'
      };
    }
    const candidates = all.map((item) => ({
      id: item.agentName,
      name: item.agentName,
      description: `[MCP · ${item.serverId || ''}] ${item.description || item.toolName || ''}`,
      source: 'mcp',
      serverId: item.serverId || ''
    }));
    const max = Math.min(5, Math.max(1, Number(limit) || 3));
    let picked = [];
    try {
      const recalled = await recallAgentTools({
        userData: userDataPath,
        embeddingConfig: getEmbeddingConfig(loadModelSettings(userDataPath)),
        candidates,
        query,
        limit: max
      });
      picked = Array.isArray(recalled && recalled.tools) ? recalled.tools : [];
    } catch {
      picked = [];
    }
    if (!picked.length) {
      const q = String(query || '').toLowerCase();
      picked = candidates
        .filter(
          (c) =>
            c.id.toLowerCase().includes(q) || String(c.description || '').toLowerCase().includes(q)
        )
        .slice(0, max)
        .map((c) => ({ id: c.id }));
    }
    const byName = new Map(all.map((item) => [item.agentName, item]));
    const matched = picked
      .map((row) => byName.get(row && row.id))
      .filter(Boolean)
      .map((item) => ({
        agentName: item.agentName,
        serverId: item.serverId || '',
        description: String(item.description || item.toolName || '').slice(0, 240),
        inputSchema: slimMcpInputSchema(item.inputSchema || {})
      }));
    return {
      ok: true,
      matched,
      total: all.length,
      note: matched.length
        ? 'matched[].agentName 可直接当工具名调用（不必等它进入工具列表）。嵌套字段被折叠时，再用 agentName 模式查完整 schema。'
        : '没有命中；换个说法，或直接给 agentName'
    };
  }
  return {
    mcp_tool_schema: async (a, ctx) => {
        if (!mcpRuntime) {
          return { error: 'MCP 运行时未就绪', errorCode: 'MCP_UNAVAILABLE', retryable: false };
        }
        const query = String(a.query || '').trim();
        if (query) return searchMcpToolSchemas(query, a.limit);
        if (typeof mcpRuntime.lookupToolSchema !== 'function') {
          return { error: 'MCP 运行时未就绪', errorCode: 'MCP_UNAVAILABLE', retryable: false };
        }
        return mcpRuntime.lookupToolSchema(String(a.agentName || ''));
    },
    mcp_manage: async (a, ctx) => {
        // 装/改/启停 MCP 服务：与 IPC 共用 mcp/manage.js（同一份 store + 同一次运行时重挂）。
        // 没有管理器时明确说「能力没开」，而不是装作工具不存在。
        if (!mcpManager) {
          return {
            ok: false,
            error: 'MCP 管理未就绪（运行时尚未装配）',
            errorCode: 'MCP_UNAVAILABLE',
            retryable: true
          };
        }
        try {
          // request_credential 需要把「请人填凭据」推到界面：只有这条通道能让模型既发起、又看不到明文。
          // 没有可用窗口（后台频道轮次）时传 null —— 让 manager 明确回「界面未就绪」，不假装弹过。
          const canNotify = !!webContents && !webContents.isDestroyed();
          return await mcpManager.applyToolRequest(a, {
            notifyCredentialRequest: canNotify
              ? (payload) => {
                  if (!webContents.isDestroyed()) webContents.send('mcp:credential-request', payload);
                }
              : null
          });
        } catch (err) {
          return {
            ok: false,
            error: String((err && err.message) || err || 'MCP 变更失败'),
            errorCode: 'MCP_MANAGE_FAILED',
            retryable: false
          };
        }
    }
  };
}

module.exports = { createMcpHandlers };
