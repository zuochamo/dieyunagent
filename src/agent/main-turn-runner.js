'use strict';

/**
 * Main 侧「跑一轮对话」的唯一实现（无 Renderer）。
 *
 * 为什么需要这一层：`channels/agent-turn.js`（企业微信）已经在 Main 里跑完整一轮 ——
 * 模型解析、系统提示、工具、压缩、落库、记忆归纳全都不经过 Renderer。同一个形态现在有三个
 * 调用方（频道 / headless 终端与 Web / 后续其它外部入口），**不能各写一份装配**：三份装配
 * 迟早会在「系统提示注入了什么、无正文怎么算失败、思考通道怎么落库」上漂移。
 *
 * 与桌面聊天的区别只有两条，都跟 UI 有关、与语义无关：
 * 1. 没有编辑器上下文（选区 / 未保存文件 / 诊断）→ snapshot 相应字段留空；
 * 2. 交付出口是调用方给的 `sink`（终端 / 频道消息 / Web 流），不是气泡。
 *
 * 与桌面的**一致性由既有单一来源保证**，本文件不另拼：
 * - 系统提示：`prepSystemPrompt`（AGENTS.md / 记忆 / 技能 / MCP / 召回），依赖装配走
 *   `system-prompt-prep-main.js`（与 IPC `agent:prep-system-prompt` 同一份）；
 * - 工具：`main-agent-tools.js`（聊天在 Renderer，Main 侧只有静态 + MCP 这一档）；
 * - 压缩：`compaction-loop.js`；
 * - 交付文本与落库闸门：`agent-round-text`（带标签思考引用不落库）；
 * - 消息与历史：`memory.message_append` / `memory.messages_recent` + `session-context`。
 */

const { loadModelSettings, resolveTextApiConfig } = require('../model-settings');
const { runRustAgentLoop } = require('./rust-loop-runner');
const { resolveLoopToolCallLimit } = require('./agent-limits');
const { applyTierRuntime, resolveContextTierIdFromSettings } = require('./model-runtime-by-tier');
const { clampModelRuntimeValue } = require('./model-runtime-schema');
const { getEffectiveInputBudget } = require('./compaction-main');
const {
  buildCompletionMessagesFromHistory,
  packMessageMeta,
  unpackMessageMeta
} = require('./session-context');
const { clearToolHarnessSessionsForSession } = require('./tool-harness');
const { buildMainAgentTools } = require('./main-agent-tools');
const { buildLoopCompactionHandler } = require('./compaction-loop');
const { buildPrepSystemPromptDeps } = require('./system-prompt-prep-main');
const { isAbortError } = require('../llm-reconnect-retry');
const roundText = require('./agent-round-text');

/**
 * 「用户自己能修」的错误：文案可以原样发到终端 / 微信 / Web（缺 API Key、core 没装…）。
 * 其余错误（RPC / sqlite / 内部堆栈）只进日志 —— 群聊里任何人都能看到那条回复，
 * 不该看到本机路径与实现细节。
 *
 * @param {string} message
 * @param {string} [code] 机器可读码（headless 入口据此决定退出码：配置类 = 3，其余 = 2）
 */
function userError(message, code) {
  const err = new Error(message);
  err.userSafe = true;
  if (code) err.code = code;
  return err;
}

/** 工作空间是否有可用代码索引（口径与 Renderer `renderer-agent-prep.js#isCodebasePrepReady` 一致） */
async function codebaseIndexReady(gateway, workspacePath) {
  if (!workspacePath) return false;
  try {
    const st = await gateway.invokeRpc('codebase.status', {}, { timeoutMs: 2500 });
    if (!st) return false;
    const chunks = Number(st.chunkCount || st.chunk_count || 0);
    return !!(st.indexed && !st.indexing && chunks > 0);
  } catch {
    return false;
  }
}

/**
 * 无 Renderer 的一次运行快照：模型看到的「这次在哪个目录、有没有索引、有没有编辑器」。
 * 编辑器字段一律空 —— 没有 UI 就没有选区 / 未保存文件 / 诊断。
 */
async function buildTurnSnapshot({ gateway, sessionId, workspacePath, userQuery }) {
  const indexOk = await codebaseIndexReady(gateway, workspacePath);
  return {
    userQuery,
    sessionId,
    workspaceInfo: workspacePath
      ? { workspacePath, kind: /^ssh:/i.test(workspacePath) ? 'ssh' : 'local' }
      : null,
    runWorkspaceRoot: workspacePath || null,
    indexOk,
    graphIndexOk: false,
    skipAuto: false,
    injectCode: false,
    allowCodebase: !!workspacePath,
    openFilePaths: [],
    changeRows: [],
    editor: { hasActiveFile: false, hasSelection: false, hasArtifact: false },
    includeEditor: false,
    stableDataChunks: [],
    turnDataChunks: [],
    now: new Date().toISOString()
  };
}

