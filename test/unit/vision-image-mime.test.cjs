'use strict';

/**
 * 出站图片格式闸门（回归：HTTP 400 "unsupported image"）。
 *
 * 上游只接受 webp/png/jpeg/gif；bmp/svg/heic 或坏 base64 一旦以 image_url 出门，
 * 整轮请求都会被 400 打回（含历史消息里的旧图）。
 */

const {
  VISION_IMAGE_MIME,
  REJECTED_IMAGE_PLACEHOLDER,
  normalizeVisionImageMime,
  sniffVisionImageMime,
  sanitizeImageUrlForApi,
  sanitizeChatBodyImagesForApi,
  sanitizeChatRequestJsonForApi,
  isLlmImageRejectedError,
  parseRejectedImageMessageIndices,
  dropRejectedChatImagesForApi
} = require('../../src/agent/guardrails-shared');
const bv = require('../../src/agent/browser-vision');

const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]);
const gif = Buffer.from('GIF89a............', 'latin1');
const webp = (() => {
  const b = Buffer.alloc(16);
  b.write('RIFF', 0, 'latin1');
  b.write('WEBP', 8, 'latin1');
  return b;
})();
const bmp = Buffer.from([0x42, 0x4d, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);

const dataUrl = (mime, buf) => `data:${mime};base64,${buf.toString('base64')}`;

describe('上游支持的图片 MIME 白名单', () => {
  it('只放行 png/jpeg/gif/webp', () => {
    expect([...VISION_IMAGE_MIME].sort()).toEqual([
      'image/gif',
      'image/jpeg',
      'image/png',
      'image/webp'
    ]);
  });

  it('归一化大小写与 image/jpg 别名，拒绝其它格式', () => {
    expect(normalizeVisionImageMime('image/png')).toBe('image/png');
    expect(normalizeVisionImageMime('IMAGE/JPEG')).toBe('image/jpeg');
    expect(normalizeVisionImageMime('image/jpg')).toBe('image/jpeg');
    expect(normalizeVisionImageMime('image/bmp')).toBe('');
    expect(normalizeVisionImageMime('image/svg+xml')).toBe('');
    expect(normalizeVisionImageMime('')).toBe('');
  });
});

describe('sniffVisionImageMime（以字节为准）', () => {
  it('识别上游支持的四种格式', () => {
    expect(sniffVisionImageMime(png.toString('base64'))).toBe('image/png');
    expect(sniffVisionImageMime(jpeg.toString('base64'))).toBe('image/jpeg');
    expect(sniffVisionImageMime(gif.toString('base64'))).toBe('image/gif');
    expect(sniffVisionImageMime(webp.toString('base64'))).toBe('image/webp');
  });

  it('bmp / 文本 / 空串一律判不出', () => {
    expect(sniffVisionImageMime(bmp.toString('base64'))).toBe('');
    expect(sniffVisionImageMime(Buffer.from('hello, plain text').toString('base64'))).toBe('');
    expect(sniffVisionImageMime('')).toBe('');
  });
});

describe('sanitizeImageUrlForApi（出站最后一道闸）', () => {
  it('合法图片放行，并按实际字节修正声明错误的 mime', () => {
    expect(sanitizeImageUrlForApi(dataUrl('image/png', png))).toBe(dataUrl('image/png', png));
    // 声明 png、内容其实是 jpeg：上游按声明会拒，这里救回
    expect(sanitizeImageUrlForApi(dataUrl('image/png', jpeg))).toBe(dataUrl('image/jpeg', jpeg));
  });

  it('bmp/svg/坏 base64/空图直接拦掉（返回空串）', () => {
    expect(sanitizeImageUrlForApi(dataUrl('image/bmp', bmp))).toBe('');
    expect(sanitizeImageUrlForApi('data:image/svg+xml;base64,PHN2Zy8+')).toBe('');
    expect(sanitizeImageUrlForApi('data:image/png;base64,')).toBe('');
    expect(sanitizeImageUrlForApi('data:image/png;base64,%%%%')).toBe('');
    expect(sanitizeImageUrlForApi('')).toBe('');
  });

  it('远端 http 图原样放行（由上游自行抓取）', () => {
    expect(sanitizeImageUrlForApi('https://example.com/a.png')).toBe('https://example.com/a.png');
  });

  it('远端扩展名明显不受支持时提前拦掉', () => {
    expect(sanitizeImageUrlForApi('https://example.com/a.bmp')).toBe('');
    expect(sanitizeImageUrlForApi('https://example.com/a.svg?v=2')).toBe('');
    expect(sanitizeImageUrlForApi('https://example.com/a.heic')).toBe('');
    // 动态图片接口无扩展名，只能放行由上游判定
    expect(sanitizeImageUrlForApi('https://example.com/api/image?id=3')).toBe(
      'https://example.com/api/image?id=3'
    );
  });

  it('裸 base64 按魔数补 data: 前缀救回', () => {
    expect(sanitizeImageUrlForApi(png.toString('base64'))).toBe(dataUrl('image/png', png));
    expect(sanitizeImageUrlForApi(bmp.toString('base64'))).toBe('');
  });

  it('blob: / file: / 本地路径等上游取不到的引用一律拦掉', () => {
    expect(sanitizeImageUrlForApi('blob:http://localhost/abcd')).toBe('');
    expect(sanitizeImageUrlForApi('file:///C:/x.png')).toBe('');
    expect(sanitizeImageUrlForApi('C:\\tmp\\x.png')).toBe('');
  });
});

describe('sanitizeChatBodyImagesForApi（Main 出站 body 闸门）', () => {
  const img = (url) => ({ type: 'image_url', image_url: { url } });

  it('剔除非法图并降级为文字说明，合法图原样保留', () => {
    const body = {
      messages: [
        { role: 'user', content: [{ type: 'text', text: '看图' }, img(dataUrl('image/bmp', bmp))] },
        { role: 'user', content: [img(dataUrl('image/png', png))] }
      ]
    };
    expect(sanitizeChatBodyImagesForApi(body)).toBe(true);
    expect(body.messages[0].content.map((p) => p.type)).toEqual(['text', 'text']);
    expect(body.messages[1].content[0]).toEqual(img(dataUrl('image/png', png)));
  });

  it('按实际字节修正声明错误的 mime', () => {
    const body = { messages: [{ role: 'user', content: [img(dataUrl('image/png', jpeg))] }] };
    expect(sanitizeChatBodyImagesForApi(body)).toBe(true);
    expect(body.messages[0].content[0]).toEqual(img(dataUrl('image/jpeg', jpeg)));
  });

  it('没有图片 part 或无可改动时返回 false，不改动原文', () => {
    const body = { messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] };
    expect(sanitizeChatBodyImagesForApi(body)).toBe(false);
    const okBody = { messages: [{ role: 'user', content: [img(dataUrl('image/png', png))] }] };
    expect(sanitizeChatBodyImagesForApi(okBody)).toBe(false);
  });

  it('Anthropic 风格 image（source）非法时降级为文字，合法时原样保留', () => {
    const badPart = {
      type: 'image',
      source: { type: 'base64', media_type: 'image/bmp', data: bmp.toString('base64') }
    };
    const bad = { messages: [{ role: 'user', content: [badPart] }] };
    expect(sanitizeChatBodyImagesForApi(bad)).toBe(true);
    expect(bad.messages[0].content[0].type).toBe('text');

    const goodPart = {
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: png.toString('base64') }
    };
    const good = { messages: [{ role: 'user', content: [goodPart] }] };
    expect(sanitizeChatBodyImagesForApi(good)).toBe(false);
    expect(good.messages[0].content[0]).toBe(goodPart);
  });
});

