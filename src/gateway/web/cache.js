'use strict';

/**
 * 极简 TTL + LRU 缓存。
 * 目的只有一个：同一 URL / 同一 query 在相邻几轮里别重复出网
 * （Agent 轮次是稀缺资源，重复抓同一页纯属浪费）。
 */

function createCache({ max = 120, ttlMs = 10 * 60 * 1000 } = {}) {
  /** @type {Map<string, { value: any, exp: number }>} */
  const map = new Map();
  let hits = 0;
  let misses = 0;

  return {
    get(key) {
      const entry = map.get(key);
      if (!entry) {
        misses += 1;
        return null;
      }
      if (entry.exp <= Date.now()) {
        map.delete(key);
        misses += 1;
        return null;
      }
      map.delete(key);
      map.set(key, entry);
      hits += 1;
      return entry.value;
    },
    set(key, value, overrideTtlMs) {
      if (map.has(key)) map.delete(key);
      const ttl = Number(overrideTtlMs) > 0 ? Number(overrideTtlMs) : ttlMs;
      map.set(key, { value, exp: Date.now() + ttl });
      while (map.size > max) {
        const oldest = map.keys().next();
        if (oldest.done) break;
        map.delete(oldest.value);
      }
      return value;
    },
    clear() {
      map.clear();
      hits = 0;
      misses = 0;
    },
    stats() {
      return { size: map.size, hits, misses };
    }
  };
}

const searchCache = createCache({ max: 80, ttlMs: 10 * 60 * 1000 });
const fetchCache = createCache({ max: 80, ttlMs: 10 * 60 * 1000 });

function clearWebCaches() {
  searchCache.clear();
  fetchCache.clear();
}

module.exports = { createCache, searchCache, fetchCache, clearWebCaches };
