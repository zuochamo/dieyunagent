'use strict';
// Verify the zero-call-site candidate list against the ENTIRE repo (all text file types).
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const names = [
  'switchPanel', 'initArtifactsBtn', 'refreshWorkspaceArtifacts',
  'getComposerSelectedModelId', 'getComposerSelectedApiConfig', 'isLocalOnlyMethod',
  'LOCAL_RPC_PREFIXES', 'updateRustBootStep', 'safeJsonStringify', 'loadComposerModelPick',
  'estimateSystemToolsExtra', 'planPreviewSubtaskForPath', 'skillDomainLabel',
  'openWorktreeApplyDialog', 'isMissingRpcHandlerError', 'rustBootStepNote',
  'getWorkspaceRootPath', 'getSessionComposerDraft', 'builtinModelsCacheEndpointKey',
  'saveBuiltinModelsCache', 'formatBuiltinDetectMeta', 'skillSearchHaystack'
];
const files = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (['node_modules', 'dist', 'release', 'target', '.git', 'build', '.dieyun'].includes(e.name)) continue;
      walk(p);
    } else if (/\.(js|cjs|mjs|html|json|md|ts|ps1|css)$/.test(e.name)) files.push(p);
  }
})(ROOT);
const texts = files.map((f) => [f, fs.readFileSync(f, 'utf8')]);
for (const n of names) {
  const re = new RegExp('\\b' + n + '\\b', 'g');
  const hits = [];
  for (const [f, t] of texts) {
    const c = (t.match(re) || []).length;
    if (c) hits.push(path.relative(ROOT, f) + '×' + c);
  }
  console.log(`${n}: ${hits.length} files -> ${hits.join(', ')}`);
}