/**
 * 本轮模型解析：没有 Renderer 会话，只能按默认文本模型（或调用方显式给的路由）解析。
 * 缺 key / 缺模型一律明确报错，不静默换供应商。
 *
 * @param {{ userData: string, route?: string, model?: string, strict?: boolean }} args
 */
function resolveTurnModel({ userData, route, model, strict }) {
  const settings = loadModelSettings(userData);
  const llm = resolveTextApiConfig(settings, route || model ? { route, model, strict: strict !== false } : {});
  if (!llm.apiKey || !llm.baseUrl) {
    throw userError('未配置 API Key，请在「模型设置」里填写', 'NO_API_KEY');
  }
  const llmModel = llm.model || settings.textModel || '';
  if (!llmModel) {
    throw userError('没有可用的默认模型，请在「模型设置」里启用一个供应商模型', 'NO_MODEL');
  }
  const contextTierId = resolveContextTierIdFromSettings(settings, llm.model);
  const runSettings = applyTierRuntime(settings, userData, { tierId: contextTierId, model: llmModel });
  const tokenBudget = getEffectiveInputBudget(runSettings, llmModel);
  // 整体继承 llm：逐字段重建会丢掉 headers / authMode / userAgent（压缩也复用这份 apiCfg）
  const apiCfg = { ...llm, baseUrl: llm.baseUrl, apiKey: llm.apiKey };
  return { settings, runSettings, llm, llmModel, contextTierId, tokenBudget, apiCfg };
}

/**
 * 在 Main 里跑一轮：**假定会话已就绪**（由调用方建会话 / 绑工作空间，见 `session-workspace-bind`）。
 *
 * @param {object} ctx
 * @param {string} ctx.userData
 * @param {{ invokeRpc: Function }} ctx.gateway
 * @param {object} ctx.coreBridge dieyun-core 桥（须已就绪）
 * @param {object|null} [ctx.mcpRuntime]
 * @param {object|null} [ctx.compactionAgent]
 * @param {{ executeAgentTool: Function }} ctx.toolBridge
 * @param {string} ctx.sessionId
 * @param {string} [ctx.workspacePath]
 * @param {() => string} [ctx.getWorkspacePath] 一轮内被换过目录时的取值入口（默认返回 ctx.workspacePath）
 * @param {string} ctx.userText 原始用户输入（进 snapshot / 归因）
 * @param {string} ctx.ledgerText 落库文本（含附件说明行）
 * @param {Array<object>} [ctx.ledgerAttachments] 附件引用（落进 user 轮次 meta）
 * @param {Array<object>} [ctx.imageParts] 多模态 part（图片附件）
 * @param {object|null} [ctx.triggerMeta] 落进用户轮次 meta 的归因（频道 / headless）
 * @param {Array<object>} [ctx.extraTools] 额外工具 schema（调用方专用，如换工作空间）
 * @param {(name: string, args: object) => Promise<any>|null} [ctx.preTool] 调用方先接手的工具
 * @param {string} [ctx.runSource] 请求快照里的来源标记
 * @param {AbortSignal|null} [ctx.signal]
 * @param {string} [ctx.sessionTitle] 轮末写进会话行的标题（频道用「[企业微信] 名称」；不给则不动）
 * @param {{ push: (text: string) => void }|null} [ctx.sink] 流式正文出口
 * @param {(phase: string, data: object) => void} [ctx.onPhase] loop phase 透出（headless 归约 trace）
 * @param {string} [ctx.route] 模型路由（供应商）
 * @param {string} [ctx.model]
 * @param {string} [ctx.abortedNote] 中止时落库的那句话
 * @param {(userDataPath: string) => any[]} [ctx.listMcpServers]
 * @returns {Promise<{ sessionId: string, content: string, trace: object[], runId: string|null,
 *   readiness: object|null, aborted: boolean }>}
 */
