'use strict';

const path = require('path');
const { bindSessionWorkspace } = require('../agent/session-workspace-bind');

/**
 * 「这个企微会话换到另一个项目」的唯一实现。
 *
 * 为什么必须是 Main 侧的一个工具，而不是在消息里认关键词：用户说「切到代账那个项目」是自然语言，
 * 认关键词既脆又违反本仓的意图硬编码禁令；模型本来就看得见工具清单，让它显式调一次更可靠。
 * 桌面上这件事由渲染器的空间选择器做（用户点选），频道里没有 UI，所以只能走工具。
 *
 * 候选集 = 频道默认工作空间 + 本机已有会话的工作空间（就是桌面左侧那些项目文件夹）。
 * 这个边界是刻意的：企微群聊里任何人都能给机器人发消息，若允许「任意绝对路径」，
 * 一句「切到 C:\Windows」就能把 Agent 指到系统目录。用户要聊一个从没在桌面打开过的
 * 项目，先在桌面打开一次即可（也就同时有了索引与 AGENTS.md）。
 */

const DEFAULT_SENTINEL = 'default';
const KNOWN_WORKSPACE_LIMIT = 200;

function normalizePathKey(p) {
  return String(p || '')
    .trim()
    .replace(/[\\/]+$/, '')
    .replace(/\//g, '\\')
    .toLowerCase();
}

function baseNameOf(p) {
  const s = String(p || '').trim();
  if (!s) return '';
  const parts = s.replace(/\\/g, '/').replace(/\/+$/, '').split('/');
  return parts[parts.length - 1] || '';
}

/**
 * @param {{
 *   gateway: any,
 *   store: any,
 *   log?: (msg: string) => void
 * }} deps
 */
function createChannelWorkspaceSwitcher(deps) {
  const log = typeof deps.log === 'function' ? deps.log : () => {};

  /** 候选清单：频道默认 + 本机已有会话的工作空间（去重、保持顺序） */
  async function listCandidates(channel) {
    const list = [];
    const seen = new Set();
    const push = (p) => {
      const raw = String(p || '').trim();
      if (!raw) return;
      const key = normalizePathKey(raw);
      if (!key || seen.has(key)) return;
      seen.add(key);
      list.push({ path: raw, name: baseNameOf(raw) || raw });
    };
    push(channel && channel.workspacePath);
    try {
      const rows = await deps.gateway.invokeRpc('memory.sessions_list', {
        limit: KNOWN_WORKSPACE_LIMIT,
        archived: false
      });
      for (const row of Array.isArray(rows) ? rows : []) {
        push(row && (row.workspaceProjectPath || row.workspacePath));
      }
    } catch (e) {
      log(`[channels] 读取已有工作空间失败：${(e && e.message) || e}`);
    }
    return list;
  }

  /** 把用户/模型给的值对到候选上：绝对路径 > 目录名精确 > 目录名部分匹配（唯一才认） */
  function matchCandidate(input, candidates) {
    const raw = String(input || '').trim();
    if (!raw) return null;
    const key = normalizePathKey(raw);
    const exact = candidates.find((c) => normalizePathKey(c.path) === key);
    if (exact) return exact;
    const byName = candidates.filter((c) => c.name.toLowerCase() === raw.toLowerCase());
    if (byName.length === 1) return byName[0];
    const byPart = candidates.filter((c) => c.name.toLowerCase().includes(raw.toLowerCase()));
    if (byPart.length === 1) return byPart[0];
    if (byPart.length > 1) return { ambiguous: byPart };
    return null;
  }

  function candidateText(candidates) {
    if (!candidates.length) return '（本机还没有可用的工作空间）';
    return candidates.map((c) => `${c.name}（${c.path}）`).join('、');
  }

  /**
   * @param {{ channel: object, conversationKey: string, sessionId: string,
   *   workspace: string, currentWorkspacePath?: string }} ctx
   * @returns {Promise<{ ok: boolean, workspacePath?: string, message: string, candidates?: Array<object> }>}
   */
  async function switchWorkspace(ctx) {
    const channel = ctx.channel;
    const channelId = channel && channel.id;
    const conversationKey = String(ctx.conversationKey || '');
    const sessionId = String(ctx.sessionId || '');
    const wanted = String(ctx.workspace || '').trim();
    if (!channelId || !conversationKey || !sessionId) {
      return { ok: false, message: '当前不是可切换工作空间的会话（缺少频道或会话上下文）' };
    }
    if (!wanted) {
      // 只查不切：模型常不知道本机有哪些项目，先把候选给它
      const list = await listCandidates(channel);
      return {
        ok: false,
        message: `未指定 workspace，未做切换。本机可切的工作空间：${candidateText(list)}`,
        candidates: list
      };
    }

    const defaultPath = channel.workspacePath ? String(channel.workspacePath) : '';
    // 「回默认」只认工具 schema 声明的哨兵值（`tool-catalog.js`：传 "default" 回到默认工作空间）。
    // 以前这里还认「默认」「默认工作空间」两个中文串 —— 等于让一张词表替模型决定参数含义，
    // 与桌面侧 `renderer-workspace-ssh.js` 各存一份、各自漂移。参数含义只有 schema 一处。
    if (wanted.toLowerCase() === DEFAULT_SENTINEL) {
      deps.store.setConversationWorkspace(channelId, conversationKey, '');
      if (!defaultPath) {
        // 频道没设默认目录：解绑，回到 ~/.dieyun/workspace（会话行写 NULL，不写空串）
        await bindSessionWorkspace(deps.gateway, sessionId, '');
        return {
          ok: true,
          workspacePath: '',
          message: '已恢复为频道默认：这条频道没设默认目录，会话回到 ~/.dieyun/workspace。'
        };
      }
      await bindSessionWorkspace(deps.gateway, sessionId, defaultPath);
      return {
        ok: true,
        workspacePath: defaultPath,
        message: `已切回频道默认工作空间：${defaultPath}`
      };
    }

    const candidates = await listCandidates(channel);
    const matched = matchCandidate(wanted, candidates);
    if (!matched) {
      return {
        ok: false,
        message:
          `找不到工作空间「${wanted}」。只能切到本机已经用过的项目（先在桌面打开一次就会出现在这里）；` +
          `要回到频道默认工作空间，请传 workspace="${DEFAULT_SENTINEL}"。` +
          `现有候选：${candidateText(candidates)}`,
        candidates
      };
    }
    if (matched.ambiguous) {
      return {
        ok: false,
        message: `「${wanted}」匹配到多个项目，请指明是哪一个：${candidateText(matched.ambiguous)}`,
        candidates: matched.ambiguous
      };
    }

    await bindSessionWorkspace(deps.gateway, sessionId, matched.path);
    // 记住这次选择：下一轮开跑直接用它（频道默认只是「新会话」的起点）
    deps.store.setConversationWorkspace(channelId, conversationKey, matched.path);
    log(`[channels] ${channelId} 会话 ${sessionId} 工作空间切到 ${matched.path}`);
    return {
      ok: true,
      workspacePath: matched.path,
      message:
        `已切到这个企微会话的工作空间：${matched.path}。` +
        '之后的读写、AGENTS.md、代码索引都以它为准；再说「切回默认」可以恢复。'
    };
  }

  return { switchWorkspace, listCandidates, matchCandidate, baseNameOf, normalizePathKey };
}

module.exports = { createChannelWorkspaceSwitcher, baseNameOf, normalizePathKey };
