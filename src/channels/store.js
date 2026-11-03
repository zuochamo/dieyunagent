'use strict';

const { createSecretStore } = require('../secret-store');
const { parseWorkspaceInput, buildSshUri } = require('../workspace/target');

/**
 * 频道（目前只有企业微信智能机器人）的持久化存储。
 *
 * 一条「频道」= 一个外部入口：一条企微机器人的凭据 + 一个工作空间 + 它自己的会话映射表。
 * 桌面 UI 的当前会话/当前工作空间与它无关 —— 这条边界是本模块存在的理由
 * （见 issue/2026-10-30-agent-channel-and-workspace-binding.md）。
 *
 * 安全：Secret 只以 safeStorage 密文落盘（`secretEnc`，base64）；文件本身按 0600 写。
 * 加解密与落盘权限的唯一实现在 `src/secret-store.js`（MCP / SSH 凭据同一份）：
 * 能加密才允许保存，否则明确报错而不是明文兜底。
 *
 * 会话映射（企微联系人 → Agent 会话）跟频道一起存：外部入口的「一对一关系」是频道自己的
 * 状态，散落到别的文件只会多一处真相。上限 500 条按最近活跃裁剪，避免长跑后无限增长。
 */

const CONVERSATION_LIMIT = 500;

function emptyState() {
  return { version: 1, channels: [] };
}

/**
 * 工作空间字符串的唯一归一入口（与 Gateway 写库闸门同一份解析，见
 * `gateway/handlers/memory.js#normalizeSessionWorkspacePath`）：
 * 能解析就存规范形态，解析不出来直接拒绝 —— 免得存进一个谁也认不出的路径。
 * @param {string|null|undefined} workspacePath
 * @returns {string|null}
 */
function normalizeWorkspacePath(workspacePath) {
  const raw = String(workspacePath == null ? '' : workspacePath).trim();
  if (!raw) return null;
  const target = parseWorkspaceInput(raw);
  if (!target) {
    const e = new Error(`工作空间路径无法识别：${raw}（远端须写成 ssh://user@host/path）`);
    e.code = 'INVALID_PARAMS';
    throw e;
  }
  return target.kind === 'ssh' ? buildSshUri(target) : target.path;
}