async function runMainTurn(ctx) {
  const gateway = ctx.gateway;
  const coreBridge = ctx.coreBridge;
  const sessionId = String(ctx.sessionId || '');
  if (!sessionId) throw new Error('会话未就绪：调用方须先建会话再跑一轮');
  if (!gateway || typeof gateway.invokeRpc !== 'function') {
    throw userError('Gateway 未就绪，任务无法执行', 'GATEWAY_UNAVAILABLE');
  }
  if (!coreBridge || !coreBridge.isReady || !coreBridge.isReady()) {
    throw userError('dieyun-core 未就绪（请运行 npm run pack:dieyun-core 并重启）', 'CORE_UNAVAILABLE');
  }

  const workspacePath = String(ctx.workspacePath || '');
  const userText = String(ctx.userText || '').trim();
  const ledgerText = String(ctx.ledgerText || userText).trim();
  if (!ledgerText) throw userError('消息内容为空', 'EMPTY_TEXT');
  const imageParts = Array.isArray(ctx.imageParts) ? ctx.imageParts : [];

  // 模型：没有 Renderer 会话，只能按默认文本模型（或调用方显式路由）解析
  const { runSettings, llmModel, contextTierId, tokenBudget, apiCfg } = resolveTurnModel({
    userData: ctx.userData,
    route: ctx.route,
    model: ctx.model
  });

  // 先落用户轮次：历史读回来时它就是「当前任务」，多模态 part 由 prepared 顶替该条
  await gateway.invokeRpc('memory.message_append', {
    sessionId,
    role: 'user',
    content: packMessageMeta(
      ledgerText,
      { trigger: ctx.triggerMeta || null, attachments: ctx.ledgerAttachments || [] },
      { role: 'user' }
    )
  });

  const snapshot = await buildTurnSnapshot({
    gateway,
    sessionId,
    workspacePath,
    userQuery: userText || ledgerText
  });
  const built = buildPrepSystemPromptDeps({
    gateway,
    userData: ctx.userData,
    snapshot,
    // 共享记忆（跨机）：频道 / 定时 / headless 与桌面走同一份装配，没装配就自动缺席
    sharedMemory: typeof ctx.getSharedMemory === 'function' ? ctx.getSharedMemory() : null,
    listMcpServers: ctx.listMcpServers
  });
  const sysPack = await built.prepSystemPrompt(snapshot, built.deps);
  const sysContent = String((sysPack && (sysPack.content || sysPack.stable)) || '');
  const turnRide = String((sysPack && sysPack.turnRide) || '');

  const rows = await gateway.invokeRpc('memory.messages_recent', { sessionId, limit: 120 });
  const history = (Array.isArray(rows) ? rows : [])
    .filter((r) => r && (r.role === 'user' || r.role === 'assistant'))
    .map((r) => ({
      role: r.role,
      content: String(r.content || ''),
      created_at: r.createdAt || r.created_at
    }));
  const helpers = {
    unpackUserContent: (raw) => unpackMessageMeta(raw).content,
    unpackAssistantMeta: (raw) => ({ content: unpackMessageMeta(raw).content, meta: null }),
    compactPlainText: (s, n) => String(s || '').slice(0, n)
  };
  const prepared = imageParts.length
    ? {
        content: [{ type: 'text', text: ledgerText }, ...imageParts],
        hasImages: true,
        textForStorage: ledgerText,
        multimodalPlainText: ledgerText
      }
    : null;
  const messages = buildCompletionMessagesFromHistory(
    history,
    sysContent,
    prepared,
    !!prepared,
    helpers,
    turnRide
  );

  const tools = [...(await buildMainAgentTools(ctx.mcpRuntime || null))];
  if (Array.isArray(ctx.extraTools) && ctx.extraTools.length) tools.push(...ctx.extraTools);
  /**
   * 一轮内工作空间可能被 `session_set_workspace` 改掉（频道 / headless 换项目）：
   * 工具调用取**此刻**的生效目录，不取本轮开始时的快照 —— 否则换完目录还在旧路径上干活。
   */
  const resolveWorkspacePath =
    typeof ctx.getWorkspacePath === 'function' ? ctx.getWorkspacePath : () => workspacePath;

  let loopResult = null;
  let aborted = false;
  try {
    loopResult = await runRustAgentLoop({
      coreBridge,
      llm: apiCfg,
      settings: runSettings,
      userData: ctx.userData,
      useStream: true,
      signal: ctx.signal || null,
      sessionId,
      runSource: String(ctx.runSource || 'main'),
      // 流式正文：`llm_delta.content` 是**本轮累计**正文（不是增量），直接推给节流 sink；
      // 收尾轮（synthesis）同理。
      onPhase: (phase, data) => {
        if (typeof ctx.onPhase === 'function') ctx.onPhase(phase, data);
        if (!data || typeof ctx.sink?.push !== 'function') return;
        if (phase === 'llm_delta' && data.content) ctx.sink.push(String(data.content));
        else if (phase === 'synthesis_delta' && data.content) ctx.sink.push(String(data.content));
      },
      startParams: {
        model: llmModel,
        messages,
        tools,
        maxToolCalls: resolveLoopToolCallLimit(runSettings),
        maxRounds: clampModelRuntimeValue('agentMaxRounds', runSettings.agentMaxRounds),
        workspaceRoot: workspacePath || undefined
      },
      compactMessages: buildLoopCompactionHandler({
        compactionAgent: ctx.compactionAgent || null,
        gateway,
        userData: ctx.userData,
        sessionId,
        workspacePath,
        tokenBudget,
        contextTierId,
        apiConfig: apiCfg,
        model: llmModel
      }),
      turnEndSynthesis: true,
      delegateTool: async (name, args) => {
        if (typeof ctx.preTool === 'function') {
          const handled = await ctx.preTool(name, args);
          if (handled) return handled;
        }
        return ctx.toolBridge.executeAgentTool(name, args, {
          workspacePath: resolveWorkspacePath() || undefined,
          sessionId,
          model: llmModel,
          // 工具侧的 agent-limits 按档位取（goalCheckTimeoutMs / visionShotsPerRound …）：
          // 不传就落到 default 档，与本次运行的模型档位不一致（桌面路径一直有传）
          contextTierId
        });
      }
    });
  } catch (err) {
    if (!isAbortError(err)) throw err;
    aborted = true;
  } finally {
    clearToolHarnessSessionsForSession(sessionId);
  }

  if (aborted) {
    // 中止（超时/用户中断）也要留痕：否则会话里这一轮像没发生过
    const note = String(ctx.abortedNote || '（任务已中止）');
    await gateway.invokeRpc('memory.message_append', {
      sessionId,
      role: 'assistant',
      content: packMessageMeta(note, { trigger: ctx.triggerMeta || null }, { role: 'assistant' })
    });
    return { sessionId, content: note, trace: [], runId: null, readiness: null, aborted: true };
  }

  const reply = String((loopResult && loopResult.content) || '').trim();
  const trace = (loopResult && loopResult.trace) || [];
  if (!reply) {
    const toolCount = trace.reduce((n, r) => n + ((r && r.tools) || []).length, 0);
    // 最常见失败（上游拒绝 / 额度用尽 / 只调工具没写正文），且文案不含内部细节：
    // 标成 userSafe 才能让对方知道「为什么没回话」，而不是一句通用失败。
    throw userError(
      toolCount
        ? `模型执行了 ${toolCount} 次工具调用但未生成任何正文，请查看日志后重试`
        : '模型未返回任何正文（上游可能拒绝请求或额度已用尽），请稍后重试',
      'EMPTY_REPLY'
    );
  }

  // 落库与桌面聊天同一闸门：带标签的思考引用只用于展示，写进账本换占位
  const body = roundText.persistableTurnText(reply);
  await gateway.invokeRpc('memory.message_append', {
    sessionId,
    role: 'assistant',
    content: packMessageMeta(body, { trigger: ctx.triggerMeta || null }, { role: 'assistant' })
  });
  // 标题：频道侧按「渠道 + 会话」给稳定标题（如「企业微信 · 张三」）；不给就保持库里原值
  // （`memory.touch_session` 的 title 是可选的，旧 agent-turn 一直在传，搬家时漏了）
  await gateway.invokeRpc('memory.touch_session', {
    sessionId,
    ...(String(ctx.sessionTitle || '').trim() ? { title: String(ctx.sessionTitle).trim() } : {})
  });

  // 记忆归纳：Main 侧跑出来的轮次同样沉淀（与定时计划同一入口）
  try {
    const { afterAgentRun } = require('./knowledge-maintainer');
    afterAgentRun({
      result: {
        content: reply,
        trace,
        runId: loopResult && loopResult.runId,
        plan: null,
        review: null,
        readiness: loopResult && loopResult.readiness
      },
      opts: {
        sessionId,
        workspacePath,
        model: llmModel,
        apiConfig: apiCfg,
        userText: ledgerText
      }
    });
  } catch {
    // 归纳失败不影响回复
  }

  return {
    sessionId,
    content: reply,
    trace,
    runId: (loopResult && loopResult.runId) || null,
    readiness: (loopResult && loopResult.readiness) || null,
    aborted: false
  };
}

module.exports = { runMainTurn, resolveTurnModel, buildTurnSnapshot, codebaseIndexReady, userError };
