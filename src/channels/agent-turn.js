'use strict';

const fs = require('fs');
const path = require('path');
const { loadModelSettings, resolveTextApiConfig } = require('../model-settings');
const { runRustAgentLoop } = require('../agent/rust-loop-runner');
const { resolveLoopToolCallLimit } = require('../agent/agent-limits');
const { applyTierRuntime, resolveContextTierIdFromSettings } = require('../agent/model-runtime-by-tier');
const { clampModelRuntimeValue } = require('../agent/model-runtime-schema');
const { getEffectiveInputBudget } = require('../agent/compaction-main');
const {
  buildCompletionMessagesFromHistory,
  packMessageMeta,
  unpackMessageMeta
} = require('../agent/session-context');
const { clearToolHarnessSessionsForSession } = require('../agent/tool-harness');
const { buildMainAgentTools } = require('../agent/main-agent-tools');
const catalog = require('../agent/tool-catalog');
const { createChannelWorkspaceSwitcher } = require('./workspace-switch');
const { buildLoopCompactionHandler } = require('../agent/compaction-loop');
const { buildPrepSystemPromptDeps } = require('../agent/system-prompt-prep-main');
const { bindSessionWorkspace } = require('../agent/session-workspace-bind');
const { normalizeVisionImageMime } = require('../agent/guardrails-shared');
const { storeVisionImage } = require('../agent/vision-image');
const { isAbortError } = require('../llm-reconnect-retry');
const roundText = require('../agent/agent-round-text');

/**
 * 频道一轮对话的执行体：**在 Main 里**跑完整的 Agent 循环，不经过 Renderer。
 *
 * 为什么要这一层（而不是复用手机桥的 `task.submit`）：`task.submit` 的语义是「驱动桌面
 * 上正在看的会话」，跑之前要把 Renderer 切到目标会话 —— 微信来一条消息就把用户的桌面
 * 对话切走，且方向相反（external → desktop）。频道任务的正确形态是「后台跑一轮」：
 * 自己的会话、自己的工作空间、自己的模型解析，完全不碰 `currentSessionId`。
 *
 * 与桌面聊天的一致性由既有单一来源保证，不在这里另拼：
 * - 系统提示：`prepSystemPrompt`（AGENTS.md / 记忆 / 技能 / MCP / 召回），依赖装配走
 *   `system-prompt-prep-main.js`（与 IPC `agent:prep-system-prompt` 同一份）；
 * - 工具：`main-agent-tools.js`（与定时计划同一份）；
 * - 压缩：`compaction-loop.js`；
 * - 交付文本与落库闸门：`agent-round-text`（带标签思考引用不落库）；
 * - 消息与历史：`memory.message_append` / `memory.messages_recent` + `session-context`。
 *
 * 差异只在「没有编辑器上下文」：没有选区/未保存文件/诊断，snapshot 相应字段留空。
 */

const CHANNEL_TITLE_PREFIX = '企业微信';
const MAX_ATTACHMENT_BYTES = 16 * 1024 * 1024;
const ATTACHMENT_TIMEOUT_MS = 20_000;
/** 收件箱保留天数（缓存语义：过期即删，见 pruneInboxDir） */
const INBOX_KEEP_DAYS = 7;

/**
 * 「用户自己能修」的错误：文案可以原样发到微信（缺 API Key、core 没装、频道被删…）。
 * 其余错误（RPC / sqlite / 内部堆栈）只进日志，微信侧统一用 runtime 的通用失败文案 ——
 * 群里任何人都能看到那条回复，不该看到本机路径与实现细节。
 */
function userError(message) {
  const err = new Error(message);
  err.userSafe = true;
  return err;
}

function channelSessionTitle(channel) {
  const name = (channel && channel.name) || '未命名频道';
  return `[${CHANNEL_TITLE_PREFIX}] ${name}`;
}

/** 频道会话在账本里的归因（Renderer 读到未知 kind 会回落通用标题，不会显示成用户气泡） */
function channelTriggerMeta(channel) {
  return {
    kind: 'channel',
    channelId: (channel && channel.id) || '',
    channelName: (channel && channel.name) || '',
    at: new Date().toISOString()
  };
}

