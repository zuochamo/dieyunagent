'use strict';

/**
 * 「看一眼自己」类工具的执行体（现在只有 `agent_inspect`）。
 *
 * 依赖一律由 `shared` 传入（不 require 有副作用的模块），所以本文件能被单测直接装进沙箱；
 * 纯函数（`capability-index` / 沙箱投影 / 档位文案）才在顶层 require。
 *
 * 三条纪律（与 schema 注释同一份）：
 * - **只读**：不写盘、不改配置；
 * - **只报事实**：不判断「该不该继续 / 该不该收尾」，也不给建议；
 * - **数字不重算**：循环预算取 `resolveAgentLoopSpec`，其余取 `getAgentLimits`，
 *   遥测取 `summarizeTelemetry` —— 每个数字都只有一个来源。
 *
 * @param {object} shared 工具桥闭包里的依赖与取值器（见 main-tools/index.js）
 */
const {
  CAPABILITIES,
  CAPABILITY_GUIDE,
  capabilityEnabled,
  CAPABILITY_BY_KEY,
  enabledCapabilities,
  projectSandboxState,
  resolveRequestKind
} = require('../capability-index');

/** 能力 key → `{ key, label }`（模型看的是人话，不是我们的内部枚举名）。 */
function labeledCapabilities(keys) {
  return (Array.isArray(keys) ? keys : []).map((key) => ({
    key,
    label: CAPABILITY_BY_KEY[key] ? CAPABILITY_BY_KEY[key].label : key
  }));
}

