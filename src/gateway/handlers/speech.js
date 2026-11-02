'use strict';

const { transcribeWhisper, probeTranscription, MAX_AUDIO_BYTES } = require('../speech-transcribe');
const { synthesizeSpeech } = require('../speech-synthesize');

/**
 * @param {{}} _deps
 */
function createSpeechHandlers(_deps) {
  return {
    'speech.transcribe': async (params) => {
      const audioBase64 = String(params?.audioBase64 || '').trim();
      if (!audioBase64) {
        const e = new Error('audioBase64 必填');
        e.code = 'MISSING_AUDIO';
        throw e;
      }
      let audioBuffer;
      try {
        audioBuffer = Buffer.from(audioBase64, 'base64');
      } catch {
        const e = new Error('audioBase64 无效');
        e.code = 'INVALID_AUDIO';
        throw e;
      }
      if (!audioBuffer.length) {
        const e = new Error('音频为空');
        e.code = 'EMPTY_AUDIO';
        throw e;
      }
      if (audioBuffer.length > MAX_AUDIO_BYTES) {
        const e = new Error('录音文件过大');
        e.code = 'AUDIO_TOO_LARGE';
        throw e;
      }
      const baseUrl = String(params?.baseUrl || '').trim();
      const apiKey = String(params?.apiKey || '').trim();
      if (!baseUrl) {
        const e = new Error('未配置 API Base URL');
        e.code = 'MISSING_BASE_URL';
        throw e;
      }
      return transcribeWhisper({
        baseUrl,
        apiKey,
        model: params?.model,
        language: params?.language,
        audioBuffer,
        filename: params?.filename,
        mimeType: params?.mimeType
      });
    },

    /**
     * 「语音」（转写）档位的连接测试：静音样片走真实转写请求。
     * 参数与 speech.transcribe 同形，只是不带 audioBase64 —— 音频由本层生成，
     * 这样测试不需要麦克风、也不需要用户先说话。
     */
    'speech.transcribe_probe': async (params) => {
      const baseUrl = String(params?.baseUrl || '').trim();
      if (!baseUrl) {
        const e = new Error('未配置 API Base URL');
        e.code = 'MISSING_BASE_URL';
        throw e;
      }
      return probeTranscription({
        baseUrl,
        apiKey: params?.apiKey,
        model: params?.model,
        language: params?.language,
        authMode: params?.authMode,
        headers: params?.headers,
        userAgent: params?.userAgent
      });
    },

    /**
     * 文本 → 音频。参数由 Renderer 按「当前设置里 kind=tts 的模型」传入
     * （与 speech.transcribe 同一套：调用方给配置，本层只做请求）。
     * 请求修饰字段（headers / userAgent / authMode）一并透传 —— 否则
     * 设置页「测试」与真实朗读会因头不同而一个通一个 400。
     */
    'speech.synthesize': async (params) => {
      const text = String(params?.text || '');
      const baseUrl = String(params?.baseUrl || '').trim();
      if (!baseUrl) {
        const e = new Error('未配置 API Base URL');
        e.code = 'MISSING_BASE_URL';
        throw e;
      }
      return synthesizeSpeech({
        baseUrl,
        apiKey: params?.apiKey,
        model: params?.model,
        text,
        voice: params?.voice,
        format: params?.format,
        authMode: params?.authMode,
        headers: params?.headers,
        userAgent: params?.userAgent,
        vars: { sessionId: params?.sessionId, model: params?.model }
      });
    }
  };
}

module.exports = { createSpeechHandlers };
