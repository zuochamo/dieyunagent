'use strict';

const { createHash } = require('node:crypto');

/**
 * 语音合成结果的内存 LRU。
 *
 * 为什么需要：一次合成的实测耗时是 2~90 秒（按文本长度），而「再听一遍」「同一条回复
 * 分句播放」都会重复请求同一段文本。缓存在**合成层**（`speech-synthesize.js`）而不是
 * Renderer：渲染端只拿 base64，缓存住的是字节，缓存在最靠近请求的地方才对后续所有
 * 调用者（桌面气泡、设置页测试、手机端）同时生效。
 *
 * 为什么按**字节**而不是条数封顶：一段 1200 字中文的 mp3 约 3 MB，按 20 条封顶就是
 * 60 MB 常驻 —— 内存会随文本长度失控，而不是随条数。
 *
 * 只在内存里（进程退出即失效）：缓存是为了「立刻再听一遍」，不是为了跨天持久化，
 * 不值得引入磁盘格式、失效策略和清理任务。
 */

const DEFAULT_MAX_BYTES = 32 * 1024 * 1024;
const DEFAULT_MAX_ENTRIES = 40;

function createTtsCache(opts = {}) {
  const maxBytes = Number(opts.maxBytes) > 0 ? Number(opts.maxBytes) : DEFAULT_MAX_BYTES;
  const maxEntries = Number(opts.maxEntries) > 0 ? Number(opts.maxEntries) : DEFAULT_MAX_ENTRIES;
  /** @type {Map<string, {value: object, bytes: number}>} 插入顺序即「旧 → 新」 */
  const map = new Map();
  let bytes = 0;
  const stats = { hits: 0, misses: 0, evictions: 0 };

  function evictOldest() {
    const oldest = map.keys().next();
    if (oldest.done) return;
    const entry = map.get(oldest.value);
    map.delete(oldest.value);
    bytes -= entry.bytes;
    stats.evictions += 1;
  }

  function get(key) {
    const entry = map.get(key);
    if (!entry) {
      stats.misses += 1;
      return null;
    }
    // 命中即刷新为「最新」，这才是 LRU 而不是 FIFO
    map.delete(key);
    map.set(key, entry);
    stats.hits += 1;
    return entry.value;
  }

  function set(key, value, entryBytes) {
    const size = Math.max(0, Number(entryBytes) || 0);
    if (!key || size <= 0) return;
    // 单条就超过总预算：不缓存（否则会把整个缓存挤空却什么都留不下）
    if (size > maxBytes) return;
    const existing = map.get(key);
    if (existing) {
      map.delete(key);
      bytes -= existing.bytes;
    }
    map.set(key, { value, bytes: size });
    bytes += size;
    while ((bytes > maxBytes || map.size > maxEntries) && map.size > 1) evictOldest();
  }

  function clear() {
    map.clear();
    bytes = 0;
  }

  return {
    get,
    set,
    clear,
    stats,
    size: () => map.size,
    bytes: () => bytes,
    maxBytes,
    maxEntries
  };
}

/**
 * 缓存键：同一段文本在不同模型 / 音色 / 格式 / 服务端下是**不同的音频**，
 * 少任何一项都会让「换了音色却听到旧声音」。
 */
function ttsCacheKey({ baseUrl, model, voice, format, text }) {
  const parts = [baseUrl, model, voice, format, text].map((v) =>
    String(v == null ? '' : v).trim()
  );
  return createHash('sha256').update(parts.join('\u0000')).digest('hex');
}

/** 进程内单例：合成只有一条入口，缓存也只有一份。 */
const ttsCache = createTtsCache();

module.exports = { createTtsCache, ttsCacheKey, ttsCache };
