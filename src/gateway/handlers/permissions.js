'use strict';

/**
 * @param {{ perms: object }} deps
 */
function createPermissionsHandlers({ perms }) {
  return {
    'permissions.get': () => ({ ...perms })
  };
}

module.exports = { createPermissionsHandlers };