function createSelfHandlers(shared) {
  const {
    gateway,
    userDataPath,
    getAgentLimits,
    resolveAgentLoopSpec,
    summarizeTelemetry,
    loadModelSettings,
    /** 把「申请开某项能力」送到界面（Main 注入；没有窗口时为 null）。 */
    notifyCapabilityRequest
  } = shared;

  return {
    agent_inspect: async (a, ctx) => {
      if (!gateway || typeof gateway.invokeRpc !== 'function') {
        return { ok: false, error: 'Gateway 未就绪', errorCode: 'GATEWAY_UNAVAILABLE', retryable: true };
      }
      const tierId = String((ctx && ctx.contextTierId) || 'default');

      // 沙箱事实：与系统提示里的【本轮能力事实】同一个投影函数（口径只有一份）
      let sandbox = null;
      try {
        const { SANDBOX_MODE_META } = require('../../gateway/sandbox-policy');
        sandbox = projectSandboxState(
          await gateway.invokeRpc('permissions.sandbox_state', {}),
          SANDBOX_MODE_META
        );
      } catch {
        sandbox = null;
      }

      let capabilities = null;
      try {
        const permissions = typeof gateway.getPermissions === 'function' ? gateway.getPermissions() : null;
        const { on, off } = enabledCapabilities(permissions);
        capabilities = { on: labeledCapabilities(on), off: labeledCapabilities(off) };
      } catch {
        capabilities = null;
      }

      let limits = null;
      try {
        const l = getAgentLimits(userDataPath, tierId);
        const settings = typeof loadModelSettings === 'function' ? loadModelSettings(userDataPath) : {};
        const loop =
          typeof resolveAgentLoopSpec === 'function'
            ? resolveAgentLoopSpec(settings, userDataPath, tierId)
            : {};
        limits = {
          // 本轮真正生效的循环预算（含用户按档位覆盖的值），不是缺省表
          loop: { maxRounds: loop.maxRounds, maxToolCalls: loop.maxToolCalls },
          subagent: { maxRounds: l.subagentMaxRounds, maxToolCalls: l.subagentMaxToolCalls },
          goal: { maxAttempts: l.goalMaxAttempts, maxWallMs: l.goalMaxWallMs }
        };
      } catch {
        limits = null;
      }

      let telemetry = null;
      try {
        const s = summarizeTelemetry(userDataPath, 200);
        telemetry = {
          // 窗口行数 + 实际样本数都给：样本是 0 时 `successRate` 也是 0，
          // 只报比率会让模型把「还没跑过任何工具」读成「全都在失败」
          window: s.windowRows,
          total: s.total,
          ok: s.ok,
          failed: s.failed,
          successRate: s.successRate,
          repeatBlocks: s.repeatBlocks,
          retries: s.retries,
          topErrors: (s.topErrors || []).slice(0, 5),
          byTool: (s.byTool || []).slice(0, 5).map((t) => ({
            tool: t.tool,
            total: t.total,
            failed: t.failed
          }))
        };
      } catch {
        telemetry = null;
      }

      return {
        ok: true,
        sandbox,
        capabilities,
        limits,
        telemetry,
        note: '以上都是当前生效的事实（只读）。要改其中任何一项属于用户设置，不是你能改的。'
      };
    },
    /**
     * 能力申请 / 复查（唯一通道）。
     *
     * 与 `mcp_manage.request_credential` 同一形态：模型发起 → 界面打开对应设置并标出开关 →
     * 用户亲手打开 → 模型 `list` 复查。没有界面（频道 / headless）时**如实说不能弹**，
     * 并把「去哪儿开」的文案交回去，让它用文字告诉用户，而不是假装弹过。
     */
    agent_capability: async (a, ctx) => {
      const action = String((a && a.action) || '').trim();
      const permissions = gateway && typeof gateway.getPermissions === 'function' ? gateway.getPermissions() : null;

      if (action === 'list') {
        return {
          ok: true,
          capabilities: CAPABILITIES.map((c) => {
            const guide = CAPABILITY_GUIDE[c.key] || null;
            return {
              key: c.key,
              label: c.label,
              on: capabilityEnabled(c.key, permissions),
              howToEnable: guide ? guide.text : ''
            };
          }),
          note: 'on=false 的能力不会出现在工具表里。要申请用 action=request + kind。'
        };
      }

      if (action !== 'request') {
        return {
          ok: false,
          error: 'agent_capability 的 action 只能是 request / list',
          errorCode: 'INVALID_ARG',
          retryable: false
        };
      }

      const kind = resolveRequestKind(a && a.kind);
      if (!kind) {
        return {
          ok: false,
          error: `不认识的能力：${String((a && a.kind) || '(空)')}。可用：${CAPABILITIES.map((c) => c.key).join(' / ')} / mcpCredential`,
          errorCode: 'UNKNOWN_CAPABILITY',
          retryable: false
        };
      }

      const guide = kind.guide;
      const already = capabilityEnabled(kind.key, permissions);
      if (already) {
        return {
          ok: true,
          delivered: false,
          kind: kind.key,
          alreadyEnabled: true,
          howToEnable: guide.text,
          verifyWith: 'agent_capability action=list',
          note: `「${kind.label}」现在是开着的：可能是工具表这一轮按提问裁剪过。用 agent_inspect 看本轮能力事实，别重复申请。`
        };
      }
      if (typeof notifyCapabilityRequest !== 'function') {
        return {
          ok: false,
          error:
            `当前没有可用的界面来弹这个申请（后台 / 无窗口轮次）。` +
            `请用文字告诉用户：${guide.text}；开好后用 agent_capability action=list 复查。`,
          errorCode: 'CAPABILITY_UI_UNAVAILABLE',
          retryable: false,
          // 失败信封会收窄字段（只保 error / errorCode / suggestedFix），所以落点写在这里
          suggestedFix: guide.text
        };
      }
      try {
        notifyCapabilityRequest({
          kind: kind.key,
          label: kind.label,
          // 会显示在界面上：截断，别把一整段思考塞进 toast
          reason: String((a && a.reason) || '').replace(/\s+/g, ' ').trim().slice(0, 200),
          page: guide.page || '',
          anchor: guide.anchor || '',
          howToEnable: guide.text
        });
      } catch (err) {
        return {
          ok: false,
          error: String((err && err.message) || err || '无法把申请送到界面'),
          errorCode: 'CAPABILITY_UI_UNAVAILABLE',
          retryable: false,
          howToEnable: guide.text
        };
      }
      return {
        ok: true,
        delivered: true,
        kind: kind.key,
        howToEnable: guide.text,
        verifyWith: 'agent_capability action=list',
        note:
          '已在界面上打开对应设置并标出要开的开关。**开关永远由用户按**；开好后用 action=list 复查，' +
          '别在这一轮反复重试同一个申请。'
      };
    }
  };
}

module.exports = { createSelfHandlers };
