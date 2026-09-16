'use strict';

const { resolveSpeechApiConfig } = require('../src/model-settings');

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assert failed');
}

const cfg = resolveSpeechApiConfig({
  modelSuppliers: [{ baseUrl: 'https://proxy/v1', apiKey: 'sk-test' }],
  speechWhisperModel: 'whisper-1',
  speechLanguage: 'zh'
});
assert(cfg.baseUrl === 'https://proxy/v1', 'supplier baseUrl');
assert(cfg.apiKey === 'sk-test', 'supplier apiKey');
assert(cfg.model === 'whisper-1', 'whisper model');
assert(cfg.language === 'zh', 'language');

const legacy = resolveSpeechApiConfig({
  builtinBaseUrl: 'https://legacy/v1',
  builtinApiKey: 'legacy-key'
});
assert(legacy.baseUrl === 'https://legacy/v1', 'legacy baseUrl');
assert(legacy.apiKey === 'legacy-key', 'legacy apiKey');

console.log('ok speech-config unit tests');
