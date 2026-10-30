'use strict';

const {
  buildTtsBody,
  parseTtsAudio,
  normalizeTtsText,
  normalizeTtsFormat,
  audioMimeType,
  sniffAudioFormat,
  synthesizeSpeech,
  MAX_TTS_CHARS,
  DEFAULT_TTS_FORMAT
} = require('../../src/gateway/speech-synthesize');
const { ttsCache } = require('../../src/gateway/tts-cache');

// 合成结果有进程内 LRU：每个用例都要从干净状态开始，否则「同样的文本」会串场
beforeEach(() => ttsCache.clear());

/** 1x1 的假 wav / mp3 头，只用来验格式嗅探 */
const WAV_HEAD = Buffer.from('RIFF\x24\x00\x00\x00WAVEfmt ', 'latin1');
const MP3_HEAD = Buffer.from([0xff, 0xfb, 0x90, 0x00]);

describe('buildTtsBody', () => {
  it('用 assistant 角色承载要合成的文本（TTS 模型的硬要求）', () => {
    const body = buildTtsBody({ model: 'mimo-v2.5-tts', text: '你好' });
    expect(body.model).toBe('mimo-v2.5-tts');
    expect(body.messages).toEqual([{ role: 'assistant', content: '你好' }]);
    expect(body.modalities).toEqual(['text', 'audio']);
    expect(body.audio.format).toBe(DEFAULT_TTS_FORMAT);
  });

  it('音色留空时整键不写（各服务端音色名不通用，硬塞 alloy 会 400）', () => {
    const body = buildTtsBody({ model: 'm', text: 'x', voice: '   ' });
    expect(body.audio).toEqual({ format: 'mp3' });
    const withVoice = buildTtsBody({ model: 'm', text: 'x', voice: ' mimo_default ' });
    expect(withVoice.audio.voice).toBe('mimo_default');
  });

  it('未知格式回落到默认值', () => {
    expect(buildTtsBody({ model: 'm', text: 'x', format: 'ogg-flac' }).audio.format).toBe(
      DEFAULT_TTS_FORMAT
    );
    expect(normalizeTtsFormat('WAV')).toBe('wav');
  });
});

describe('normalizeTtsText', () => {
  it('短文本原样保留', () => {
    expect(normalizeTtsText('  你好\r\n世界  ')).toEqual({ text: '你好\n世界', truncated: false });
  });

  it('超长文本截断在句末，并显式标记 truncated（不静默截断）', () => {
    const long = `${'啊'.repeat(MAX_TTS_CHARS - 2)}。${'后半段'.repeat(200)}`;
    const out = normalizeTtsText(long);
    expect(out.truncated).toBe(true);
    expect(out.text.length).toBeLessThanOrEqual(MAX_TTS_CHARS + 1);
    expect(out.text.endsWith('。')).toBe(true);
  });

  it('空文本得到空串（由调用方报错，不在本层抛）', () => {
    expect(normalizeTtsText(null)).toEqual({ text: '', truncated: false });
  });

  it('截断不切断代理对（emoji / 扩展区汉字）：孤立代理项会让服务端 400 或合成杂音', () => {
    // 让第 MAX_TTS_CHARS-1 位正好是 emoji 的高代理
    const long = `${'a'.repeat(MAX_TTS_CHARS - 1)}😀${'b'.repeat(50)}`;
    const out = normalizeTtsText(long);
    expect(out.truncated).toBe(true);
    // 结尾不能是孤立的高/低代理
    expect(/[\uD800-\uDBFF]$/.test(out.text)).toBe(false);
    expect(/[\uDC00-\uDFFF]/.test(out.text)).toBe(false);
    expect(out.text.length).toBe(MAX_TTS_CHARS - 1);
  });
});

describe('parseTtsAudio', () => {
  it('取 choices[0].message.audio.data', () => {
    const data = { choices: [{ message: { role: 'assistant', content: '', audio: { data: 'QUJD' } } }] };
    expect(parseTtsAudio(data)).toEqual({ audioBase64: 'QUJD', format: DEFAULT_TTS_FORMAT });
  });

  it('没有音频返回 null（调用方据此报「该模型不支持 chat 出音频」）', () => {
    expect(parseTtsAudio({ choices: [{ message: { content: 'ok' } }] })).toBeNull();
    expect(parseTtsAudio(null)).toBeNull();
  });
});

