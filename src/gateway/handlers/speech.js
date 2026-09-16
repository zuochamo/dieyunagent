'use strict';

const { transcribeWhisper, MAX_AUDIO_BYTES } = require('../speech-transcribe');

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
    }
  };
}

module.exports = { createSpeechHandlers };
