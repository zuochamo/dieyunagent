'use strict';

const fs = require('fs');
const path = require('path');
const { runMainTurn, userError } = require('../agent/main-turn-runner');
const { bindSessionWorkspace } = require('../agent/session-workspace-bind');
const { createChannelWorkspaceSwitcher } = require('./workspace-switch');
const catalog = require('../agent/tool-catalog');
const { normalizeVisionImageMime } = require('../agent/guardrails-shared');
const { storeVisionImage } = require('../agent/vision-image');

/**
 * 频道一轮对话的执行体：**在 Main 里**跑完整的 Agent 循环，不经过 Renderer。
 *
 * 为什么要这一层（而不是复用手机桥的 `task.submit`）：`task.submit` 的语义是「驱动桌面
 * 上正在看的会话」，跑之前要把 Renderer 切到目标会话 —— 微信来一条消息就把用户的桌面
 * 对话切走，且方向相反（external → desktop）。频道任务的正确形态是「后台跑一轮」：
 * 自己的会话、自己的工作空间、自己的模型解析，完全不碰 `currentSessionId`。
 *
 * 一轮怎么跑（系统提示 / 工具 / 压缩 / 落库 / 记忆归纳）**不在本文件**：单一来源是
 * `agent/main-turn-runner.js#runMainTurn`。这里只做频道特有的事：
 * 企微联系人 → 会话映射、附件 URL 下载与收件箱落地、`session_set_workspace` 的频道实现、
 * 以及「桌面历史列表要刷新」的通知。
 */

const CHANNEL_TITLE_PREFIX = '企业微信';
const MAX_ATTACHMENT_BYTES = 16 * 1024 * 1024;
const ATTACHMENT_TIMEOUT_MS = 20_000;
/** 收件箱保留天数（缓存语义：过期即删，见 pruneInboxDir） */
const INBOX_KEEP_DAYS = 7;

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
 *   notifySessionsChanged?: (payload: object) => void,
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

    /** 频道的私事（换工作空间）就地处理；其余工具照旧委托给 Main 工具桥 */
    const workspaceSwitcher = createChannelWorkspaceSwitcher({
      gateway,
      store: deps.store,
      log
    });
    const runChannelTool = async (name, args) => {
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
    };

    const result = await runMainTurn({
      userData: deps.userData,
      gateway,
      coreBridge,
      mcpRuntime: deps.getMcpRuntime ? deps.getMcpRuntime() : null,
      compactionAgent: deps.getCompactionAgent ? deps.getCompactionAgent() : null,
      toolBridge: deps.createToolBridge(null),
      sessionId,
      workspacePath,
      getWorkspacePath: () => workspacePath,
      userText,
      ledgerText,
      ledgerAttachments: preparedAtt.ledgerAttachments,
      imageParts: preparedAtt.imageParts,
      triggerMeta: channelTriggerMeta(channel),
      sessionTitle: channelSessionTitle(channel),
      extraTools: catalog.toolsByNames(catalog.CHANNEL_RUNTIME_TOOL_NAMES),
      preTool: runChannelTool,
      runSource: 'channel',
      signal: ctx.signal || null,
      sink: ctx.sink || null,
      abortedNote: '（频道任务已中止）',
      listMcpServers: deps.listMcpServers,
      // 共享记忆（跨机）：频道在 Main 后台跑一轮，prompt 装配与桌面同源
      getSharedMemory: deps.getSharedMemory
    });

    // 轮末再通知一次：会话行的时间/条数变了，历史列表里排到正确位置
    notifySessionsChanged(channel, result.sessionId);
    return { sessionId: result.sessionId, text: result.content };
  }

  return { runTurn };
}

module.exports = { createChannelTurnRunner, channelSessionTitle, prepareAttachments };
