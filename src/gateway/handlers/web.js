'use strict';

/**
 * web.* RPC：只做参数校验与权限闸门，实际能力全在 gateway/web 模块里。
 * @param {{
 *   assertWebFetchEnabled: () => void,
 *   webTools: { webFetch: Function, webSearch: Function }
 * }} deps
 */
function createWebHandlers({ assertWebFetchEnabled, webTools }) {
  return {
    'web.fetch': async ({ url, maxChars, timeoutMs, mode, session, skipCache }) => {
      assertWebFetchEnabled();
      if (!url || typeof url !== 'string') {
        const e = new Error('url 必填');
        e.code = 'INVALID_URL';
        throw e;
      }
      return webTools.webFetch(url, { maxChars, timeoutMs, mode, session, skipCache });
    },

    'web.search': async ({ query, engine, site, page, fetchTop, maxChars, timeoutMs, session, skipCache }) => {
      assertWebFetchEnabled();
      if (!query || typeof query !== 'string') {
        const e = new Error('query 必填');
        e.code = 'INVALID_QUERY';
        throw e;
      }
      return webTools.webSearch(query, {
        engine,
        site,
        page,
        fetchTop,
        maxChars,
        timeoutMs,
        session,
        skipCache
      });
    }
  };
}

module.exports = { createWebHandlers };
