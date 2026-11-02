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

/**
 * 0.3 秒静音 WAV（16 kHz / 单声道 / 16 bit）。
 *
 * 用途只有一个：设置页「测试」需要一段**不依赖麦克风**的音频去打通真实转写链路。
 * 静音转出来的文本是空的，但那正是「端点存在、认这个 multipart、跑完了模型」的证明。
 */
function buildSilentWav(ms = 300, sampleRate = 16000) {
  const samples = Math.max(1, Math.round((sampleRate * ms) / 1000));
  const dataBytes = samples * 2;
  const buf = Buffer.alloc(44 + dataBytes); // 静音 = 全 0，不用再写数据段
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16); // PCM 头长度
  buf.writeUInt16LE(1, 20); // format = PCM
  buf.writeUInt16LE(1, 22); // 单声道
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28); // byteRate
  buf.writeUInt16LE(2, 32); // blockAlign
  buf.writeUInt16LE(16, 34); // bitsPerSample
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataBytes, 40);
  return buf;
}

/** 把服务端 404 的原始报错翻成「这个地址没有转写端点」这种能动手的结论。 */
const NOT_A_TRANSCRIBER_404 = '这个地址没有 /v1/audio/transcriptions 转写端点（LM Studio / Ollama / llama.cpp 都不提供；需要 whisper 类服务）';

/**
 * 「语音」档位的连接测试。
 *
 * 为什么必须走真实转写而不是发个 HEAD：麦克风链路踩过的坑全在请求形态里
 * （端点路径、multipart 字段名、mime、language），只有真正寄一段音频过去才会暴露。
 * 静音样片让测试不依赖麦克风、也不需要用户说话。
 *
 * @returns {Promise<{ok: true, text: string, silent: boolean}>}
 */
async function probeTranscription(opts) {
  try {
    const res = await transcribeWhisper({
      ...opts,
      audioBuffer: buildSilentWav(),
      filename: 'probe.wav',
      mimeType: 'audio/wav'
    });
    return { ok: true, text: res.text, silent: false };
  } catch (err) {
    if (err && err.code === 'EMPTY_TRANSCRIPT') {
      // 静音没有内容可转写：端点通了，这就是成功
      return { ok: true, text: '', silent: true };
    }
    if (err && err.status === 404) {
      const e = new Error(NOT_A_TRANSCRIBER_404);
      e.code = 'NO_TRANSCRIBE_ENDPOINT';
      throw e;
    }
    throw err;
  }
}

module.exports = {
  transcribeWhisper,
  resolveTranscriptionUrl,
  probeTranscription,
  buildSilentWav,
  MAX_AUDIO_BYTES
};
