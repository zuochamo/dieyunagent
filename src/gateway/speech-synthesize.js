'use strict';

const { buildLlmHeaders, resolveLlmEndpoint } = require('../agent/llm-request');
const { ttsCache, ttsCacheKey } = require('./tts-cache');

/**
 * 语音合成（TTS）出站请求的**单一来源**：请求体形状 + 响应取音频 + 格式→MIME。
 *
 * 为什么不用 `/v1/audio/speech`：OpenAI 系的自带 TTS 模型（`*-tts`，含本地 vLLM /
 * MiMo 这类网关）实际可用的是「chat 出音频」这条路 —— `POST /v1/chat/completions`，
 * `messages` 里必须有 **assistant** 角色（它的 content 就是要合成的文本），
 * 音频回在 `choices[0].message.audio.data`（base64）。实测：
 *   - `/v1/audio/speech` → 404（很多自建网关根本没有这个端点）
 *   - `messages:[{role:'user'}]` → 400 `messages must contain an assistant role for TTS model`
 *   - `messages:[{role:'assistant'}]` → 200，`message.audio.data` 是音频
 *
 * 职责边界（与 speech-transcribe.js 对称，勿混）：
 *   - 本模块 = 「给文本，产出音频字节」；
 *   - 「用哪家 / 哪个模型」是设置（`kind: 'tts'` 的自定义模型 / 供应商 `modelModalities`）；
 *   - 「端点与请求头」唯一来源是 agent/llm-request.js。
 */

/** 单次朗读的文本上限：超了会合成出几分钟音频、也让 UI 长时间空转。 */
const MAX_TTS_CHARS = 1200;
/**
 * HTTP 超时。必须**小于** Renderer 的 `speech.synthesize` RPC 超时（180s）：
 * 反过来的话网关先放弃、渲染端还要多等一截才拿到同一个失败。
 * 合成耗时随文本长度增长（实测 400 字约 20s，700 字可到 90s）。
 */
const TTS_TIMEOUT_MS = 170000;
const DEFAULT_TTS_FORMAT = 'mp3';

/**
 * 合成格式 → MIME。**唯一一份**：Renderer 只按返回的 mimeType 造 Blob，
 * 不再自己维护一张格式表。
 */
const AUDIO_MIME_BY_FORMAT = {
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  opus: 'audio/ogg',
  aac: 'audio/aac',
  flac: 'audio/flac',
  pcm: 'audio/wave'
};

function normalizeTtsFormat(format) {
  const f = String(format == null ? '' : format).trim().toLowerCase();
  return AUDIO_MIME_BY_FORMAT[f] ? f : DEFAULT_TTS_FORMAT;
}

function audioMimeType(format) {
  return AUDIO_MIME_BY_FORMAT[normalizeTtsFormat(format)] || AUDIO_MIME_BY_FORMAT[DEFAULT_TTS_FORMAT];
}

/**
 * 按 UTF-16 长度安全截断：不把代理对（emoji、扩展区汉字）切成半个字符。
 * 切一半的后果不是显示乱码 —— 是请求体里出现孤立代理项，服务端要么 400，要么合成出一声杂音。
 *
 * @param {string} str
 * @param {number} max
 * @returns {string}
 */
function sliceByCodeUnitSafe(str, max) {
  if (str.length <= max) return str;
  let end = max;
  const last = str.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1; // 结尾落在高代理 → 退一格
  return str.slice(0, end);
}

/**
 * 朗读文本归一化 + 截断。
 *
 * 截断优先停在句末，避免把一句话切成半个字（听感上像卡带）。
 * `truncated` 由调用方回给 UI 提示，**不静默**截断。
 *
 * @param {string} text
 * @returns {{ text: string, truncated: boolean }}
 */
function normalizeTtsText(text) {
  const raw = String(text == null ? '' : text)
    .replace(/\r\n?/g, '\n')
    .trim();
  if (raw.length <= MAX_TTS_CHARS) return { text: raw, truncated: false };
  const head = sliceByCodeUnitSafe(raw, MAX_TTS_CHARS);
  const candidates = ['。', '！', '？', '.', '!', '?', '\n']
    .map((mark) => head.lastIndexOf(mark))
    .filter((idx) => idx >= 0);
  const cut = candidates.length ? Math.max(...candidates) : -1;
  const body = cut > MAX_TTS_CHARS * 0.5 ? head.slice(0, cut + 1) : head;
  return { text: body.trim(), truncated: true };
}

/**
 * 请求体：**只有这一份**（Renderer 的「测试」按钮走同一个 handler，不再手抄一份 body）。
 *
 * - `messages` 用 assistant 角色（TTS 模型的要求，见文件头）；
 * - `modalities` / `audio.format` 是 OpenAI 兼容的「chat 出音频」标准开关；
 * - `audio.voice` 留空则整键不写 —— 各家默认音色不同，硬塞 `alloy` 会让
 *   只认自家音色名的服务端直接 400（实测这家就是）。
 *
 * @param {{ model: string, text: string, voice?: string, format?: string }} spec
 * @returns {object}
 */
function buildTtsBody(spec) {
  const opts = spec && typeof spec === 'object' ? spec : {};
  const body = {
    model: String(opts.model == null ? '' : opts.model).trim(),
    messages: [{ role: 'assistant', content: String(opts.text == null ? '' : opts.text) }],
    modalities: ['text', 'audio'],
    audio: { format: normalizeTtsFormat(opts.format) }
  };
  const voice = String(opts.voice == null ? '' : opts.voice).trim();
  if (voice) body.audio.voice = voice;
  return body;
}

