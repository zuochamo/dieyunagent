'use strict';

const { buildLlmHeaders, resolveLlmEndpoint } = require('../agent/llm-request');

const MAX_AUDIO_BYTES = 15 * 1024 * 1024;
const TRANSCRIBE_TIMEOUT_MS = 120000;

function resolveTranscriptionUrl(baseUrl) {
  // 端点拼接单一来源 llm-request.js；此处只保留「必填」语义
  const url = resolveLlmEndpoint(baseUrl, 'transcriptions');
  if (!url) {
    const e = new Error('未配置 API Base URL（请在模型设置中填写供应商地址）');
    e.code = 'MISSING_BASE_URL';
    throw e;
  }
  return url;
}

function parseTranscriptionResponse(data) {
  if (!data || typeof data !== 'object') return '';
  if (typeof data.text === 'string') return data.text.trim();
  if (data.data && typeof data.data.text === 'string') return data.data.text.trim();
  return '';
}

/**
 * OpenAI-compatible Whisper batch transcription.
 * @param {{ baseUrl: string, apiKey?: string, model?: string, language?: string, audioBuffer: Buffer, filename?: string, mimeType?: string }} opts
 */
async function transcribeWhisper(opts) {
  const audioBuffer = opts?.audioBuffer;
  if (!audioBuffer || !Buffer.isBuffer(audioBuffer) || !audioBuffer.length) {
    const e = new Error('音频为空');
    e.code = 'EMPTY_AUDIO';
    throw e;
  }
  if (audioBuffer.length > MAX_AUDIO_BYTES) {
    const e = new Error('录音过长，请缩短后重试');
    e.code = 'AUDIO_TOO_LARGE';
    throw e;
  }

  const url = resolveTranscriptionUrl(opts.baseUrl);
  const model = String(opts.model || 'whisper-1').trim() || 'whisper-1';
  const mimeType = String(opts.mimeType || 'audio/webm').trim() || 'audio/webm';
  const filename = String(opts.filename || 'speech.webm').trim() || 'speech.webm';

  const form = new FormData();
  form.append('file', new Blob([audioBuffer], { type: mimeType }), filename);
  form.append('model', model);
  const lang = String(opts.language || '').trim();
  if (lang) form.append('language', lang);

  // FormData 由 fetch 自带 multipart boundary：json:false 确保不设 Content-Type
  const apiKey = String(opts.apiKey || '').trim();
  const headers = buildLlmHeaders({
    apiKey,
    authMode: opts.authMode,
    headers: opts.headers,
    userAgent: opts.userAgent,
    json: false
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TRANSCRIBE_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(url, { method: 'POST', headers, body: form, signal: controller.signal });
  } catch (err) {
    if (err && err.name === 'AbortError') {
      const e = new Error('语音转写超时');
      e.code = 'TRANSCRIBE_TIMEOUT';
      throw e;
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }

  const raw = await res.text();
  let data = null;
  try {
    data = raw ? JSON.parse(raw) : null;
  } catch {
    data = null;
  }

  if (!res.ok) {
    const msg =
      (data && (data.error?.message || data.message)) ||
      raw.slice(0, 240) ||
      `HTTP ${res.status}`;
    const e = new Error(`Whisper 转写失败：${msg}`);
    e.code = 'TRANSCRIBE_HTTP';
    e.status = res.status;
    throw e;
  }

  const text = parseTranscriptionResponse(data);
  if (!text) {
    const e = new Error('转写结果为空');
    e.code = 'EMPTY_TRANSCRIPT';
    throw e;
  }

  return { ok: true, text, model, language: lang || null };
}

module.exports = {
  transcribeWhisper,
  resolveTranscriptionUrl,
  MAX_AUDIO_BYTES
};
