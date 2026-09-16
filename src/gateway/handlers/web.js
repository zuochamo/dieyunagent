'use strict';

/**
 * @param {{
 *   assertWebFetchEnabled: () => void,
 *   webFetch: { fetchWithRedirects: Function, webSearch: Function }
 * }} deps
 */
function createWebHandlers({ assertWebFetchEnabled, webFetch }) {
  return {
    'web.fetch': async ({ url, maxChars, timeoutMs }) => {
      assertWebFetchEnabled();
      if (!url || typeof url !== 'string') {
        const e = new Error('url 必填');
        e.code = 'INVALID_URL';
        throw e;
      }
      return webFetch.fetchWithRedirects(url, { maxChars, timeoutMs });
    },

    'web.search': async ({ query, engine, maxChars, timeoutMs }) => {
      assertWebFetchEnabled();
      if (!query || typeof query !== 'string') {
        const e = new Error('query 必填');
        e.code = 'INVALID_QUERY';
        throw e;
      }
      return webFetch.webSearch(query, engine, { maxChars, timeoutMs });
    }
  };
}

module.exports = { createWebHandlers };
