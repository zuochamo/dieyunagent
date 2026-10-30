'use strict';

/**
 * 合成结果的内存 LRU（`src/gateway/tts-cache.js`）。
 *
 * 守的语义：
 * 1. 命中要**续命**（LRU 而不是 FIFO：常用的那条不能被后来的挤掉）；
 * 2. 按字节封顶（一段 1200 字音频 ~3 MB，按条数封顶会让内存随文本长度失控）；
 * 3. 单条超过预算就不缓存（否则会把整个缓存挤空却什么都留不下）；
 * 4. 缓存键必须带音色 / 格式 / 服务端：换了音色还听到旧声音是最难查的 bug。
 */
const { createTtsCache, ttsCacheKey } = require('../../src/gateway/tts-cache');

describe('createTtsCache', () => {
  it('存进去能取出来，未命中返回 null 并计数', () => {
    const cache = createTtsCache({ maxBytes: 1000, maxEntries: 10 });
    cache.set('k', { v: 1 }, 100);
    expect(cache.get('k')).toEqual({ v: 1 });
    expect(cache.get('nope')).toBeNull();
    expect(cache.stats.hits).toBe(1);
    expect(cache.stats.misses).toBe(1);
  });

  it('命中会续命：淘汰的是最久没被用的那条（LRU 不是 FIFO）', () => {
    const cache = createTtsCache({ maxBytes: 300, maxEntries: 10 });
    cache.set('a', 'A', 100);
    cache.set('b', 'B', 100);
    cache.set('c', 'C', 100);
    cache.get('a'); // a 变成最新
    cache.set('d', 'D', 100); // 触发淘汰：应淘汰 b
    expect(cache.get('b')).toBeNull();
    expect(cache.get('a')).toBe('A');
    expect(cache.get('c')).toBe('C');
    expect(cache.get('d')).toBe('D');
    expect(cache.stats.evictions).toBe(1);
  });

  it('按字节封顶（不是按条数）', () => {
    const cache = createTtsCache({ maxBytes: 250, maxEntries: 100 });
    cache.set('big1', 'x', 200);
    cache.set('big2', 'y', 200); // 超预算 → 淘汰 big1
    expect(cache.bytes()).toBeLessThanOrEqual(250);
    expect(cache.get('big1')).toBeNull();
    expect(cache.get('big2')).toBe('y');
  });

  it('条数封顶也生效', () => {
    const cache = createTtsCache({ maxBytes: 10_000, maxEntries: 2 });
    cache.set('a', 'A', 1);
    cache.set('b', 'B', 1);
    cache.set('c', 'C', 1);
    expect(cache.size()).toBe(2);
    expect(cache.get('a')).toBeNull();
  });

  it('单条就超过总预算时不缓存（不挤空缓存却什么都不留）', () => {
    const cache = createTtsCache({ maxBytes: 100, maxEntries: 10 });
    cache.set('huge', 'H', 500);
    expect(cache.size()).toBe(0);
    expect(cache.get('huge')).toBeNull();
  });

  it('重复写同一个键不会重复计入字节', () => {
    const cache = createTtsCache({ maxBytes: 1000, maxEntries: 10 });
    cache.set('k', 'v1', 100);
    cache.set('k', 'v2', 300);
    expect(cache.bytes()).toBe(300);
    expect(cache.get('k')).toBe('v2');
  });

  it('clear 清空', () => {
    const cache = createTtsCache({ maxBytes: 1000, maxEntries: 10 });
    cache.set('k', 'v', 100);
    cache.clear();
    expect(cache.size()).toBe(0);
    expect(cache.bytes()).toBe(0);
  });
});

describe('ttsCacheKey', () => {
  const base = {
    baseUrl: 'http://host:5018/v1',
    model: 'mimo-v2.5-tts',
    voice: '茉莉',
    format: 'mp3',
    text: '你好'
  };

  it('相同输入键稳定', () => {
    expect(ttsCacheKey(base)).toBe(ttsCacheKey({ ...base }));
  });

  it('音色 / 格式 / 模型 / 服务端 / 文本任一不同就是不同的声音', () => {
    const variants = [
      { ...base, voice: '苏打' },
      { ...base, format: 'wav' },
      { ...base, model: 'other-tts' },
      { ...base, baseUrl: 'http://other:5018/v1' },
      { ...base, text: '你好。' }
    ];
    const keys = new Set([ttsCacheKey(base), ...variants.map((v) => ttsCacheKey(v))]);
    expect(keys.size).toBe(6);
  });

  it('空音色与 undefined 音色等价（都表示用服务端默认音色）', () => {
    expect(ttsCacheKey({ ...base, voice: '' })).toBe(ttsCacheKey({ ...base, voice: undefined }));
  });
});