async function downloadAttachment(url, log) {
  const raw = String(url || '').trim();
  if (!raw) throw new Error('附件地址为空');
  // 附件 URL 来自回调体（群里任何人可控）：出网一律过 SSRF 校验，与联网搜索同一份实现。
  // 没有这道闸，一条消息就能让 Main 去取 127.0.0.1 / 内网地址。
  const { assertSafeUrl } = require('../gateway/web/url-safety');
  let safeUrl;
  try {
    safeUrl = assertSafeUrl(raw);
  } catch (e) {
    throw new Error(`附件地址不允许访问（${(e && e.message) || e}）`);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ATTACHMENT_TIMEOUT_MS);
  if (typeof timer.unref === 'function') timer.unref();
  try {
    const res = await fetch(safeUrl.href || safeUrl, { signal: controller.signal });
    if (!res.ok) throw new Error(`附件下载失败（HTTP ${res.status}）`);
    const declared = Number(res.headers.get('content-length') || 0);
    if (declared && declared > MAX_ATTACHMENT_BYTES) throw new Error('附件超过 16MB，未下载');
    const buf = await readBodyCapped(res, MAX_ATTACHMENT_BYTES, controller);
    return { buf, contentType: String(res.headers.get('content-type') || '') };
  } catch (e) {
    if (log) log(`[channels] 附件下载失败 ${raw.slice(0, 120)}：${(e && e.message) || e}`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 边收边计数：`content-length` 可以撒谎或不给，不能把身子整块读进内存再判大小
 * （一条指向大文件的图片消息就能把 Main 撑爆）。
 */
async function readBodyCapped(res, maxBytes, controller) {
  const body = res.body;
  if (!body || typeof body.getReader !== 'function') {
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > maxBytes) throw new Error('附件超过 16MB，未下载');
    return buf;
  }
  const reader = body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > maxBytes) {
        try {
          controller.abort();
        } catch {
          // ignore
        }
        throw new Error('附件超过 16MB，未下载');
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // ignore
    }
  }
  return Buffer.concat(chunks, total);
}