describe('格式与 MIME', () => {
  it('按魔数识别实际格式（服务端可能忽略请求里的 format）', () => {
    expect(sniffAudioFormat(WAV_HEAD)).toBe('wav');
    expect(sniffAudioFormat(MP3_HEAD)).toBe('mp3');
    expect(sniffAudioFormat(Buffer.from('OggS....', 'latin1'))).toBe('opus');
    expect(sniffAudioFormat(Buffer.from('hello', 'latin1'))).toBe('');
  });

  it('格式 → MIME 唯一一份', () => {
    expect(audioMimeType('mp3')).toBe('audio/mpeg');
    expect(audioMimeType('wav')).toBe('audio/wav');
    expect(audioMimeType('')).toBe('audio/mpeg');
  });
});

describe('synthesizeSpeech', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('成功时把音频回成 base64 + mimeType，并按魔数纠正格式', async () => {
    const audio = Buffer.concat([WAV_HEAD, Buffer.from('data')]);
    let seenUrl = '';
    let seenBody = null;
    globalThis.fetch = async (url, init) => {
      seenUrl = url;
      seenBody = JSON.parse(init.body);
      return new Response(
        JSON.stringify({
          choices: [{ message: { role: 'assistant', content: '', audio: { data: audio.toString('base64') } } }]
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    };
    // 请求里写 mp3，服务端却回 wav → 以实际字节为准
    const res = await synthesizeSpeech({
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'k',
      model: 'tts-1',
      text: '你好',
      format: 'mp3'
    });
    expect(seenUrl).toBe('https://api.example.com/v1/chat/completions');
    expect(seenBody.messages[0].role).toBe('assistant');
    expect(res.format).toBe('wav');
    expect(res.mimeType).toBe('audio/wav');
    expect(Buffer.from(res.audioBase64, 'base64').equals(audio)).toBe(true);
  });

  it('同一段文本第二次合成直接命中缓存（不再等 20 秒、不再打上游）', async () => {
    const audio = MP3_HEAD;
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      return new Response(
        JSON.stringify({
          choices: [{ message: { role: 'assistant', content: '', audio: { data: audio.toString('base64') } } }]
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    };
    const opts = {
      baseUrl: 'https://api.example.com/v1',
      model: 'tts-1',
      text: '同一句话',
      voice: '茉莉',
      format: 'mp3'
    };
    const first = await synthesizeSpeech(opts);
    const second = await synthesizeSpeech({ ...opts });
    expect(calls).toBe(1);
    expect(first.cached).toBeUndefined();
    expect(second.cached).toBe(true);
    expect(second.audioBase64).toBe(first.audioBase64);
  });

  it('换音色不会命中旧缓存（否则会听到上一个音色）', async () => {
    const audio = MP3_HEAD;
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      return new Response(
        JSON.stringify({
          choices: [{ message: { role: 'assistant', content: '', audio: { data: audio.toString('base64') } } }]
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    };
    const base = { baseUrl: 'https://api.example.com/v1', model: 'tts-1', text: '同一句话' };
    await synthesizeSpeech({ ...base, voice: '茉莉' });
    await synthesizeSpeech({ ...base, voice: '苏打' });
    expect(calls).toBe(2);
  });

  it('上游报错时把服务端原话带出来（含 param 说明）', async () => {    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          error: { code: '400', message: 'Param Incorrect', param: 'messages must contain an assistant role' }
        }),
        { status: 400, headers: { 'content-type': 'application/json' } }
      );
    await expect(
      synthesizeSpeech({ baseUrl: 'https://api.example.com/v1', model: 'tts-1', text: '你好' })
    ).rejects.toThrow(/Param Incorrect.*assistant role/);
  });

  it('响应里没有音频 → TTS_NO_AUDIO', async () => {
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: 'hi' } }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    await expect(
      synthesizeSpeech({ baseUrl: 'https://api.example.com/v1', model: 'tts-1', text: '你好' })
    ).rejects.toMatchObject({ code: 'TTS_NO_AUDIO' });
  });

  it('缺模型 / 缺端点 / 空文本时给明确错误码，且不发请求', async () => {
    let called = false;
    globalThis.fetch = async () => {
      called = true;
      return new Response('{}', { status: 200 });
    };
    await expect(synthesizeSpeech({ baseUrl: 'https://x/v1', text: '你好' })).rejects.toMatchObject({
      code: 'MISSING_MODEL'
    });
    await expect(synthesizeSpeech({ model: 'tts-1', text: '你好' })).rejects.toMatchObject({
      code: 'MISSING_BASE_URL'
    });
    await expect(synthesizeSpeech({ baseUrl: 'https://x/v1', model: 'tts-1', text: '   ' })).rejects.toMatchObject({
      code: 'EMPTY_TEXT'
    });
    expect(called).toBe(false);
  });
});
