'use strict';

function createGuardedFetch(permissions) {
  const allowed = new Set(Array.isArray(permissions) ? permissions.map(String) : []);
  return function guardedFetch(url, init) {
    if (!allowed.has('network')) {
      const err = new Error('插件未声明 network 权限');
      err.code = 'PLUGIN_PERMISSION_DENIED';
      throw err;
    }
    return fetch(url, init);
  };
}

module.exports = {
  createGuardedFetch
};