/** 音频魔数嗅探：服务端不认 `format` 却按默认格式回包时，别把 wav 当 mp3 播。 */
function sniffAudioFormat(buffer) {
  if (!buffer || !buffer.length) return '';
  const b = buffer;
  if (b.length >= 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WAVE') {
    return 'wav';
  }
  if (b.length >= 4 && b.toString('latin1', 0, 4) === 'OggS') return 'opus';
  if (b.length >= 4 && b.toString('latin1', 0, 4) === 'fLaC') return 'flac';
  if (b.length >= 3 && b.toString('latin1', 0, 3) === 'ID3') return 'mp3';
  if (b.length >= 2 && b[0] === 0xff && (b[1] & 0xe0) === 0xe0) return 'mp3';
  return '';
}

/**
 * 从 chat.completion 响应里取音频。
 * @param {any} data
 * @returns {{ audioBase64: string, format: string } | null}
 */
function parseTtsAudio(data) {
  const message = data && Array.isArray(data.choices) ? data.choices[0]?.message : null;
  const audio = message && typeof message === 'object' ? message.audio : null;
  const base64 = String(audio && audio.data ? audio.data : '').trim();
  if (!base64) return null;
  return { audioBase64: base64, format: normalizeTtsFormat(audio?.format) };
}

function ttsError(message, code, extra) {
  const e = new Error(message);
  e.code = code;
  if (extra && typeof extra === 'object') Object.assign(e, extra);
  return e;
}

/**
 * 文本 → 音频（OpenAI 兼容「chat 出音频」）。
 *
 * @param {{ baseUrl: string, apiKey?: string, model: string, text: string,
 *           voice?: string, format?: string, authMode?: string,
 *           headers?: object|string, userAgent?: string, vars?: Record<string, unknown> }} opts
 * @returns {Promise<{ ok: true, audioBase64: string, mimeType: string, format: string,
 *                     model: string, chars: number, truncated: boolean }>}
 */
async function synthesizeSpeech(opts) {
  const o = opts && typeof opts === 'object' ? opts : {};
  const { text, truncated } = normalizeTtsText(o.text);
  if (!text) throw ttsError('没有可朗读的文本', 'EMPTY_TEXT');

  const model = String(o.model == null ? '' : o.model).trim();
  if (!model) throw ttsError('未配置语音合成模型（在模型设置里添加一个「语音合成」类型的模型）', 'MISSING_MODEL');

  const url = resolveLlmEndpoint(o.baseUrl, 'chat');
  if (!url) throw ttsError('未配置 API Base URL（请在模型设置中填写接口地址）', 'MISSING_BASE_URL');

  const voice = String(o.voice == null ? '' : o.voice).trim();
  const format = normalizeTtsFormat(o.format);
  // 同一条文本再听一遍不该重新合成（实测 2~90 秒）。键必须带上影响声音的每一项。
  const cacheKey = ttsCacheKey({ baseUrl: o.baseUrl, model, voice, format, text });
  const cached = ttsCache.get(cacheKey);
  if (cached) return { ...cached, cached: true };

  const body = buildTtsBody({ model, text, voice: o.voice, format: o.format });
  const headers = buildLlmHeaders({
    apiKey: o.apiKey,
    authMode: o.authMode,
    headers: o.headers,
    userAgent: o.userAgent,
    vars: o.vars
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TTS_TIMEOUT_MS);
  let res;
  let raw = '';
  try {
    res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: controller.signal });
    raw = await res.text();
  } catch (err) {
    if (err && err.name === 'AbortError') throw ttsError('语音合成超时', 'TTS_TIMEOUT');
    throw err;
  } finally {
    clearTimeout(timer);
  }

  let data = null;
  try {
    data = raw ? JSON.parse(raw) : null;
  } catch {
    data = null;
  }

  if (!res.ok) {
    const msg =
      (data && (data.error?.message || data.message)) || raw.slice(0, 240) || `HTTP ${res.status}`;
    const param = data && data.error && data.error.param ? `（${data.error.param}）` : '';
    throw ttsError(`语音合成失败：${msg}${param}`, 'TTS_HTTP', { status: res.status });
  }

  const audio = parseTtsAudio(data);
  if (!audio) {
    throw ttsError(
      '语音合成返回里没有音频（该模型可能不支持 chat 出音频）',
      'TTS_NO_AUDIO'
    );
  }

  const buffer = Buffer.from(audio.audioBase64, 'base64');
  if (!buffer.length) throw ttsError('语音合成返回空音频', 'TTS_EMPTY_AUDIO');
  // 服务端实际回的格式优先（它可能忽略请求里的 format）
  const sniffed = sniffAudioFormat(buffer);
  const actualFormat = sniffed || audio.format;

  const result = {
    ok: true,
    audioBase64: buffer.toString('base64'),
    mimeType: audioMimeType(actualFormat),
    format: actualFormat,
    model,
    chars: text.length,
    truncated
  };
  ttsCache.set(cacheKey, result, buffer.length);
  return result;
}

module.exports = {
  synthesizeSpeech,
  buildTtsBody,
  parseTtsAudio,
  normalizeTtsText,
  normalizeTtsFormat,
  audioMimeType,
  sniffAudioFormat,
  MAX_TTS_CHARS,
  DEFAULT_TTS_FORMAT
};
