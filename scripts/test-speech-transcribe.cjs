'use strict';

const { resolveTranscriptionUrl } = require('../src/gateway/speech-transcribe');

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assert failed');
}

assert(
  resolveTranscriptionUrl('https://api.openai.com/v1') === 'https://api.openai.com/v1/audio/transcriptions',
  'openai v1 url'
);
assert(
  resolveTranscriptionUrl('https://proxy.example/v1/') === 'https://proxy.example/v1/audio/transcriptions',
  'trailing slash'
);
assert(
  resolveTranscriptionUrl('https://proxy.example/v2') === 'https://proxy.example/v2/audio/transcriptions',
  'v2 path'
);

console.log('ok speech-transcribe unit tests');
