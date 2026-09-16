'use strict';

const { agentRunEventFromServicePayload } = require('./run-events');

const { EventEmitter } = require('events');
const { dieyunDefaultWorkspaceDir } = require('../agent-home');
const { loadModelSettings, resolveSpeechApiConfig } = require('../model-settings');

function normalizeLimit(value, fallback, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(1, Math.floor(n)));
}

function eventPreview(text, max = 120) {
  return String(text || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

class AgentService extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.gateway = opts.gateway || null;
    this.userDataPath = opts.userDataPath || null;
    this.log = typeof opts.log === 'function' ? opts.log : () => {};
    this.desktopExecutor = null;
    this.desktopCanceller = null;
    this.activeRequests = new Map();
  }

  setGateway(gateway) {
    this.gateway = gateway || null;
  }

  setDesktopExecutor(fn) {
    this.desktopExecutor = typeof fn === 'function' ? fn : null;
  }

  setDesktopCanceller(fn) {
    this.desktopCanceller = typeof fn === 'function' ? fn : null;
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
    return {
      model: cfg.model || 'whisper-1',
      language: cfg.language || 'zh'
    };
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
          traceText: active.traceText || '',
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
          traceText: active.traceText || '',
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

  async submitTask(input = {}) {
    const text = String(input.text || '').trim();
    if (!text) {
      const e = new Error('任务内容不能为空');
      e.code = 'INVALID_TEXT';
      throw e;
    }
    if (!this.desktopExecutor) {
      const e = new Error('桌面执行器未连接');
      e.code = 'DESKTOP_EXECUTOR_UNAVAILABLE';
      throw e;
    }

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
    } else {
      const created = await this._rpc('memory.session_create', {
        title: input.title || null,
        workspacePath: null
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
    this.desktopExecutor(task);
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
      entry.traceText = trace
        .map((row) => String(row.fullThought || row.thought || '').trim())
        .filter(Boolean)
        .join('\n');
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
        entry.traceText = payload.trace
          .map((row) => String(row.fullThought || row.thought || '').trim())
          .filter(Boolean)
          .join('\n');
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
    if (!this.desktopCanceller) return { ok: false, error: '桌面取消器未连接' };
    this.desktopCanceller({
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
