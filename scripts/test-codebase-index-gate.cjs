'use strict';

/**
 * Smoke: 索引门闩辅助逻辑 — needsIndex / progress 文案 / search 不再 ensure。
 * 不启动 Electron；校验 gateway rpc 片段导出不可用时用内联复刻。
 */

function codebaseNeedsRebuild(st, sig, opts = {}) {
  if (opts.force) return true;
  if (!st || !st.indexed) return true;
  if (sig && st.chunkCount > 0 && (!st.embeddingModel || st.embeddingModel !== sig)) {
    return true;
  }
  return false;
}

function codebaseNeedsFullIndex(st, sig, opts = {}) {
  if (codebaseNeedsRebuild(st, sig, opts)) return true;
  if (!st.chunkCount || st.chunkCount === 0) return true;
  return false;
}

function formatCodebaseIndexProgress(st) {
  if (!st) return '正在建立代码索引…';
  const phase = String(st.phase || '').trim();
  const phaseLabel =
    phase === 'walking'
      ? '扫描文件'
      : phase === 'chunking'
        ? '切分代码'
        : phase === 'embedding'
          ? '生成向量'
          : phase === 'finishing'
            ? '写入索引'
            : phase === 'error'
              ? '索引失败'
              : '建立索引';
  const done = Number(st.filesDone) || 0;
  const total = Number(st.filesTotal) || 0;
  const chunks = Number(st.chunkCount) || 0;
  const vectors = Number(st.vectorCount) || 0;
  const parts = [phaseLabel];
  if (total > 0) parts.push(`${done}/${total} 文件`);
  else if (done > 0) parts.push(`${done} 文件`);
  if (chunks > 0) parts.push(`${chunks} chunk`);
  if (vectors > 0) parts.push(`${vectors} 向量`);
  return parts.join(' · ');
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assert failed');
}

assert(codebaseNeedsFullIndex(null, ''), 'null needs index');
assert(codebaseNeedsFullIndex({ indexed: false, chunkCount: 0 }, ''), 'empty needs index');
assert(!codebaseNeedsRebuild({ indexed: true, chunkCount: 0 }, ''), 'empty completed no rebuild');
assert(
  codebaseNeedsFullIndex({ indexed: true, chunkCount: 0 }, ''),
  'empty completed still needs content for search'
);
assert(!codebaseNeedsFullIndex({ indexed: true, chunkCount: 10 }, ''), 'ready no need');
assert(
  codebaseNeedsFullIndex({ indexed: true, chunkCount: 10, embeddingModel: 'a@1' }, 'b@1'),
  'stale embedding needs index'
);
assert(
  codebaseNeedsFullIndex({ indexed: true, chunkCount: 10 }, 'a@1'),
  'missing embeddingModel with sig needs rebuild'
);
assert(
  !codebaseNeedsFullIndex({ indexed: true, chunkCount: 10, embeddingModel: 'a@1' }, 'a@1'),
  'matching embedding ok'
);

const note = formatCodebaseIndexProgress({
  phase: 'embedding',
  filesDone: 12,
  filesTotal: 100,
  chunkCount: 40,
  vectorCount: 8
});
assert(note.includes('生成向量'), `phase in note: ${note}`);
assert(note.includes('12/100'), `files in note: ${note}`);
assert(note.includes('40 chunk'), `chunks in note: ${note}`);

const fs = require('fs');
const path = require('path');
const rpc = fs.readFileSync(path.join(__dirname, '..', 'src', 'gateway', 'rpc.js'), 'utf8');
const graphRpc = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'gateway', 'handlers', 'graph.js'),
  'utf8'
);
assert(graphRpc.includes("'graph.index.start'"), 'rpc has graph.index.start');
assert(rpc.includes('GRAPH_INDEXING_IN_PROGRESS'), 'graph tools return indexing code');
assert(rpc.includes('GRAPH_INDEX_REQUIRED'), 'graph tools return required code');
assert(rpc.includes('assertGraphIndexReady'), 'graph assert helper');

const remoteCore = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'remote', 'remote-index-core.js'),
  'utf8'
);
assert(remoteCore.includes('codebase.index.start'), 'remote allows index.start');
assert(remoteCore.includes('graph.index.start'), 'remote allows graph.index.start');
assert(remoteCore.includes('STATUS_FAST_METHODS'), 'remote status bypasses exclusive queue');

const codebaseInc = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'index', 'codebase-incremental-scheduler.js'),
  'utf8'
);
assert(codebaseInc.includes('force: false'), 'codebase scheduler uses force:false');
assert(codebaseInc.includes("codebase.index.start"), 'codebase scheduler calls index.start');
assert(codebaseInc.includes('skipIfReady: false'), 'codebase scheduler refresh even if indexed');

const graphInc = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'graph', 'graph-incremental-scheduler.js'),
  'utf8'
);
assert(graphInc.includes('graph.index.start'), 'graph scheduler uses index.start');
assert(graphInc.includes('skipIfReady: false'), 'graph scheduler refresh even if indexed');

const prep = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'renderer', 'renderer-agent-prep.js'),
  'utf8'
);
assert(prep.includes("id: 'graph'"), 'prep step graph defined');
assert(prep.includes('codebase.index.start'), 'prep calls codebase.index.start');
assert(prep.includes('graph.index.start'), 'prep calls graph.index.start');
assert(prep.includes('一律不等待'), 'prep helper documents no-wait');
assert(!prep.includes('3 * 60 * 1000'), 'prep removed 3min poll');
assert(prep.includes('已发起'), 'prep started message');
assert(prep.includes('创建中'), 'prep creating message');
assert(prep.includes('function isCodebasePrepReady'), 'codebase ready helper');
assert(prep.includes('skipIfReady: false'), 'prep start does not skip empty indexed shell');
assert(prep.includes('async function ensurePrepIndexReady'), 'prep uses ensurePrepIndexReady');
assert(prep.includes('本次不等待'), 'prep documents no-wait policy');
assert(!prep.includes('buildingNote:'), 'prep no longer passes buildingNote');

const sysMsg = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'renderer', 'renderer-agent-system-message.js'),
  'utf8'
);
assert(
  sysMsg.includes("if (allowCodebase && workspacePath && typeof gatewayCall === 'function')"),
  'renderer codebase prep gated on allowCodebase'
);
assert(sysMsg.includes('const collectGraph = async () => {'), 'graph prep is a separate collector');

const promptPrep = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'agent', 'system-prompt-prep.js'),
  'utf8'
);
assert(promptPrep.includes('if (allowCodebase)'), 'Main codebase recall gated on allowCodebase');
assert(promptPrep.includes('fetchCodebaseBlock'), 'Main fetches codebase when allowed');
assert(promptPrep.includes('if (injectCode)'), 'other code context uses injectCode, not codebase index gate');

const delegate = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'agent', 'delegate-tool-gateway.js'),
  'utf8'
);
assert(delegate.includes('autoIndex: false'), 'delegate tools do not auto-index');
assert(!delegate.includes('autoIndex: true'), 'delegate removed autoIndex true');

console.log('test-codebase-index-gate: ok');
