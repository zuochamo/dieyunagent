'use strict';

/**
 * 「语音」（转写）档位的连接测试：`probeTranscription`。
 *
 * 背景：设置页以前对 speech 档位只弹一句「请自己点麦克风实测」，用户根本没法确认
 * 配置对不对（实际踩的坑就是端点指到了没有 /v1/audio/transcriptions 的合成服务上）。
 * 现在用一段静音 WAV 走真实转写请求，能把三类失败分开：404（不是转写服务）、
 * 422（参数形态不对）、401（鉴权），成功时也可能是「200 + 空文本」。
 */
const { probeTranscription, buildSilentWav, transcribeWhisper } = require('../../src/gateway/speech-transcribe');

/** 只在测试里用的 fetch 替身：记录请求，回放响应。 */
function installFetch(handler) {
  const calls = [];
  const original = global.fetch;
  global.fetch = async (url, opts) => {
    calls.push({ url: String(url), opts });
    return handler(String(url), opts);
  };
  return {
    calls,
    restore() {
      global.fetch = original;
    }
  };
}

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return typeof body === 'string' ? body : JSON.stringify(body);
    }
  };
}

describe('buildSilentWav', () => {
  it('生成合法 WAV 头（PCM / 16k / 单声道 / 16bit）', () => {
    const buf = buildSilentWav(300, 16000);
    expect(buf.length).toBe(44 + 16000 * 0.3 * 2);
    expect(buf.subarray(0, 4).toString('ascii')).toBe('RIFF');
    expect(buf.subarray(8, 12).toString('ascii')).toBe('WAVE');
    expect(buf.readUInt16LE(20)).toBe(1); // PCM
    expect(buf.readUInt16LE(22)).toBe(1); // 单声道
    expect(buf.readUInt32LE(24)).toBe(16000);
    expect(buf.readUInt16LE(34)).toBe(16);
    expect(buf.readUInt32LE(40)).toBe(buf.length - 44);
    expect(buf.subarray(44).every((b) => b === 0)).toBe(true); // 静音
  });
});

describe('probeTranscription', () => {
  const cfg = { baseUrl: 'http://h:8000/v1', apiKey: 'not-needed', model: 'whisper-1', language: 'zh' };

  it('200 + 有文本：直接把这句带回来（真跑通了模型）', async () => {
    const f = installFetch(() => jsonResponse(200, { text: '今天天气不错' }));
    try {
      const res = await probeTranscription(cfg);
      expect(res).toEqual({ ok: true, text: '今天天气不错', silent: false });
      expect(f.calls[0].url).toBe('http://h:8000/v1/audio/transcriptions');
    } finally {
      f.restore();
    }
  });

  it('200 + 空文本 = 成功（静音没内容可转写）', async () => {
    const f = installFetch(() => jsonResponse(200, { text: '' }));
    try {
      expect(await probeTranscription(cfg)).toEqual({ ok: true, text: '', silent: true });
    } finally {
      f.restore();
    }
  });

  it('404 翻成「这个地址没有转写端点」，而不是丢一句 HTTP 404', async () => {
    const f = installFetch(() => jsonResponse(404, { detail: 'Not Found' }));
    try {
      await expect(probeTranscription(cfg)).rejects.toThrow(/没有 \/v1\/audio\/transcriptions/);
    } finally {
      f.restore();
    }
  });

  it('422 带上服务端的原始说明（参数形态不对时能直接看出缺什么）', async () => {
    const f = installFetch(() =>
      jsonResponse(422, { detail: [{ loc: ['body', 'file'], msg: 'Field required' }] })
    );
    try {
      await expect(probeTranscription(cfg)).rejects.toThrow(/422|Field required/);
    } finally {
      f.restore();
    }
  });

  it('请求形态与麦克风真实路径一致：multipart + file/model/language 字段', async () => {
    const f = installFetch(() => jsonResponse(200, { text: '' }));
    try {
      await probeTranscription(cfg);
      const form = f.calls[0].opts.body;
      expect(form instanceof FormData).toBe(true);
      expect(form.get('model')).toBe('whisper-1');
      expect(form.get('language')).toBe('zh');
      const file = form.get('file');
      expect(file.name).toBe('probe.wav');
      expect(file.type).toBe('audio/wav');
    } finally {
      f.restore();
    }
  });

  it('真路径与探针共用同一套端点拼接（避免「测试通过、麦克风 404」）', async () => {
    const f = installFetch(() => jsonResponse(200, { text: 'ok' }));
    try {
      await transcribeWhisper({
        ...cfg,
        audioBuffer: Buffer.from('x'),
        filename: 'speech.webm',
        mimeType: 'audio/webm'
      });
      const realUrl = f.calls[0].url;
      await probeTranscription(cfg);
      expect(f.calls[1].url).toBe(realUrl);
    } finally {
      f.restore();
    }
  });
});
