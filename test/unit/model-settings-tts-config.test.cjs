'use strict';

/**
 * Main 侧「朗读模型」解析（`resolveTtsApiConfig`）。
 *
 * 这条链路只有手机端 / 无 Renderer 的调用方走，所以特别容易「设置了却没生效」：
 * 手机只发文本，模型 / 端点 / 密钥都在这里解析，判据必须与
 * Renderer 的 `ModelCapabilities.pickTtsModel` 一致，否则会出现
 * 「电脑上能朗读、手机上提示没有模型」。
 */
const { resolveTtsApiConfig } = require('../../src/model-settings');

describe('resolveTtsApiConfig', () => {
  it('自定义模型 kind=tts：带出端点/密钥/音色/格式与请求修饰字段', () => {
    const cfg = resolveTtsApiConfig({
      customModels: [
        { id: 'm1', name: 'mimo-v2.5-tts', kind: 'tts', baseUrl: 'http://h:5018/v1 ', apiKey: 'k', voice: '茉莉', format: 'mp3', headers: { 'x-app': 'dieyun' } }
      ]
    });
    expect(cfg).toEqual({
      baseUrl: 'http://h:5018/v1',
      apiKey: 'k',
      model: 'mimo-v2.5-tts',
      voice: '茉莉',
      format: 'mp3',
      headers: { 'x-app': 'dieyun' }
    });
  });

  it('跳过转写模型：两种能力是独立槽位（那台服务器有 tts 没有转写）', () => {
    const cfg = resolveTtsApiConfig({
      customModels: [
        { name: 'whisper-1', kind: 'speech', baseUrl: 'http://h/v1', apiKey: 'k' },
        { name: 'tts-1', kind: 'tts', baseUrl: 'http://h/v1', apiKey: 'k' }
      ]
    });
    expect(cfg.model).toBe('tts-1');
  });

  it('供应商模型：modelModalities 声明为 tts 且已启用才认', () => {
    const cfg = resolveTtsApiConfig({
      modelSuppliers: [
        {
          id: 's1',
          baseUrl: 'http://sup/v1',
          apiKey: 'sk',
          enabledModels: { 'chat-model': true, 'tts-model': true },
          modelModalities: { 'chat-model': 'text', 'tts-model': 'tts' }
        }
      ]
    });
    expect(cfg).toMatchObject({ baseUrl: 'http://sup/v1', apiKey: 'sk', model: 'tts-model', voice: '', format: '' });
  });

  it('供应商的 tts 模型被关掉时不认（不静默用别的模型顶替）', () => {
    const cfg = resolveTtsApiConfig({
      modelSuppliers: [
        {
          id: 's1',
          baseUrl: 'http://sup/v1',
          apiKey: 'sk',
          enabledModels: { 'tts-model': false },
          modelModalities: { 'tts-model': 'tts' }
        }
      ]
    });
    expect(cfg).toBeNull();
  });

  it('没配朗读模型 → null（调用方据此明确报错，不猜、不兜底到转写模型）', () => {
    expect(resolveTtsApiConfig({})).toBeNull();
    expect(resolveTtsApiConfig({ speechWhisperModel: 'whisper-1' })).toBeNull();
    expect(resolveTtsApiConfig(null)).toBeNull();
  });

  it('自定义 tts 模型没填 baseUrl → null（缺端点等于不可用）', () => {
    expect(
      resolveTtsApiConfig({ customModels: [{ name: 'tts-1', kind: 'tts', baseUrl: '  ', apiKey: 'k' }] })
    ).toBeNull();
  });
});
