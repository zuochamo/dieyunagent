/**
 * Dieyun renderer bootstrap (Phase 3).
 * Registers domain init() hooks + deps; validates symbols before init.
 */
(function () {
  'use strict';

  /** @type {Map<string, { id: string, deps: string[], require: string[], init: Function, scriptHint?: string }>} */
  const domains = new Map();
  /** @type {(() => Promise<void> | void) | null} */
  let startupHook = null;

  function ns(id) {
    return window[id] || null;
  }

  function resolveSymbol(name) {
    if (typeof window[name] === 'function') return window[name];
    for (const id of [
      'DieyunGateway',
      'DieyunChat',
      'DieyunComposer',
      'DieyunAgent',
      'DieyunWorkspace',
      'DieyunSettings',
      'DieyunApp'
    ]) {
      const bucket = ns(id);
      if (bucket && typeof bucket[name] === 'function') return bucket[name];
    }
    return null;
  }

  function missingDeps(id, deps) {
    const missing = [];
    for (const dep of deps) {
      if (!ns(dep)) missing.push(`${dep} (namespace not registered — check script load order)`);
    }
    return missing;
  }

  function missingSymbols(require) {
    const missing = [];
    for (const sym of require || []) {
      if (typeof resolveSymbol(sym) !== 'function') {
        missing.push(sym);
      }
    }
    return missing;
  }

  function topoSort(ids) {
    const order = [];
    const visiting = new Set();
    const visited = new Set();

    function visit(id) {
      if (visited.has(id)) return;
      if (visiting.has(id)) {
        throw new Error(`[DieyunBootstrap] cyclic dependency involving ${id}`);
      }
      visiting.add(id);
      const spec = domains.get(id);
      if (spec) {
        for (const dep of spec.deps || []) visit(dep);
      }
      visiting.delete(id);
      visited.add(id);
      order.push(id);
    }

    for (const id of ids) visit(id);
    return order;
  }

  function register(spec) {
    if (!spec || !spec.id) {
      throw new Error('[DieyunBootstrap] register() requires id');
    }
    domains.set(spec.id, {
      id: spec.id,
      deps: Array.isArray(spec.deps) ? spec.deps.slice() : [],
      require: Array.isArray(spec.require) ? spec.require.slice() : [],
      init: typeof spec.init === 'function' ? spec.init : () => {},
      scriptHint: spec.scriptHint || ''
    });
    const bucket = ns(spec.id);
    if (bucket) {
      bucket.deps = spec.deps || [];
      bucket.init = spec.init;
    }
  }

  function run(explicitIds) {
    const ids = explicitIds && explicitIds.length ? explicitIds.map(String) : [...domains.keys()];
    const order = topoSort(ids);
    const errors = [];

    for (const id of order) {
      const spec = domains.get(id);
      if (!spec) {
        errors.push(`${id}: not registered`);
        continue;
      }
      const depMissing = missingDeps(id, spec.deps);
      if (depMissing.length) {
        errors.push(`${id}: missing dependencies — ${depMissing.join('; ')}`);
        continue;
      }
      const symMissing = missingSymbols(spec.require);
      if (symMissing.length) {
        const hint = spec.scriptHint ? ` (expected from ${spec.scriptHint})` : '';
        errors.push(`${id}: missing symbols — ${symMissing.join(', ')}${hint}`);
        continue;
      }
      try {
        spec.init(ns(id));
      } catch (err) {
        errors.push(`${id}: init failed — ${err && err.message ? err.message : String(err)}`);
      }
    }

    if (errors.length) {
      const msg = `[DieyunBootstrap] domain init failed:\n  ${errors.join('\n  ')}`;
      console.error(msg);
      throw new Error(msg);
    }
    return order;
  }

  function setStartup(fn) {
    startupHook = typeof fn === 'function' ? fn : null;
  }

  async function runStartup() {
    if (!startupHook) return;
    await startupHook();
  }

  window.DieyunBootstrap = {
    register,
    run,
    setStartup,
    runStartup,
    resolveSymbol,
    _domains: domains
  };
})();
