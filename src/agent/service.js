'use strict';

const { agentRunEventFromServicePayload } = require('./run-events');
const { bindSessionWorkspace } = require('./session-workspace-bind');

const { EventEmitter } = require('events');
const { dieyunDefaultWorkspaceDir } = require('../agent-home');
const { loadModelSettings, resolveSpeechApiConfig, resolveTtsApiConfig } = require('../model-settings');

function normalizeLimit(value, fallback, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(1, Math.floor(n)));
}

function eventPreview(text, max = 120) {
  return String(text || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

/** 两个工作空间字符串是否指同一个目录（本地路径不区分大小写与斜杠，远端路径区分）。 */
function sameWorkspacePath(a, b) {
  const norm = (v) => {
    const s = String(v == null ? '' : v).trim().replace(/\\/g, '/').replace(/\/+$/, '');
    return /^ssh:/i.test(s) ? s : s.toLowerCase();
  };
  return norm(a) === norm(b);
}

class AgentService extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.gateway = opts.gateway || null;
    this.userDataPath = opts.userDataPath || null;
    this.log = typeof opts.log === 'function' ? opts.log : () => {};
    /**
     * 「谁跑这一轮」的唯一注入点。两种实现：
     * - 桌面：把 task 转发给 Renderer（Renderer 拥有编辑器上下文与工具表）；
     * - 无窗口（`src/headless`）：在 Main 侧就地跑一轮（`agent/main-turn-runner`）。
     * 没注入 = 没有执行者，`submitTask` 明确报错，绝不静默丢弃任务。
     */
    this.executor = null;
    this.canceller = null;
    this.activeRequests = new Map();
  }

  setGateway(gateway) {
    this.gateway = gateway || null;
  }

  setExecutor(fn) {
    this.executor = typeof fn === 'function' ? fn : null;
  }

  setCanceller(fn) {
    this.canceller = typeof fn === 'function' ? fn : null;
  }

  _ensureGateway() {
    if (!this.gateway || typeof this.gateway.invokeRpc !== 'function') {
      const e = new Error('Gateway 未就绪');
      e.code = 'GATEWAY_UNAVAILABLE';
      throw e;
    }
    return this.gateway;
  }

  async _rpc(method, params) {
    return this._ensureGateway().invokeRpc(method, params);
  }

  _emitEvent(event) {
    const payload = {
      at: Date.now(),
      ...event
    };
    if (!payload.runEvent) {
      try {
        payload.runEvent = agentRunEventFromServicePayload(payload);
      } catch {
        payload.runEvent = null;
      }
    }
    this.emit('event', payload);
    return payload;
  }

  info() {
    return {
      ok: true,
      mode: 'lan',
      defaultWorkspace: dieyunDefaultWorkspaceDir(),
      active: [...this.activeRequests.values()].map((r) => ({
        requestId: r.requestId,
        sessionId: r.sessionId,
        status: r.status,
        preview: r.preview,
        createdAt: r.createdAt
      }))
    };
  }

  async listSessions(limit = 50) {
    const rows = await this._rpc('memory.sessions_list', {
      limit: normalizeLimit(limit, 50, 100),
      archived: false
    });
    return Array.isArray(rows) ? rows : [];
  }

  async getMessages(sessionId, limit = 200) {
    if (!sessionId) throw new Error('sessionId 必填');
    const rows = await this._rpc('memory.messages_recent', {
      sessionId: String(sessionId),
      limit: normalizeLimit(limit, 200, 500)
    });
    return Array.isArray(rows) ? rows : [];
  }

  getSpeechSettings() {
    const settings = this.userDataPath ? loadModelSettings(this.userDataPath) : {};
    const cfg = resolveSpeechApiConfig(settings);
    // 朗读（合成）能力：手机端据此决定显不显示「朗读」按钮。
    // 与转写是两个独立槽位 —— 一台服务端常常只有其中一种能力。
    const tts = resolveTtsApiConfig(settings);
    return {
      model: cfg.model || 'whisper-1',
      language: cfg.language || 'zh',
      ttsReady: !!(tts && tts.baseUrl && tts.model),
      ttsModel: tts ? tts.model : '',
      ttsAutoRead: settings.ttsAutoRead === true
    };
  }

  /**
   * 手机端朗读：**只传文本**，模型 / 端点 / 密钥都在 Main 解析
   * （手机不该拿到 apiKey，也不该在两处各维护一份选模型逻辑）。
   */
  async synthesizeSpeech(params = {}) {
    const text = String(params.text || '').trim();
    if (!text) {
      const e = new Error('text 必填');
      e.code = 'EMPTY_TEXT';
      throw e;
    }
    const settings = this.userDataPath ? loadModelSettings(this.userDataPath) : {};
    const cfg = resolveTtsApiConfig(settings);
    if (!cfg || !cfg.baseUrl || !cfg.model) {
      const e = new Error('未配置朗读模型（请在电脑端「设置 → 模型」里添加一个「语音合成」类型的模型）');
      e.code = 'MISSING_TTS_MODEL';
      throw e;
    }
    return this._rpc('speech.synthesize', {
      text,
      baseUrl: cfg.baseUrl,
      apiKey: cfg.apiKey,
      model: cfg.model,
      voice: cfg.voice,
      format: cfg.format,
      authMode: cfg.authMode,
      headers: cfg.headers,
      userAgent: cfg.userAgent
    });
  }

  async getTrace(params = {}) {
    const requestId = params.requestId ? String(params.requestId) : '';
    if (requestId) {
      const active = this.activeRequests.get(requestId);
      if (active && ((Array.isArray(active.trace) && active.trace.length) || active.streamContent)) {
        return {
          runId: active.runId || null,
          requestId,
          sessionId: active.sessionId,
          trace: active.trace || [],
          streamContent: active.streamContent || '',
          live: active.status !== 'completed' && active.status !== 'failed' && active.status !== 'stopped',
          createdAt: active.createdAt || Date.now()
        };
      }
    }
    if (params.sessionId) {
      const sid = String(params.sessionId);
      const active = [...this.activeRequests.values()].find(
        (r) =>
          r.sessionId === sid &&
          ((Array.isArray(r.trace) && r.trace.length) || r.streamContent)
      );
      if (active) {
        return {
          runId: active.runId || null,
          requestId: active.requestId,
          sessionId: active.sessionId,
          trace: active.trace || [],
          streamContent: active.streamContent || '',
          live: active.status !== 'completed' && active.status !== 'failed' && active.status !== 'stopped',
          createdAt: active.createdAt || Date.now()
        };
      }
    }
    if (!params.runId && !params.messageId && params.sessionId) {
      const state = await this._rpc('agent.state_get', { sessionId: String(params.sessionId) });
      if (state && state.runId) {
        const trace = await this._rpc('agent.trace_get', { runId: state.runId });
        return trace || null;
      }
      return null;
    }
    const trace = await this._rpc('agent.trace_get', {
      runId: params.runId,
      messageId: params.messageId
    });
    return trace || null;
  }

  /**
   * 「跟随桌面」模式的取值来源：提交任务的这一刻，桌面视图显示的工作空间。
   * 取不到就交给会话默认（~/.dieyun/workspace）。
   */
  _desktopWorkspacePath() {
    const gw = this.gateway;
    if (!gw || typeof gw.getWorkspace !== 'function') return '';
    try {
      const ws = gw.getWorkspace();
      return ws && ws.workspacePath ? String(ws.workspacePath) : '';
    } catch {
      return '';
    }
  }

  async submitTask(input = {}) {
    const text = String(input.text || '').trim();
    if (!text) {
      const e = new Error('任务内容不能为空');
      e.code = 'INVALID_TEXT';
      throw e;
    }
    if (!this.executor) {
      const e = new Error('任务执行器未连接');
      e.code = 'EXECUTOR_UNAVAILABLE';
      throw e;
    }

    // 外部频道（手机内网桥 / 企微转接器等）可以显式声明本会话的工作空间。绑定归会话所有：
    // 一旦落库，桌面 UI 之后切工作空间/切会话都没有资格改写它。
    // 未声明时沿用「跟随桌面」，但取值在**提交这一刻**定下来并落成绑定 —— 不再让 Renderer
    // 在任务启动时用当时的视图去猜（那正是会话工作空间漂移的成因，见
    // issues/2026-10-30-agent-channel-and-workspace-binding.md 问题 2）。
    const declaredWorkspacePath = String(input.workspacePath || '').trim();
    const workspacePath = declaredWorkspacePath || this._desktopWorkspacePath();

    const requestedSessionId = String(input.sessionId || '').trim();
    let sessionId = '';
    if (requestedSessionId) {
      const row = await this._rpc('memory.session_get', { sessionId: requestedSessionId });
      if (!row || !row.id) {
        const e = new Error('会话不存在或已删除');
        e.code = 'SESSION_NOT_FOUND';
        throw e;
      }
      sessionId = row.id;
      // 显式声明的绑定是该渠道的固定工作空间，要能纠正存量会话（含历史上被桌面拽偏的）。
      // 隐式「跟随桌面」不覆盖已有绑定，否则桌面切目录会把正在用的外部会话拽走。
      // 绑定一律走 `bindSessionWorkspace`（会话行 + 进程内上下文两处都写的唯一实现）：
      // 只写会话行会让下一次 hydrate 之前的工具/索引仍按旧上下文解析路径。
      if (declaredWorkspacePath && !sameWorkspacePath(row.workspacePath, declaredWorkspacePath)) {
        await bindSessionWorkspace(this._ensureGateway(), sessionId, declaredWorkspacePath);
      } else if (!declaredWorkspacePath && !row.workspacePath && workspacePath) {
        // 「跟随桌面」且会话还没绑定：把提交这一刻的桌面工作空间钉到会话上。
        // 之后桌面再切目录不会把这个会话拽走 —— 这正是问题 2 里看到的那种翻转。
        await bindSessionWorkspace(this._ensureGateway(), sessionId, workspacePath);
      }
    } else {
      const created = await this._rpc('memory.session_create', {
        title: input.title || null,
        workspacePath: workspacePath || null
      });
      if (!created || !created.id) {
        const e = new Error('创建会话失败');
        e.code = 'SESSION_CREATE_FAILED';
        throw e;
      }
      sessionId = created.id;
    }

    const requestId = `mobile-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const task = {
      requestId,
      sessionId,
      text,
      source: input.source || 'mobile',
      createdAt: Date.now()
    };
    this.activeRequests.set(requestId, {
      ...task,
      status: 'queued',
      preview: eventPreview(text),
      streamContent: ''
    });

    this._emitEvent({
      type: 'task.queued',
      requestId,
      sessionId,
      preview: eventPreview(text)
    });
    this.executor(task);
    return { ok: true, requestId, sessionId };
  }

  acceptTask(payload = {}) {
    const requestId = String(payload.requestId || '');
    const entry = this.activeRequests.get(requestId);
    if (entry) entry.status = 'running';
    this._emitEvent({
      type: 'task.started',
      requestId,
      sessionId: payload.sessionId || entry?.sessionId || null
    });
  }

  rejectTask(payload = {}) {
    const requestId = String(payload.requestId || '');
    const entry = this.activeRequests.get(requestId);
    if (entry) entry.status = 'failed';
    this._emitEvent({
      type: 'task.failed',
      requestId,
      sessionId: payload.sessionId || entry?.sessionId || null,
      error: String(payload.error || '任务被拒绝')
    });
    this.activeRequests.delete(requestId);
  }

  progressTask(payload = {}) {
    const requestId = String(payload.requestId || '');
    const entry = this.activeRequests.get(requestId);
    const trace = Array.isArray(payload.trace) ? payload.trace : [];
    const streamContent = typeof payload.streamContent === 'string' ? payload.streamContent : '';
    if (entry) {
      entry.trace = trace;
      if (streamContent) entry.streamContent = streamContent;
      // 有意不派生 traceText：跨边界可回读的只有结构化 trace（思考通道隔离 §3.7 D4）。
      // 展示用纯文本由展示层从 trace 现场格式化，不在这一层再拼一份「思考纯文本」。
    }
    this._emitEvent({
      type: 'task.progress',
      requestId,
      sessionId: payload.sessionId || entry?.sessionId || null,
      trace,
      streamContent: entry?.streamContent || streamContent || ''
    });
  }

  completeTask(payload = {}) {
    const requestId = String(payload.requestId || '');
    const entry = this.activeRequests.get(requestId);
    if (entry) {
      entry.status = payload.status || 'completed';
      if (Array.isArray(payload.trace)) {
        entry.trace = payload.trace;
      }
      if (payload.runId) entry.runId = payload.runId;
    }
    this._emitEvent({
      type: payload.status === 'failed' ? 'task.failed' : payload.status === 'stopped' ? 'task.stopped' : 'task.completed',
      requestId,
      sessionId: payload.sessionId || entry?.sessionId || null,
      runId: payload.runId || null,
      summary: payload.summary || '',
      error: payload.error || '',
      trace: Array.isArray(payload.trace) ? payload.trace : entry?.trace || []
    });
    this.activeRequests.delete(requestId);
  }

  async transcribeSpeech(params = {}) {
    const audioBase64 = String(params.audioBase64 || '').trim();
    if (!audioBase64) {
      const e = new Error('audioBase64 必填');
      e.code = 'MISSING_AUDIO';
      throw e;
    }
    const settings = this.userDataPath ? loadModelSettings(this.userDataPath) : {};
    const cfg = resolveSpeechApiConfig(settings);
    const baseUrl = String(params.baseUrl || cfg.baseUrl).trim();
    const apiKey = String(params.apiKey || cfg.apiKey).trim();
    if (!baseUrl) {
      const e = new Error('未配置 API Base URL（请在电脑端模型设置中填写）');
      e.code = 'MISSING_BASE_URL';
      throw e;
    }
    return this._rpc('speech.transcribe', {
      audioBase64,
      mimeType: params.mimeType,
      filename: params.filename,
      baseUrl,
      apiKey,
      model: String(params.model || cfg.model).trim() || 'whisper-1',
      language: params.language != null ? String(params.language).trim() : cfg.language
    });
  }

  stopTask(input = {}) {
    const requestId = input.requestId ? String(input.requestId) : '';
    const sessionId = input.sessionId ? String(input.sessionId) : '';
    const entry = requestId
      ? this.activeRequests.get(requestId)
      : [...this.activeRequests.values()].find((r) => r.sessionId === sessionId);
    if (!entry) return { ok: false, error: '任务未运行' };
    if (!this.canceller) return { ok: false, error: '任务执行器未连接' };
    this.canceller({
      requestId: entry.requestId,
      sessionId: entry.sessionId,
      reason: input.reason || '手机端停止'
    });
    entry.status = 'stopping';
    this._emitEvent({
      type: 'task.stopping',
      requestId: entry.requestId,
      sessionId: entry.sessionId
    });
    return { ok: true };
  }
}

module.exports = { AgentService };