describe('sanitizeChatRequestJsonForApi（llm-proxy 字符串闸门）', () => {
  it('含图片 part 时解析清洗后重新序列化', () => {
    const raw = JSON.stringify({
      model: 'm',
      messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: dataUrl('image/bmp', bmp) } }] }]
    });
    const out = sanitizeChatRequestJsonForApi(raw);
    expect(out).not.toBe(raw);
    expect(JSON.parse(out).messages[0].content[0].type).toBe('text');
  });

  it('Anthropic 风格 image part 也能被识别并清洗', () => {
    const raw = JSON.stringify({
      model: 'm',
      messages: [
        { role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/heic', data: 'AAAA' } }] }
      ]
    });
    const parsed = JSON.parse(sanitizeChatRequestJsonForApi(raw));
    expect(parsed.messages[0].content[0].type).toBe('text');
  });

  it('不含图片 part 时原样返回（同一字符串引用，避免无谓 parse/stringify）', () => {
    const raw = JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'hi' }] });
    expect(sanitizeChatRequestJsonForApi(raw)).toBe(raw);
    expect(sanitizeChatRequestJsonForApi('')).toBe('');
    expect(sanitizeChatRequestJsonForApi('not json {"image_url":1}')).toBe('not json {"image_url":1}');
  });
});