function newChannelId() {
  return `ch_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * @param {{ userDataPath: string, safeStorage?: import('electron').SafeStorage, log?: (msg: string) => void }} deps
 */
function createChannelStore(deps) {
  const userDataPath = String(deps.userDataPath || '');
  const log = typeof deps.log === 'function' ? deps.log : () => {};
  // 加解密与 0600 落盘唯一实现：`src/secret-store.js`
  const box = createSecretStore({
    userDataPath,
    fileName: 'channels.json',
    safeStorage: deps.safeStorage,
    log,
    label: 'channels',
    encryptUnavailableMessage: '当前系统无法加密存储凭据，无法保存频道 Secret',
    // 坏文件必须抛（不能当空）：下一次保存会用「只有一条频道」的状态覆盖整份文件，
    // 用户所有频道与会话映射一起没。
    onCorrupt: 'throw',
    corruptCode: 'CHANNEL_STORE_CORRUPT'
  });
  const file = box.filePath;

  const canEncrypt = box.canEncrypt;
  const encryptSecret = box.encryptSecret;
  const decryptSecret = box.decryptSecret;

  /**
   * 读配置。**解析失败绝不静默当空**（见 `secret-store.js` 的 `onCorrupt: 'throw'`）。
   * 文件不存在才算空态；结构不对同样报 CHANNEL_STORE_CORRUPT，让 UI 明确告诉用户文件坏了。
   */
  function readState() {
    const raw = box.readJson();
    if (!raw) return emptyState();
    if (!Array.isArray(raw.channels)) {
      const err = new Error(`频道配置文件结构不对（${file}）：缺少 channels 数组`);
      err.code = 'CHANNEL_STORE_CORRUPT';
      log(`[channels] ${err.message}`);
      throw err;
    }
    return { version: 1, channels: raw.channels.filter((c) => c && c.id) };
  }

  function writeState(state) {
    const payload = { version: 1, channels: state.channels.map(publicRecordOfStorage) };
    // 只存密文，但文件仍按 0600 落盘（与 ssh-profiles.json 同理：同机其他用户不该看到
    // 你有哪几条频道、绑定哪个目录）
    box.writeJson(payload);
  }

  /** 落盘形态：去掉运行时字段，只留配置 */
  function publicRecordOfStorage(row) {
    return {
      id: String(row.id),
      kind: 'wecom',
      name: String(row.name || ''),
      enabled: row.enabled !== false,
      botId: String(row.botId || ''),
      secretEnc: String(row.secretEnc || ''),
      workspacePath: row.workspacePath ? String(row.workspacePath) : null,
      // 进入会话的欢迎语（空 = 不发，别打扰用户）
      welcomeText: String(row.welcomeText || ''),
      createdAt: Number(row.createdAt) || Date.now(),
      updatedAt: Number(row.updatedAt) || Date.now(),
      conversations: sanitizeConversations(row.conversations)
    };
  }

  function sanitizeConversations(input) {
    if (!input || typeof input !== 'object') return {};
    const rows = Object.entries(input)
      .map(([key, val]) => ({
        key,
        sessionId: val && val.sessionId ? String(val.sessionId) : '',
        // 这个企微会话显式切过的工作空间（空 = 用频道默认）；
        // 有它才不用在每轮重新问用户「今天是哪个项目」
        workspacePath: val && val.workspacePath ? String(val.workspacePath) : '',
        updatedAt: Number(val && val.updatedAt) || 0
      }))
      .filter((r) => r.key && r.sessionId)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, CONVERSATION_LIMIT);
    const out = {};
    for (const r of rows) {
      out[r.key] = { sessionId: r.sessionId, workspacePath: r.workspacePath, updatedAt: r.updatedAt };
    }
    return out;
  }

  /** 对外视图：永不带出 Secret，只告诉 UI「有没有存过」 */
  function toPublic(row) {
    return {
      id: row.id,
      kind: row.kind,
      name: row.name,
      enabled: row.enabled !== false,
      botId: row.botId || '',
      hasSecret: !!(row.secretEnc && canEncrypt()),
      workspacePath: row.workspacePath || null,
      welcomeText: row.welcomeText || '',
      conversationCount: Object.keys(row.conversations || {}).length,
      createdAt: Number(row.createdAt) || 0,
      updatedAt: Number(row.updatedAt) || 0
    };
  }

  function listChannels() {
    return readState().channels.map(toPublic);
  }

  function getChannelRecord(id) {
    const cid = String(id || '').trim();
    if (!cid) return null;
    return readState().channels.find((c) => String(c.id) === cid) || null;
  }

  function getChannel(id) {
    const row = getChannelRecord(id);
    return row ? toPublic(row) : null;
  }

  /** 运行时取凭据的唯一出口（明文只在内存里出现一次） */
  function getChannelSecrets(id) {
    const row = getChannelRecord(id);
    if (!row) return null;
    return {
      id: row.id,
      botId: String(row.botId || ''),
      secret: decryptSecret(row.secretEnc),
      enabled: row.enabled !== false,
      workspacePath: row.workspacePath || null
    };
  }

  /**
   * @param {{ name?: string, botId: string, secret: string, workspacePath?: string|null, welcomeText?: string, enabled?: boolean }} input
   */
  function createChannel(input = {}) {
    const botId = String(input.botId || '').trim();
    const secret = String(input.secret || '').trim();
    if (!botId) {
      const e = new Error('Bot ID 必填');
      e.code = 'INVALID_PARAMS';
      throw e;
    }
    if (!secret) {
      const e = new Error('Secret 必填');
      e.code = 'INVALID_PARAMS';
      throw e;
    }
    const state = readState();
    if (state.channels.some((c) => String(c.botId) === botId)) {
      const e = new Error('该 Bot ID 已存在于其他频道');
      e.code = 'CHANNEL_DUPLICATE';
      throw e;
    }
    const now = Date.now();
    const row = {
      id: newChannelId(),
      kind: 'wecom',
      name: String(input.name || '').trim() || `企业微信 ${botId.slice(-6)}`,
      enabled: input.enabled !== false,
      botId,
      secretEnc: encryptSecret(secret),
      workspacePath: normalizeWorkspacePath(input.workspacePath),
      welcomeText: String(input.welcomeText || '').trim(),
      createdAt: now,
      updatedAt: now,
      conversations: {}
    };
    state.channels.push(row);
    writeState(state);
    return toPublic(row);
  }

  /**
   * @param {string} id
   * @param {{ name?: string, botId?: string, secret?: string, workspacePath?: string|null, welcomeText?: string, enabled?: boolean }} patch
   */
  function updateChannel(id, patch = {}) {
    const cid = String(id || '').trim();
    const state = readState();
    const idx = state.channels.findIndex((c) => String(c.id) === cid);
    if (idx < 0) {
      const e = new Error('频道不存在');
      e.code = 'CHANNEL_NOT_FOUND';
      throw e;
    }
    const row = state.channels[idx];
    const next = { ...row };
    if (patch.name !== undefined) next.name = String(patch.name || '').trim() || row.name;
    if (patch.botId !== undefined) {
      const botId = String(patch.botId || '').trim();
      if (!botId) {
        const e = new Error('Bot ID 必填');
        e.code = 'INVALID_PARAMS';
        throw e;
      }
      if (state.channels.some((c) => String(c.id) !== cid && String(c.botId) === botId)) {
        const e = new Error('该 Bot ID 已存在于其他频道');
        e.code = 'CHANNEL_DUPLICATE';
        throw e;
      }
      next.botId = botId;
    }
    // 只改密码时前端不回传原 Secret：undefined = 保持不变，空串 = 不允许清空
    if (patch.secret !== undefined) {
      const secret = String(patch.secret || '').trim();
      if (!secret) {
        const e = new Error('Secret 不能为空');
        e.code = 'INVALID_PARAMS';
        throw e;
      }
      next.secretEnc = encryptSecret(secret);
    }
    if (patch.workspacePath !== undefined) next.workspacePath = normalizeWorkspacePath(patch.workspacePath);
    if (patch.welcomeText !== undefined) next.welcomeText = String(patch.welcomeText || '').trim();
    if (patch.enabled !== undefined) next.enabled = !!patch.enabled;
    next.updatedAt = Date.now();
    state.channels[idx] = next;
    writeState(state);
    return toPublic(next);
  }

  function deleteChannel(id) {
    const cid = String(id || '').trim();
    const state = readState();
    const before = state.channels.length;
    state.channels = state.channels.filter((c) => String(c.id) !== cid);
    if (state.channels.length === before) return { ok: false, error: 'CHANNEL_NOT_FOUND' };
    writeState(state);
    return { ok: true };
  }

  function getConversationSession(id, conversationKey) {
    const row = getChannelRecord(id);
    const key = String(conversationKey || '').trim();
    if (!row || !key) return '';
    const entry = row.conversations && row.conversations[key];
    return entry && entry.sessionId ? String(entry.sessionId) : '';
  }

  function setConversationSession(id, conversationKey, sessionId) {
    const cid = String(id || '').trim();
    const key = String(conversationKey || '').trim();
    if (!cid || !key) return false;
    const state = readState();
    const idx = state.channels.findIndex((c) => String(c.id) === cid);
    if (idx < 0) return false;
    const row = state.channels[idx];
    const conversations = { ...(row.conversations || {}) };
    if (!sessionId) delete conversations[key];
    else {
      // 重建会话时保留这条会话显式选过的工作空间（否则用户切过去的项目会丢）
      const prev = conversations[key] || {};
      conversations[key] = {
        sessionId: String(sessionId),
        workspacePath: prev.workspacePath || '',
        updatedAt: Date.now()
      };
    }
    state.channels[idx] = { ...row, conversations: sanitizeConversations(conversations) };
    writeState(state);
    return true;
  }

  /**
   * 记一次「这个会话还活着」：只更新 updatedAt，不动 sessionId / workspacePath。
   *
   * 会话映射按 updatedAt 裁剪（500 条），只在「新建/切换」时更新会让老会话的活跃时间停在
   * 第一次说话那一刻 —— 天天在用的群会被当成最旧的先裁掉，用户的上下文凭空消失。
   */
  function touchConversation(id, conversationKey) {
    const cid = String(id || '').trim();
    const key = String(conversationKey || '').trim();
    if (!cid || !key) return false;
    const state = readState();
    const idx = state.channels.findIndex((c) => String(c.id) === cid);
    if (idx < 0) return false;
    const row = state.channels[idx];
    const prev = (row.conversations || {})[key];
    if (!prev || !prev.sessionId) return false;
    const conversations = { ...row.conversations, [key]: { ...prev, updatedAt: Date.now() } };
    state.channels[idx] = { ...row, conversations: sanitizeConversations(conversations) };
    writeState(state);
    return true;
  }

  /**
   * 记住「这个企微会话用哪个工作空间」：空值 = 回到频道默认。
   * 只在该会话已存在映射时生效（没有会话就没有「切到哪」这回事）。
   */
  function setConversationWorkspace(id, conversationKey, workspacePath) {
    const cid = String(id || '').trim();
    const key = String(conversationKey || '').trim();
    if (!cid || !key) return false;
    const state = readState();
    const idx = state.channels.findIndex((c) => String(c.id) === cid);
    if (idx < 0) return false;
    const row = state.channels[idx];
    const conversations = { ...(row.conversations || {}) };
    const prev = conversations[key];
    if (!prev || !prev.sessionId) return false;
    conversations[key] = {
      sessionId: String(prev.sessionId),
      workspacePath: workspacePath ? String(workspacePath) : '',
      updatedAt: Date.now()
    };
    state.channels[idx] = { ...row, conversations: sanitizeConversations(conversations) };
    writeState(state);
    return true;
  }

  /** 一条会话的映射（会话 id + 显式选过的工作空间） */
  function getConversation(id, conversationKey) {
    const row = getChannelRecord(id);
    const key = String(conversationKey || '').trim();
    if (!row || !key) return null;
    const entry = (row.conversations || {})[key];
    if (!entry || !entry.sessionId) return null;
    return { sessionId: String(entry.sessionId), workspacePath: String(entry.workspacePath || '') };
  }

  /** 会话被删（SESSION_NOT_FOUND）时清掉映射，下一次消息自动重建 */
  function clearConversationSession(id, conversationKey) {
    return setConversationSession(id, conversationKey, '');
  }

  return {
    file,
    canEncrypt,
    listChannels,
    getChannel,
    getChannelSecrets,
    createChannel,
    updateChannel,
    deleteChannel,
    getConversation,
    getConversationSession,
    setConversationSession,
    setConversationWorkspace,
    touchConversation,
    clearConversationSession
  };
}

module.exports = { createChannelStore, normalizeWorkspacePath, CONVERSATION_LIMIT };