/** 非图片附件落到频道收件箱，让 Agent 用普通文件工具读（图片走多模态，不落这条） */
function saveInboxFile({ userDataPath, channelId, name, buf }) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const safeName = String(name || 'attachment.bin').replace(/[\\/:*?"<>|]/g, '_').slice(0, 120);
  const dir = path.join(userDataPath, 'channels-inbox', String(channelId || 'channel'));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${stamp}-${safeName}`);
  fs.writeFileSync(file, buf);
  pruneInboxDir(dir);
  return file;
}

/**
 * 收件箱是缓存不是档案：只保留最近 INBOX_KEEP_DAYS 天的附件，否则群里每天发文件会把
 * 磁盘吃到用户自己都不认识（谁也不会去手动清 userData）。
 */
function pruneInboxDir(dir) {
  const cutoff = Date.now() - INBOX_KEEP_DAYS * 24 * 3600 * 1000;
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    const full = path.join(dir, name);
    try {
      const st = fs.statSync(full);
      if (st.isFile() && st.mtimeMs < cutoff) fs.unlinkSync(full);
    } catch {
      // 单个文件删不掉不影响本轮
    }
  }
}

/**
 * 把附件变成「模型能看的东西」：图片 → 多模态 part（同时留一份磁盘副本供后续轮引用），
 * 文件 → 收件箱路径 + 正文提示。
 *
 * @returns {Promise<{ imageParts: Array<object>, ledgerNotes: string[], ledgerAttachments: Array<object> }>}
 */
async function prepareAttachments({ attachments, userDataPath, channelId, workspacePath, log }) {
  const imageParts = [];
  const ledgerNotes = [];
  const ledgerAttachments = [];
  for (const item of Array.isArray(attachments) ? attachments : []) {
    if (!item || !item.url) continue;
    try {
      const { buf, contentType } = await downloadAttachment(item.url, log);
      if (item.kind === 'image') {
        const mime = normalizeVisionImageMime(contentType.split(';')[0] || 'image/jpeg') || 'image/jpeg';
        const base64 = buf.toString('base64');
        imageParts.push({ type: 'image_url', image_url: { url: `data:${mime};base64,${base64}` } });
        const stored = storeVisionImage({ base64, mime }, { workspacePath: workspacePath || undefined, userDataPath });
        if (stored && stored.path) {
          ledgerNotes.push(`[图片] ${stored.path}`);
          ledgerAttachments.push({ kind: 'image', path: stored.path });
        }
      } else {
        const file = saveInboxFile({ userDataPath, channelId, name: item.name, buf });
        ledgerNotes.push(`[附件] ${file}`);
        ledgerAttachments.push({ kind: 'file', path: file });
      }
    } catch (e) {
      ledgerNotes.push(`[附件] 下载失败：${(e && e.message) || e}`);
    }
  }
  return { imageParts, ledgerNotes, ledgerAttachments };
}

/**
 * 会话解析：频道会话由频道自己持有（一条联系人 → 一条会话），失联即重建。
 * `workspacePath` 是「本次运行的生效工作空间」——调用方算好传进来
 * （该会话显式切过的目录优先，否则频道默认），这里不自己读配置，避免两处口径。
 */
async function ensureChannelSession({ gateway, store, channel, channelId, conversationKey, sessionId, workspacePath, onSession }) {
  const target = String(workspacePath || '');
  let sid = String(sessionId || '');
  if (sid) {
    try {
      const row = await gateway.invokeRpc('memory.session_get', { sessionId: sid });
      if (row && row.id) {
        if (target && String(row.workspacePath || '').trim() !== target) {
          await bindSessionWorkspace(gateway, sid, target);
        }
        return sid;
      }
      sid = '';
    } catch {
      // 会话已被删除：重建（映射由调用方清掉）
      sid = '';
    }
  }
  const created = await gateway.invokeRpc('memory.session_create', {
    title: channelSessionTitle(channel),
    workspacePath: target || null
  });
  if (!created || !created.id) throw userError('创建频道会话失败');
  sid = created.id;
  if (target) await bindSessionWorkspace(gateway, sid, target);
  if (typeof onSession === 'function') onSession(sid);
  if (store && conversationKey) store.setConversationSession(channelId, conversationKey, sid);
  return sid;
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
 * @param {{
 *   store: object,
 *   userData: string,
 *   getGateway: () => any,
 *   getCoreBridge: () => any,
 *   getMcpRuntime: () => any,
 *   getCompactionAgent: () => any,
 *   createToolBridge: (webContents: any) => any,
 *   listMcpServers?: (userDataPath: string) => any[],
 *   log?: (msg: string) => void
 * }} deps
 */
function createChannelTurnRunner(deps) {
  const log = typeof deps.log === 'function' ? deps.log : () => {};

  /** 告诉桌面「账本里多了一条会话」：只刷新历史列表，不切换当前会话 */
  function notifySessionsChanged(channel, sessionId) {
    if (typeof deps.notifySessionsChanged !== 'function') return;
    try {
      deps.notifySessionsChanged({
        channelId: (channel && channel.id) || '',
        sessionId,
        title: channelSessionTitle(channel)
      });
    } catch (e) {
      log(`[channels] 通知桌面刷新会话列表失败：${(e && e.message) || e}`);
    }
  }

  /**
   * @param {{ channelId: string, conversationKey: string, sessionId: string, text: string,
   *   attachments: Array<{kind: 'image'|'file', url: string, name?: string}>,
   *   sink: { push: (text: string) => void }, signal?: AbortSignal,
   *   onSession?: (sessionId: string) => void }} ctx
   * @returns {Promise<{ sessionId: string, text: string }>}
   */
  async function runTurn(ctx) {
    const channelId = String(ctx.channelId || '');
    const conversationKey = String(ctx.conversationKey || '');
    const gateway = deps.getGateway ? deps.getGateway() : null;
    const coreBridge = deps.getCoreBridge ? deps.getCoreBridge() : null;
    if (!gateway || typeof gateway.invokeRpc !== 'function') throw userError('Gateway 未就绪，频道任务无法执行');
    if (!coreBridge || !coreBridge.isReady || !coreBridge.isReady()) {
      throw userError('dieyun-core 未就绪（请运行 npm run pack:dieyun-core 并重启客户端）');
    }
    const channel = deps.store.getChannel(channelId);
    if (!channel) throw userError('频道不存在');
    // 生效工作空间：这个会话显式切过的优先（微信里说过「切到 XX 项目」），否则用频道默认。
    // 频道默认只负责「新会话从哪开始」，改设置不该把用户已经切过去的会话拽回来。
    const conversation = conversationKey
      ? deps.store.getConversation(channelId, conversationKey)
      : null;
    // 一轮内可能被 session_set_workspace 改掉：后续工具调用立刻改用新目录
    let workspacePath = String(
      (conversation && conversation.workspacePath) || channel.workspacePath || ''
    );

    const sessionId = await ensureChannelSession({
      gateway,
      store: deps.store,
      channel,
      channelId,
      conversationKey,
      sessionId: ctx.sessionId,
      workspacePath,
      // 新会话一建出来就让桌面看见：用户切到「历史对话」不必等这一轮跑完
      onSession: (sid) => {
        if (typeof ctx.onSession === 'function') ctx.onSession(sid);
        notifySessionsChanged(channel, sid);
      }
    });

    // 模型：频道没有 Renderer 会话，只能按默认文本模型解析（显式报错，不静默换 key）
    const settings = loadModelSettings(deps.userData);
    const llm = resolveTextApiConfig(settings, {});
    if (!llm.apiKey || !llm.baseUrl) throw userError('未配置 API Key，请在「模型设置」里填写');
    const llmModel = llm.model || settings.textModel || '';
    if (!llmModel) throw userError('没有可用的默认模型，请在「模型设置」里启用一个供应商模型');
    const contextTierId = resolveContextTierIdFromSettings(settings, llm.model);
    const runSettings = applyTierRuntime(settings, deps.userData, { tierId: contextTierId, model: llmModel });
    const tokenBudget = getEffectiveInputBudget(runSettings, llmModel);
    const apiCfg = { ...llm, baseUrl: llm.baseUrl, apiKey: llm.apiKey };

    // 附件：图片进多模态（当轮可见），文件进收件箱（工具可读）；两者都留一行落库说明
    const preparedAtt = await prepareAttachments({
      attachments: ctx.attachments,
      userDataPath: deps.userData,
      channelId,
      workspacePath,
      log
    });
    const userText = String(ctx.text || '').trim();
    const ledgerText = [userText, ...preparedAtt.ledgerNotes].filter(Boolean).join('\n\n');
    if (!ledgerText) throw userError('消息内容为空');

    // 先落用户轮次：历史读回来时它就是「当前任务」，多模态 part 由 prepared 顶替该条
    await gateway.invokeRpc('memory.message_append', {
      sessionId,
      role: 'user',
      content: packMessageMeta(
        ledgerText,
        { trigger: channelTriggerMeta(channel), attachments: preparedAtt.ledgerAttachments },
        { role: 'user' }
      )
    });

    const indexOk = await codebaseIndexReady(gateway, workspacePath);
    const snapshot = {
      userQuery: userText || ledgerText,
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
      composerMode: 'agent',
      now: new Date().toISOString()
    };
    const built = buildPrepSystemPromptDeps({
      gateway,
      userData: deps.userData,
      snapshot,
      listMcpServers: deps.listMcpServers
    });
    const sysPack = await built.prepSystemPrompt(snapshot, built.deps);
    const sysContent = String((sysPack && sysPack.content) || (sysPack && sysPack.stable) || '');
    const turnRide = String((sysPack && sysPack.turnRide) || '');

    const rows = await gateway.invokeRpc('memory.messages_recent', { sessionId, limit: 120 });
    const history = (Array.isArray(rows) ? rows : [])
      .filter((r) => r && (r.role === 'user' || r.role === 'assistant'))
      .map((r) => ({ role: r.role, content: String(r.content || ''), created_at: r.createdAt || r.created_at }));
    const helpers = {
      unpackUserContent: (raw) => unpackMessageMeta(raw).content,
      unpackAssistantMeta: (raw) => ({ content: unpackMessageMeta(raw).content, meta: null }),
      compactPlainText: (s, n) => String(s || '').slice(0, n)
    };
    const prepared = preparedAtt.imageParts.length
      ? {
          content: [{ type: 'text', text: ledgerText }, ...preparedAtt.imageParts],
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

    const mcpRuntime = deps.getMcpRuntime ? deps.getMcpRuntime() : null;
    const tools = [
      ...(await buildMainAgentTools(mcpRuntime)),
      // 外部频道没有工作空间选择器，换项目只能由模型显式调这条工具
      ...catalog.toolsByNames(catalog.CHANNEL_RUNTIME_TOOL_NAMES)
    ];
    const toolBridge = deps.createToolBridge(null);
    const compactionAgent = deps.getCompactionAgent ? deps.getCompactionAgent() : null;
    const workspaceSwitcher = createChannelWorkspaceSwitcher({
      gateway,
      store: deps.store,
      log
    });

    /** 频道的私事（换工作空间）就地处理；其余工具照旧委托给 Main 工具桥 */
    async function runChannelTool(name, args) {
      if (name !== 'session_set_workspace') return null;
      const result = await workspaceSwitcher.switchWorkspace({
        channel,
        conversationKey,
        sessionId,
        workspace: args && args.workspace,
        currentWorkspacePath: workspacePath
      });
      if (result.ok) {
        if (result.workspacePath) workspacePath = String(result.workspacePath);
        // 会话行的工作空间变了，桌面历史列表要把它挪到新项目分组下
        notifySessionsChanged(channel, sessionId);
      }
      return result;
    }

    let loopResult = null;
    let aborted = false;
    try {
      loopResult = await runRustAgentLoop({
        coreBridge,
        llm: apiCfg,
        settings: runSettings,
        userData: deps.userData,
        useStream: true,
        signal: ctx.signal || null,
        sessionId,
        runSource: 'channel',
        // 流式正文：`llm_delta.content` 是**本轮累计**正文（不是增量），直接推给节流 sink；
        // 收尾轮（synthesis）同理。企微按条数限流，节流在 runtime 的 sink 里做。
        onPhase: (phase, data) => {
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
          compactionAgent,
          gateway,
          userData: deps.userData,
          sessionId,
          workspacePath,
          tokenBudget,
          contextTierId,
          apiConfig: apiCfg,
          model: llmModel
        }),
        turnEndSynthesis: true,
        delegateTool: async (name, args) => {
          const handled = await runChannelTool(name, args);
          if (handled) return handled;
          return toolBridge.executeAgentTool(name, args, {
            workspacePath: workspacePath || undefined,
            sessionId,
            model: llmModel
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
      await gateway.invokeRpc('memory.message_append', {
        sessionId,
        role: 'assistant',
        content: packMessageMeta('（频道任务已中止）', { trigger: channelTriggerMeta(channel) }, { role: 'assistant' })
      });
      notifySessionsChanged(channel, sessionId);
      return { sessionId, text: '（频道任务已中止）' };
    }

    const reply = String((loopResult && loopResult.content) || '').trim();
    if (!reply) {
      const trace = (loopResult && loopResult.trace) || [];
      const toolCount = trace.reduce((n, r) => n + ((r && r.tools) || []).length, 0);
      // 这是最常见的失败（上游拒绝 / 额度用尽 / 只调工具没写正文），且文案不含内部细节：
      // 标成 userSafe 才能让微信那头知道「为什么没回话」，而不是一句通用失败。
      throw userError(
        toolCount
          ? `模型执行了 ${toolCount} 次工具调用但未生成任何正文，请查看桌面端日志后重试`
          : '模型未返回任何正文（上游可能拒绝请求或额度已用尽），请稍后重试'
      );
    }

    // 落库与桌面聊天同一闸门：带标签的思考引用只用于展示，写进账本换占位
    const body = roundText.persistableTurnText(reply);
    await gateway.invokeRpc('memory.message_append', {
      sessionId,
      role: 'assistant',
      content: packMessageMeta(body, { trigger: channelTriggerMeta(channel) }, { role: 'assistant' })
    });
    await gateway.invokeRpc('memory.touch_session', { sessionId, title: channelSessionTitle(channel) });
    // 轮末再通知一次：会话行的时间/条数变了，历史列表里排到正确位置
    notifySessionsChanged(channel, sessionId);

    // 记忆归纳：频道的轮次同样沉淀（与定时计划同一入口）
    try {
      const { afterAgentRun } = require('../agent/knowledge-maintainer');
      afterAgentRun({
        result: {
          content: reply,
          trace: (loopResult && loopResult.trace) || [],
          runId: loopResult && loopResult.runId,
          plan: null,
          review: null,
          readiness: loopResult && loopResult.readiness
        },
        opts: {
          sessionId,
          workspacePath: workspacePath || '',
          model: llmModel,
          apiConfig: apiCfg,
          userText: ledgerText
        }
      });
    } catch {
      // 归纳失败不影响回复
    }

    return { sessionId, text: reply };
  }

  return { runTurn };
}

module.exports = { createChannelTurnRunner, channelSessionTitle, channelTriggerMeta, prepareAttachments };
