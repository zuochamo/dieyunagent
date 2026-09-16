/**
 * Dieyun renderer domain namespaces (Phase 2).
 * Modules register exports here; compat mirrors selected keys to window.*.
 */
(function () {
  'use strict';

  const DOMAIN_NAMES = [
    'DieyunGateway',
    'DieyunChat',
    'DieyunComposer',
    'DieyunAgent',
    'DieyunWorkspace',
    'DieyunSettings',
    'DieyunApp'
  ];

  function ensure(nsName) {
    window[nsName] = window[nsName] || {};
    return window[nsName];
  }

  for (const name of DOMAIN_NAMES) {
    ensure(name);
  }

  /**
   * @param {string} nsName
   * @param {Record<string, unknown>} exports
   * @param {{ compat?: boolean | string[] }} [opts]
   */
  function register(nsName, exports, opts = {}) {
    const ns = ensure(nsName);
    // 保留 accessor：Object.assign 会把 getter 求值成快照
    for (const key of Object.keys(exports || {})) {
      const desc = Object.getOwnPropertyDescriptor(exports, key);
      if (!desc) continue;
      if (desc.get || desc.set) {
        Object.defineProperty(ns, key, {
          configurable: true,
          enumerable: true,
          get: desc.get,
          set: desc.set
        });
      } else {
        ns[key] = exports[key];
      }
    }
    const compat = opts.compat;
    if (compat === false) return ns;
    const keys = Array.isArray(compat)
      ? compat
      : Object.keys(exports).filter((key) => {
          const val = exports[key];
          return typeof val === 'function';
        });
    for (const key of keys) {
      const val = exports[key];
      if (val !== undefined) {
        window[key] = val;
      }
    }
    return ns;
  }

  window.DieyunNamespaces = { register, ensure, DOMAIN_NAMES };
})();
