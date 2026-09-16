'use strict';

const crypto = require('crypto');

const PREFIX = 'project:';

/**
 * Stable scope key for workspace-bound project memory (fits long_memories.scope VARCHAR).
 * @param {string | null | undefined} workspacePath
 */
function projectMemoryScope(workspacePath) {
  const p = String(workspacePath || '').trim();
  if (!p) return '';
  if (p.length <= 100) return `${PREFIX}${p}`;
  const hash = crypto.createHash('sha256').update(p).digest('hex').slice(0, 16);
  const tail = p.slice(-72);
  return `${PREFIX}${hash}:${tail}`;
}

module.exports = { projectMemoryScope, PROJECT_MEMORY_PREFIX: PREFIX };