describe('上游「unsupported image」400 的识别与修复', () => {
  const img = (url) => ({ type: 'image_url', image_url: { url } });
  const goodImg = () => img(dataUrl('image/png', png));
  /** 复刻真实中转文案：.messages[N].image[0] + unsupported image */
  const providerError = (idx) => {
    const err = new Error(
      `HTTP 400 {"error":{"code":"invalid_request_error","message":"Error from provider (Console Go): ` +
        `Upstream request failed: [invalid_request_error] .messages[${idx}].image[0]: You have uploaded an ` +
        `unsupported image. Please make sure your image is valid and has one of the following formats: ` +
        `webp, png, jpeg, and gif.","param":null,"type":"invalid_request_error"}}`
    );
    err.statusCode = 400;
    return err;
  };

  it('识别「图片不合规」的 400，不误伤其它 4xx', () => {
    expect(isLlmImageRejectedError(providerError(27))).toBe(true);
    expect(isLlmImageRejectedError(new Error('HTTP 400 invalid api key'))).toBe(false);
    expect(isLlmImageRejectedError(new Error('HTTP 429 unsupported image'))).toBe(false);
    expect(isLlmImageRejectedError(new Error('HTTP 400 unsupported media type'))).toBe(true);
    expect(isLlmImageRejectedError(null)).toBe(false);
  });

  it('解析被拒下标：方括号与点号写法都认，解析不到返回空数组', () => {
    expect(parseRejectedImageMessageIndices(providerError(27).message)).toEqual([27]);
    expect(parseRejectedImageMessageIndices('.messages[3].content[1]: invalid image')).toEqual([3]);
    expect(parseRejectedImageMessageIndices('messages.5.image[0] unsupported image')).toEqual([5]);
    expect(parseRejectedImageMessageIndices('You have uploaded an unsupported image')).toEqual([]);
  });

  it('按定位丢图：只丢指定消息，并降级为文字说明', () => {
    const body = {
      messages: [
        { role: 'user', content: [{ type: 'text', text: '看图' }, goodImg()] },
        { role: 'user', content: [goodImg()] }
      ]
    };
    expect(dropRejectedChatImagesForApi(body, { messageIndices: [1] }).dropped).toBe(1);
    expect(body.messages[0].content[1].type).toBe('image_url');
    expect(body.messages[1].content[0]).toEqual({
      type: 'text',
      text: REJECTED_IMAGE_PLACEHOLDER
    });
  });

  it('不给定位（或丢了整轮）时丢光全部图片', () => {
    const body = {
      messages: [
        { role: 'user', content: [goodImg(), goodImg()] },
        { role: 'tool', content: [{ type: 'text', text: 'ok' }, goodImg()] }
      ]
    };
    expect(dropRejectedChatImagesForApi(body).dropped).toBe(3);
    expect(JSON.stringify(body)).not.toContain('image_url');
    expect(dropRejectedChatImagesForApi(body, { messageIndices: [] }).dropped).toBe(0);
    expect(dropRejectedChatImagesForApi(null).dropped).toBe(0);
  });
});

describe('browser-vision 只入队上游支持的格式', () => {
  it('bmp 声明直接拒绝，未声明 mime 按 png 处理', () => {
    expect(
      bv.recordVisionImage('run-mime', {
        source: 'attachment',
        mime: 'image/bmp',
        base64: bmp.toString('base64'),
        path: 'x.bmp'
      })
    ).toBe(false);
    expect(
      bv.recordVisionImage('run-mime', {
        source: 'attachment',
        mime: 'IMAGE/JPEG',
        base64: 'AAAA',
        path: 'y.jpg'
      })
    ).toBe(true);
    expect(
      bv.recordVisionImage('run-mime', { source: 'browser', base64: 'BBBB', tool: 'browser_screenshot' })
    ).toBe(true);

    const queued = bv.takePendingVisionImages('run-mime');
    expect(queued.map((it) => it.mime)).toEqual(['image/jpeg', 'image/png']);
  });
});
