'use strict';

/** Session transcript roles that may be projected into the next model request. */
const TRANSCRIPT_ROLES = new Set(['user', 'assistant']);

/**
 * The session book: user/assistant records only.
 * Live UI fields (transientTrace, system/tool rows) are not part of the transcript.
 */
function transcriptFromMessages(messages) {
  return (Array.isArray(messages) ? messages : []).filter(
    (m) => m && TRANSCRIPT_ROLES.has(m.role)
  );
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    TRANSCRIPT_ROLES,
    transcriptFromMessages
  };
}

if (typeof window !== 'undefined') {
  window.transcriptFromMessages = transcriptFromMessages;
}
